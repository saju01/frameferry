const fsp = require('node:fs/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { ZipWriter, ZIP32_MAX } = require('./zip.js');

const VERSION = '0.2.2';
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
// Matches every spelling of a signed provider URL, not just the canonical one: scheme and host
// are case-insensitive, an explicit port or userinfo may be present, subdomains are allowed, the
// query may order its parameters any way, and a protocol-relative form still counts.
const SIGNED_URL_RE = /(?:https?:)?\/\/(?:[^\s/@]*@)?(?:[a-z0-9-]+\.)*instacognito\.com(?::\d+)?\/(?:media\b[^\s"'<>]*|[^\s"'<>]*\?[^\s"'<>]*)/gi;
function redactSignedUrls(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.replace(SIGNED_URL_RE, '[REDACTED instacognito media URL]');
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function jsonText(data) { return JSON.stringify(data, null, 2) + '\n'; }
function unique(list) { return [...new Set(list)]; }
function asPositiveIntOrDefault(value, fallback, label) {
  if (value == null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw new ArchiveError('BAD_ARGS', label + ' must be a positive number');
  return Math.floor(n);
}
function normalizeMediaType(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'image' || v === 'photo' || v === 'jpg' || v === 'png' || v === 'webp') return 'image';
  if (v === 'video' || v === 'reel' || v === 'mp4') return 'video';
  return 'unknown';
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
  await fsp.writeFile(tmp, jsonText(data), { mode });
  await fsp.chmod(tmp, mode);
  await fsp.rename(tmp, file);
  await fsp.chmod(file, mode);
}
async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
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
    status: path.join(root, '.frameferry', handle, 'status.json')
  };
}
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
function parseDateText(value) {
  if (!value) return null;
  const clean = String(value).split('\n').map(s => s.trim()).filter(Boolean).at(-1) || String(value).trim();
  if (!/\b(?:19|20)\d{2}\b/.test(clean)) return clean;
  const t = Date.parse(clean);
  return Number.isFinite(t) ? new Date(t).toISOString() : clean;
}
// Date provenance -------------------------------------------------------------
// parseDateText (above) is deliberately unchanged: it returns an ISO timestamp when it can and
// echoes the human label when it cannot, so `dateParsed` alone can never tell a caller whether
// it holds a proven instant or a piece of display text. The fields below make that difference
// explicit and machine-readable. A year is NEVER inferred -- not from neighbouring items, not
// from scrape order, and not from the wall clock -- so a yearless or relative label stays
// unresolved until a caller supplies a per-item proof.
const DATE_STATUSES = new Set(['resolved', 'unresolved']);
const DATE_PROVENANCES = new Set([
  'provider-iso',            // input was already an ISO-8601 date; UTC, deterministic
  'provider-explicit-year',  // label carried an explicit 4-digit year; day precision, host TZ
  'provider-unparsed-label', // explicit year present but the label did not parse to that year
  'provider-relative-label', // "2d", "3 hours ago", "yesterday" -- no absolute instant
  'provider-yearless-label', // "23 August" -- ambiguous across years
  'caller-proven',           // caller supplied a proven date plus the evidence for it
  'none'                     // no date text at all
]);
const EXPLICIT_YEAR_RE = /\b((?:19|20)\d{2})\b/;
// A full calendar date is required. YYYY-MM is a valid ISO string but names a month, not a day,
// and promoting it would assert a day the provider never published.
// Captured rather than merely matched, so the spelled calendar fields can be validated
// arithmetically instead of being handed to Date.parse, which silently rolls an impossible date
// over (2024-02-31T00:00:00Z becomes 2 March) for every time-bearing form.
const ISO_PARTS_RE = /^((?:19|20)\d{2})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
// Anything written in ISO shape must clear the strict ISO check or stay unresolved. Date.parse
// falls back to a lenient legacy parser when strict ISO parsing fails, which rescues impossible
// dates like 2024-02-31 as 2 March; the explicit-year path must never see them.
const ISO_SHAPED_RE = /^(?:19|20)\d{2}-\d{1,2}(?:-\d{1,2})?(?:[T ]|$)/;
const EXPLICIT_ZONE_RE = /(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})\s*$/i;
const RELATIVE_DATE_RE = /\bago\b|\byesterday\b|\btoday\b|\bjust now\b|\blast\b|^\d+\s*(?:s|m|h|d|w|min|mins|hr|hrs|sec|secs|day|days|week|weeks|month|months|year|years)$|^\d+\s*(?:day|days|week|weeks|month|months|year|years)\b/i;
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Evidence for a caller-proven date is a closed vocabulary plus an optional sanitized note, not
// free text: arbitrary caller strings are persisted into receipts and copied into the public ZIP.
const DATE_EVIDENCE_KINDS = new Set(['provider-permalink', 'provider-listing', 'operator-attested', 'external-record']);
const URLISH_RE = /(?:[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)/gi;
const CONTROL_CHAR_RE = new RegExp('[\\u0000-\\u001f\\u007f]+', 'g');
const EVIDENCE_NOTE_MAX = 200;
function cleanDateText(value) {
  if (value == null) return null;
  const text = String(value);
  return text.split('\n').map(s => s.trim()).filter(Boolean).at(-1) || text.trim() || null;
}
// Date.parse reads a zone-less label as LOCAL midnight while toISOString() renders UTC, so on a
// host east of UTC "1 January 2019" would otherwise persist as 2018-12-31T13:00:00.000Z -- the
// wrong year, in the one field that claims to be authoritative. When the text carries no zone,
// re-read the calendar fields it actually spelled out and pin them to UTC, so the resolved value
// is the date the provider displayed regardless of where the archive ran.
function utcFromLocalParts(d) {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds())).toISOString();
}
function pinnedInstant(text, t, alreadyUtc) {
  const d = new Date(t);
  return alreadyUtc ? d.toISOString() : utcFromLocalParts(d);
}
// Only promote text whose parsed instant expresses exactly the calendar date the text spelled
// out. Date.parse silently normalizes impossible dates and accepts month-precision input; both
// must stay unresolved rather than become an asserted capture timestamp.
function isRealCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function resolveIsoInstant(text) {
  if (typeof text !== 'string') return null;
  const parts = ISO_PARTS_RE.exec(text);
  if (!parts) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, msText, zone] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  // Validate the calendar ourselves. Date.parse is strict for a bare ISO date but lenient for a
  // date-time, so an impossible day would otherwise be normalized into a real instant and then
  // asserted as an authoritative capture timestamp.
  if (!isRealCalendarDate(year, month, day)) return null;
  const hour = hourText === undefined ? 0 : Number(hourText);
  const minute = minuteText === undefined ? 0 : Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const ms = msText === undefined ? 0 : Number(msText.padEnd(3, '0'));
  if (hour > 23 || minute > 59 || second > 59) return null;
  const t = Date.parse(text);
  if (!Number.isFinite(t)) return null;
  // A bare ISO date is UTC by specification; a date-time is local unless it names a zone.
  const dateOnly = hourText === undefined;
  const iso = pinnedInstant(text, t, dateOnly || Boolean(zone));
  // Without a zone the value is pinned to the fields the text spelled, so it must round-trip
  // exactly. With a zone the instant is unambiguous and the calendar check above is the guard.
  if (!zone) {
    const back = new Date(iso);
    if (back.getUTCFullYear() !== year || back.getUTCMonth() + 1 !== month || back.getUTCDate() !== day
      || back.getUTCHours() !== hour || back.getUTCMinutes() !== minute
      || back.getUTCSeconds() !== second || back.getUTCMilliseconds() !== ms) return null;
  }
  return iso;
}
function resolveExplicitYearInstant(text, year) {
  const t = Date.parse(text);
  if (!Number.isFinite(t)) return null;
  const iso = pinnedInstant(text, t, EXPLICIT_ZONE_RE.test(text));
  const final = new Date(iso);
  // Compare against the UTC fields of the value actually persisted, not the local ones, so the
  // guard cannot pass while the stored string says a different year.
  if (final.getUTCFullYear() !== Number(year)) return null;
  // The label must actually name a day of month, and the parsed day must be that day. This
  // rejects month-precision labels ("August 2024"), year-only labels, and dates the engine
  // rolled over ("31 February 2024" parses to 2 March).
  const dayTokens = (text.match(/\b\d{1,2}\b/g) || []).map(Number);
  if (!dayTokens.includes(final.getUTCDate())) return null;
  const lower = text.toLowerCase();
  // If a month was named in words, it must be the month that was parsed.
  if (MONTH_NAMES.some(name => lower.includes(name.slice(0, 3))) && !lower.includes(MONTH_NAMES[final.getUTCMonth()].slice(0, 3))) return null;
  return iso;
}
function strictInstant(text) {
  const iso = resolveIsoInstant(text);
  if (iso) return iso;
  if (typeof text !== 'string' || ISO_SHAPED_RE.test(text)) return null;
  const year = text.match(EXPLICIT_YEAR_RE);
  return year ? resolveExplicitYearInstant(text, year[1]) : null;
}
// Notes are optional colour on an allowlisted evidence kind, never a place to park a URL: every
// URL-shaped token is removed outright rather than pattern-matched against one provider spelling.
function sanitizeEvidenceNote(value) {
  if (typeof value !== 'string') return null;
  const stripped = redactSignedUrls(value)
    .replace(URLISH_RE, '[url removed]')
    .replace(CONTROL_CHAR_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  return stripped.length > EVIDENCE_NOTE_MAX ? stripped.slice(0, EVIDENCE_NOTE_MAX).trim() + '...' : stripped;
}
function normalizeDateEvidence(value, where = '') {
  const source = typeof value === 'string' ? { kind: value } : (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
  if (!source) throw new ArchiveError('BAD_DATE_PROOF', 'dateEvidence must be an allowlisted kind, or { kind, note }' + where);
  const kind = typeof source.kind === 'string' ? source.kind.trim() : '';
  if (!DATE_EVIDENCE_KINDS.has(kind)) throw new ArchiveError('BAD_DATE_PROOF', 'dateEvidence.kind must be one of ' + [...DATE_EVIDENCE_KINDS].join(', ') + where);
  return { kind, note: sanitizeEvidenceNote(source.note) };
}
function unresolvedDate(dateRaw, dateParsed, provenance) {
  return { dateRaw, dateParsed, dateResolved: null, dateStatus: 'unresolved', dateProvenance: provenance, dateEvidence: null };
}
// Returns the full date field set for one item. `dateProven`/`dateEvidence` are NEW input names
// on purpose: the long-standing `dateParsed` input keeps its "best available text" meaning and
// can never promote an item to resolved, so existing callers cannot trip the proof validation.
function resolveItemDate(value, opts = {}) {
  const options = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  const dateRaw = value == null ? null : (String(value).trim() || null);
  const dateParsed = parseDateText(value);
  const hasProof = options.dateProven != null || options.dateEvidence != null;
  if (hasProof) {
    const where = options.itemRef ? ' for ' + options.itemRef : '';
    if (options.dateEvidence == null) throw new ArchiveError('BAD_DATE_PROOF', 'dateProven requires dateEvidence describing the per-item proof' + where);
    if (options.dateProven == null) throw new ArchiveError('BAD_DATE_PROOF', 'dateEvidence supplied without dateProven' + where);
    const evidence = normalizeDateEvidence(options.dateEvidence, where);
    const proven = String(options.dateProven).trim();
    if (!EXPLICIT_YEAR_RE.test(proven)) throw new ArchiveError('BAD_DATE_PROOF', 'dateProven must carry an explicit four-digit year' + where);
    const iso = strictInstant(proven);
    if (!iso) throw new ArchiveError('BAD_DATE_PROOF', 'dateProven must be a complete, valid calendar date' + where);
    return { dateRaw, dateParsed: iso, dateResolved: iso, dateStatus: 'resolved', dateProvenance: 'caller-proven', dateEvidence: evidence };
  }
  const clean = cleanDateText(value);
  if (!clean) return { dateRaw, dateParsed, dateResolved: null, dateStatus: 'unresolved', dateProvenance: 'none', dateEvidence: null };
  const iso = resolveIsoInstant(clean);
  if (iso) return { dateRaw, dateParsed, dateResolved: iso, dateStatus: 'resolved', dateProvenance: 'provider-iso', dateEvidence: null };
  const year = clean.match(EXPLICIT_YEAR_RE);
  if (year) {
    const explicit = ISO_SHAPED_RE.test(clean) ? null : resolveExplicitYearInstant(clean, year[1]);
    if (explicit) return { dateRaw, dateParsed, dateResolved: explicit, dateStatus: 'resolved', dateProvenance: 'provider-explicit-year', dateEvidence: null };
    return unresolvedDate(dateRaw, dateParsed, 'provider-unparsed-label');
  }
  if (RELATIVE_DATE_RE.test(clean)) return unresolvedDate(dateRaw, dateParsed, 'provider-relative-label');
  return unresolvedDate(dateRaw, dateParsed, 'provider-yearless-label');
}
// Never trust stored or caller-supplied provenance on its own. Every provider-* provenance is
// reproducible from the raw label, so re-derive it and require the record to agree; a record
// forged as {dateStatus:'resolved'} over a yearless dateRaw fails here. A caller-proven record
// cannot be re-derived by definition, so it must instead carry a well-formed allowlisted
// evidence record and a complete, valid timestamp.
function validatedDateFields(record) {
  const status = record?.dateStatus;
  const provenance = record?.dateProvenance;
  if (!DATE_STATUSES.has(status) || !DATE_PROVENANCES.has(provenance)) return null;
  const resolved = record?.dateResolved ?? null;
  if (provenance === 'caller-proven') {
    if (status !== 'resolved') return null;
    const iso = resolveIsoInstant(typeof resolved === 'string' ? resolved : '');
    if (!iso) return null;
    let evidence;
    try { evidence = normalizeDateEvidence(record?.dateEvidence); } catch { return null; }
    return { dateStatus: 'resolved', dateProvenance: 'caller-proven', dateResolved: iso, dateEvidence: evidence };
  }
  const derived = resolveItemDate(record?.dateRaw ?? null);
  if (derived.dateStatus !== status || derived.dateProvenance !== provenance || derived.dateResolved !== resolved) return null;
  return { dateStatus: derived.dateStatus, dateProvenance: derived.dateProvenance, dateResolved: derived.dateResolved, dateEvidence: null };
}
// Fail closed: anything that needs a real capture instant must refuse an unresolved item rather
// than substitute a guess, and must not be satisfied by a record that merely claims to be
// resolved. Returns the ISO string so callers can use it directly.
function requireCaptureTimestamp(record, context = 'operation') {
  const valid = validatedDateFields(record);
  if (!valid || valid.dateStatus !== 'resolved' || !valid.dateResolved) {
    const reported = record?.dateStatus === 'resolved' ? 'not verifiable' : (record?.dateStatus || 'unknown');
    throw new ArchiveError('DATE_UNRESOLVED', context + ' requires a proven capture timestamp; date is ' + reported + ' (provenance ' + (record?.dateProvenance || 'none') + ')');
  }
  return valid.dateResolved;
}
// Stored fields win only when they survive validation; otherwise recompute from dateRaw so a
// legacy receipt written before this contract, or a tampered one, degrades to unresolved rather
// than to a fabricated timestamp. Used at every site that surfaces a receipt, so index.json and
// receipts/*.json always agree.
function receiptDateFields(record) {
  const valid = validatedDateFields(record);
  if (valid) return valid;
  const derived = resolveItemDate(record?.dateRaw ?? null);
  return { dateStatus: derived.dateStatus, dateProvenance: derived.dateProvenance, dateResolved: derived.dateResolved, dateEvidence: null };
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
  const seenStable = new Set();
  const seenPosts = new Set();
  const nextIndex = new Map();
  const items = [];
  for (const raw of rawItems || []) {
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
    // Accept our own output as input: a normalized caller-proven item carries dateResolved and
    // dateEvidence but no dateProven, and must not trip the proof validation on a round trip.
    const provenIn = raw.dateProven ?? (raw.dateProvenance === 'caller-proven' ? raw.dateResolved : undefined);
    const resolvedDate = resolveItemDate(dateRaw, { dateProven: provenIn, dateEvidence: raw.dateEvidence, itemRef: (shortcode || 'item') + '#' + items.length });
    const item = {
      category,
      shortcode: shortcode || null,
      carouselIndex,
      mediaType,
      href,
      dateRaw: dateRaw ? String(dateRaw).trim() : null,
      dateParsed: resolvedDate.dateStatus === 'resolved' && resolvedDate.dateProvenance === 'caller-proven' ? resolvedDate.dateParsed : (raw.dateParsed || parseDateText(dateRaw)),
      dateResolved: resolvedDate.dateResolved,
      dateStatus: resolvedDate.dateStatus,
      dateProvenance: resolvedDate.dateProvenance,
      dateEvidence: resolvedDate.dateEvidence,
      captionTruncated: raw.captionTruncated ?? raw.caption ?? null,
      likes: raw.likes != null ? String(raw.likes) : null,
      comments: raw.comments != null ? String(raw.comments) : null,
      permalink: raw.permalink ?? null,
      highlightGroup: raw.highlightGroup ?? options.highlightGroup ?? null,
      identityBasis: shortcode ? 'provider-shortcode' : 'content-sha256'
    };
    item.stableId = shortcode ? stableMediaId(item) : null;
    if (item.stableId && seenStable.has(item.stableId)) continue;
    if (item.stableId) seenStable.add(item.stableId);
    if (shortcode) seenPosts.add(shortcode);
    items.push(item);
  }
  return { items, uniquePostCount: seenPosts.size };
}
// Pending-import dedup contract ----------------------------------------------
// Advisory planner for a pending import batch: it groups byte-identical media by SHA-256 so a
// consumer can upload or register each distinct byte sequence once, while keeping every source
// reference that pointed at it. It performs no I/O and MUST NOT be read as a staging layout --
// the on-disk archive stays one media file and one receipt per stableId, because export names
// ZIP entries from the receipt path and would otherwise emit duplicate entry names. The dedup
// this enables is "do not re-upload bytes we already sent", not "collapse files on disk".
const SHA256_RE = /^[0-9a-f]{64}$/;
// A stable ID becomes a filename downstream, so bare dot segments and a leading dash are refused
// alongside anything outside the safe charset.
const STABLE_ID_RE = /^(?!\.{1,2}$)(?!-)[A-Za-z0-9._-]+$/;
const PENDING_IMPORT_DROPPED_FIELDS = new Set(['href']);
function sanitizeReferenceValue(value) {
  if (typeof value === 'string') return redactSignedUrls(value);
  if (Array.isArray(value)) return value.map(sanitizeReferenceValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, sanitizeReferenceValue(inner)]));
  }
  return value;
}
const SHA_IDENTITY_RE = /(?:^|__)sha256-([0-9a-f]{64})$/;
function pendingImportReference(entry, index) {
  const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  // Preserve every field the caller supplied -- dedup must never be a lossy transform -- minus
  // the signed provider URL, which never reaches persisted or reported JSON anywhere else. Any
  // remaining string is redacted, since a caller may carry a signed URL in another field.
  const preserved = Object.fromEntries(Object.entries(source)
    .filter(([key]) => !PENDING_IMPORT_DROPPED_FIELDS.has(key))
    .map(([key, value]) => [key, sanitizeReferenceValue(value)]));
  return {
    ...preserved,
    sourceIndex: index,
    stableId: String(source.stableId ?? '').trim(),
    sha256: typeof source.sha256 === 'string' ? source.sha256.trim().toLowerCase() : '',
    // Never coerced: an invalid category is reported as a malformed entry, not silently rewritten.
    category: typeof source.category === 'string' ? source.category.trim() : (source.category ?? null),
    identityBasis: source.identityBasis || (source.shortcode ? 'provider-shortcode' : 'content-sha256'),
    ...receiptDateFields(source)
  };
}
function knownBySha(known) {
  const pairs = known instanceof Map ? [...known.entries()] : Object.entries(known && typeof known === 'object' ? known : {});
  const byStableId = new Map();
  const bySha = new Map();
  for (const [stableId, value] of pairs) {
    const sha = typeof value === 'string' ? value.trim().toLowerCase() : (typeof value?.sha256 === 'string' ? value.sha256.trim().toLowerCase() : '');
    // The key becomes canonicalStableId, which a consumer uses as a filename or registry key,
    // so it must clear the same guard as an in-batch id rather than being trusted.
    if (!SHA256_RE.test(sha) || !STABLE_ID_RE.test(String(stableId))) continue;
    byStableId.set(String(stableId), sha);
    if (!bySha.has(sha)) bySha.set(sha, String(stableId));
  }
  return { byStableId, bySha };
}
// Deterministic so a re-run after a partial import produces the same plan: a listing-order
// dependent choice would re-upload the very bytes the previous run deduped.
function chooseCanonical(references, knownStableId) {
  if (knownStableId) return knownStableId;
  const ranked = [...references].sort((a, b) => {
    const aProv = a.identityBasis === 'provider-shortcode' ? 0 : 1;
    const bProv = b.identityBasis === 'provider-shortcode' ? 0 : 1;
    if (aProv !== bProv) return aProv - bProv;
    return a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0;
  });
  return ranked[0].stableId;
}
function planPendingImport(entries, opts = {}) {
  const options = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
  const known = knownBySha(options.known);
  // Array holes would be skipped by forEach while still counting toward length, breaking the
  // reference invariant; Array.from materialises them as undefined so they surface as errors.
  // A non-iterable is a caller bug, not an empty batch.
  let list;
  if (entries == null) list = [];
  else if (Array.isArray(entries)) list = Array.from(entries);
  else if (typeof entries[Symbol.iterator] === 'function') list = [...entries];
  else throw new ArchiveError('BAD_ARGS', 'planPendingImport entries must be an array or iterable');
  const errors = [];
  const accepted = [];
  // Errors are removed before grouping so a malformed entry can never masquerade as a conflict.
  list.forEach((entry, index) => {
    const ref = pendingImportReference(entry, index);
    const reasons = [];
    if (!SHA256_RE.test(ref.sha256)) reasons.push('invalid-sha256');
    if (!ref.stableId) reasons.push('missing-stable-id');
    else if (!STABLE_ID_RE.test(ref.stableId)) reasons.push('unsafe-stable-id');
    const embedded = ref.stableId.match(SHA_IDENTITY_RE);
    if (embedded && SHA256_RE.test(ref.sha256) && embedded[1] !== ref.sha256) reasons.push('stable-id-embeds-different-sha256');
    // A category-prefixed id that disagrees with the entry's own category is a caller bug; ids
    // with no valid category prefix are legacy post ids and are left alone.
    const prefix = ref.stableId.includes('__') ? ref.stableId.slice(0, ref.stableId.indexOf('__')) : null;
    if (prefix && VALID_CATEGORIES.includes(prefix) && prefix !== ref.category) reasons.push('category-disagrees-with-stable-id');
    if (!VALID_CATEGORIES.includes(ref.category)) reasons.push('invalid-category');
    if (reasons.length) errors.push({ sourceIndex: index, reasons, reference: ref });
    else accepted.push(ref);
  });
  // Same stableId claiming two different byte sequences -- inside the batch, or against an
  // already-imported asset. Either way the identity is disputed, so nothing under it is staged.
  const shaByStableId = new Map();
  const conflictedIds = new Map();
  for (const ref of accepted) {
    const priorInBatch = shaByStableId.get(ref.stableId);
    const priorKnown = known.byStableId.get(ref.stableId);
    const prior = priorInBatch || priorKnown;
    if (prior && prior !== ref.sha256) {
      const seen = conflictedIds.get(ref.stableId) || new Set();
      seen.add(prior).add(ref.sha256);
      conflictedIds.set(ref.stableId, seen);
    } else if (!priorInBatch) shaByStableId.set(ref.stableId, ref.sha256);
  }
  const conflicts = [...conflictedIds.entries()]
    .map(([stableId, shas]) => ({ stableId, sha256: [...shas].sort(), knownSha256: known.byStableId.get(stableId) || null }))
    .sort((a, b) => (a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : 0));
  const byShaGroups = new Map();
  for (const ref of accepted) {
    if (!byShaGroups.has(ref.sha256)) byShaGroups.set(ref.sha256, []);
    byShaGroups.get(ref.sha256).push(ref);
  }
  const groups = [...byShaGroups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([sha256, refs]) => {
      const references = [...refs].sort((a, b) => (a.stableId < b.stableId ? -1 : a.stableId > b.stableId ? 1 : a.sourceIndex - b.sourceIndex));
      const disputed = references.some(ref => conflictedIds.has(ref.stableId));
      const knownStableId = known.bySha.get(sha256) || null;
      return {
        sha256,
        status: disputed ? 'conflict' : 'ready',
        canonicalStableId: chooseCanonical(references, disputed ? null : knownStableId),
        alreadyPresent: Boolean(knownStableId),
        knownStableId,
        references,
        stableIds: unique(references.map(ref => ref.stableId)).sort(),
        categories: unique(references.map(ref => ref.category)).sort(),
        referenceCount: references.length
      };
    });
  const staged = groups.filter(group => group.status === 'ready');
  const conflicted = groups.filter(group => group.status === 'conflict');
  const stagedReferences = staged.reduce((sum, group) => sum + group.referenceCount, 0);
  const conflictedReferences = conflicted.reduce((sum, group) => sum + group.referenceCount, 0);
  const alreadyPresent = staged.filter(group => group.alreadyPresent).length;
  return {
    groups,
    staged,
    conflicts,
    errors,
    counts: {
      references: list.length,
      erroredReferences: errors.length,
      stagedReferences,
      conflictedReferences,
      uniqueBytes: staged.length,
      duplicateReferences: stagedReferences - staged.length,
      alreadyPresent,
      newUniqueBytes: staged.length - alreadyPresent,
      conflicts: conflicts.length,
      conflictedUniqueBytes: conflicted.length
    }
  };
}
function validateProviderMediaUrl(raw) {
  let u;
  try { u = new URL(raw, PROVIDER_ORIGIN); } catch { throw new ArchiveError('BAD_URL', 'invalid media URL'); }
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
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile() || st.size !== receipt.bytes) return false;
  const data = await fsp.readFile(file);
  return crypto.createHash('sha256').update(data).digest('hex') === receipt.sha256;
}
async function downloadOne(item, paths, { fetchImpl = globalThis.fetch, maxBytes = DEFAULT_MAX_BYTES, runId, remainingMs = DEFAULT_NETWORK_TIMEOUT_MS, dnsLookup, timeoutMs, completedMap = {}, handle } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1, timeoutMs || remainingMs));
  const tempBase = path.join(paths.mediaDir, (item.stableId || fallbackFailureKey(item, 0)) + '.' + Date.now() + '-' + crypto.randomBytes(8).toString('hex') + '.part');
  try {
    const res = await fetchWithValidatedRedirects(item.href, { fetchImpl, remainingMs, dnsLookup, signal: ac.signal });
    if (!res.ok) throw new ArchiveError('DOWNLOAD_FAILED', 'download failed with HTTP ' + res.status);
    const ct = (headerGet(res, 'content-type') || '').toLowerCase();
    if (ct.includes('text/html')) throw new ArchiveError('BAD_CONTENT', 'provider returned HTML instead of media');
    const declared = Number(headerGet(res, 'content-length') || '0');
    if (declared > maxBytes) throw new ArchiveError('TOO_LARGE', 'content-length exceeds max bytes');
    await ensureSafeDir(paths.mediaDir, paths.root);
    await ensureSafeDir(paths.receiptDir, paths.root);
    const got = await streamResponseToPart(res, tempBase, { maxBytes, signal: ac.signal });
    if (declared && declared !== got.bytes) throw new ArchiveError('BAD_LENGTH', 'content-length mismatch');
    const mediaType = item.mediaType === 'unknown' ? normalizeMediaType(got.kind) : item.mediaType;
    const stableId = item.stableId || stableMediaId(item, got.sha256);
    const ext = extFor(got.kind);
    const dest = path.join(paths.mediaDir, stableId + '.' + ext);
    const existing = completedMap[stableId];
    if (existing && existing.sha256 === got.sha256 && existing.bytes === got.bytes && await verifyReceipt(paths, existing)) {
      await fsp.rm(tempBase, { force: true }).catch(() => {});
      return { receipt: existing, fetchedButReused: true };
    }
    await fsp.rename(tempBase, dest);
    const receipt = {
      stableId,
      id: stableId,
      category: item.category,
      mediaType,
      shortcode: item.shortcode || null,
      carouselIndex: item.carouselIndex || 0,
      identityBasis: item.shortcode ? 'provider-shortcode' : 'content-sha256',
      captionTruncated: item.captionTruncated ?? null,
      permalink: item.permalink ?? null,
      dateRaw: item.dateRaw ?? null,
      dateParsed: item.dateParsed ?? null,
      ...receiptDateFields(item),
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
function decideOutcome({ reportedTotal, uniquePostCount, failed, noGrowth, hitLimit, mode, reusedOnlyComplete = false }) {
  if (reportedTotal == null) return { status: 'ACTION_REQUIRED', reason: 'reported total could not be parsed' };
  if (failed > 0) return { status: 'PARTIAL', reason: failed + ' downloads failed' };
  if (hitLimit) return { status: 'PARTIAL', reason: 'bounded limit reached' };
  if (noGrowth && mode === 'full' && uniquePostCount < reportedTotal) return { status: 'PARTIAL', reason: 'no new cards loaded' };
  if (reportedTotal != null && uniquePostCount < reportedTotal) return { status: 'PARTIAL', reason: 'advertised shortfall ' + uniquePostCount + '/' + reportedTotal };
  return { status: 'COMPLETE', reason: reusedOnlyComplete ? 'all requested media reused from verified receipts' : 'reported total reached and downloads verified' };
}
function sanitizeFailedItem(item, error, index = 0) {
  return {
    stableId: item.stableId || fallbackFailureKey(item, index),
    category: item.category || 'posts',
    shortcode: item.shortcode || null,
    carouselIndex: item.carouselIndex || 0,
    mediaType: item.mediaType || 'unknown',
    identityBasis: item.identityBasis || (item.shortcode ? 'provider-shortcode' : 'content-sha256'),
    error: redactSignedUrls(error)
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
    mediaTypeFilterApplied: section.mediaTypeFilterApplied || DEFAULT_MEDIA_TYPES,
    evidence: section.evidence || {},
    items: section.items || [],
    reportedTotal: section.reportedTotal ?? null,
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
    captionTruncated: item?.captionTruncated ?? null,
    dateRaw: item?.dateRaw ?? null,
    dateParsed: item?.dateParsed ?? null,
    ...receiptDateFields(item),
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
      noGrowth: section.noGrowth,
      hitLimit: section.hitLimit,
      mode,
      reusedOnlyComplete: section.downloadedCount === 0 && section.reusedCount > 0
    });
    return { ...outcome, uniquePostCount: shortcodes.size };
  }
  if (section.failedCount > 0) return { status: 'PARTIAL', reason: section.reason || (section.failedCount + ' items failed') };
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
function finalGlobalOutcome(sections, failedCount) {
  if (sections.some(section => section.status === 'ACTION_REQUIRED')) return { status: 'ACTION_REQUIRED', reason: 'one or more requested sections could not prove completeness' };
  if (sections.every(section => section.status === 'COMPLETE') && failedCount === 0) return { status: 'COMPLETE', reason: 'all requested sections completed and downloads verified' };
  return { status: 'PARTIAL', reason: 'one or more requested sections were partial, unavailable, unsupported, or blocked' };
}
function remainingTimeout(started, maxTimeMs) { return Math.max(1, maxTimeMs - (Date.now() - started)); }
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
    function Probed(callback, options) {
      const observer = new Native(callback, options);
      const nativeObserve = observer.observe.bind(observer);
      observer.observe = function (target) {
        try {
          for (const marked of document.querySelectorAll('[' + attr + ']')) marked.removeAttribute(attr);
          if (target && typeof target.setAttribute === 'function') target.setAttribute(attr, '1');
        } catch { /* marking is best effort; never break the provider's own pagination */ }
        return nativeObserve(target);
      };
      return observer;
    }
    Probed.prototype = Native.prototype;
    window.IntersectionObserver = Probed;
    window.__ffPaginationSentinelProbe = true;
    return true;
  }, PAGINATION_SENTINEL_ATTR);
}
async function scrollLastCardCenterAndWaitForGrowth(page, beforeState, { started, maxTimeMs, growthWaitMs = 15000, settleMs = 1200, recenterEveryMs = 1000, maxRecenters = 3, targetUniqueCount = null } = {}) {
  const waitBudget = Math.max(1, Math.min(growthWaitMs, remainingTimeout(started, maxTimeMs)));
  const deadline = Date.now() + waitBudget;
  let bestState = beforeState;
  let bestCount = beforeState.count || 0;
  let bestIds = new Set(beforeState.ids || []);
  let grew = false;
  let sawLoading = false;
  let lastGrowthAt = 0;
  let nextRecenterAt = 0;
  let recenterCount = 0;
  let sentinel = null;
  // The provider hangs its pagination IntersectionObserver (rootMargin 200px) on the TOP-LEVEL
  // card of the last post, then appends that post's carousel slides as sibling .post-cards
  // after it. Centering the final DOM card parks the real sentinel several card heights above
  // the viewport, outside the observer's margin, and pagination stalls with no growth.
  //
  // installPaginationSentinelProbe marks whichever element the provider is actually observing,
  // which is authoritative and needs no inference from card markup. The two heuristics below it
  // are fail-closed fallbacks for pages where the probe was never installed (a caller driving
  // this function directly, or an attached page navigated outside our control).
  async function recenterPaginationSentinel() {
    const found = await page.evaluate(attr => {
      const scroll = el => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
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
    }, PAGINATION_SENTINEL_ATTR);
    if (!found) return false;
    sentinel = found;
    return true;
  }
  if (!await recenterPaginationSentinel()) return { ...beforeState, grew: false, waitedMs: 0, recenterCount: 0, sentinelIndex: null, sentinelId: null, sentinelSource: null };
  recenterCount++;
  nextRecenterAt = Date.now() + recenterEveryMs;
  while (Date.now() < deadline && Date.now() - started < maxTimeMs) {
    const now = Date.now();
    if (now >= nextRecenterAt && recenterCount < maxRecenters) {
      if (await recenterPaginationSentinel()) recenterCount++;
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
      bestCount = Math.max(bestCount, state.count);
      bestIds = stateIds;
      if (targetUniqueCount && bestIds.size >= targetUniqueCount) return { ...state, grew: true, sawLoading, waitedMs: waitBudget - Math.max(0, deadline - Date.now()), recenterCount, ...sentinel };
    }
    if (grew && loading === 0 && Date.now() - lastGrowthAt >= settleMs) {
      const finalState = await getRenderedCardState(page);
      return { ...finalState, grew: true, sawLoading, waitedMs: waitBudget - Math.max(0, deadline - Date.now()), recenterCount, ...sentinel };
    }
    await page.waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  const finalState = await getRenderedCardState(page);
  return { ...finalState, grew, sawLoading, waitedMs: waitBudget, recenterCount, ...sentinel };
}
async function cleanupScrapeBrowser(page, browser) {
  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
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
async function switchToCategoryTab(page, category, timeoutMs) {
  const upper = category.toUpperCase();
  const tab = page.locator('#menu-wrapper .menu-item[data-id="' + upper + '"]').first();
  if (await tab.count() === 0) return { tabPresent: false };
  const active = await tab.evaluate(el => el.classList.contains('active')).catch(() => false);
  if (!active) await tab.click({ timeout: timeoutMs });
  await page.waitForTimeout(Math.min(250, Math.max(1, timeoutMs)));
  return { tabPresent: true };
}
async function waitForSectionReady(page, category, started, maxTimeMs) {
  const deadline = Date.now() + Math.min(8000, remainingTimeout(started, maxTimeMs));
  while (Date.now() < deadline) {
    const err = await extractSectionError(page);
    if (err) return { kind: 'error', ...err };
    if (category === 'highlights') {
      const count = await page.locator('#highlights-container .highlight').count().catch(() => 0);
      if (count > 0) return { kind: 'highlights' };
    }
    const cards = await page.locator('#post-container .post-card').count().catch(() => 0);
    if (cards > 0) return { kind: 'cards' };
    await page.waitForTimeout(Math.min(200, Math.max(1, remainingTimeout(started, maxTimeMs))));
  }
  return { kind: 'empty' };
}
async function extractItemsFromPage(page, maybeOptions = {}, maybeFlags = {}) {
  let options = {};
  if (typeof maybeOptions === 'number') options = { reportedTotal: maybeOptions, ...maybeFlags };
  else options = maybeOptions || {};
  const raw = await page.locator('#post-container .post-card').evaluateAll(cards => cards.map(card => {
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
  const norm = normalizeItems(raw, { category: options.category || 'posts', mediaTypes: options.mediaTypes || DEFAULT_MEDIA_TYPES, highlightGroup: options.highlightGroup || null });
  return { items: norm.items, reportedTotal: options.reportedTotal ?? null, uniquePostCount: norm.uniquePostCount, noGrowth: !!options.noGrowth, hitLimit: !!options.hitLimit };
}
async function scrapeCardSection(page, { category, mediaTypes, reportedTotal, started, maxTimeMs, maxPages }) {
  let noGrowth = false;
  let hitLimit = false;
  let exhaustedPageBudget = maxPages <= 0;
  for (let i = 0; i < maxPages; i++) {
    const before = await getRenderedCardState(page);
    if (before.count === 0) { exhaustedPageBudget = false; break; }
    if (reportedTotal && before.ids.length >= reportedTotal) { exhaustedPageBudget = false; break; }
    if (Date.now() - started >= maxTimeMs) { hitLimit = true; break; }
    const after = await scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs, targetUniqueCount: reportedTotal });
    if (Date.now() - started >= maxTimeMs) { hitLimit = true; break; }
    if (!after.grew) { noGrowth = true; break; }
    exhaustedPageBudget = i === maxPages - 1;
  }
  if (exhaustedPageBudget && !noGrowth) hitLimit = true;
  const extracted = await extractItemsFromPage(page, { category, mediaTypes, reportedTotal, noGrowth, hitLimit });
  const itemCount = extracted.items.length;
  let status = itemCount ? 'COMPLETE' : 'UNAVAILABLE';
  let reason = itemCount ? 'visible section extracted' : 'no visible cards in section';
  if (category === 'posts' && reportedTotal == null) {
    status = 'ACTION_REQUIRED';
    reason = 'reported total could not be parsed';
  } else if (hitLimit) {
    status = 'PARTIAL';
    reason = 'bounded limit reached before section settled';
  } else if (!itemCount && noGrowth) {
    status = 'UNAVAILABLE';
    reason = 'provider showed no cards for the selected section';
  }
  return makeSectionRecord({ category, status, reason, tabPresent: true, itemCount, mediaTypeFilterApplied: mediaTypes, evidence: { source: '#post-container .post-card' }, items: extracted.items, reportedTotal, noGrowth, hitLimit, uniquePostCount: extracted.uniquePostCount ?? null });
}
async function scrapeHighlightsSection(page, { mediaTypes, started, maxTimeMs }) {
  const tiles = page.locator('#highlights-container .highlight');
  const count = await tiles.count().catch(() => 0);
  if (!count) return makeSectionRecord({ category: 'highlights', status: 'UNAVAILABLE', reason: 'provider exposed no highlight groups', tabPresent: true, itemCount: 0, mediaTypeFilterApplied: mediaTypes, evidence: { source: '#highlights-container .highlight' }, items: [] });
  const allItems = [];
  for (let i = 0; i < count; i++) {
    const title = await tiles.nth(i).locator('span').first().innerText().catch(() => '') || 'highlight-' + (i + 1);
    await tiles.nth(i).click({ timeout: remainingTimeout(started, maxTimeMs) });
    const ready = await waitForSectionReady(page, 'stories', started, maxTimeMs);
    if (ready.kind === 'error') continue;
    const extracted = await extractItemsFromPage(page, { category: 'highlights', mediaTypes, highlightGroup: title });
    allItems.push(...extracted.items);
  }
  return makeSectionRecord({ category: 'highlights', status: allItems.length ? 'COMPLETE' : 'UNAVAILABLE', reason: allItems.length ? 'highlight groups extracted from visible UI' : 'highlight groups had no visible stories', tabPresent: true, itemCount: allItems.length, mediaTypeFilterApplied: mediaTypes, evidence: { source: '#highlights-container .highlight + #post-container .post-card' }, items: allItems });
}
async function scrapeWithPlaywright({ handle, maxPages, maxTimeMs, browserExecutable, browserChannel, attachCdp, categories = DEFAULT_CATEGORIES, mediaTypes = DEFAULT_MEDIA_TYPES }) {
  if (attachCdp) {
    const u = new URL(attachCdp);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) throw new ArchiveError('BAD_CDP', 'CDP attach must be explicit loopback http://127.0.0.1:<port>');
  }
  const { chromium } = await require('playwright');
  let browser, page;
  const started = Date.now();
  try {
    if (attachCdp) { browser = await chromium.connectOverCDP(attachCdp, { timeout: remainingTimeout(started, maxTimeMs) }); page = await browser.newPage(); }
    else { browser = await chromium.launch({ headless: true, executablePath: browserExecutable, channel: browserChannel, timeout: remainingTimeout(started, maxTimeMs) }); page = await browser.newPage(); }
    page.setDefaultTimeout(remainingTimeout(started, maxTimeMs));
    await page.goto(PROVIDER_PHOTO_URL, { waitUntil: 'domcontentloaded', timeout: remainingTimeout(started, maxTimeMs) });
    // Must run after navigation and before the search click: the provider only builds its
    // pagination observer once results render, so this is the last safe moment to wrap it.
    await installPaginationSentinelProbe(page).catch(() => false);
    await page.fill('input#search-input', handle, { timeout: remainingTimeout(started, maxTimeMs) });
    await page.click('button#download-btn', { timeout: remainingTimeout(started, maxTimeMs) });
    await page.waitForTimeout(Math.min(500, remainingTimeout(started, maxTimeMs)));
    const profile = await extractProfileFromPage(page, handle);
    const sections = [];
    for (const category of categories) {
      const tab = await switchToCategoryTab(page, category, remainingTimeout(started, maxTimeMs));
      if (!tab.tabPresent) {
        sections.push(makeSectionRecord({ category, status: 'UNAVAILABLE', reason: 'provider did not expose a ' + category + ' tab', tabPresent: false, itemCount: 0, mediaTypeFilterApplied: mediaTypes, evidence: { selector: '#menu-wrapper .menu-item[data-id="' + category.toUpperCase() + '"]' }, items: [] }));
        continue;
      }
      const ready = await waitForSectionReady(page, category, started, maxTimeMs);
      if (ready.kind === 'error') {
        sections.push(makeSectionRecord({ category, status: ready.status, reason: ready.reason, tabPresent: true, itemCount: 0, mediaTypeFilterApplied: mediaTypes, evidence: { source: 'provider error state' }, items: [] }));
        continue;
      }
      if (ready.kind === 'empty') {
        sections.push(makeSectionRecord({ category, status: 'UNAVAILABLE', reason: 'provider exposed no visible content for selected tab', tabPresent: true, itemCount: 0, mediaTypeFilterApplied: mediaTypes, evidence: { source: 'empty visible UI' }, items: [] }));
        continue;
      }
      if (category === 'highlights') sections.push(await scrapeHighlightsSection(page, { mediaTypes, started, maxTimeMs }));
      else sections.push(await scrapeCardSection(page, { category, mediaTypes, reportedTotal: category === 'posts' ? profile.reportedPostCount : null, started, maxTimeMs, maxPages }));
    }
    return { profile, sections };
  } finally {
    await cleanupScrapeBrowser(page, browser);
  }
}
async function archiveProfile(opts = {}) {
  const handle = validateHandle(opts.handle);
  const mode = opts.mode || 'full';
  if (!['full', 'sync'].includes(mode)) throw new ArchiveError('BAD_MODE', 'mode must be full or sync');
  const categories = parseCategories(opts.categories);
  const mediaTypes = parseMediaTypes(opts.mediaTypes);
  const root = await safeOutputRoot(opts.output);
  const paths = profilePaths(root, handle);
  const runId = Date.now() + '-' + crypto.randomUUID();
  const started = Date.now();
  const maxTimeMs = opts.maxTimeMs || DEFAULT_MAX_TIME_MS;
  await ensureSafeDir(paths.stateDir, paths.root);
  await ensureSafeDir(paths.mediaDir, paths.root);
  await ensureSafeDir(paths.receiptDir, paths.root);
  return withLock(paths, runId, async () => {
    const prior = await readJson(paths.manifest, { version: 2, handle, completed: {}, failed: {}, runs: [], sections: [], requestedCategories: DEFAULT_CATEGORIES, mediaTypes: DEFAULT_MEDIA_TYPES });
    await writeStatus(paths, { status: 'RUNNING', reason: 'scan started', runId, handle, mode, requestedCategories: categories, mediaTypes, startedAt: new Date().toISOString(), priorCompletedCount: Object.keys(prior.completed || {}).length });
    let scan;
    try {
      if (opts.sections) scan = { profile: opts.profile || null, sections: normalizeProvidedSections(opts.sections, mediaTypes) };
      else if (opts.items) scan = legacyScanFromItems({ ...opts, category: categories[0] || 'posts', mediaTypes });
      else scan = await scrapeWithPlaywright({ handle, maxPages: opts.maxPages || 12, maxTimeMs, browserExecutable: opts.browserExecutable, browserChannel: opts.browserChannel, attachCdp: opts.attachCdp, categories, mediaTypes });
    } catch (err) {
      const status = { status: err instanceof DeferredError ? 'DEFERRED' : 'ACTION_REQUIRED', reason: redactSignedUrls(err.message), retryAt: err.retryAt, runId, handle, mode, requestedCategories: categories, mediaTypes, updatedAt: new Date().toISOString(), priorCompletedCount: Object.keys(prior.completed || {}).length };
      await writeStatus(paths, status);
      throw err;
    }
    const completed = { ...(prior.completed || {}) };
    const failed = {};
    const freshKeys = new Set();
    const finalSections = [];
    let downloaded = 0;
    let reused = 0;
    let failedCount = 0;
    for (const sectionInput of scan.sections) {
      const section = makeSectionRecord({ ...sectionInput, mediaTypeFilterApplied: mediaTypes });
      if (!['COMPLETE', 'PARTIAL'].includes(section.status) && (!section.items || !section.items.length)) {
        finalSections.push(section);
        continue;
      }
      section.downloadedCount = 0;
      section.reusedCount = 0;
      section.failedCount = 0;
      const items = section.items || [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const failureKey = item.stableId || fallbackFailureKey(item, i);
        freshKeys.add(failureKey);
        if (Date.now() - started > maxTimeMs) {
          section.failedCount++;
          failedCount++;
          failed[failureKey] = sanitizeFailedItem(item, 'time budget reached', i);
          continue;
        }
        if (item.stableId && completed[item.stableId] && await verifyReceipt(paths, completed[item.stableId])) {
          reused++;
          section.reusedCount++;
          delete failed[failureKey];
          delete failed[item.stableId];
          continue;
        }
        if (!item.href) {
          section.failedCount++;
          failedCount++;
          failed[failureKey] = sanitizeFailedItem(item, 'missing media href', i);
          continue;
        }
        try {
          const result = await downloadOne(item, paths, { fetchImpl: opts.fetchImpl, maxBytes: opts.maxBytes || DEFAULT_MAX_BYTES, runId, remainingMs: Math.max(1, maxTimeMs - (Date.now() - started)), dnsLookup: opts.dnsLookup, timeoutMs: Math.min(opts.networkTimeoutMs || DEFAULT_NETWORK_TIMEOUT_MS, Math.max(1, maxTimeMs - (Date.now() - started))), completedMap: completed, handle });
          completed[result.receipt.stableId] = result.receipt;
          delete failed[failureKey];
          delete failed[result.receipt.stableId];
          if (result.fetchedButReused) { reused++; section.reusedCount++; }
          else { downloaded++; section.downloadedCount++; }
          if ((opts.delayMs ?? DEFAULT_DELAY_MS) && Math.max(0, maxTimeMs - (Date.now() - started)) > 0) await delay(Math.min(opts.delayMs ?? DEFAULT_DELAY_MS, 5000, Math.max(1, maxTimeMs - (Date.now() - started))));
        } catch (err) {
          if (err instanceof DeferredError) {
            for (const [sid, oldFail] of Object.entries(prior.failed || {})) if (!freshKeys.has(sid) && !failed[sid]) failed[sid] = sanitizeFailedItem(oldFail, 'pending fresh scan retry');
            const manifest = { version: 2, handle, updatedAt: new Date().toISOString(), requestedCategories: categories, mediaTypes, profile: publicProfile(scan.profile), sections: finalSections.map(statusSectionRecord), completed, failed, runs: [...(prior.runs || []), { runId, mode, status: 'DEFERRED', completedCount: Object.keys(completed).length, failedCount }] };
            await atomicWriteJson(paths.manifest, manifest);
            await writeStatus(paths, { status: 'DEFERRED', reason: redactSignedUrls(err.message), retryAt: err.retryAt, runId, handle, mode, requestedCategories: categories, mediaTypes, sections: finalSections.map(statusSectionRecord), downloadedCount: downloaded, reusedCount: reused, completedCount: Object.keys(completed).length, failedCount: Object.keys(failed).length, updatedAt: new Date().toISOString() });
            throw err;
          }
          section.failedCount++;
          failedCount++;
          failed[failureKey] = sanitizeFailedItem(item, err.message, i);
        }
      }
      const settled = sectionOutcomeForCompleted(section, Object.values(completed), { mode });
      section.status = settled.status;
      section.reason = settled.reason;
      if (settled.uniquePostCount != null) section.uniquePostCount = settled.uniquePostCount;
      finalSections.push(section);
    }
    for (const [sid, oldFail] of Object.entries(prior.failed || {})) if (!freshKeys.has(sid) && !failed[sid]) failed[sid] = sanitizeFailedItem(oldFail, 'pending fresh scan retry');
    const global = finalGlobalOutcome(finalSections, failedCount);
    const postSection = finalSections.find(section => section.category === 'posts');
    const uniquePostCount = new Set(Object.values(completed).filter(receipt => receiptCategory(receipt) === 'posts' && receiptShortcode(receipt)).map(receipt => receiptShortcode(receipt))).size;
    const manifest = {
      version: 2,
      handle,
      updatedAt: new Date().toISOString(),
      requestedCategories: categories,
      mediaTypes,
      profile: publicProfile(scan.profile),
      sections: finalSections.map(statusSectionRecord),
      completed,
      failed,
      runs: [...(prior.runs || []), { runId, mode, status: global.status, completedCount: Object.keys(completed).length, failedCount, downloadedCount: downloaded, reusedCount: reused }]
    };
    await atomicWriteJson(paths.manifest, manifest);
    return writeStatus(paths, {
      status: global.status,
      reason: global.reason,
      runId,
      handle,
      mode,
      requestedCategories: categories,
      mediaTypes,
      sections: finalSections.map(statusSectionRecord),
      uniquePostCount,
      reportedTotal: postSection?.reportedTotal ?? null,
      completedCount: Object.keys(completed).length,
      failedCount,
      downloadedCount: downloaded,
      reusedCount: reused,
      updatedAt: new Date().toISOString()
    });
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
    ...receiptDateFields(receipt),
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
    const publicReceipt = { ...receipt, category: receiptCategory(receipt), identityBasis: receiptIdentityBasis(receipt), ...receiptDateFields(receipt) };
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
  return await readJson(paths.status, { status: 'ACTION_REQUIRED', reason: 'no status exists yet', handle });
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
  resolveItemDate,
  requireCaptureTimestamp,
  receiptDateFields,
  normalizeItems,
  parseReportedTotal,
  planPendingImport,
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
  scrollLastCardCenterAndWaitForGrowth,
  scrapeWithPlaywright,
  extractReportedTotalFromPage,
  extractItemsFromPage,
  cleanupScrapeBrowser,
  statusProfile,
  doctor,
  parseCategories,
  parseMediaTypes
};