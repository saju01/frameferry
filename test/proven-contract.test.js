'use strict';
// Permanent regressions for the PROVEN provider-contract repair (DR-S1, DR1-DR5).
//
// Every page here is a real Chromium DOM fulfilled in-process from synthetic HTML inside the
// no-network sandbox: no provider traffic, no signed locators, no private strings, no skips.
// Positive controls use the REAL captured `p`/`pc` representation via
// test/fixtures/sanitized-listing.js - a clearly labelled sanitized derivative that keeps the
// real structural relationships (12 records, one `om` child => 13 cards, 6 image / 7 video,
// reverse(hu|vhu) -> /media?id=). Adversarial payloads here are deliberate NEGATIVE controls
// for representations the decoder does not support, never production fallbacks.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),fsSync=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const F=require('../src/index.js'),W=require('../src/sync-window.js'),{openBudget}=require('../src/request-budget.js');
const SANITIZED=require('./fixtures/sanitized-listing.js');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const bind=(o,k)=>typeof o[k]==='function'?o[k].bind(o):o[k];
async function tmp(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-proven-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function launch(t){
 const {chromium}=require('playwright');
 const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath();
 assert.ok(fsSync.existsSync(executablePath),'required real DOM browser must exist; no skips');
 const browser=await chromium.launch({headless:true,executablePath});t.after(()=>browser.close());return browser;
}

const {opaque,rec,posts,card,PROFILE,document_,RENDERER,responsePage,paintNow,paintAfter}=require('./fixtures/listing-page.js');
async function windowFixture(t,{script,initial='',api}){
 const browser=await launch(t),context=await browser.newContext({serviceWorkers:'block'});
 const seen=[];let page=null;
 await context.route('**/*',async route=>{
  const request=route.request(),u=new URL(request.url());
  if(u.pathname.startsWith('/api/')){seen.push(u.pathname);return api(route,u);}
  return route.fulfill({status:200,contentType:'text/html',body:document_(script,initial)});
 });
 page=await context.newPage();
 const root=await tmp(t),budget=openBudget(path.join(root,'ledger.json'),'proven');t.after(()=>budget.close());
 return {page,budget,root,api:seen,context};
}
const listing=data=>(route,u)=>route.fulfill({status:200,contentType:'application/json',
 body:JSON.stringify(u.pathname==='/api/posts'?data:{})});
const outcome=promise=>promise.then(
 value=>({accepted:true,cards:value.raw.map(x=>x.shortcode),raw:value.raw,binding:value.binding}),
 e=>({accepted:false,code:e.code,readiness:e.details?.readiness}));
const trace=page=>page.evaluate(()=>window.trace||[]);
const live=page=>page.evaluate(()=>[...document.querySelectorAll('#post-container .post-card')]
 .map(c=>c.querySelector('[data-id]')?.getAttribute('data-id')));

// === POSITIVE CONTROLS on the real captured representation ===============================
test('proven contract: the real captured representation binds image, video and carousel cards',async t=>{
 const f=await windowFixture(t,{script:responsePage(paintNow),api:listing(SANITIZED.RESPONSE)});
 const r=await outcome(W.discover(f.page,'example',f.budget,Date.now()+20000,200,9000));
 assert.equal(r.accepted,true,'the proven p/pc representation must bind a healthy window');
 assert.equal(r.binding.basis,'response-tuples');
 assert.equal(r.raw.length,13,'12 primaries plus one om child render as 13 cards');
 assert.equal(r.raw.filter(x=>x.mediaType==='image').length,6);
 assert.equal(r.raw.filter(x=>x.mediaType==='video').length,7);
 // Every tuple - association, type and date - matches the decoded response, not just counts.
 assert.deepEqual(r.raw.map(x=>[x.shortcode,x.mediaType,x.dateRaw]),
  SANITIZED.TUPLES.map(x=>[x.shortcode,x.mediaType,x.dateRaw]));
 assert.deepEqual(r.raw.map(x=>F.providerMediaIdentity(x.href)),
  SANITIZED.TUPLES.map(x=>'/media?id='+x.mediaId));
 // The carousel child keeps its primary's shortcode and its own distinct locator.
 const carousel=r.raw.filter(x=>x.shortcode===SANITIZED.TUPLES[0].shortcode);
 assert.equal(carousel.length,2);
 assert.notEqual(F.providerMediaIdentity(carousel[0].href),F.providerMediaIdentity(carousel[1].href));
});
test('proven contract: an unchanged listing the response repeats stays healthy',async t=>{
 // The DOM already shows exactly what the response carries and nothing re-renders: a normal
 // quiet window must still bind, so this is not an always-refuse implementation.
 const payload=posts(rec({code:'AAA',media:'M1'}),rec({code:'BBB',media:'M2',type:'video'}));
 const initial=card('M1',{shortcode:'AAA'})+card('M2',{shortcode:'BBB',type:'video'});
 const f=await windowFixture(t,{script:responsePage('window.trace.push("no-render");'),initial,api:listing(payload)});
 const r=await outcome(W.discover(f.page,'example',f.budget,Date.now()+16000,50,7000));
 const why=JSON.stringify({code:r.code,cause:r.readiness?.cause,binding:r.readiness?.binding,
  samples:r.readiness?.samples,rawCount:r.readiness?.rawCount,transport:r.readiness?.transport,
  probe:await F.readRenderObservation(f.page),observer:await F.readListingBodyObservation(f.page)});
 assert.equal(r.accepted,true,'an unchanged but positively bound listing must remain acceptable: '+why);
 assert.equal(r.binding.basis,'response-tuples');
 assert.deepEqual(r.cards,['AAA','BBB']);
});
for(const delay of [100,1500])test('proven contract: a render delayed '+delay+'ms binds once it actually lands',async t=>{
 const payload=posts(rec({code:'NEW',media:'MN'}));
 const f=await windowFixture(t,{script:responsePage(paintAfter(delay)),initial:card('OLD',{year:2025}),api:listing(payload)});
 const r=await outcome(W.discover(f.page,'example',f.budget,Date.now()+20000,50,9000));
 assert.equal(r.accepted,true,'a genuinely delayed render must still bind inside the wait');
 assert.deepEqual(r.cards,['NEW']);
 assert.ok((await trace(f.page)).includes('rendered'));
});

// === DR1: request-generation-provenance is gone as an acceptance basis ====================
const staleScript=responsePage('document.getElementById("post-container").innerHTML='
 +JSON.stringify(card('OLD',{year:2025}))+';window.trace.push("old-rerendered-after-response");'
 +'setTimeout(function(){document.getElementById("post-container").innerHTML='+JSON.stringify(card('NEW'))
 +';window.trace.push("new-rendered");},2000);');
test('DR1: a response-driven structural re-render of OLD is not provenance',async t=>{
 const f=await windowFixture(t,{script:staleScript,initial:card('OLD',{year:2025}),api:listing({})});
 const r=await outcome(W.discover(f.page,'example',f.budget,Date.now()+14000,50,6000));
 const atReturn=await trace(f.page);
 await f.page.waitForFunction(()=>window.trace.includes('new-rendered'));
 assert.deepEqual(await live(f.page),['NEW']);
 assert.ok(atReturn.includes('old-rerendered-after-response'),'the counterexample must have re-rendered OLD after decoding');
 assert.equal(r.accepted,false,'an inert body carries no listing identity and can never certify one');
 assert.equal(r.code,'WINDOW_NOT_READY');
 assert.equal(r.readiness.binding.reason,'unknown-response-evidence');
 assert.equal(W.localWindowReadiness(r.readiness),false);
});
test('DR1: stale provenance cannot publish a nothing-new COMPLETE',async t=>{
 const root=await tmp(t),browser=await launch(t);let atClose=null;
 const install=async context=>{await context.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  return route.fulfill({status:200,contentType:'text/html',body:document_(staleScript,card('OLD',{year:2025}))});
 });};
 const chromium={launch:async()=>new Proxy(browser,{get(target,key){
  if(key!=='newContext')return bind(target,key);
  return async options=>{const context=await target.newContext(options);await install(context);
   return new Proxy(context,{get(ctx,k){if(k!=='newPage')return bind(ctx,k);
    return async()=>{const p=await ctx.newPage();return new Proxy(p,{get(page,prop){
     if(prop!=='close')return bind(page,prop);
     return async()=>{atClose=await trace(page).catch(()=>[]);return page.close();};}});};}});};}})};
 const r=await W.syncWindow({handles:[{handle:'example',dateAfter:'2026-01-01'}],runId:'proven-dr1',
  output:path.join(root,'out'),resultFile:path.join(root,'result.json'),
  requestLedger:path.join(root,'ledger.json'),maxTimeMs:12000},{chromium,readinessWaitMs:6000});
 const published=JSON.parse(await fsSync.promises.readFile(path.join(root,'result.json'),'utf8'));
 assert.equal(r.status,published.status);
 assert.ok(atClose.includes('old-rerendered-after-response'));
 assert.notEqual(published.status,'COMPLETE','a false nothing-new COMPLETE must not survive');
});

// === DR2/DR3: exhaustive tuple comparison, not independent token sets =====================
const adversarial=[
 {name:'crossed tuple associations',
  initial:card('M1',{shortcode:'B'})+card('M2',{shortcode:'A'}),
  payload:posts(rec({code:'A',media:'M1'}),rec({code:'B',media:'M2'})),
  later:card('M1',{shortcode:'A'})+card('M2',{shortcode:'B'})},
 {name:'duplicate same-id child multiplicity',
  initial:card('M',{shortcode:'A'}),
  payload:posts(rec({code:'A',media:'M',children:[{media:'M'}]})),
  later:card('M',{shortcode:'A'})+card('M',{shortcode:'A'})},
 {name:'missing carousel child',
  initial:card('M1',{shortcode:'A'}),
  payload:posts(rec({code:'A',media:'M1',children:[{media:'M2'}]})),
  later:card('M1',{shortcode:'A'})+card('M2',{shortcode:'A'})},
 {name:'stale date and media type on the same id',
  initial:card('SAME',{year:2025,type:'image'}),
  payload:posts(rec({code:'SAME',media:'SAME',type:'video',date:'1 January 2026'})),
  later:card('SAME',{year:2026,type:'video'})},
 {name:'mixed recognized and unknown payload fields',
  initial:card('OLD'),
  payload:{...posts(rec({code:'OLD',media:'OLD'})),items:[{code:'NEW',download:'https://media.example.invalid/new'}]},
  later:card('OLD')+card('NEW')}
];
for(const c of adversarial)test('DR2/DR3: '+c.name+' cannot certify an unrendered listing',async t=>{
 const f=await windowFixture(t,{script:responsePage('setTimeout(function(){'
  +'document.getElementById("post-container").innerHTML='+JSON.stringify(c.later)
  +';window.trace.push("rendered");},2000);'),initial:c.initial,api:listing(c.payload)});
 const r=await outcome(W.discover(f.page,'example',f.budget,Date.now()+14000,50,4500));
 const atReturn=await trace(f.page);
 await f.page.waitForFunction(()=>window.trace.includes('rendered'));
 assert.ok(!r.accepted||atReturn.includes('rendered'),
  'token sets certified the incomplete or semantically different pre-response listing');
 if(r.accepted)assert.deepEqual(r.cards,(await live(f.page)),'an accepted listing must be the rendered one');
});
test('DR3: a wholly unknown payload stays inconclusive',async t=>{
 const f=await windowFixture(t,{script:responsePage('document.getElementById("post-container").innerHTML='
  +JSON.stringify(card('NEW'))+';window.trace.push("rendered");'),initial:card('OLD'),
  api:listing({items:[{code:'NEW'}]})});
 const r=await outcome(W.discover(f.page,'example',f.budget,Date.now()+16000,50,6000));
 assert.equal(r.accepted,false);
 assert.equal(r.readiness.binding.reason,'unknown-response-evidence');
 assert.equal(W.localWindowReadiness(r.readiness),false);
});
// Unobserved variants are a missing prerequisite, never a guess.
const unsupported=[
 {name:'a video whose vu and vhu differ',payload:(()=>{const r=rec({code:'A',media:'M',type:'video'});r.vu=opaque('other');return posts(r);})()},
 {name:'a carousel child carrying its own children',payload:(()=>{const r=rec({code:'A',media:'M',children:[{media:'M2'}]});r.om[0].om=[];return posts(r);})()},
 {name:'a video carousel child',payload:(()=>{const r=rec({code:'A',media:'M',children:[{media:'M2'}]});r.om[0].vu=opaque('M2');r.om[0].vhu=opaque('M2');return posts(r);})()},
 {name:'an unknown extra item field',payload:(()=>{const r=rec({code:'A',media:'M'});r.extra='x';return posts(r);})()},
 {name:'a non-string listing field',payload:(()=>{const r=rec({code:'A',media:'M'});r.pd=20260101;return posts(r);})()},
 {name:'a missing required item field',payload:(()=>{const r=rec({code:'A',media:'M'});delete r.pd;return posts(r);})()}
];
for(const c of unsupported)test('proven contract: '+c.name+' is unsupported, not guessed',async t=>{
 const f=await windowFixture(t,{script:responsePage(paintNow),initial:card('OLD'),api:listing(c.payload)});
 const r=await outcome(W.discover(f.page,'example',f.budget,Date.now()+16000,50,6000));
 assert.equal(r.accepted,false,'an unobserved variant must not be certified');
 assert.equal(r.readiness.binding.reason,'unknown-response-evidence');
});
test('proven contract: an out-of-order listing settlement is inconclusive',async t=>{
 let n=0;
 const f=await windowFixture(t,{initial:card('OLD'),
  script:RENDERER+';window.trace=[];function show(){'
   +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
   +'fetch("/api/posts").then(function(r){return r.json();});'
   +'setTimeout(function(){fetch("/api/posts").then(function(r){return r.json();}).then(function(d){'
   +'window.trace.push("decoded");ffPaint(d);window.trace.push("rendered");});},100);}',
  api:(route,u)=>{
   if(u.pathname!=='/api/posts')return route.fulfill({status:200,contentType:'application/json',body:'{}'});
   const mine=++n;
   const body=JSON.stringify(mine===1?posts(rec({code:'FIRST',media:'M1'})):posts(rec({code:'SECOND',media:'M2'})));
   // The newest-issued response comes back FIRST, so which listing the page rendered is ambiguous.
   return mine===1?pause(900).then(()=>route.fulfill({status:200,contentType:'application/json',body}))
    :route.fulfill({status:200,contentType:'application/json',body});
  }});
 const r=await outcome(W.discover(f.page,'example',f.budget,Date.now()+16000,50,6000));
 assert.equal(r.accepted,false,'an out-of-order settlement must never accept');
 assert.equal(r.readiness.binding.reason,'out-of-order-response');
});

// === DR-S1: bounded, cancellable observation of already-generated bodies ==================
test('DR-S1: the transport monitor reads no response bytes of its own',async()=>{
 // The observer must never transfer or decode a body through the Playwright response API:
 // that call is neither bounded nor cancellable. Touching it here fails the test outright.
 const page=new EventEmitter(),frame={};page.mainFrame=()=>frame;
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null,
  responseEvidence:{maxBytes:64,timeoutMs:20,maxReceipts:4,maxActiveReads:2}});
 let reads=0;
 const boom=()=>{reads++;throw new Error('the observer must not read response bodies itself');};
 const request={url:()=>F.PROVIDER_ORIGIN+'/api/posts',frame:()=>frame};
 page.emit('request',request);
 page.emit('response',{request:()=>request,status:()=>200,headers:()=>({}),text:boom,body:boom});
 page.emit('requestfinished',request);
 await pause(30);
 assert.equal(reads,0,'no bytes may be read outside the admitted page-side observer bounds');
 const receipts=monitor.receipts();
 assert.equal(receipts.list.length,1);
 assert.equal(receipts.list[0].path,'/api/posts');
 assert.equal(receipts.list[0].status,200);
 assert.ok(!('media' in receipts.list[0]),'receipts carry transport metadata only');
 monitor.detach();
});
test('DR-S1: a body beyond the observer ceiling is cancelled and never accepts',async t=>{
 const big=posts(...Array.from({length:40},(_,i)=>rec({code:'C'+i,media:'M'+i,c:'x'})));
 const f=await windowFixture(t,{script:responsePage(paintNow),initial:card('OLD'),api:listing(big)});
 // A ceiling far below the payload: the clone reader must cancel rather than buffer it.
 const r=await outcome(W.discover(f.page,'example',f.budget,Date.now()+16000,200,6000,
  {responseEvidence:{maxBytes:256,timeoutMs:2000,maxReceipts:8,maxActiveReads:2}}));
 assert.equal(r.accepted,false,'an oversized body must be refused, never buffered into acceptance');
 assert.equal(r.readiness.binding.reason,'unknown-response-evidence');
 const observed=await F.readListingBodyObservation(f.page);
 assert.ok(observed,'the page-side observer must report its own state');
 const post=observed.bodies.find(b=>b.path==='/api/posts');
 assert.ok(post,'the listing body must have been observed');
 assert.equal(post.state,'oversized');
 assert.equal(post.retainedBytes,0,'a cancelled read retains nothing');
 assert.ok(observed.cancelledReads>=1,'the clone reader must actually be cancelled at the ceiling');
});
test('DR-S1: a new generation cancels outstanding reads and drops retained evidence',async t=>{
 const f=await windowFixture(t,{script:responsePage(paintNow),initial:card('OLD'),
  api:listing(posts(rec({code:'A',media:'M'})))});
 await F.installRenderObservationProbe(f.page,{maxBytes:65536,timeoutMs:2000,maxActiveReads:2,maxBodies:8});
 await f.page.goto(F.PROVIDER_PHOTO_URL,{waitUntil:'domcontentloaded'});
 await f.page.click('button#download-btn');
 await f.page.waitForFunction(()=>window.trace&&window.trace.includes('rendered'));
 const before=await F.readListingBodyObservation(f.page);
 assert.ok(before.bodies.some(b=>b.path==='/api/posts'&&b.state==='read'),'the clone read must land');
 await F.beginRenderObservationGeneration(f.page);
 const after=await F.readListingBodyObservation(f.page);
 assert.deepEqual(after.bodies,[],'a new generation drops every retained observer body');
 assert.equal(after.retainedBytes,0,'no accepting state may survive cancellation');
});

// === DR4: revalidate the document generation after the LAST awaited guard =================
async function sectionFixture(t,html){
 const browser=await launch(t),context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',route=>{const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/'))return route.fulfill({status:403,headers:{'retry-after':'42'},body:'{}'});
  return route.fulfill({status:200,contentType:'text/html',
   body:u.pathname==='/next'?'<div id="post-container">'+card('NEW')+'</div>':html});});
 const page=await context.newPage();await page.goto(F.PROVIDER_PHOTO_URL);
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null});t.after(()=>monitor.detach());
 return {page,monitor};
}
async function refuse(page,monitor){
 await page.evaluate(()=>fetch('/api/stories').then(r=>r.text()));
 const end=Date.now()+2000;while(monitor.inFlight()&&Date.now()<end)await pause(10);
 assert.equal(monitor.denial()?.status,403);
}
// Fires `action` inside the FINAL challenge read - the last await before the return.
function wrapFinalChallenge(page,{armed,action}){
 let fired=false;
 const proxied=new Proxy(page,{get(target,key){
  if(key!=='locator')return bind(target,key);
  return (selector,...rest)=>{const loc=target.locator(selector,...rest);
   if(!selector.includes('captcha'))return loc;
   return new Proxy(loc,{get(l,k){if(k!=='evaluateAll')return bind(l,k);
    return async(...args)=>{const seen=await l.evaluateAll(...args);
     if(!fired&&armed()){fired=true;await action();}return seen;};}});};}});
 return {page:proxied,fired:()=>fired};
}
test('DR4: a navigation inside the final refusal read invalidates the retired error',async t=>{
 const {page,monitor}=await sectionFixture(t,'<div id="error-no-content">RETIRED</div>');
 let armed=false,before,after;
 const w=wrapFinalChallenge(page,{armed:()=>armed,action:async()=>{
  before=monitor.generation();await page.goto(F.PROVIDER_ORIGIN+'/next');after=monitor.generation();}});
 const wrapped=new Proxy(w.page,{get(target,key){
  if(key!=='evaluate')return bind(target,key);
  return async(fn,arg)=>{const seen=await page.evaluate(fn,arg);
   if(Array.isArray(arg)&&arg.includes('#error-no-content'))armed=true;return seen;};}});
 const r=await F.waitForSectionReady(wrapped,'posts',Date.now(),6000,monitor);
 assert.equal(w.fired(),true,'the counterexample must have navigated inside the final read');
 assert.ok(after>before,'the document generation must actually have moved');
 assert.notEqual(r.kind,'error','a retired document may not be returned as a terminal error');
});
test('DR4: a stable ordinary absence with no transition is still terminal',async t=>{
 const {page,monitor}=await sectionFixture(t,'<div id="error-no-content">EMPTY</div>');
 const r=await F.waitForSectionReady(page,'posts',Date.now(),4000,monitor);
 assert.equal(r.kind,'error','revalidation must not turn a genuinely quiet absence into a non-answer');
 assert.equal(r.status,'UNAVAILABLE');
});

// === DR5: the first latched refusal wins, synchronously, at the final boundary ============
test('DR5: a refusal latched inside the final challenge read dominates the return',async t=>{
 const {page,monitor}=await sectionFixture(t,'<div id="post-container">'+card('OLD')+'</div>');
 let armed=false;
 const w=wrapFinalChallenge(page,{armed:()=>armed,action:()=>refuse(page,monitor)});
 const wrapped=new Proxy(w.page,{get(target,key){
  if(key!=='evaluate')return bind(target,key);
  return async(fn,arg)=>{const seen=await page.evaluate(fn,arg);if(arg==='posts')armed=true;return seen;};}});
 const r=await F.waitForSectionReady(wrapped,'posts',Date.now(),6000,monitor);
 assert.equal(w.fired(),true);
 assert.equal(r.kind,'blocked','an HTTP refusal latched during the final DOM check must not return cards');
 assert.equal(r.blocked.status,403);
 assert.equal(r.blocked.retryAt!=null,true,'the original Retry-After must propagate');
});
test('DR5: the last highlight group emits no batch after a latched refusal',async t=>{
 const html='<div id="profile-section"><span class="username-text">@example</span> 1 posts</div>'
  +'<div id="menu-wrapper"><button class="menu-item active" data-id="HIGHLIGHTS">Highlights</button></div>'
  +'<div id="highlights-container"><button class="highlight" onclick="document.getElementById(\'post-container\').innerHTML='
  +JSON.stringify(card('OLD')).replaceAll('"','&quot;')+'"><span>group</span></button></div><div id="post-container"></div>';
 const {page,monitor}=await sectionFixture(t,html);
 let armed=false;const batches=[];
 const w=wrapFinalChallenge(page,{armed:()=>armed,action:()=>refuse(page,monitor)});
 const wrapped=new Proxy(w.page,{get(target,key){
  if(key!=='locator')return bind(target,key);
  return (selector,...rest)=>{const loc=target.locator(selector,...rest);
   if(selector!=='#post-container .post-card')return loc;
   return new Proxy(loc,{get(l,k){if(k!=='evaluateAll')return bind(l,k);
    return async(...args)=>{const seen=await l.evaluateAll(...args);armed=true;return seen;};}});};}});
 const scan=await F.scanReadyProfilePage(wrapped,{handle:'example',categories:['highlights'],
  mediaTypes:['image'],maxPages:5,maxTimeMs:8000,continuationMonitor:monitor,
  onDiscoveryBatch:async b=>batches.push({items:b.items.map(x=>x.shortcode),denialAtCallback:monitor.denial()})});
 assert.equal(w.fired(),true);
 assert.ok(scan.sections.some(s=>s.evidence?.blocked?.status===403),'blocked evidence must be retained');
 assert.equal(batches.filter(b=>b.denialAtCallback&&b.items.length).length,0,
  'no batch may reach the ledger after the monitor already latched a refusal');
});
