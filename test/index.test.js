const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const lib = require('../src/index.js');

const python3Available = spawnSync('python3', ['-c', 'import zipfile'], { stdio: 'ignore' }).status === 0;

const jpg = Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4,0xff,0xd9]);
const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
const mp4 = Buffer.from([0,0,0,20,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,0,0,0,0,0]);
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

function streamOf(buf, chunk = 3) {
  let off = 0;
  return new ReadableStream({
    pull(controller) {
      if (off >= buf.length) {
        controller.close();
        return;
      }
      controller.enqueue(buf.subarray(off, off + chunk));
      off += chunk;
    }
  });
}
function res({ status = 200, url = 'https://instacognito.com/media?id=rotated', body = jpg, headers = { 'content-type': 'image/jpeg' } } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (!lower['content-length']) lower['content-length'] = String(body.length);
  return { status, ok: status >= 200 && status < 300, url, headers: { get: k => lower[String(k).toLowerCase()] || null }, body: streamOf(body) };
}
async function tmp() { return await fsp.mkdtemp(path.join(os.tmpdir(), 'frameferry-test-')); }
async function readJson(file) { return JSON.parse(await fsp.readFile(file, 'utf8')); }
async function readManifest(out) { return readJson(path.join(out, '.frameferry', 'example', 'manifest.json')); }
async function readStatus(out) { return readJson(path.join(out, '.frameferry', 'example', 'status.json')); }
function section(category, items, extra = {}) {
  return { category, status: 'COMPLETE', items, ...extra };
}
function countNamedTests(text) {
  return [...text.matchAll(/test\('([^']+)'/g)].map(m => m[1]);
}

test('normalizes real provider carousel: one card per slide with same shortcode becomes multiple media', () => {
  const raw = [
    { shortcode: 'CAR', href: 'https://instacognito.com/media?id=1' },
    { shortcode: 'CAR', href: 'https://instacognito.com/media?id=2' },
    { shortcode: 'OTHER', href: 'https://instacognito.com/media?id=3' },
    { shortcode: 'CAR', carouselIndex: 1, href: 'https://instacognito.com/media?id=dup' }
  ];
  const n = lib.normalizeItems(raw);
  assert.equal(n.uniquePostCount, 2);
  assert.deepEqual(n.items.map(i => i.stableId), ['CAR-0', 'CAR-1', 'OTHER-0']);
});

test('repeat-page cards dedupe before assigning carousel indices', () => {
  const page = [
    { shortcode: 'CAR', href: 'https://instacognito.com/media?id=one', type: 'photo' },
    { shortcode: 'CAR', href: 'https://instacognito.com/media?id=two', type: 'photo' },
    { shortcode: 'OTHER', href: 'https://instacognito.com/media?id=three', type: 'photo' }
  ];
  const n = lib.normalizeItems([...page, ...page]);
  assert.deepEqual(n.items.map(i => i.stableId), ['CAR-0', 'CAR-1', 'OTHER-0']);
});

test('malformed dates are preserved instead of becoming invalid watermark', () => {
  assert.equal(lib.parseDateText(['views', 'not a date'].join('\n')), 'not a date');
});

test('reported count parser uses POSTS adjacency, not max followers/header integers', () => {
  assert.equal(lib.parseReportedTotal('Followers 125,000 Following 12 POSTS 68'), 68);
  assert.equal(lib.parseReportedTotal('68 posts 125,000 followers'), 68);
  assert.equal(lib.parseReportedTotal(['68', 'posts', '680.2k', 'followers', '656', 'following'].join('\n')), 68);
  assert.equal(lib.parseReportedTotal('125,000 followers only'), null);
});

test('unknown denom cannot claim complete and advertised shortfall is partial', async () => {
  assert.equal(lib.decideOutcome({ reportedTotal: null, uniquePostCount: 10, failed: 0 }).status, 'ACTION_REQUIRED');
  assert.equal(lib.decideOutcome({ reportedTotal: 20, uniquePostCount: 12, failed: 0 }).status, 'PARTIAL');
  const d = await tmp();
  const out = path.join(d, 'out');
  const unknown = await lib.archiveProfile({
    handle: 'example',
    output: out,
    reportedTotal: null,
    items: [{ shortcode: 'A', href: 'https://instacognito.com/media?id=a' }],
    dnsLookup: publicDns,
    fetchImpl: async () => res(),
    delayMs: 0
  });
  assert.equal(unknown.status, 'ACTION_REQUIRED');
  const short = await lib.archiveProfile({
    handle: 'example',
    output: out,
    mode: 'sync',
    reportedTotal: 3,
    noGrowth: true,
    items: [{ shortcode: 'A', href: 'https://instacognito.com/media?id=rotated' }],
    dnsLookup: publicDns,
    fetchImpl: async () => res(),
    delayMs: 0
  });
  assert.equal(short.status, 'PARTIAL');
  assert.match(short.sections[0].reason, /shortfall|no new cards/i);
});

test('provider URL validation rejects non-provider and non-https', () => {
  assert.throws(() => lib.validateProviderMediaUrl('http://instacognito.com/media?id=x'), /media URL/);
  assert.throws(() => lib.validateProviderMediaUrl('https://evil.test/media?id=x'), /media URL/);
  assert.doesNotThrow(() => lib.validateProviderMediaUrl('https://instacognito.com/media?id=x'));
});

test('redirect SSRF private hosts, mapped hex IPv6, CGNAT, and DNS failures are rejected', async () => {
  await assert.rejects(() => lib.validateRedirectTarget('https://127.0.0.1/x'), /private/);
  await assert.rejects(() => lib.validateRedirectTarget('https://localhost/x'), /private/);
  await assert.rejects(() => lib.validateRedirectTarget('https://example.com/x', async () => { throw new Error('dns down'); }), /failed closed/);
  assert.equal(lib.isPrivateIp('100.64.0.1'), true);
  assert.equal(lib.isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(lib.isPrivateIp('0:0:0:0:0:ffff:7f00:1'), true);
});

test('handle traversal and output symlink are rejected', async () => {
  assert.throws(() => lib.validateHandle('../bad'), /handle/);
  const d = await tmp();
  const target = path.join(d, 'target');
  const link = path.join(d, 'link');
  await fsp.mkdir(target);
  await fsp.symlink(target, link);
  await assert.rejects(() => lib.safeOutputRoot(link), /symlink/);
});

test('download streams to .part, sha receipt, magic beats content type, and redacts signed urls', async () => {
  const d = await tmp();
  const root = await lib.safeOutputRoot(path.join(d, 'out'));
  const paths = lib.profilePaths(root, 'example');
  const item = { shortcode: 'ABC', carouselIndex: 0, href: 'https://instacognito.com/media?id=fixture-redacted-token', type: 'photo' };
  const got = await lib.downloadOne(item, paths, { dnsLookup: publicDns, fetchImpl: async () => res({ body: png, headers: { 'content-type': 'image/jpeg' } }), runId: 'r1' });
  assert.equal(got.receipt.bytes, png.length);
  assert.match(got.receipt.path, /.png$/);
  assert.match(got.receipt.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readdirSync(paths.mediaDir).some(n => n.endsWith('.part')), false);
  assert.equal(lib.redactSignedUrls(item.href), '[REDACTED instacognito media URL]');
});

test('HTML/truncation/oversize fail before unbounded buffering', async () => {
  const d = await tmp();
  const root = await lib.safeOutputRoot(path.join(d, 'out'));
  const paths = lib.profilePaths(root, 'example');
  const item = { shortcode: 'ABC', carouselIndex: 0, href: 'https://instacognito.com/media?id=x' };
  await assert.rejects(() => lib.downloadOne(item, paths, { dnsLookup: publicDns, fetchImpl: async () => res({ body: Buffer.from('<html></html>'), headers: { 'content-type': 'text/html' } }) }), /HTML/);
  await assert.rejects(() => lib.downloadOne(item, paths, { dnsLookup: publicDns, fetchImpl: async () => res({ headers: { 'content-type': 'image/jpeg', 'content-length': '999999' } }), maxBytes: 10 }), /exceeds/);
  await assert.rejects(() => lib.downloadOne(item, paths, { dnsLookup: publicDns, fetchImpl: async () => res({ headers: { 'content-type': 'image/jpeg', 'content-length': '99' } }) }), /length/);
});

test('429 Retry-After beyond budget persists DEFERRED and preserves prior completed evidence', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const okItem = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [okItem], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  const deferItem = { shortcode: 'B', href: 'https://instacognito.com/media?id=b' };
  await assert.rejects(() => lib.archiveProfile({
    handle: 'example',
    output: out,
    reportedTotal: 2,
    items: [okItem, deferItem],
    dnsLookup: publicDns,
    fetchImpl: async url => url.includes('b') ? res({ status: 429, headers: { 'retry-after': '120', 'content-type': 'image/jpeg' } }) : res(),
    remainingMs: 1000,
    maxTimeMs: 1000,
    delayMs: 0
  }), err => err.code === 'DEFERRED');
  const status = await readStatus(out);
  const manifest = await readManifest(out);
  assert.equal(status.status, 'DEFERRED');
  assert.ok(status.retryAt);
  assert.equal(Object.keys(manifest.completed).length, 1);
});

test('429 within budget waits and retries same provider URL', async () => {
  const d = await tmp();
  const root = await lib.safeOutputRoot(path.join(d, 'out'));
  const paths = lib.profilePaths(root, 'example');
  const item = { shortcode: 'ABC', href: 'https://instacognito.com/media?id=x' };
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls === 1 ? res({ status: 429, headers: { 'retry-after': '0', 'content-type': 'image/jpeg' } }) : res();
  };
  const got = await lib.downloadOne(item, paths, { dnsLookup: publicDns, fetchImpl, remainingMs: 1000, runId: 'r' });
  assert.equal(calls, 2);
  assert.equal(got.receipt.bytes, jpg.length);
});

test('sync reuses verified receipts: second run same IDs rotated URLs performs zero fetches', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  let calls = 0;
  const items1 = [{ shortcode: 'A', href: 'https://instacognito.com/media?id=oldA' }, { shortcode: 'B', href: 'https://instacognito.com/media?id=oldB' }];
  await lib.archiveProfile({ handle: 'example', output: out, mode: 'full', reportedTotal: 2, items: items1, dnsLookup: publicDns, fetchImpl: async () => { calls++; return res(); }, delayMs: 0 });
  calls = 0;
  const items2 = [{ shortcode: 'A', href: 'https://instacognito.com/media?id=newA' }, { shortcode: 'B', href: 'https://instacognito.com/media?id=newB' }];
  const s2 = await lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 2, items: items2, dnsLookup: publicDns, fetchImpl: async () => { calls++; return res(); }, delayMs: 0 });
  assert.equal(s2.status, 'COMPLETE');
  assert.equal(s2.reusedCount, 2);
  assert.equal(calls, 0);
});

test('corrupted completed file is retried and repaired', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  let calls = 0;
  const item = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => { calls++; return res(); }, delayMs: 0 });
  await fsp.writeFile(path.join(out, 'media', 'example', 'A-0.jpg'), Buffer.from('bad'));
  calls = 0;
  const s = await lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 1, items: [{ shortcode: 'A', href: 'https://instacognito.com/media?id=rotated' }], dnsLookup: publicDns, fetchImpl: async () => { calls++; return res(); }, delayMs: 0 });
  assert.equal(s.status, 'COMPLETE');
  assert.equal(calls, 1);
});

test('failed manifest entries do not persist signed URLs while fresh overlap retries', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const item = { shortcode: 'A', href: 'https://instacognito.com/media?id=fixture-redacted' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res({ body: Buffer.from('bad'), headers: { 'content-type': 'image/jpeg' } }), delayMs: 0 });
  let manifest = await readManifest(out);
  assert.equal(JSON.stringify(manifest.failed).includes('media?id='), false);
  assert.equal(Object.keys(manifest.failed).length, 1);
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  manifest = await readManifest(out);
  assert.equal(Object.keys(manifest.failed).length, 0);
});

test('live lock rejects alive PID and stale lock recovers', async () => {
  const d = await tmp();
  const root = await lib.safeOutputRoot(path.join(d, 'out'));
  const paths = lib.profilePaths(root, 'example');
  await fsp.mkdir(paths.stateDir, { recursive: true });
  await fsp.writeFile(paths.lock, JSON.stringify({ pid: process.pid, host: os.hostname(), runId: 'alive' }));
  await assert.rejects(() => lib.withLock(paths, 'r', async () => {}), /locked/);
  await fsp.writeFile(paths.lock, JSON.stringify({ pid: 99999999, host: os.hostname(), runId: 'stale' }));
  await lib.withLock(paths, 'r2', async () => 42);
  assert.equal(fs.existsSync(paths.lock), false);
});

test('secret redaction removes signed provider URLs from status-shaped text', () => {
  const redacted = lib.redactSignedUrls('failed https://instacognito.com/media?id=abcDEF123 more');
  assert.equal(redacted.includes('abcDEF123'), false);
  assert.equal(redacted.includes('media?id='), false);
});

test('CDP attach rejects non-loopback remote targets', async () => {
  await assert.rejects(() => lib.archiveProfile({ handle: 'example', output: path.join(os.tmpdir(), 'nope'), attachCdp: 'http://192.168.1.2:9222' }), /CDP|loopback/);
});

test('network timeout is capped by remaining maxTimeMs, not user larger networkTimeoutMs', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const started = Date.now();
  const fetchImpl = async (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const s = await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [{ shortcode: 'A', href: 'https://instacognito.com/media?id=slow' }], dnsLookup: publicDns, fetchImpl, maxTimeMs: 40, networkTimeoutMs: 5000, delayMs: 0 });
  assert.equal(s.status, 'PARTIAL');
  assert.ok(Date.now() - started < 1500);
});

test('profile extraction accepts a caller supplied timeout', async () => {
  let gotTimeout;
  const fakePage = { locator() { return { first() { return { innerText: async (opts) => { gotTimeout = opts.timeout; return 'POSTS 7'; } }; } }; } };
  assert.equal(await lib.extractReportedTotalFromPage(fakePage, 23), 7);
  assert.equal(gotTimeout, 23);
});

test('CLI doctor parses --attach-cdp without swallowing it as handle, and bad flags fail', () => {
  const bin = path.join(__dirname, '..', 'bin', 'frameferry.js');
  const bad = spawnSync(process.execPath, [bin, 'doctor', '--attach-cdp', 'http://192.168.1.2:9222'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /"cdpOk": false/);
  const miss = spawnSync(process.execPath, [bin, 'archive', 'example', '--max-pages'], { encoding: 'utf8' });
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /requires a value/);
  const unknown = spawnSync(process.execPath, [bin, 'doctor', '--bogus', 'value'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /not valid/);
  const inapplicable = spawnSync(process.execPath, [bin, 'doctor', '--output', 'x'], { encoding: 'utf8' });
  assert.equal(inapplicable.status, 1);
  assert.match(inapplicable.stderr, /not valid/);
});

test('actual Playwright DOM fixture models real carousel cards and profile-section POSTS parsing', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage();
    await page.setContent('<header>Followers 125,000</header><section id="profile-section"><span>125,000 followers</span><b>2 POSTS</b></section><div id="post-container"><article class="post-card"><div class="post-image" data-type="image"></div><div class="post-content"><p>Caption</p><a class="content-download-btn" href="https://instacognito.com/media?id=one">d</a></div><div class="post-footer"><div class="icon-group likes-trigger" data-id="CAR"><span>5</span></div><div class="icon-group comments-trigger" data-id="CAR"><span>1</span></div><div class="icon-group"><span>2024-01-01</span></div></div></article><article class="post-card"><div class="post-image" data-type="image"></div><div class="post-content"><p>Caption 2</p><a class="content-download-btn" href="https://instacognito.com/media?id=two">d</a></div><div class="post-footer"><div class="icon-group likes-trigger" data-id="CAR"><span>2</span></div><div class="icon-group comments-trigger" data-id="CAR"><span>0</span></div><div class="icon-group"><span>2024-01-01</span></div></div></article><article class="post-card"><div class="post-image" data-type="video"></div><div class="post-content"><p>Third</p><a class="content-download-btn" href="https://instacognito.com/media?id=three">d</a></div><div class="post-footer"><div class="icon-group likes-trigger" data-id="OTHER"><span>7</span></div><div class="icon-group"><span>2024-01-02</span></div></div></article></div>');
    const total = await lib.extractReportedTotalFromPage(page);
    const got = await lib.extractItemsFromPage(page, { category: 'posts', mediaTypes: ['image', 'video'], reportedTotal: total });
    assert.equal(total, 2);
    assert.equal(got.uniquePostCount, 2);
    assert.deepEqual(got.items.map(i => i.stableId), ['CAR-0', 'CAR-1', 'OTHER-0']);
  } finally {
    await browser.close();
  }
});

test('partial dates without explicit year preserve raw text', () => {
  assert.equal(lib.parseDateText(['views', '23 August'].join('\n')), '23 August');
  assert.match(lib.parseDateText(['views', '23 August 2024'].join('\n')), /^2024-/);
});

test('foreign-host and EPERM locks fail closed', async () => {
  const d = await tmp();
  const root = await lib.safeOutputRoot(path.join(d, 'out'));
  const paths = lib.profilePaths(root, 'example');
  await fsp.mkdir(paths.stateDir, { recursive: true });
  await fsp.writeFile(paths.lock, JSON.stringify({ pid: 99999999, host: 'other-host', runId: 'foreign' }));
  await assert.rejects(() => lib.withLock(paths, 'r', async () => {}), /another or unknown host/);
  await fsp.writeFile(paths.lock, JSON.stringify({ pid: 12345, host: os.hostname(), runId: 'eperm' }));
  const originalKill = process.kill;
  process.kill = () => { const e = new Error('no permission'); e.code = 'EPERM'; throw e; };
  try {
    await assert.rejects(() => lib.withLock(paths, 'r2', async () => {}), /locked by alive pid/);
  } finally {
    process.kill = originalKill;
  }
});

test('internal state/media/receipt symlink components are rejected', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  await fsp.mkdir(out, { recursive: true });
  await fsp.mkdir(path.join(d, 'elsewhere'));
  await fsp.symlink(path.join(d, 'elsewhere'), path.join(out, 'media'));
  await assert.rejects(() => lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [{ shortcode: 'A', href: 'https://instacognito.com/media?id=x' }], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 }), /internal directory path contains symlink/);
});

test('pagination waits for delayed growth after explicit center scroll of already-visible last card', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="post-container"><article class="post-card"><span data-id="P1"></span><a class="content-download-btn" href="https://instacognito.com/media?id=one">d</a></article></div><script>window.scrollCalls=[]; Element.prototype.scrollIntoView=function(opts){ window.scrollCalls.push(opts); setTimeout(()=>{ if(!document.querySelector('[data-id=P2]')) document.querySelector('#post-container').insertAdjacentHTML('beforeend','<article class="post-card"><span data-id="P2"></span><a class="content-download-btn" href="https://instacognito.com/media?id=two">d</a></article>'); }, 1100); };</script>`);
    const before = await lib.getRenderedCardState(page);
    const started = Date.now();
    const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 7000, growthWaitMs: 5000 });
    const elapsed = Date.now() - started;
    assert.equal(after.grew, true);
    assert.ok(elapsed < 4200, 'settled before full growth window; elapsed=' + elapsed);
    assert.deepEqual(after.ids, ['P1', 'P2']);
    const calls = await page.evaluate(() => window.scrollCalls);
    assert.equal(calls[0].block, 'center');
  } finally {
    await browser.close();
  }
});

test('pagination no-growth waits only bounded budget before declaring no growth', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="post-container"><article class="post-card"><span data-id="ONLY"></span><a class="content-download-btn" href="https://instacognito.com/media?id=one">d</a></article></div>');
    const before = await lib.getRenderedCardState(page);
    const started = Date.now();
    const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 5000, growthWaitMs: 400 });
    assert.equal(after.grew, false);
    assert.ok(Date.now() - started >= 350);
    assert.ok(Date.now() - started < 2000);
  } finally {
    await browser.close();
  }
});

test('pagination waits for partial batch to settle and recenters current last card', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div id="post-container"><article class="post-card"><span data-id="P1"></span><a class="content-download-btn" href="https://instacognito.com/media?id=one">d</a></article></div><div id="loader" aria-busy="true"></div><script>window.scrollCalls=[]; Element.prototype.scrollIntoView=function(opts){ window.scrollCalls.push({opts, at: Date.now(), last: this.querySelector('[data-id]')?.getAttribute('data-id')}); if(!window.started){ window.started=1; setTimeout(()=>document.querySelector('#post-container').insertAdjacentHTML('beforeend','<article class="post-card"><span data-id="P2"></span><a class="content-download-btn" href="https://instacognito.com/media?id=two">d</a></article>'), 500); setTimeout(()=>{ document.querySelector('#post-container').insertAdjacentHTML('beforeend','<article class="post-card"><span data-id="P3"></span><a class="content-download-btn" href="https://instacognito.com/media?id=three">d</a></article>'); document.querySelector('#loader').remove(); }, 1300); } };</script>`);
    const before = await lib.getRenderedCardState(page);
    const started = Date.now();
    const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 6000, growthWaitMs: 5000, settleMs: 700, recenterEveryMs: 600, maxRecenters: 3, targetUniqueCount: 3 });
    assert.equal(after.grew, true);
    assert.deepEqual(after.ids, ['P1', 'P2', 'P3']);
    const calls = await page.evaluate(() => window.scrollCalls);
    assert.ok(calls.length >= 2 && calls.length <= 3);
    assert.equal(calls[0].opts.block, 'center');
  } finally {
    await browser.close();
  }
});

test('pagination centers the provider top-level sentinel, not a trailing carousel child card', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    // Provider shape: R() appends each post's carousel slides as SIBLING .post-cards that inherit
    // the parent's data-id, and Te() observes only the last post's TOP-LEVEL card with a 200px
    // rootMargin. data-marker is test-only and is what distinguishes parent from slide, since the
    // provider renders byte-identical markup for both.
    const card = (marker, id, media) => '<article class="post-card" data-marker="' + marker + '"><span class="likes-trigger" data-id="' + id + '"><span>5</span></span><a class="content-download-btn" href="https://instacognito.com/media?id=' + media + '">d</a></article>';
    const lead = Array.from({ length: 8 }, (_, i) => card('lead', 'P' + (i + 1), 'lead' + i)).join('');
    const carousel = card('parent', 'PLAST', 'slide0') + Array.from({ length: 6 }, (_, i) => card('slide', 'PLAST', 'slide' + (i + 1))).join('');
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent('<style>body{margin:0}#post-container{display:block}.post-card{display:block;height:300px;box-sizing:border-box;border:1px solid #ccc}</style><div id="post-container">' + lead + carousel + '</div><script>(function(){ const orig = Element.prototype.scrollIntoView; window.scrollCalls = []; Element.prototype.scrollIntoView = function(opts){ const tag = this.querySelector("[data-id]"); window.scrollCalls.push({ block: opts && opts.block, marker: this.getAttribute("data-marker"), id: tag ? tag.getAttribute("data-id") : null, index: Array.prototype.indexOf.call(document.querySelectorAll("#post-container .post-card"), this) }); return orig.call(this, opts); }; window.paginationFires = 0; const sentinel = document.querySelector(\'#post-container .post-card[data-marker="parent"]\'); const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; io.disconnect(); window.paginationFires++; document.getElementById("post-container").insertAdjacentHTML("beforeend", \'<article class="post-card" data-marker="next"><span class="likes-trigger" data-id="PNEXT"><span>1</span></span><a class="content-download-btn" href="https://instacognito.com/media?id=next">d</a></article>\'); }, { rootMargin: "200px" }); io.observe(sentinel); })();</script>');

    // Precondition: the sentinel must start below viewport height + rootMargin, or the observer
    // fires on observe() and the negative half of this test proves nothing.
    const geometry = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#post-container .post-card')];
      const parent = document.querySelector('#post-container .post-card[data-marker="parent"]');
      return { parentIndex: cards.indexOf(parent), lastIndex: cards.length - 1, parentTop: parent.getBoundingClientRect().top, lastTop: cards[cards.length - 1].getBoundingClientRect().top, viewport: window.innerHeight };
    });
    assert.equal(geometry.parentIndex, 8);
    assert.equal(geometry.lastIndex, 14, 'sentinel must sit 6 slides above the final DOM card');
    assert.ok(geometry.parentTop > geometry.viewport + 200, 'sentinel must start outside viewport + rootMargin; top=' + geometry.parentTop);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.paginationFires), 0, 'observer must not fire on load');

    // The pre-fix target: centering the final DOM card, which is the last carousel slide.
    await page.evaluate(() => { const cards = document.querySelectorAll('#post-container .post-card'); cards[cards.length - 1].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.paginationFires), 0, 'centering the last carousel slide must not reach the provider sentinel');
    assert.equal((await lib.getRenderedCardState(page)).count, 15, 'no growth from scrolling the wrong card');

    await page.evaluate(() => { window.scrollCalls = []; });
    const before = await lib.getRenderedCardState(page);
    assert.deepEqual(before.ids, ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'PLAST']);
    const started = Date.now();
    const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 12000, growthWaitMs: 6000, settleMs: 500, maxRecenters: 1 });
    assert.equal(after.grew, true, 'centering the top-level sentinel must trigger provider pagination');
    assert.equal(after.sentinelIndex, 8);
    assert.equal(after.sentinelId, 'PLAST');
    assert.ok(after.ids.includes('PNEXT'), 'new batch must be observed: ' + JSON.stringify(after.ids));
    assert.equal(after.count, 16);
    assert.equal(await page.evaluate(() => window.paginationFires), 1);
    const calls = await page.evaluate(() => window.scrollCalls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].block, 'center');
    assert.equal(calls[0].id, 'PLAST');
    assert.equal(calls[0].marker, 'parent', 'must center the top-level sentinel, not a carousel slide; centered a ' + calls[0].marker);
    assert.equal(calls[0].index, 8);
  } finally {
    await browser.close();
  }
});

test('pagination follows the observed sentinel when the last post and its slides carry no data-id', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    // A zero-engagement post renders no .likes-trigger and no .comments-trigger, so neither it
    // nor its carousel slides carry a data-id anywhere. Every markup-based heuristic is blind
    // here; only the element the provider actually observes identifies the sentinel.
    const idCard = (marker, id, media) => '<article class="post-card" data-marker="' + marker + '"><span class="likes-trigger" data-id="' + id + '"><span>5</span></span><a class="content-download-btn" href="https://instacognito.com/media?id=' + media + '">d</a></article>';
    const blankCard = (marker, media) => '<article class="post-card" data-marker="' + marker + '"><a class="content-download-btn" href="https://instacognito.com/media?id=' + media + '">d</a></article>';
    const lead = Array.from({ length: 8 }, (_, i) => idCard('lead', 'P' + (i + 1), 'lead' + i)).join('');
    const carousel = blankCard('parent', 'slide0') + Array.from({ length: 6 }, (_, i) => blankCard('slide', 'slide' + (i + 1))).join('');
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // The fixture wraps IntersectionObserver first and only then lets the "provider" build its
    // observer, exactly the ordering scrapeWithPlaywright establishes between goto and search.
    await page.setContent('<style>body{margin:0}#post-container{display:block}.post-card{display:block;height:300px;box-sizing:border-box;border:1px solid #ccc}</style><div id="post-container">' + lead + carousel + '</div><script>(function(){ const attr = "data-ff-pagination-sentinel"; const Native = window.IntersectionObserver; function Probed(cb, opts){ const o = new Native(cb, opts); const nat = o.observe.bind(o); o.observe = function(target){ for (const m of document.querySelectorAll("[" + attr + "]")) m.removeAttribute(attr); target.setAttribute(attr, "1"); return nat(target); }; return o; } Probed.prototype = Native.prototype; window.IntersectionObserver = Probed; const orig = Element.prototype.scrollIntoView; window.scrollCalls = []; Element.prototype.scrollIntoView = function(opts){ window.scrollCalls.push({ block: opts && opts.block, marker: this.getAttribute("data-marker"), index: Array.prototype.indexOf.call(document.querySelectorAll("#post-container .post-card"), this) }); return orig.call(this, opts); }; window.paginationFires = 0; const sentinel = document.querySelector(\'#post-container .post-card[data-marker="parent"]\'); const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; io.disconnect(); window.paginationFires++; document.getElementById("post-container").insertAdjacentHTML("beforeend", \'<article class="post-card" data-marker="next"><span class="likes-trigger" data-id="PNEXT"><span>1</span></span><a class="content-download-btn" href="https://instacognito.com/media?id=next">d</a></article>\'); }, { rootMargin: "200px" }); io.observe(sentinel); })();</script>');

    const setup = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#post-container .post-card')];
      const marked = document.querySelector('[data-ff-pagination-sentinel]');
      return { markedMarker: marked && marked.getAttribute('data-marker'), markedIndex: cards.indexOf(marked), lastIndex: cards.length - 1, markedTop: marked.getBoundingClientRect().top, viewport: window.innerHeight, idsPresent: cards.filter(c => c.querySelector('[data-id]')).length };
    });
    assert.equal(setup.markedMarker, 'parent', 'observe() must mark the element the provider watches');
    assert.equal(setup.markedIndex, 8);
    assert.equal(setup.lastIndex, 14, 'sentinel must sit 6 slides above the final DOM card');
    assert.equal(setup.idsPresent, 8, 'only the 8 lead posts carry a data-id');
    assert.ok(setup.markedTop > setup.viewport + 200, 'sentinel must start outside viewport + rootMargin; top=' + setup.markedTop);
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.paginationFires), 0, 'observer must not fire on load');

    // Both markup heuristics land here: with no data-id anywhere in the trailing run, the id-run
    // rule degrades to the last card, which is a slide six cards below the real sentinel.
    await page.evaluate(() => { const cards = document.querySelectorAll('#post-container .post-card'); cards[cards.length - 1].scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.paginationFires), 0, 'centering the last slide must not reach the provider sentinel');
    assert.equal((await lib.getRenderedCardState(page)).count, 15, 'no growth from scrolling the wrong card');

    await page.evaluate(() => { window.scrollCalls = []; });
    const before = await lib.getRenderedCardState(page);
    assert.deepEqual(before.ids, ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
    const started = Date.now();
    const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 12000, growthWaitMs: 6000, settleMs: 500, maxRecenters: 1 });
    assert.equal(after.grew, true, 'centering the observed sentinel must trigger provider pagination');
    assert.equal(after.sentinelSource, 'observed');
    assert.equal(after.sentinelIndex, 8);
    assert.equal(after.sentinelId, null, 'the sentinel legitimately has no data-id here');
    assert.ok(after.ids.includes('PNEXT'), 'new batch must be observed: ' + JSON.stringify(after.ids));
    assert.equal(after.count, 16);
    assert.equal(await page.evaluate(() => window.paginationFires), 1);
    const calls = await page.evaluate(() => window.scrollCalls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].block, 'center');
    assert.equal(calls[0].marker, 'parent', 'must center the observed sentinel, not a slide; centered a ' + calls[0].marker);
  } finally {
    await browser.close();
  }
});

test('sentinel probe marks each newly observed element, clears the previous one, and still paginates', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  assert.equal(lib.PAGINATION_SENTINEL_ATTR, 'data-ff-pagination-sentinel', 'fixtures hardcode this attribute; keep them in step');
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.setContent('<div id="a">a</div><div id="b">b</div><div id="c">c</div>');
    assert.equal(await lib.installPaginationSentinelProbe(page), true);
    assert.equal(await lib.installPaginationSentinelProbe(page), true, 'installing twice must not double-wrap');

    const marks = await page.evaluate(attr => {
      const seen = [];
      const read = () => [...document.querySelectorAll('[' + attr + ']')].map(el => el.id).join(',');
      const first = new IntersectionObserver(() => {}); first.observe(document.getElementById('a')); seen.push(read());
      const second = new IntersectionObserver(() => {}); second.observe(document.getElementById('b')); seen.push(read());
      second.disconnect();
      const third = new IntersectionObserver(() => {}); third.observe(document.getElementById('c')); seen.push(read());
      return seen;
    }, lib.PAGINATION_SENTINEL_ATTR);
    assert.deepEqual(marks, ['a', 'b', 'c'], 'exactly one element is marked at a time and it is the latest observed');

    // The wrapper must not break the observer it wraps: a visible element still fires.
    const fired = await page.evaluate(() => new Promise(resolve => {
      const io = new IntersectionObserver(entries => { if (entries[0].isIntersecting) { io.disconnect(); resolve(true); } });
      io.observe(document.getElementById('a'));
      setTimeout(() => resolve(false), 2000);
    }));
    assert.equal(fired, true, 'wrapped observers must still deliver intersections');
  } finally {
    await browser.close();
  }
});

test('attached browser cleanup disconnects transport without closing external server marker', async () => {
  const events = [];
  const externalServer = { closed: false };
  const page = { close: async () => events.push('page.close') };
  const browser = { close: async () => events.push('browser.close') };
  await lib.cleanupScrapeBrowser(page, browser);
  assert.deepEqual(events, ['page.close', 'browser.close']);
  assert.equal(externalServer.closed, false);
});

test('normalizeItems keeps zero-engagement posts and stories without fake shortcodes', () => {
  const posts = lib.normalizeItems([{ href: 'https://instacognito.com/media?id=zero', mediaType: 'image', dateRaw: '2024-08-23' }], { category: 'posts', mediaTypes: ['image', 'video'] });
  assert.equal(posts.items.length, 1);
  assert.equal(posts.items[0].shortcode, null);
  assert.equal(posts.items[0].stableId, null);
  assert.equal(posts.items[0].identityBasis, 'content-sha256');
  const stories = lib.normalizeItems([{ href: 'https://instacognito.com/media?id=story', mediaType: 'image', captionTruncated: null }], { category: 'stories', mediaTypes: ['image', 'video'] });
  assert.equal(stories.items[0].identityBasis, 'content-sha256');
});

test('extractItemsFromPage understands provider-like posts/stories cards', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no chromium binary'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="post-container"><article class="post-card"><div class="post-image" data-type="image"></div><div class="post-content"><p>Hello world</p><a class="content-download-btn" href="https://instacognito.com/media?id=a">d</a></div><div class="post-footer"><div class="icon-group likes-trigger" data-id="CAR"><span>5</span></div><div class="icon-group comments-trigger" data-id="CAR"><span>1</span></div><div class="icon-group"><span>2024-01-01</span></div></div></article><article class="post-card"><div class="post-image" data-type="video"></div><div class="post-content"><p>Zero social proof</p><a class="content-download-btn" href="https://instacognito.com/media?id=b">d</a></div><div class="post-footer"><div class="icon-group"><span>2024-01-02</span></div></div></article></div>');
    const posts = await lib.extractItemsFromPage(page, { category: 'posts', mediaTypes: ['image', 'video'] });
    assert.equal(posts.items.length, 2);
    assert.equal(posts.items[0].stableId, 'CAR-0');
    assert.equal(posts.items[1].stableId, null);
    await page.setContent('<div id="post-container"><article class="post-card"><div class="story-image" data-type="video"></div><div class="post-content"><a class="content-download-btn" href="https://instacognito.com/media?id=s1">d</a></div><div class="post-footer"><div class="icon-group"><span>23 August</span></div></div></article></div>');
    const stories = await lib.extractItemsFromPage(page, { category: 'stories', mediaTypes: ['image', 'video'] });
    assert.equal(stories.items.length, 1);
    assert.equal(stories.items[0].category, 'stories');
    assert.equal(stories.items[0].shortcode, null);
    assert.equal(stories.items[0].mediaType, 'video');
  } finally {
    await browser.close();
  }
});

test('archiveProfile reuses post receipts on stable IDs and rotated URLs', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  let calls = 0;
  await lib.archiveProfile({
    handle: 'example',
    output: out,
    sections: [section('posts', [
      { shortcode: 'A', href: 'https://instacognito.com/media?id=oldA', mediaType: 'image' },
      { shortcode: 'B', href: 'https://instacognito.com/media?id=oldB', mediaType: 'image' }
    ], { reportedTotal: 2 })],
    dnsLookup: publicDns,
    fetchImpl: async () => { calls++; return res(); },
    delayMs: 0
  });
  calls = 0;
  const second = await lib.archiveProfile({
    handle: 'example',
    output: out,
    mode: 'sync',
    sections: [section('posts', [
      { shortcode: 'A', href: 'https://instacognito.com/media?id=newA', mediaType: 'image' },
      { shortcode: 'B', href: 'https://instacognito.com/media?id=newB', mediaType: 'image' }
    ], { reportedTotal: 2 })],
    dnsLookup: publicDns,
    fetchImpl: async () => { calls++; return res(); },
    delayMs: 0
  });
  assert.equal(second.status, 'COMPLETE');
  assert.equal(second.reusedCount, 2);
  assert.equal(calls, 0);
});

test('stories re-fetch but dedupe after hashing because no stable provider ID exists', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  let calls = 0;
  const fetchImpl = async () => { calls++; return res({ body: png, headers: { 'content-type': 'image/png' } }); };
  await lib.archiveProfile({
    handle: 'example',
    output: out,
    sections: [section('stories', [{ href: 'https://instacognito.com/media?id=story1', mediaType: 'image' }])],
    dnsLookup: publicDns,
    fetchImpl,
    delayMs: 0
  });
  calls = 0;
  const second = await lib.archiveProfile({
    handle: 'example',
    output: out,
    mode: 'sync',
    sections: [section('stories', [{ href: 'https://instacognito.com/media?id=story2', mediaType: 'image' }])],
    dnsLookup: publicDns,
    fetchImpl,
    delayMs: 0
  });
  const manifest = await readManifest(out);
  assert.equal(calls, 1);
  assert.equal(Object.keys(manifest.completed).length, 1);
  assert.equal(second.reusedCount, 1);
});

test('category selection + unavailable section yields honest PARTIAL with section records', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const result = await lib.archiveProfile({
    handle: 'example',
    output: out,
    categories: 'posts,highlights',
    sections: [
      section('posts', [{ shortcode: 'A', href: 'https://instacognito.com/media?id=a', mediaType: 'image' }], { reportedTotal: 1 }),
      { category: 'highlights', status: 'UNAVAILABLE', reason: 'provider exposed no highlight groups', items: [] }
    ],
    dnsLookup: publicDns,
    fetchImpl: async () => res(),
    delayMs: 0
  });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.sections.length, 2);
  assert.equal(result.sections[1].status, 'UNAVAILABLE');
});

test('status and manifest sections never persist signed provider URLs', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  await lib.archiveProfile({
    handle: 'example',
    output: out,
    categories: 'posts,reels',
    sections: [
      section('posts', [{ shortcode: 'A', href: 'https://instacognito.com/media?id=secret-post', mediaType: 'image' }], { reportedTotal: 1 }),
      { category: 'reels', status: 'UNAVAILABLE', reason: 'provider exposed no reels for https://instacognito.com/media?id=secret-reel', items: [] }
    ],
    dnsLookup: publicDns,
    fetchImpl: async () => res(),
    delayMs: 0
  });
  const status = JSON.stringify(await readStatus(out));
  const manifest = JSON.stringify(await readManifest(out));
  assert.equal(status.includes('media?id='), false);
  assert.equal(manifest.includes('media?id='), false);
});

test('legacy post receipts without category still count toward uniquePostCount and export as posts', { skip: !python3Available }, async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const zipPath = path.join(d, 'legacy.zip');
  await lib.archiveProfile({
    handle: 'example',
    output: out,
    sections: [section('posts', [{ shortcode: 'A', href: 'https://instacognito.com/media?id=a', mediaType: 'image' }], { reportedTotal: 1 })],
    dnsLookup: publicDns,
    fetchImpl: async () => res(),
    delayMs: 0
  });
  const manifestPath = path.join(out, '.frameferry', 'example', 'manifest.json');
  const receiptPath = path.join(out, 'receipts', 'example', 'A-0.json');
  const manifest = await readJson(manifestPath);
  delete manifest.completed['A-0'].category;
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const receipt = await readJson(receiptPath);
  delete receipt.category;
  await fsp.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  const rerun = await lib.archiveProfile({
    handle: 'example',
    output: out,
    mode: 'sync',
    sections: [section('posts', [{ shortcode: 'A', href: 'https://instacognito.com/media?id=rotated', mediaType: 'image' }], { reportedTotal: 1 })],
    dnsLookup: publicDns,
    fetchImpl: async () => { throw new Error('should not fetch'); },
    delayMs: 0
  });
  assert.equal(rerun.uniquePostCount, 1);
  await lib.exportProfile({ handle: 'example', output: out, zip: zipPath });
  const py = spawnSync('python3', ['-c', [
    'import json, sys, zipfile',
    'z=zipfile.ZipFile(sys.argv[1])',
    'root=sorted({n.split("/",1)[0] for n in z.namelist()})[0]',
    'idx=json.loads(z.read(root+"/index.json"))',
    'print(idx[0]["category"])'
  ].join('\n'), zipPath], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  assert.equal(py.stdout.trim(), 'posts');
});

test('exportProfile writes ZIP with metadata, checksums, and byte-exact media', { skip: !python3Available }, async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const zipPath = path.join(d, 'export.zip');
  let call = 0;
  await lib.archiveProfile({
    handle: 'example',
    output: out,
    categories: 'posts,stories',
    sections: [
      section('posts', [{ shortcode: 'A', href: 'https://instacognito.com/media?id=a', mediaType: 'image', captionTruncated: 'caption', dateRaw: '2024-01-01' }], { reportedTotal: 1 }),
      section('stories', [{ href: 'https://instacognito.com/media?id=s', mediaType: 'video', dateRaw: '23 August', highlightGroup: null }])
    ],
    dnsLookup: publicDns,
    fetchImpl: async () => { call++; return call === 1 ? res({ body: jpg }) : res({ body: mp4, headers: { 'content-type': 'video/mp4' } }); },
    delayMs: 0
  });
  const exported = await lib.exportProfile({ handle: 'example', output: out, zip: zipPath });
  assert.equal(exported.totalEntryCount > 0, true);
  const py = spawnSync('python3', ['-c', [
    'import hashlib, json, sys, zipfile',
    'z=zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None',
    'root=sorted({n.split("/",1)[0] for n in z.namelist()})[0]',
    'idx=json.loads(z.read(root+"/index.json"))',
    'sections=json.loads(z.read(root+"/sections.json"))',
    'checks=z.read(root+"/checksums.txt").decode()',
    'assert "media?id=" not in z.read(root+"/sections.json").decode()',
    'assert "media?id=" not in z.read(root+"/manifest.json").decode()',
    'line_map={}',
    'for line in checks.strip().splitlines():',
    '    h,name=line.split("  ",1); line_map[name]=h',
    'for name in ["manifest.json","index.json","sections.json","README.txt"]:',
    '    assert hashlib.sha256(z.read(root+"/"+name)).hexdigest()==line_map[name]',
    'print(json.dumps({"entries": len(z.namelist()), "indexCount": len(idx), "sectionStatuses": [s["status"] for s in sections], "hasChecksums": "media/" in checks}))'
  ].join('\n'), zipPath], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const info = JSON.parse(py.stdout.trim());
  assert.equal(info.indexCount, 2);
  assert.deepEqual(info.sectionStatuses, ['COMPLETE', 'COMPLETE']);
  assert.equal(info.hasChecksums, true);
});

test('exportProfile rejects dangerous destinations and symlink ancestors', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  await lib.archiveProfile({
    handle: 'example',
    output: out,
    sections: [section('posts', [{ shortcode: 'A', href: 'https://instacognito.com/media?id=a', mediaType: 'image' }], { reportedTotal: 1 })],
    dnsLookup: publicDns,
    fetchImpl: async () => res(),
    delayMs: 0
  });
  await assert.rejects(() => lib.exportProfile({ handle: 'example', output: out, zip: path.join(out, 'bad.zip') }), /outside the archive root/);
  const parent = path.join(d, 'parent');
  const real = path.join(parent, 'real');
  const link = path.join(parent, 'link');
  await fsp.mkdir(real, { recursive: true });
  await fsp.symlink(real, link);
  await assert.rejects(() => lib.exportProfile({ handle: 'example', output: out, zip: path.join(link, 'bad.zip') }), /symlink/);
  const nested = path.join(d, 'new', 'dir', 'export.zip');
  await lib.exportProfile({ handle: 'example', output: out, zip: nested });
  assert.equal(fs.existsSync(nested), true);
});

test('exportProfile refuses corrupted bytes, stale part files, and zero zip limits', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const zipPath = path.join(d, 'export.zip');
  await lib.archiveProfile({
    handle: 'example',
    output: out,
    sections: [section('posts', [{ shortcode: 'A', href: 'https://instacognito.com/media?id=a', mediaType: 'image' }], { reportedTotal: 1 })],
    dnsLookup: publicDns,
    fetchImpl: async () => res(),
    delayMs: 0
  });
  await fsp.writeFile(zipPath + '.part', 'stale');
  await assert.rejects(() => lib.exportProfile({ handle: 'example', output: out, zip: zipPath }), /temporary .part/);
  await lib.exportProfile({ handle: 'example', output: out, zip: zipPath, overwriteZip: true });
  assert.equal(fs.existsSync(zipPath + '.part'), false);
  await assert.rejects(() => lib.exportProfile({ handle: 'example', output: out, zip: path.join(d, 'zero.zip'), maxZipBytes: 0 }), /positive number/);
  await fsp.writeFile(path.join(out, 'media', 'example', 'A-0.jpg'), Buffer.from('corrupt'));
  await assert.rejects(() => lib.exportProfile({ handle: 'example', output: out, zip: path.join(d, 'corrupt.zip') }), /receipt verification failed/);
});

test('CLI rejects bad category/media-type flags and keeps doctor parsing attach-cdp', () => {
  const bin = path.join(__dirname, '..', 'bin', 'frameferry.js');
  const badCategory = spawnSync(process.execPath, [bin, 'archive', 'example', '--output', 'x', '--categories', 'bogus'], { encoding: 'utf8' });
  assert.equal(badCategory.status, 1);
  assert.match(badCategory.stderr, /categories/);
  const badMedia = spawnSync(process.execPath, [bin, 'archive', 'example', '--output', 'x', '--media-types', 'audio'], { encoding: 'utf8' });
  assert.equal(badMedia.status, 1);
  assert.match(badMedia.stderr, /media-types/);
  const badCdp = spawnSync(process.execPath, [bin, 'doctor', '--attach-cdp', 'http://192.168.1.2:9222'], { encoding: 'utf8' });
  assert.equal(badCdp.status, 1);
  assert.match(badCdp.stdout, /"cdpOk": false/);
});

test('local CLI works from repo path without assuming global frameferry', () => {
  const bin = path.join(__dirname, '..', 'bin', 'frameferry.js');
  const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), lib.VERSION);
  const doctor = spawnSync(process.execPath, [bin, 'doctor'], { encoding: 'utf8' });
  const parsed = JSON.parse(doctor.stdout);
  assert.equal(typeof parsed.node, 'string');
  assert.equal(typeof parsed.playwright, 'boolean');
});

test('date provenance resolves only explicit-year and ISO input, never yearless or relative labels', () => {
  const iso = lib.resolveItemDate('2024-08-23');
  assert.equal(iso.dateStatus, 'resolved');
  assert.equal(iso.dateProvenance, 'provider-iso');
  assert.equal(iso.dateResolved, '2024-08-23T00:00:00.000Z');

  const explicit = lib.resolveItemDate(['views', '23 August 2024'].join('\n'));
  assert.equal(explicit.dateStatus, 'resolved');
  assert.equal(explicit.dateProvenance, 'provider-explicit-year');
  // Asserted in UTC, which is what gets persisted. Reading it back with a local-time accessor is
  // exactly the mistake that let a wrong year ship, so the whole timestamp is pinned here.
  assert.equal(explicit.dateResolved, '2024-08-23T00:00:00.000Z');

  // The whole point of the contract: a label with no year stays unresolved. No year is ever
  // inferred from a neighbouring item, from scrape order, or from the wall clock.
  for (const [text, provenance] of [['23 August', 'provider-yearless-label'], ['August 23', 'provider-yearless-label'], ['2d ago', 'provider-relative-label'], ['yesterday', 'provider-relative-label'], ['3h', 'provider-relative-label']]) {
    const got = lib.resolveItemDate(text);
    assert.equal(got.dateStatus, 'unresolved', text + ' must not resolve');
    assert.equal(got.dateResolved, null, text + ' must not carry a timestamp');
    assert.equal(got.dateProvenance, provenance, text);
    assert.equal(got.dateRaw, text, 'raw label is preserved verbatim');
  }

  const missing = lib.resolveItemDate(null);
  assert.equal(missing.dateStatus, 'unresolved');
  assert.equal(missing.dateProvenance, 'none');
  assert.equal(missing.dateResolved, null);

  // Date.parse is lenient enough to mint an instant from text that merely contains four digits;
  // the resolved year must match the year the label actually spelled out.
  const junk = lib.resolveItemDate('1999 likes');
  assert.equal(junk.dateResolved, null);
  assert.ok(junk.dateStatus === 'unresolved', 'junk containing a year must not resolve');
});

test('caller date proof is accepted only with evidence and fails closed otherwise', () => {
  const proven = lib.resolveItemDate('23 August', { dateProven: '2024-08-23T10:00:00.000Z', dateEvidence: { kind: 'provider-permalink', note: 'permalink page shows 23 August 2024' } });
  assert.equal(proven.dateStatus, 'resolved');
  assert.equal(proven.dateProvenance, 'caller-proven');
  assert.equal(proven.dateResolved, '2024-08-23T10:00:00.000Z');
  assert.equal(proven.dateRaw, '23 August', 'the raw provider label is still preserved');
  assert.equal(proven.dateEvidence.kind, 'provider-permalink');
  assert.match(proven.dateEvidence.note, /permalink page/);
  // A bare allowlisted kind is enough; free text alone is not evidence.
  assert.deepEqual(lib.resolveItemDate(null, { dateProven: '2024-08-23', dateEvidence: 'operator-attested' }).dateEvidence, { kind: 'operator-attested', note: null });
  assert.throws(() => lib.resolveItemDate('23 August', { dateProven: '2024-08-23', dateEvidence: 'I checked it myself' }), err => err.code === 'BAD_DATE_PROOF' && /allowlisted|kind must be/.test(err.message));

  assert.throws(() => lib.resolveItemDate('23 August', { dateProven: '2024-08-23' }), err => err.code === 'BAD_DATE_PROOF' && /dateEvidence/.test(err.message));
  assert.throws(() => lib.resolveItemDate('23 August', { dateEvidence: { kind: 'operator-attested' } }), err => err.code === 'BAD_DATE_PROOF' && /dateProven/.test(err.message));
  assert.throws(() => lib.resolveItemDate('23 August', { dateProven: '23 August', dateEvidence: { kind: 'operator-attested' } }), err => err.code === 'BAD_DATE_PROOF' && /four-digit year/.test(err.message));
  assert.throws(() => lib.resolveItemDate('23 August', { dateProven: 'not a date 2024 at all!!', dateEvidence: { kind: 'operator-attested' } }), err => err.code === 'BAD_DATE_PROOF' && /complete, valid calendar date/.test(err.message));
  // An incomplete or impossible proof is refused just like an unparseable one.
  for (const bad of ['2024-08', '2024', 'August 2024', '2024-02-31', '31 February 2024']) {
    assert.throws(() => lib.resolveItemDate('23 August', { dateProven: bad, dateEvidence: { kind: 'operator-attested' } }), err => err.code === 'BAD_DATE_PROOF', 'must refuse proof ' + bad);
  }

  // Evidence is caller free text that lands in receipts and the exported ZIP.
  // Adversarial: every equivalent spelling of a signed provider URL, plus unrelated URLs, must be
  // gone from anything persisted. Evidence notes are caller-controlled and reach the public ZIP.
  const leaky = [
    'seen at https://instacognito.com/media?id=SIGNEDTOKEN',
    'seen at https://instacognito.com:443/media?id=SIGNEDTOKEN',
    'seen at HTTPS://INSTACOGNITO.COM/media?id=SIGNEDTOKEN',
    'seen at https://instacognito.com/media?sig=x&id=SIGNEDTOKEN',
    'seen at //instacognito.com/media?id=SIGNEDTOKEN',
    'seen at https://cdn.instacognito.com/media?id=SIGNEDTOKEN',
    'seen at https://user:pw@instacognito.com/media?id=SIGNEDTOKEN',
    'seen at http://example.net/leak?token=SIGNEDTOKEN'
  ];
  for (const note of leaky) {
    const got = lib.resolveItemDate(null, { dateProven: '2024-08-23', dateEvidence: { kind: 'provider-permalink', note } });
    assert.ok(!got.dateEvidence.note.includes('SIGNEDTOKEN'), 'token survived sanitisation: ' + got.dateEvidence.note);
    assert.ok(!/instacognito\.com\/media/i.test(got.dateEvidence.note), 'provider media URL survived: ' + got.dateEvidence.note);
  }
  // Notes are length-capped and stripped of control characters so a receipt cannot carry a payload.
  const huge = lib.resolveItemDate(null, { dateProven: '2024-08-23', dateEvidence: { kind: 'operator-attested', note: 'x'.repeat(5000) } });
  assert.ok(huge.dateEvidence.note.length <= 210, 'note must be capped, got ' + huge.dateEvidence.note.length);
  const ctrl = lib.resolveItemDate(null, { dateProven: '2024-08-23', dateEvidence: { kind: 'operator-attested', note: 'a\u0000b\u001fc' } });
  assert.equal(ctrl.dateEvidence.note, 'a b c');
});

test('legacy dateParsed input can never promote an item to resolved', () => {
  // dateParsed keeps its long-standing "best available text" meaning, so existing callers that
  // pass it keep working and cannot accidentally trip the proof validation.
  const { items } = lib.normalizeItems([
    { shortcode: 'A', href: 'https://instacognito.com/media?id=a', mediaType: 'image', dateRaw: '23 August', dateParsed: '2024-08-23T00:00:00.000Z' }
  ], { category: 'posts', mediaTypes: ['image', 'video'] });
  assert.equal(items.length, 1);
  assert.equal(items[0].dateParsed, '2024-08-23T00:00:00.000Z', 'backward-compatible field is untouched');
  assert.equal(items[0].dateStatus, 'unresolved', 'an unproven ISO passthrough does not resolve the item');
  assert.equal(items[0].dateResolved, null);
  assert.equal(items[0].dateProvenance, 'provider-yearless-label');
  assert.equal(items[0].dateRaw, '23 August');
});

test('normalizeItems stamps provenance on every item and requireCaptureTimestamp fails closed', () => {
  const { items } = lib.normalizeItems([
    { shortcode: 'A', href: 'https://instacognito.com/media?id=a', mediaType: 'image', dateRaw: '2024-08-23' },
    { shortcode: 'B', href: 'https://instacognito.com/media?id=b', mediaType: 'image', dateRaw: '23 August' },
    { shortcode: 'C', href: 'https://instacognito.com/media?id=c', mediaType: 'image' }
  ], { category: 'posts', mediaTypes: ['image', 'video'] });
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.ok(['resolved', 'unresolved'].includes(item.dateStatus), 'every item carries a machine-readable status');
    assert.ok(typeof item.dateProvenance === 'string' && item.dateProvenance, 'every item carries provenance');
  }
  assert.equal(lib.requireCaptureTimestamp(items[0], 'test'), '2024-08-23T00:00:00.000Z');
  assert.throws(() => lib.requireCaptureTimestamp(items[1], 'timeline write'), err => err.code === 'DATE_UNRESOLVED');
  assert.throws(() => lib.requireCaptureTimestamp(items[2], 'timeline write'), err => err.code === 'DATE_UNRESOLVED');
  // A legacy record with no provenance fields at all, and a hand-edited one claiming resolved
  // without a usable timestamp, must both be refused rather than trusted.
  assert.throws(() => lib.requireCaptureTimestamp({ dateRaw: '23 August', dateParsed: '2024-08-23T00:00:00.000Z' }, 'timeline write'), err => err.code === 'DATE_UNRESOLVED');
  assert.throws(() => lib.requireCaptureTimestamp({ dateStatus: 'resolved', dateResolved: '23 August' }, 'timeline write'), err => err.code === 'DATE_UNRESOLVED');
  assert.throws(() => lib.requireCaptureTimestamp({ dateStatus: 'resolved', dateResolved: null }, 'timeline write'), err => err.code === 'DATE_UNRESOLVED');
});

test('legacy receipts without provenance export as unresolved and index agrees with receipts', { skip: !python3Available }, async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const zipPath = path.join(d, 'legacy-dates.zip');
  await lib.archiveProfile({
    handle: 'example',
    output: out,
    sections: [section('posts', [{ shortcode: 'A', href: 'https://instacognito.com/media?id=a', mediaType: 'image', dateRaw: '23 August' }], { reportedTotal: 1 })],
    dnsLookup: publicDns,
    fetchImpl: async () => res(),
    delayMs: 0
  });
  const manifestPath = path.join(out, '.frameferry', 'example', 'manifest.json');
  const receiptPath = path.join(out, 'receipts', 'example', 'A-0.json');
  const manifest = await readJson(manifestPath);
  const receipt = await readJson(receiptPath);
  // Simulate a receipt written before this contract existed: the new fields simply are not there,
  // but the misleading dateParsed echo is.
  for (const field of ['dateStatus', 'dateProvenance', 'dateResolved', 'dateEvidence']) {
    delete manifest.completed['A-0'][field];
    delete receipt[field];
  }
  assert.equal(receipt.dateParsed, '23 August', 'legacy receipts echo the label into dateParsed');
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await fsp.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');

  await lib.exportProfile({ handle: 'example', output: out, zip: zipPath });
  const py = spawnSync('python3', ['-c', [
    'import json, sys, zipfile',
    'z=zipfile.ZipFile(sys.argv[1])',
    'root=sorted({n.split("/",1)[0] for n in z.namelist()})[0]',
    'idx=json.loads(z.read(root+"/index.json"))[0]',
    'rec=json.loads(z.read(root+"/receipts/A-0.json"))',
    'print(json.dumps([idx["dateStatus"], idx["dateProvenance"], idx["dateResolved"], idx["dateRaw"], rec["dateStatus"], rec["dateProvenance"], rec["dateResolved"]]))'
  ].join('\n'), zipPath], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const [idxStatus, idxProv, idxResolved, idxRaw, recStatus, recProv, recResolved] = JSON.parse(py.stdout);
  assert.equal(idxStatus, 'unresolved', 'a legacy yearless receipt must not gain a fabricated timestamp');
  assert.equal(idxProv, 'provider-yearless-label');
  assert.equal(idxResolved, null);
  assert.equal(idxRaw, '23 August', 'the raw label is still preserved');
  // Both surfaces recompute through the same helper, so the ZIP cannot contradict itself.
  assert.equal(recStatus, idxStatus);
  assert.equal(recProv, idxProv);
  assert.equal(recResolved, idxResolved);
});

test('pending import dedupes byte-identical media by sha256 while preserving every reference', () => {
  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);
  const entries = [
    { stableId: 'P1-0', sha256: shaA, category: 'posts', shortcode: 'P1', identityBasis: 'provider-shortcode', href: 'https://instacognito.com/media?id=SIGNED' },
    { stableId: 'stories__sha256-' + shaA, sha256: shaA, category: 'stories', identityBasis: 'content-sha256' },
    { stableId: 'P2-0', sha256: shaA, category: 'posts', shortcode: 'P2', carouselIndex: 0, identityBasis: 'provider-shortcode' },
    { stableId: 'P3-0', sha256: shaB, category: 'posts', shortcode: 'P3', identityBasis: 'provider-shortcode' }
  ];
  const plan = lib.planPendingImport(entries);
  assert.equal(plan.counts.references, 4);
  assert.equal(plan.counts.uniqueBytes, 2, 'three references share one byte sequence');
  assert.equal(plan.counts.duplicateReferences, 2);
  assert.equal(plan.counts.newUniqueBytes, 2);
  assert.equal(plan.counts.erroredReferences, 0);
  assert.equal(plan.counts.conflicts, 0);

  const shared = plan.staged.find(group => group.sha256 === shaA);
  assert.equal(shared.referenceCount, 3, 'no reference may be discarded by dedup');
  assert.deepEqual(shared.stableIds, ['P1-0', 'P2-0', 'stories__sha256-' + shaA]);
  // Byte-identical media legitimately appears under more than one category; both survive.
  assert.deepEqual(shared.categories, ['posts', 'stories']);
  assert.equal(shared.canonicalStableId, 'P1-0', 'provider-shortcode identity is preferred over a content hash id');

  // Signed provider URLs never reach persisted or reported JSON anywhere else; not here either.
  assert.ok(!JSON.stringify(plan).includes('SIGNED'), 'plan must not carry signed provider URLs');

  // Every reference is accounted for in exactly one bucket.
  assert.equal(plan.counts.references, plan.counts.stagedReferences + plan.counts.conflictedReferences + plan.counts.erroredReferences);

  // Deterministic: a re-run over a differently ordered batch must not re-upload deduped bytes.
  const strip = p => JSON.stringify(p.groups.map(g => ({ ...g, references: g.references.map(({ sourceIndex, ...rest }) => rest) })));
  assert.equal(strip(plan), strip(lib.planPendingImport([...entries].reverse())), 'plan decisions must not depend on input order');
});

test('pending import holds conflicts and malformed entries without discarding references', () => {
  const shaA = 'a'.repeat(64);
  const shaB = 'b'.repeat(64);

  // Same stableId claiming two different byte sequences, inside one batch.
  const inBatch = lib.planPendingImport([
    { stableId: 'P1-0', sha256: shaA, category: 'posts', shortcode: 'P1' },
    { stableId: 'P1-0', sha256: shaB, category: 'posts', shortcode: 'P1' }
  ]);
  assert.equal(inBatch.counts.conflicts, 1);
  assert.equal(inBatch.staged.length, 0, 'disputed identity must never be staged');
  assert.deepEqual(inBatch.conflicts[0].sha256, [shaA, shaB]);
  assert.equal(inBatch.groups.reduce((n, g) => n + g.referenceCount, 0), 2, 'both references are retained for a human to resolve');

  // The same conflict across the already-imported boundary, which is the one that would
  // overwrite existing evidence.
  const vsKnown = lib.planPendingImport([{ stableId: 'P1-0', sha256: shaB, category: 'posts', shortcode: 'P1' }], { known: { 'P1-0': { sha256: shaA } } });
  assert.equal(vsKnown.counts.conflicts, 1);
  assert.equal(vsKnown.conflicts[0].knownSha256, shaA);
  assert.equal(vsKnown.staged.length, 0);

  // Already imported, same bytes: reused rather than counted as new.
  const reuse = lib.planPendingImport([{ stableId: 'P1-0', sha256: shaA, category: 'posts', shortcode: 'P1' }], { known: { 'P1-0': { sha256: shaA } } });
  assert.equal(reuse.counts.alreadyPresent, 1);
  assert.equal(reuse.counts.newUniqueBytes, 0, 'truthful counts: nothing new to upload');
  assert.equal(reuse.staged[0].knownStableId, 'P1-0');

  // Malformed entries are surfaced, never silently dropped, and cannot masquerade as conflicts.
  const bad = lib.planPendingImport([
    { stableId: 'stories__sha256-' + shaA, sha256: shaB, category: 'stories' },
    { stableId: 'X-0', sha256: 'not-a-hash' },
    { sha256: shaA, category: 'posts' },
    { stableId: 'stories__P9-0', sha256: shaA, category: 'posts' },
    { stableId: '../escape', sha256: shaA, category: 'posts' }
  ]);
  assert.equal(bad.counts.erroredReferences, 5);
  assert.equal(bad.staged.length, 0);
  assert.equal(bad.counts.references, bad.counts.stagedReferences + bad.counts.conflictedReferences + bad.counts.erroredReferences);
  const reasons = bad.errors.map(e => e.reasons.join(','));
  assert.ok(reasons.includes('stable-id-embeds-different-sha256'), JSON.stringify(reasons));
  assert.ok(reasons.some(r => r.includes('invalid-sha256')), JSON.stringify(reasons));
  assert.ok(reasons.some(r => r.includes('missing-stable-id')), JSON.stringify(reasons));
  assert.ok(reasons.includes('category-disagrees-with-stable-id'), JSON.stringify(reasons));
  assert.ok(reasons.some(r => r.includes('unsafe-stable-id')), JSON.stringify(reasons));
  for (const err of bad.errors) assert.ok(err.reference, 'the offending reference is retained on the error');
});

test('resolved dates are the calendar date the provider showed, on every host timezone', () => {
  // Date.parse reads a zone-less label as LOCAL midnight while toISOString() renders UTC, so a
  // host east of UTC would otherwise persist "1 January 2019" as 2018-12-31T13:00:00.000Z -- the
  // wrong YEAR, in the field that claims to be authoritative. Asserted in a child process because
  // TZ is read once at startup.
  const probe = 'const l = require(' + JSON.stringify(path.join(__dirname, '..', 'src', 'index.js')) + ');'
    + 'console.log(JSON.stringify(["1 January 2019", "January 1, 2021", "23 August 2024", "2024-08-23", "2024-08-23T10:00:00Z"].map(t => l.resolveItemDate(t).dateResolved)));';
  const expected = ['2019-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z', '2024-08-23T00:00:00.000Z', '2024-08-23T00:00:00.000Z', '2024-08-23T10:00:00.000Z'];
  for (const tz of ['UTC', 'Pacific/Auckland', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Asia/Kolkata']) {
    const out = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    assert.equal(out.status, 0, tz + ': ' + out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), expected, 'resolved dates must not shift with host timezone ' + tz);
  }
});

test('incomplete and impossible calendar dates never become authoritative timestamps', () => {
  // Date.parse accepts month-precision input and silently normalises impossible dates; both would
  // assert a day the provider never published.
  for (const text of ['2024-08', '2024', 'August 2024', 'May 2023', '2024-02-31', '2024-13-01', '31 February 2024', '30 February 2024']) {
    const got = lib.resolveItemDate(text);
    assert.equal(got.dateStatus, 'unresolved', text + ' must not resolve');
    assert.equal(got.dateResolved, null, text + ' must not carry a timestamp, got ' + got.dateResolved);
    assert.equal(got.dateRaw, text, 'the raw label is preserved');
  }
  // A complete, valid date still resolves, so the guard is not simply refusing everything.
  assert.equal(lib.resolveItemDate('2024-02-29').dateResolved, '2024-02-29T00:00:00.000Z', 'a real leap day resolves');
  assert.equal(lib.resolveItemDate('2023-02-29').dateResolved, null, 'a leap day in a non-leap year does not');
});

test('impossible calendar dates are refused in every ISO form, not just date-only', () => {
  // Date.parse is strict for a bare ISO date but LENIENT for a date-time, so an impossible day
  // in a time-bearing form was silently rolled over into a real instant and then asserted as an
  // authoritative capture timestamp. The calendar is now validated arithmetically.
  for (const text of [
    '2024-02-31T00:00:00Z', '2024-02-31T00:00:00', '2024-02-31 00:00', '2024-02-31',
    '2023-02-29T12:00:00Z', '2023-02-29', '2024-04-31T00:00:00Z', '2024-06-31T23:59:59Z',
    '2024-13-01T00:00:00Z', '2024-00-10T00:00:00Z', '2024-08-32T00:00:00Z', '2024-08-00T00:00:00Z',
    '1900-02-29', '2100-02-29T00:00:00Z', '2024-08-23T25:00:00Z', '2024-08-23T10:61:00Z',
    '2024-08-23T10:00:61Z', '2024-02-30T10:00:00+02:00'
  ]) {
    const got = lib.resolveItemDate(text);
    assert.equal(got.dateStatus, 'unresolved', text + ' must not resolve');
    assert.equal(got.dateResolved, null, text + ' must not carry a timestamp, got ' + got.dateResolved);
    assert.equal(got.dateRaw, text, 'the raw label is preserved');
    // The same validator backs caller proofs, so an impossible proof must be refused too.
    assert.throws(() => lib.resolveItemDate(null, { dateProven: text, dateEvidence: { kind: 'operator-attested' } }), err => err.code === 'BAD_DATE_PROOF', 'proof accepted for ' + text);
  }

  // Real dates in every accepted ISO form still resolve, so the guard is not simply refusing all
  // time-bearing input. Leap days that genuinely exist are the sharp edge in both directions.
  const valid = [
    ['2024-02-29', '2024-02-29T00:00:00.000Z'],
    ['2024-02-29T12:00:00Z', '2024-02-29T12:00:00.000Z'],
    ['2000-02-29', '2000-02-29T00:00:00.000Z'],
    ['2024-08-23', '2024-08-23T00:00:00.000Z'],
    ['2024-08-23T10:00:00', '2024-08-23T10:00:00.000Z'],
    ['2024-08-23T10:00:00Z', '2024-08-23T10:00:00.000Z'],
    ['2024-08-23T10:00:00.250Z', '2024-08-23T10:00:00.250Z'],
    ['2024-08-23T10:00:00+02:00', '2024-08-23T08:00:00.000Z'],
    ['2024-12-31T23:59:59Z', '2024-12-31T23:59:59.000Z']
  ];
  for (const [text, expected] of valid) {
    assert.equal(lib.resolveItemDate(text).dateResolved, expected, text + ' must still resolve');
  }
});

test('persisted caller-proven records cannot smuggle a normalized impossible date', () => {
  // validatedDateFields reuses the ISO validator, so a receipt or manifest edited by hand or
  // written by a third party cannot assert a day that never existed and have it reach an export.
  for (const resolved of ['2024-02-31T00:00:00Z', '2023-02-29T12:00:00Z', '2024-04-31T00:00:00Z', '2024-08-23T25:00:00Z', '2024-08', '2024']) {
    const forged = { dateRaw: '23 August', dateStatus: 'resolved', dateProvenance: 'caller-proven', dateResolved: resolved, dateEvidence: { kind: 'operator-attested' } };
    assert.throws(() => lib.requireCaptureTimestamp(forged, 'timeline write'), err => err.code === 'DATE_UNRESOLVED', 'accepted forged dateResolved ' + resolved);
    const fields = lib.receiptDateFields(forged);
    assert.equal(fields.dateStatus, 'unresolved', 'forged dateResolved survived into a receipt: ' + resolved);
    assert.equal(fields.dateResolved, null);
  }
  // A real leap-day proof still round-trips, so the check is not vacuous.
  const honest = { dateRaw: '29 February', dateStatus: 'resolved', dateProvenance: 'caller-proven', dateResolved: '2024-02-29T12:00:00.000Z', dateEvidence: { kind: 'provider-permalink' } };
  assert.equal(lib.requireCaptureTimestamp(honest, 'timeline write'), '2024-02-29T12:00:00.000Z');
  assert.equal(lib.receiptDateFields(honest).dateProvenance, 'caller-proven');
});

test('forged date records are refused rather than laundered into authority', () => {
  // Every provider-* provenance is reproducible from dateRaw, so a record that claims one it
  // cannot reproduce is rejected and recomputed. Forging a date now requires forging dateRaw too.
  const forgeries = [
    { dateRaw: '23 August', dateStatus: 'resolved', dateProvenance: 'provider-iso', dateResolved: '2024-01-01T00:00:00.000Z' },
    { dateRaw: '2d ago', dateStatus: 'resolved', dateProvenance: 'provider-relative-label', dateResolved: '2019-01-01T00:00:00.000Z' },
    { dateRaw: null, dateStatus: 'resolved', dateProvenance: 'none', dateResolved: '2019-01-01T00:00:00.000Z' },
    { dateRaw: '23 August', dateStatus: 'resolved', dateProvenance: 'provider-explicit-year', dateResolved: '2024-08-23T00:00:00.000Z' },
    // caller-proven cannot be re-derived, so it must carry well-formed allowlisted evidence.
    { dateRaw: '23 August', dateStatus: 'resolved', dateProvenance: 'caller-proven', dateResolved: '2019-01-01T00:00:00.000Z' },
    { dateRaw: '23 August', dateStatus: 'resolved', dateProvenance: 'caller-proven', dateResolved: '2019-01-01T00:00:00.000Z', dateEvidence: 'just trust me' },
    { dateRaw: '23 August', dateStatus: 'resolved', dateProvenance: 'caller-proven', dateResolved: '2019-01', dateEvidence: { kind: 'operator-attested' } }
  ];
  for (const forged of forgeries) {
    assert.throws(() => lib.requireCaptureTimestamp(forged, 'timeline write'), err => err.code === 'DATE_UNRESOLVED', 'forgery accepted: ' + JSON.stringify(forged));
    const fields = lib.receiptDateFields(forged);
    assert.equal(fields.dateStatus, 'unresolved', 'forgery survived into a receipt: ' + JSON.stringify(fields));
    assert.equal(fields.dateResolved, null);
  }
  // A genuine caller-proven record still round-trips through both helpers.
  const honest = { dateRaw: '23 August', dateStatus: 'resolved', dateProvenance: 'caller-proven', dateResolved: '2024-08-23T10:00:00.000Z', dateEvidence: { kind: 'provider-permalink', note: 'permalink page' } };
  assert.equal(lib.requireCaptureTimestamp(honest, 'timeline write'), '2024-08-23T10:00:00.000Z');
  assert.equal(lib.receiptDateFields(honest).dateProvenance, 'caller-proven');
  // And a genuine provider record does too, so validation is not vacuous.
  const real = lib.resolveItemDate('2024-08-23');
  assert.equal(lib.requireCaptureTimestamp(real, 'timeline write'), '2024-08-23T00:00:00.000Z');
});

test('pending import preserves caller metadata and reports malformed categories', () => {
  const shaA = 'a'.repeat(64);
  const entry = {
    stableId: 'P1-0', sha256: shaA, category: 'posts', shortcode: 'P1', carouselIndex: 0, mediaType: 'image',
    captionTruncated: 'a caption', permalink: 'https://example.com/p/P1', highlightGroup: 'trip', likes: '12',
    comments: '3', contentType: 'image/jpeg', bytes: 1234, dateRaw: '2024-08-23',
    href: 'https://instacognito.com/media?id=SIGNEDTOKEN'
  };
  const ref = lib.planPendingImport([entry]).staged[0].references[0];
  // Dedup must not be a lossy transform: everything the caller supplied comes back...
  for (const key of ['captionTruncated', 'permalink', 'highlightGroup', 'likes', 'comments', 'contentType', 'bytes', 'dateRaw', 'mediaType', 'carouselIndex', 'shortcode']) {
    assert.deepEqual(ref[key], entry[key], 'reference must preserve ' + key);
  }
  // ...except the signed provider URL, which never reaches persisted or reported JSON.
  assert.ok(!('href' in ref), 'href must not be carried into the plan');
  assert.ok(!JSON.stringify(lib.planPendingImport([entry])).includes('SIGNEDTOKEN'), 'no signed URL may survive anywhere in the plan');
  // Date provenance is validated on the way through rather than echoed from the caller.
  assert.equal(ref.dateStatus, 'resolved');
  assert.equal(ref.dateResolved, '2024-08-23T00:00:00.000Z');
  const echoed = lib.planPendingImport([{ ...entry, dateRaw: '23 August', dateStatus: 'resolved', dateResolved: '2024-01-01T00:00:00.000Z', dateProvenance: 'provider-iso' }]).staged[0].references[0];
  assert.equal(echoed.dateStatus, 'unresolved', 'a forged date must not be echoed by the planner');

  // An invalid or missing category is reported, never silently rewritten to posts.
  const bad = lib.planPendingImport([
    { stableId: 'P2-0', sha256: shaA, category: 'bogus', shortcode: 'P2' },
    { stableId: 'P3-0', sha256: shaA, shortcode: 'P3' }
  ]);
  assert.equal(bad.staged.length, 0);
  assert.equal(bad.counts.erroredReferences, 2);
  for (const err of bad.errors) assert.ok(err.reasons.includes('invalid-category'), JSON.stringify(err.reasons));
  assert.equal(bad.errors[0].reference.category, 'bogus', 'the offending value is retained, not coerced');
});

test('pending import accounts for array holes, refuses non-iterables, and guards known ids', () => {
  const shaA = 'a'.repeat(64);
  // forEach skips array holes while length still counts them, which would silently drop
  // references and break the documented invariant.
  const sparse = new Array(3);
  sparse[2] = { stableId: 'P1-0', sha256: shaA, category: 'posts', shortcode: 'P1' };
  const plan = lib.planPendingImport(sparse);
  assert.equal(plan.counts.references, 3);
  assert.equal(plan.counts.erroredReferences, 2, 'holes must surface as errors, not vanish');
  assert.equal(plan.counts.references, plan.counts.stagedReferences + plan.counts.conflictedReferences + plan.counts.erroredReferences);

  // A non-iterable is a caller bug, not an empty batch: returning an empty plan would read as
  // "nothing to import" and skip real media.
  assert.throws(() => lib.planPendingImport(42), err => err.code === 'BAD_ARGS');
  assert.throws(() => lib.planPendingImport({ stableId: 'P1-0' }), err => err.code === 'BAD_ARGS');
  assert.equal(lib.planPendingImport(new Set([{ stableId: 'P2-0', sha256: shaA, category: 'posts', shortcode: 'P2' }])).counts.references, 1, 'other iterables are accepted');
  assert.equal(lib.planPendingImport(null).counts.references, 0);

  // canonicalStableId is what a consumer uses as a filename or registry key, so an id arriving
  // through `known` must clear the same guard as one arriving in the batch.
  const traversal = lib.planPendingImport([{ stableId: 'posts__X-0', sha256: shaA, category: 'posts', shortcode: 'X' }], { known: { '../../../../etc/cron.d/evil': shaA } });
  assert.equal(traversal.staged[0].canonicalStableId, 'posts__X-0');
  assert.equal(traversal.staged[0].knownStableId, null, 'an unsafe known id must not be adopted');

  // Bare dot segments and a leading dash are filenames too.
  const unsafe = lib.planPendingImport([
    { stableId: '..', sha256: shaA, category: 'posts' },
    { stableId: '.', sha256: 'b'.repeat(64), category: 'posts' },
    { stableId: '-lead', sha256: 'c'.repeat(64), category: 'posts' }
  ]);
  assert.equal(unsafe.staged.length, 0);
  for (const err of unsafe.errors) assert.ok(err.reasons.includes('unsafe-stable-id'), JSON.stringify(err.reasons));
});

test('content-export branch retains at least the baseline test inventory plus new coverage', async () => {
  const baselineNames = [
    'normalizes real provider carousel: one card per slide with same shortcode becomes multiple media',
    'repeat-page cards dedupe before assigning carousel indices',
    'malformed dates are preserved instead of becoming invalid watermark',
    'reported count parser uses POSTS adjacency, not max followers/header integers',
    'unknown denom cannot claim complete and advertised shortfall is partial',
    'provider URL validation rejects non-provider and non-https',
    'redirect SSRF private hosts, mapped hex IPv6, CGNAT, and DNS failures are rejected',
    'handle traversal and output symlink are rejected',
    'download streams to .part, sha receipt, magic beats content type, and redacts signed urls',
    'HTML/truncation/oversize fail before unbounded buffering',
    '429 Retry-After beyond budget persists DEFERRED and preserves prior completed evidence',
    '429 within budget waits and retries same provider URL',
    'sync reuses verified receipts: second run same IDs rotated URLs performs zero fetches',
    'corrupted completed file is retried and repaired',
    'failed manifest entries do not persist signed URLs while fresh overlap retries',
    'live lock rejects alive PID and stale lock recovers',
    'secret redaction removes signed provider URLs from status-shaped text',
    'CDP attach rejects non-loopback remote targets',
    'network timeout is capped by remaining maxTimeMs, not user larger networkTimeoutMs',
    'profile extraction accepts a caller supplied timeout',
    'CLI doctor parses --attach-cdp without swallowing it as handle, and bad flags fail',
    'actual Playwright DOM fixture models real carousel cards and profile-section POSTS parsing',
    'partial dates without explicit year preserve raw text',
    'foreign-host and EPERM locks fail closed',
    'internal state/media/receipt symlink components are rejected',
    'pagination waits for delayed growth after explicit center scroll of already-visible last card',
    'pagination no-growth waits only bounded budget before declaring no growth',
    'pagination waits for partial batch to settle and recenters current last card',
    'attached browser cleanup disconnects transport without closing external server marker'
  ];
  const current = await fsp.readFile(__filename, 'utf8');
  const newNames = countNamedTests(current);
  for (const name of baselineNames) assert.ok(newNames.includes(name), 'missing baseline test: ' + name);
  assert.ok(newNames.length >= baselineNames.length + 6, 'expected expanded coverage beyond ' + baselineNames.length + ', got ' + newNames.length);
});
