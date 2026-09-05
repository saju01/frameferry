const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

const VERSION = '0.1.0';
const PROVIDER_ORIGIN = 'https://instacognito.com';
const PROVIDER_PHOTO_URL = PROVIDER_ORIGIN + '/en/photo';
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TIME_MS = 600000;
const DEFAULT_DELAY_MS = 500;

class ArchiveError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ArchiveError'; this.code = code; this.details = details; }
}
class DeferredError extends ArchiveError {
  constructor(retryAt, message = 'provider requested retry later') { super('DEFERRED', message, { retryAt }); this.retryAt = retryAt; }
}

function validateHandle(handle) {
  handle = String(handle || '');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle) || handle.includes('..') || handle.startsWith('.')) {
    throw new ArchiveError('BAD_HANDLE', 'handle must use letters, digits, dot, or underscore');
  }
  return handle;
}
function redactSignedUrls(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(/https:\/\/instacognito\.com\/media\?id=[A-Za-z0-9._~!$&'()*+,;=:@%\/-]+/g, 'https://instacognito.com/media?id=[REDACTED]');
}
async function safeOutputRoot(output) {
  if (!output) throw new ArchiveError('BAD_OUTPUT', '--output is required');
  const resolved = path.resolve(output);
  const parts = resolved.split(path.sep).filter(Boolean);
  let probe = path.isAbsolute(resolved) ? path.sep : '';
  for (const part of parts) {
    probe = path.join(probe, part);
    try {
      const st = await fsp.lstat(probe);
      if (st.isSymbolicLink()) throw new ArchiveError('BAD_OUTPUT', 'output path contains symlink: ' + probe);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      break;
    }
  }
  await fsp.mkdir(resolved, { recursive: true, mode: 0o700 });
  const st = await fsp.lstat(resolved);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ArchiveError('BAD_OUTPUT', 'output must be a real directory');
  return await fsp.realpath(resolved);
}
async function ensureSafeDir(dir, root) {
  const resolved = path.resolve(dir);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new ArchiveError('BAD_OUTPUT', 'internal path escapes output root');
  const rel = path.relative(base, resolved);
  let probe = base;
  if (rel && rel !== '.') {
    for (const part of rel.split(path.sep)) {
      probe = path.join(probe, part);
      try {
        const st = await fsp.lstat(probe);
        if (st.isSymbolicLink()) throw new ArchiveError('BAD_OUTPUT', 'internal directory path contains symlink: ' + probe);
        if (!st.isDirectory()) throw new ArchiveError('BAD_OUTPUT', 'internal path is not a directory: ' + probe);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        break;
      }
    }
  }
  await fsp.mkdir(resolved, { recursive: true, mode: 0o700 });
  const st = await fsp.lstat(resolved);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ArchiveError('BAD_OUTPUT', 'internal directory must be a real directory');
  return resolved;
}
function profilePaths(root, handle) {
  validateHandle(handle);
  return {
    root,
    stateDir: path.join(root, '.frameferry', handle),
    mediaDir: path.join(root, 'media', handle),
    receiptDir: path.join(root, 'receipts', handle),
    lock: path.join(root, '.frameferry', handle, 'lock.json'),
    manifest: path.join(root, '.frameferry', handle, 'manifest.json'),
    status: path.join(root, '.frameferry', handle, 'status.json')
  };
}
async function atomicWriteJson(file, data, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  await fsp.chmod(tmp, mode);
  await fsp.rename(tmp, file);
  await fsp.chmod(file, mode);
}
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
function isPidAlive(pid) { try { process.kill(pid, 0); return true; } catch (err) { if (err && err.code === 'EPERM') return true; return false; } }
async function withLock(paths, runId, fn) {
  await ensureSafeDir(paths.stateDir, paths.root);
  try {
    const fd = await fsp.open(paths.lock, 'wx', 0o600);
    await fd.writeFile(JSON.stringify({ runId, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }) + '\n');
    await fd.close();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const lock = await readJson(paths.lock, {});
    if (!lock.host || lock.host !== os.hostname()) throw new ArchiveError('LOCKED_FOREIGN', 'profile lock belongs to another or unknown host; failing closed', { lock });
    if (lock.pid && isPidAlive(lock.pid)) throw new ArchiveError('LOCKED', 'profile is locked by alive pid ' + lock.pid, { lock });
    await fsp.rename(paths.lock, paths.lock + '.stale-' + Date.now()).catch(() => {});
    return withLock(paths, runId, fn);
  }
  try { return await fn(); } finally { await fsp.unlink(paths.lock).catch(() => {}); }
}
function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec)) return new Date(now + Math.max(0, sec) * 1000).toISOString();
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function stableMediaId(item) {
  const shortcode = String(item.shortcode || '').trim();
  const index = Number.isInteger(item.carouselIndex) ? item.carouselIndex : 0;
  if (!shortcode) throw new ArchiveError('BAD_ITEM', 'media item missing shortcode');
  return (shortcode + '-' + index).replace(/[^A-Za-z0-9._-]/g, '_');
}
function parseDateText(value) {
  if (!value) return null;
  const clean = String(value).split('\n').map(s => s.trim()).filter(Boolean).at(-1) || String(value).trim();
  if (!/\b(?:19|20)\d{2}\b/.test(clean)) return clean;
  const t = Date.parse(clean);
  return Number.isFinite(t) ? new Date(t).toISOString() : clean;
}
function normalizeItems(rawItems) {
  const seenStable = new Set();
  const seenPost = new Set();
  const nextIndex = new Map();
  const rawSeen = new Set();
  const items = [];
  for (const raw of rawItems || []) {
    const shortcode = String(raw.shortcode || raw.dataId || '').trim();
    if (!shortcode) continue;
    const rawKey = shortcode + '|' + (raw.href || '') + '|' + (raw.type || '') + '|' + (raw.dateText || '');
    if (rawSeen.has(rawKey)) continue;
    rawSeen.add(rawKey);
    let carouselIndex;
    if (Number.isInteger(raw.carouselIndex)) carouselIndex = raw.carouselIndex;
    else { carouselIndex = nextIndex.get(shortcode) || 0; nextIndex.set(shortcode, carouselIndex + 1); }
    const item = { shortcode, carouselIndex, type: raw.type || 'unknown', href: raw.href || null, dateText: parseDateText(raw.dateText) };
    item.stableId = stableMediaId(item);
    if (seenStable.has(item.stableId)) continue;
    seenStable.add(item.stableId); seenPost.add(shortcode); items.push(item);
  }
  return { items, uniquePostCount: seenPost.size };
}
function parseReportedTotal(text) {
  if (!text) return null;
  const s = String(text);
  const num = '(?<![\\d.])(\\d+(?:[,. ]\\d{3})*)(?![\\d.])';
  const candidates = [];
  for (const m of s.matchAll(new RegExp(num + '\\s*(?:posts?|post)\\b', 'gi'))) {
    const prefix = s.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
    if (/following\s*$/.test(prefix)) continue;
    candidates.push({ value: m[1], score: 0, index: m.index });
  }
  for (const m of s.matchAll(new RegExp('(?:posts?|post)\\D{0,20}' + num, 'gi'))) {
    const suffix = s.slice(m.index + m[0].length, m.index + m[0].length + 16).toLowerCase();
    if (/^\s*follow(?:ing|ers?)/.test(suffix)) continue;
    candidates.push({ value: m[1], score: 1, index: m.index });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  return Number(candidates[0].value.replace(/[^0-9]/g, ''));
}
function validateProviderMediaUrl(raw) {
  let u; try { u = new URL(raw); } catch { throw new ArchiveError('BAD_URL', 'invalid media URL'); }
  if (u.protocol !== 'https:' || u.hostname !== 'instacognito.com' || u.pathname !== '/media' || !u.searchParams.has('id')) throw new ArchiveError('BAD_URL', 'media URL must be https://instacognito.com/media?id=...');
  return u;
}
function parseIPv4Mapped(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h.startsWith('::ffff:')) return h.slice(7);
  const m = h.match(/^0:0:0:0:0:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) { const a = parseInt(m[1], 16), b = parseInt(m[2], 16); return [a >> 8, a & 255, b >> 8, b & 255].join('.'); }
  return null;
}
function isPrivateIp(ip) {
  const mapped = parseIPv4Mapped(ip);
  if (mapped) return isPrivateIp(mapped);
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || p[0] === 0;
  }
  if (net.isIPv6(ip)) {
    const h = ip.toLowerCase();
    return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
  }
  return false;
}
function isPrivateHostLiteral(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || isPrivateIp(h);
}
async function validateRedirectTarget(raw, lookup = dns.lookup) {
  const u = new URL(raw);
  if (u.protocol !== 'https:') throw new ArchiveError('BAD_REDIRECT', 'redirect target must be HTTPS');
  if (isPrivateHostLiteral(u.hostname)) throw new ArchiveError('BAD_REDIRECT', 'redirect target is private/local');
  let addrs;
  try { addrs = await lookup(u.hostname, { all: true }); }
  catch { throw new ArchiveError('BAD_REDIRECT', 'redirect DNS lookup failed closed'); }
  if (!addrs || !addrs.length) throw new ArchiveError('BAD_REDIRECT', 'redirect DNS lookup returned no addresses');
  for (const a of addrs) if (isPrivateIp(a.address)) throw new ArchiveError('BAD_REDIRECT', 'redirect resolves to private/local address');
  return u;
}
function headerGet(res, name) { return res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null; }
async function fetchWithValidatedRedirects(url, { fetchImpl, remainingMs, maxRedirects = 5, dnsLookup, signal }) {
  let current = validateProviderMediaUrl(url).href;
  await validateRedirectTarget(current, dnsLookup);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(current, { redirect: 'manual', signal });
    if (res.status === 429) {
      const retryAt = parseRetryAfter(headerGet(res, 'retry-after')) || new Date(Date.now() + 3600000).toISOString();
      const waitMs = Math.max(0, Date.parse(retryAt) - Date.now());
      if (waitMs > remainingMs) throw new DeferredError(retryAt);
      if (waitMs) await delay(waitMs, undefined, { signal });
      remainingMs -= waitMs;
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = headerGet(res, 'location');
      if (!loc) throw new ArchiveError('BAD_REDIRECT', 'redirect missing Location');
      const next = new URL(loc, current).href;
      validateProviderMediaUrl(next);
      await validateRedirectTarget(next, dnsLookup);
      current = next;
      continue;
    }
    res.finalUrl = current;
    return res;
  }
  throw new ArchiveError('BAD_REDIRECT', 'too many redirects');
}
function mediaKindFromMagic(buf) {
  if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'png';
  if (buf.subarray(4, 8).toString() === 'ftyp') return 'mp4';
  if (buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
function extFor(kind) { return kind === 'jpg' ? 'jpg' : kind; }
function responseBodyStream(res) {
  if (res.body && typeof res.body.getReader === 'function') return res.body;
  if (res.body && Symbol.asyncIterator in res.body) return res.body;
  throw new ArchiveError('BAD_CONTENT', 'response has no readable body');
}
async function streamResponseToPart(res, part, { maxBytes, signal }) {
  const body = responseBodyStream(res);
  const fh = await fsp.open(part, 'w', 0o600);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const head = [];
  try {
    if (body.getReader) {
      const reader = body.getReader();
      for (;;) {
        if (signal?.aborted) throw new ArchiveError('TIMEOUT', 'download timeout');
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        bytes += chunk.length;
        if (bytes > maxBytes) throw new ArchiveError('TOO_LARGE', 'download exceeds max bytes');
        if (Buffer.concat(head).length < 16) head.push(chunk.subarray(0, 16));
        hash.update(chunk); await fh.write(chunk);
      }
    } else {
      for await (const chunkRaw of body) {
        if (signal?.aborted) throw new ArchiveError('TIMEOUT', 'download timeout');
        const chunk = Buffer.from(chunkRaw);
        bytes += chunk.length;
        if (bytes > maxBytes) throw new ArchiveError('TOO_LARGE', 'download exceeds max bytes');
        if (Buffer.concat(head).length < 16) head.push(chunk.subarray(0, 16));
        hash.update(chunk); await fh.write(chunk);
      }
    }
  } finally { await fh.close(); }
  const first = Buffer.concat(head).subarray(0, 16);
  const kind = mediaKindFromMagic(first);
  if (!kind) throw new ArchiveError('BAD_SIGNATURE', 'download signature is not recognized media');
  return { bytes, sha256: hash.digest('hex'), kind };
}
async function verifyReceipt(paths, receipt) {
  if (!receipt || !receipt.path || !receipt.sha256 || !Number.isInteger(receipt.bytes)) return false;
  const file = path.resolve(paths.root, receipt.path);
  if (!file.startsWith(paths.root + path.sep)) return false;
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile() || st.size !== receipt.bytes) return false;
  const data = await fsp.readFile(file);
  return crypto.createHash('sha256').update(data).digest('hex') === receipt.sha256;
}
async function downloadOne(item, paths, { fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MAX_BYTES, runId, remainingMs = 60000, dnsLookup, timeoutMs } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs || remainingMs));
  try {
    const res = await fetchWithValidatedRedirects(item.href, { fetchImpl, remainingMs, dnsLookup, signal: ac.signal });
    if (!res.ok) throw new ArchiveError('DOWNLOAD_FAILED', 'download failed with HTTP ' + res.status);
    const ct = (headerGet(res, 'content-type') || '').toLowerCase();
    if (ct.includes('text/html')) throw new ArchiveError('BAD_CONTENT', 'provider returned HTML instead of media');
    const declared = Number(headerGet(res, 'content-length') || '0');
    if (declared > maxBytes) throw new ArchiveError('TOO_LARGE', 'content-length exceeds max bytes');
    const stableId = item.stableId || stableMediaId(item);
    await ensureSafeDir(paths.mediaDir, paths.root);
    await ensureSafeDir(paths.receiptDir, paths.root);
    const partBase = path.join(paths.mediaDir, stableId + '.part');
    const got = await streamResponseToPart(res, partBase, { maxBytes, signal: ac.signal });
    if (declared && declared !== got.bytes) throw new ArchiveError('BAD_LENGTH', 'content-length mismatch');
    const dest = path.join(paths.mediaDir, stableId + '.' + extFor(got.kind));
    await fsp.rename(partBase, dest);
    const receipt = { stableId, shortcode: item.shortcode, carouselIndex: item.carouselIndex || 0, type: item.type || 'unknown', path: path.relative(paths.root, dest), bytes: got.bytes, sha256: got.sha256, contentType: ct || 'application/octet-stream', sourceHost: 'instacognito.com', runId, completedAt: new Date().toISOString() };
    await atomicWriteJson(path.join(paths.receiptDir, stableId + '.json'), receipt);
    return receipt;
  } catch (err) {
    await fsp.rm(path.join(paths.mediaDir, (item.stableId || stableMediaId(item)) + '.part'), { force: true }).catch(() => {});
    if (err.name === 'AbortError') throw new ArchiveError('TIMEOUT', 'download timeout');
    throw err;
  } finally { clearTimeout(timer); }
}
function decideOutcome({ reportedTotal, uniquePostCount, failed, noGrowth, hitLimit, mode, reusedOnlyComplete = false }) {
  if (reportedTotal == null) return { status: 'ACTION_REQUIRED', reason: 'reported total could not be parsed' };
  if (failed > 0) return { status: 'PARTIAL', reason: failed + ' downloads failed' };
  if (hitLimit) return { status: 'PARTIAL', reason: 'bounded limit reached' };
  if (noGrowth && mode === 'full' && uniquePostCount < reportedTotal) return { status: 'PARTIAL', reason: 'no new cards loaded' };
  if (reportedTotal != null && uniquePostCount < reportedTotal) return { status: 'PARTIAL', reason: 'advertised shortfall ' + uniquePostCount + '/' + reportedTotal };
  return { status: 'COMPLETE', reason: reusedOnlyComplete ? 'all requested media reused from verified receipts' : 'reported total reached and downloads verified' };
}
function sanitizeFailedItem(item, error) { return { stableId: item.stableId || stableMediaId(item), shortcode: item.shortcode, carouselIndex: item.carouselIndex || 0, type: item.type || 'unknown', error: redactSignedUrls(error) }; }
async function writeStatus(paths, status) { await atomicWriteJson(paths.status, status); return status; }
async function archiveProfile(opts = {}) {
  const handle = validateHandle(opts.handle);
  const mode = opts.mode || 'full';
  if (!['full', 'sync'].includes(mode)) throw new ArchiveError('BAD_MODE', 'mode must be full or sync');
  const root = await safeOutputRoot(opts.output);
  const paths = profilePaths(root, handle);
  const runId = Date.now() + '-' + crypto.randomUUID();
  const started = Date.now();
  const maxTimeMs = opts.maxTimeMs || DEFAULT_MAX_TIME_MS;
  await ensureSafeDir(paths.stateDir, paths.root);
  await ensureSafeDir(paths.mediaDir, paths.root);
  await ensureSafeDir(paths.receiptDir, paths.root);
  return withLock(paths, runId, async () => {
    const prior = await readJson(paths.manifest, { version: 1, handle, completed: {}, failed: {}, runs: [] });
    await writeStatus(paths, { status: 'RUNNING', reason: 'scan started', runId, handle, mode, startedAt: new Date().toISOString(), priorCompletedCount: Object.keys(prior.completed || {}).length });
    let scan;
    try {
      scan = opts.items ? { items: opts.items, reportedTotal: opts.reportedTotal, uniquePostCount: normalizeItems(opts.items).uniquePostCount, scanSeenPostCount: normalizeItems(opts.items).uniquePostCount, extractedPostCount: normalizeItems(opts.items).uniquePostCount, noGrowth: !!opts.noGrowth, hitLimit: !!opts.hitLimit } : await scrapeWithPlaywright({ handle, maxPages: opts.maxPages || 12, maxTimeMs, browserExecutable: opts.browserExecutable, browserChannel: opts.browserChannel, attachCdp: opts.attachCdp });
    } catch (err) {
      const status = { status: err instanceof DeferredError ? 'DEFERRED' : 'ACTION_REQUIRED', reason: redactSignedUrls(err.message), retryAt: err.retryAt, runId, handle, mode, updatedAt: new Date().toISOString(), priorCompletedCount: Object.keys(prior.completed || {}).length };
      await writeStatus(paths, status); throw err;
    }
    const norm = normalizeItems(scan.items);
    const freshById = new Map(norm.items.map(i => [i.stableId, i]));
    const completed = { ...(prior.completed || {}) };
    const failed = {};
    for (const [sid, oldFail] of Object.entries(prior.failed || {})) if (!freshById.has(sid)) failed[sid] = sanitizeFailedItem(oldFail, 'pending fresh scan retry');
    let downloaded = 0, reused = 0;
    for (const item of freshById.values()) {
      const sid = item.stableId;
      if (Date.now() - started > maxTimeMs) { failed[sid] = sanitizeFailedItem(item, 'time budget reached'); continue; }
      const existing = completed[sid];
      if (existing && await verifyReceipt(paths, existing)) { reused++; continue; }
      if (!item.href) { failed[sid] = sanitizeFailedItem(item, 'missing media href'); continue; }
      try {
        const receipt = await downloadOne(item, paths, { fetchImpl: opts.fetchImpl, maxBytes: opts.maxBytes || DEFAULT_MAX_BYTES, runId, remainingMs: Math.max(0, maxTimeMs - (Date.now() - started)), dnsLookup: opts.dnsLookup, timeoutMs: Math.min(opts.networkTimeoutMs || Infinity, Math.max(1, maxTimeMs - (Date.now() - started))) });
        completed[sid] = receipt; delete failed[sid]; downloaded++;
        await atomicWriteJson(paths.manifest, { version: 1, handle, updatedAt: new Date().toISOString(), completed, failed, runs: prior.runs || [] });
        const remainingAfterDownload = maxTimeMs - (Date.now() - started);
        if ((opts.delayMs ?? DEFAULT_DELAY_MS) && remainingAfterDownload > 0) await delay(Math.min(opts.delayMs ?? DEFAULT_DELAY_MS, 5000, remainingAfterDownload));
      } catch (err) {
        if (err instanceof DeferredError) {
          const manifest = { version: 1, handle, updatedAt: new Date().toISOString(), completed, failed, runs: [...(prior.runs || []), { runId, mode, status: 'DEFERRED', scanSeenPostCount: scan.scanSeenPostCount ?? null, extractedPostCount: scan.extractedPostCount ?? norm.uniquePostCount, completedCount: Object.keys(completed).length, failedCount: Object.keys(failed).length }] };
          await atomicWriteJson(paths.manifest, manifest);
          await writeStatus(paths, { status: 'DEFERRED', reason: err.message, retryAt: err.retryAt, runId, handle, mode, scanSeenPostCount: scan.scanSeenPostCount ?? null, extractedPostCount: scan.extractedPostCount ?? norm.uniquePostCount, noGrowth: !!scan.noGrowth, downloadedCount: downloaded, reusedCount: reused, completedCount: Object.keys(completed).length, failedCount: Object.keys(failed).length, updatedAt: new Date().toISOString() });
          throw err;
        }
        failed[sid] = sanitizeFailedItem(item, err.message);
      }
    }
    const completedPostSet = new Set([...norm.items.map(i => i.shortcode), ...Object.values(completed).map(r => r.shortcode).filter(Boolean)]);
    const uniquePostCount = completedPostSet.size;
    const outcome = decideOutcome({ reportedTotal: scan.reportedTotal, uniquePostCount, failed: Object.keys(failed).length, noGrowth: scan.noGrowth, hitLimit: scan.hitLimit, mode, reusedOnlyComplete: downloaded === 0 && reused > 0 });
    const run = { runId, mode, status: outcome.status, uniquePostCount, reportedTotal: scan.reportedTotal ?? null, scanSeenPostCount: scan.scanSeenPostCount ?? null, extractedPostCount: scan.extractedPostCount ?? norm.uniquePostCount, noGrowth: !!scan.noGrowth, hitLimit: !!scan.hitLimit, completedCount: Object.keys(completed).length, failedCount: Object.keys(failed).length, downloadedCount: downloaded, reusedCount: reused };
    const manifest = { version: 1, handle, updatedAt: new Date().toISOString(), completed, failed, runs: [...(prior.runs || []), run] };
    await atomicWriteJson(paths.manifest, manifest);
    return writeStatus(paths, { ...outcome, runId, handle, mode, uniquePostCount, reportedTotal: scan.reportedTotal ?? null, scanSeenPostCount: scan.scanSeenPostCount ?? null, extractedPostCount: scan.extractedPostCount ?? norm.uniquePostCount, noGrowth: !!scan.noGrowth, hitLimit: !!scan.hitLimit, completedCount: Object.keys(completed).length, failedCount: Object.keys(failed).length, downloadedCount: downloaded, reusedCount: reused, updatedAt: new Date().toISOString() });
  });
}
function remainingTimeout(started, maxTimeMs) { return Math.max(1, maxTimeMs - (Date.now() - started)); }
async function extractRawItemsFromPage(page) {
  return page.locator('#post-container .post-card').evaluateAll(cards => cards.map(card => {
    const shortcode = card.querySelector('[data-id]')?.getAttribute('data-id') || '';
    const typed = card.querySelector('[data-type]') || card.closest('[data-type]');
    const link = card.querySelector('.content-download-btn[href]');
    const footer = card.querySelector('.post-footer')?.innerText || '';
    return { shortcode, type: typed?.getAttribute('data-type') || 'unknown', href: link?.href || '', dateText: footer };
  }));
}
function mergeRawItemSnapshots(snapshots) {
  return normalizeItems((snapshots || []).flat().filter(Boolean));
}
async function getRenderedCardState(page) {
  return page.locator('#post-container .post-card').evaluateAll(cards => ({
    count: cards.length,
    ids: [...new Set(cards.map(card => card.querySelector('[data-id]')?.getAttribute('data-id')).filter(Boolean))]
  }));
}
async function scrollLastCardCenterAndWaitForGrowth(page, beforeState, { started, maxTimeMs, growthWaitMs = 15000, settleMs = 1200, recenterEveryMs = 1000, maxRecenters = 3, targetUniqueCount = null } = {}) {
  const waitBudget = Math.max(1, Math.min(growthWaitMs, remainingTimeout(started, maxTimeMs)));
  const deadline = Date.now() + waitBudget;
  const beforeIds = new Set(beforeState.ids || []);
  let bestState = beforeState;
  let bestRawItems = [];
  let bestCount = beforeState.count || 0;
  let bestIds = new Set(beforeState.ids || []);
  let grew = false;
  let sawLoading = false;
  let lastGrowthAt = 0;
  let nextRecenterAt = 0;
  let recenterCount = 0;
  async function recenterLastCard() {
    const cards = page.locator('#post-container .post-card');
    const count = await cards.count();
    if (count === 0) return false;
    await cards.nth(count - 1).evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }));
    return true;
  }
  if (!await recenterLastCard()) return { ...beforeState, grew: false, waitedMs: 0, recenterCount: 0 };
  recenterCount++;
  nextRecenterAt = Date.now() + recenterEveryMs;
  while (Date.now() < deadline && Date.now() - started < maxTimeMs) {
    const now = Date.now();
    if (now >= nextRecenterAt && recenterCount < maxRecenters) {
      if (await recenterLastCard()) recenterCount++;
      nextRecenterAt = now + recenterEveryMs;
    }
    const state = await getRenderedCardState(page);
    const stateIds = new Set(state.ids || []);
    const uniqueGrew = [...stateIds].some(id => !bestIds.has(id));
    const countGrew = state.count > bestCount;
    const loading = await page.locator('.loading, .spinner, [aria-busy="true"], [data-loading="true"]').count().catch(() => 0);
    sawLoading = sawLoading || loading > 0;
    if (countGrew || uniqueGrew) {
      grew = true;
      lastGrowthAt = Date.now();
      bestState = state;
      bestRawItems = await extractRawItemsFromPage(page);
      bestCount = Math.max(bestCount, state.count);
      bestIds = stateIds;
      if (targetUniqueCount && bestIds.size >= targetUniqueCount) return { ...state, rawItems: bestRawItems, grew: true, sawLoading, waitedMs: waitBudget - Math.max(0, deadline - Date.now()), recenterCount };
    }
    if (grew && loading === 0 && Date.now() - lastGrowthAt >= settleMs) {
      const finalState = await getRenderedCardState(page);
      return { ...finalState, rawItems: await extractRawItemsFromPage(page), grew: true, sawLoading, waitedMs: waitBudget - Math.max(0, deadline - Date.now()), recenterCount };
    }
    await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  const finalState = await getRenderedCardState(page);
  return { ...finalState, rawItems: grew ? bestRawItems : await extractRawItemsFromPage(page), grew, sawLoading, waitedMs: waitBudget, recenterCount };
}
async function scrapeWithPlaywright({ handle, maxPages, maxTimeMs, browserExecutable, browserChannel, attachCdp }) {
  if (attachCdp) { const u = new URL(attachCdp); if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) throw new ArchiveError('BAD_CDP', 'CDP attach must be explicit loopback http://127.0.0.1:<port>'); }
  const { chromium } = await require('playwright');
  let browser, page, attached = false; const started = Date.now();
  try {
    if (attachCdp) { browser = await chromium.connectOverCDP(attachCdp, { timeout: remainingTimeout(started, maxTimeMs) }); attached = true; page = await browser.newPage(); }
    else { browser = await chromium.launch({ headless: true, executablePath: browserExecutable, channel: browserChannel, timeout: remainingTimeout(started, maxTimeMs) }); page = await browser.newPage(); }
    page.setDefaultTimeout(remainingTimeout(started, maxTimeMs));
    await page.goto(PROVIDER_PHOTO_URL, { waitUntil: 'domcontentloaded', timeout: remainingTimeout(started, maxTimeMs) });
    await page.fill('input#search-input', handle, { timeout: remainingTimeout(started, maxTimeMs) });
    await page.click('button#download-btn', { timeout: remainingTimeout(started, maxTimeMs) });
    await page.waitForSelector('#post-container .post-card', { timeout: remainingTimeout(started, maxTimeMs) });
    const reportedTotal = await extractReportedTotalFromPage(page, remainingTimeout(started, maxTimeMs));
    const seen = new Set(); const rawSnapshots = []; let noGrowth = false, hitLimit = false;
    for (let i = 0; i < maxPages; i++) {
      page.setDefaultTimeout(remainingTimeout(started, maxTimeMs));
      const beforeState = await getRenderedCardState(page);
      rawSnapshots.push(await extractRawItemsFromPage(page));
      beforeState.ids.forEach(id => seen.add(id));
      if (Date.now() - started >= maxTimeMs) { hitLimit = true; break; }
      if (reportedTotal && seen.size >= reportedTotal) break;
      if (beforeState.count === 0) break;
      const afterState = await scrollLastCardCenterAndWaitForGrowth(page, beforeState, { started, maxTimeMs, targetUniqueCount: reportedTotal });
      rawSnapshots.push(afterState.rawItems || await extractRawItemsFromPage(page));
      afterState.ids.forEach(id => seen.add(id));
      if (Date.now() - started >= maxTimeMs) { hitLimit = true; break; }
      if (!afterState.grew) { noGrowth = true; break; }
    }
    rawSnapshots.push(await extractRawItemsFromPage(page));
    const merged = mergeRawItemSnapshots(rawSnapshots);
    return { items: merged.items, reportedTotal, uniquePostCount: merged.uniquePostCount, scanSeenPostCount: seen.size, extractedPostCount: merged.uniquePostCount, noGrowth, hitLimit };
  } finally { if (page) await page.close().catch(() => {}); if (browser && !attached) await browser.close().catch(() => {}); }
}
async function extractReportedTotalFromPage(page, timeoutMs = 2000) {
  const text = await page.locator('#profile-section, [id*=profile], [class*=profile]').first().innerText({ timeout: Math.max(1, timeoutMs) }).catch(() => '');
  return parseReportedTotal(text);
}
async function extractItemsFromPage(page, reportedTotal = null, flags = {}) {
  const norm = mergeRawItemSnapshots([await extractRawItemsFromPage(page)]);
  return { items: norm.items, reportedTotal, uniquePostCount: norm.uniquePostCount, noGrowth: !!flags.noGrowth, hitLimit: !!flags.hitLimit };
}
async function statusProfile({ handle, output }) { validateHandle(handle); const root = await safeOutputRoot(output); const paths = profilePaths(root, handle); await ensureSafeDir(paths.stateDir, paths.root); return await readJson(paths.status, { status: 'ACTION_REQUIRED', reason: 'no status exists yet', handle }); }
async function doctor({ attachCdp } = {}) {
  const checks = { node: process.versions.node, nodeOk: Number(process.versions.node.split('.')[0]) >= 20, playwright: false, cdpOk: true };
  try { require('playwright'); checks.playwright = true; } catch (err) { checks.playwrightError = err.message; }
  if (attachCdp) { try { const u = new URL(attachCdp); checks.cdpOk = u.protocol === 'http:' && ['127.0.0.1','localhost','::1','[::1]'].includes(u.hostname); } catch { checks.cdpOk = false; } }
  checks.ok = checks.nodeOk && checks.playwright && checks.cdpOk; return checks;
}
module.exports = { VERSION, PROVIDER_ORIGIN, PROVIDER_PHOTO_URL, ArchiveError, DeferredError, validateHandle, redactSignedUrls, safeOutputRoot, ensureSafeDir, profilePaths, atomicWriteJson, readJson, withLock, parseRetryAfter, stableMediaId, parseDateText, normalizeItems, parseReportedTotal, validateProviderMediaUrl, validateRedirectTarget, isPrivateIp, isPrivateHostLiteral, fetchWithValidatedRedirects, streamResponseToPart, verifyReceipt, downloadOne, decideOutcome, archiveProfile, getRenderedCardState, scrollLastCardCenterAndWaitForGrowth, scrapeWithPlaywright, extractRawItemsFromPage, mergeRawItemSnapshots, extractReportedTotalFromPage, extractItemsFromPage, statusProfile, doctor };
