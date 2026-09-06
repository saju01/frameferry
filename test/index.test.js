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

// --- bounded, request-aware continuation grace -------------------------------------------------
// Every fixture below is served entirely from page.route: a catch-all route intercepts the
// document, the continuation endpoint, and anything else, so no request can reach the network.
const CONTINUATION_FIXTURE_URL = 'https://instacognito.com/en/photo';

function continuationFixtureHtml(providerScript, extraHtml = '') {
  const card = (marker, id) => '<article class="post-card" data-marker="' + marker + '"><span class="likes-trigger" data-id="' + id + '"><span>5</span></span><a class="content-download-btn" href="https://instacognito.com/media?id=' + id + '">d</a></article>';
  const lead = Array.from({ length: 8 }, (_, i) => card('lead', 'P' + (i + 1))).join('');
  return '<!doctype html><style>body{margin:0}#post-container{display:block}.post-card{display:block;height:300px;box-sizing:border-box;border:1px solid #ccc}</style>'
    + extraHtml
    + '<div id="post-container">' + lead + card('parent', 'PLAST') + '</div>'
    + '<script>(function(){'
    + 'const attr = "data-ff-pagination-sentinel";'
    + 'const Native = window.IntersectionObserver;'
    + 'function Probed(cb, opts){ const o = new Native(cb, opts); const nat = o.observe.bind(o); o.observe = function(target){ for (const m of document.querySelectorAll("[" + attr + "]")) m.removeAttribute(attr); target.setAttribute(attr, "1"); return nat(target); }; return o; }'
    + 'Probed.prototype = Native.prototype; window.IntersectionObserver = Probed;'
    + 'window.intersections = 0; window.appended = 0; window.lastStatus = null;'
    + 'window.appendBatch = function(n){ for (let i = 0; i < n; i++) { window.appended++; document.getElementById("post-container").insertAdjacentHTML("beforeend", \'<article class="post-card" data-marker="next"><span class="likes-trigger" data-id="PNEXT\' + window.appended + \'"><span>1</span></span><a class="content-download-btn" href="https://instacognito.com/media?id=next\' + window.appended + \'">d</a></article>\'); } };'
    + 'window.sentinel = document.querySelector(\'#post-container .post-card[data-marker="parent"]\');'
    + providerScript
    + '})();</script>';
}

async function serveContinuationFixture(page, providerScript, apiHandler, extraHtml = '') {
  const html = continuationFixtureHtml(providerScript, extraHtml);
  const seen = { api: 0, unexpected: [] };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/en/photo') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (url.pathname === '/api/posts') { seen.api++; return apiHandler(route, seen); }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    seen.unexpected.push(url.href);
    return route.abort();
  });
  await page.goto(CONTINUATION_FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  const geometry = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#post-container .post-card')];
    const marked = document.querySelector('[data-ff-pagination-sentinel]');
    return { markedIndex: cards.indexOf(marked), markedTop: marked ? marked.getBoundingClientRect().top : null, viewport: window.innerHeight };
  });
  assert.equal(geometry.markedIndex, 8, 'observe() must mark the sentinel the fixture provider watches');
  assert.ok(geometry.markedTop > geometry.viewport + 200, 'sentinel must start outside viewport + rootMargin; top=' + geometry.markedTop);
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(() => window.intersections), 0, 'observer must not fire before the helper scrolls');
  return seen;
}

const jsonRoute = (body, extra = {}) => route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body), ...extra });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The helper's fixed pause between scrolling away and re-centering the sentinel.
const REARM_PAUSE_BUDGET_MS = 250;

test('continuation grace re-arms the observed sentinel when the first trigger fires no request', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // The Sydney trace: the observed sentinel is present and valid, the first bounded trigger
    // produces no /api/posts request at all, and the second trigger paginates normally.
    const seen = await serveContinuationFixture(page, 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; if (window.intersections < 2) return; io.disconnect(); fetch("/api/posts", { method: "POST", body: "{}" }).then(r => r.json()).then(d => window.appendBatch(d.count)); }, { rootMargin: "200px" }); io.observe(window.sentinel);', jsonRoute({ count: 3 }));
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      assert.equal(before.count, 9);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 25000, growthWaitMs: 1200, graceWaitMs: 4000, inFlightSettleMs: 4000, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      assert.equal(after.grew, true, 'a first window with no continuation request must not be terminal');
      assert.equal(after.graceAttemptsUsed, 1, 'exactly one bounded grace attempt');
      assert.equal(after.sentinelSource, 'observed');
      assert.equal(after.blocked, null);
      assert.equal(after.continuationRequests, 1, 'the continuation request fired inside the grace window');
      assert.equal(after.count, 12);
      assert.ok(after.ids.includes('PNEXT1'), 'new batch must be observed: ' + JSON.stringify(after.ids));
      assert.equal(await page.evaluate(() => window.intersections), 2, 'the grace attempt must produce a fresh intersection transition');
      assert.equal(seen.api, 1);
      assert.equal(monitor.count(), 1);
      assert.equal(monitor.inFlight(), 0);
      assert.equal(monitor.denial(), null);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('continuation in-flight response settles without consuming a grace attempt', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const seen = await serveContinuationFixture(page, 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; io.disconnect(); fetch("/api/posts", { method: "POST", body: "{}" }).then(r => r.json()).then(d => window.appendBatch(d.count)); }, { rootMargin: "200px" }); io.observe(window.sentinel);', async route => { await sleep(1500); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 2 }) }); });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 25000, growthWaitMs: 700, graceWaitMs: 4000, inFlightSettleMs: 4000, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const elapsed = Date.now() - started;
      assert.equal(after.grew, true, 'a response still in flight must be allowed to settle');
      assert.equal(after.graceAttemptsUsed, 0, 'settlement is not a retry and must not spend the grace budget');
      assert.equal(after.continuationRequests, 1);
      assert.equal(after.blocked, null);
      assert.equal(after.count, 11);
      assert.ok(after.ids.includes('PNEXT1'), 'new batch must be observed: ' + JSON.stringify(after.ids));
      assert.ok(elapsed < 6000, 'settlement stays bounded; elapsed=' + elapsed);
      assert.equal(await page.evaluate(() => window.intersections), 1, 'no re-arm was needed');
      assert.equal(seen.api, 1);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('continuation grace stays bounded when the provider never fires and skips heuristic sentinels', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const seen = await serveContinuationFixture(page, 'const io = new IntersectionObserver(function(entries){ if (entries[0].isIntersecting) window.intersections++; }, { rootMargin: "200px" }); io.observe(window.sentinel);', jsonRoute({ count: 0 }));
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const maxTimeMs = 30000;
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs, growthWaitMs: 600, graceWaitMs: 600, inFlightSettleMs: 600, graceAttempts: 1, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const elapsed = Date.now() - started;
      assert.equal(after.grew, false, 'a stalled provider still terminates');
      assert.equal(after.graceAttemptsUsed, 1, 'at most graceAttempts extra attempts');
      assert.equal(after.continuationRequests, 0);
      assert.equal(after.blocked, null);
      assert.equal(after.count, 9);
      assert.ok(elapsed < 600 + 600 + 600 + 2500, 'total wait stays within growthWaitMs + graceWaitMs + inFlightSettleMs plus overhead; elapsed=' + elapsed);
      assert.ok(elapsed < maxTimeMs, 'never exceeds the global deadline; elapsed=' + elapsed);
      assert.equal(seen.api, 0);

      // A heuristic sentinel is not authoritative, so it keeps today's fail-closed behavior.
      await page.evaluate(() => document.querySelector('[data-ff-pagination-sentinel]').removeAttribute('data-ff-pagination-sentinel'));
      const heuristicStarted = Date.now();
      const heuristic = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started: heuristicStarted, maxTimeMs, growthWaitMs: 600, graceWaitMs: 600, inFlightSettleMs: 600, graceAttempts: 1, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const heuristicElapsed = Date.now() - heuristicStarted;
      assert.equal(heuristic.grew, false);
      assert.notEqual(heuristic.sentinelSource, 'observed');
      assert.equal(heuristic.graceAttemptsUsed, 0, 'heuristic sentinels get no grace');
      assert.ok(heuristicElapsed < 600 + 2000, 'heuristic path keeps the single bounded window; elapsed=' + heuristicElapsed);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('continuation denial with 429 Retry-After blocks instead of retrying', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const seen = await serveContinuationFixture(page, 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; io.disconnect(); fetch("/api/posts", { method: "POST", body: "{}" }).then(r => { window.lastStatus = r.status; }); }, { rootMargin: "200px" }); io.observe(window.sentinel);', route => route.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '120' }, body: '{"error":"rate limited"}' }));
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 30000, growthWaitMs: 700, graceWaitMs: 5000, inFlightSettleMs: 5000, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const elapsed = Date.now() - started;
      assert.equal(after.grew, false);
      assert.ok(after.blocked, 'a provider denial must be reported, not retried');
      assert.equal(after.blocked.status, 429);
      assert.match(after.blocked.reason, /429/);
      assert.equal(typeof after.blocked.retryAt, 'string');
      assert.ok(Date.parse(after.blocked.retryAt) > Date.now(), 'Retry-After must be parsed forward: ' + after.blocked.retryAt);
      assert.equal(after.graceAttemptsUsed, 0, 'never retry into a denial');
      assert.equal(after.continuationRequests, 1);
      assert.ok(elapsed < 3000, 'denial returns without spending the grace or settlement windows; elapsed=' + elapsed);
      assert.equal(await page.evaluate(() => window.lastStatus), 429);
      assert.equal(seen.api, 1);
      assert.ok(monitor.denial(), 'monitor must surface the denial');
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('continuation request that returns no new cards is a terminal boundary with no grace retry', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const seen = await serveContinuationFixture(page, 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; io.disconnect(); fetch("/api/posts", { method: "POST", body: "{}" }).then(r => r.json()).then(d => window.appendBatch(d.count)); }, { rootMargin: "200px" }); io.observe(window.sentinel);', jsonRoute({ count: 0 }));
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 30000, growthWaitMs: 900, graceWaitMs: 5000, inFlightSettleMs: 5000, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const elapsed = Date.now() - started;
      assert.equal(after.grew, false);
      assert.equal(after.continuationRequests, 1, 'the provider answered this window');
      assert.equal(after.graceAttemptsUsed, 0, 'a served continuation with no new cards is a real boundary');
      assert.equal(after.blocked, null);
      assert.equal(after.count, 9);
      assert.ok(elapsed < 3000, 'no extra window is spent on a terminal boundary; elapsed=' + elapsed);
      assert.equal(seen.api, 1);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

// --- adversarial continuation regressions ------------------------------------------------------
// Each of these reproduces a defect an independent review found in the first grace implementation.
async function drainContinuation(page, monitor, budgetMs = 6000) {
  const until = Date.now() + budgetMs;
  while (monitor.inFlight() > 0 && Date.now() < until) await page.waitForTimeout(100);
}

test('a latched continuation denial stops the next call before it scrolls or triggers again', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // The observer stays connected, so any fresh intersection transition triggers another POST.
    const seen = await serveContinuationFixture(page, 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ window.lastStatus = r.status; }); }, { rootMargin: "200px" }); io.observe(window.sentinel);', route => route.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '90' }, body: '{"error":"rate limited"}' }));
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const opts = { maxTimeMs: 30000, growthWaitMs: 700, graceWaitMs: 4000, inFlightSettleMs: 4000, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor };
      const first = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started: Date.now(), ...opts });
      assert.ok(first.blocked, 'first call must record the denial');
      assert.equal(seen.api, 1);
      assert.equal(await page.evaluate(() => window.intersections), 1);

      // The next page iteration starts from wherever the provider UI left the viewport; the
      // sentinel is no longer centered, so a fresh recenter WOULD be a real trigger.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300);
      const startedSecond = Date.now();
      const second = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started: startedSecond, ...opts });
      const elapsed = Date.now() - startedSecond;
      assert.equal(seen.api, 1, 'never trigger a second continuation request into a latched denial');
      assert.equal(await page.evaluate(() => window.intersections), 1, 'no fresh intersection may be produced after a denial');
      assert.equal(second.recenterCount, 0, 'a denied call must not scroll');
      assert.equal(second.sentinelSource, null, 'a denied call must return without centering anything');
      assert.ok(second.blocked, 'the latched denial must still block');
      assert.equal(second.blocked.status, 429);
      assert.equal(second.grew, false);
      assert.equal(second.graceAttemptsUsed, 0);
      assert.ok(elapsed < 500, 'a denied call returns immediately; elapsed=' + elapsed);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('growth in the same window as a recorded denial still reports the denial', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // A batch already in the provider's hands renders while the NEXT continuation is refused.
    const seen = await serveContinuationFixture(page, 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; io.disconnect(); fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ window.lastStatus = r.status; }); setTimeout(function(){ window.appendBatch(2); }, 200); }, { rootMargin: "200px" }); io.observe(window.sentinel);', route => route.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '60' }, body: '{"error":"rate limited"}' }));
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 30000, growthWaitMs: 4000, graceWaitMs: 4000, inFlightSettleMs: 4000, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      assert.equal(after.grew, true, 'growth that really happened is still reported');
      assert.equal(after.count, 11);
      assert.ok(after.blocked, 'a denial recorded during a growing window must not be dropped');
      assert.equal(after.blocked.status, 429);
      assert.equal(typeof after.blocked.retryAt, 'string');
      assert.equal(after.graceAttemptsUsed, 0);
      assert.equal(after.continuationRequests, 1);
      assert.equal(seen.api, 1);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('a visible challenge behind a hidden captcha node is still detected as blocked', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // The hidden node comes FIRST in DOM order, so a .first() visibility probe on the selector
    // list looks at the wrong element and misses the live challenge below it.
    const challenge = '<div class="g-recaptcha" style="display:none">hidden widget</div><form id="challenge-form" style="display:block;width:320px;height:90px">verify you are human</form>';
    const seen = await serveContinuationFixture(page, 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; if (window.intersections < 2) return; io.disconnect(); fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ return r.json(); }).then(function(d){ window.appendBatch(d.count); }); }, { rootMargin: "200px" }); io.observe(window.sentinel);', jsonRoute({ count: 2 }), challenge);
    const visibility = await page.evaluate(() => ({ hidden: document.querySelector('.g-recaptcha').getBoundingClientRect().height, shown: document.querySelector('#challenge-form').getBoundingClientRect().height }));
    assert.equal(visibility.hidden, 0, 'the masking node must really be hidden');
    assert.ok(visibility.shown > 0, 'the real challenge must really be visible');
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 30000, growthWaitMs: 700, graceWaitMs: 4000, inFlightSettleMs: 4000, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      assert.equal(after.grew, false, 'a visible challenge must never be paginated through');
      assert.ok(after.blocked, 'the challenge must be reported');
      assert.match(after.blocked.reason, /challenge|captcha/);
      assert.equal(after.graceAttemptsUsed, 0, 'never grace-retry into a challenge');
      assert.equal(after.count, 9);
      assert.equal(seen.api, 0, 'no continuation request may be issued while a challenge is up');
      assert.equal(await page.evaluate(() => window.intersections), 0, 'no trigger may be produced while a challenge is up');
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('a continuation request pending since before entry blocks grace instead of racing it', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const seen = await serveContinuationFixture(page, 'window.startContinuation = function(){ fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ return r.json(); }).then(function(d){ window.appendBatch(d.count); }); }; const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; if (window.intersections < 2) return; window.startContinuation(); }, { rootMargin: "200px" }); io.observe(window.sentinel);', async route => { await sleep(2500); try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0 }) }); } catch { /* page may already be gone */ } });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      // The request starts before the helper is entered, so its count delta inside the call is
      // zero even though it is still pending.
      await page.evaluate(() => window.startContinuation());
      await page.waitForTimeout(200);
      assert.equal(monitor.count(), 1);
      assert.equal(monitor.inFlight(), 1);
      const before = await lib.getRenderedCardState(page);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 30000, growthWaitMs: 600, graceWaitMs: 600, inFlightSettleMs: 600, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      assert.equal(seen.api, 1, 'never run two continuation requests at once');
      assert.equal(after.graceAttemptsUsed, 0, 'a still-pending request must not be raced by a re-arm');
      assert.equal(monitor.count(), 1);
      assert.equal(after.continuationRequests, 0, 'the pending request predates this call');
      assert.equal(after.grew, false);
      assert.equal(after.blocked, null);
      // The opening recenter used to fire here, harmless only because this fixture needs two
      // intersections before it fetches; an unanswered entry request now suppresses it outright.
      assert.equal(await page.evaluate(() => window.intersections), 0, 'nothing may be triggered while the entry request is unanswered, not even the opening recenter');
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
      await drainContinuation(page, monitor);
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('a request issued by a grace re-arm gets its own bounded settlement extension', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const seen = await serveContinuationFixture(page, 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; if (window.intersections < 2) return; io.disconnect(); fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ return r.json(); }).then(function(d){ window.appendBatch(d.count); }); }, { rootMargin: "200px" }); io.observe(window.sentinel);', async route => { await sleep(1200); try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 1 }) }); } catch { /* page may already be gone */ } });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const maxTimeMs = 30000;
      const growthWaitMs = 600;
      const graceWaitMs = 600;
      const inFlightSettleMs = 3000;
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs, growthWaitMs, graceWaitMs, inFlightSettleMs, graceAttempts: 1, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const elapsed = Date.now() - started;
      assert.equal(after.grew, true, 'the helper must not report a boundary while its own trigger is in flight');
      assert.equal(after.graceAttemptsUsed, 1);
      assert.equal(after.continuationRequests, 1);
      assert.equal(after.blocked, null);
      assert.equal(after.count, 10);
      assert.ok(after.ids.includes('PNEXT1'), 'the late batch must be observed: ' + JSON.stringify(after.ids));
      // One settlement before grace plus one per grace attempt, nothing more.
      const bound = growthWaitMs + inFlightSettleMs + 1 * (graceWaitMs + inFlightSettleMs);
      assert.ok(elapsed < bound + 2000, 'settlement stays inside the graceAttempts + 1 bound (' + bound + 'ms); elapsed=' + elapsed);
      assert.ok(elapsed < maxTimeMs, 'never exceeds the global deadline; elapsed=' + elapsed);
      assert.equal(seen.api, 1);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
      await drainContinuation(page, monitor);
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('a cadence recenter onto a newly marked sentinel must not trigger into a latched denial', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // An already-pending batch renders mid-window: the provider rebuilds its observer on the new
    // last card and the probe re-marks THAT element, so the next cadence recenter scrolls to an
    // element which has never intersected. That scroll is a real trigger, even though the sentinel
    // the window started on was already centered.
    const provider = 'window.secondFires = 0;'
      + 'window.batch2 = function(){ window.appendBatch(4); const cards = document.querySelectorAll("#post-container .post-card"); window.io2 = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.secondFires++; fetch("/api/posts", { method: "POST", body: "{}" }); }, { rootMargin: "200px" }); window.io2.observe(cards[cards.length - 1]); };'
      + 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; io.disconnect(); fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ window.lastStatus = r.status; }); setTimeout(window.batch2, 300); }, { rootMargin: "200px" }); io.observe(window.sentinel);';
    const seen = await serveContinuationFixture(page, provider, route => route.fulfill({ status: 429, contentType: 'application/json', headers: { 'retry-after': '90' }, body: '{"error":"rate limited"}' }));
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 30000, growthWaitMs: 2500, graceWaitMs: 4000, inFlightSettleMs: 4000, settleMs: 1500, recenterEveryMs: 500, maxRecenters: 3, continuationMonitor: monitor });
      assert.equal(seen.api, 1, 'no recenter may trigger another continuation request after a denial');
      assert.equal(await page.evaluate(() => window.secondFires), 0, 'the re-marked sentinel must never be scrolled into view while denied');
      assert.equal(after.grew, true, 'the batch that did render is still reported');
      assert.equal(after.count, 13);
      assert.ok(after.blocked, 'the denial must be reported alongside the growth');
      assert.equal(after.blocked.status, 429);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('a challenge that appears mid-window survives a growing return', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // The monitor latches HTTP 429/403 only; a challenge is visible in the DOM and nowhere else,
    // so a growing return that never re-checks it drops the fact that the provider stopped us.
    const challenge = '<form id="challenge-form" style="display:none;width:320px;height:90px">verify you are human</form>';
    const provider = 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; io.disconnect(); setTimeout(function(){ window.appendBatch(2); }, 200); setTimeout(function(){ document.getElementById("challenge-form").style.display = "block"; }, 250); }, { rootMargin: "200px" }); io.observe(window.sentinel);';
    const seen = await serveContinuationFixture(page, provider, jsonRoute({ count: 0 }), challenge);
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 30000, growthWaitMs: 3000, graceWaitMs: 4000, inFlightSettleMs: 4000, settleMs: 400, recenterEveryMs: 1000, maxRecenters: 1, continuationMonitor: monitor });
      assert.equal(after.grew, true);
      assert.equal(after.count, 11);
      assert.ok(after.blocked, 'a challenge raised mid-window must not be dropped by a growing return');
      assert.match(after.blocked.reason, /challenge|captcha/);
      assert.equal(after.blocked.status, null, 'a DOM challenge carries no HTTP status');
      assert.equal(after.graceAttemptsUsed, 0);
      assert.equal(seen.api, 0, 'no continuation request may be issued once the challenge is up');
      assert.equal(await page.evaluate(() => window.intersections), 1);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('the opening recenter waits for a continuation already pending at entry', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // This provider paginates on its FIRST intersection, so the opening recenter is itself a
    // trigger and would run a second request concurrently with the one already pending.
    const provider = 'window.startContinuation = function(){ fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ return r.json(); }).then(function(d){ window.appendBatch(d.count); }); };'
      + 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; io.disconnect(); window.startContinuation(); }, { rootMargin: "200px" }); io.observe(window.sentinel);';
    const seen = await serveContinuationFixture(page, provider, async route => { await sleep(800); try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 2 }) }); } catch { /* page may already be gone */ } });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      await page.evaluate(() => window.startContinuation());
      await page.waitForTimeout(200);
      assert.equal(monitor.inFlight(), 1, 'one continuation is pending before the helper is entered');
      const before = await lib.getRenderedCardState(page);
      const maxTimeMs = 30000;
      const growthWaitMs = 600;
      const graceWaitMs = 600;
      const inFlightSettleMs = 3000;
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs, growthWaitMs, graceWaitMs, inFlightSettleMs, graceAttempts: 1, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const elapsed = Date.now() - started;
      assert.equal(seen.api, 1, 'the opening recenter must not run a second continuation request');
      assert.equal(await page.evaluate(() => window.intersections), 0, 'nothing may be scrolled while a continuation is pending');
      assert.equal(after.grew, true, 'the pending response must still be allowed to settle');
      assert.equal(after.count, 11);
      assert.equal(after.sentinelSource, 'observed', 'the sentinel is still reported, read without scrolling');
      assert.equal(after.recenterCount, 0, 'settling triggers nothing');
      assert.equal(after.graceAttemptsUsed, 0);
      assert.equal(after.blocked, null);
      const bound = inFlightSettleMs + growthWaitMs + graceWaitMs + inFlightSettleMs;
      assert.ok(elapsed < bound + 2000, 'entry settlement draws on the same graceAttempts + 1 budget (' + bound + 'ms); elapsed=' + elapsed);
      assert.ok(elapsed < maxTimeMs, 'never exceeds the global deadline; elapsed=' + elapsed);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
      await drainContinuation(page, monitor);
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

// --- race windows between a decision and the scroll it authorises ------------------------------
// A guard is only as good as the instant it runs in. Each test below lets the world change in the
// gap between a check and the pagination trigger that check permitted, and asserts the trigger
// does not happen anyway.

test('a challenge that appears during the re-arm pause stops the grace recenter', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // The re-arm scrolls fully away, pauses for the browser to deliver the leave, then centers
    // the sentinel again. That second scroll is a real pagination trigger, and the pre-re-arm
    // block check is already stale by the time it happens: the challenge here is rendered by the
    // scroll-to-top itself, which is the only scroll to the document origin in the whole call.
    const challenge = '<form id="challenge-form" style="display:none;width:320px;height:90px">verify you are human</form>';
    const provider = 'window.armedAt = null;'
      + 'window.addEventListener("scroll", function(){ if (window.intersections >= 1 && window.scrollY < 5 && window.armedAt === null) { window.armedAt = Date.now(); document.getElementById("challenge-form").style.display = "block"; } });'
      // The Sydney shape: the first bounded trigger issues no request, so the call reaches grace.
      + 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; if (window.intersections < 2) return; io.disconnect(); fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ return r.json(); }).then(function(d){ window.appendBatch(d.count); }); }, { rootMargin: "200px" }); io.observe(window.sentinel);';
    const seen = await serveContinuationFixture(page, provider, jsonRoute({ count: 3 }), challenge);
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 30000, growthWaitMs: 700, graceWaitMs: 4000, inFlightSettleMs: 4000, graceAttempts: 1, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const revealed = await page.evaluate(() => ({ armedAt: window.armedAt, shown: document.getElementById('challenge-form').getBoundingClientRect().height }));
      assert.ok(revealed.armedAt, 'the fixture must have revealed the challenge during the re-arm pause');
      assert.ok(revealed.shown > 0, 'the challenge must really be visible');
      assert.equal(seen.api, 0, 'no continuation request may be issued after a challenge appears mid-re-arm');
      assert.equal(await page.evaluate(() => window.intersections), 1, 'the re-arm must not complete a fresh intersection into a challenge');
      assert.equal(after.recenterCount, 1, 'only the opening recenter may have scrolled');
      assert.equal(after.graceAttemptsUsed, 1, 'the attempt was spent, then abandoned before triggering');
      assert.equal(after.grew, false);
      assert.ok(after.blocked, 'a challenge seen during the re-arm pause must be reported');
      assert.match(after.blocked.reason, /challenge|captcha/);
      assert.equal(after.continuationRequests, 0);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('an entry settlement that expires with the request still pending must not open the recenter', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // The provider paginates on its FIRST intersection, so the opening recenter is a trigger.
    const provider = 'window.startContinuation = function(){ fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ return r.json(); }).then(function(d){ window.appendBatch(d.count); }); };'
      + 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; io.disconnect(); window.startContinuation(); }, { rootMargin: "200px" }); io.observe(window.sentinel);';
    // Far slower than the settlement window: the request is still unanswered when it expires.
    const seen = await serveContinuationFixture(page, provider, async route => { await sleep(3000); try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0 }) }); } catch { /* page may already be gone */ } });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      await page.evaluate(() => window.startContinuation());
      await page.waitForTimeout(200);
      assert.equal(monitor.inFlight(), 1, 'one continuation is pending before the helper is entered');
      const before = await lib.getRenderedCardState(page);
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs: 30000, growthWaitMs: 400, graceWaitMs: 400, inFlightSettleMs: 400, graceAttempts: 1, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const elapsed = Date.now() - started;
      // An elapsed settlement window is not evidence that the request is stale, and it is not
      // permission to put a second continuation on the wire beside the first.
      assert.equal(seen.api, 1, 'an expired settlement must not authorise a second continuation request');
      assert.equal(monitor.inFlight(), 1, 'the original request is still pending at return');
      assert.equal(await page.evaluate(() => window.intersections), 0, 'nothing may be scrolled while the entry request is unanswered');
      assert.equal(after.recenterCount, 0, 'a still-pending entry request must not be raced by the opening recenter');
      assert.equal(after.sentinelSource, 'observed', 'the sentinel is still reported, read without scrolling');
      assert.equal(after.grew, false);
      assert.equal(after.blocked, null, 'nothing was denied; the pending request alone is the reason');
      assert.equal(after.graceAttemptsUsed, 0);
      assert.equal(after.continuationRequests, 0, 'the pending request predates this call');
      assert.ok(elapsed < 2500, 'the call returns on the expired settlement, not after the pending request; elapsed=' + elapsed);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
      await drainContinuation(page, monitor);
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('a global deadline that elapses during the entry wait must not open the recenter', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const provider = 'window.startContinuation = function(){ fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ return r.json(); }).then(function(d){ window.appendBatch(d.count); }); };'
      + 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; io.disconnect(); window.startContinuation(); }, { rootMargin: "200px" }); io.observe(window.sentinel);';
    // This one answers inside the settlement window and brings back nothing, so the request is
    // settled and undenied when the window ends: the only thing left to stop a trigger is the
    // global deadline, which the wait itself consumed.
    const seen = await serveContinuationFixture(page, provider, async route => { await sleep(300); try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 0 }) }); } catch { /* page may already be gone */ } });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      await page.evaluate(() => window.startContinuation());
      await page.waitForTimeout(200);
      assert.equal(monitor.inFlight(), 1, 'one continuation is pending before the helper is entered');
      const before = await lib.getRenderedCardState(page);
      const maxTimeMs = 1200;
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs, growthWaitMs: 5000, graceWaitMs: 5000, inFlightSettleMs: 5000, graceAttempts: 1, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= maxTimeMs - 100, 'the entry wait must have consumed the whole deadline; elapsed=' + elapsed);
      assert.equal(seen.api, 1, 'an expired deadline must not authorise a continuation with no window left to observe it');
      assert.equal(monitor.inFlight(), 0, 'the entry request was answered, so only the deadline can stop the trigger');
      assert.equal(await page.evaluate(() => window.intersections), 0, 'nothing may be scrolled once the deadline is gone');
      assert.equal(after.recenterCount, 0);
      assert.equal(after.sentinelSource, 'observed');
      assert.equal(after.grew, false);
      assert.equal(after.blocked, null);
      assert.equal(after.graceAttemptsUsed, 0);
      assert.ok(elapsed < maxTimeMs + 2000, 'the call still returns promptly after the deadline; elapsed=' + elapsed);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
      await drainContinuation(page, monitor);
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('a continuation started by the re-arm scroll-to-top is settled, not abandoned as no growth', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // Refusing to recenter over a request the re-arm pause woke is correct; concluding from that
    // refusal that the provider has nothing left is not. The request here returns real cards, so
    // reporting no growth would truncate the backfill with time still on the clock.
    const provider = 'window.armedAt = null;'
      + 'window.startContinuation = function(){ fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ return r.json(); }).then(function(d){ window.appendBatch(d.count); }); };'
      // The re-arm scroll-to-top is the only scroll to the document origin in the whole call.
      + 'window.addEventListener("scroll", function(){ if (window.intersections >= 1 && window.scrollY < 5 && window.armedAt === null) { window.armedAt = Date.now(); window.startContinuation(); } });'
      // The first bounded trigger is silent, so the call reaches grace; the observer stays
      // connected, so any further recenter would be visible as another intersection.
      + 'const io = new IntersectionObserver(function(entries){ if (!entries[0].isIntersecting) return; window.intersections++; }, { rootMargin: "200px" }); io.observe(window.sentinel);';
    const seen = await serveContinuationFixture(page, provider, async route => { await sleep(1000); try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ count: 2 }) }); } catch { /* page may already be gone */ } });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const before = await lib.getRenderedCardState(page);
      assert.equal(before.count, 9);
      const maxTimeMs = 30000;
      const growthWaitMs = 700;
      const graceWaitMs = 4000;
      const inFlightSettleMs = 4000;
      const started = Date.now();
      const after = await lib.scrollLastCardCenterAndWaitForGrowth(page, before, { started, maxTimeMs, growthWaitMs, graceWaitMs, inFlightSettleMs, graceAttempts: 1, settleMs: 300, maxRecenters: 1, continuationMonitor: monitor });
      const elapsed = Date.now() - started;
      assert.ok(await page.evaluate(() => window.armedAt), 'the fixture must have started the continuation during the re-arm pause');
      assert.equal(after.grew, true, 'a live continuation is not a terminal boundary');
      assert.equal(after.count, 11, 'the batch the re-arm woke must be observed, not abandoned');
      assert.ok(after.ids.includes('PNEXT1') && after.ids.includes('PNEXT2'), 'both new cards must be reported: ' + JSON.stringify(after.ids));
      assert.equal(monitor.inFlight(), 0, 'the settlement must not return over a still-pending request');
      assert.equal(seen.api, 1, 'exactly one continuation: the settlement must never issue a second');
      assert.equal(await page.evaluate(() => window.intersections), 1, 'the settlement observes only; nothing may be scrolled by it');
      assert.equal(after.recenterCount, 1, 'only the opening recenter may have scrolled');
      assert.equal(after.graceAttemptsUsed, 1);
      assert.equal(after.continuationRequests, 1);
      assert.equal(after.blocked, null);
      // The settlement draws on the same capped budget, and the abandoned grace window is not
      // spent, so the documented worst case is unchanged.
      const bound = growthWaitMs + REARM_PAUSE_BUDGET_MS + inFlightSettleMs;
      assert.ok(elapsed < bound + 2000, 'the new settlement stays bounded (' + bound + 'ms); elapsed=' + elapsed);
      assert.ok(elapsed < maxTimeMs, 'never exceeds the global deadline; elapsed=' + elapsed);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

// --- full-backfill correctness: late profile and page-replacing DOM ----------------------------
// Both fixtures are served entirely from page.route, like the continuation fixtures above.
const PROFILE_FIXTURE_URL = 'https://instacognito.com/en/photo';

// A provider page whose #post-container is REPLACED on each continuation, which is what the posts
// trace recorded (22 -> 56 -> 83 -> 22 cards, every request 200).
function pagedFixtureHtml(pages) {
  const card = p => '<article class="post-card"><img class="post-image" data-type="' + p.type + '">'
    + '<div class="post-content"><p>' + p.caption + '</p></div>'
    + '<span class="likes-trigger" data-id="' + p.id + '"><span>5</span></span>'
    + '<span class="comments-trigger" data-id="' + p.id + '"><span>1</span></span>'
    + '<div class="post-footer"><div class="icon-group"><span>' + p.date + '</span></div></div>'
    + '<a class="content-download-btn" href="https://instacognito.com/media?id=' + p.media + '&sig=' + Math.random().toString(36).slice(2) + '">d</a></article>';
  return '<!doctype html><style>body{margin:0}.post-card{display:block;height:300px}</style>'
    + '<div id="profile-section"><span class="username-text">@pagedhandle</span><div>24 posts 10k followers</div></div>'
    + '<div id="post-container"></div>'
    + '<script>(function(){'
    + 'const attr = "data-ff-pagination-sentinel";'
    + 'const Native = window.IntersectionObserver;'
    + 'function Probed(cb, opts){ const o = new Native(cb, opts); const nat = o.observe.bind(o); o.observe = function(t){ for (const m of document.querySelectorAll("[" + attr + "]")) m.removeAttribute(attr); t.setAttribute(attr, "1"); return nat(t); }; return o; }'
    + 'Probed.prototype = Native.prototype; window.IntersectionObserver = Probed;'
    + 'window.pages = ' + JSON.stringify(pages) + ';'
    + 'window.pageIndex = 0; window.intersections = 0; window.maxConcurrent = 0; window.inFlight = 0;'
    + 'window.cardHtml = ' + card.toString() + ';'
    + 'window.arm = function(){ const cards = document.querySelectorAll("#post-container .post-card"); if (!cards.length) return;'
    + '  if (window.io) window.io.disconnect();'
    + '  window.io = new IntersectionObserver(function(e){ if (!e[0].isIntersecting) return; window.intersections++; window.loadNext(); }, { rootMargin: "200px" });'
    + '  window.io.observe(cards[cards.length - 1]); };'
    + 'window.render = function(items){ document.getElementById("post-container").innerHTML = items.map(window.cardHtml).join(""); window.arm(); };'
    + 'window.loadNext = function(){ if (window.pageIndex >= window.pages.length - 1) return;'
    + '  window.inFlight++; window.maxConcurrent = Math.max(window.maxConcurrent, window.inFlight);'
    + '  fetch("/api/posts", { method: "POST", body: "{}" }).then(function(r){ return r.json(); }).then(function(d){ window.inFlight--; window.pageIndex++; window.render(window.pages[window.pageIndex]); }); };'
    + 'window.render(window.pages[0]);'
    + '})();</script>';
}

function pageOfPosts(prefix, n, opts = {}) {
  return Array.from({ length: n }, (_, i) => ({ id: prefix + (i + 1), media: prefix + (i + 1) + '-0', type: 'image', caption: 'caption ' + prefix + (i + 1), date: '2026-01-0' + ((i % 9) + 1), ...opts }));
}

test('a profile that answers after the old fixed wait is still read, with its real total', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // The readiness trace: /api/posts lands first and renders cards, /api/profile answers 1058ms
    // after the click. The old fixed 500ms read saw cards, an empty username and no total.
    const html = '<!doctype html><div id="profile-section"></div><div id="post-container"><article class="post-card"><span class="likes-trigger" data-id="P1"><span>1</span></span></article></div>'
      + '<script>setTimeout(function(){ document.getElementById("profile-section").innerHTML = \'<span class="username-text">@syrn</span><div>253 posts 505.4k followers</div>\'; }, 1200);</script>';
    const seen = { unexpected: [] };
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/en/photo') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
      seen.unexpected.push(url.href);
      return route.abort();
    });
    await page.goto(PROFILE_FIXTURE_URL, { waitUntil: 'domcontentloaded' });

    // What the old fixed 500ms wait produced: cards on screen, profile not yet answered.
    await page.waitForTimeout(500);
    const early = await lib.extractProfileFromPage(page, 'syrn');
    assert.equal(early.reportedPostCount, null, 'the fixture must really be unready at 500ms');

    const started = Date.now();
    const ready = await lib.waitForProfileReady(page, 'syrn', { started, maxTimeMs: 30000 });
    assert.equal(ready.ready, true, 'the bounded wait must see the late profile');
    assert.equal(ready.matched, true, 'readiness requires the requested username, not just any profile');
    assert.equal(ready.blocked, null);
    const profile = await lib.extractProfileFromPage(page, 'syrn');
    assert.equal(profile.reportedPostCount, 253, 'the real total must be read, never invented and never null');
    assert.equal(profile.handle, 'syrn');
    assert.ok(Date.now() - started < 30000);
    assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
  } finally {
    await browser.close();
  }
});

test('a profile that never arrives stays unknown within bounds instead of faking a total', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const seen = { unexpected: [] };
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      // A profile for a DIFFERENT handle must never be accepted as the requested one.
      if (url.pathname === '/en/photo') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><div id="profile-section"><span class="username-text">@someoneelse</span><div>99 posts</div></div><div id="post-container"></div>' });
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
      seen.unexpected.push(url.href);
      return route.abort();
    });
    await page.goto(PROFILE_FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    const started = Date.now();
    const ready = await lib.waitForProfileReady(page, 'syrn', { started, maxTimeMs: 30000, waitMs: 900 });
    const elapsed = Date.now() - started;
    assert.equal(ready.ready, false, 'a mismatched profile is not readiness');
    assert.equal(ready.matched, false);
    assert.equal(ready.blocked, null);
    assert.ok(elapsed >= 800 && elapsed < 4000, 'the wait stays bounded; elapsed=' + elapsed);
    assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
  } finally {
    await browser.close();
  }
});

test('a page-replacing provider retains every observed batch instead of only the last DOM', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // Page A then page B, each 12 posts, the second REPLACING the first in the DOM.
    const pageA = pageOfPosts('A', 12);
    const pageB = pageOfPosts('B', 12);
    const seen = { api: 0, unexpected: [] };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/en/photo') return route.fulfill({ status: 200, contentType: 'text/html', body: pagedFixtureHtml([pageA, pageB]) });
      if (url.pathname === '/api/posts') { seen.api++; await sleep(300); try { return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); } catch { return; } }
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
      seen.unexpected.push(url.href);
      return route.abort();
    });
    await page.goto(PROFILE_FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const started = Date.now();
      const section = await lib.scrapeCardSection(page, { category: 'posts', mediaTypes: ['image', 'video'], reportedTotal: 24, started, maxTimeMs: 30000, maxPages: 4, continuationMonitor: monitor });
      const finalDom = await lib.getRenderedCardState(page);
      assert.equal(finalDom.count, 12, 'the fixture must really replace the DOM, leaving one page visible');
      assert.equal(section.uniquePostCount, 24, 'both batches must be retained, not just the visible one');
      assert.equal(section.itemCount, 24);
      const ids = section.items.map(i => i.shortcode);
      for (const p of [...pageA, ...pageB]) assert.ok(ids.includes(p.id), 'lost post ' + p.id);
      assert.equal(ids[0], 'A1', 'the first batch must be kept, in first-seen order');
      // Archive data is preserved verbatim, and no signed URL is ever surfaced in the record.
      const a1 = section.items.find(i => i.shortcode === 'A1');
      assert.equal(a1.captionTruncated, 'caption A1');
      assert.equal(a1.dateRaw, '2026-01-01');
      assert.equal(a1.carouselIndex, 0);
      assert.ok(section.items.every(i => i.carouselIndex === 0), 'single-slide posts must not be renumbered by re-observation');
      assert.equal(new Set(section.items.map(i => i.stableId)).size, 24, 'stable ids must stay unique across batches');
      assert.equal(await page.evaluate(() => window.maxConcurrent), 1, 'continuations must stay serialized');
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('page-replacing scans keep carousel slides distinct and stay inside maxPages and the deadline', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // Page A carries one carousel post as two distinct slides; page B re-shows that same post
    // with ROTATED signed URLs plus its third slide. The repeat must not duplicate, and the new
    // slide must not be collapsed into it.
    const carouselA = [
      { id: 'CAR', media: 'CAR-0', type: 'image', caption: 'car', date: '2026-02-01' },
      { id: 'CAR', media: 'CAR-1', type: 'image', caption: 'car', date: '2026-02-01' }
    ];
    const carouselB = [
      { id: 'CAR', media: 'CAR-0', type: 'image', caption: 'car', date: '2026-02-01' },
      { id: 'CAR', media: 'CAR-1', type: 'image', caption: 'car', date: '2026-02-01' },
      { id: 'CAR', media: 'CAR-2', type: 'image', caption: 'car', date: '2026-02-01' }
    ];
    const pageA = [...carouselA, ...pageOfPosts('A', 3)];
    const pageB = [...carouselB, ...pageOfPosts('B', 3)];
    const pageC = pageOfPosts('C', 3);
    const seen = { api: 0, unexpected: [] };
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/en/photo') return route.fulfill({ status: 200, contentType: 'text/html', body: pagedFixtureHtml([pageA, pageB, pageC, pageC]) });
      if (url.pathname === '/api/posts') { seen.api++; await sleep(200); try { return await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); } catch { return; } }
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
      seen.unexpected.push(url.href);
      return route.abort();
    });
    await page.goto(PROFILE_FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const maxPages = 3;
      const started = Date.now();
      const section = await lib.scrapeCardSection(page, { category: 'posts', mediaTypes: ['image', 'video'], reportedTotal: 99, started, maxTimeMs: 6000, maxPages, continuationMonitor: monitor });
      // Pages A, B and C were all observed even though only C is on screen.
      assert.equal((await lib.getRenderedCardState(page)).count, 3, 'only the last page remains in the DOM');
      const elapsed = Date.now() - started;
      const car = section.items.filter(i => i.shortcode === 'CAR');
      assert.equal(car.length, 3, 'three distinct slides, no duplicate from the repeated page: ' + JSON.stringify(car.map(c => c.href)));
      assert.deepEqual(car.map(c => c.carouselIndex), [0, 1, 2], 'slide indices are assigned once, in first-seen order');
      assert.equal(new Set(car.map(c => c.stableId)).size, 3, 'each slide keeps its own stable id');
      assert.equal(section.uniquePostCount, 10, 'CAR plus A1-A3 plus B1-B3 plus C1-C3');
      // Bounds are unchanged by the accumulation.
      assert.equal(await page.evaluate(() => window.maxConcurrent), 1, 'no parallel continuations');
      assert.ok(elapsed < 6000 + 2000, 'the hard deadline still ends the scan; elapsed=' + elapsed);
      assert.ok(section.hitLimit || section.noGrowth, 'a bounded stop is reported, never silently completed');
      assert.notEqual(section.status, 'COMPLETE_WITHOUT_BOUND');
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

// --- profile readiness is enforced, not merely awaited -----------------------------------------
// These drive the real post-search orchestration (readiness gate, tab switch, section loop)
// against a fully routed offline page, which is as close to end-to-end as it gets with no network.
async function serveProfilePage(page, body, extraRoutes = {}) {
  const seen = { api: 0, unexpected: [] };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/en/photo') return route.fulfill({ status: 200, contentType: 'text/html', body });
    if (extraRoutes[url.pathname]) { seen.api++; return extraRoutes[url.pathname](route, seen); }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    seen.unexpected.push(url.href);
    return route.abort();
  });
  await page.goto(PROFILE_FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  return seen;
}

// A provider page showing SOMEONE ELSE with a small total that the visible cards already satisfy:
// consuming it would let the section claim it had everything.
const STALE_PROFILE_HTML = '<!doctype html>'
  + '<div id="profile-section"><span class="username-text">@someoneelse</span><div>2 posts 10k followers</div></div>'
  + '<div id="menu-wrapper"><div class="menu-item" data-id="POSTS">Posts</div></div>'
  + '<div id="post-container">'
  + '<article class="post-card"><img class="post-image" data-type="image"><span class="likes-trigger" data-id="X1"><span>1</span></span><a class="content-download-btn" href="https://instacognito.com/media?id=X1">d</a></article>'
  + '<article class="post-card"><img class="post-image" data-type="image"><span class="likes-trigger" data-id="X2"><span>1</span></span><a class="content-download-btn" href="https://instacognito.com/media?id=X2">d</a></article>'
  + '</div>';

test('a stale mismatched profile is never consumed and no section is scraped from it', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const seen = await serveProfilePage(page, STALE_PROFILE_HTML);
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      // The trap: 2 visible cards against @someoneelse's total of 2 would look complete.
      const stale = await lib.extractProfileFromPage(page, 'syrn');
      assert.equal(stale.reportedPostCount, 2, 'the fixture must really offer a satisfiable foreign total');

      const started = Date.now();
      const scan = await lib.scanReadyProfilePage(page, { handle: 'syrn', maxPages: 4, maxTimeMs: 20000, categories: ['posts'], mediaTypes: ['image', 'video'], started, continuationMonitor: monitor, });
      assert.equal(scan.profile.reportedPostCount, null, 'a foreign total must never become this handle’s total');
      assert.equal(scan.profile.rawProfileText, null, 'no profile text may be carried from a mismatched page');
      assert.equal(scan.profile.handle, 'syrn');
      assert.equal(scan.sections.length, 1);
      const posts = scan.sections[0];
      assert.equal(posts.status, 'ACTION_REQUIRED', 'unproven readiness is action-required, never COMPLETE');
      assert.equal(posts.itemCount, 0, 'no cards may be consumed from a profile that was never confirmed');
      assert.deepEqual(posts.items, []);
      assert.equal(posts.uniquePostCount, null);
      assert.equal(posts.evidence.matchedRequestedHandle, false, 'the evidence names the actual failure');
      assert.equal(posts.evidence.blocked, null);
      assert.match(posts.reason, /did not render the requested profile/);
      assert.equal(seen.api, 0, 'no continuation may be issued for an unconfirmed profile');
      assert.ok(Date.now() - started < 20000);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('readiness stopped by a visible challenge reports BLOCKED and scrapes nothing', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // A live challenge over a page that otherwise looks scrapeable.
    const html = '<!doctype html><form id="challenge-form" style="display:block;width:320px;height:90px">verify you are human</form>' + STALE_PROFILE_HTML.replace('<!doctype html>', '');
    const seen = await serveProfilePage(page, html);
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const started = Date.now();
      const scan = await lib.scanReadyProfilePage(page, { handle: 'syrn', maxPages: 4, maxTimeMs: 20000, categories: ['posts'], mediaTypes: ['image', 'video'], started, continuationMonitor: monitor });
      const elapsed = Date.now() - started;
      const posts = scan.sections[0];
      assert.equal(posts.status, 'BLOCKED', 'a challenge during readiness is blocked evidence, not a timeout');
      assert.match(posts.reason, /challenge|captcha/);
      assert.equal(posts.evidence.blocked.status, null, 'a DOM challenge carries no HTTP status');
      assert.match(posts.evidence.blocked.reason, /challenge|captcha/);
      assert.equal(posts.itemCount, 0);
      assert.equal(scan.profile.reportedPostCount, null);
      assert.equal(seen.api, 0, 'nothing may be triggered while a challenge is up');
      assert.ok(elapsed < 3000, 'a challenge ends the wait at once rather than burning the budget; elapsed=' + elapsed);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

test('a matching ready profile still scrapes its section end to end', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    // The gate must not become a wall: a confirmed profile scrapes exactly as before.
    const html = STALE_PROFILE_HTML.replace('@someoneelse', '@syrn').replace('2 posts', '2 posts');
    const seen = await serveProfilePage(page, html);
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const started = Date.now();
      const scan = await lib.scanReadyProfilePage(page, { handle: 'syrn', maxPages: 2, maxTimeMs: 15000, categories: ['posts'], mediaTypes: ['image', 'video'], started, continuationMonitor: monitor });
      const posts = scan.sections[0];
      assert.equal(scan.profile.reportedPostCount, 2, 'a confirmed profile keeps its real total');
      assert.equal(scan.profile.handle, 'syrn');
      assert.equal(posts.itemCount, 2, 'the visible cards are scraped once the profile is confirmed');
      assert.equal(posts.uniquePostCount, 2);
      assert.deepEqual(posts.items.map(i => i.shortcode), ['X1', 'X2']);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

// --- reliable bounded resume: overlap, pending, checkpoints, ownership, starvation -------------
// Every case below is synthetic and offline: fetchImpl is injected, no provider is contacted, and
// no canonical state is touched. They encode the six defects observed in the live manifests.

async function readOwnerFile(out) { return readJson(path.join(out, '.frameferry', 'example', 'current-owner.json')); }
async function writeManifestRaw(out, manifest) {
  await fsp.writeFile(path.join(out, '.frameferry', 'example', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

test('a failure is cleared only by a verified matching receipt, and an unresolved one is retained', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const good = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  const bad = { shortcode: 'B', href: 'https://instacognito.com/media?id=b' };
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 2, items: [good, bad], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => url.includes('id=b') ? res({ body: Buffer.from('not-media'), headers: { 'content-type': 'image/jpeg' } }) : res()
  });
  let manifest = await readManifest(out);
  assert.ok(manifest.completed['A-0'], 'A must have a receipt');
  assert.ok(manifest.failed['B-0'], 'B must be a real failure');

  // The observed Sydney state: an ID that really was downloaded is ALSO listed as failed, and the
  // next scan does not rediscover it. 429 of 1514 "failures" were of exactly this shape.
  manifest.failed['A-0'] = { stableId: 'A-0', category: 'posts', shortcode: 'A', carouselIndex: 0, mediaType: 'image', identityBasis: 'provider-shortcode', error: 'pending fresh scan retry' };
  await writeManifestRaw(out, manifest);

  const other = { shortcode: 'C', href: 'https://instacognito.com/media?id=c' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 3, items: [other], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  manifest = await readManifest(out);
  const stillFailed = { ...(manifest.failed || {}), ...(manifest.pending || {}) };
  assert.equal(stillFailed['A-0'], undefined, 'a failure with a verified matching receipt must be resolved, not carried forever');
  assert.ok(stillFailed['B-0'], 'a failure with no receipt must be retained, never cleared blindly');
  assert.ok((manifest.audit || []).some(entry => (entry.resolvedByReceipt || []).includes('A-0')), 'resolution must be auditable');

  // Presence of a completed entry is not enough: the bytes must still verify.
  manifest = await readManifest(out);
  manifest.failed['A-0'] = { stableId: 'A-0', category: 'posts', shortcode: 'A', carouselIndex: 0, mediaType: 'image', identityBasis: 'provider-shortcode', error: 'pending fresh scan retry' };
  await writeManifestRaw(out, manifest);
  await fsp.writeFile(path.join(out, 'media', 'example', 'A-0.jpg'), Buffer.from('corrupted'));
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 3, items: [other], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  manifest = await readManifest(out);
  const afterCorruption = { ...(manifest.failed || {}), ...(manifest.pending || {}) };
  assert.ok(afterCorruption['A-0'], 'a corrupted receipt must not count as verified resolution');
});

test('an interrupted run has already persisted the progress it made, and the next run reuses it', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const items = ['A', 'B', 'C', 'D', 'E'].map(s => ({ shortcode: s, href: 'https://instacognito.com/media?id=' + s }));
  let calls = 0;
  const midRun = [];
  const fetchImpl = async () => {
    calls++;
    if (calls === 5) {
      // What a crash at this instant would leave behind on disk.
      const onDisk = await readJson(path.join(out, '.frameferry', 'example', 'manifest.json')).catch(() => null);
      midRun.push(onDisk ? Object.keys(onDisk.completed || {}).length : 0);
    }
    return res();
  };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 5, items, dnsLookup: publicDns, fetchImpl, delayMs: 0, checkpointEveryItems: 2 });
  assert.ok(midRun[0] >= 2, 'progress must be checkpointed durably during the run, not only at the end; saw ' + midRun[0]);

  let fetches = 0;
  const rotated = items.map(i => ({ shortcode: i.shortcode, href: 'https://instacognito.com/media?id=' + i.shortcode + '-rotated' }));
  const s = await lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 5, items: rotated, dnsLookup: publicDns, fetchImpl: async () => { fetches++; return res(); }, delayMs: 0 });
  assert.equal(fetches, 0, 'a resumed run must reuse every verified receipt');
  assert.equal(s.reusedCount, 5);
});

test('work never attempted is pending, not a download failure, at section and outcome', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const items = ['A', 'B'].map(s => ({ shortcode: s, href: 'https://instacognito.com/media?id=' + s }));
  let fetches = 0;
  const s = await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 2, items, dnsLookup: publicDns, delayMs: 0,
    maxTimeMs: 5000, acquisitionMaxTimeMs: 0,
    fetchImpl: async () => { fetches++; return res(); }
  });
  assert.equal(fetches, 0, 'no item can be acquired once the acquisition budget is spent');
  assert.equal(s.failedCount, 0, 'unattempted work is not a download failure');
  assert.equal(s.pendingCount, 2, 'unattempted work must be reported as pending');
  assert.equal(/downloads failed/.test(s.reason), false, 'the outcome must not call pending work a download failure: ' + s.reason);
  assert.match(s.reason, /pending/i);
  const posts = s.sections.find(section => section.category === 'posts');
  assert.equal(posts.failedCount, 0);
  assert.equal(posts.pendingCount, 2);
  const manifest = await readManifest(out);
  assert.equal(Object.keys(manifest.failed || {}).length, 0, 'the manifest must not record pending work as failures');
  assert.equal(Object.keys(manifest.pending || {}).length, 2);

  // Per-run truth and cumulative truth are different facts and must be recorded as different fields.
  const run = manifest.runs.at(-1);
  assert.equal(run.downloadedCount, 0);
  assert.equal(run.pendingCount, 2);
  assert.equal(run.failedCount, 0);
  assert.equal(run.completedCount, 0, 'a per-run entry must hold this run\'s own count, not the cumulative total');
  assert.equal(manifest.cumulative.completedCount, 0);
});

test('no id is ever both completed and outstanding, and carousel slides stay distinct', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const slides = [
    { shortcode: 'CAR', href: 'https://instacognito.com/media?id=s0' },
    { shortcode: 'CAR', href: 'https://instacognito.com/media?id=s1' },
    { shortcode: 'SOLO', href: 'https://instacognito.com/media?id=solo' }
  ];
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 2, items: slides, dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => url.includes('id=s1') ? res({ body: Buffer.from('not-media'), headers: { 'content-type': 'image/jpeg' } }) : res()
  });
  let manifest = await readManifest(out);
  assert.ok(manifest.completed['CAR-0'], 'slide 0 downloaded');
  assert.ok(manifest.failed['CAR-1'], 'slide 1 failed and stays its own distinct entry');
  assert.equal(manifest.failed['CAR-1'].carouselIndex, 1, 'a failed slide must keep its own carousel index');
  assert.equal(manifest.completed['CAR-0'].carouselIndex, 0);

  // Inject the overlap for both a completed slide and a completed solo post, then run a scan that
  // rediscovers neither: the invariant must hold without the ids being re-seen.
  manifest.failed['CAR-0'] = { ...manifest.failed['CAR-1'], stableId: 'CAR-0', carouselIndex: 0, error: 'pending fresh scan retry' };
  manifest.failed['SOLO-0'] = { stableId: 'SOLO-0', category: 'posts', shortcode: 'SOLO', carouselIndex: 0, mediaType: 'image', identityBasis: 'provider-shortcode', error: 'pending fresh scan retry' };
  await writeManifestRaw(out, manifest);
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 2, items: [{ shortcode: 'NEW', href: 'https://instacognito.com/media?id=new' }], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  manifest = await readManifest(out);
  const outstanding = { ...(manifest.failed || {}), ...(manifest.pending || {}) };
  for (const id of Object.keys(outstanding)) {
    assert.equal(manifest.completed[id], undefined, 'id ' + id + ' is recorded as both completed and outstanding');
  }
  assert.ok(outstanding['CAR-1'], 'the genuinely missing slide must survive the reconciliation');
  assert.equal(new Set(Object.keys(manifest.completed)).size, Object.keys(manifest.completed).length);
});

test('a known total with missing items reports an exact coverage shortfall, and an unknown total says so', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const items = [{ shortcode: 'A', href: 'https://instacognito.com/media?id=a' }, { shortcode: 'B', href: 'https://instacognito.com/media?id=b' }];
  const s = await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 5, items, dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  assert.equal(s.status, 'PARTIAL');
  assert.ok(s.coverage, 'a partial outcome must state exactly what is missing');
  assert.equal(s.coverage.reportedTotalKnown, true);
  assert.equal(s.coverage.reportedTotal, 5);
  assert.equal(s.coverage.uniquePostCount, 2);
  assert.equal(s.coverage.missingPostCount, 3);
  assert.equal(s.coverage.outstandingMediaCount, 0);

  const d2 = await tmp();
  const out2 = path.join(d2, 'out');
  const s2 = await lib.archiveProfile({ handle: 'example', output: out2, items, dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  assert.equal(s2.coverage.reportedTotalKnown, false, 'an unknown total must be reported as unknown, never as satisfied');
  assert.equal(s2.coverage.missingPostCount, null, 'an unknown total cannot yield a missing count');
});

test('a stale owner record is reconciled instead of trusted, and a live one refuses a second writer', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const item = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });

  const owner = await readOwnerFile(out);
  assert.equal(owner.terminal, true, 'a finished run must leave a terminal owner record, not a running claim');
  assert.equal(owner.stage, 'finished');
  assert.equal(lib.evaluateOwnerRecord(owner).state, 'TERMINAL');

  // The observed CURRENT-OWNER.json defect: a claim that says RUNNING long after the pass ended.
  const ownerPath = path.join(out, '.frameferry', 'example', 'current-owner.json');
  await fsp.writeFile(ownerPath, JSON.stringify({ ...owner, runId: 'ghost', pid: 99999999, stage: 'acquiring', terminal: false, status: 'RUNNING' }, null, 2));
  assert.equal(lib.evaluateOwnerRecord(await readOwnerFile(out)).state, 'STALE', 'a dead pid claiming to run is stale metadata, not a running owner');
  const resumed = await lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  assert.equal(resumed.status, 'COMPLETE', 'a stale claim must be reconciled, not treated as a live owner');
  const takeover = (await readManifest(out)).audit.some(entry => entry.ownerTakeover && entry.ownerTakeover.runId === 'ghost');
  assert.ok(takeover, 'taking over a stale claim must be auditable');

  // A live claim from a different run is a second writer and must be refused outright.
  await fsp.writeFile(ownerPath, JSON.stringify({ runId: 'live-other', pid: process.pid, host: os.hostname(), stage: 'acquiring', terminal: false, status: 'RUNNING', startedAt: new Date().toISOString() }, null, 2));
  assert.equal(lib.evaluateOwnerRecord(await readOwnerFile(out)).state, 'ACTIVE');
  await assert.rejects(
    () => lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 }),
    err => err.code === 'LOCKED_OWNER',
    'a live owner from another run must not get a second writer'
  );
});

test('discovery does not stop on the post total while known media are still missing', () => {
  // The starvation: coverage was measured in unique POSTS, but the outstanding work is MEDIA.
  // With every post already on the cached first page the scan exited immediately, so the missing
  // carousel slides were never rediscovered and waited forever for a "fresh scan".
  const allPostsSeen = { reportedTotal: 598, uniquePostCount: 598, resumeTargets: new Set(['P1-1', 'P2-3']), discoveredIds: new Set(['P1-0', 'P2-0']) };
  assert.equal(lib.discoveryCoverageSatisfied(allPostsSeen), false, 'known missing media must keep discovery running');
  assert.equal(lib.discoveryCoverageSatisfied({ ...allPostsSeen, discoveredIds: new Set(['P1-0', 'P1-1', 'P2-3']) }), true, 'once every target is covered the post total may stop discovery');
  assert.equal(lib.discoveryCoverageSatisfied({ reportedTotal: 598, uniquePostCount: 598, resumeTargets: new Set(), discoveredIds: new Set() }), true, 'with no outstanding targets the post total is the only condition');
  assert.equal(lib.discoveryCoverageSatisfied({ reportedTotal: 598, uniquePostCount: 12, resumeTargets: new Set(), discoveredIds: new Set() }), false, 'an unmet post total still stops nothing');
  assert.equal(lib.discoveryCoverageSatisfied({ reportedTotal: null, uniquePostCount: 12, resumeTargets: new Set(), discoveredIds: new Set() }), false, 'an unknown total never satisfies coverage');
});

test('a resumed run targets the ids it is still missing and reports what discovery covered', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const good = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  const bad = { shortcode: 'B', href: 'https://instacognito.com/media?id=b' };
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 2, items: [good, bad], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => url.includes('id=b') ? res({ body: Buffer.from('not-media'), headers: { 'content-type': 'image/jpeg' } }) : res()
  });
  // A scan that rediscovers neither outstanding id: the run must say so rather than silently
  // reusing whatever the first page happened to hold.
  const s = await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 2, items: [good], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  assert.ok(s.resume, 'a resumed run must report its own resume coverage');
  assert.equal(s.resume.targeted, 1, 'B-0 is the one outstanding id');
  assert.equal(s.resume.rediscovered, 0);
  assert.deepEqual(s.resume.stillMissing, ['B-0']);

  const s2 = await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 2, items: [good, bad], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  assert.equal(s2.resume.targeted, 1);
  assert.equal(s2.resume.rediscovered, 1, 'a rediscovered target must be counted as recovered');
  assert.deepEqual(s2.resume.stillMissing, []);
  assert.equal(s2.status, 'COMPLETE');
});

test('a mid-run checkpoint still carries outstanding work the scan has not re-seen', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const bad = { shortcode: 'B', href: 'https://instacognito.com/media?id=b' };
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 1, items: [bad], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async () => res({ body: Buffer.from('not-media'), headers: { 'content-type': 'image/jpeg' } })
  });
  assert.ok((await readManifest(out)).failed['B-0'], 'B-0 must start out outstanding');

  // A later scan that never re-sees B-0. If a checkpoint wrote only this run's own maps, a crash
  // here would erase B-0 and the next run would never know it was owed.
  const items = ['P', 'Q', 'R', 'S'].map(s => ({ shortcode: s, href: 'https://instacognito.com/media?id=' + s }));
  let calls = 0;
  const midRun = [];
  const fetchImpl = async () => {
    calls++;
    if (calls === 3) {
      const onDisk = await readJson(path.join(out, '.frameferry', 'example', 'manifest.json')).catch(() => null);
      midRun.push(onDisk ? { ...(onDisk.failed || {}), ...(onDisk.pending || {}) } : {});
    }
    return res();
  };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 5, items, dnsLookup: publicDns, fetchImpl, delayMs: 0, checkpointEveryItems: 2 });
  assert.ok(midRun[0]['B-0'], 'a checkpoint must not drop outstanding work that this scan did not re-see');
  assert.ok((await readManifest(out)).failed['B-0'], 'and it must still be owed at the end of the run');
});

// --- independent review 1 counterexamples ------------------------------------------------------
// Each case below is a counterexample the first round of tests missed. All synthetic and offline.

test('P1-1 a run cannot report COMPLETE while it still owes outstanding media', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const slides = [
    { shortcode: 'CAR', href: 'https://instacognito.com/media?id=s0' },
    { shortcode: 'CAR', href: 'https://instacognito.com/media?id=s1' }
  ];
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 1, items: slides, dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => url.includes('id=s1') ? res({ body: Buffer.from('not-media'), headers: { 'content-type': 'image/jpeg' } }) : res()
  });
  assert.ok((await readManifest(out)).failed['CAR-1'], 'CAR-1 must start out owed');
  // A later scan that satisfies the post total but never re-sees the owed slide.
  const s = await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [slides[0]], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  assert.equal(s.coverage.outstandingMediaCount, 1);
  assert.deepEqual(s.resume.stillMissing, ['CAR-1']);
  assert.notEqual(s.status, 'COMPLETE', 'COMPLETE while media is still owed is a false completion');
});

test('P1-2 a deferred retry of a rediscovered failure keeps the item, never drops it', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const bad = { shortcode: 'B', href: 'https://instacognito.com/media?id=b' };
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 1, items: [bad], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async () => res({ body: Buffer.from('not-media'), headers: { 'content-type': 'image/jpeg' } })
  });
  assert.ok((await readManifest(out)).failed['B-0']);
  // Rediscovered, then denied: it is fresh (so carried state no longer covers it) and the deferral
  // stops the run before it can be filed anywhere.
  await assert.rejects(() => lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 1, items: [bad], dnsLookup: publicDns, delayMs: 0,
    remainingMs: 1000, maxTimeMs: 1000,
    fetchImpl: async () => res({ status: 429, headers: { 'retry-after': '120', 'content-type': 'image/jpeg' } })
  }), err => err.code === 'DEFERRED');
  const manifest = await readManifest(out);
  const outstanding = { ...(manifest.failed || {}), ...(manifest.pending || {}) };
  assert.ok(outstanding['B-0'], 'a deferred item must still be owed, not silently forgotten');
});

test('P1-3a a checkpoint records discovered work that has not been acquired yet', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const items = ['A', 'B', 'C', 'D', 'E'].map(s => ({ shortcode: s, href: 'https://instacognito.com/media?id=' + s }));
  let calls = 0;
  const midRun = [];
  const fetchImpl = async () => {
    calls++;
    if (calls === 3) {
      const onDisk = await readJson(path.join(out, '.frameferry', 'example', 'manifest.json')).catch(() => null);
      midRun.push(onDisk ? { ...(onDisk.failed || {}), ...(onDisk.pending || {}) } : {});
    }
    return res();
  };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 5, items, dnsLookup: publicDns, fetchImpl, delayMs: 0, checkpointEveryItems: 2 });
  assert.ok(midRun[0]['E-0'], 'work already discovered but not yet acquired must be checkpointed as owed');
  assert.ok(midRun[0]['D-0'], 'and so must every other queued item');
});

test('P1-3b receipts committed between checkpoints are adopted, not re-downloaded', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const item = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  // A crash between the receipt landing on disk and the manifest learning about it.
  const manifest = await readManifest(out);
  delete manifest.completed['A-0'];
  await writeManifestRaw(out, manifest);
  assert.ok(fs.existsSync(path.join(out, 'receipts', 'example', 'A-0.json')), 'the receipt file must still be on disk');
  let fetches = 0;
  await lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 1, items: [{ shortcode: 'A', href: 'https://instacognito.com/media?id=rotated' }], dnsLookup: publicDns, fetchImpl: async () => { fetches++; return res(); }, delayMs: 0 });
  assert.equal(fetches, 0, 'an orphaned but verifiable receipt must be adopted, not re-fetched');
  assert.ok((await readManifest(out)).completed['A-0'], 'and it must be back in the manifest');
});

test('P1-4a spending the acquisition budget never marks an already completed id as owed', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const item = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  const s = await lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0, maxTimeMs: 5000, acquisitionMaxTimeMs: 0 });
  const manifest = await readManifest(out);
  const outstanding = { ...(manifest.failed || {}), ...(manifest.pending || {}) };
  assert.equal(outstanding['A-0'], undefined, 'an id with a verified receipt is not owed just because the budget ran out');
  assert.ok(manifest.completed['A-0']);
  assert.equal(s.coverage.outstandingMediaCount, 0);
});

test('P1-4b a receipt only resolves the id and handle it actually belongs to', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const item = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  const root = await lib.safeOutputRoot(out);
  const paths = lib.profilePaths(root, 'example');
  const receipt = (await readManifest(out)).completed['A-0'];

  const wrongId = await lib.reconcileAgainstReceipts(paths, { 'B-0': receipt }, { 'B-0': { stableId: 'B-0', error: 'x' } });
  assert.deepEqual(wrongId.resolved, [], 'a receipt for A-0 must not resolve B-0');
  assert.ok(wrongId.retained['B-0']);

  const wrongHandle = await lib.reconcileAgainstReceipts(paths, { 'A-0': { ...receipt, profileHandle: 'someoneelse' } }, { 'A-0': { stableId: 'A-0', error: 'x' } });
  assert.deepEqual(wrongHandle.resolved, [], 'a receipt belonging to another handle must not resolve anything here');
  assert.ok(wrongHandle.retained['A-0']);

  const right = await lib.reconcileAgainstReceipts(paths, { 'A-0': receipt }, { 'A-0': { stableId: 'A-0', error: 'x' } });
  assert.deepEqual(right.resolved, ['A-0'], 'the receipt that genuinely matches still resolves');
});

test('P1-5 lock takeover is fail-closed on an unattributable lock and release is ownership checked', async () => {
  const d = await tmp();
  const root = await lib.safeOutputRoot(path.join(d, 'out'));
  const paths = lib.profilePaths(root, 'example');
  await fsp.mkdir(paths.stateDir, { recursive: true });

  // A lock naming no pid cannot be proved stale, so it must not be taken over.
  await fsp.writeFile(paths.lock, JSON.stringify({ host: os.hostname(), runId: 'nopid' }));
  await assert.rejects(() => lib.withLock(paths, 'r', async () => {}), /lock/i, 'an unattributable lock must fail closed, not be assumed stale');
  assert.ok(fs.existsSync(paths.lock), 'and it must be left where it was');
  await fsp.unlink(paths.lock);

  // If our lock is taken over while we hold it, releasing must not delete the new owner's lock.
  let observed = null;
  await lib.withLock(paths, 'mine', async () => {
    observed = JSON.parse(await fsp.readFile(paths.lock, 'utf8'));
    await fsp.writeFile(paths.lock, JSON.stringify({ pid: process.pid, host: os.hostname(), runId: 'someone-else', token: 'not-ours' }));
  });
  assert.ok(observed && observed.token, 'a held lock must carry an ownership token');
  assert.ok(fs.existsSync(paths.lock), 'releasing must not unlink a lock this run no longer owns');
  assert.equal(JSON.parse(await fsp.readFile(paths.lock, 'utf8')).runId, 'someone-else');
});

test('P1-6 a carousel slide is never resolved by index alone when the provider media differs', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const s0 = { shortcode: 'CAR', href: 'https://instacognito.com/media?id=slideZero' };
  const s1 = { shortcode: 'CAR', href: 'https://instacognito.com/media?id=slideOne' };
  const bodyFor = url => url.includes('slideZero') ? jpg : png;
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 1, items: [s0, s1], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => res({ body: bodyFor(url), headers: { 'content-type': 'image/jpeg' } })
  });
  let manifest = await readManifest(out);
  assert.equal(manifest.completed['CAR-0'].bytes, jpg.length, 'slide 0 holds the first media');
  assert.equal(manifest.completed['CAR-1'].bytes, png.length, 'slide 1 holds the second media');

  // The same two slides, re-observed in the opposite order. Encounter order now calls slideOne
  // "CAR-0", so resolving by index would silently label the wrong media as slide 0.
  let fetches = 0;
  await lib.archiveProfile({
    handle: 'example', output: out, mode: 'sync', reportedTotal: 1, items: [s1, s0], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => { fetches++; return res({ body: bodyFor(url), headers: { 'content-type': 'image/jpeg' } }); }
  });
  assert.ok(fetches > 0, 'a slide whose provider media no longer matches its receipt must not be reused by index');
  manifest = await readManifest(out);
  // Round 2 corrected this: re-acquiring must not remap a verified slide. The stored content stands
  // and the conflicting observation is held, because slide position is not evidence about which
  // media a verified id refers to.
  assert.equal(manifest.completed['CAR-0'].bytes, jpg.length, 'a verified slide must not be overwritten by a conflicting one');
  assert.equal(manifest.completed['CAR-1'].bytes, png.length);
  assert.ok(manifest.conflicts['CAR-0'] && manifest.conflicts['CAR-1'], 'both conflicting observations must be held');
});

test('P2-7 an unexpected failure still finalizes the owner instead of leaving a live RUNNING claim', async (t) => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const item = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  const media = path.join(out, 'media', 'example', 'A-0.jpg');
  await fsp.chmod(media, 0o000);
  const stillReadable = await fsp.readFile(media).then(() => true).catch(() => false);
  if (stillReadable) { await fsp.chmod(media, 0o600); t.skip('cannot revoke read access in this environment'); return; }
  try {
    await assert.rejects(() => lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 }));
  } finally {
    await fsp.chmod(media, 0o600);
  }
  const owner = await readOwnerFile(out);
  assert.equal(owner.terminal, true, 'a run that died must not leave a non-terminal claim naming this live process');
  // The real harm: the next legitimate run in this same live process being refused as a second writer.
  const s = await lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  assert.equal(s.status, 'COMPLETE');
});

test('P2-8 acquisition serves the ids already owed before newly discovered ones', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const mk = s => ({ shortcode: s, href: 'https://instacognito.com/media?id=' + s });
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 3, items: [mk('X'), mk('B'), mk('C')], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => (url.includes('id=B') || url.includes('id=C')) ? res({ body: Buffer.from('not-media'), headers: { 'content-type': 'image/jpeg' } }) : res()
  });
  const owed = await readManifest(out);
  assert.ok(owed.failed['B-0'] && owed.failed['C-0'], 'B and C must start out owed');

  // A scan that surfaces two new posts alongside the owed ones. First-seen order would spend the
  // budget on the new work and starve the backlog again.
  const order = [];
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 5, items: [mk('N1'), mk('N2'), mk('B'), mk('C')], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => { order.push(new URL(url).searchParams.get('id')); return res(); }
  });
  assert.deepEqual(order.slice(0, 2).sort(), ['B', 'C'], 'the already owed ids must be acquired first, got ' + order.join(','));
});

test('P2-10 a legacy time-budget marker is pending work, not a download failure', () => {
  assert.equal(lib.isPendingEntry({ error: 'time budget reached' }), true);
  const split = lib.partitionPriorOutcomes({ failed: { 'A-0': { stableId: 'A-0', error: 'time budget reached' }, 'B-0': { stableId: 'B-0', error: 'provider returned HTML instead of media' } } });
  assert.ok(split.pending['A-0'], 'legacy budget skips migrate to pending');
  assert.equal(split.failed['A-0'], undefined);
  assert.ok(split.failed['B-0'], 'a real failure stays a failure');
});

// A provider that denies pagination on POSTS. The REELS tab is stocked so that scraping on past a
// denial is visible in the result rather than silent.
const DENIAL_TABS_HTML = '<!doctype html><style>body{margin:0}.post-card{display:block;height:300px}</style>'
  + '<div id="profile-section"><span class="username-text">@denyhandle</span><div>40 posts 10k followers</div></div>'
  + '<div id="menu-wrapper"><div class="menu-item" data-id="POSTS">Posts</div><div class="menu-item" data-id="REELS">Reels</div></div>'
  + '<div id="post-container"></div>'
  + '<script>(function(){'
  + 'const card = (id, type) => \'<article class="post-card"><img class="post-image" data-type="\' + type + \'"><span class="likes-trigger" data-id="\' + id + \'"><span>1</span></span><a class="content-download-btn" href="https://instacognito.com/media?id=\' + id + \'">d</a></article>\';'
  + 'window.reelsRendered = 0;'
  + 'window.renderPosts = function(){ document.getElementById("post-container").innerHTML = [1,2,3].map(function(i){ return card("P" + i, "image"); }).join(""); window.arm(); };'
  + 'window.renderReels = function(){ window.reelsRendered++; document.getElementById("post-container").innerHTML = [1,2].map(function(i){ return card("R" + i, "video"); }).join(""); };'
  + 'window.arm = function(){ const cards = document.querySelectorAll("#post-container .post-card"); if (!cards.length) return;'
  + '  if (window.io) window.io.disconnect();'
  + '  window.io = new IntersectionObserver(function(e){ if (!e[0].isIntersecting) return; fetch("/api/posts", { method: "POST", body: "{}" }).catch(function(){}); }, { rootMargin: "200px" });'
  + '  window.io.observe(cards[cards.length - 1]); };'
  + 'document.querySelector(\'#menu-wrapper .menu-item[data-id="REELS"]\').addEventListener("click", window.renderReels);'
  + 'window.renderPosts();'
  + '})();</script>';

test('P2-9 a provider denial is preserved as evidence and stops the remaining sections', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const seen = await serveProfilePage(page, DENIAL_TABS_HTML, {
      '/api/posts': route => route.fulfill({ status: 429, headers: { 'retry-after': '120' }, contentType: 'application/json', body: '{"error":"slow down"}' })
    });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      const started = Date.now();
      const scan = await lib.scanReadyProfilePage(page, { handle: 'denyhandle', maxPages: 3, maxTimeMs: 20000, categories: ['posts', 'reels'], mediaTypes: ['image', 'video'], started, continuationMonitor: monitor });
      const posts = scan.sections.find(s => s.category === 'posts');
      assert.equal(posts.status, 'PARTIAL');
      // The cause must survive, not be flattened into a generic bounded-limit reason.
      assert.ok(posts.evidence && posts.evidence.blocked, 'the denial must be persisted as section evidence');
      assert.equal(posts.evidence.blocked.status, 429);
      assert.ok(Date.parse(posts.evidence.blocked.retryAt) > Date.now(), 'Retry-After must be preserved: ' + posts.evidence.blocked.retryAt);
      assert.match(posts.reason, /429|denied|denial/i, 'the reason must name the denial, got: ' + posts.reason);

      const reels = scan.sections.find(s => s.category === 'reels');
      assert.notEqual(reels.status, 'COMPLETE', 'no section may be scraped after the provider has denied');
      assert.equal(await page.evaluate(() => window.reelsRendered), 0, 'the reels tab must not be clicked after a denial');
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});

// --- independent review 2 counterexamples ------------------------------------------------------

test('R2-1 concurrent takeovers of one stale lock admit exactly one writer', async () => {
  const d = await tmp();
  const root = await lib.safeOutputRoot(path.join(d, 'out'));
  const paths = lib.profilePaths(root, 'example');
  await fsp.mkdir(paths.stateDir, { recursive: true });
  await fsp.writeFile(paths.lock, JSON.stringify({ pid: 99999999, host: os.hostname(), runId: 'dead', token: 'dead-token' }));
  let inside = 0;
  let maxInside = 0;
  const attempt = async id => lib.withLock(paths, id, async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await new Promise(r => setTimeout(r, 60));
    inside--;
    return id;
  });
  const settled = await Promise.allSettled([attempt('a'), attempt('b'), attempt('c'), attempt('d')]);
  const winners = settled.filter(r => r.status === 'fulfilled');
  assert.equal(maxInside, 1, 'two callers reading the same dead lock must never both hold it');
  assert.equal(winners.length, 1, 'exactly one takeover may succeed, got ' + winners.length);
});

test('R2-2 a lone slide of a known carousel is not reused by index, and a conflict never overwrites', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const s0 = { shortcode: 'CAR', href: 'https://instacognito.com/media?id=slideZero' };
  const s1 = { shortcode: 'CAR', href: 'https://instacognito.com/media?id=slideOne' };
  const bodyFor = url => url.includes('slideZero') ? jpg : png;
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 1, items: [s0, s1], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => res({ body: bodyFor(url), headers: { 'content-type': 'image/jpeg' } })
  });
  assert.equal((await readManifest(out)).completed['CAR-0'].bytes, jpg.length);

  // Only ONE slide of the carousel is visible now, so encounter order calls it CAR-0 even though
  // the media is the second slide. Slide count 1 must not be enough to resolve it by index.
  let fetches = 0;
  await lib.archiveProfile({
    handle: 'example', output: out, mode: 'sync', reportedTotal: 1, items: [s1], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => { fetches++; return res({ body: bodyFor(url), headers: { 'content-type': 'image/jpeg' } }); }
  });
  assert.ok(fetches > 0, 'a lone slide of a post known to be a carousel must not resolve by index alone');
  const manifest = await readManifest(out);
  assert.equal(manifest.completed['CAR-0'].bytes, jpg.length, 'a verified slide must never be destructively overwritten by a conflicting one');
  assert.ok(manifest.conflicts && manifest.conflicts['CAR-0'], 'the conflicting content must be held and recorded');
});

test('R2-3 the discovered queue is persisted before any acquisition starts', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const items = ['A', 'B', 'C'].map(s => ({ shortcode: s, href: 'https://instacognito.com/media?id=' + s }));
  const atFirstFetch = [];
  const fetchImpl = async () => {
    if (!atFirstFetch.length) {
      const onDisk = await readJson(path.join(out, '.frameferry', 'example', 'manifest.json')).catch(() => null);
      atFirstFetch.push(onDisk ? { ...(onDisk.failed || {}), ...(onDisk.pending || {}) } : null);
    }
    return res();
  };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 3, items, dnsLookup: publicDns, fetchImpl, delayMs: 0, checkpointEveryItems: 100 });
  const owed = atFirstFetch[0];
  assert.ok(owed, 'a manifest must exist before the first acquisition');
  for (const id of ['A-0', 'B-0', 'C-0']) assert.ok(owed[id], 'the whole discovered queue must be persisted before acquiring: missing ' + id);
});

test('R2-4 unverifiable completed entries cannot claim completeness and never overlap owed work', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const mk = s => ({ shortcode: s, href: 'https://instacognito.com/media?id=' + s });
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 2, items: [mk('A'), mk('B')], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  // B's bytes rot on disk and no later scan re-observes B.
  await fsp.writeFile(path.join(out, 'media', 'example', 'B-0.jpg'), Buffer.from('rotted'));
  const s = await lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 2, items: [mk('A')], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  assert.notEqual(s.status, 'COMPLETE', 'a receipt that no longer verifies cannot count toward completeness');
  const manifest = await readManifest(out);
  const outstanding = { ...(manifest.failed || {}), ...(manifest.pending || {}) };
  assert.ok(outstanding['B-0'], 'the unverifiable id must be owed again');
  assert.equal(manifest.completed['B-0'], undefined, 'and it must not still be counted as completed');
  for (const id of Object.keys(outstanding)) assert.equal(manifest.completed[id], undefined, id + ' is both completed and owed');
});

test('R2-4b a checkpoint never lists a verified completed id as owed', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const mk = s => ({ shortcode: s, href: 'https://instacognito.com/media?id=' + s });
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [mk('A')], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  const seen = [];
  await lib.archiveProfile({
    handle: 'example', output: out, mode: 'sync', reportedTotal: 3, items: [mk('A'), mk('B'), mk('C')], dnsLookup: publicDns, delayMs: 0, checkpointEveryItems: 100,
    fetchImpl: async () => {
      if (!seen.length) {
        const onDisk = await readJson(path.join(out, '.frameferry', 'example', 'manifest.json')).catch(() => null);
        seen.push(onDisk ? { ...(onDisk.failed || {}), ...(onDisk.pending || {}) } : {});
      }
      return res();
    }
  });
  assert.equal(seen[0]['A-0'], undefined, 'an id with a verified receipt must not be checkpointed as owed');
  assert.ok(seen[0]['C-0'], 'while genuinely unacquired work still must be');
});

test('R2-5 identity must be positively proved on every resolution path', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const item = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  const root = await lib.safeOutputRoot(out);
  const paths = lib.profilePaths(root, 'example');
  const receipt = (await readManifest(out)).completed['A-0'];

  // A receipt missing its identity fields proves nothing.
  const noId = { ...receipt }; delete noId.stableId; delete noId.id;
  assert.deepEqual((await lib.reconcileAgainstReceipts(paths, { 'B-0': noId }, { 'B-0': { stableId: 'B-0', error: 'x' } }, 'example')).resolved, [], 'a receipt with no stableId must not resolve anything');
  const noHandle = { ...receipt }; delete noHandle.profileHandle;
  assert.deepEqual((await lib.reconcileAgainstReceipts(paths, { 'A-0': noHandle }, { 'A-0': { stableId: 'A-0', error: 'x' } }, 'example')).resolved, [], 'a receipt with no handle must not resolve anything');

  // Content-identical reuse inside downloadOne must check identity too, not just the hash.
  const foreign = { ...receipt, profileHandle: 'someoneelse' };
  const got = await lib.downloadOne({ ...item, stableId: 'A-0', carouselIndex: 0, category: 'posts', mediaType: 'image' }, paths, {
    dnsLookup: publicDns, fetchImpl: async () => res(), runId: 'r', remainingMs: 5000, completedMap: { 'A-0': foreign }, handle: 'example'
  });
  assert.notEqual(got.receipt.profileHandle, 'someoneelse', 'a receipt belonging to another handle must never be reused by content match');
  assert.equal(got.receipt.profileHandle, 'example');
});

test('R2-6 a failure after the owner claim is written still finalizes it', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const item = { shortcode: 'A', href: 'https://instacognito.com/media?id=a' };
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 });
  // status.json becomes un-writable, so the RUNNING status write fails right after the claim.
  const statusPath = path.join(out, '.frameferry', 'example', 'status.json');
  await fsp.rm(statusPath, { force: true });
  await fsp.mkdir(statusPath, { recursive: true });
  try {
    await assert.rejects(() => lib.archiveProfile({ handle: 'example', output: out, mode: 'sync', reportedTotal: 1, items: [item], dnsLookup: publicDns, fetchImpl: async () => res(), delayMs: 0 }));
  } finally {
    await fsp.rm(statusPath, { recursive: true, force: true });
  }
  const owner = await readJson(path.join(out, '.frameferry', 'example', 'current-owner.json')).catch(() => null);
  assert.notEqual(lib.evaluateOwnerRecord(owner).state, 'ACTIVE', 'a failed run must not leave a live claim behind');
  const root = await lib.safeOutputRoot(out);
  assert.equal(fs.existsSync(lib.profilePaths(root, 'example').lock), false, 'and it must not leave the lock behind');
});

test('R2-7 an item that keeps failing does not starve the rest of the backlog', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const mk = s => ({ shortcode: s, href: 'https://instacognito.com/media?id=' + s });
  const failing = async () => res({ body: Buffer.from('not-media'), headers: { 'content-type': 'image/jpeg' } });
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 2, items: [mk('B'), mk('C')], dnsLookup: publicDns, fetchImpl: failing, delayMs: 0 });
  // Only B is re-observed and fails again, so it has burnt more attempts than C.
  await lib.archiveProfile({ handle: 'example', output: out, reportedTotal: 2, items: [mk('B')], dnsLookup: publicDns, fetchImpl: failing, delayMs: 0 });
  const order = [];
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 2, items: [mk('B'), mk('C')], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => { order.push(new URL(url).searchParams.get('id')); return res(); }
  });
  assert.equal(order[0], 'C', 'the id that has consumed fewer attempts must be served first, got ' + order.join(','));
});

test('R2-9 a signed media URL is redacted whatever the query order', () => {
  const first = lib.redactSignedUrls('failed https://instacognito.com/media?signature=SIGVALUE&id=SECRETID more');
  assert.equal(first.includes('SECRETID'), false, 'id must not survive a signature-first URL: ' + first);
  assert.equal(first.includes('SIGVALUE'), false, 'the signature must not survive either: ' + first);
  const second = lib.redactSignedUrls('failed https://instacognito.com/media?id=SECRETID&signature=SIGVALUE more');
  assert.equal(second.includes('SECRETID'), false);
  assert.equal(second.includes('SIGVALUE'), false);
});

test('R2-9b a persisted failure never carries a signature-first media URL', async () => {
  const d = await tmp();
  const out = path.join(d, 'out');
  const item = { shortcode: 'A', href: 'https://instacognito.com/media?signature=SIGVALUE&id=SECRETID' };
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 1, items: [item], dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async url => { throw new Error('upstream exploded for ' + url); }
  });
  const manifest = JSON.stringify(await readManifest(out));
  assert.equal(manifest.includes('SECRETID'), false, 'the media id leaked into the manifest');
  assert.equal(manifest.includes('SIGVALUE'), false, 'the signature leaked into the manifest');
});

test('R2-8 a latched denial is checked before the coverage exit, not bypassed by it', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    const seen = await serveProfilePage(page, DENIAL_TABS_HTML, {
      '/api/posts': route => route.fulfill({ status: 429, headers: { 'retry-after': '120' }, contentType: 'application/json', body: '{"error":"slow down"}' })
    });
    const monitor = lib.attachContinuationRequestMonitor(page);
    try {
      // Latch a real denial first, exactly as an earlier window would have.
      await page.evaluate(() => fetch('/api/posts', { method: 'POST', body: '{}' }).catch(() => {}));
      await page.waitForTimeout(200);
      const apiBefore = seen.api;
      // Coverage is already satisfied by the three visible posts, so the loop takes its early exit.
      const section = await lib.scrapeCardSection(page, { category: 'posts', mediaTypes: ['image', 'video'], reportedTotal: 3, started: Date.now(), maxTimeMs: 15000, maxPages: 3, continuationMonitor: monitor });
      assert.equal(seen.api, apiBefore, 'a satisfied coverage exit must not trigger again');
      assert.notEqual(section.status, 'COMPLETE', 'a section may not settle COMPLETE while a denial is latched');
      assert.ok(section.evidence && section.evidence.blocked, 'the latched denial must be reported');
      assert.equal(section.evidence.blocked.status, 429);
      assert.ok(Date.parse(section.evidence.blocked.retryAt) > Date.now(), 'Retry-After must be preserved: ' + section.evidence.blocked.retryAt);
      assert.deepEqual(seen.unexpected, [], 'fixture must never reach the network');
    } finally {
      monitor.detach();
    }
  } finally {
    await browser.close();
  }
});
