'use strict';
// Permanent regressions for the FINAL PR7 closure findings PR-S1, PR-L1 and PR-L2.
//
// Every page here is a real Chromium DOM fulfilled in-process from synthetic HTML inside the
// no-network sandbox: no provider traffic, no signed locators, no private strings, no skips.
// See .review-evidence/passive-design.md for the mechanism these assertions encode. It
// SUPERSEDES .review-evidence/closure-design.md, whose forwarded-stream bound argument the
// independent review disproved; the PR-S1 block below reconciles each changed assertion.
// They are counterexamples, and must never be relaxed into successes.
const test=require('node:test'),{after}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises');
const fsSync=require('node:fs'),os=require('node:os'),path=require('node:path');
const F=require('../src/index.js'),W=require('../src/sync-window.js'),{openBudget}=require('../src/request-budget.js');
const SANITIZED=require('./fixtures/sanitized-listing.js');
const ORACLE=require('./fixtures/original-structure-oracle.js');
const {rec,posts,card,document_,responsePage,paintNow,RENDERER,PROFILE}=require('./fixtures/listing-page.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));

// ONE browser for the whole file, with a FRESH context and page per fixture. Several of these
// tests loop, and a browser per iteration pushed the full suite into the sandbox's 1GiB cgroup
// ceiling; contexts give the same isolation for a fraction of the memory.
let shared=null;
async function launch(){
 if(shared)return shared;
 const {chromium}=require('playwright');
 const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath();
 assert.ok(fsSync.existsSync(executablePath),'required real DOM browser must exist; no skips');
 shared=await chromium.launch({headless:true,executablePath});return shared;
}
after(async()=>{if(shared)await shared.close();shared=null;});
async function pageFixture(t,html=''){
 const browser=await launch(),context=await browser.newContext({serviceWorkers:'block'});
 t.after(()=>context.close());
 await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));
 const page=await context.newPage();await page.goto(F.PROVIDER_PHOTO_URL);return {page,context};
}
async function budget(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-closure-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const b=openBudget(path.join(root,'ledger.json'),'closure');t.after(()=>b.close());return b;
}
// Counts every second consumer and every platform object the observer could introduce, and the
// largest backing buffer any stream reader anywhere in the page was handed. The Response and
// ReadableStream counters are installed BEFORE the probe, so they see anything it constructs;
// objects the page itself builds in a test are noted in that test.
const INSTRUMENT=`(()=>{window.ffMeter={clones:0,tees:0,getReaders:0,defaultReads:0,byobReads:0,cancels:0,
  responses:0,streams:0,maxBacking:0};
 const nativeClone=Response.prototype.clone,nativeTee=ReadableStream.prototype.tee;
 Response.prototype.clone=function(){ffMeter.clones++;return nativeClone.apply(this,arguments);};
 ReadableStream.prototype.tee=function(){ffMeter.tees++;return nativeTee.apply(this,arguments);};
 const nativeGetReader=ReadableStream.prototype.getReader;
 ReadableStream.prototype.getReader=function(){ffMeter.getReaders++;return nativeGetReader.apply(this,arguments);};
 window.Response=new Proxy(Response,{construct(t,a,n){ffMeter.responses++;return Reflect.construct(t,a,n);}});
 window.ReadableStream=new Proxy(ReadableStream,{construct(t,a,n){ffMeter.streams++;return Reflect.construct(t,a,n);}});
 const note=s=>{if(s&&s.value&&s.value.buffer)ffMeter.maxBacking=Math.max(ffMeter.maxBacking,s.value.buffer.byteLength);return s;};
 const dr=ReadableStreamDefaultReader.prototype.read;
 ReadableStreamDefaultReader.prototype.read=function(){ffMeter.defaultReads++;return dr.apply(this,arguments).then(note);};
 const dc=ReadableStreamDefaultReader.prototype.cancel;
 ReadableStreamDefaultReader.prototype.cancel=function(){ffMeter.cancels++;return dc.apply(this,arguments);};
 if(window.ReadableStreamBYOBReader){const br=ReadableStreamBYOBReader.prototype.read;
  ReadableStreamBYOBReader.prototype.read=function(){ffMeter.byobReads++;return br.apply(this,arguments).then(note);};}
})()`;
const meter=page=>page.evaluate(()=>window.ffMeter);

// === PR-S1: the observer must not be a second consumer, nor a second anything ============
// RECONCILIATION with the interposition these tests were written for. The independent review
// disproved that design's acquisition/backing bound (PR-S1), its "measured peak" claim
// (PR-S1-accounting) and its Response-equivalence claim (CLOSURE-L3), and the approved repair
// DELETES it rather than patching its queue. The assertions below are therefore strictly
// stronger, never weaker: where a test previously allowed the observer to take the one reader
// and forward chunks, it now requires the observer to take nothing at all. The one assertion
// that is deliberately INVERTED is "an observation completes for a body the page never
// consumes": under the passive contract an unconsumed response is inconclusive by design, and it
// is kept below as an explicit negative control rather than deleted. peakObserverAllocationBytes
// is gone with the claim it encoded; retention and refusal bounds are asserted directly.
test('PR-S1: observing a listing body the page reads adds no second consumer and no wrapper',async t=>{
 const body=JSON.stringify(posts(rec({code:'A',media:'M'})));
 const {page,context}=await pageFixture(t);
 await context.route('**/api/posts',r=>r.fulfill({contentType:'application/json',body}));
 await page.evaluate(INSTRUMENT);
 await F.installRenderObservationProbe(page,{maxBytes:1048576,maxActiveReads:1,maxRetainedBytes:1048576,timeoutMs:4000});
 await page.evaluate(()=>{window.appText=null;fetch('/api/posts').then(r=>{
  window.appMeta={status:r.status,ok:r.ok,url:r.url,type:r.type,redirected:r.redirected,ct:r.headers.get('content-type'),
   own:Object.getOwnPropertyNames(r)};
  return r.text();}).then(s=>{window.appText=s;});});
 await page.waitForFunction(()=>window.appText!==null);
 await page.waitForFunction(()=>window.__ffWindowObservation.bodyReport(false).bodies[0]?.state==='read');
 const m=await meter(page),observed=await F.readListingBodyObservation(page),appMeta=await page.evaluate(()=>window.appMeta);
 console.log('NO_DUPLICATION '+JSON.stringify({meter:m,observed,appMeta}));
 assert.equal(m.clones,0,'the observer must not clone the response: a clone tees the body');
 assert.equal(m.tees,0,'the observer must not tee the body onto a branch it cannot bound');
 assert.equal(m.getReaders,0,'text() consumes internally: no reader may be acquired by anyone');
 assert.equal(m.responses,0,'the observer must construct no Response of its own');
 assert.equal(m.streams,0,'the observer must construct no stream and no queue of its own');
 assert.equal(observed.bodies[0].state,'read');
 assert.equal(observed.bodies[0].via,'text');
 // The application received its own body, byte for byte, on the NATIVE Response the provider
 // sent - not an equivalent one carrying a forwarded body.
 assert.equal(await page.evaluate(()=>window.appText),body);
 assert.equal(appMeta.status,200);assert.equal(appMeta.ok,true);
 assert.equal(appMeta.url,F.PROVIDER_ORIGIN+'/api/posts');
 assert.equal(appMeta.type,'basic');assert.equal(appMeta.redirected,false);
 assert.deepEqual(appMeta.own,[],'no own property may be defined on the response to imitate metadata');
 assert.match(appMeta.ct,/application\/json/);
});

test('PR-S1: the underlying source is pulled exactly once, never onto a second branch',async t=>{
 const {page}=await pageFixture(t);
 await page.evaluate(INSTRUMENT);
 // A counting source: if the observer duplicated the body onto a clone/tee branch, or pulled it
 // itself, the source would have to produce it more than once.
 await page.evaluate(()=>{window.produced=0;window.fetch=()=>Promise.resolve(new Response(new ReadableStream({
  start(c){const payload=new TextEncoder().encode('{"p":[],"pc":"0123456789_0123"}');
   window.produced+=payload.byteLength;c.enqueue(payload);c.close();}})));});
 await F.installRenderObservationProbe(page,{maxBytes:65536,maxActiveReads:1,maxRetainedBytes:65536,timeoutMs:4000});
 await page.evaluate(()=>{window.appLen=null;fetch('/api/posts').then(r=>r.text()).then(s=>{window.appLen=s.length;});});
 await page.waitForFunction(()=>window.appLen!==null);
 const observed=await F.readListingBodyObservation(page),m=await meter(page);
 const produced=await page.evaluate(()=>window.produced),appLen=await page.evaluate(()=>window.appLen);
 console.log('SINGLE_PULL_CHAIN '+JSON.stringify({produced,appLen,meter:m,observed}));
 assert.equal(m.clones,0);assert.equal(m.tees,0);
 assert.equal(produced,31,'the source produced the body exactly once');
 assert.equal(appLen,31,'and the application received all of it');
 assert.equal(observed.bodies[0].state,'read','from the application own single read the observation still completes');
 assert.equal(observed.bodies[0].retainedBytes,31);
});

test('PR-S1: a body the page never consumes is inconclusive, and is not read to make it complete',async t=>{
 // INVERTED, deliberately. The interposition completed this observation by taking the body's one
 // reader and draining it - which is exactly the acquisition the reviewer proved unbounded. A
 // passive observer never forces an application to consume a body so that observation can
 // succeed; an unconsumed response is inconclusive, and a window resting on it is refused.
 const {page,context}=await pageFixture(t);
 await context.route('**/api/posts',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(posts(rec({code:'A',media:'M'})))}));
 await page.evaluate(INSTRUMENT);
 await F.installRenderObservationProbe(page,{maxBytes:65536,maxActiveReads:1,maxRetainedBytes:65536,timeoutMs:400});
 await page.evaluate(()=>{fetch('/api/posts').catch(()=>{});});
 await pause(900);
 const observed=await F.readListingBodyObservation(page),m=await meter(page);
 console.log('UNCONSUMED_BODY '+JSON.stringify({observed,meter:m}));
 assert.equal(m.clones,0);assert.equal(m.tees,0);
 assert.equal(m.getReaders,0,'nothing may acquire the body reader');
 assert.equal(m.defaultReads,0,'nothing may read the body');
 assert.equal(m.responses,0);assert.equal(m.streams,0);
 assert.equal(observed.bodies[0].state,'unconsumed','an unread body is inconclusive, never accepting evidence');
 assert.equal(observed.bodies[0].text,null);
 assert.equal(observed.activeTaps,0);
 assert.equal(observed.retainedBytes,0);
 assert.equal(observed.retainedBackingBytes,0);
});

test('PR-S1: a retained observation must never pin a backing buffer past the ceiling',async t=>{
 const {page}=await pageFixture(t);
 await page.evaluate(INSTRUMENT);
 // One byte of payload carried on a 65536-byte ArrayBuffer: byteLength accounting cannot see the
 // allocation the view pins. A passive observer never holds a view at all - it looks only at the
 // string or the parsed value the application itself produced.
 await page.evaluate(()=>{window.fetch=()=>Promise.resolve(new Response(new ReadableStream({
  start(c){c.enqueue(new Uint8Array(new ArrayBuffer(65536),0,1));c.close();}})));});
 await F.installRenderObservationProbe(page,{maxBytes:64,maxActiveReads:1,maxRetainedBytes:64,timeoutMs:4000});
 await page.evaluate(()=>{window.appDone=false;fetch('/api/posts').then(async r=>{
  const rd=r.body.getReader();for(;;){const s=await rd.read();if(s.done)break;}window.appDone=true;});});
 await page.waitForFunction(()=>window.appDone===true);
 await pause(100);
 const observed=await F.readListingBodyObservation(page),m=await meter(page);
 console.log('BACKING_CEILING '+JSON.stringify({observed,meter:m}));
 const body=observed.bodies[0];
 assert.equal(m.clones,0);assert.equal(m.tees,0);
 assert.equal(m.getReaders,1,'only the application acquired a reader');
 // Exactly the Response and the body stream the fixture page itself built, and not one platform
 // object more: the observer created no stream to hold those views in.
 assert.equal(m.streams,1,'the observer created no stream to hold those views in');
 assert.equal(m.responses,1,'the observer created no Response of its own');
 assert.equal(m.maxBacking,65536,'the counterexample really did deliver a huge backing buffer');
 assert.equal(body.retainedBackingBytes,0,'a raw-stream consumption is not an observed path and retains nothing');
 assert.equal(observed.retainedBackingBytes,0,'total observer retained allocation must respect the ceiling');
 assert.equal(observed.retainedBytes,0);
});

test('PR-S1: an over-ceiling application read is refused and retains nothing',async t=>{
 const {page,context}=await pageFixture(t);
 await context.route('**/api/posts',r=>r.fulfill({contentType:'application/octet-stream',body:Buffer.alloc(65536,65)}));
 await page.evaluate(INSTRUMENT);
 await F.installRenderObservationProbe(page,{maxBytes:64,maxActiveReads:1,maxRetainedBytes:64,timeoutMs:4000});
 await page.evaluate(()=>{window.appLen=null;fetch('/api/posts').then(r=>r.text()).then(s=>{window.appLen=s.length;});});
 await page.waitForFunction(()=>window.appLen!==null);
 await page.waitForFunction(()=>window.__ffWindowObservation.bodyReport(false).bodies[0]?.state==='oversized');
 const observed=await F.readListingBodyObservation(page),m=await meter(page);
 console.log('OVER_CEILING '+JSON.stringify({observed,meter:m,appLen:await page.evaluate(()=>window.appLen)}));
 assert.equal(m.clones,0,'refusing must not require a second consumer either');
 assert.equal(observed.bodies[0].retainedBytes,0,'an over-ceiling body retains nothing');
 assert.equal(observed.bodies[0].retainedBackingBytes,0);
 assert.equal(observed.retainedBytes,0);
 assert.ok(observed.refusedObservations>=1,'the observation must actually be refused at the ceiling');
 // The application still got its whole body: the observer refused to RETAIN, and never had
 // anything to withhold in the first place.
 assert.equal(await page.evaluate(()=>window.appLen),65536);
});

test('PR-S1: a body the observer cannot represent is refused, never read unbounded',async t=>{
 const {page}=await pageFixture(t);
 await page.evaluate(INSTRUMENT);
 // A non-byte source whose chunks are not ArrayBufferViews. The application's own text() rejects
 // on it; the observation follows that rejection into unknown evidence rather than reaching past
 // the application for bytes of its own.
 await page.evaluate(()=>{window.fetch=()=>Promise.resolve(new Response(new ReadableStream({
  start(c){c.enqueue('{"p":[],"pc":"0123456789_0123"}');c.close();}})));});
 await F.installRenderObservationProbe(page,{maxBytes:65536,maxActiveReads:1,maxRetainedBytes:65536,timeoutMs:4000});
 await page.evaluate(()=>{window.appRejected=null;fetch('/api/posts').then(r=>r.text())
  .then(()=>{window.appRejected=false;},()=>{window.appRejected=true;});});
 await page.waitForFunction(()=>window.appRejected!==null);
 await page.waitForFunction(()=>{const b=window.__ffWindowObservation.bodyReport(false).bodies[0];return b&&b.state!=='reading';});
 const observed=await F.readListingBodyObservation(page);
 console.log('UNACCOUNTABLE_CHUNK '+JSON.stringify({observed,appRejected:await page.evaluate(()=>window.appRejected)}));
 assert.equal(await page.evaluate(()=>window.appRejected),true,'the application own read must reject natively');
 assert.equal(observed.bodies[0].state,'unreadable','an unaccountable body must never produce accepting evidence');
 assert.equal(observed.retainedBytes,0);
 assert.equal(observed.retainedBackingBytes,0);
 assert.equal(observed.activeTaps,0);
});

test('PR-S1: however the application consumes its body, it still receives all of it',async t=>{
 const payload='{"p":[],"pc":"0123456789_0123"}';
 for(const how of ['pipeTo','tee','blob','arrayBuffer']){
  const {page,context}=await pageFixture(t);
  await context.route('**/api/posts',r=>r.fulfill({contentType:'application/json',body:payload}));
  await page.evaluate(INSTRUMENT);
  await F.installRenderObservationProbe(page,{maxBytes:65536,maxActiveReads:1,maxRetainedBytes:65536,timeoutMs:4000});
  await page.evaluate(async how=>{window.appBytes=null;
   const r=await fetch('/api/posts');
   if(how==='pipeTo'){let n=0;await r.body.pipeTo(new WritableStream({write(c){n+=c.byteLength;}}));window.appBytes=n;}
   else if(how==='tee'){const [a,b]=r.body.tee();b.cancel();
    const rd=a.getReader();let n=0;for(;;){const s=await rd.read();if(s.done)break;n+=s.value.byteLength;}window.appBytes=n;}
   else if(how==='blob'){window.appBytes=(await r.blob()).size;}
   else {window.appBytes=(await r.arrayBuffer()).byteLength;}},how);
  await page.waitForFunction(()=>window.appBytes!==null);
  const observed=await F.readListingBodyObservation(page),m=await meter(page);
  console.log('APP_CONSUMPTION '+JSON.stringify({how,appBytes:await page.evaluate(()=>window.appBytes),observed:observed.bodies[0],meter:m}));
  assert.equal(await page.evaluate(()=>window.appBytes),payload.length,'the application must receive its whole body');
  assert.equal(m.clones,0,'the observer still never clones');
  assert.equal(m.responses,0,'and never builds a Response');
  assert.equal(m.streams,0,'and never builds a stream');
  // None of these is a supported observation path, so all four are truthfully inconclusive and
  // none of them retains anything.
  assert.ok(['unconsumed','unsupported'].includes(observed.bodies[0].state),
   how+' must be typed inconclusive, was '+observed.bodies[0].state);
  assert.equal(observed.retainedBytes,0);
  assert.equal(observed.retainedBackingBytes,0);
 }
});

test('PR-S1: a truncated application read never becomes complete evidence',async t=>{
 // A cancelled stream reports done on the next read exactly as an exhausted one does. Nothing
 // may hold that prefix as a complete body: the decoder refusing truncated JSON is a second line
 // of defence, not the contract.
 const {page}=await pageFixture(t);
 await page.evaluate(INSTRUMENT);
 await page.evaluate(()=>{window.fetch=()=>Promise.resolve(new Response(new ReadableStream({
  start(c){c.enqueue(new TextEncoder().encode('{"p":[],"pc":"0123456789_0123"}'));}})));});
 await F.installRenderObservationProbe(page,{maxBytes:65536,maxActiveReads:1,maxRetainedBytes:65536,timeoutMs:5000});
 await page.evaluate(()=>{window.appTruncated=false;fetch('/api/posts').then(async r=>{
  const rd=r.body.getReader();
  await rd.read();
  await rd.cancel();
  await rd.read();
  window.appTruncated=true;});});
 await page.waitForFunction(()=>window.appTruncated===true);
 const observed=await F.readListingBodyObservation(page);
 console.log('TRUNCATED_READ '+JSON.stringify({observed}));
 assert.notEqual(observed.bodies[0].state,'read','a cancelled, incomplete read must never be complete evidence');
 assert.equal(observed.bodies[0].text,null);
 assert.equal(observed.retainedBytes,0);
 assert.equal(observed.retainedBackingBytes,0);
 assert.equal(observed.activeTaps,0);
});

test('PR-S1: a still-pending observation is released without touching the application read',async t=>{
 for(const how of ['generation','timeout']){
  const {page}=await pageFixture(t);
  await page.evaluate(INSTRUMENT);
  // The application calls json() on a body that is deliberately left OPEN, so its own read is
  // genuinely outstanding - and the observation genuinely armed - when the deadline or the new
  // generation arrives.
  await page.evaluate(()=>{window.release=null;window.fetch=()=>Promise.resolve(new Response(new ReadableStream({
   start(c){c.enqueue(new TextEncoder().encode('{"p":[],'));
    window.release=()=>{c.enqueue(new TextEncoder().encode('"pc":"0123456789_0123"}'));c.close();};}})));});
  await F.installRenderObservationProbe(page,{maxBytes:65536,maxActiveReads:1,maxRetainedBytes:65536,timeoutMs:how==='timeout'?150:8000});
  await page.evaluate(()=>{window.appJson=null;window.appSettled=false;
   fetch('/api/posts').then(r=>r.json()).then(v=>{window.appJson=v;window.appSettled=true;});});
  await page.waitForFunction(()=>window.__ffWindowObservation.activeTaps===1);
  if(how==='generation')await F.beginRenderObservationGeneration(page);else await pause(400);
  const observed=await F.readListingBodyObservation(page),m=await meter(page);
  const settledBefore=await page.evaluate(()=>window.appSettled);
  // The application read finishes AFTERWARDS, on its own terms, with its own value.
  await page.evaluate(()=>window.release());
  await page.waitForFunction(()=>window.appSettled===true);
  const after=await F.readListingBodyObservation(page);
  console.log('PENDING_RELEASE '+JSON.stringify({how,observed,after,meter:m,settledBefore,
   appJson:await page.evaluate(()=>window.appJson)}));
  assert.equal(settledBefore,false,'the application read must still have been outstanding');
  assert.equal(observed.activeTaps,0,'an outstanding observation must be released, not left armed');
  assert.equal(observed.retainedBytes,0,'no evidence may survive release');
  assert.equal(observed.retainedBackingBytes,0);
  if(how==='generation')assert.equal(observed.bodies.length,0,'a new generation retires every body');
  else assert.equal(observed.bodies[0].state,'unreadable');
  assert.equal(m.clones,0);
  // The observer released ITS OWN slot only; it never held, cancelled or disturbed anything of
  // the application's, so the late completion resurrects neither evidence nor accounting.
  assert.equal(m.cancels,0,'the observer must never cancel the application own reader');
  assert.deepEqual(await page.evaluate(()=>window.appJson),{p:[],pc:'0123456789_0123'},
   'the application own json() resolves with its own value, unchanged');
  assert.equal(after.activeTaps,0);
  assert.equal(after.retainedBytes,0);
  if(how==='generation')assert.deepEqual(after.bodies,[]);
  else assert.equal(after.bodies[0].state,'unreadable');
 }
});

test('PR-S1: a healthy supported listing still accepts through the passive observer',async t=>{
 const browser=await launch(),context=await browser.newContext({serviceWorkers:'block'});
 t.after(()=>context.close());
 await context.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',
   body:JSON.stringify(u.pathname==='/api/posts'?SANITIZED.RESPONSE:{})});
  return route.fulfill({status:200,contentType:'text/html',body:document_(responsePage(paintNow))});
 });
 const page=await context.newPage(),b=await budget(t);
 const r=await W.discover(page,'example',b,Date.now()+20000,200,9000);
 console.log('HEALTHY_ACCEPT '+JSON.stringify({basis:r.binding.basis,cards:r.raw.length}));
 assert.equal(r.binding.basis,'response-tuples');
 assert.equal(r.raw.length,13,'12 primaries plus one om child render as 13 cards');
 assert.deepEqual(r.raw.map(x=>[x.shortcode,x.mediaType,x.dateRaw]),
  SANITIZED.TUPLES.map(x=>[x.shortcode,x.mediaType,x.dateRaw]));
});

// === PR-L1: halt retention reports, it does not emit ======================================
test('PR-L1: halt retention keeps late data but emits no fresh batch after refusal',async t=>{
 const {page,context}=await pageFixture(t,'<div id="post-container">'+card('OLD')+'</div>');
 let releaseDenied=null,releasePending=null;const requests=[];
 await context.route('**/api/**',r=>{requests.push(new URL(r.request().url()).pathname);
  if(r.request().url().includes('denied'))releaseDenied=r;else releasePending=r;});
 const m=F.attachContinuationRequestMonitor(page,{pathname:null});t.after(()=>m.detach());
 await page.evaluate(html=>{fetch('/api/posts?denied=1').then(r=>r.text());
  fetch('/api/posts?pending=1').then(r=>r.text()).then(()=>{document.getElementById('post-container').innerHTML=html;});},card('NEW'));
 while(!releaseDenied||!releasePending)await pause(5);
 const callbacks=[];let armed=false,postRefusalRequests=0;
 page.on('request',r=>{if(m.denial()&&new URL(r.url()).pathname.startsWith('/api/'))postRefusalRequests++;});
 const result=await F.scrapeCardSection(page,{category:'posts',mediaTypes:['image'],reportedTotal:100,started:Date.now(),
  maxTimeMs:6000,maxPages:3,continuationMonitor:m,requireTerminal:true,onDiscoveryBatch:async batch=>{
   callbacks.push({codes:batch.items.map(x=>x.shortcode),denial:m.denial()?.status||null});
   if(!armed&&batch.items.length){armed=true;
    setTimeout(()=>releaseDenied.fulfill({status:429,headers:{'retry-after':'42'},body:'{}'}),80);
    setTimeout(()=>releasePending.fulfill({status:200,body:'{}'}),650);}
  }});
 console.log('HALT_CALLBACK '+JSON.stringify({status:result.status,blocked:result.evidence.blocked,
  returned:result.items.map(x=>x.shortcode),callbacks,requests:requests.length,postRefusalRequests}));
 assert.equal(result.status,'PARTIAL');
 assert.equal(result.evidence.blocked.status,429,'the first refusal is still reported');
 assert.equal(result.evidence.blocked.retryAt!=null,true,'Retry-After survives');
 assert.ok(result.items.some(x=>x.shortcode==='OLD'));
 assert.ok(result.items.some(x=>x.shortcode==='NEW'),'already-requested late render remains reportable');
 assert.equal(postRefusalRequests,0,'no fresh request after refusal');
 assert.equal(callbacks.filter(c=>c.denial&&c.codes.length).length,0,'new item batches must not escape after refusal');
 assert.ok(callbacks.some(c=>!c.denial&&c.codes.includes('OLD')),'pre-refusal emission is unchanged');
});

// === PR-L2: the public derivative must keep the real relationships ========================
const partitions=response=>{
 const nodes=[];
 (response.p||[]).forEach((r,i)=>{nodes.push(['p['+i+']',r]);
  (r.om||[]).forEach((c,j)=>nodes.push(['p['+i+'].om['+j+']',c]));});
 const fields=[...new Set(nodes.flatMap(([,n])=>Object.keys(n)))].filter(f=>f!=='om').sort();
 const out={nodes:nodes.map(([label])=>label),keySets:nodes.map(([,n])=>Object.keys(n).sort()),fields:{}};
 for(const field of fields){
  const classes=new Map();
  out.fields[field]=nodes.map(([,n])=>{
   if(!(field in n))return null;
   const v=n[field];
   if(!classes.has(v))classes.set(v,classes.size);
   return classes.get(v);
  });
 }
 return out;
};
test('PR-L2: the sanitized derivative reproduces the original equality relationships',()=>{
 const actual=partitions(SANITIZED.RESPONSE);
 // Failures print field names, node indices and class integers only - never a value from
 // either the public fixture or the original capture.
 assert.deepEqual(actual.nodes,ORACLE.nodes,'node count, order and carousel nesting');
 assert.deepEqual(actual.keySets,ORACLE.keySets,'per-node key sets, i.e. the image/video split');
 assert.deepEqual(Object.keys(actual.fields).sort(),Object.keys(ORACLE.fields).sort(),'field name set');
 for(const field of Object.keys(ORACLE.fields))
  assert.deepEqual(actual.fields[field],ORACLE.fields[field],'equality classes for field '+field);
 assert.equal(typeof SANITIZED.RESPONSE.pc,ORACLE.pcType,'pc type');
 // A per-field class scheme cannot express a relationship BETWEEN two fields of one record, so
 // vu === vhu gets its own assertion rather than being claimed and left unguarded.
 const videos=[];
 (SANITIZED.RESPONSE.p||[]).forEach(r=>{videos.push(r);(r.om||[]).forEach(c=>videos.push(c));});
 assert.equal(videos.filter(n=>'vu' in n).every(n=>n.vu===n.vhu),ORACLE.vuEqualsVhuPerVideo,'vu === vhu per video');
});
test('PR-L2: the decoded public tuples still match the fixture response exactly',()=>{
 const decoded=F.decodeListingResponse(JSON.stringify(SANITIZED.RESPONSE));
 assert.equal(decoded.supported,true);
 assert.equal(decoded.tuples.length,ORACLE.nodes.length);
 assert.deepEqual(decoded.tuples.map(x=>[x.shortcode,x.mediaType,x.dateRaw]),
  SANITIZED.TUPLES.map(x=>[x.shortcode,x.mediaType,x.dateRaw]),'TUPLES must track the repaired response');
 assert.deepEqual(decoded.tuples.map(x=>x.mediaIdentity),SANITIZED.TUPLES.map(x=>'/media?id='+x.mediaId));
});
