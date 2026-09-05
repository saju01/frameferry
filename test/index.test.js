const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const lib = require('../src/index.js');
const jpg = Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4,0xff,0xd9]);
const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
function streamOf(buf, chunk=3) { let off=0; return new ReadableStream({ pull(controller){ if(off>=buf.length){controller.close(); return;} controller.enqueue(buf.subarray(off, off+chunk)); off+=chunk; } }); }
function res({status=200,url='https://instacognito.com/media?id=rotated',body=jpg,headers={'content-type':'image/jpeg'}}={}){ const lower=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v)])); if(!lower['content-length']) lower['content-length']=String(body.length); return {status,ok:status>=200&&status<300,url,headers:{get:k=>lower[String(k).toLowerCase()]||null},body:streamOf(body)}; }
async function tmp(){ return await fsp.mkdtemp(path.join(os.tmpdir(),'instascrap-test-')); }
async function readManifest(out){ return JSON.parse(await fsp.readFile(path.join(out,'.instascrap','example','manifest.json'),'utf8')); }

test('normalizes real provider carousel: one card per slide with same shortcode becomes multiple media', () => {
  const raw=[
    {shortcode:'CAR',href:'https://instacognito.com/media?id=1'},
    {shortcode:'CAR',href:'https://instacognito.com/media?id=2'},
    {shortcode:'OTHER',href:'https://instacognito.com/media?id=3'},
    {shortcode:'CAR',carouselIndex:1,href:'https://instacognito.com/media?id=dup'}
  ];
  const n=lib.normalizeItems(raw);
  assert.equal(n.uniquePostCount,2);
  assert.deepEqual(n.items.map(i=>i.stableId), ['CAR-0','CAR-1','OTHER-0']);
});

test('repeat-page cards dedupe before assigning carousel indices', () => {
  const page=[
    {shortcode:'CAR',href:'https://instacognito.com/media?id=one',type:'photo'},
    {shortcode:'CAR',href:'https://instacognito.com/media?id=two',type:'photo'},
    {shortcode:'OTHER',href:'https://instacognito.com/media?id=three',type:'photo'}
  ];
  const n=lib.normalizeItems([...page,...page]);
  assert.deepEqual(n.items.map(i=>i.stableId), ['CAR-0','CAR-1','OTHER-0']);
});

test('malformed dates are preserved instead of becoming invalid watermark', () => { assert.equal(lib.parseDateText('views\nnot a date'), 'not a date'); });

test('reported count parser uses POSTS adjacency, not max followers/header integers', () => {
  assert.equal(lib.parseReportedTotal('Followers 125,000 Following 12 POSTS 68'), 68);
  assert.equal(lib.parseReportedTotal('68 posts 125,000 followers'), 68);
  assert.equal(lib.parseReportedTotal('125,000 followers only'), null);
});

test('unknown denom cannot claim complete and advertised shortfall is partial', () => {
  assert.equal(lib.decideOutcome({reportedTotal:null,uniquePostCount:10,failed:0}).status, 'ACTION_REQUIRED');
  assert.equal(lib.decideOutcome({reportedTotal:20,uniquePostCount:12,failed:0}).status,'PARTIAL');
});

test('provider URL validation rejects non-provider and non-https', () => {
  assert.throws(()=>lib.validateProviderMediaUrl('http://instacognito.com/media?id=x'), /media URL/);
  assert.throws(()=>lib.validateProviderMediaUrl('https://evil.test/media?id=x'), /media URL/);
  assert.doesNotThrow(()=>lib.validateProviderMediaUrl('https://instacognito.com/media?id=x'));
});

test('redirect SSRF private hosts, mapped hex IPv6, CGNAT, and DNS failures are rejected', async () => {
  await assert.rejects(()=>lib.validateRedirectTarget('https://127.0.0.1/x'), /private/);
  await assert.rejects(()=>lib.validateRedirectTarget('https://localhost/x'), /private/);
  await assert.rejects(()=>lib.validateRedirectTarget('https://example.com/x', async()=>{ throw new Error('dns down'); }), /failed closed/);
  assert.equal(lib.isPrivateIp('100.64.0.1'), true);
  assert.equal(lib.isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(lib.isPrivateIp('0:0:0:0:0:ffff:7f00:1'), true);
});

test('handle traversal and output symlink are rejected', async () => {
  assert.throws(()=>lib.validateHandle('../bad'), /handle/);
  const d=await tmp(); const target=path.join(d,'target'); const link=path.join(d,'link'); await fsp.mkdir(target); await fsp.symlink(target, link);
  await assert.rejects(()=>lib.safeOutputRoot(link), /symlink/);
});

test('download streams to .part, sha receipt, magic beats content type, and redacts signed urls', async () => {
  const d=await tmp(); const root=await lib.safeOutputRoot(path.join(d,'out')); const paths=lib.profilePaths(root,'example');
  const item={shortcode:'ABC',carouselIndex:0,href:'https://instacognito.com/media?id=fixture-redacted-token',type:'photo'};
  const receipt=await lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl:async()=>res({body:png,headers:{'content-type':'image/jpeg'}}),runId:'r1'});
  assert.equal(receipt.bytes,png.length); assert.match(receipt.path, /\.png$/); assert.match(receipt.sha256,/^[a-f0-9]{64}$/);
  assert.equal(fs.readdirSync(paths.mediaDir).some(n=>n.endsWith('.part')), false);
  assert.equal(lib.redactSignedUrls(item.href), 'https://instacognito.com/media?id=[REDACTED]');
});

test('HTML/truncation/oversize fail before unbounded buffering', async () => {
  const d=await tmp(); const root=await lib.safeOutputRoot(path.join(d,'out')); const paths=lib.profilePaths(root,'example');
  const item={shortcode:'ABC',carouselIndex:0,href:'https://instacognito.com/media?id=x'};
  await assert.rejects(()=>lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl:async()=>res({body:Buffer.from('<html></html>'),headers:{'content-type':'text/html'}})}), /HTML/);
  await assert.rejects(()=>lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl:async()=>res({headers:{'content-type':'image/jpeg','content-length':'999999'}}),maxBytes:10}), /exceeds/);
  await assert.rejects(()=>lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl:async()=>res({headers:{'content-type':'image/jpeg','content-length':'99'}})}), /length/);
});

test('429 Retry-After beyond budget persists DEFERRED and preserves prior completed evidence', async () => {
  const d=await tmp(); const out=path.join(d,'out');
  const okItem={shortcode:'A',href:'https://instacognito.com/media?id=a'};
  await lib.archiveProfile({handle:'example',output:out,reportedTotal:1,items:[okItem],dnsLookup:publicDns,fetchImpl:async()=>res(),delayMs:0});
  const deferItem={shortcode:'B',href:'https://instacognito.com/media?id=b'};
  await assert.rejects(()=>lib.archiveProfile({handle:'example',output:out,reportedTotal:2,items:[okItem,deferItem],dnsLookup:publicDns,fetchImpl:async url=> url.includes('b') ? res({status:429,headers:{'retry-after':'120','content-type':'image/jpeg'}}) : res(),remainingMs:1000,maxTimeMs:1000,delayMs:0}), err => err.code==='DEFERRED');
  const status=JSON.parse(await fsp.readFile(path.join(out,'.instascrap','example','status.json'),'utf8'));
  const manifest=await readManifest(out);
  assert.equal(status.status,'DEFERRED'); assert.ok(status.retryAt); assert.equal(Object.keys(manifest.completed).length,1);
});

test('429 within budget waits and retries same provider URL', async () => {
  const d=await tmp(); const root=await lib.safeOutputRoot(path.join(d,'out')); const paths=lib.profilePaths(root,'example');
  const item={shortcode:'ABC',href:'https://instacognito.com/media?id=x'}; let calls=0;
  const fetchImpl=async()=>{ calls++; return calls===1 ? res({status:429,headers:{'retry-after':'0','content-type':'image/jpeg'}}) : res(); };
  const receipt=await lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl,remainingMs:1000,runId:'r'});
  assert.equal(calls,2); assert.equal(receipt.bytes,jpg.length);
});

test('sync reuses verified receipts: second run same IDs rotated URLs performs zero fetches', async () => {
  const d=await tmp(); const out=path.join(d,'out'); let calls=0;
  const items1=[{shortcode:'A',href:'https://instacognito.com/media?id=oldA'},{shortcode:'B',href:'https://instacognito.com/media?id=oldB'}];
  await lib.archiveProfile({handle:'example',output:out,mode:'full',reportedTotal:2,items:items1,dnsLookup:publicDns,fetchImpl:async()=>{calls++; return res();},delayMs:0});
  calls=0;
  const items2=[{shortcode:'A',href:'https://instacognito.com/media?id=newA'},{shortcode:'B',href:'https://instacognito.com/media?id=newB'}];
  const s2=await lib.archiveProfile({handle:'example',output:out,mode:'sync',reportedTotal:2,items:items2,dnsLookup:publicDns,fetchImpl:async()=>{calls++; return res();},delayMs:0});
  assert.equal(s2.status,'COMPLETE'); assert.equal(s2.reusedCount,2); assert.equal(calls,0);
});

test('corrupted completed file is retried and repaired', async () => {
  const d=await tmp(); const out=path.join(d,'out'); let calls=0; const item={shortcode:'A',href:'https://instacognito.com/media?id=a'};
  await lib.archiveProfile({handle:'example',output:out,reportedTotal:1,items:[item],dnsLookup:publicDns,fetchImpl:async()=>{calls++; return res();},delayMs:0});
  await fsp.writeFile(path.join(out,'media','example','A-0.jpg'), Buffer.from('bad'));
  calls=0; const s=await lib.archiveProfile({handle:'example',output:out,mode:'sync',reportedTotal:1,items:[{shortcode:'A',href:'https://instacognito.com/media?id=rotated'}],dnsLookup:publicDns,fetchImpl:async()=>{calls++; return res();},delayMs:0});
  assert.equal(s.status,'COMPLETE'); assert.equal(calls,1);
});

test('failed manifest entries do not persist signed URLs while fresh overlap retries', async () => {
  const d=await tmp(); const out=path.join(d,'out'); const item={shortcode:'A',href:'https://instacognito.com/media?id=fixture-redacted'};
  await lib.archiveProfile({handle:'example',output:out,reportedTotal:1,items:[item],dnsLookup:publicDns,fetchImpl:async()=>res({body:Buffer.from('bad'),headers:{'content-type':'image/jpeg'}}),delayMs:0});
  const manifest=await readManifest(out);
  assert.equal(JSON.stringify(manifest.failed).includes('media?id='), false);
});

test('live lock rejects alive PID and stale lock recovers', async () => {
  const d=await tmp(); const root=await lib.safeOutputRoot(path.join(d,'out')); const paths=lib.profilePaths(root,'example'); await fsp.mkdir(paths.stateDir,{recursive:true});
  await fsp.writeFile(paths.lock, JSON.stringify({pid:process.pid,host:os.hostname(),runId:'alive'}));
  await assert.rejects(()=>lib.withLock(paths,'r',async()=>{}), /locked/);
  await fsp.writeFile(paths.lock, JSON.stringify({pid:99999999,host:os.hostname(),runId:'stale'}));
  await lib.withLock(paths,'r2',async()=>42); assert.equal(fs.existsSync(paths.lock), false);
});

test('secret redaction removes signed provider URLs from status-shaped text', () => { assert.equal(lib.redactSignedUrls('failed https://instacognito.com/media?id=abcDEF123 more').includes('abcDEF123'), false); });

test('CDP attach rejects non-loopback remote targets', async () => { await assert.rejects(()=>lib.archiveProfile({handle:'example',output:path.join(os.tmpdir(),'nope'),attachCdp:'http://192.168.1.2:9222'}), /CDP|loopback/); });



test('network timeout is capped by remaining maxTimeMs, not user larger networkTimeoutMs', async () => {
  const d=await tmp(); const out=path.join(d,'out');
  const started=Date.now();
  const fetchImpl=async (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
  const s=await lib.archiveProfile({handle:'example',output:out,reportedTotal:1,items:[{shortcode:'A',href:'https://instacognito.com/media?id=slow'}],dnsLookup:publicDns,fetchImpl,maxTimeMs:40,networkTimeoutMs:5000,delayMs:0});
  assert.equal(s.status,'PARTIAL');
  assert.ok(Date.now()-started < 1500);
});

test('profile extraction accepts a caller supplied timeout', async () => {
  let gotTimeout;
  const fakePage={ locator(){ return { first(){ return { innerText: async (opts) => { gotTimeout=opts.timeout; return 'POSTS 7'; } }; } }; } };
  assert.equal(await lib.extractReportedTotalFromPage(fakePage, 23), 7);
  assert.equal(gotTimeout, 23);
});

test('CLI doctor parses --attach-cdp without swallowing it as handle, and bad flags fail', () => {
  const bin=path.join(__dirname,'..','bin','instascrap.js');
  const bad=spawnSync(process.execPath,[bin,'doctor','--attach-cdp','http://192.168.1.2:9222'],{encoding:'utf8'});
  assert.equal(bad.status,1); assert.match(bad.stdout, /"cdpOk": false/);
  const miss=spawnSync(process.execPath,[bin,'archive','example','--max-pages'],{encoding:'utf8'});
  assert.equal(miss.status,1); assert.match(miss.stderr, /requires a value/);
  const unknown=spawnSync(process.execPath,[bin,'doctor','--bogus','value'],{encoding:'utf8'});
  assert.equal(unknown.status,1); assert.match(unknown.stderr, /not valid/);
  const inapplicable=spawnSync(process.execPath,[bin,'doctor','--output','x'],{encoding:'utf8'});
  assert.equal(inapplicable.status,1); assert.match(inapplicable.stderr, /not valid/);
});

test('actual Playwright DOM fixture models real carousel cards and profile-section POSTS parsing', async (t) => {
  let chromium; try { chromium=require('playwright').chromium; } catch { t.skip('playwright package unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no existing chromium binary; not downloading'); return; }
  const browser = await chromium.launch({ headless:true, executablePath: exe });
  try {
    const page = await browser.newPage();
    await page.setContent(`<header>Followers 125,000</header><section id="profile-section"><span>125,000 followers</span><b>2 POSTS</b></section><div id="post-container"><article class="post-card"><span data-id="CAR"></span><span data-type="photo"></span><a class="content-download-btn" href="https://instacognito.com/media?id=one">d</a><div class="post-footer">views\n2024-01-01</div></article><article class="post-card"><span data-id="CAR"></span><span data-type="photo"></span><a class="content-download-btn" href="https://instacognito.com/media?id=two">d</a><div class="post-footer">views\n2024-01-01</div></article><article class="post-card"><span data-id="OTHER"></span><span data-type="video"></span><a class="content-download-btn" href="https://instacognito.com/media?id=three">d</a><div class="post-footer">plays\n2024-01-02</div></article></div>`);
    const total = await lib.extractReportedTotalFromPage(page);
    const got = await lib.extractItemsFromPage(page,total);
    assert.equal(total,2); assert.equal(got.uniquePostCount,2); assert.deepEqual(got.items.map(i=>i.stableId), ['CAR-0','CAR-1','OTHER-0']);
  } finally { await browser.close(); }
});
