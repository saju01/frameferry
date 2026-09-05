const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const lib = require('../src/index.js');
const jpg = Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4,0xff,0xd9]);
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
function res({status=200,url='https://instacognito.com/media?id=rotated',body=jpg,headers={'content-type':'image/jpeg'}}={}){ const lower=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v)])); if(!lower['content-length']) lower['content-length']=String(body.length); return {status,ok:status>=200&&status<300,url,headers:{get:k=>lower[String(k).toLowerCase()]||null},arrayBuffer:async()=>body}; }
async function tmp(){ return await fsp.mkdtemp(path.join(os.tmpdir(),'instacog-test-')); }

test('synthetic carousel pagination >12, pinned duplicate, and duplicate-code dedupe counts posts vs media', () => {
  const raw=[]; for(let i=0;i<14;i++) raw.push({shortcode:'P'+i,carouselIndex:0,href:'https://instacognito.com/media?id=a'+i,type:'photo',dateText:'likes\n2024-01-01'});
  raw.unshift({shortcode:'PINNED',carouselIndex:0,href:'https://instacognito.com/media?id=p1'});
  raw.push({shortcode:'PINNED',carouselIndex:0,href:'https://instacognito.com/media?id=p2'});
  raw.push({shortcode:'P3',carouselIndex:1,href:'https://instacognito.com/media?id=c2'});
  const n=lib.normalizeItems(raw);
  assert.equal(n.uniquePostCount,15);
  assert.equal(n.items.length,16);
  assert.equal(n.items.filter(i=>i.shortcode==='PINNED').length,1);
});

test('malformed dates are preserved instead of becoming invalid watermark', () => {
  assert.equal(lib.parseDateText('views\nnot a date'), 'not a date');
});

test('reported count parser handles grouped integers', () => {
  assert.equal(lib.parseReportedTotal('Profile has 1,234 posts'), 1234);
});

test('unknown denom cannot claim complete and advertised shortfall is partial', () => {
  assert.equal(lib.decideOutcome({reportedTotal:null,uniquePostCount:10,failed:0}).status, 'ACTION_REQUIRED');
  const o=lib.decideOutcome({reportedTotal:20,uniquePostCount:12,failed:0});
  assert.equal(o.status,'PARTIAL');
});

test('provider URL validation rejects non-provider and non-https', () => {
  assert.throws(()=>lib.validateProviderMediaUrl('http://instacognito.com/media?id=x'), /media URL/);
  assert.throws(()=>lib.validateProviderMediaUrl('https://evil.test/media?id=x'), /media URL/);
  assert.doesNotThrow(()=>lib.validateProviderMediaUrl('https://instacognito.com/media?id=x'));
});

test('redirect SSRF and private hosts are rejected', async () => {
  await assert.rejects(()=>lib.validateRedirectTarget('https://127.0.0.1/x'), /private/);
  await assert.rejects(()=>lib.validateRedirectTarget('https://localhost/x'), /private/);
});

test('handle traversal and output symlink are rejected', async () => {
  assert.throws(()=>lib.validateHandle('../bad'), /handle/);
  const d=await tmp(); const target=path.join(d,'target'); const link=path.join(d,'link'); await fsp.mkdir(target); await fsp.symlink(target, link);
  await assert.rejects(()=>lib.safeOutputRoot(link), /symlink/);
});

test('download writes part atomically, sha receipt, and redacts signed urls', async () => {
  const d=await tmp(); const root=await lib.safeOutputRoot(path.join(d,'out')); const paths=lib.profilePaths(root,'example');
  const item={shortcode:'ABC',carouselIndex:0,href:'https://instacognito.com/media?id=secret-token',type:'photo'};
  const receipt=await lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl:async()=>res(),runId:'r1'});
  assert.equal(receipt.bytes,jpg.length); assert.match(receipt.sha256,/^[a-f0-9]{64}$/); assert.equal(receipt.sourceHost,'instacognito.com');
  assert.equal(fs.readdirSync(paths.mediaDir).some(n=>n.endsWith('.part')), false);
  assert.equal(lib.redactSignedUrls(item.href), 'https://instacognito.com/media?id=[REDACTED]');
});

test('HTML truncation and oversize/length errors are failures', async () => {
  const d=await tmp(); const root=await lib.safeOutputRoot(path.join(d,'out')); const paths=lib.profilePaths(root,'example');
  const item={shortcode:'ABC',carouselIndex:0,href:'https://instacognito.com/media?id=x'};
  await assert.rejects(()=>lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl:async()=>res({body:Buffer.from('<html></html>'),headers:{'content-type':'text/html'}})}), /HTML/);
  await assert.rejects(()=>lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl:async()=>res({headers:{'content-type':'image/jpeg','content-length':'999999'}}),maxBytes:10}), /exceeds/);
  await assert.rejects(()=>lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl:async()=>res({headers:{'content-type':'image/jpeg','content-length':'99'}})}), /length/);
});

test('429 Retry-After beyond budget becomes deferred with retryAt', async () => {
  const d=await tmp(); const root=await lib.safeOutputRoot(path.join(d,'out')); const paths=lib.profilePaths(root,'example');
  const item={shortcode:'ABC',carouselIndex:0,href:'https://instacognito.com/media?id=x'};
  await assert.rejects(()=>lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl:async()=>res({status:429,headers:{'retry-after':'120','content-type':'image/jpeg'}}),remainingMs:1000}), err => err.code==='DEFERRED' && !!err.retryAt);
});

test('archive second run is idempotent across signed URL rotation and retries failed', async () => {
  const d=await tmp(); const out=path.join(d,'out'); let call=0;
  const fetchImpl=async (url)=>{ call++; return res({url:'https://instacognito.com/media?id=rotated-'+call}); };
  const items1=[{shortcode:'A',carouselIndex:0,href:'https://instacognito.com/media?id=old'},{shortcode:'B',carouselIndex:0,href:'https://instacognito.com/media?id=old2'}];
  const s1=await lib.archiveProfile({handle:'example',output:out,mode:'full',reportedTotal:2,items:items1,fetchImpl,dnsLookup:publicDns,delayMs:0});
  assert.equal(s1.status,'COMPLETE');
  const items2=[{shortcode:'A',carouselIndex:0,href:'https://instacognito.com/media?id=new'}];
  const s2=await lib.archiveProfile({handle:'example',output:out,mode:'sync',reportedTotal:1,items:items2,fetchImpl,dnsLookup:publicDns,delayMs:0});
  assert.equal(s2.status,'COMPLETE');
  const manifest=JSON.parse(await fsp.readFile(path.join(out,'.instacognito','example','manifest.json'),'utf8'));
  assert.equal(Object.keys(manifest.completed).length,2);
  assert.equal(JSON.stringify(manifest).includes('media?id='), false);
});

test('failed bytes are preserved for retry and cancellation/failed checkpoint is not OK', async () => {
  const d=await tmp(); const out=path.join(d,'out'); let first=true;
  const item={shortcode:'A',carouselIndex:0,href:'https://instacognito.com/media?id=x'};
  const badThenGood=async()=>{ if(first){ first=false; return res({body:Buffer.from('bad'),headers:{'content-type':'image/jpeg'}}); } return res(); };
  const s1=await lib.archiveProfile({handle:'example',output:out,reportedTotal:1,items:[item],fetchImpl:badThenGood,dnsLookup:publicDns,delayMs:0});
  assert.equal(s1.status,'PARTIAL');
  const s2=await lib.archiveProfile({handle:'example',output:out,mode:'sync',reportedTotal:1,items:[item],fetchImpl:badThenGood,dnsLookup:publicDns,delayMs:0});
  assert.equal(s2.status,'COMPLETE');
});

test('live lock rejects alive PID and stale lock recovers', async () => {
  const d=await tmp(); const root=await lib.safeOutputRoot(path.join(d,'out')); const paths=lib.profilePaths(root,'example'); await fsp.mkdir(paths.stateDir,{recursive:true});
  await fsp.writeFile(paths.lock, JSON.stringify({pid:process.pid,runId:'alive'}));
  await assert.rejects(()=>lib.withLock(paths,'r',async()=>{}), /locked/);
  await fsp.writeFile(paths.lock, JSON.stringify({pid:99999999,runId:'stale'}));
  await lib.withLock(paths,'r2',async()=>42);
  assert.equal(fs.existsSync(paths.lock), false);
});

test('secret redaction removes signed provider URLs from status-shaped text', () => {
  const s=lib.redactSignedUrls('failed https://instacognito.com/media?id=abcDEF123 more');
  assert.equal(s.includes('abcDEF123'), false);
});


test('DNS failures fail closed and mapped/CGNAT addresses are private', async () => {
  await assert.rejects(()=>lib.validateRedirectTarget('https://example.com/x', async()=>{ throw new Error('dns down'); }), /failed closed/);
  assert.equal(lib.isPrivateIp('100.64.0.1'), true);
  assert.equal(lib.isPrivateIp('::ffff:127.0.0.1'), true);
});

test('429 within budget waits and retries same provider URL', async () => {
  const d=await tmp(); const root=await lib.safeOutputRoot(path.join(d,'out')); const paths=lib.profilePaths(root,'example');
  const item={shortcode:'ABC',carouselIndex:0,href:'https://instacognito.com/media?id=x'}; let calls=0;
  const fetchImpl=async()=>{ calls++; return calls===1 ? res({status:429,headers:{'retry-after':'0','content-type':'image/jpeg'}}) : res(); };
  const receipt=await lib.downloadOne(item,paths,{dnsLookup:publicDns,fetchImpl,remainingMs:1000,runId:'r'});
  assert.equal(calls,2); assert.equal(receipt.bytes,jpg.length);
});

test('failed manifest entries do not persist signed URLs while fresh overlap retries', async () => {
  const d=await tmp(); const out=path.join(d,'out');
  const item={shortcode:'A',carouselIndex:0,href:'https://instacognito.com/media?id=leaky'};
  await lib.archiveProfile({handle:'example',output:out,reportedTotal:1,items:[item],dnsLookup:publicDns,fetchImpl:async()=>res({body:Buffer.from('bad'),headers:{'content-type':'image/jpeg'}}),delayMs:0});
  const manifest=JSON.parse(await fsp.readFile(path.join(out,'.instacognito','example','manifest.json'),'utf8'));
  assert.equal(JSON.stringify(manifest.failed).includes('media?id='), false);
});

test('CDP attach rejects non-loopback remote targets', async () => {
  await assert.rejects(()=>lib.archiveProfile({handle:'example',output:path.join(os.tmpdir(),'nope'),attachCdp:'http://192.168.1.2:9222'}), /CDP|loopback/);
});
