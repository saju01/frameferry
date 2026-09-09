const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { performance } = require('node:perf_hooks');
const { ZipWriter, ZIP32_MAX } = require('./zip.js');
const discovery = require('./discovery.js');

const VERSION = '0.2.1';
const PROVIDER_ORIGIN = 'https://instacognito.com';
const PROVIDER_PHOTO_URL = PROVIDER_ORIGIN + '/en/photo';
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_TIME_MS = 600000;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_NETWORK_TIMEOUT_MS = 60000;
const VALID_CATEGORIES = ['posts', 'reels', 'stories', 'highlights'];
const VALID_MEDIA_TYPES = ['image', 'video'];
const DEFAULT_CATEGORIES = ['posts'];
const DEFAULT_MEDIA_TYPES = ['image', 'video'];
const ZIP32_HARD_MAX_BYTES = Math.min(ZIP32_MAX - 4096, 2 * 1024 * 1024 * 1024);
const ZIP32_HARD_MAX_ENTRIES = 5000;
const ZIP32_HARD_MAX_FILES = 3000;
const DEFAULT_CHECKPOINT_EVERY_ITEMS = 25;
// Discovery and acquisition are different deadlines. Sharing one budget is how a slow scan turned
// every item into "time budget reached": the scan spent the whole allowance and acquisition, the
// part that actually makes progress, got none. Capping discovery guarantees acquisition a share.
const DISCOVERY_BUDGET_RATIO = 0.5;
const MAX_AUDIT_ENTRIES = 20;
const LOCK_TAKEOVER_MAX_ATTEMPTS = 3;
// A claim whose owner cannot be identified at all is only recoverable once it is clearly not live.
const LOCK_CLAIM_MAX_AGE_MS = 15 * 60 * 1000;
// An entry carrying one of these is work that was never attempted, not a download that failed.
// Conflating the two is what reported 1514 "failures" for 1085 genuinely outstanding ids.
const PENDING_MARKERS = new Set(['pending fresh scan retry', 'awaiting rediscovery', 'acquisition budget reached', 'discovery budget reached', 'awaiting acquisition', 'provider deferred acquisition', 'carousel slide mapping unproven', 'time budget reached']);

class ArchiveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.details = details;
  }
}
class DeferredError extends ArchiveError {
  constructor(retryAt, message = 'provider requested retry later') {
    super('DEFERRED', message, { retryAt });
    this.retryAt = retryAt;
  }
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
  // Any media URL, whatever the query order. Keying on "?id=" meant a signature-first URL matched
  // nothing at all and was persisted verbatim.
  return text.replace(/https:\/\/instacognito\.com\/media(?:\?[^\s"'\\]*)?/gi, '[REDACTED instacognito media URL]');
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function jsonText(data) { return JSON.stringify(data, null, 2) + '\n'; }
function unique(list) { return [...new Set(list)]; }
function asPositiveIntOrDefault(value, fallback, label) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) throw new ArchiveError('BAD_ARGS', label + ' must be a positive number');
  return Math.floor(n);
}
function normalizeMediaType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'image' || v === 'photo' || v === 'jpg' || v === 'png' || v === 'webp') return 'image';
  if (v === 'video' || v === 'reel' || v === 'mp4') return 'video';
  return 'unknown';
}
function sanitizeContentTypeToken(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const token = raw.split(';')[0].trim().toLowerCase();
  if (token.length > 64 || !/^[a-z0-9][a-z0-9!#$&\-^_.+]*\/[a-z0-9][a-z0-9!#$&\-^_.+]*$/.test(token)) return null;
  return token;
}
function optionListText(list) { return list.join(', '); }
function parseChoiceList(raw, valid, label, defaults) {
  if (raw == null || raw === '') return [...defaults];
  const parts = String(raw).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!parts.length) throw new ArchiveError('BAD_ARGS', label + ' requires at least one value');
  let expanded = parts;
  if (parts.includes('all')) {
    if (valid.includes('all')) expanded = [...valid].filter(v => v !== 'all');
    else expanded = [...valid];
  }
  const out = unique(expanded);
  for (const item of out) if (!valid.includes(item) && item !== 'all') throw new ArchiveError('BAD_ARGS', label + ' must be one of: ' + optionListText(valid));
  return out.filter(item => item !== 'all');
}
function parseCategories(raw) { return parseChoiceList(raw, VALID_CATEGORIES, '--categories', DEFAULT_CATEGORIES); }
function parseMediaTypes(raw) { return parseChoiceList(raw, VALID_MEDIA_TYPES, '--media-types', DEFAULT_MEDIA_TYPES); }

async function ensureNoSymlinkAncestors(target, { allowMissingLeaf = true } = {}) {
  const resolved = path.resolve(target);
  const parts = resolved.split(path.sep).filter(Boolean);
  let probe = path.isAbsolute(resolved) ? path.sep : '';
  let missing = false;
  for (let i = 0; i < parts.length; i++) {
    probe = path.join(probe, parts[i]);
    if (missing) continue;
    try {
      const st = await fsp.lstat(probe);
      if (st.isSymbolicLink()) throw new ArchiveError('BAD_OUTPUT', 'path contains symlink: ' + probe);
    } catch (err) {
      if (err.code === 'ENOENT' && allowMissingLeaf) {
        missing = true;
        continue;
      }
      if (err.code === 'ENOENT') throw new ArchiveError('BAD_OUTPUT', 'path ancestor missing: ' + probe);
      throw err;
    }
  }
  return resolved;
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
async function ensureSafeFileInsideRoot(root, relativePath) {
  const abs = path.resolve(root, relativePath);
  const base = path.resolve(root);
  if (!abs.startsWith(base + path.sep)) throw new ArchiveError('BAD_OUTPUT', 'file escapes output root');
  await ensureNoSymlinkAncestors(abs, { allowMissingLeaf: false });
  const st = await fsp.lstat(abs);
  if (st.isSymbolicLink() || !st.isFile()) throw new ArchiveError('BAD_OUTPUT', 'zip source must be a real file: ' + abs);
  return abs;
}
async function atomicWriteJson(file, data, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fsp.writeFile(tmp, redactSignedUrls(jsonText(data)), { mode });
  await fsp.chmod(tmp, mode);
  await fsp.rename(tmp, file);
  await fsp.chmod(file, mode);
}
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
// A takeover claim is abandoned when it names a dead process on this host, or when it carries no
// usable owner at all and is old enough that no live taker could still be behind it. A claim naming
// a live pid, or one from another host, is never abandoned: it is contention, and it fails closed.
function claimIsAbandoned(claim, stat) {
  const ageMs = stat ? Date.now() - stat.mtimeMs : 0;
  if (!claim || !Number.isInteger(claim.pid)) return !!stat && ageMs > LOCK_CLAIM_MAX_AGE_MS;
  if (claim.host && claim.host !== os.hostname()) return false;
  if (!claim.host) return ageMs > LOCK_CLAIM_MAX_AGE_MS;
  return !isPidAlive(claim.pid);
}
function isPidAlive(pid) { try { process.kill(pid, 0); return true; } catch (err) { if (err && err.code === 'EPERM') return true; return false; } }
function profilePaths(root, handle) {
  validateHandle(handle);
  return {
    root,
    stateDir: path.join(root, '.frameferry', handle),
    mediaDir: path.join(root, 'media', handle),
    receiptDir: path.join(root, 'receipts', handle),
    lock: path.join(root, '.frameferry', handle, 'lock.json'),
    manifest: path.join(root, '.frameferry', handle, 'manifest.json'),
    owner: path.join(root, '.frameferry', handle, 'current-owner.json'),
    status: path.join(root, '.frameferry', handle, 'status.json')
  };
}
async function withLock(paths, runId, fn, attempt = 0) {
  await ensureSafeDir(paths.stateDir, paths.root);
  // The token makes the lock attributable to this exact acquisition, so a takeover that happens
  // while we hold it cannot be mistaken for our own lock on release.
  const token = crypto.randomUUID();
  try {
    const fd = await fsp.open(paths.lock, 'wx', 0o600);
    await fd.writeFile(JSON.stringify({ runId, token, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }) + '\n');
    await fd.close();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (attempt >= LOCK_TAKEOVER_MAX_ATTEMPTS) throw new ArchiveError('LOCKED', 'profile lock could not be acquired within bounded stale-takeover attempts');
    const lock = await readJson(paths.lock, {});
    if (!lock.host || lock.host !== os.hostname()) throw new ArchiveError('LOCKED_FOREIGN', 'profile lock belongs to another or unknown host; failing closed', { lock });
    // A lock that names no pid cannot be proved stale. Assuming it is would hand a second writer
    // the profile on nothing more than a partial write.
    if (!Number.isInteger(lock.pid)) throw new ArchiveError('LOCKED', 'profile lock does not name a pid; failing closed rather than assuming it is stale', { lock });
    if (isPidAlive(lock.pid)) throw new ArchiveError('LOCKED', 'profile is locked by alive pid ' + lock.pid, { lock });
    // Renaming by path is not a claim: a caller that read this stale lock but acted late could move
    // the winner's fresh lock aside and become a second writer. The claim is therefore taken on the
    // exact inode observed. Only one caller can create that claim file, and the inode is re-checked
    // before anything is moved, so a lock that has already been replaced is left alone.
    const staleStat = await fsp.stat(paths.lock).catch(() => null);
    if (!staleStat) return withLock(paths, runId, fn, attempt + 1);
    const claimPath = paths.lock + '.claim-' + staleStat.ino;
    let claimFd;
    try { claimFd = await fsp.open(claimPath, 'wx', 0o600); }
    catch (claimErr) {
      if (claimErr.code !== 'EEXIST') throw claimErr;
      // An empty, anonymous claim was permanent: a taker killed between creating it and releasing
      // it blocked the handle for good. The claim now says who holds it, so an abandoned one can be
      // told apart from a live one and recovered -- while a live or unjudgeable claim still fails
      // closed, because recovering one of those is exactly how a second writer gets in.
      const claim = await readJson(claimPath, null).catch(() => null);
      const abandoned = claimIsAbandoned(claim, await fsp.stat(claimPath).catch(() => null));
      if (!abandoned) throw new ArchiveError('LOCKED', 'another run is already taking over this stale lock; failing closed', { lock, claim: claim ? { runId: claim.runId ?? null, pid: claim.pid ?? null, host: claim.host ?? null } : null });
      // Removing it does not itself grant the takeover: whoever wins the exclusive create below is
      // the single holder, and every loser sees a live claim and stops.
      await fsp.unlink(claimPath).catch(() => {});
      return withLock(paths, runId, fn, attempt + 1);
    }
    await claimFd.writeFile(JSON.stringify({ runId, token, pid: process.pid, host: os.hostname(), lockInode: staleStat.ino, createdAt: new Date().toISOString() }) + '\n').catch(() => {});
    try {
      const recheck = await fsp.stat(paths.lock).catch(() => null);
      if (recheck && recheck.ino === staleStat.ino) {
        await fsp.rename(paths.lock, paths.lock + '.stale-' + staleStat.ino + '-' + Date.now()).catch(renameErr => { if (renameErr.code !== 'ENOENT') throw renameErr; });
      }
    } finally {
      await claimFd.close().catch(() => {});
      await fsp.unlink(claimPath).catch(() => {});
    }
    return withLock(paths, runId, fn, attempt + 1);
  }
  // Between creating the lock and using it, confirm the file on disk is still the one we wrote.
  const held = await readJson(paths.lock, null);
  const heldStat = await fsp.stat(paths.lock).catch(() => null);
  if (!held || held.token !== token) throw new ArchiveError('LOCKED', 'profile lock was taken over during acquisition; failing closed', { lock: held });
  try { return await fn(); }
  finally {
    // Release only what is still, byte for byte and inode for inode, the lock this run created.
    const currentStat = await fsp.stat(paths.lock).catch(() => null);
    const current = await readJson(paths.lock, null).catch(() => null);
    if (current && currentStat && heldStat && currentStat.ino === heldStat.ino && current.token === token) await fsp.unlink(paths.lock).catch(() => {});
  }
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const sec = Number(value);
  if (Number.isFinite(sec)) return new Date(now + Math.max(0, sec) * 1000).toISOString();
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
function parseDateText(value) {
  if (!value) return null;
  const clean = String(value).split('\n').map(s => s.trim()).filter(Boolean).at(-1) || String(value).trim();
  if (!/\b(?:19|20)\d{2}\b/.test(clean)) return clean;
  const t = Date.parse(clean);
  return Number.isFinite(t) ? new Date(t).toISOString() : clean;
}
function parseReportedTotal(text) {
  if (!text) return null;
  const s = String(text);
  const patterns = [
    /(\d+(?:[,. ]\d{3})*)\s*(?:posts?|post)\b/gi,
    /(?:posts?|post)\D{0,20}(\d+(?:[,. ]\d{3})*)/gi
  ];
  const candidates = [];
  for (const [score, re] of patterns.entries()) {
    for (const m of s.matchAll(re)) {
      const before = s.slice(Math.max(0, (m.index || 0) - 16), m.index || 0).toLowerCase();
      const after = s.slice((m.index || 0) + m[0].length, (m.index || 0) + m[0].length + 16).toLowerCase();
      if (/following\s*$/.test(before) || /^\s*follow(?:ing|ers?)/.test(after)) continue;
      candidates.push({ value: m[1], score, index: m.index || 0 });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score || a.index - b.index);
  return Number(String(candidates[0].value).replace(/[^0-9]/g, ''));
}
function legacyStableMediaId(item) {
  const shortcode = String(item.shortcode || '').trim();
  const index = Number.isInteger(item.carouselIndex) ? item.carouselIndex : 0;
  if (!shortcode) throw new ArchiveError('BAD_ITEM', 'media item missing shortcode');
  return (shortcode + '-' + index).replace(/[^A-Za-z0-9._-]/g, '_');
}
function stableMediaId(item, contentSha = null) {
  const shortcode = String(item.shortcode || '').trim();
  const index = Number.isInteger(item.carouselIndex) ? item.carouselIndex : 0;
  const category = VALID_CATEGORIES.includes(item.category) ? item.category : 'posts';
  const fingerprint = item.providerMediaFingerprint || providerMediaFingerprint(item.href);
  if (shortcode && fingerprint) return category + '__' + sha256(JSON.stringify([category, shortcode, fingerprint]));
  if (shortcode) {
    const base = (shortcode + '-' + index).replace(/[^A-Za-z0-9._-]/g, '_');
    return category === 'posts' ? base : (category + '__' + base);
  }
  if (!contentSha) throw new ArchiveError('BAD_ITEM', 'content-hash identity required when shortcode is unavailable');
  return (category + '__sha256-' + contentSha).replace(/[^A-Za-z0-9._-]/g, '_');
}
function fallbackFailureKey(item, index) {
  const category = VALID_CATEGORIES.includes(item?.category) ? item.category : 'posts';
  const shortcode = String(item?.shortcode || '').trim();
  return shortcode ? category + '__' + shortcode + '-' + (Number.isInteger(item.carouselIndex) ? item.carouselIndex : 0) : category + '__pending-' + index;
}
function normalizeItems(rawItems, opts = {}) {
  const options = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  const category = VALID_CATEGORIES.includes(options.category) ? options.category : 'posts';
  const mediaTypes = options.mediaTypes || DEFAULT_MEDIA_TYPES;
  const allowedKnown = new Set(mediaTypes.map(normalizeMediaType));
  const seenRaw = new Set();
  const latest = new Map();
  for (const raw of rawItems || []) latest.set(rawCardIdentity(raw), raw);
  const seenStable = new Set();
  const seenPosts = new Set();
  const nextIndex = new Map();
  const items = [];
  for (const raw of latest.values()) {
    const mediaType = normalizeMediaType(raw.mediaType ?? raw.type);
    if (mediaType !== 'unknown' && allowedKnown.size && !allowedKnown.has(mediaType)) continue;
    const shortcode = String(raw.shortcode || raw.dataId || '').trim();
    const href = raw.href || null;
    const rawKey = [category, shortcode || '-', href || '-', mediaType, raw.dateRaw || raw.dateText || '-', raw.captionTruncated || raw.caption || '-', raw.highlightGroup || options.highlightGroup || '-'].join('|');
    if (seenRaw.has(rawKey)) continue;
    seenRaw.add(rawKey);
    let carouselIndex;
    if (Number.isInteger(raw.carouselIndex)) carouselIndex = raw.carouselIndex;
    else {
      const key = shortcode ? shortcode : '__missing-shortcode__';
      carouselIndex = nextIndex.get(key) || 0;
      nextIndex.set(key, carouselIndex + 1);
    }
    const dateRaw = raw.dateRaw ?? raw.dateText ?? null;
    const item = {
      category,
      shortcode: shortcode || null,
      carouselIndex,
      mediaType,
      href,
      dateRaw: dateRaw ? String(dateRaw).trim() : null,
      dateParsed: raw.dateParsed || parseDateText(dateRaw),
      captionTruncated: raw.captionTruncated ?? raw.caption ?? null,
      likes: raw.likes != null ? String(raw.likes) : null,
      comments: raw.comments != null ? String(raw.comments) : null,
      permalink: raw.permalink ?? null,
      highlightGroup: raw.highlightGroup ?? options.highlightGroup ?? null,
      rawPostId: shortcode || null,
      providerMediaFingerprint: providerMediaFingerprint(href),
      locatorObservedAt: raw.locatorObservedAt || raw.observedAt || new Date().toISOString(),
      metadataProvenance: raw.metadataProvenance || { observedAt: raw.observedAt || new Date().toISOString(), category, source: 'supported-ui', dateRaw, captionTruncated: raw.captionTruncated ?? raw.caption ?? null },
      identityBasis: shortcode ? 'provider-media-fingerprint-v1' : 'content-sha256'
    };
    item.identityDisposition = item.providerMediaFingerprint ? 'bound' : 'missing-provider-fingerprint';
    item.stableId = shortcode && item.providerMediaFingerprint ? stableMediaId(item) : null;
    if (item.stableId && seenStable.has(item.stableId)) continue;
    if (item.stableId) seenStable.add(item.stableId);
    if (shortcode) seenPosts.add(shortcode);
    item.providerMediaFingerprint = providerMediaFingerprint(href);
    items.push(item);
  }
  // How many slides this post actually showed in this observation. A single-slide post has an
  // unambiguous index; a carousel does not, and needs its mapping proved before it can be reused.
  const slideCounts = new Map();
  for (const item of items) if (item.shortcode) slideCounts.set(item.shortcode, (slideCounts.get(item.shortcode) || 0) + 1);
  for (const item of items) item.slideCount = item.shortcode ? slideCounts.get(item.shortcode) : 1;
  return { items, uniquePostCount: seenPosts.size };
}
function validateProviderMediaUrl(raw) {
  let u;
  try { u = new URL(raw, PROVIDER_ORIGIN); } catch { throw new ArchiveError('BAD_URL', 'invalid media URL'); }
  if (!providerMediaIdentity(u.href)) throw new ArchiveError('BAD_URL', 'media URL must be https://instacognito.com/media?id=...');
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
async function fetchWithValidatedRedirects(url, { fetchImpl, remainingMs, maxRedirects = 5, dnsLookup, signal, stopOnDenial = false }) {
  let current = validateProviderMediaUrl(url).href;
  await validateRedirectTarget(current, dnsLookup);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(current, { redirect: 'manual', signal });
    if (res.status === 429) {
      const retryAt = parseRetryAfter(headerGet(res, 'retry-after')) || new Date(Date.now() + 3600000).toISOString();
      if (stopOnDenial) throw new DeferredError(retryAt);
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
        hash.update(chunk);
        await fh.write(chunk);
      }
    } else {
      for await (const chunkRaw of body) {
        if (signal?.aborted) throw new ArchiveError('TIMEOUT', 'download timeout');
        const chunk = Buffer.from(chunkRaw);
        bytes += chunk.length;
        if (bytes > maxBytes) throw new ArchiveError('TOO_LARGE', 'download exceeds max bytes');
        if (Buffer.concat(head).length < 16) head.push(chunk.subarray(0, 16));
        hash.update(chunk);
        await fh.write(chunk);
      }
    }
  } finally {
    await fh.close();
  }
  const first = Buffer.concat(head).subarray(0, 16);
  const kind = mediaKindFromMagic(first);
  if (!kind) throw new ArchiveError('BAD_SIGNATURE', 'download signature is not recognized media');
  return { bytes, sha256: hash.digest('hex'), kind };
}
async function verifyReceipt(paths, receipt) {
  if (!receipt || !receipt.path || !receipt.sha256 || !Number.isInteger(receipt.bytes)) return false;
  const file = path.resolve(paths.root, receipt.path);
  if (!file.startsWith(paths.root + path.sep)) return false;
  try { await ensureNoSymlinkAncestors(file, { allowMissingLeaf: false }); }
  catch (err) { if (err.code === 'ENOENT' || err.code === 'BAD_OUTPUT') return false; throw err; }
  const st = await fsp.lstat(file).catch(() => null);
  if (!st || st.isSymbolicLink() || !st.isFile() || st.size !== receipt.bytes) return false;
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 65536 })) digest.update(chunk);
  return digest.digest('hex') === receipt.sha256;
}
// Pending versus failed, and resolution that is proved rather than assumed.
function isPendingEntry(entry) { return !!entry && PENDING_MARKERS.has(String(entry.error || '')); }
// Older manifests only had `failed`, with unattempted work filed alongside real failures. Split
// them on read so a legacy manifest reports the same truth as a fresh one, without rewriting it.
function partitionPriorOutcomes(prior) {
  const failed = {};
  const pending = { ...(prior?.pending || {}) };
  for (const [id, entry] of Object.entries(prior?.failed || {})) {
    if (isPendingEntry(entry)) { pending[id] = entry; continue; }
    failed[id] = entry;
    // An older writer could record the same id in both maps. It is one piece of outstanding work
    // either way, so it is normalized to the failure record, which carries the real cause, rather
    // than being returned twice and counted twice downstream.
    delete pending[id];
  }
  return { failed, pending };
}
// An outstanding entry is cleared ONLY when a completed receipt for the same id is present and its
// bytes still hash to what the receipt claims. Presence alone is not proof, and anything that
// cannot be proved is retained rather than quietly dropped.
// Bytes hashing correctly is not enough: a receipt filed under the wrong key, or belonging to
// another handle, proves nothing about the id being cleared here.
function receiptMatchesIdentity(receipt, id, handle) {
  if (!receipt) return false;
  // Positive proof, not absence of contradiction. Treating a missing stableId or handle as "no
  // objection" let a receipt with no identity at all resolve any id asked of it.
  const receiptId = receiptStableId(receipt);
  if (!receiptId || !id || receiptId !== id) return false;
  if (!receipt.profileHandle || !handle || receipt.profileHandle !== handle) return false;
  const category = VALID_CATEGORIES.find(c => id.startsWith(c + '__')) || 'posts';
  if (receiptCategory(receipt) !== category) return false;
  if (id.startsWith(category + '__sha256-')) return id === category + '__sha256-' + receipt.sha256;
  if (new RegExp('^' + category + '__[a-f0-9]{64}$').test(id)) {
    if (!receipt.shortcode) return false;
    if (receipt.providerMediaFingerprint) return /^[a-f0-9]{64}$/.test(receipt.providerMediaFingerprint) && stableMediaId(receipt) === id;
    // Older manifest snapshots may omit a fingerprint that the immutable receipt file
    // still carries. Observation-specific reuse verifies its hash-bound ID separately.
    return receipt.identityBasis === 'provider-media-fingerprint-v1' && receipt.discoveryId === id;
  }
  if (!receipt.shortcode) return false;
  const legacy = (category === 'posts' ? '' : category + '__') + legacyStableMediaId(receipt);
  return legacy === id;
}
// A provider locator fingerprint can rotate across runs. It is NOT byte identity.
// Only an independently saved, bounded quarantine receipt and both rehashed files can
// certify an alias. This helper reads evidence; it never rewrites either media/receipt.
async function loadByteEvidence(paths, evidenceRoot, completed, handle, remainingMs) {
  const aliases = {};
  if (evidenceRoot == null) return { aliases, receipt: null };
  const reject = message => { throw new ArchiveError('BYTE_EVIDENCE', message); };
  if (typeof evidenceRoot !== 'string' || !evidenceRoot) reject('evidence root must be an explicit directory');
  const root = path.resolve(evidenceRoot);
  if (root === paths.root || root.startsWith(paths.root + path.sep) || paths.root.startsWith(root + path.sep)) reject('evidence and canonical roots must not overlap');
  const started = Date.now();
  const budget = Math.max(1, remainingMs);
  const checkBudget = () => { if (Date.now() - started >= budget) reject('byte evidence verification deadline reached'); };
  const ep = profilePaths(root, handle);
  try {
    await ensureNoSymlinkAncestors(ep.manifest, { allowMissingLeaf: false });
    const stat = await fsp.lstat(ep.manifest);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) reject('evidence manifest is not a bounded regular file');
    const bytes = await fsp.readFile(ep.manifest), manifest = JSON.parse(bytes);
    if (manifest.handle !== handle) reject('evidence manifest belongs to another handle');
    await ensureNoSymlinkAncestors(ep.owner, {allowMissingLeaf:false});
    const os = await fsp.lstat(ep.owner); if (!os.isFile() || os.size > 1024 * 1024) reject('evidence owner is not bounded');
    const owner = await readJson(ep.owner, null);
    if (!owner || owner.handle !== handle || owner.terminal !== true || evaluateOwnerRecord(owner).state === 'ACTIVE') reject('evidence owner is not terminal');
    const entries = Object.entries(manifest.completed || {});
    if (entries.length > 5000) reject('evidence receipt count exceeds bound');
    let total = 0;
    const byScope = new Map();
    for (const [id, r] of Object.entries(completed)) {
      const key = JSON.stringify([receiptCategory(r), r.shortcode, r.sha256, r.bytes]);
      (byScope.get(key) || byScope.set(key, []).get(key)).push([id,r]);
    }
    for (const [id, r] of entries) {
      checkBudget();
      if (!Number.isSafeInteger(r.bytes) || r.bytes <= 0 || r.bytes > 50 * 1024 * 1024) reject('invalid evidence item byte bound');
      total += r.bytes; if (total > 512 * 1024 * 1024) reject('evidence byte bound exceeded');
      if (!receiptMatchesIdentity(r,id,handle) || !r.providerMediaFingerprint || stableMediaId(r) !== id) reject('evidence receipt lacks exact fingerprint identity');
      if (!path.resolve(root,r.path).startsWith(ep.mediaDir + path.sep)) reject('evidence media escapes exact handle directory');
      const receiptFile = path.join(ep.receiptDir,id+'.json');
      await ensureNoSymlinkAncestors(receiptFile, {allowMissingLeaf:false});
      const rs = await fsp.lstat(receiptFile); if (!rs.isFile() || rs.size > 1024 * 1024) reject('evidence receipt is not bounded');
      const onDisk = await readJson(receiptFile,null);
      if (!onDisk || JSON.stringify(onDisk) !== JSON.stringify(r)) reject('evidence manifest and immutable receipt disagree');
      if (!await verifyReceipt(ep,r)) reject('evidence media failed byte verification');
      if (manifest.conflicts?.[id]) continue;
      const candidates = byScope.get(JSON.stringify([receiptCategory(r),r.shortcode,r.sha256,r.bytes])) || [];
      // Byte-identical duplicate slides remain ambiguous. Never choose by encounter index.
      if (candidates.length !== 1) continue;
      const [canonicalId,canonical] = candidates[0];
      if (!receiptMatchesIdentity(canonical,canonicalId,handle) || !path.resolve(paths.root,canonical.path).startsWith(paths.mediaDir + path.sep) || !await verifyReceipt(paths,canonical)) reject('canonical evidence failed identity/byte verification');
      aliases[id] = {canonicalId, fingerprint:r.providerMediaFingerprint, category:receiptCategory(r), rawPostId:r.shortcode, handle, sha256:r.sha256, bytes:r.bytes, evidence:'scoped-quarantine-byte-proof', evidenceManifestSha256:sha256(bytes), evidenceRunId:r.runId, observedAt:r.completedAt};
    }
    checkBudget();
    if (sha256(await fsp.readFile(ep.manifest)) !== sha256(bytes)) reject('evidence changed during verification');
    return {aliases,receipt:{manifestSha256:sha256(bytes),verifiedRefs:entries.length,verifiedBytes:total,unambiguousAliases:Object.keys(aliases).length}};
  } catch (err) { if (err.code === 'BYTE_EVIDENCE') throw err; reject('evidence input could not be safely verified'); }
}
async function reconcileAgainstReceipts(paths, completed, entries, handle = null) {
  const expectedHandle = handle || (paths && paths.stateDir ? path.basename(paths.stateDir) : null);
  const retained = {};
  const resolved = [];
  // Ids the manifest calls completed but whose receipt cannot be proved. They are owed, not done,
  // and must stop being counted as completed so the two maps can never claim the same id.
  const unverifiable = [];
  for (const [id, entry] of Object.entries(entries || {})) {
    const receipt = (completed || {})[id];
    if (receipt && receiptMatchesIdentity(receipt, id, expectedHandle) && await verifyReceipt(paths, receipt)) { resolved.push(id); continue; }
    if (receipt) unverifiable.push(id);
    retained[id] = entry;
  }
  return { retained, resolved: resolved.sort(), unverifiable: unverifiable.sort() };
}
// The three outcome maps answer one question each -- acquired, failed, owed -- and an id can only
// have one answer. A live run finished with 684 ids recorded as both completed and pending, so the
// invariant is now asserted on the way to disk rather than trusted.
function outcomeMapOverlaps(completed, failed, pending) {
  const completedIds = new Set(Object.keys(completed || {}));
  const failedIds = Object.keys(failed || {});
  const failedSet = new Set(failedIds);
  return {
    completedFailed: failedIds.filter(id => completedIds.has(id)).sort(),
    completedPending: Object.keys(pending || {}).filter(id => completedIds.has(id)).sort(),
    failedPending: Object.keys(pending || {}).filter(id => failedSet.has(id)).sort()
  };
}
function assertDisjointOutcomes(completed, failed, pending, stage) {
  const overlaps = outcomeMapOverlaps(completed, failed, pending);
  const total = overlaps.completedFailed.length + overlaps.completedPending.length + overlaps.failedPending.length;
  if (!total) return;
  throw new ArchiveError('INVARIANT', 'outcome maps must be pairwise disjoint before persisting (' + stage + ')', {
    stage,
    completedFailed: overlaps.completedFailed.slice(0, 20),
    completedPending: overlaps.completedPending.slice(0, 20),
    failedPending: overlaps.failedPending.slice(0, 20),
    overlapCount: total
  });
}
// Receipt files are committed to disk before the manifest learns about them, so a crash in between
// leaves a verifiable receipt the next run would otherwise re-download as an orphan.
async function adoptOrphanReceipts(paths, completed, handle) {
  const adopted = [];
  const names = await fsp.readdir(paths.receiptDir).catch(() => []);
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (completed[id]) continue;
    const receipt = await readJson(path.join(paths.receiptDir, name), null).catch(() => null);
    if (!receipt || !receiptMatchesIdentity(receipt, id, handle)) continue;
    if (!await verifyReceipt(paths, receipt)) continue;
    completed[id] = receipt;
    adopted.push(id);
  }
  return adopted.sort();
}
function ownerRecord({ runId, handle, stage, status = 'RUNNING', terminal = false, startedAt, extra = {} }) {
  return { runId, handle, pid: process.pid, host: os.hostname(), stage, status, terminal, startedAt, updatedAt: new Date().toISOString(), ...extra };
}
// A claim is metadata, never authority. It is honoured only while the process it names is actually
// alive on this host; otherwise it is stale and gets reconciled. That is both halves of the rule:
// a dead claim must not block a resume, and a live one must not gain a second writer.
function evaluateOwnerRecord(owner) {
  if (!owner || !owner.runId) return { state: 'NONE', owner: owner || null };
  if (owner.terminal) return { state: 'TERMINAL', owner };
  if (owner.host && owner.host !== os.hostname()) return { state: 'FOREIGN', owner };
  if (Number.isInteger(owner.pid) && isPidAlive(owner.pid)) return { state: 'ACTIVE', owner };
  return { state: 'STALE', owner };
}
// Coverage is a fact about MEDIA, not about posts. The reported total is a post count, so reaching
// it says nothing about carousel slides still missing: with every post already on the cached first
// page the scan exited immediately and the outstanding slides were never rediscovered. Since signed
// URLs are deliberately never persisted, rediscovery is the only way an outstanding id can be
// retried at all -- stopping early is exactly what starved it.
function discoveryCoverageSatisfied({ reportedTotal, uniquePostCount, resumeTargets, discoveredIds, category = 'posts' }) {
  if (!reportedTotal) return false;
  if (!(uniquePostCount >= reportedTotal)) return false;
  for (const id of resumeTargets || []) {
    const targetCategory = VALID_CATEGORIES.find(c => id.startsWith(c + '__')) || 'posts';
    if (targetCategory === category && (!discoveredIds || !discoveredIds.has(id))) return false;
  }
  return true;
}
async function downloadOne(item, paths, { fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MAX_BYTES, runId, remainingMs = DEFAULT_NETWORK_TIMEOUT_MS, dnsLookup, timeoutMs, completedMap = {}, handle, stopOnDenial = false } = {}) {
  const observedFingerprint = providerMediaFingerprint(item.href);
  if (item.providerMediaFingerprint && item.providerMediaFingerprint !== observedFingerprint) throw new ArchiveError('IDENTITY_CONFLICT', 'provided fingerprint contradicts supported media locator');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs || remainingMs));
  const tempBase = path.join(paths.mediaDir, (item.stableId || fallbackFailureKey(item, 0)) + '.' + Date.now() + '-' + crypto.randomBytes(8).toString('hex') + '.part');
  try {
    const res = await fetchWithValidatedRedirects(item.href, { fetchImpl, remainingMs, dnsLookup, signal: ac.signal, stopOnDenial });
    if ([401,403].includes(res.status)) throw new ArchiveError('DENIED', 'provider denied acquisition with HTTP ' + res.status);
    if (!res.ok) throw new ArchiveError('DOWNLOAD_FAILED', 'download failed with HTTP ' + res.status);
    const ct = (headerGet(res, 'content-type') || '').toLowerCase();
    if (ct.includes('text/html')) throw new ArchiveError('BAD_CONTENT', 'provider returned HTML instead of media');
    const declared = Number(headerGet(res, 'content-length') || '0');
    if (declared > maxBytes) throw new ArchiveError('TOO_LARGE', 'content-length exceeds max bytes');
    await ensureSafeDir(paths.mediaDir, paths.root);
    await ensureSafeDir(paths.receiptDir, paths.root);
    const got = await streamResponseToPart(res, tempBase, { maxBytes, signal: ac.signal });
    if (declared && declared !== got.bytes) throw new ArchiveError('BAD_LENGTH', 'content-length mismatch');
    const actualMediaType = normalizeMediaType(got.kind);
    const expectedMediaType = normalizeMediaType(item.mediaType);
    const mimeMediaType = ct.startsWith('image/') ? 'image' : ct.startsWith('video/') ? 'video' : 'unknown';
    if ((expectedMediaType !== 'unknown' && expectedMediaType !== actualMediaType) ||
        (mimeMediaType !== 'unknown' && mimeMediaType !== actualMediaType)) {
      throw new ArchiveError('MEDIA_TYPE_MISMATCH', 'delivered media magic contradicts expected type or MIME; item stays owed', {
        expectedMediaType,
        actualMediaType,
        mimeClass: mimeMediaType,
        contentTypeToken: sanitizeContentTypeToken(ct),
        httpStatus: typeof res.status === 'number' && Number.isFinite(res.status) && res.status >= 0 ? res.status : null,
        declaredLength: Number.isFinite(declared) && declared >= 0 ? declared : null,
        streamedBytes: Number.isFinite(got.bytes) && got.bytes >= 0 ? got.bytes : null,
      });
    }
    const mediaType = actualMediaType;
    const stableId = item.stableId || stableMediaId(item, got.sha256);
    const ext = extFor(got.kind);
    const dest = path.join(paths.mediaDir, stableId + '.' + ext);
    let existing = completedMap[stableId];
    if (!receiptMatchesIdentity(existing, stableId, handle)) {
      const onDisk = await readJson(path.join(paths.receiptDir, stableId + '.json'), null);
      if (receiptMatchesIdentity(onDisk, stableId, handle)) existing = onDisk;
    }
    // Matching bytes are not an identity. Without this check a receipt belonging to another handle
    // could be adopted wholesale just because the content happened to hash the same.
    const existingIsOurs = receiptMatchesIdentity(existing, stableId, handle);
    if (existingIsOurs && existing.sha256 === got.sha256 && existing.bytes === got.bytes && await verifyReceipt(paths, existing)) {
      await fsp.rm(tempBase, { force: true }).catch(() => {});
      // Same bytes, so the media is the same, but it was just observed under the current provider
      // id. Refreshing the fingerprint keeps the slide mapping provable on the next run instead of
      // leaving a stale one that would force a re-acquire.
      return { receipt: existing, fetchedButReused: true };
    }
    // Different bytes for an id whose stored receipt still verifies is a conflict, not an update.
    // Overwriting would destroy verified content on nothing better than slide position, so the
    // observation is reported and held instead.
    if (existingIsOurs && existing.sha256 !== got.sha256 && await verifyReceipt(paths, existing)) {
      await fsp.rm(tempBase, { force: true }).catch(() => {});
      return { receipt: existing, fetchedButReused: true, conflict: { expectedSha256: existing.sha256, observedSha256: got.sha256, observedBytes: got.bytes, observedAt: new Date().toISOString(), observedProviderMediaFingerprint: item.providerMediaFingerprint || null, category: item.category, rawPostId: item.rawPostId || item.shortcode || null, metadataProvenance: item.metadataProvenance || null } };
    }
    const destinationExists = await fsp.lstat(dest).catch(err => { if (err.code === 'ENOENT') return null; throw err; });
    if (destinationExists && !existingIsOurs) throw new ArchiveError('IDENTITY_CONFLICT', 'existing canonical destination lacks a positively bound receipt; held unchanged');
    if (destinationExists?.isSymbolicLink()) throw new ArchiveError('BAD_OUTPUT', 'canonical destination is a symlink');
    await fsp.rename(tempBase, dest);
    const receipt = {
      stableId,
      id: stableId,
      category: item.category,
      mediaType,
      shortcode: item.shortcode || null,
      carouselIndex: item.carouselIndex || 0,
      identityBasis: item.identityBasis || (item.shortcode ? 'provider-media-fingerprint-v1' : 'content-sha256'),
      providerMediaFingerprint: item.providerMediaFingerprint ?? providerMediaFingerprint(item.href),
      discoveryId: item.discoveryId || item.stableId || null,
      metadataProvenance: item.metadataProvenance || null,
      slideCount: Number.isInteger(item.slideCount) ? item.slideCount : 1,
      captionTruncated: item.captionTruncated ?? null,
      permalink: item.permalink ?? null,
      dateRaw: item.dateRaw ?? null,
      dateParsed: item.dateParsed ?? null,
      highlightGroup: item.highlightGroup ?? null,
      likes: item.likes ?? null,
      comments: item.comments ?? null,
      profileHandle: handle,
      path: path.relative(paths.root, dest),
      bytes: got.bytes,
      sha256: got.sha256,
      contentType: ct || 'application/octet-stream',
      sourceHost: 'instacognito.com',
      runId,
      completedAt: new Date().toISOString()
    };
    await atomicWriteJson(path.join(paths.receiptDir, stableId + '.json'), receipt);
    return { receipt, fetchedButReused: false };
  } catch (err) {
    await fsp.rm(tempBase, { force: true }).catch(() => {});
    if (err.name === 'AbortError') throw new ArchiveError('TIMEOUT', 'download timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
function decideOutcome({ reportedTotal, uniquePostCount, failed, pending = 0, noGrowth, hitLimit, mode, reusedOnlyComplete = false }) {
  if (reportedTotal == null) return { status: 'ACTION_REQUIRED', reason: 'reported total could not be parsed' };
  if (failed > 0) return { status: 'PARTIAL', reason: failed + ' downloads failed' };
  if (pending > 0) return { status: 'PARTIAL', reason: pending + ' items pending acquisition' };
  if (hitLimit) return { status: 'PARTIAL', reason: 'bounded limit reached' };
  if (noGrowth && mode === 'full' && uniquePostCount < reportedTotal) return { status: 'PARTIAL', reason: 'no new cards loaded' };
  if (reportedTotal != null && uniquePostCount < reportedTotal) return { status: 'PARTIAL', reason: 'advertised shortfall ' + uniquePostCount + '/' + reportedTotal };
  return { status: 'COMPLETE', reason: reusedOnlyComplete ? 'all requested media reused from verified receipts' : 'reported total reached and downloads verified' };
}
function sanitizeFailedItem(item, error, index = 0, attempts = null, errorCode = null) {
  return {
    // How much budget this id has already consumed, carried across runs so acquisition can rotate
    // rather than spending every run on whichever id happens to sort first.
    attempts: Number.isInteger(attempts) ? attempts : (Number.isInteger(item?.attempts) ? item.attempts : 0),
    stableId: item.stableId || fallbackFailureKey(item, index),
    category: item.category || 'posts',
    shortcode: item.shortcode || null,
    carouselIndex: item.carouselIndex || 0,
    mediaType: item.mediaType || 'unknown',
    identityBasis: item.identityBasis || (item.shortcode ? 'provider-shortcode' : 'content-sha256'),
    providerMediaFingerprint: item.providerMediaFingerprint || null,
    rawPostId: item.rawPostId || item.shortcode || null,
    discoveryId: item.discoveryId || item.stableId || null,
    metadataProvenance: item.metadataProvenance || null,
    locatorObservedAt: item.locatorObservedAt || null,
    identityDisposition: item.identityDisposition || null,
    error: redactSignedUrls(error),
    ...(errorCode === 'MEDIA_TYPE_MISMATCH' && item._mismatchDiagnostics ? {
      mismatchDiagnostics: {
        expectedMediaType: ['image', 'video', 'unknown'].includes(item._mismatchDiagnostics.expectedMediaType) ? item._mismatchDiagnostics.expectedMediaType : 'unknown',
        actualMediaType: ['image', 'video', 'unknown'].includes(item._mismatchDiagnostics.actualMediaType) ? item._mismatchDiagnostics.actualMediaType : 'unknown',
        mimeClass: ['image', 'video', 'unknown'].includes(item._mismatchDiagnostics.mimeClass) ? item._mismatchDiagnostics.mimeClass : 'unknown',
        contentTypeToken: typeof item._mismatchDiagnostics.contentTypeToken === 'string' && item._mismatchDiagnostics.contentTypeToken.length <= 64 ? item._mismatchDiagnostics.contentTypeToken : null,
        httpStatus: Number.isFinite(item._mismatchDiagnostics.httpStatus) && item._mismatchDiagnostics.httpStatus >= 0 ? item._mismatchDiagnostics.httpStatus : null,
        declaredLength: Number.isFinite(item._mismatchDiagnostics.declaredLength) && item._mismatchDiagnostics.declaredLength >= 0 ? item._mismatchDiagnostics.declaredLength : null,
        streamedBytes: Number.isFinite(item._mismatchDiagnostics.streamedBytes) && item._mismatchDiagnostics.streamedBytes >= 0 ? item._mismatchDiagnostics.streamedBytes : null,
      }
    } : {}),
  };
}
async function writeStatus(paths, status) { await atomicWriteJson(paths.status, status); return status; }
function makeSectionRecord(section = {}) {
  return {
    category: section.category,
    status: section.status || 'UNAVAILABLE',
    reason: section.reason || null,
    tabPresent: section.tabPresent ?? true,
    itemCount: section.itemCount ?? 0,
    downloadedCount: section.downloadedCount ?? 0,
    reusedCount: section.reusedCount ?? 0,
    failedCount: section.failedCount ?? 0,
    pendingCount: section.pendingCount ?? 0,
    mediaTypeFilterApplied: section.mediaTypeFilterApplied || DEFAULT_MEDIA_TYPES,
    evidence: section.evidence || {},
    items: section.items || [],
    reportedTotal: section.reportedTotal ?? null,
    // Everything discovered across the whole scan, not just what the last DOM happened to show.
    // scrapeCardSection has always passed this; it was being dropped here, so the outcome
    // decision could only ever see the visible page.
    uniquePostCount: section.uniquePostCount ?? null,
    noGrowth: !!section.noGrowth,
    hitLimit: !!section.hitLimit
  };
}
function publicItemSummary(item, index = 0) {
  return {
    stableId: item?.stableId || fallbackFailureKey(item, index),
    category: VALID_CATEGORIES.includes(item?.category) ? item.category : 'posts',
    shortcode: item?.shortcode || null,
    carouselIndex: Number.isInteger(item?.carouselIndex) ? item.carouselIndex : 0,
    mediaType: item?.mediaType || 'unknown',
    identityBasis: item?.identityBasis || (item?.shortcode ? 'provider-shortcode' : 'content-sha256'),
    providerMediaFingerprint: item?.providerMediaFingerprint || null,
    rawPostId: item?.rawPostId || item?.shortcode || null,
    metadataProvenance: item?.metadataProvenance || null,
    locatorObservedAt: item?.locatorObservedAt || null,
    captionTruncated: item?.captionTruncated ?? null,
    dateRaw: item?.dateRaw ?? null,
    dateParsed: item?.dateParsed ?? null,
    likes: item?.likes ?? null,
    comments: item?.comments ?? null,
    permalink: item?.permalink ?? null,
    highlightGroup: item?.highlightGroup ?? null
  };
}
function publicSectionRecord(section = {}) {
  const clean = makeSectionRecord(section);
  return {
    category: clean.category,
    status: clean.status,
    reason: clean.reason ? redactSignedUrls(clean.reason) : null,
    tabPresent: clean.tabPresent,
    itemCount: clean.itemCount,
    downloadedCount: clean.downloadedCount,
    reusedCount: clean.reusedCount,
    failedCount: clean.failedCount,
    pendingCount: clean.pendingCount,
    mediaTypeFilterApplied: clean.mediaTypeFilterApplied,
    evidence: clean.evidence || {},
    items: (clean.items || []).map((item, index) => publicItemSummary(item, index)),
    reportedTotal: clean.reportedTotal ?? null,
    noGrowth: !!clean.noGrowth,
    hitLimit: !!clean.hitLimit,
    uniquePostCount: clean.uniquePostCount ?? null
  };
}
function statusSectionRecord(section = {}) {
  const clean = publicSectionRecord(section);
  delete clean.items;
  return clean;
}
function publicProfile(profile = null) {
  if (!profile) return null;
  return {
    handle: profile.handle || null,
    reportedPostCount: profile.reportedPostCount ?? null,
    rawProfileText: profile.rawProfileText ? redactSignedUrls(String(profile.rawProfileText)) : null
  };
}
function receiptCategory(receipt) {
  return VALID_CATEGORIES.includes(receipt?.category) ? receipt.category : 'posts';
}
function receiptStableId(receipt) {
  return receipt?.stableId || receipt?.id || null;
}
function receiptIdentityBasis(receipt) {
  return receipt?.identityBasis || (receipt?.shortcode ? 'provider-shortcode' : 'content-sha256');
}
function receiptShortcode(receipt) {
  return typeof receipt?.shortcode === 'string' && receipt.shortcode.trim() ? receipt.shortcode.trim() : null;
}
function sectionOutcomeForCompleted(section, completedEntries, { mode }) {
  const items = section.items || [];
  const completedForSection = completedEntries.filter(receipt => receiptCategory(receipt) === section.category);
  if (section.category === 'posts') {
    const shortcodes = new Set();
    for (const item of items) if (item.shortcode) shortcodes.add(item.shortcode);
    for (const receipt of completedForSection) {
      const shortcode = receiptShortcode(receipt);
      if (shortcode) shortcodes.add(shortcode);
    }
    const outcome = decideOutcome({
      reportedTotal: section.reportedTotal,
      uniquePostCount: shortcodes.size,
      failed: section.failedCount,
      pending: section.pendingCount || 0,
      noGrowth: section.noGrowth,
      hitLimit: section.hitLimit,
      mode,
      reusedOnlyComplete: section.downloadedCount === 0 && section.reusedCount > 0
    });
    return { ...outcome, uniquePostCount: shortcodes.size };
  }
  if (section.failedCount > 0) return { status: 'PARTIAL', reason: section.reason || (section.failedCount + ' items failed') };
  if (section.pendingCount > 0) return { status: 'PARTIAL', reason: (section.pendingCount + ' items pending acquisition') };
  if (section.hitLimit) return { status: 'PARTIAL', reason: section.reason || 'bounded limit reached before section settled' };
  if (section.itemCount === 0) return { status: 'UNAVAILABLE', reason: section.reason || 'no visible items found' };
  if (section.noGrowth && mode === 'full') return { status: 'COMPLETE', reason: section.reason || 'visible section exhausted without further growth' };
  return { status: 'COMPLETE', reason: section.reason || 'section downloaded/reused successfully' };
}
function normalizeProvidedSections(sections, mediaTypes) {
  return (sections || []).map(section => {
    const norm = normalizeItems(section.items || [], { category: section.category, mediaTypes });
    return makeSectionRecord({
      category: section.category,
      status: section.status || (norm.items.length ? 'COMPLETE' : 'UNAVAILABLE'),
      reason: section.reason || null,
      tabPresent: section.tabPresent ?? true,
      itemCount: norm.items.length,
      downloadedCount: 0,
      reusedCount: 0,
      failedCount: 0,
      pendingCount: 0,
      mediaTypeFilterApplied: mediaTypes,
      evidence: section.evidence || {},
      items: norm.items,
      reportedTotal: section.reportedTotal ?? null,
      noGrowth: !!section.noGrowth,
      hitLimit: !!section.hitLimit
    });
  });
}
function legacyScanFromItems(opts) {
  const category = opts.category || 'posts';
  const norm = normalizeItems(opts.items || [], { category, mediaTypes: opts.mediaTypes || DEFAULT_MEDIA_TYPES });
  return {
    profile: opts.profile || null,
    sections: [makeSectionRecord({
      category,
      status: 'COMPLETE',
      reason: null,
      tabPresent: true,
      itemCount: norm.items.length,
      mediaTypeFilterApplied: opts.mediaTypes || DEFAULT_MEDIA_TYPES,
      evidence: { mode: 'synthetic-items' },
      items: norm.items,
      reportedTotal: opts.reportedTotal ?? null,
      noGrowth: !!opts.noGrowth,
      hitLimit: !!opts.hitLimit
    })]
  };
}
function finalGlobalOutcome(sections, failedCount, pendingCount = 0, outstandingCount = 0, conflictCount = 0) {
  if (sections.some(section => section.status === 'ACTION_REQUIRED')) return { status: 'ACTION_REQUIRED', reason: 'one or more requested sections could not prove completeness' };
  if (conflictCount > 0) return { status: 'PARTIAL', reason: conflictCount + ' conflicting contents held for review' };
  // Outstanding work carried from earlier runs counts too. Judging completeness on this run's own
  // counts alone let a scan that simply never re-saw an owed id report COMPLETE while owing it.
  if (sections.every(section => section.status === 'COMPLETE') && failedCount === 0 && pendingCount === 0 && outstandingCount === 0) return { status: 'COMPLETE', reason: 'all requested sections completed and downloads verified' };
  if (failedCount === 0 && pendingCount === 0 && outstandingCount > 0) return { status: 'PARTIAL', reason: outstandingCount + ' items still owed from earlier runs and not re-observed by this scan' };
  // Work that was never attempted is outstanding, not failed. Reporting it as failure is what made
  // a resumable backlog look like a wall of download errors.
  if (failedCount === 0 && pendingCount > 0) return { status: 'PARTIAL', reason: pendingCount + ' items pending acquisition, no download failures' };
  return { status: 'PARTIAL', reason: 'one or more requested sections were partial, unavailable, unsupported, or blocked' };
}
const budgetOrigins = new Map();
function elapsedSince(started) {
  if (!budgetOrigins.has(started)) {
    if (budgetOrigins.size >= 1000) budgetOrigins.delete(budgetOrigins.keys().next().value);
    budgetOrigins.set(started, performance.now() - Math.max(0, Date.now() - started));
  }
  return Math.max(Date.now() - started, performance.now() - budgetOrigins.get(started));
}
function remainingTimeout(started, maxTimeMs) { return Math.max(1, maxTimeMs - elapsedSince(started)); }
async function getRenderedCardState(page) {
  return page.locator('#post-container .post-card').evaluateAll(cards => ({
    count: cards.length,
    ids: [...new Set(cards.map(card => card.querySelector('.likes-trigger[data-id], .comments-trigger[data-id], [data-id]')?.getAttribute('data-id')).filter(Boolean))]
  }));
}
const PAGINATION_SENTINEL_ATTR = 'data-ff-pagination-sentinel';
// The provider creates exactly one IntersectionObserver, in `Te`, and re-creates it for every
// rendered batch to watch the top-level card of the newest last post. Wrapping the constructor
// after goto but before the search click means no observer can be created before the probe is
// in place, so the marked element is always the live pagination sentinel -- no inference from
// card markup, and correct even when that post carries no data-id at all.
async function installPaginationSentinelProbe(page) {
  return page.evaluate(attr => {
    if (window.__ffPaginationSentinelProbe) return true;
    const Native = window.IntersectionObserver;
    if (typeof Native !== 'function') return false;
    const markerOwner = new WeakMap();
    function Probed(callback, options) {
      const observer = new Native(callback, options);
      const nativeObserve = observer.observe.bind(observer);
      const nativeUnobserve = observer.unobserve.bind(observer);
      const nativeDisconnect = observer.disconnect.bind(observer);
      let markedTarget = null;
      const clearOwnedMarker = target => {
        try {
          if (target && markerOwner.get(target) === observer) {
            target.removeAttribute(attr);
            markerOwner.delete(target);
          }
        } catch { /* observational cleanup must not break provider lifecycle */ }
      };
      observer.unobserve = function (target) {
        const result = nativeUnobserve(target);
        clearOwnedMarker(target);
        if (markedTarget === target) markedTarget = null;
        return result;
      };
      observer.disconnect = function () {
        const result = nativeDisconnect();
        clearOwnedMarker(markedTarget);
        markedTarget = null;
        return result;
      };
      observer.observe = function (target) {
        const result = nativeObserve(target);
        try {
          for (const marked of document.querySelectorAll('[' + attr + ']')) marked.removeAttribute(attr);
          if (target && typeof target.setAttribute === 'function') {
            target.setAttribute(attr, '1');
            markerOwner.set(target, observer);
            markedTarget = target;
          }
        } catch { /* marking is best effort; never break the provider's own pagination */ }
        return result;
      };
      return observer;
    }
    Probed.prototype = Native.prototype;
    window.IntersectionObserver = Probed;
    window.__ffPaginationSentinelProbe = true;
    return true;
  }, PAGINATION_SENTINEL_ATTR);
}
const CONTINUATION_REQUEST_PATH = '/api/posts';
const CONTINUATION_DENIAL_STATUSES = new Set([401, 403, 429]);
const CHALLENGE_SELECTOR = 'iframe[src*="captcha" i], iframe[src*="challenge" i], iframe[title*="challenge" i], .g-recaptcha, .h-captcha, #challenge-form, #cf-challenge-running, [data-captcha]';
// The provider continuation is a single POST to /api/posts with no cursor in either direction, so
// the only thing that can be observed about it is whether it was issued, whether it is still in
// flight, and whether it came back denied. That is exactly what the pagination stop decision needs:
// a window with no request at all is not evidence of a terminal boundary, a window whose request
// was answered is, and a denial must never be retried into.
function attachContinuationRequestMonitor(page, { pathname = CONTINUATION_REQUEST_PATH } = {}) {
  let startedCount = 0, settledCount = 0, failedCount = 0;
  const paths = {};
  let denial = null;
  const pending = new Set();
  const wanted = pathname == null ? null : String(pathname).replace(/\/+$/, '');
  const matches = request => {
    try { const u = new URL(request.url()); return u.origin === PROVIDER_ORIGIN && (wanted == null ? u.pathname.startsWith('/api/') : u.pathname.replace(/\/+$/, '') === wanted); } catch { return false; }
  };
  const onRequest = request => { if (!matches(request)) return; startedCount++; pending.add(request); const pathname = new URL(request.url()).pathname; const label = ['/api/profile','/api/posts','/api/reels','/api/stories','/api/highlights'].includes(pathname) ? pathname : 'other-api'; paths[label] = (paths[label] || 0) + 1; };
  const onSettled = request => { if (pending.delete(request)) settledCount++; };
  const onFailed = request => { if (pending.has(request)) failedCount++; onSettled(request); };
  const onResponse = response => {
    let request;
    try { request = response.request(); } catch { return; }
    if (!matches(request)) return;
    const status = response.status();
    if (!CONTINUATION_DENIAL_STATUSES.has(status) || denial) return;
    let retryAfter = null;
    try { retryAfter = response.headers()['retry-after'] ?? null; } catch { retryAfter = null; }
    denial = { reason: 'provider denied continuation with HTTP ' + status, status, retryAt: parseRetryAfter(retryAfter) };
  };
  let attached = false;
  if (page && typeof page.on === 'function') {
    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfinished', onSettled);
    page.on('requestfailed', onFailed);
    attached = true;
  }
  return {
    count: () => startedCount,
    snapshot: () => ({ started: startedCount, settled: settledCount, failed: failedCount, inFlight: pending.size, paths: { ...paths } }),
    stop: reason => { denial ||= { reason, kind: 'request-limit', status: null, retryAt: null }; },
    inFlight: () => pending.size,
    denial: () => denial,
    detach() {
      if (!attached) return;
      attached = false;
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onSettled);
      page.off('requestfailed', onFailed);
      pending.clear();
    }
  };
}
async function detectContinuationDenial(page, continuationMonitor) {
  const denial = typeof continuationMonitor?.denial === 'function' ? continuationMonitor.denial() : null;
  if (denial) return denial;
  // CHALLENGE_SELECTOR is a selector list, so .first() is the first DOM match of ANY branch: a
  // hidden .g-recaptcha sitting above a visible #challenge-form would mask a live challenge.
  // Ask whether ANY match is visible, in one round trip, and fail open to "not blocked" if the
  // page cannot be evaluated at all.
  const challenged = await page.locator(CHALLENGE_SELECTOR).evaluateAll(els => els.some(el => {
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }));
  if (challenged) return { reason: 'provider challenge or captcha is visible', status: null, retryAt: null };
  return null;
}
const MIN_GRACE_WINDOW_MS = 250;
const REARM_SETTLE_MS = 250;
async function scrollLastCardCenterAndWaitForGrowth(page, beforeState, { started, maxTimeMs, growthWaitMs = 15000, settleMs = 1200, recenterEveryMs = 1000, maxRecenters = 3, targetUniqueCount = null, continuationMonitor = null, graceAttempts = 1, graceWaitMs = 4000, inFlightSettleMs = 4000, onBatchObserved = null } = {}) {
  let bestState = beforeState;
  let bestCount = beforeState.count || 0;
  let bestIds = new Set(beforeState.ids || []);
  let grew = false;
  let sawLoading = false;
  let lastGrowthAt = 0;
  let nextRecenterAt = 0;
  let recenterCount = 0;
  let waitedMs = 0;
  let graceAttemptsUsed = 0;
  let blocked = null;
  let settlementsUsed = 0;
  // One settlement extension before grace plus one per grace attempt, so the worst case stays
  // growthWaitMs + inFlightSettleMs + graceAttempts * (graceWaitMs + inFlightSettleMs), and every
  // one of those windows is still clamped by remainingTimeout(started, maxTimeMs).
  const maxSettlements = graceAttempts + 1;
  let sentinel = { sentinelIndex: null, sentinelId: null, sentinelSource: null };
  const monitorCount = () => (typeof continuationMonitor?.count === 'function' ? continuationMonitor.count() : 0);
  const latchedDenial = () => (typeof continuationMonitor?.denial === 'function' ? continuationMonitor.denial() : null);
  const requestsBefore = monitorCount();
  const continuationRequests = () => monitorCount() - requestsBefore;
  const inFlight = () => (typeof continuationMonitor?.inFlight === 'function' ? continuationMonitor.inFlight() : 0);
  // Triggering with no window left to observe the result in is a request the provider answers
  // into nothing: it costs a continuation against whatever rate budget exists and cannot report
  // what came back. remainingTimeout floors at 1, so an elapsed deadline shows up here as a
  // sub-threshold remainder rather than a negative one.
  const noWindowLeft = () => remainingTimeout(started, maxTimeMs) <= MIN_GRACE_WINDOW_MS;
  // A denial recorded at any point in this call has to survive EVERY return path, including the
  // ones that also grew: a batch can render while the next continuation is refused, and dropping
  // the denial there would let the caller trigger again into a provider that already said no.
  const decorate = state => {
    if (!blocked) blocked = latchedDenial();
    return { ...state, grew, sawLoading, waitedMs, recenterCount, ...sentinel, graceAttemptsUsed, continuationRequests: continuationRequests(), blocked, stopCause: blocked ? (blocked.kind || (blocked.status ? 'denied' : 'challenged')) : inFlight() > 0 ? 'awaiting-response' : elapsedSince(started) >= maxTimeMs ? 'deadline' : grew ? 'grew' : continuationRequests() ? 'awaiting-render' : 'no-trigger' };
  };
  // The provider hangs its pagination IntersectionObserver (rootMargin 200px) on the TOP-LEVEL
  // card of the last post, then appends that post's carousel slides as sibling .post-cards
  // after it. Centering the final DOM card parks the real sentinel several card heights above
  // the viewport, outside the observer's margin, and pagination stalls with no growth.
  //
  // installPaginationSentinelProbe marks whichever element the provider is actually observing,
  // which is authoritative and needs no inference from card markup. The two heuristics below it
  // are fail-closed fallbacks for pages where the probe was never installed (a caller driving
  // this function directly, or an attached page navigated outside our control).
  // scrollToIt=false reports the sentinel without touching the viewport, which is how a call
  // that must not trigger anything can still say which element the provider is watching.
  async function locatePaginationSentinel(scrollToIt) {
    const found = await page.evaluate(([attr, scrollToIt]) => {
      const scroll = el => { if (scrollToIt) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); };
      const cards = [...document.querySelectorAll('#post-container .post-card')];
      const idOf = card => card.querySelector('.likes-trigger[data-id], .comments-trigger[data-id], [data-id]')?.getAttribute('data-id') || '';
      const observed = document.querySelector('[' + attr + ']');
      if (observed && observed.isConnected) {
        scroll(observed);
        return { sentinelIndex: cards.indexOf(observed), sentinelId: idOf(observed) || null, sentinelSource: 'observed' };
      }
      if (!cards.length) return null;
      let index = cards.length - 1;
      const lastId = idOf(cards[index]);
      // Carousel slides inherit the parent's data-id, so the first card of the trailing same-id
      // run is that post's top-level card. Cards with no data-id at all (stories, highlight
      // stories, zero-engagement posts) carry no identity: fall back to the last card.
      if (lastId) while (index > 0 && idOf(cards[index - 1]) === lastId) index--;
      scroll(cards[index]);
      return { sentinelIndex: index, sentinelId: lastId || null, sentinelSource: lastId ? 'id-run' : 'last-card' };
    }, [PAGINATION_SENTINEL_ATTR, !!scrollToIt]);
    if (!found) return false;
    sentinel = found;
    return true;
  }
  const recenterPaginationSentinel = () => locatePaginationSentinel(true);
  // Count/post IDs do not identify a media batch. Parent retention fix preserved:
  // every poll captures media; callback/extraction failures propagate.
  async function notifyBatchObserved() {
    if (typeof onBatchObserved === 'function') return await onBatchObserved();
    return 0;
  }
  // Every scroll to the sentinel is a pagination trigger, including the in-window cadence
  // recenter: when an already-pending batch renders, the provider rebuilds its observer on the
  // new last card and the probe re-marks a DIFFERENT element, so the next recenter scrolls to an
  // element that has never intersected and fires it. Nothing may scroll into a denial or a
  // visible challenge, and a challenge found this way has to stick, because the DOM state that
  // proved it can be gone by the time the call returns.
  async function refreshBlocked() {
    if (!blocked) blocked = await detectContinuationDenial(page, continuationMonitor);
    return blocked;
  }
  // Re-centering an element that is already intersecting and unchanged produces no
  // IntersectionObserver callback, so the cadence recenters cannot by themselves wake a provider
  // observer that stayed silent on the same sentinel. A re-arm scrolls fully away first, lets the
  // browser deliver the leave, and then centers the sentinel again, which is a genuine fresh
  // enter transition.
  // Returns 'recentered' when the sentinel was genuinely re-armed, otherwise the reason it
  // refused, because those reasons are not interchangeable: a challenge, a denial or an exhausted
  // deadline really is the end of this call, but a continuation that started during the pause is
  // live work that still has to be observed.
  async function rearmPaginationSentinel() {
    const observedStillConnected = await page.evaluate(attr => {
      const observed = document.querySelector('[' + attr + ']');
      if (!observed || !observed.isConnected) return false;
      const top = document.querySelector('#post-container .post-card') || document.querySelector('#post-container') || document.body;
      if (top && typeof top.scrollIntoView === 'function') top.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
      else window.scrollTo(0, 0);
      return true;
    }, PAGINATION_SENTINEL_ATTR).catch(() => false);
    if (!observedStillConnected) return 'disconnected';
    await page.waitForTimeout(Math.min(REARM_SETTLE_MS, remainingTimeout(started, maxTimeMs)));
    // The pause is a window in which the world changes: a challenge can be rendered, a denial can
    // land, the deadline can run out, and the scroll-to-top above can itself have woken a
    // continuation. Every check that authorised this re-arm was made before that pause, so it is
    // stale, and the recenter below is a real pagination trigger. Re-check all three here rather
    // than scroll on a stale permission. refreshBlocked() latches whatever it finds, so a denial
    // or a challenge discovered in this gap still reaches the caller through decorate().
    if (await refreshBlocked()) return 'blocked';
    if (noWindowLeft()) return 'expired';
    // The scroll-to-top above is itself capable of waking the provider, so a continuation can be
    // running here that did not exist when this attempt was authorised. Refusing to recenter is
    // right -- it would race that request -- but refusing is not the same as concluding there is
    // nothing left, which is what the caller does with every other refusal.
    if (inFlight() > 0) return 'pending';
    return await recenterPaginationSentinel() ? 'recentered' : 'disconnected';
  }
  // One bounded observation window. The primary window, the in-flight settlement extension and
  // every grace window run through here, so they cannot drift apart. Returns a finished result
  // when growth settled (or the target was reached) and null when the window simply expired.
  async function runWaitWindow(windowMs, { allowRecenter = true } = {}) {
    const windowBudget = Math.max(1, Math.min(windowMs, remainingTimeout(started, maxTimeMs)));
    const deadline = Date.now() + windowBudget;
    nextRecenterAt = Date.now() + recenterEveryMs;
    while (Date.now() < deadline && elapsedSince(started) < maxTimeMs) {
      const now = Date.now();
      let haltAfterObserving = !!await refreshBlocked();
      // The guard rides the recenter path only, so it costs at most maxRecenters extra round
      // trips per window rather than one per poll tick. A denial stops the trigger, not the
      // observation: reading the DOM one more time before returning keeps a batch that really
      // did render from being reported as no growth.
      if (allowRecenter && inFlight() === 0 && continuationRequests() === 0 && now >= nextRecenterAt && recenterCount < maxRecenters) {
        if (await refreshBlocked()) haltAfterObserving = true;
        else {
          if (await recenterPaginationSentinel()) recenterCount++;
          nextRecenterAt = now + recenterEveryMs;
        }
      }
      const state = await getRenderedCardState(page);
      const stateIds = new Set(state.ids || []);
      // The provider replaces #post-container rather than appending, and a batch can be rendered
      // and replaced again inside a single window -- the caller would then never see it at all.
      // This poll already reads the card state, so hand every distinct rendering to the caller as
      // it appears. It is observation only: it never scrolls and never affects control flow.
      const mediaGrew = (await notifyBatchObserved(state)) > 0;
      const uniqueGrew = [...stateIds].some(id => !bestIds.has(id));
      const countGrew = state.count > bestCount;
      const loading = await page.locator('.loading, .spinner, [aria-busy="true"], [data-loading="true"]').count().catch(() => 0);
      sawLoading = sawLoading || loading > 0;
      if (countGrew || uniqueGrew || mediaGrew) {
        grew = true;
        lastGrowthAt = Date.now();
        bestState = state;
        bestCount = Math.max(bestCount, state.count);
        bestIds = stateIds;
        if (targetUniqueCount && bestIds.size >= targetUniqueCount && inFlight() === 0) {
          waitedMs += windowBudget - Math.max(0, deadline - Date.now());
          await refreshBlocked();
          return decorate(state);
        }
      }
      if (grew && inFlight() === 0 && loading === 0 && Date.now() - lastGrowthAt >= settleMs) {
        waitedMs += windowBudget - Math.max(0, deadline - Date.now());
        // A challenge that appeared mid-window must survive a growing return: decorate() only
        // folds in the monitor's HTTP latch, and the DOM check is the only thing that sees it.
        await refreshBlocked();
        return decorate(await getRenderedCardState(page));
      }
      if (haltAfterObserving) {
        // Stop triggers immediately, but retain a final bounded already-rendering batch.
        await page.waitForTimeout(Math.min(250, remainingTimeout(started, maxTimeMs)));
        const last = await getRenderedCardState(page); await notifyBatchObserved();
        grew ||= last.count > bestCount || (last.ids || []).some(id => !bestIds.has(id));
        bestState = last;
        waitedMs += windowBudget - Math.max(0, deadline - Date.now());
        return decorate(last);
      }
      await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    waitedMs += windowBudget;
    return null;
  }
  // Settlement, never a retry: a continuation request that is still in flight has not had its
  // chance to render yet, so extend the wait rather than declaring a boundary. It triggers
  // nothing new and never spends a grace attempt, and the maxSettlements cap keeps the total
  // bounded whether the pending request predates this call or was issued by a grace re-arm.
  async function settleInFlightRequest(windowOptions = {}) {
    if (settlementsUsed >= maxSettlements || inFlight() === 0) return null;
    settlementsUsed++;
    return runWaitWindow(inFlightSettleMs, { ...windowOptions, allowRecenter: false });
  }
  // Never trigger into a denial. The opening recenter is itself a pagination trigger and the
  // monitor's denial latch outlives a single call, so a 429 recorded by an earlier page
  // iteration has to stop this one before anything is scrolled.
  if (await refreshBlocked()) return decorate(beforeState);
  // A continuation already pending on entry meets the opening recenter first, and with the
  // sentinel outside the viewport that scroll is a fresh enter transition: two requests would
  // run at once. Settle it first, with the cadence recenter suppressed so this window triggers
  // nothing, and read the sentinel without scrolling so it is still reported. The ordinary
  // opening recenter proceeds only once that request has actually been answered.
  if (inFlight() > 0) {
    await locatePaginationSentinel(false);
    const settledAtEntry = await settleInFlightRequest({ allowRecenter: false });
    if (settledAtEntry) return settledAtEntry;
    if (grew) return decorate(await getRenderedCardState(page));
    if (await refreshBlocked()) return decorate(await getRenderedCardState(page));
    // An elapsed settlement window is not evidence that the request died, and it is never
    // permission to retry. A request STILL pending here was never answered, so the opening
    // recenter would put a second continuation on the wire beside it; and an exhausted deadline
    // leaves no window to observe a trigger in. Neither needs a denial to be a reason to stop.
    // This exit runs after the denial check above, so nothing found here can hide one.
    if (inFlight() > 0 || noWindowLeft()) return decorate(await getRenderedCardState(page));
  }
  if (noWindowLeft()) return { ...decorate(beforeState), stopCause: 'deadline' };
  if (!await recenterPaginationSentinel()) return decorate(beforeState);
  recenterCount++;
  const settled = await runWaitWindow(growthWaitMs);
  if (settled) return settled;
  if (grew) return decorate(await getRenderedCardState(page));

  // The primary window ended with no growth. Before calling that a terminal boundary, spend a
  // bounded, request-aware grace budget: the production trace shows a first bounded trigger that
  // issued no continuation request at all followed by a second that returned HTTP 200 with 19
  // items, so one silent window is not evidence that the provider has nothing left.
  if (await refreshBlocked()) return decorate(await getRenderedCardState(page));

  const extended = await settleInFlightRequest();  // pre-grace settlement
  if (extended) return extended;
  if (grew) return decorate(await getRenderedCardState(page));
  if (await refreshBlocked()) return decorate(await getRenderedCardState(page));

  // Grace is deliberately narrow: only an authoritative observed sentinel that is still
  // connected, only when the monitor saw no continuation request at all in this call AND none is
  // still pending (a request that fired and produced no cards is a real boundary, and one that
  // is still running must be settled, not raced by a second trigger), and only inside the
  // global deadline.
  while (
    graceAttemptsUsed < graceAttempts
    && sentinel.sentinelSource === 'observed'
    && continuationMonitor
    && continuationRequests() === 0
    && inFlight() === 0
    && remainingTimeout(started, maxTimeMs) > MIN_GRACE_WINDOW_MS
  ) {
    if (await refreshBlocked()) break;
    graceAttemptsUsed++;
    const rearmed = await rearmPaginationSentinel();
    if (rearmed !== 'recentered') {
      // A re-arm that stood down because its own scroll-to-top started a continuation has real
      // work outstanding. Give it the same bounded, observation-only settlement the request
      // would have received had it arrived a moment earlier: it draws on the same capped
      // settlement budget, it scrolls nothing, so the no-retrigger guard is untouched, and the
      // result is reported honestly whether the batch lands or the window simply expires.
      if (rearmed === 'pending') {
        const settledAfterRearm = await settleInFlightRequest({ allowRecenter: false });
        if (settledAfterRearm) return settledAfterRearm;
        // Same evidence handling as the sibling settlement below: a challenge that appeared
        // while we waited lives only in the DOM, where decorate() cannot see it.
        await refreshBlocked();
      }
      break;
    }
    recenterCount++;
    const regrew = await runWaitWindow(graceWaitMs);
    if (regrew) return regrew;
    if (grew) break;
    // A request the re-arm just issued deserves the same bounded settlement as one that was
    // already running; without it the helper would report a boundary while its own trigger is
    // still in flight.
    const graceExtended = await settleInFlightRequest();
    if (graceExtended) return graceExtended;
    if (grew) break;
    if (await refreshBlocked()) break;
  }
  return decorate(await getRenderedCardState(page));
}
async function cleanupScrapeBrowser(page, browser) {
  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}
const PROFILE_READY_WAIT_MS = 8000;
const PROFILE_READY_POLL_MS = 250;
// /api/profile is answered independently of /api/posts, and the readiness trace shows it landing
// 1058ms after the search click for one handle and 32ms for another. A fixed 500ms sleep read the
// DOM before the response in the slow case and produced a blank profile with a null reported
// total, which downgrades an otherwise healthy section to ACTION_REQUIRED. Wait for the profile
// of the handle actually requested, bounded by the global deadline, and report honestly when it
// truly never arrives -- a missing total stays null, it is never invented.
async function waitForProfileReady(page, handle, { started, maxTimeMs, continuationMonitor = null, waitMs = PROFILE_READY_WAIT_MS } = {}) {
  const wanted = String(handle || '').replace(/^@/, '').trim().toLowerCase();
  const deadline = Date.now() + Math.max(1, Math.min(waitMs, remainingTimeout(started, maxTimeMs)));
  let last = { matched: false, hasTotal: false };
  while (Date.now() < deadline && elapsedSince(started) < maxTimeMs) {
    // A visible challenge or a latched HTTP denial ends the wait at once: no amount of waiting
    // makes a refused profile render, and that evidence has to reach the caller instead of being
    // spent as a timeout.
    const blocked = await detectContinuationDenial(page, continuationMonitor);
    if (blocked) return { ...last, ready: false, blocked };
    const seen = await page.evaluate(() => {
      const section = document.querySelector('#profile-section');
      return {
        text: section ? section.innerText : '',
        name: section?.querySelector('.username-text')?.textContent || ''
      };
    }).catch(() => ({ text: '', name: '' }));
    const shown = String(seen.name || '').replace(/^@/, '').trim().toLowerCase();
    // Readiness is the profile for the handle we asked for AND the metadata the section outcome
    // depends on. Rendered cards are the initial /api/posts response and are no evidence at all
    // that /api/profile has landed, which is exactly how the blank-profile run passed its check.
    last = { matched: !!wanted && shown === wanted, hasTotal: parseReportedTotal(seen.text) != null };
    if (last.matched && last.hasTotal) return { ...last, ready: true, blocked: null };
    await page.waitForTimeout(Math.min(PROFILE_READY_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return { ...last, ready: false, blocked: null };
}
async function extractProfileFromPage(page, handle) {
  const text = await page.locator('#profile-section').first().innerText({ timeout: 2000 }).catch(() => '');
  const username = await page.locator('#profile-section .username-text').first().innerText({ timeout: 1000 }).catch(() => '').then(v => String(v || '').replace(/^@/, '').trim() || handle);
  return { handle: username || handle, reportedPostCount: parseReportedTotal(text), rawProfileText: text ? redactSignedUrls(text) : null };
}
async function extractReportedTotalFromPage(page, timeoutMs = 2000) {
  const text = await page.locator('#profile-section, [id*=profile], [class*=profile]').first().innerText({ timeout: Math.max(1, timeoutMs) }).catch(() => '');
  return parseReportedTotal(text);
}
async function extractSectionError(page) {
  const checks = [
    ['#error-private', 'BLOCKED', 'provider reports private or blocked content'],
    ['#error-not-found', 'BLOCKED', 'provider reports profile not found'],
    ['#error-no-content', 'UNAVAILABLE', null]
  ];
  for (const [selector, status, defaultReason] of checks) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const text = await locator.innerText().catch(() => '');
    return { status, reason: text.trim() || defaultReason || selector };
  }
  return null;
}
async function switchToCategoryTab(page, category, timeoutMs, initialPosts = false) {
  const upper = category.toUpperCase();
  const tab = page.locator('#menu-wrapper .menu-item[data-id="' + upper + '"]').first();
  if (await tab.count() === 0) return { tabPresent: false };
  const active = await tab.evaluate(el => el.classList.contains('active')).catch(() => false) || (initialPosts && category === 'posts');
  if (!active) {
    await page.evaluate(category => {
      const cards = [...document.querySelectorAll('#post-container .post-card')];
      window.__ffCategoryTransition = { category, cards, hrefs: cards.map(c => c.querySelector('.content-download-btn')?.href || '') };
    }, category);
    await tab.click({ timeout: timeoutMs });
  }
  await page.waitForTimeout(Math.min(250, Math.max(1, timeoutMs)));
  return { tabPresent: true };
}
async function waitForSectionReady(page, category, started, maxTimeMs, continuationMonitor = null) {
  let deadline = Date.now() + Math.min(8000, remainingTimeout(started, maxTimeMs));
  const pending = () => (continuationMonitor?.inFlight?.() || 0) > 0;
  const result = value => ({ ...value, transport: continuationMonitor?.snapshot?.() || null });
  while (Date.now() < deadline && elapsedSince(started) < maxTimeMs) {
    const blocked = await detectContinuationDenial(page, continuationMonitor);
    if (blocked) return result({ kind: 'blocked', blocked });
    // Observe the SAME live request without a search/tab/scroll retry. Settlement
    // receives a bounded render grace; the caller deadline always remains hard.
    if (pending()) deadline = Date.now() + Math.min(8000, remainingTimeout(started, maxTimeMs));
    const err = await extractSectionError(page);
    if (err && (!pending() || err.status === 'BLOCKED')) return result({ kind: 'error', ...err });
    if (category === 'highlights') {
      const count = await page.locator('#highlights-container .highlight').count().catch(() => 0);
      if (count > 0 && !pending()) return result({ kind: 'highlights' });
    }
    const cards = await page.locator('#post-container .post-card').count().catch(() => 0);
    if (cards > 0) {
      const bound = await page.evaluate(category => {
        const transition = window.__ffCategoryTransition;
        if (!transition || transition.category !== category) return true;
        const selected = document.querySelector('#menu-wrapper .menu-item.active');
        if (![category, transition.parentCategory].includes(selected?.getAttribute('data-id')?.toLowerCase())) return false;
        const cards = [...document.querySelectorAll('#post-container .post-card')];
        return cards.length > 0 && cards.every(card => { const oldIndex = transition.cards.indexOf(card); return oldIndex < 0 || (card.querySelector('.content-download-btn')?.href || '') !== transition.hrefs[oldIndex]; });
      }, category);
      if (bound && !pending()) return result({ kind: 'cards' });
    }
    await page.waitForTimeout(Math.min(200, Math.max(1, remainingTimeout(started, maxTimeMs))));
  }
  return result({ kind: pending() ? 'awaiting-response' : 'missing-observation', deadlineReached: elapsedSince(started) >= maxTimeMs });
}
// The provider re-renders #post-container in place rather than appending forever: the posts trace
// shows 22 -> 56 -> 83 -> 22 cards across three steps with every request answered 200. Reading the
// cards is therefore separate from turning them into items, so a scan can retain each batch as it
// is observed instead of keeping only whatever DOM happens to be last.
async function readRawCardsFromPage(page) {
  return page.locator('#post-container .post-card').evaluateAll(cards => cards.map(card => {
    const media = card.querySelector('.post-image, .story-image');
    const download = card.querySelector('.content-download-btn[href]');
    const caption = card.querySelector('.post-content p')?.textContent?.trim() || null;
    const likesEl = card.querySelector('.likes-trigger');
    const commentsEl = card.querySelector('.comments-trigger');
    const dateGroup = [...card.querySelectorAll('.post-footer .icon-group')].at(-1);
    const dateText = dateGroup?.querySelector('span')?.textContent?.trim() || dateGroup?.textContent?.trim() || null;
    const shortcode = likesEl?.getAttribute('data-id') || commentsEl?.getAttribute('data-id') || card.querySelector('[data-id]')?.getAttribute('data-id') || '';
    return {
      shortcode,
      mediaType: media?.getAttribute('data-type') || 'unknown',
      href: download?.href || '',
      captionTruncated: caption,
      dateRaw: dateText,
      likes: likesEl?.querySelector('span')?.textContent?.trim() || null,
      comments: commentsEl?.querySelector('span')?.textContent?.trim() || null,
      permalink: null
    };
  }));
}
function extractItemsFromRawCards(raw, options = {}) {
  const norm = normalizeItems(raw, { category: options.category || 'posts', mediaTypes: options.mediaTypes || DEFAULT_MEDIA_TYPES, highlightGroup: options.highlightGroup || null });
  return { items: norm.items, reportedTotal: options.reportedTotal ?? null, uniquePostCount: norm.uniquePostCount, noGrowth: !!options.noGrowth, hitLimit: !!options.hitLimit };
}
async function extractItemsFromPage(page, maybeOptions = {}, maybeFlags = {}) {
  let options = {};
  if (typeof maybeOptions === 'number') options = { reportedTotal: maybeOptions, ...maybeFlags };
  else options = maybeOptions || {};
  return extractItemsFromRawCards(await readRawCardsFromPage(page), options);
}
// Signed media URLs rotate between renders, so the raw href cannot be the identity of a slide.
// The provider media id is a locator fingerprint, NOT a cross-run byte identity; keeping the observable card in
// the key means genuinely distinct slides of the same post stay distinct rather than collapsing.
// Persist this sanitized observation key, never the locator. Cross-run equivalence of
// changed keys requires independently verified scoped bytes; encounter order is not proof.
function providerMediaFingerprint(href) {
  const identity = providerMediaIdentity(href);
  return identity ? sha256(identity) : null;
}
function providerMediaIdentity(href) {
  if (typeof href !== 'string' || !href) return null;
  try {
    const u = new URL(href);
    const ids = u.searchParams.getAll('id');
    if (u.protocol !== 'https:' || u.hostname !== 'instacognito.com' || u.port || u.username || u.password || u.pathname !== '/media' || u.hash || ids.length !== 1) return null;
    const id = ids[0];
    if (!id || id.length > 8192 || [...id].some(c => c.trim() === "" || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return null;
    return '/media?id=' + id;
  } catch { return null; }
}
function rawCardIdentity(card) {
  const fingerprint = providerMediaFingerprint(card.href);
  return fingerprint ? JSON.stringify([card.shortcode || null, fingerprint])
    : JSON.stringify([card.shortcode || null, null, card.mediaType || null]);
}
async function scrapeCardSection(page, { category, mediaTypes, reportedTotal, started, maxTimeMs, maxPages, continuationMonitor = null, resumeTargets = null, onDiscoveryBatch = null, slicePages = 12, sliceTimeMs = 180000, maxObservedMedia = 100000, targetAliases = {}, requireTerminal = false, stopWhenTargetsObserved = false, targetPosts = [] }) {
  const accumulated = new Map(), posts = new Set(), discoveredIds = new Set();
  let blocked = null, stopCause = 'page-limit', steps = 0, slice = 1, sliceStarted = Date.now(), sliceStep = 0, generation = 0;
  let finalState = null, activeStep = false;
  const observedAt = new Date().toISOString();
  await discovery.installCapture(page);
  const checkpoint = async (items = []) => {
    if (onDiscoveryBatch) await onDiscoveryBatch({ items, stopCause, frontier: { category, pages: steps + (activeStep ? 1 : 0), slice, generation, elapsedMs: elapsedSince(started), uniquePostCount: posts.size, uniqueMediaIdentityCount: discoveredIds.size, pendingRequests: continuationMonitor?.inFlight?.() || 0, lastSettled: !(continuationMonitor?.inFlight?.() > 0) } });
  };
  const retainVisibleBatch = async () => {
    const captured = await discovery.drainCapture(page);
    generation = captured.generation;
    const batches = [...captured.batches.filter(b => !b.category || b.category === category), { cards: await readRawCardsFromPage(page), observedAt: new Date().toISOString() }];
    const changed = new Map();
    for (const batch of batches) for (const card of batch.cards) {
      const key = rawCardIdentity(card), prior = accumulated.get(key);
      // Compare observable fields, not polling timestamps. Work is proportional to rendered
      // batches, not the size of the accumulated profile. Preserve metadata provenance on
      // locator-only refresh while replacing the in-memory locator on every actual change.
      const signature = JSON.stringify([card.shortcode, card.href, card.mediaType, card.dateRaw, card.captionTruncated, card.likes, card.comments]);
      if (prior && prior.observationSignature === signature) continue;
      const meta = JSON.stringify([card.dateRaw, card.captionTruncated, card.likes, card.comments]);
      const next = { ...card, observationSignature: signature, observedAt: batch.observedAt,
        locatorObservedAt: prior?.href === card.href ? prior.locatorObservedAt : batch.observedAt,
        metadataProvenance: prior?.metadataSignature === meta ? prior.metadataProvenance : { source: 'supported-ui', category, observedAt: batch.observedAt, dateRaw: card.dateRaw || null, captionTruncated: card.captionTruncated || null }, metadataSignature: meta };
      accumulated.set(key, next); changed.set(key, next);
      if (card.shortcode) posts.add(card.shortcode);
    }
    if (accumulated.size > maxObservedMedia) throw new ArchiveError('RESOURCE_BUDGET', 'discovery identity ceiling reached');
    const items = normalizeItems([...changed.values()], { category, mediaTypes: DEFAULT_MEDIA_TYPES }).items;
    for (const item of items) if (item.stableId) { discoveredIds.add(item.stableId); for (const alias of targetAliases[item.stableId] || []) discoveredIds.add(alias); }
    if (items.length) await checkpoint(items);
    if (captured.gap) throw new ArchiveError('OBSERVATION_GAP', captured.gap);
    return items.length;
  };
  try {
    await retainVisibleBatch();
    while (steps < maxPages) {
      blocked = await detectContinuationDenial(page, continuationMonitor);
      if (blocked) { stopCause = blocked.kind || (blocked.status ? 'denied' : 'challenged'); break; }
      if (elapsedSince(started) >= maxTimeMs) { stopCause = continuationMonitor?.inFlight?.() ? 'awaiting-response' : 'deadline'; break; }
      const pending = continuationMonitor?.inFlight?.() > 0;
      const scopedTargets = [...(resumeTargets || [])].filter(id => (VALID_CATEGORIES.find(c => id.startsWith(c + '__')) || 'posts') === category);
      if (!pending && stopWhenTargetsObserved && (scopedTargets.length || targetPosts.length) && scopedTargets.every(id => discoveredIds.has(id)) && targetPosts.every(id => posts.has(id))) { stopCause = 'targets-observed'; break; }
      // Advertised coverage is useful evidence, but a production full-history scan still
      // needs explicit provider terminal UI; synthetic selected-item callers keep their gate.
      if (!pending && !requireTerminal && discoveryCoverageSatisfied({ category, reportedTotal, uniquePostCount: posts.size, resumeTargets, discoveredIds })) { stopCause = 'coverage-satisfied'; break; }
      const sectionError = typeof page.on === 'function' ? await extractSectionError(page) : null;
      if (!pending && sectionError?.status === 'UNAVAILABLE') { stopCause = 'terminal-ui'; break; }
      if (sectionError?.status === 'BLOCKED') { blocked = { reason: sectionError.reason, kind: 'denied', status: null }; stopCause = 'denied'; break; }
      const before = await getRenderedCardState(page);
      finalState = before;
      if (!before.count && !pending) {
        const terminal = typeof page.on === 'function' ? await extractSectionError(page) : null;
        stopCause = terminal?.status === 'UNAVAILABLE' ? 'terminal-ui' : 'missing-observation'; break;
      }
      if (sliceStep >= slicePages || Date.now() - sliceStarted >= sliceTimeMs) {
        stopCause = 'slice-boundary'; await checkpoint(); slice++; sliceStep = 0; sliceStarted = Date.now();
      }
      const helperBudget = Math.min(maxTimeMs, elapsedSince(started) + Math.max(1, sliceTimeMs - (Date.now() - sliceStarted)));
      activeStep = !pending;
      const after = await scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: helperBudget, continuationMonitor, maxRecenters: 1, onBatchObserved: retainVisibleBatch });
      finalState = after;
      await retainVisibleBatch();
      blocked = after.blocked;
      stopCause = after.stopCause;
      if (blocked) break;
      // A bounded helper is not a controller deadline. Keep observing the SAME inflight
      // request across slices, without consuming a new page or issuing another trigger.
      if (stopCause === 'awaiting-response' || (stopCause === 'deadline' && elapsedSince(started) < maxTimeMs)) { await checkpoint(); continue; }
      activeStep = false; steps++; sliceStep++;
      await checkpoint();
      if (!after.grew) {
        // An answered request may commit DOM later. Observe without scrolling for the rest
        // of the slice. Never infer exhaustion from a silent/unchanged response.
        if (stopCause === 'awaiting-render') {
          const end = Math.min(started + maxTimeMs, Date.now() + Math.min(4000, sliceTimeMs));
          let changed = false;
          while (Date.now() < end) {
            blocked = await detectContinuationDenial(page, continuationMonitor); if (blocked) break;
            if (await retainVisibleBatch()) { changed = true; break; }
            await page.waitForTimeout(Math.min(250, end - Date.now()));
          }
          if (changed && !blocked) continue;
        }
        break;
      }
    }
    if (steps >= maxPages && !blocked) stopCause = 'page-limit';
    if (!blocked) blocked = await detectContinuationDenial(page, continuationMonitor);
    if (blocked) stopCause = blocked.kind || (blocked.status ? 'denied' : 'challenged');
    if (elapsedSince(started) >= maxTimeMs && !blocked) stopCause = continuationMonitor?.inFlight?.() ? 'awaiting-response' : 'deadline';
    await checkpoint();
  } catch (err) {
    stopCause = err.code === 'OBSERVATION_GAP' ? 'observation-gap' : 'observation-error';
    // Do not swallow a failed durable write; the last acknowledged checkpoint survives.
    try { await checkpoint(); } catch {}
    err.code ||= 'OBSERVATION_ERROR'; err.details = { ...(err.details || {}), stopCause, retainedMediaCount: accumulated.size, category };
    throw err;
  }
  const norm = normalizeItems([...accumulated.values()], { category, mediaTypes });
  const hitLimit = !['terminal-ui', 'coverage-satisfied'].includes(stopCause);
  const status = category === 'posts' && reportedTotal == null ? 'ACTION_REQUIRED' : hitLimit ? 'PARTIAL' : norm.items.length ? 'COMPLETE' : 'UNAVAILABLE';
  return makeSectionRecord({ category, status, reason: blocked ? 'provider denied continuation: ' + blocked.reason : stopCause, tabPresent: true, itemCount: norm.items.length, mediaTypeFilterApplied: mediaTypes,
    evidence: { source: '#post-container .post-card', stopCause, terminalEvidence: stopCause === 'terminal-ui' ? '#error-no-content visible' : null, slices: slice, pages: steps, generation, transport: continuationMonitor?.snapshot?.() || null, resources: discovery.resourceSnapshot(), lastRenderedCount: finalState?.count ?? null,
      scan: { rawUniquePostCount: posts.size, uniqueMediaIdentityCount: [...accumulated.values()].filter(i => providerMediaFingerprint(i.href)).length, selectedMediaIdentityCount: norm.items.filter(i => i.providerMediaFingerprint).length, matchedTargetIds: [...(resumeTargets || [])].filter(id => discoveredIds.has(id)), matchedTargetPosts: targetPosts.filter(id => posts.has(id)) }, advertised: { category, count: reportedTotal, observedAt }, blocked },
    items: norm.items, reportedTotal, noGrowth: false, hitLimit, uniquePostCount: posts.size });
}
async function scrapeHighlightsSection(page, { mediaTypes, started, maxTimeMs, onDiscoveryBatch = null, continuationMonitor = null }) {
  const tiles = page.locator('#highlights-container .highlight');
  const count = await tiles.count().catch(() => 0);
  if (!count) return makeSectionRecord({ category: 'highlights', status: 'UNAVAILABLE', reason: 'provider exposed no highlight groups', tabPresent: true, itemCount: 0, mediaTypeFilterApplied: mediaTypes, evidence: { source: '#highlights-container .highlight' }, items: [] });
  const allItems = [];
  for (let i = 0; i < count; i++) {
    if (elapsedSince(started) >= maxTimeMs) break;
    const blocked = await detectContinuationDenial(page, continuationMonitor);
    if (blocked) return makeSectionRecord({ category: 'highlights', status: 'PARTIAL', hitLimit: true, reason: blocked.reason, evidence: { blocked, stopCause: 'denied' }, items: allItems });
    const title = await tiles.nth(i).locator('span').first().innerText().catch(() => '') || 'highlight-' + (i + 1);
    await page.evaluate(() => { const cards = [...document.querySelectorAll('#post-container .post-card')]; window.__ffCategoryTransition = { category: 'stories', parentCategory: 'highlights', cards, hrefs: cards.map(c => c.querySelector('.content-download-btn')?.href || '') }; });
    await tiles.nth(i).click({ timeout: remainingTimeout(started, maxTimeMs) });
    const ready = await waitForSectionReady(page, 'stories', started, maxTimeMs, continuationMonitor);
    if (ready.kind !== 'cards') break;
    const extracted = await extractItemsFromPage(page, { category: 'highlights', mediaTypes, highlightGroup: title });
    allItems.push(...extracted.items);
    if (onDiscoveryBatch) await onDiscoveryBatch({ items: extracted.items, stopCause: 'visible-highlight-group', frontier: { category: 'highlights', pages: i + 1, elapsedMs: elapsedSince(started), lastSettled: true } });
  }
  return makeSectionRecord({ category: 'highlights', status: 'PARTIAL', hitLimit: true, reason: 'visible highlight groups do not prove deep-history traversal', tabPresent: true, itemCount: allItems.length, mediaTypeFilterApplied: mediaTypes, evidence: { source: '#highlights-container .highlight + #post-container .post-card' }, items: allItems });
}
async function scrapeWithPlaywright({ handle, maxPages, maxTimeMs, browserExecutable, browserChannel, attachCdp, categories = DEFAULT_CATEGORIES, mediaTypes = DEFAULT_MEDIA_TYPES, resumeTargets = null, onDiscoveryBatch = null, slicePages = 12, sliceTimeMs = 180000, maxObservedMedia = 100000, targetAliases = {}, requireTerminal = true, consumeScan = null, stopWhenTargetsObserved = false, targetPosts = [] }) {
  if (attachCdp) {
    const u = new URL(attachCdp);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) throw new ArchiveError('BAD_CDP', 'CDP attach must be explicit loopback http://127.0.0.1:<port>');
  }
  const { chromium } = await require('playwright');
  let browser, page, continuationMonitor = null;
  const started = Date.now();
  try {
    if (attachCdp) { browser = await chromium.connectOverCDP(attachCdp, { timeout: remainingTimeout(started, maxTimeMs) }); page = await browser.newPage(); }
    else { browser = await chromium.launch({ headless: true, executablePath: browserExecutable, channel: browserChannel, timeout: remainingTimeout(started, maxTimeMs) }); page = await browser.newPage(); }
    page.setDefaultTimeout(remainingTimeout(started, maxTimeMs));
    // Attached before the first navigation so no continuation request can be missed.
    continuationMonitor = attachContinuationRequestMonitor(page, { pathname: null });
    let forwardedContentRequests = 0;
    await page.route(PROVIDER_ORIGIN + '/api/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname !== '/api/profile') {
        if (forwardedContentRequests >= maxPages) { continuationMonitor.stop('request-limit'); await route.abort('blockedbyclient'); return; }
        forwardedContentRequests++;
      }
      await route.fallback();
    });
    await page.goto(PROVIDER_PHOTO_URL, { waitUntil: 'domcontentloaded', timeout: remainingTimeout(started, maxTimeMs) });
    // Must run after navigation and before the search click: the provider only builds its
    // pagination observer once results render, so this is the last safe moment to wrap it.
    await installPaginationSentinelProbe(page);
    await discovery.installCapture(page);
    await page.fill('input#search-input', handle, { timeout: remainingTimeout(started, maxTimeMs) });
    await page.click('button#download-btn', { timeout: remainingTimeout(started, maxTimeMs) });
    const scan = await scanReadyProfilePage(page, { handle, maxPages, maxTimeMs, categories, mediaTypes, started, continuationMonitor, resumeTargets, onDiscoveryBatch, slicePages, sliceTimeMs, maxObservedMedia, targetAliases, requireTerminal, stopWhenTargetsObserved, targetPosts });
    if (!consumeScan) return scan;
    let remainingPages = Math.max(0, maxPages - scan.sections.reduce((n,s) => n + (s.evidence?.pages || 0), 0));
    return await consumeScan(scan, {
      browserVersion: browser.version(),
      refresh: async (targets, budgetMs) => {
        const denial = await detectContinuationDenial(page, continuationMonitor);
        if (denial) return { items: [], blocked: denial, stopCause: 'denied' };
        if (remainingPages <= 0 || forwardedContentRequests >= maxPages || budgetMs <= 250) return { items: [], blocked: null, stopCause: 'replay-budget' };
        const replayStarted = Date.now();
        await page.evaluate(() => { const cards = [...document.querySelectorAll('#post-container .post-card')]; window.__ffCategoryTransition = { category: 'posts', cards, hrefs: cards.map(c => c.querySelector('.content-download-btn')?.href || '') }; });
        await discovery.resetCapture(page, 'posts');
        await page.fill('input#search-input', handle, { timeout: budgetMs });
        await page.click('button#download-btn', { timeout: remainingTimeout(replayStarted, budgetMs) });
        // Search readiness must not accept old cards/profile while the new response is pending.
        await page.waitForTimeout(Math.min(250, remainingTimeout(replayStarted, budgetMs)));
        const replay = await scanReadyProfilePage(page, { handle, maxPages: remainingPages, maxTimeMs: budgetMs, categories, mediaTypes, started: replayStarted, continuationMonitor, resumeTargets: targets, onDiscoveryBatch, slicePages, sliceTimeMs, maxObservedMedia, requireTerminal: false, stopWhenTargetsObserved: true });
        remainingPages -= replay.sections.reduce((n,s) => n + (s.evidence?.pages || 0), 0);
        return { items: replay.sections.flatMap(s => s.items || []), blocked: replay.sections.find(s => s.evidence?.blocked)?.evidence.blocked || null, stopCause: replay.sections.map(s => s.evidence?.stopCause).join(',') };
      }
    });
  } finally {
    if (continuationMonitor) continuationMonitor.detach();
    await cleanupScrapeBrowser(page, browser);
  }
}
// Everything the scan does once the search has been submitted. Split out so it can be exercised
// against a page whose provider responses are controlled, which is the only way to test the
// readiness gate and the section loop together without a live provider.
async function scanReadyProfilePage(page, { handle, maxPages, maxTimeMs, categories = DEFAULT_CATEGORIES, mediaTypes = DEFAULT_MEDIA_TYPES, started = Date.now(), continuationMonitor = null, resumeTargets = null, onDiscoveryBatch = null, slicePages = 12, sliceTimeMs = 180000, maxObservedMedia = 100000, targetAliases = {}, requireTerminal = false, stopWhenTargetsObserved = false, targetPosts = [] }) {
  {
    const readiness = await waitForProfileReady(page, handle, { started, maxTimeMs, continuationMonitor });
    // Fail closed. Until the provider has rendered the profile for the handle actually requested,
    // whatever is in the DOM is somebody else's page or a stale one, and its post total is not a
    // fact about this handle -- consuming it would let a section satisfy a foreign total from
    // visible cards and report COMPLETE. A readiness stopped by a challenge or a latched denial
    // is the same: the scan never starts, and the evidence is carried out rather than papered
    // over with an empty result.
    if (!readiness.ready) {
      const status = readiness.blocked ? 'BLOCKED' : 'ACTION_REQUIRED';
      const reason = readiness.blocked
        ? readiness.blocked.reason
        : (readiness.matched
          ? 'provider rendered the requested profile without a reported total'
          : 'provider did not render the requested profile before the bounded wait expired');
      return {
        profile: { handle, reportedPostCount: null, rawProfileText: null },
        sections: categories.map(category => makeSectionRecord({
          category,
          status,
          reason,
          tabPresent: false,
          itemCount: 0,
          mediaTypeFilterApplied: mediaTypes,
          evidence: { source: 'profile readiness', matchedRequestedHandle: !!readiness.matched, reportedTotalRendered: !!readiness.hasTotal, blocked: readiness.blocked ? { reason: readiness.blocked.reason, status: readiness.blocked.status ?? null } : null },
          items: []
        }))
      };
    }
    const profile = await extractProfileFromPage(page, handle);
    const sections = [];
    let remainingPages = maxPages;
    for (const category of categories) {
      const deniedBeforeTab = await detectContinuationDenial(page, continuationMonitor);
      if (deniedBeforeTab) {
        for (const remaining of categories.slice(categories.indexOf(category))) sections.push(makeSectionRecord({ category: remaining, status: 'PARTIAL', hitLimit: true, reason: deniedBeforeTab.reason, evidence: { blocked: deniedBeforeTab, stopCause: 'denied-before-tab' } }));
        break;
      }
      if (elapsedSince(started) >= maxTimeMs || remainingPages <= 0) {
        sections.push(makeSectionRecord({ category, status: 'PARTIAL', reason: 'global discovery budget reached before category', hitLimit: true, evidence: { stopCause: 'unvisited-category' } }));
        continue;
      }
      const tab = await switchToCategoryTab(page, category, remainingTimeout(started, maxTimeMs), sections.length === 0 && category === 'posts');
      if (!tab.tabPresent) {
        sections.push(makeSectionRecord({ category, status: 'UNAVAILABLE', reason: 'provider did not expose a ' + category + ' tab', tabPresent: false, itemCount: 0, mediaTypeFilterApplied: mediaTypes, evidence: { selector: '#menu-wrapper .menu-item[data-id="' + category.toUpperCase() + '"]' }, items: [] }));
        continue;
      }
      const ready = await waitForSectionReady(page, category, started, maxTimeMs, continuationMonitor);
      if (ready.kind === 'blocked') {
        for (const remaining of categories.slice(categories.indexOf(category))) sections.push(makeSectionRecord({ category: remaining, status: 'PARTIAL', hitLimit: true, reason: ready.blocked.reason, evidence: { blocked: ready.blocked, stopCause: 'denied-during-tab-readiness', transport: ready.transport } }));
        break;
      }
      if (ready.kind === 'error') {
        sections.push(makeSectionRecord({ category, status: ready.status, reason: ready.reason, tabPresent: true, itemCount: 0, mediaTypeFilterApplied: mediaTypes, evidence: { source: 'provider error state', transport: ready.transport }, items: [] }));
        continue;
      }
      if (ready.kind === 'missing-observation' || ready.kind === 'awaiting-response') {
        sections.push(makeSectionRecord({ category, status: 'PARTIAL', hitLimit: true, reason: 'category readiness ' + ready.kind, tabPresent: true, itemCount: 0, mediaTypeFilterApplied: mediaTypes, evidence: { source: 'category readiness', stopCause: ready.kind, deadlineReached: !!ready.deadlineReached, transport: ready.transport }, items: [] }));
        continue;
      }
      await discovery.resetCapture(page, category);
      if (category === 'highlights') sections.push(await scrapeHighlightsSection(page, { mediaTypes, started, maxTimeMs, onDiscoveryBatch, continuationMonitor }));
      else sections.push(await scrapeCardSection(page, { category, mediaTypes, reportedTotal: category === 'posts' ? profile.reportedPostCount : null, started, maxTimeMs, maxPages: remainingPages, continuationMonitor, resumeTargets, onDiscoveryBatch, slicePages, sliceTimeMs, maxObservedMedia, targetAliases, requireTerminal, stopWhenTargetsObserved, targetPosts }));
      remainingPages -= sections.at(-1)?.evidence?.pages || 0;
      // The provider has refused. Switching tabs would trigger straight back into a provider that
      // has already denied us, so the remaining sections are recorded as not attempted instead.
      const denial = sections.at(-1)?.evidence?.blocked;
      if (denial) {
        for (const remaining of categories.slice(categories.indexOf(category) + 1)) {
          sections.push(makeSectionRecord({ category: remaining, status: 'UNAVAILABLE', reason: 'not attempted after provider denial: ' + denial.reason, tabPresent: false, itemCount: 0, mediaTypeFilterApplied: mediaTypes, evidence: { source: 'skipped after provider denial', blocked: denial }, items: [] }));
        }
        break;
      }
    }
    return { profile, sections };
  }
}
async function archiveProfile(opts = {}) {
  const handle = validateHandle(opts.handle);
  const mode = opts.mode || 'full';
  if (!['full', 'sync'].includes(mode)) throw new ArchiveError('BAD_MODE', 'mode must be full or sync');
  const categories = parseCategories(opts.categories);
  const mediaTypes = parseMediaTypes(opts.mediaTypes);
  const effective = discovery.validateOptions(opts);
  const root = await safeOutputRoot(opts.output);
  const paths = profilePaths(root, handle);
  const runId = Date.now() + '-' + crypto.randomUUID();
  const started = Date.now();
  const startedAtIso = new Date().toISOString();
  const maxTimeMs = effective.maxTimeMs;
  const checkpointEveryItems = asPositiveIntOrDefault(opts.checkpointEveryItems, DEFAULT_CHECKPOINT_EVERY_ITEMS, 'checkpointEveryItems');
  await ensureSafeDir(paths.stateDir, paths.root);
  await ensureSafeDir(paths.mediaDir, paths.root);
  await ensureSafeDir(paths.receiptDir, paths.root);
  return withLock(paths, runId, async () => {
    // The lock is the mutex; this record is the durable answer to "who is running, and where did
    // they get to". It is checked before anything is written, and it is never believed on its own:
    // a claim naming a live process on this host refuses a second writer outright, and a claim
    // naming a dead one is stale metadata to be reconciled and audited, not obeyed.
    const priorOwner = await readJson(paths.owner, null);
    const ownerState = evaluateOwnerRecord(priorOwner);
    if (ownerState.state === 'ACTIVE' && priorOwner.runId !== runId) {
      throw new ArchiveError('LOCKED_OWNER', 'profile is owned by live run ' + priorOwner.runId + ' (pid ' + priorOwner.pid + ')', { owner: { runId: priorOwner.runId, pid: priorOwner.pid ?? null, stage: priorOwner.stage ?? null } });
    }
    if (ownerState.state === 'FOREIGN') {
      throw new ArchiveError('LOCKED_OWNER', 'owner record belongs to another host; failing closed', { owner: { runId: priorOwner.runId, host: priorOwner.host ?? null } });
    }
    const ownerTakeover = ownerState.state === 'STALE'
      ? { runId: priorOwner.runId, pid: priorOwner.pid ?? null, stage: priorOwner.stage ?? null, claimedStatus: priorOwner.status ?? null, reclaimedAt: new Date().toISOString() }
      : null;

    const prior = await readJson(paths.manifest, { version: 2, handle, completed: {}, failed: {}, pending: {}, runs: [], sections: [], requestedCategories: DEFAULT_CATEGORIES, mediaTypes: DEFAULT_MEDIA_TYPES });
    if (prior.handle && prior.handle !== handle) throw new ArchiveError('IDENTITY_BINDING', 'manifest belongs to another handle');
    const completed = { ...(prior.completed || {}) };
    // Receipts that reached disk but never reached the manifest are real, verifiable progress.
    // Adopting them first stops a crash between the two from costing a re-download.
    const adoptedReceipts = await adoptOrphanReceipts(paths, completed, handle);
    // Split legacy state into real failures and work never attempted, then clear only what a
    // verified receipt actually proves. Anything unproved is retained.
    const split = partitionPriorOutcomes(prior);
    const reconciledFailed = await reconcileAgainstReceipts(paths, completed, split.failed, handle);
    const reconciledPending = await reconcileAgainstReceipts(paths, completed, split.pending, handle);
    const carriedFailed = reconciledFailed.retained;
    const carriedPending = reconciledPending.retained;
    const resolvedByReceipt = [...reconciledFailed.resolved, ...reconciledPending.resolved].sort();
    // An id the manifest called completed but whose receipt will not verify is owed, not done.
    // Leaving it in completed let the same id sit in both maps and still count toward completeness.
    const unverifiableCompleted = [...new Set([...reconciledFailed.unverifiable, ...reconciledPending.unverifiable])].sort();
    for (const id of unverifiableCompleted) delete completed[id];
    const conflicts = { ...(prior.conflicts || {}) };
    // What this run is still missing, and therefore what discovery must actually cover. Signed URLs
    // are never persisted, so an outstanding id can only be retried once a scan surfaces it again.
    const resumeTargets = new Set([...Object.keys(carriedFailed), ...Object.keys(carriedPending), ...effective.targetIds]);

    const audit = [...(prior.audit || [])];
    const auditEntry = {};
    if (resolvedByReceipt.length) auditEntry.resolvedByReceipt = resolvedByReceipt;
    if (adoptedReceipts.length) auditEntry.adoptedReceipts = adoptedReceipts;
    if (unverifiableCompleted.length) auditEntry.unverifiableCompleted = unverifiableCompleted;
    if (ownerTakeover) auditEntry.ownerTakeover = ownerTakeover;
    if (Object.keys(auditEntry).length) audit.push({ runId, at: new Date().toISOString(), ...auditEntry });
    while (audit.length > MAX_AUDIT_ENTRIES) audit.shift();

    let stage = 'starting';
    const runtime = discovery.runtimeReceipt(effective);
    let ledger = null;
    const aliases = { ...(prior.identityAliases || {}) };
    const byteEvidence = await loadByteEvidence(paths, opts.byteEvidenceRoot, completed, handle, maxTimeMs - elapsedSince(started));
    runtime.byteEvidence = byteEvidence.receipt;
    const targetAliases = {};
    for (const [id, proof] of Object.entries(byteEvidence.aliases)) (targetAliases[id] ||= []).push(proof.canonicalId);
    for (const [legacyId, entry] of Object.entries({ ...completed, ...carriedPending, ...carriedFailed })) {
      if (!entry.providerMediaFingerprint || !entry.shortcode) continue;
      if (completed[legacyId] && (!receiptMatchesIdentity(entry, legacyId, handle) || !await verifyReceipt(paths, entry))) continue;
      const id = stableMediaId({ ...entry, category: receiptCategory(entry) });
      (targetAliases[id] ||= []).push(legacyId);
    }
    const writeOwner = async (nextStage, { status = 'RUNNING', terminal = false } = {}) => {
      stage = nextStage;
      await atomicWriteJson(paths.owner, ownerRecord({ runId, handle, stage, status, terminal, startedAt: startedAtIso, extra: { mode, requestedCategories: categories, runtime } }));
    };
    try {
    await writeOwner('discovery');
    await writeStatus(paths, { status: 'RUNNING', reason: 'scan started', runId, handle, mode, stage, requestedCategories: categories, mediaTypes, startedAt: startedAtIso, priorCompletedCount: Object.keys(completed).length, resumeTargetCount: resumeTargets.size });

    // Discovery and acquisition get separate deadlines so a slow scan can never consume the whole
    // allowance and leave acquisition with nothing, which is what starved every known-missing id.
    const discoveryBudgetMs = Math.min(effective.discoveryMaxTimeMs, Math.max(1, maxTimeMs - (elapsedSince(started))));
    async function consumeScan(scan, session = {}) {
    runtime.browserVersion = session.browserVersion || null;
    const discoveryEndedAt = Date.now();
    const observedCumulative = new Map(ledger?.observed || []);
    const scanItems = scan.sections.flatMap(s => s.items || []);
    for (const item of scanItems) if (item.stableId) observedCumulative.set(item.stableId, { rawPostId: item.shortcode, category: item.category });
    for (const receipt of Object.values({ ...completed, ...carriedPending, ...carriedFailed })) if (receipt.shortcode) observedCumulative.set(receipt.stableId, { rawPostId: receipt.shortcode, category: receiptCategory(receipt) });
    const scanMetrics = { rawUniquePostCount: scan.sections.find(s => s.category === 'posts')?.evidence?.scan?.rawUniquePostCount ?? new Set(scanItems.filter(i => i.category === 'posts' && i.shortcode).map(i => i.shortcode)).size, uniqueMediaIdentityCount: scan.sections.reduce((n,s) => n + (s.evidence?.scan?.uniqueMediaIdentityCount ?? new Set((s.items || []).map(i => i.stableId).filter(Boolean)).size), 0),
      categories: Object.fromEntries(scan.sections.map(s => [s.category, { rawUniquePostCount: s.evidence?.scan?.rawUniquePostCount ?? new Set((s.items || []).map(i => i.shortcode).filter(Boolean)).size, uniqueMediaIdentityCount: s.evidence?.scan?.uniqueMediaIdentityCount ?? new Set((s.items || []).map(i => i.stableId).filter(Boolean)).size, advertisedCount: s.reportedTotal, advertisedObservedAt: s.evidence?.advertised?.observedAt || new Date().toISOString(), stopCause: s.evidence?.stopCause || 'provided-items' }])) };
    const discoveryStopCause = scan.sections.map(s => s.evidence?.stopCause || s.reason).join(',');
    if (effective.discoveryOnly) {
      if (ledger) { await ledger.close(discoveryStopCause); ledger = null; }
      const result = { schemaVersion: 3, status: 'PARTIAL', reason: 'discovery-only; no acquisition or completeness claim', runId, handle, runtime, scan: scanMetrics, sections: scan.sections.map(statusSectionRecord), stage: 'discovery-finished', updatedAt: new Date().toISOString() };
      await writeOwner('discovery-finished', { status: result.status, terminal: true });
      return writeStatus(paths, result);
    }
    const discoveryDenied = scan.sections.some(s => s.evidence?.blocked || s.status === 'BLOCKED');
    const acquisitionBudgetMs = discoveryDenied ? 0 : Math.min(effective.acquisitionMaxTimeMs, Math.max(0, maxTimeMs - elapsedSince(started)));
    const acquisitionDeadline = performance.now() + acquisitionBudgetMs;
    const acquisitionRemaining = () => Math.min(acquisitionDeadline - performance.now(), maxTimeMs - elapsedSince(started));

    // Sections and their item queue are settled before acquisition begins, so every persisted view
    // knows the whole of what this scan discovered rather than only what it has already reached.
    const identitiesByPost = new Map();
    for (const [id, entry] of Object.entries({ ...completed, ...carriedPending, ...carriedFailed })) {
      if (!entry.shortcode) continue;
      const key = JSON.stringify([receiptCategory(entry), entry.shortcode]);
      (identitiesByPost.get(key) || identitiesByPost.set(key, []).get(key)).push({ id, entry });
    }
    for (const section of scan.sections) for (const item of section.items || []) {
      if (!item.stableId) continue;
      const candidates = identitiesByPost.get(JSON.stringify([item.category, item.shortcode])) || [];
      const proof = byteEvidence.aliases[item.stableId];
      if (proof && proof.fingerprint === item.providerMediaFingerprint && proof.category === item.category && proof.rawPostId === item.shortcode && completed[proof.canonicalId]?.sha256 === proof.sha256) {
        const canonical = completed[proof.canonicalId];
        aliases[item.stableId] = proof;
        item.discoveryId = item.stableId; item.legacyId = proof.canonicalId; item.stableId = proof.canonicalId;
        item.byteEvidence = proof; item.displayOrder = item.carouselIndex; item.carouselIndex = canonical.carouselIndex;
        continue;
      }
      const matching = candidates.filter(({ id, entry }) => (entry.providerMediaFingerprint === item.providerMediaFingerprint || (!entry.providerMediaFingerprint && id === item.stableId && entry.identityBasis === 'provider-media-fingerprint-v1')) && (!completed[id] || receiptMatchesIdentity(entry, id, handle)));
      if (matching.length === 1) {
        const { id, entry } = matching[0];
        if (!completed[id] || await verifyReceipt(paths, entry)) {
          if (id !== item.stableId) aliases[item.stableId] = { canonicalId: id, fingerprint: item.providerMediaFingerprint, category: item.category, rawPostId: item.shortcode, handle, evidence: completed[id] ? 'fingerprint-and-byte-verified-receipt' : 'persisted-outstanding-fingerprint', observedAt: new Date().toISOString() };
          item.discoveryId = item.stableId; item.legacyId = id !== item.stableId ? id : null; item.stableId = id;
          item.displayOrder = item.carouselIndex;
          if (item.legacyId && Number.isInteger(entry.carouselIndex)) item.carouselIndex = entry.carouselIndex;
        }
      } else if (matching.length > 1 || candidates.some(({ entry }) => !entry.providerMediaFingerprint)) {
        item.identityDisposition = 'legacy-mapping-unresolved';
      }
    }
    const plannedSections = scan.sections.map(sectionInput => {
      const section = makeSectionRecord({ ...sectionInput, mediaTypeFilterApplied: mediaTypes });
      const acquirable = ['COMPLETE', 'PARTIAL'].includes(section.status) || !!(section.items && section.items.length);
      const entries = acquirable ? (section.items || []).map((item, index) => ({ item, index, key: item.stableId || fallbackFailureKey(item, index) })) : [];
      return { section, acquirable, entries };
    });
    const discoveredQueue = new Map();
    for (const planned of plannedSections) for (const entry of planned.entries) if (!discoveredQueue.has(entry.key)) discoveredQueue.set(entry.key, entry);

    // Whether a stored receipt genuinely answers for the slide now being looked at. A single-slide
    // post has an unambiguous index. A carousel does not: slide order is an artefact of how the
    // provider happened to render, so only a matching provider-media fingerprint proves the
    // mapping. Without that proof the slide is re-acquired rather than resolved by position, which
    // is what would otherwise let a reorder silently file one slide's bytes under another's id.
    // How many slides this post is known to have, from anywhere: what this scan showed, what the
    // receipt recorded, and how many slide ids are already stored. Judging on the current
    // observation alone meant a carousel seen one slide at a time looked like a single-slide post
    // and resolved by index, which is the reorder hazard all over again.
    const storedSlideCounts = new Map();
    for (const [id, receipt] of Object.entries(completed)) {
      const shortcode = receiptShortcode(receipt) || (id.includes('-') ? id.slice(0, id.lastIndexOf('-')) : null);
      if (shortcode) storedSlideCounts.set(shortcode, (storedSlideCounts.get(shortcode) || 0) + 1);
    }
    const knownSlideCount = (item, receipt) => Math.max(
      Number.isInteger(item.slideCount) ? item.slideCount : 1,
      Number.isInteger(receipt?.slideCount) ? receipt.slideCount : 1,
      item.shortcode ? (storedSlideCounts.get(item.shortcode) || 1) : 1
    );
    const receiptResolvesItem = (item, receipt) => {
      if (!receiptMatchesIdentity(receipt, item.stableId, handle)) return false;
      if (receiptCategory(receipt) !== item.category || receiptShortcode(receipt) !== item.shortcode) return false;
      const observed = item.providerMediaFingerprint || providerMediaFingerprint(item.href);
      const proof = item.byteEvidence;
      if (proof && proof.canonicalId === item.stableId && proof.fingerprint === observed && proof.sha256 === receipt.sha256 && proof.bytes === receipt.bytes && proof.category === item.category && proof.rawPostId === item.shortcode && proof.handle === handle) return true;
      if (receipt.providerMediaFingerprint && observed) return receipt.providerMediaFingerprint === observed;
      return receipt.identityBasis === 'provider-media-fingerprint-v1' && receipt.stableId === stableMediaId({ ...item, providerMediaFingerprint: observed });
    };

    const failed = {};
    const pending = {};
    const freshKeys = new Set();
    const acquiredKeys = new Set();
    const sweptResolved = [];
    const sweptDemoted = [];
    const finalSections = [];
    let downloaded = 0;
    let reused = 0;
    // Per-run outcome counts are derived from these sets rather than tallied as the loop goes, so
    // the integrity sweep removing an entry cannot leave a count describing a state that no longer
    // exists. A live run settled PARTIAL on two pending ids the sweep had already resolved.
    const runFailed = new Set();
    const runPending = new Set();
    const sectionCounters = new Map();
    const counterFor = section => {
      if (!sectionCounters.has(section)) sectionCounters.set(section, { failed: new Set(), pending: new Set() });
      return sectionCounters.get(section);
    };
    const failedCountNow = () => runFailed.size;
    const pendingCountNow = () => runPending.size;
    const forgetOutcome = id => {
      runFailed.delete(id);
      runPending.delete(id);
      for (const counter of sectionCounters.values()) { counter.failed.delete(id); counter.pending.delete(id); }
    };
    const syncSectionCounts = () => {
      for (const [section, counter] of sectionCounters) {
        section.failedCount = counter.failed.size;
        section.pendingCount = counter.pending.size;
      }
    };
    let processed = 0, acquiredBytes = 0, acquisitionAttempts = 0;

    // Prior state that this scan did not surface again. Retained rather than dropped: a real
    // failure stays a failure, and work never attempted stays pending.
    // Every persisted view carries this merge, including mid-run checkpoints: a checkpoint that
    // omitted carried state would let a crash silently drop outstanding work the next run would
    // then never know about.
    const carriedView = () => {
      const failedOut = { ...failed };
      const pendingOut = { ...pending };
      for (const [sid, entry] of Object.entries(carriedFailed)) if (!freshKeys.has(sid) && !failedOut[sid] && !pendingOut[sid]) failedOut[sid] = sanitizeFailedItem(entry, entry.error || 'unresolved download failure');
      for (const [sid, entry] of Object.entries(carriedPending)) if (!freshKeys.has(sid) && !failedOut[sid] && !pendingOut[sid]) pendingOut[sid] = sanitizeFailedItem(entry, 'awaiting rediscovery');
      // Work this scan discovered but has not reached yet is owed too. Leaving it out let a
      // checkpoint describe a queue as if it did not exist, so a crash lost it entirely.
      for (const [key, queued] of discoveredQueue) {
        if (acquiredKeys.has(key) || failedOut[key] || pendingOut[key]) continue;
        // Already recorded as completed under a matching identity, so it is not owed.
        if (completed[key] && receiptMatchesIdentity(completed[key], key, handle)) continue;
        pendingOut[key] = sanitizeFailedItem(queued.item, 'awaiting acquisition', queued.index, priorAttempts(key));
      }
      return { failedOut, pendingOut };
    };
    const mergeCarried = () => {
      const view = carriedView();
      Object.assign(failed, view.failedOut);
      Object.assign(pending, view.pendingOut);
    };
    const priorAttempts = key => {
      const prior = carriedFailed[key] || carriedPending[key];
      return Number.isInteger(prior?.attempts) ? prior.attempts : 0;
    };
    const rediscoveredCount = () => [...resumeTargets].filter(id => freshKeys.has(id)).length;
    const stillMissingIds = () => {
      const view = carriedView();
      return [...resumeTargets].filter(id => view.failedOut[id] || view.pendingOut[id]).sort();
    };
    const resumeRecord = () => ({ targeted: resumeTargets.size, rediscovered: rediscoveredCount(), stillMissing: stillMissingIds() });
    const buildManifest = (sectionList, runStatus, stageName) => {
      const view = carriedView();
      return {
      version: 3,
      runtime, scan: scanMetrics, identityAliases: aliases,
      observedCumulativePostCount: new Set([...observedCumulative.values()].filter(i => i.category === 'posts' && i.rawPostId).map(i => i.rawPostId)).size,
      acquiredPostCount: new Set(Object.values(completed).filter(i => receiptCategory(i) === 'posts' && i.shortcode).map(i => i.shortcode)).size,
      handle,
      updatedAt: new Date().toISOString(),
      requestedCategories: categories,
      mediaTypes,
      profile: publicProfile(scan.profile),
      sections: sectionList.map(statusSectionRecord),
      completed,
      failed: view.failedOut,
      pending: view.pendingOut,
      conflicts,
      audit,
      // Where this run got to, written atomically as it goes, so an interrupt leaves durable
      // progress rather than a manifest that never learned what was already on disk.
      checkpoint: { runId, stage: stageName, status: runStatus, pid: process.pid, host: os.hostname(), startedAt: startedAtIso, updatedAt: new Date().toISOString() },
      // Per-run truth and cumulative truth are different facts and are recorded as different fields.
      // completedCount is what the manifest records; verifiedThisRun is what this run actually
      // re-checked byte for byte. They are different claims and must not be conflated.
      cumulative: { completedCount: Object.keys(completed).length, verifiedThisRunCount: downloaded + reused, failedCount: Object.keys(view.failedOut).length, pendingCount: Object.keys(view.pendingOut).length },
      resume: resumeRecord(),
      // What the disjointness sweep had to settle. Resolutions are routine bookkeeping; a demotion
      // means a receipt this manifest called completed could not be proved, which is worth naming.
      integritySweep: {
        resolvedByReceiptCount: new Set(sweptResolved).size,
        demotedFromCompletedCount: new Set(sweptDemoted).size,
        demotedFromCompleted: [...new Set(sweptDemoted)].sort().slice(0, 50)
      },
      runs: [...(prior.runs || []), { schemaVersion: 3, countScope: 'run', runId, mode, status: runStatus, downloadedCount: downloaded, reusedCount: reused, failedCount: failedCountNow(), pendingCount: pendingCountNow(), completedCount: downloaded + reused }]
      };
    };
    // An id can be recorded as acquired or as owed, never both. The reuse gate can decline to
    // resolve a slide it cannot prove, and the budget or a failed retry then files that same id as
    // owed while its earlier receipt still stands -- which is exactly how the live run finished
    // with 684 ids in both maps. The sweep settles each such id by evidence: a receipt that passes
    // positive identity and byte verification means the id is acquired and stops being owed, and
    // anything that cannot be proved stops counting as completed and stays owed. No outstanding
    // work is ever discarded to satisfy the invariant.
    const sweepOutcomeOverlaps = async () => {
      const view = carriedView();
      for (const id of new Set([...Object.keys(view.failedOut), ...Object.keys(view.pendingOut)])) {
        const receipt = completed[id];
        if (!receipt) continue;
        if (receiptMatchesIdentity(receipt, id, handle) && await verifyReceipt(paths, receipt)) {
          sweptResolved.push(id);
          delete failed[id];
          delete pending[id];
          delete carriedFailed[id];
          delete carriedPending[id];
          forgetOutcome(id);
          acquiredKeys.add(id);
          continue;
        }
        sweptDemoted.push(id);
        delete completed[id];
      }
      // An id that reached both maps is still one piece of outstanding work. Keep the failure,
      // which carries the actual cause, and drop the duplicate rather than failing the run closed.
      for (const id of Object.keys(pending)) {
        if (!failed[id]) continue;
        delete pending[id];
        runPending.delete(id);
        for (const counter of sectionCounters.values()) counter.pending.delete(id);
      }
    };
    const persistManifest = async (sectionList, runStatus, stageName) => {
      await sweepOutcomeOverlaps();
      syncSectionCounts();
      const manifest = buildManifest(sectionList, runStatus, stageName);
      assertDisjointOutcomes(manifest.completed, manifest.failed, manifest.pending, stageName);
      await atomicWriteJson(paths.manifest, manifest);
      return manifest;
    };
    const checkpoint = async (sectionList, stageName) => { await persistManifest(sectionList, 'RUNNING', stageName); };

    // The whole discovered queue reaches disk before a single item is acquired. Waiting for the
    // first checkpoint meant a crash early in acquisition left no manifest at all, and everything
    // this scan had already discovered was lost with it.
    await checkpoint(plannedSections.map(planned => planned.section), 'queue-settled');
    await writeOwner('acquiring');
    for (const planned of plannedSections) {
      if (!planned.acquirable) continue;
      planned.section.downloadedCount = 0;
      planned.section.reusedCount = 0;
      planned.section.failedCount = 0;
      planned.section.pendingCount = 0;
    }
    // One queue across every requested section, not one per section drained in turn. Per-section
    // draining meant a posts backlog that fails on every run could hold the shared deadline
    // indefinitely and a reel owed far fewer attempts would never be reached at all.
    // Owed ids first, then fewest attempts; section and discovery order only break ties, so
    // per-section grouping no longer decides who gets budget.
    const owedRank = key => (resumeTargets.has(key) ? 0 : 1);
    const workQueue = [];
    plannedSections.forEach((planned, sectionOrder) => {
      if (!planned.acquirable) return;
      for (const entry of planned.entries) workQueue.push({ ...entry, section: planned.section, sectionOrder });
    });
    workQueue.sort((a, b) =>
      owedRank(a.key) - owedRank(b.key)
      || priorAttempts(a.key) - priorAttempts(b.key)
      || a.sectionOrder - b.sectionOrder
      || a.index - b.index);
    let locatorReplayAttempted = false;
    for (const entry of workQueue) {
      const section = entry.section;
      const item = entry.item;
      const i = entry.index;
      const failureKey = entry.key;
      freshKeys.add(failureKey);
      // Reuse is decided before the budget: an id with a verified receipt is already acquired,
      // and calling it owed because the clock ran out would report completed work as missing.
      const priorReceipt = item.stableId ? completed[item.stableId] : null;
      if (priorReceipt && receiptResolvesItem(item, priorReceipt) && await verifyReceipt(paths, priorReceipt)) {
        reused++;
        section.reusedCount++;
        delete failed[failureKey];
        delete failed[item.stableId];
        delete pending[failureKey];
        delete pending[item.stableId];
        acquiredKeys.add(failureKey);
        if (item.stableId) acquiredKeys.add(item.stableId);
        processed++;
        if (processed % checkpointEveryItems === 0) await checkpoint(plannedSections.map(planned => planned.section), 'acquiring');
        continue;
      }
      // Out of acquisition budget is work not attempted. It is pending, never a download failure.
      if (acquisitionRemaining() <= 0 || acquisitionAttempts >= effective.maxAcquireItems || acquiredBytes >= effective.maxAcquireBytes) {
        runPending.add(failureKey);
        counterFor(section).pending.add(failureKey);
        pending[failureKey] = sanitizeFailedItem(item, 'acquisition budget reached', i, priorAttempts(failureKey));
        continue;
      }
      if (item.identityDisposition && item.identityDisposition !== 'bound') {
        runPending.add(failureKey); counterFor(section).pending.add(failureKey);
        pending[failureKey] = sanitizeFailedItem(item, item.identityDisposition, i, priorAttempts(failureKey));
        continue;
      }
      if (!item.href) {
        runFailed.add(failureKey);
        counterFor(section).failed.add(failureKey);
        failed[failureKey] = sanitizeFailedItem(item, 'missing media href', i, priorAttempts(failureKey) + 1);
        continue;
      }
      if (!locatorReplayAttempted && session.refresh && item.locatorObservedAt && Date.now() - Date.parse(item.locatorObservedAt) > effective.maxLocatorAgeMs && acquisitionRemaining() > 250) {
        locatorReplayAttempted = true;
        const needed = new Set(workQueue.filter(e => !acquiredKeys.has(e.key)).map(e => e.item.discoveryId || e.item.stableId).filter(Boolean));
        const refreshed = await session.refresh(needed, Math.max(1, Math.floor(acquisitionRemaining())));
        if (refreshed.blocked) throw new ArchiveError('DENIED', refreshed.blocked.reason);
        const latest = new Map(refreshed.items.map(i => [i.stableId, i]));
        for (const queued of workQueue) {
          const fresh = latest.get(queued.item.discoveryId || queued.item.stableId);
          if (fresh && fresh.providerMediaFingerprint === queued.item.providerMediaFingerprint) Object.assign(queued.item, { href: fresh.href, locatorObservedAt: fresh.locatorObservedAt, metadataProvenance: fresh.metadataProvenance });
        }
      }
      if (item.locatorObservedAt && Date.now() - Date.parse(item.locatorObservedAt) > effective.maxLocatorAgeMs) {
        runPending.add(failureKey); counterFor(section).pending.add(failureKey);
        pending[failureKey] = sanitizeFailedItem(item, 'locator re-observation required', i, priorAttempts(failureKey));
        continue;
      }
      try {
        acquisitionAttempts++;
        const result = await downloadOne(item, paths, { stopOnDenial: true, fetchImpl: opts.fetchImpl, maxBytes: Math.min(effective.maxBytes, effective.maxAcquireBytes - acquiredBytes), runId, remainingMs: Math.max(1, acquisitionRemaining()), dnsLookup: opts.dnsLookup, timeoutMs: Math.min(opts.networkTimeoutMs || DEFAULT_NETWORK_TIMEOUT_MS, Math.max(1, acquisitionRemaining())), completedMap: completed, handle });
        if (!result.fetchedButReused) acquiredBytes += result.receipt.bytes;
        completed[result.receipt.stableId] = result.receipt;
        delete failed[failureKey];
        delete failed[result.receipt.stableId];
        delete pending[failureKey];
        delete pending[result.receipt.stableId];
        if (result.conflict) {
          // Held, not applied: the verified receipt stands and the conflicting observation is
          // recorded for review rather than overwriting content that still proves out.
          conflicts[result.receipt.stableId] = { ...result.conflict, stableId: result.receipt.stableId, shortcode: item.shortcode || null, carouselIndex: item.carouselIndex ?? 0, runId };
        }
        if (result.fetchedButReused) { reused++; section.reusedCount++; }
        else { downloaded++; section.downloadedCount++; }
        acquiredKeys.add(failureKey);
        acquiredKeys.add(result.receipt.stableId);
        processed++;
        if (processed % checkpointEveryItems === 0) await checkpoint(plannedSections.map(planned => planned.section), 'acquiring');
        if ((opts.delayMs ?? DEFAULT_DELAY_MS) && acquisitionRemaining() > 0) await delay(Math.min(opts.delayMs ?? DEFAULT_DELAY_MS, 5000, Math.max(1, acquisitionRemaining())));
      } catch (err) {
        if (err instanceof DeferredError || err.code === 'DENIED') {
          // The provider refused this specific item. It is fresh, so carried state no longer
          // covers it, and without filing it here the deferral would drop it entirely.
          runPending.add(failureKey);
          counterFor(section).pending.add(failureKey);
          pending[failureKey] = sanitizeFailedItem(item, 'provider deferred acquisition', i, priorAttempts(failureKey) + 1);
          mergeCarried();
          await persistManifest(plannedSections.map(planned => planned.section), 'DEFERRED', 'deferred');
          await writeOwner('deferred', { status: 'DEFERRED', terminal: true });
          await writeStatus(paths, { status: 'DEFERRED', reason: redactSignedUrls(err.message), retryAt: err.retryAt, runId, handle, mode, stage: 'deferred', requestedCategories: categories, mediaTypes, sections: plannedSections.map(planned => statusSectionRecord(planned.section)), downloadedCount: downloaded, reusedCount: reused, completedCount: Object.keys(completed).length, failedCount: failedCountNow(), pendingCount: pendingCountNow(), outstandingCount: Object.keys(failed).length + Object.keys(pending).length, resume: resumeRecord(), updatedAt: new Date().toISOString() });
          throw err;
        }
        runFailed.add(failureKey);
        counterFor(section).failed.add(failureKey);
        if (err.code === 'MEDIA_TYPE_MISMATCH' && err.details) item._mismatchDiagnostics = err.details;
        failed[failureKey] = sanitizeFailedItem(item, err.message, i, priorAttempts(failureKey) + 1, err.code);
        delete item._mismatchDiagnostics;
        processed++;
        if (processed % checkpointEveryItems === 0) await checkpoint(plannedSections.map(planned => planned.section), 'acquiring');
        if (effective.stopOnItemFailure) {
          await checkpoint(plannedSections.map(planned => planned.section), 'acquiring');
          break;
        }
      }
    }
    if (effective.stopOnItemFailure) {
      for (const entry of workQueue) {
        if (acquiredKeys.has(entry.key) || runFailed.has(entry.key) || runPending.has(entry.key)) continue;
        runPending.add(entry.key);
        counterFor(entry.section).pending.add(entry.key);
        pending[entry.key] = sanitizeFailedItem(entry.item, 'acquisition stopped after item failure', entry.index, priorAttempts(entry.key));
      }
    }
    // Sweep before any judgement, not after it. Accounting that ran first described a state the
    // sweep then changed, so a run could persist PARTIAL and a pending count for work it had
    // already proved was acquired.
    await sweepOutcomeOverlaps();
    syncSectionCounts();
    // Sections settle once the whole queue is drained, so each one is judged against the final
    // completed set rather than whatever happened to be done when its own turn ended.
    for (const planned of plannedSections) {
      const section = planned.section;
      if (planned.acquirable) {
        const settled = sectionOutcomeForCompleted(section, Object.values(completed), { mode });
        section.status = settled.status;
        section.reason = settled.reason;
        if (settled.uniquePostCount != null) section.uniquePostCount = settled.uniquePostCount;
      }
      finalSections.push(section);
    }
    await checkpoint(finalSections, 'sections-settled');
    mergeCarried();
    let outstandingCount = Object.keys(failed).length + Object.keys(pending).length;
    let global = finalGlobalOutcome(finalSections, failedCountNow(), pendingCountNow(), outstandingCount, Object.keys(conflicts).length);
    let verificationDeadline = false;
    if (global.status === 'COMPLETE') {
      // COMPLETE is the one claim worth paying to check. Every recorded receipt is re-verified
      // before it is made, and anything that no longer proves out becomes owed again instead of
      // being counted purely because the manifest still listed it.
      for (const [id, receipt] of Object.entries({ ...completed })) {
        if (elapsedSince(started) >= maxTimeMs) { verificationDeadline = true; break; }
        if (receiptMatchesIdentity(receipt, id, handle) && await verifyReceipt(paths, receipt)) continue;
        delete completed[id];
        pending[id] = sanitizeFailedItem({ ...receipt, stableId: id }, 'receipt no longer verifies', 0, priorAttempts(id));
      }
      outstandingCount = Object.keys(failed).length + Object.keys(pending).length;
      global = finalGlobalOutcome(finalSections, failedCountNow(), pendingCountNow(), outstandingCount, Object.keys(conflicts).length);
    }
    if (verificationDeadline) global = { status: 'PARTIAL', reason: 'global verification deadline reached; recorded receipts not all reverified' };
    const postSection = finalSections.find(section => section.category === 'posts');
    const uniquePostCount = new Set(Object.values(completed).filter(receipt => receiptCategory(receipt) === 'posts' && receiptShortcode(receipt)).map(receipt => receiptShortcode(receipt))).size;
    await persistManifest(finalSections, global.status, 'finished');
    if (ledger) { await ledger.close(discoveryStopCause + ';acquisition-finished'); ledger = null; }
    await writeOwner('finished', { status: global.status, terminal: true });
    return writeStatus(paths, {
      schemaVersion: 3, runtime, scan: scanMetrics,
      observedCumulativePostCount: new Set([...observedCumulative.values()].filter(i => i.category === 'posts' && i.rawPostId).map(i => i.rawPostId)).size,
      acquiredPostCount: uniquePostCount,
      acquisition: { runDownloaded: downloaded, runReused: reused, runPending: pendingCountNow(), runFailed: failedCountNow(), attempts: acquisitionAttempts, newBytes: acquiredBytes },
      verificationDeadline,
      cumulative: { acquiredMediaCount: Object.keys(completed).length, pendingCount: Object.keys(pending).length, failedCount: Object.keys(failed).length, conflictCount: Object.keys(conflicts).length },
      status: global.status,
      reason: global.reason,
      runId,
      handle,
      mode,
      stage: 'finished',
      requestedCategories: categories,
      mediaTypes,
      sections: finalSections.map(statusSectionRecord),
      uniquePostCount,
      reportedTotal: postSection?.reportedTotal ?? null,
      completedCount: Object.keys(completed).length,
      failedCount: failedCountNow(),
      pendingCount: pendingCountNow(),
      downloadedCount: downloaded,
      reusedCount: reused,
      // Exactly what is still missing, separated from what actually failed.
      coverage: {
        reportedTotalKnown: (postSection?.reportedTotal ?? null) != null,
        reportedTotal: postSection?.reportedTotal ?? null,
        uniquePostCount,
        missingPostCount: (postSection?.reportedTotal ?? null) != null ? Math.max(0, postSection.reportedTotal - uniquePostCount) : null,
        outstandingMediaCount: Object.keys(failed).length + Object.keys(pending).length
      },
      resume: resumeRecord(),
      conflictCount: Object.keys(conflicts).length,
      updatedAt: new Date().toISOString()
    });
    }
    let scan;
    try {
      if (!opts.items && !opts.sections) {
        const ledgerFile = path.join(paths.stateDir, "discovery.jsonl");
        await ensureNoSymlinkAncestors(ledgerFile);
        ledger = await discovery.openLedger(ledgerFile, { handle, runId, runtime, maxObservedMedia: effective.maxObservedMedia });
        discovery.replayRequirement(ledger.frontier, effective);
      }
      if (opts.sections) scan = { profile: opts.profile || null, sections: normalizeProvidedSections(opts.sections, mediaTypes) };
      else if (opts.items) scan = legacyScanFromItems({ ...opts, category: categories[0] || 'posts', mediaTypes });
      else return await scrapeWithPlaywright({ consumeScan, stopWhenTargetsObserved: effective.discoveryOnly && !!(effective.targetIds.length || effective.targetPosts.length), targetPosts: effective.targetPosts, handle, maxPages: effective.maxPages, maxTimeMs: discoveryBudgetMs, browserExecutable: opts.browserExecutable, browserChannel: opts.browserChannel, attachCdp: opts.attachCdp, categories, mediaTypes, resumeTargets, targetAliases, slicePages: effective.slicePages, sliceTimeMs: effective.sliceTimeMs, maxObservedMedia: effective.maxObservedMedia, requireTerminal: mode === 'full',
        onDiscoveryBatch: async batch => { await ledger.checkpoint(batch); await writeOwner('discovery'); } });
      return await consumeScan(scan);
    } catch (err) {
      const status = { status: err instanceof DeferredError ? 'DEFERRED' : 'ACTION_REQUIRED', reason: redactSignedUrls(err.message), retryAt: err.retryAt, runId, handle, mode, stage, requestedCategories: categories, mediaTypes, updatedAt: new Date().toISOString(), priorCompletedCount: Object.keys(completed).length };
      await writeOwner(stage, { status: status.status, terminal: true });
      await writeStatus(paths, status);
      throw err;
    }
    } catch (err) {
      if (ledger) { try { await ledger.close(err.code || 'observation-error'); } catch {} ledger = null; }
      // However this run ends, its claim ends with it. Leaving a non-terminal record naming a still
      // live process would refuse the next legitimate run as a second writer.
      try {
        await writeOwner(stage, { status: err instanceof DeferredError ? 'DEFERRED' : (err && err.code) || 'FAILED', terminal: true });
      } catch {
        // If the claim cannot even be finalized, remove it. No record at all reads as "no owner",
        // which is recoverable; a record naming this live process would refuse the next run.
        await fsp.unlink(paths.owner).catch(() => {});
      }
      throw err;
    }
  });
}
function zipReadmeText(handle, status) {
  return [
    'FrameFerry portable export for @' + handle,
    '',
    "This is a ZIP of public content exposed through InstaCognito's public UI.",
    'It is not an Instagram account export and cannot recover deleted, expired, or private stories.',
    "Code is MIT-licensed; downloaded media remains subject to its owners' rights.",
    'Packaging success is separate from archive completeness. See manifest.json and sections.json.',
    'Stories/highlights without stable provider shortcodes are re-fetched on future syncs and deduped after hashing.',
    'ZIP support is bounded to ZIP32-safe archives: max 2 GiB output and 5000 entries in this release.',
    '',
    'Archive status: ' + (status?.status || 'UNKNOWN'),
    'Archive reason: ' + (status?.reason || 'unknown')
  ].join('\n') + '\n';
}
async function prepareZipDestination(zipPath, root, overwrite) {
  if (!zipPath) throw new ArchiveError('BAD_ARGS', '--zip is required');
  const dest = path.resolve(zipPath);
  if (dest === root || dest.startsWith(root + path.sep)) throw new ArchiveError('BAD_OUTPUT', 'zip destination must be outside the archive root');
  await ensureNoSymlinkAncestors(dest, { allowMissingLeaf: true });
  const existing = await fsp.lstat(dest).catch(() => null);
  if (existing) {
    if (!overwrite) throw new ArchiveError('BAD_OUTPUT', 'zip destination already exists');
    if (!existing.isFile()) throw new ArchiveError('BAD_OUTPUT', 'zip destination must be a file path');
  }
  return dest;
}
async function exportProfile(opts = {}) {
  const handle = validateHandle(opts.handle);
  const root = await safeOutputRoot(opts.output);
  const dest = await prepareZipDestination(opts.zip, root, !!opts.overwriteZip);
  const part = dest + '.part';
  if (dest === part) throw new ArchiveError('BAD_OUTPUT', 'zip destination is invalid');
  const paths = profilePaths(root, handle);
  const manifest = await readJson(paths.manifest);
  const status = await readJson(paths.status, { status: 'ACTION_REQUIRED', reason: 'no status exists yet', handle });
  if (!manifest) throw new ArchiveError('BAD_OUTPUT', 'no manifest exists for this handle');
  const receipts = Object.values(manifest.completed || {}).sort((a, b) => String(receiptStableId(a)).localeCompare(String(receiptStableId(b))));
  const maxBytes = asPositiveIntOrDefault(opts.maxZipBytes, ZIP32_HARD_MAX_BYTES, '--max-zip-bytes');
  const maxEntries = asPositiveIntOrDefault(opts.maxZipEntries, ZIP32_HARD_MAX_ENTRIES, '--max-zip-entries');
  const maxFiles = asPositiveIntOrDefault(opts.maxZipFiles, ZIP32_HARD_MAX_FILES, '--max-zip-files');
  if (receipts.length > maxFiles) throw new ArchiveError('BAD_OUTPUT', 'zip source file count exceeds configured limit');
  const sourceFiles = [];
  let sourceBytes = 0;
  for (const receipt of receipts) {
    if (!await verifyReceipt(paths, receipt)) throw new ArchiveError('BAD_OUTPUT', 'zip source receipt verification failed for ' + (receiptStableId(receipt) || 'unknown')); 
    const sourcePath = await ensureSafeFileInsideRoot(root, receipt.path);
    const st = await fsp.stat(sourcePath);
    sourceBytes += st.size;
    if (sourceBytes > maxBytes) throw new ArchiveError('BAD_OUTPUT', 'zip source bytes exceed configured ZIP32-safe limit');
    sourceFiles.push({ receipt, sourcePath, size: st.size });
  }
  const timestamp = new Date().toISOString().replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z');
  const rootEntry = 'frameferry-' + handle + '-' + timestamp;
  const sections = (status.sections || manifest.sections || []).map(statusSectionRecord);
  const index = receipts.map(receipt => ({
    id: receiptStableId(receipt),
    category: receiptCategory(receipt),
    mediaType: receipt.mediaType || 'unknown',
    shortcode: receipt.shortcode ?? null,
    carouselIndex: receipt.carouselIndex ?? 0,
    captionTruncated: receipt.captionTruncated ?? null,
    permalink: receipt.permalink ?? null,
    dateRaw: receipt.dateRaw ?? null,
    dateParsed: receipt.dateParsed ?? null,
    highlightGroup: receipt.highlightGroup ?? null,
    bytes: receipt.bytes,
    sha256: receipt.sha256,
    path: 'media/' + path.basename(receipt.path),
    identityBasis: receiptIdentityBasis(receipt)
  }));
  const zipManifest = {
    version: 1,
    toolVersion: VERSION,
    handle,
    generatedAt: new Date().toISOString(),
    provider: { origin: PROVIDER_ORIGIN, photoUrl: PROVIDER_PHOTO_URL, source: 'instacognito-public-ui' },
    requestedCategories: status.requestedCategories || manifest.requestedCategories || DEFAULT_CATEGORIES,
    mediaTypes: status.mediaTypes || manifest.mediaTypes || DEFAULT_MEDIA_TYPES,
    completeness: {
      packagingStatus: 'COMPLETE',
      archiveStatus: status.status || 'UNKNOWN',
      archiveReason: status.reason || null,
      requestedSectionCount: sections.length,
      completedSectionCount: sections.filter(section => section.status === 'COMPLETE').length
    }
  };
  const generated = new Map();
  generated.set(rootEntry + '/manifest.json', Buffer.from(jsonText(zipManifest)));
  generated.set(rootEntry + '/index.json', Buffer.from(jsonText(index)));
  generated.set(rootEntry + '/sections.json', Buffer.from(jsonText(sections)));
  generated.set(rootEntry + '/README.txt', Buffer.from(zipReadmeText(handle, status)));
  for (const receipt of receipts) {
    const publicReceipt = { ...receipt, category: receiptCategory(receipt), identityBasis: receiptIdentityBasis(receipt) };
    delete publicReceipt.href;
    generated.set(rootEntry + '/receipts/' + receiptStableId(receipt) + '.json', Buffer.from(jsonText(publicReceipt)));
  }
  const checksumLines = [];
  for (const [entryName, buf] of generated.entries()) checksumLines.push(sha256(buf) + '  ' + entryName.slice(rootEntry.length + 1));
  for (const file of sourceFiles) checksumLines.push(file.receipt.sha256 + '  media/' + path.basename(file.receipt.path));
  generated.set(rootEntry + '/checksums.txt', Buffer.from(checksumLines.join('\n') + '\n'));
  if (generated.size + sourceFiles.length > maxEntries) throw new ArchiveError('BAD_OUTPUT', 'zip entry count exceeds configured limit');
  const stalePart = await fsp.lstat(part).catch(() => null);
  if (stalePart) {
    if (!stalePart.isFile()) throw new ArchiveError('BAD_OUTPUT', 'zip temporary .part path already exists and is not a file');
    if (!opts.overwriteZip) throw new ArchiveError('BAD_OUTPUT', 'zip temporary .part already exists; rerun with --overwrite-zip after inspection');
    await fsp.rm(part, { force: true });
  }
  let writer;
  let interrupted;
  const onSignal = async (signal) => {
    interrupted = new ArchiveError('INTERRUPTED', 'zip export interrupted by ' + signal);
    await writer?.abort().catch(() => {});
    await fsp.rm(part, { force: true }).catch(() => {});
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    writer = await ZipWriter.create(part, { maxEntries, maxBytes });
    for (const [entryName, buf] of generated.entries()) await writer.addBuffer(entryName, buf);
    for (const file of sourceFiles) await writer.addFile(rootEntry + '/media/' + path.basename(file.receipt.path), file.sourcePath);
    if (interrupted) throw interrupted;
    await writer.close();
    await fsp.rename(part, dest);
  } catch (err) {
    await writer?.abort().catch(() => {});
    await fsp.rm(part, { force: true }).catch(() => {});
    throw err;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  return {
    zipPath: dest,
    sourceFileCount: sourceFiles.length,
    generatedEntryCount: generated.size,
    totalEntryCount: sourceFiles.length + generated.size,
    maxBytes,
    archiveStatus: status.status || 'UNKNOWN',
    archiveReason: status.reason || null
  };
}
async function statusProfile({ handle, output }) {
  validateHandle(handle);
  const root = await safeOutputRoot(output);
  const paths = profilePaths(root, handle);
  await ensureSafeDir(paths.stateDir, paths.root);
  const status = await readJson(paths.status, { status: 'ACTION_REQUIRED', reason: 'no status exists yet', handle });
  // A status left saying RUNNING by a process that is gone is stale metadata, not a running job.
  // Report what is actually true rather than repeating the claim.
  const owner = await readJson(paths.owner, null);
  const evaluated = evaluateOwnerRecord(owner);
  if (status.status === 'RUNNING' && evaluated.state !== 'ACTIVE') {
    return { ...status, status: 'INTERRUPTED', reason: 'run ' + (owner?.runId || status.runId || 'unknown') + ' stopped at stage ' + (owner?.stage || status.stage || 'unknown') + ' without recording an outcome', ownerState: evaluated.state, owner: owner ? { runId: owner.runId, pid: owner.pid ?? null, stage: owner.stage ?? null, updatedAt: owner.updatedAt ?? null } : null };
  }
  return { ...status, ownerState: evaluated.state };
}
async function doctor({ attachCdp } = {}) {
  const checks = { node: process.versions.node, nodeOk: Number(process.versions.node.split('.')[0]) >= 20, playwright: false, cdpOk: true, zip32ExportLimitBytes: ZIP32_HARD_MAX_BYTES };
  try { require('playwright'); checks.playwright = true; } catch (err) { checks.playwrightError = err.message; }
  if (attachCdp) {
    try { const u = new URL(attachCdp); checks.cdpOk = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname); }
    catch { checks.cdpOk = false; }
  }
  checks.ok = checks.nodeOk && checks.playwright && checks.cdpOk;
  return checks;
}

module.exports = {
  VERSION,
  PROVIDER_ORIGIN,
  PROVIDER_PHOTO_URL,
  VALID_CATEGORIES,
  VALID_MEDIA_TYPES,
  ArchiveError,
  DeferredError,
  validateHandle,
  redactSignedUrls,
  safeOutputRoot,
  ensureSafeDir,
  profilePaths,
  atomicWriteJson,
  readJson,
  withLock,
  parseRetryAfter,
  legacyStableMediaId,
  stableMediaId,
  parseDateText,
  normalizeItems,
  parseReportedTotal,
  validateProviderMediaUrl,
  validateRedirectTarget,
  isPrivateIp,
  isPrivateHostLiteral,
  fetchWithValidatedRedirects,
  streamResponseToPart,
  verifyReceipt,
  downloadOne,
  decideOutcome,
  archiveProfile,
  exportProfile,
  getRenderedCardState,
  PAGINATION_SENTINEL_ATTR,
  installPaginationSentinelProbe,
  attachContinuationRequestMonitor,
  scrollLastCardCenterAndWaitForGrowth,
  scrapeWithPlaywright,
  extractReportedTotalFromPage,
  extractItemsFromPage,
  readRawCardsFromPage,
  extractItemsFromRawCards,
  waitForProfileReady,
  scanReadyProfilePage,
  extractProfileFromPage,
  scrapeCardSection,
  cleanupScrapeBrowser,
  statusProfile,
  doctor,
  isPendingEntry,
  partitionPriorOutcomes,
  reconcileAgainstReceipts,
  loadByteEvidence,
  evaluateOwnerRecord,
  discoveryCoverageSatisfied,
  parseCategories,
  parseMediaTypes, elapsedSince, providerMediaFingerprint, providerMediaIdentity, switchToCategoryTab, waitForSectionReady, discovery,
  sanitizeFailedItem,
};
