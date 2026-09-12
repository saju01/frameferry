'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
const error = (code, message, details = {}) => Object.assign(new Error(message), { code, details });
function validateOptions(opts = {}) {
  const integer = (key, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    const n = opts[key] == null ? fallback : Number(opts[key]);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw error('BAD_ARGS', key + ' must be an integer in [' + min + ', ' + max + ']');
    return n;
  };
  const list = key => {
    const items = opts[key] == null ? [] : (Array.isArray(opts[key]) ? opts[key] : String(opts[key]).split(','));
    if (items.length > 500 || items.some(x => typeof x !== 'string' || !/^[A-Za-z0-9_.-]{1,180}$/.test(x))) throw error('BAD_ARGS', key + ' must contain at most 500 sanitized IDs');
    return [...new Set(items)];
  };
  if (opts.discoveryOnly && opts.zip) throw error('BAD_ARGS', 'discovery-only cannot export or acquire');
  const maxTimeMs = integer('maxTimeMs', 600000, 1, 7200000);
  return { maxTimeMs, maxPages: integer('maxPages', 12, 1, 1000),
    discoveryMaxTimeMs: integer('discoveryMaxTimeMs', Math.max(1, Math.floor(maxTimeMs / 2)), 1, maxTimeMs),
    acquisitionMaxTimeMs: integer('acquisitionMaxTimeMs', maxTimeMs, 0, maxTimeMs),
    slicePages: integer('slicePages', 12, 1, 1000), sliceTimeMs: integer('sliceTimeMs', Math.min(180000, maxTimeMs), 1, 7200000),
    checkpointEveryItems: integer('checkpointEveryItems', 25, 1, 1000),
    maxAcquireItems: integer('maxAcquireItems', 100000, 0, 100000),
    maxAcquireBytes: integer('maxAcquireBytes', 512 * 1024 * 1024, 0, 2 * 1024 * 1024 * 1024),
    maxBytes: integer('maxBytes', 50 * 1024 * 1024, 1, 512 * 1024 * 1024),
    networkTimeoutMs: integer('networkTimeoutMs', 60000, 1, 600000), delayMs: integer('delayMs', 500, 0, 60000),
    maxLocatorAgeMs: integer('maxLocatorAgeMs', 300000, 1, 7200000),
    maxObservedMedia: integer('maxObservedMedia', 100000, 1, 100000),
    discoveryOnly: !!opts.discoveryOnly, targetIds: list('targetIds'), targetPosts: list('targetPosts'), stopOnItemFailure: !!opts.stopOnItemFailure };
}
function runtimeReceipt(effective) {
  const files = ['index.js', 'discovery.js', 'zip.js', '../bin/frameferry.js', '../package.json'].map(name => [name, hash(fs.readFileSync(path.join(__dirname, name)))]);
  let commit = null;
  // Local read-only provenance; no remote access and no environment/argv secrets.
  try { commit = require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).toString().trim(); } catch {}
  return { schemaVersion: 1, commit, sourceHashes: Object.fromEntries(files), sourceDigest: hash(JSON.stringify(files)), resources: resourceSnapshot(), node: process.version, playwright: require('playwright/package.json').version, effectiveOptions: effective };
}
// State lives in the owned page only. No URLs leave this buffer except to the in-memory
// acquisition queue. A bounded overflow is an observation gap, never silent truncation.
const instrumented = new WeakSet();
const navigationTracked = new WeakSet();
async function installCapture(page) {
  if (typeof page.on !== 'function') return false; // explicit synthetic adapters use polling
  if (!navigationTracked.has(page)) {
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) instrumented.delete(page);
    });
    navigationTracked.add(page);
  }
  const expectedExisting = instrumented.has(page);
  const result = await page.evaluate(expectedExisting => {
    const existing = window.__ffCapture;
    if (existing) {
      if (!Array.isArray(existing.queue) || typeof existing.reset !== 'function' ||
          !existing.observer || !Number.isInteger(existing.generation)) {
        return { installed: false, gap: 'invalid-document-capture-state' };
      }
      return { installed: true };
    }
    if (expectedExisting) return { installed: false, gap: 'document-capture-state-lost' };
    const state = { queue: [], cards: 0, generation: 0, gap: null, category: null };
    const extract = card => {
      const likes = card.querySelector('.likes-trigger'), comments = card.querySelector('.comments-trigger');
      const date = [...card.querySelectorAll('.post-footer .icon-group')].at(-1);
      return { shortcode: likes?.getAttribute('data-id') || comments?.getAttribute('data-id') || card.querySelector('[data-id]')?.getAttribute('data-id') || '',
        mediaType: card.querySelector('.post-image, .story-image')?.getAttribute('data-type') || 'unknown',
        href: card.querySelector('.content-download-btn[href]')?.href || '',
        dateRaw: date?.querySelector('span')?.textContent?.trim() || date?.textContent?.trim() || null,
        captionTruncated: card.querySelector('.post-content p')?.textContent?.trim() || null,
        likes: likes?.querySelector('span')?.textContent?.trim() || null, comments: comments?.querySelector('span')?.textContent?.trim() || null };
    };
    const enqueue = cards => {
      if (!cards.length || state.gap) return;
      if (state.queue.length >= 64 || state.cards + cards.length > 4096) { state.gap = 'generation-buffer-overflow'; return; }
      state.queue.push({ generation: ++state.generation, category: state.category, observedAt: new Date().toISOString(), cards: cards.map(extract) });
      state.cards += cards.length;
    };
    const observer = new MutationObserver(records => {
      // Removed subtrees preserve intermediate innerHTML replacements, including several
      // replacements in the same JS task before the next polling tick.
      const removed = new Set(); let relevant = false;
      for (const record of records) {
        const inPosts = record.target.closest?.('#post-container') || [...record.removedNodes].some(n => n.id === 'post-container');
        if (!inPosts) continue;
        relevant = true;
        if (record.type === 'attributes' && record.attributeName === 'href' && record.oldValue !== record.target.getAttribute('href')) {
          // Old locators of the SAME identity are not needed. Identity swaps on one node
          // cannot be reconstructed with all old metadata: flag the limitation explicitly.
          try { if (new URL(record.oldValue, location.href).searchParams.get('id') !== new URL(record.target.href).searchParams.get('id')) state.gap = 'in-place-media-identity-change'; } catch { state.gap = 'unreadable-attribute-generation'; }
        }
        for (const node of record.removedNodes) {
          if (node.matches?.('.post-card')) removed.add(node);
          for (const card of node.querySelectorAll?.('.post-card') || []) removed.add(card);
        }
      }
      if (removed.size) enqueue([...removed]);
      if (relevant) enqueue([...document.querySelectorAll('#post-container .post-card')]);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true, attributeFilter: ['href', 'data-id', 'data-type'] });
    state.observer = observer;
    state.reset = category => { state.queue = []; state.cards = 0; state.gap = null; state.category = category; };
    window.__ffCapture = state;
    return { installed: true };
  }, expectedExisting);
  if (result?.gap) throw error('OBSERVATION_GAP', result.gap);
  if (result?.installed) instrumented.add(page);
  return !!result?.installed;
}
async function resetCapture(page, category) {
  if (await installCapture(page)) await page.evaluate(category => window.__ffCapture.reset(category), category);
}
async function drainCapture(page) {
  if (!await installCapture(page)) return { batches: [], generation: 0, gap: null };
  return page.evaluate(() => { const s = window.__ffCapture; const batches = s.queue; s.queue = []; s.cards = 0; return { batches, generation: s.generation, gap: s.gap }; });
}
// Append-only deltas avoid rewriting every prior identity on every 250ms observation.
// A fsync completes BEFORE the next trigger. A truncated final line after SIGKILL is
// discarded on recovery; all previously acknowledged batches survive. No signed URL.
async function openLedger(file, { handle, runId, runtime, maxObservedMedia = 100000 }) {
  const observed = new Map(); let frontier = {}; let sequence = 0; let recoveredTail = false;
  let ledgerBytes = (await fsp.stat(file).catch(e => { if (e.code === 'ENOENT') return {size:0}; throw e; })).size;
  if (ledgerBytes > 64 * 1024 * 1024) throw error('RESOURCE_BUDGET', 'discovery ledger exceeds bounded 64MiB; explicit compaction required');
  const existing = await fsp.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  let validBytes = 0;
  const lines = existing.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]; if (!line) { validBytes++; continue; }
    let entry; try { entry = JSON.parse(line); } catch { throw error('DISCOVERY_CORRUPT', 'discovery ledger has a corrupt committed record'); }
    if (entry.handle !== handle || entry.schemaVersion !== 1 || entry.sequence !== sequence + 1) throw error('DISCOVERY_BINDING', 'discovery ledger identity or sequence mismatch');
    sequence = entry.sequence;
    for (const item of entry.items || []) { if (!item.id || !item.category || !item.fingerprint) throw error('DISCOVERY_CORRUPT', 'invalid discovery identity'); observed.set(item.id, item); }
    if (observed.size > maxObservedMedia) throw error('RESOURCE_BUDGET', 'saved discovery exceeds maxObservedMedia');
    if (entry.frontier) frontier[entry.frontier.category] = entry.frontier;
    validBytes += Buffer.byteLength(line) + 1;
  }
  if (lines.at(-1)) { recoveredTail = true; await fsp.truncate(file, validBytes); }
  const fd = await fsp.open(file, 'a', 0o600);
  const append = async record => {
    const entry = { schemaVersion: 1, handle, runId, sequence: ++sequence, observedAt: new Date().toISOString(), ...record };
    const line = JSON.stringify(entry).replace(/https:\/\/instacognito[.]com\/media[^\s"']*/gi, '[REDACTED media URL]') + '\n';
    if (ledgerBytes + Buffer.byteLength(line) > 64 * 1024 * 1024) throw error('RESOURCE_BUDGET', 'discovery ledger byte ceiling reached');
    await fd.writeFile(line); await fd.sync(); ledgerBytes += Buffer.byteLength(line);
  };
  await append({ event: 'session-start', runtime, recoveredTail, owner: { pid: process.pid, host: os.hostname() } });
  return { observed, frontier,
    async checkpoint(batch) {
      const items = [];
      for (const item of batch.items || []) {
        if (!item.stableId || !item.providerMediaFingerprint) continue;
        const clean = { id: item.stableId, category: item.category, rawPostId: item.shortcode, fingerprint: item.providerMediaFingerprint, metadataProvenance: item.metadataProvenance, locatorObservedAt: item.locatorObservedAt };
        const old = observed.get(clean.id);
        if (!old || JSON.stringify(old.metadataProvenance) !== JSON.stringify(clean.metadataProvenance) || old.locatorObservedAt !== clean.locatorObservedAt) items.push(clean);
        observed.set(clean.id, clean);
      }
      if (observed.size > maxObservedMedia) throw error('RESOURCE_BUDGET', 'discovery identity ceiling reached');
      let savedFrontier = batch.frontier;
      if (batch.frontier) {
        const old = frontier[batch.frontier.category];
        savedFrontier = old && old.pages > batch.frontier.pages ? { ...old, currentPages: batch.frontier.pages, currentElapsedMs: batch.frontier.elapsedMs, lastRunId: runId } : { ...batch.frontier, stopCause: batch.stopCause, lastRunId: runId };
        frontier[batch.frontier.category] = savedFrontier;
      }
      await append({ event: 'checkpoint', items, frontier: savedFrontier, stopCause: batch.stopCause });
    },
    async close(stopCause) { try { await append({ event: 'session-end', stopCause }); } finally { await fd.close(); } }
  };
}
function replayRequirement(frontier, options) {
  const needPages = Math.max(0, ...Object.values(frontier || {}).map(f => f.pages || 0)) + 1;
  const needMs = Math.max(0, ...Object.values(frontier || {}).map(f => f.elapsedMs || 0)) + 2000;
  if (Object.keys(frontier || {}).length && (options.maxPages < needPages || options.discoveryMaxTimeMs < needMs)) throw error('REPLAY_BUDGET', 'new UI session cannot extend saved frontier under declared ceilings', { requiredMaxPages: needPages, requiredDiscoveryMaxTimeMs: needMs });
  return { requiredMaxPages: needPages, requiredDiscoveryMaxTimeMs: needMs };
}
function resourceSnapshot() {
  const result = { processRssBytes: process.memoryUsage().rss, observedAt: new Date().toISOString() };
  try {
    const group = fs.readFileSync('/proc/self/cgroup', 'utf8').split(String.fromCharCode(10)).find(s => s.startsWith('0::')).slice(3);
    const dir = path.join('/sys/fs/cgroup', group);
    result.cgroupMemoryMax = fs.readFileSync(path.join(dir,'memory.max'),'utf8').trim();
    result.cgroupMemoryCurrent = Number(fs.readFileSync(path.join(dir,'memory.current'),'utf8').trim());
  } catch { result.cgroupObservation = 'unavailable'; }
  return result;
}
module.exports = { resourceSnapshot, validateOptions, runtimeReceipt, installCapture, resetCapture, drainCapture, openLedger, replayRequirement };
