'use strict';
// Permanent regressions for the approved readiness observation contract v2 (FR1-FR3).
// Every page here is a real Chromium DOM fulfilled in-process from synthetic HTML inside the
// no-network sandbox: no provider traffic, no signed locators, no private strings, no skips.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),fsSync=require('node:fs'),os=require('node:os'),path=require('node:path');
const F=require('../src/index.js'),W=require('../src/sync-window.js'),{openBudget}=require('../src/request-budget.js');
// The listing bodies below use the REAL observed representation, built here so a fixture can
// never be more permissive than the decoder. See test/fixtures/listing-page.js.
const {rec,posts,RENDERER}=require('./fixtures/listing-page.js');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const bind=(o,k)=>typeof o[k]==='function'?o[k].bind(o):o[k];
async function tmp(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-contract-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function launch(t){
 const {chromium}=require('playwright');
 const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath();
 assert.ok(fsSync.existsSync(executablePath),'required real DOM browser must exist; no skips');
 const browser=await chromium.launch({headless:true,executablePath});t.after(()=>browser.close());return browser;
}
const card=(id,{shortcode=id,year=2026,type='image'}={})=>'<div class="post-card"><img class="post-image" data-type="'+type+'">'
 +'<a class="content-download-btn" href="/media?id='+id+'"></a><span data-id="'+shortcode+'"></span>'
 +'<div class="post-footer"><span class="icon-group"><span>1 January '+year+'</span></span></div></div>';
const PROFILE='document.getElementById("profile-section").innerHTML=\'<span class="username-text">@example</span> 1 posts\';';
const document_=(script,initial='')=>'<input id="search-input"><button id="download-btn" onclick="show()">Search</button>'
 +'<div id="profile-section"></div><div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">Posts</button></div>'
 +'<div id="post-container">'+initial+'</div><script>'+script+'</script>';
// Renders the profile from /api/profile. `body` is whatever the listing handler should do with
// the decoded /api/posts response, so a fixture decides for itself when (or whether) it commits.
const responsePage=body=>RENDERER+';window.trace=[];function show(){'
 +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
 +'fetch("/api/posts").then(function(r){return r.json();}).then(function(d){window.trace.push("decoded");'+body+'});}';
const commit='ffPaint(d);window.trace.push("rendered");';
async function windowFixture(t,{script,initial='',api}){
 const browser=await launch(t),context=await browser.newContext({serviceWorkers:'block'});
 const seen=[];let page=null;
 await context.route('**/*',async route=>{
  const request=route.request(),u=new URL(request.url());
  if(u.pathname.startsWith('/api/')){
   let main=false;try{main=request.frame()===page.mainFrame();}catch{main=false;}
   seen.push({path:u.pathname,main});
   return api(route,u);
  }
  return route.fulfill({status:200,contentType:'text/html',body:document_(script,initial)});
 });
 page=await context.newPage();
 const root=await tmp(t),budget=openBudget(path.join(root,'ledger.json'),'contract');t.after(()=>budget.close());
 return {page,budget,root,api:seen,context};
}
const json=data=>route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
const outcome=promise=>promise.then(
 value=>({accepted:true,cards:value.raw.map(x=>x.shortcode),slides:value.raw.length,binding:value.binding,observedAt:value.observedAt}),
 e=>({accepted:false,code:e.code,readiness:e.details?.readiness}));
const live=page=>page.evaluate(()=>[...document.querySelectorAll('#post-container [data-id]')].map(x=>x.getAttribute('data-id')));

// --- FR1: a decoded response cannot certify the listing it has not replaced yet ----------
for(const delay of [100,2000])test('contract FR1: a response-driven render delayed '+delay+'ms cannot certify the pre-request listing',async t=>{
 const f=await windowFixture(t,{
  script:RENDERER+';window.trace=[];function show(){document.getElementById("post-container").innerHTML='+JSON.stringify(card('OLD'))+';'
   +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
   +'fetch("/api/posts").then(function(r){return r.json();}).then(function(d){window.trace.push("decoded");'
   +'setTimeout(function(){'+commit+'},'+delay+');});}',
  api:json(posts(rec({code:'NEW',media:'NEW'})))});
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+12000,10,6000));
 await f.page.waitForFunction(()=>window.trace.includes('rendered'));
 assert.deepEqual(await live(f.page),['NEW'],'the fixture must really replace the listing from its response');
 assert.equal(f.api.length,2);assert.ok(f.api.every(x=>x.main),'the fixture must issue its API traffic from the intended main frame');
 if(result.accepted)assert.deepEqual(result.cards,['NEW'],'a decoded response certified its own displaced pre-request listing');
 else assert.equal(result.code,'WINDOW_NOT_READY');
 if(delay===100){assert.equal(result.accepted,true,'the healthy render control must really succeed');assert.equal(result.binding.basis,'response-tuples');}
});
test('contract FR1: syncWindow cannot publish a nothing-new COMPLETE from a pre-request listing',async t=>{
 const root=await tmp(t),browser=await launch(t);let api=[],atClose=null;
 const install=async context=>{
  api=[];
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.pathname.startsWith('/api/')){api.push(u.pathname);return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(posts(rec({code:'NEW',media:'NEW'})))});}
   return route.fulfill({status:200,contentType:'text/html',body:document_(
    RENDERER+';window.trace=[];function show(){document.getElementById("post-container").innerHTML='+JSON.stringify(card('OLD',{year:2025}))+';'
    +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
    +'fetch("/api/posts").then(function(r){return r.json();}).then(function(d){window.trace.push("decoded");setTimeout(function(){'+commit+'},2000);});}')});
  });
 };
 const chromium={launch:async()=>new Proxy(browser,{get(b,k){
  if(k!=='newContext')return bind(b,k);
  return async options=>{
   const context=await b.newContext(options);await install(context);
   return new Proxy(context,{get(c,key){
    if(key!=='newPage')return bind(c,key);
    return async()=>{const page=await c.newPage();return new Proxy(page,{get(p,prop){
     if(prop!=='close')return bind(p,prop);
     return async()=>{atClose=await p.evaluate(()=>({trace:window.trace,live:[...document.querySelectorAll('#post-container [data-id]')].map(x=>x.getAttribute('data-id'))})).catch(()=>null);return p.close();};
    }});};
   }});
  };
 }})};
 const result=await W.syncWindow({handles:[{handle:'example',dateAfter:'2026-01-01'}],runId:'contract',output:path.join(root,'out'),
  resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'ledger.json'),maxTimeMs:10000},{chromium,readinessWaitMs:6000});
 const published=JSON.parse(await fs.readFile(path.join(root,'result.json'),'utf8'));
 assert.equal(published.status,result.status);
 assert.equal(api.length,2,'the fixture must really answer one profile and one listing request');
 assert.ok(atClose&&atClose.trace.includes('decoded'),'the browser must really have decoded the listing response before the page closed');
 assert.ok(result.status!=='COMPLETE'||result.handles.example.observations.every(x=>x.shortcode==='NEW'),
  'published a COMPLETE nothing-new window from the pre-request listing while the decoded response carried a qualifying item');
});
test('contract FR1: an unchanged listing is acceptable when the response positively binds it',async t=>{
 // "Nothing new" is a legitimate answer. The page never touches the DOM here: the only
 // evidence that the rendered listing is current is that the response identifies it.
 const f=await windowFixture(t,{initial:card('SAME'),script:responsePage(''),api:json(posts(rec({code:'SAME',media:'SAME'})))});
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+15000,10,5000));
 assert.equal(result.accepted,true,'a matching response that required no re-render must still bind its listing');
 assert.deepEqual(result.cards,['SAME']);
 assert.equal(result.binding.basis,'response-tuples');
 assert.deepEqual(await live(f.page),['SAME'],'the fixture must really never have re-rendered');
});
// An inert body used to be accepted on request-generation provenance. It carries no listing at
// all, so it is now unsupported evidence and can certify nothing - in either direction.
test('contract FR1: an inert listing response cannot certify a listing that predates the request',async t=>{
 const f=await windowFixture(t,{
  script:'function show(){document.getElementById("post-container").innerHTML='+JSON.stringify(card('STALE'))+';'
   +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
   +'fetch("/api/posts").then(function(r){return r.json();});}',
  api:json({})});
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+10000,10,3000));
 assert.equal(result.accepted,false,'an empty response beside a listing rendered before the request is not evidence');
 assert.equal(result.code,'UNSUPPORTED_LISTING_FORMAT');
 assert.equal(result.readiness.binding.reason,'unknown-response-evidence');
 assert.equal(result.readiness.cause,'unbound');
 assert.equal(W.localWindowReadiness(result.readiness),false,'an unbound window is not positive handle-local evidence');
});
// NEGATIVE control, formerly a positive one. A commit that lands after the request was issued
// cannot distinguish a genuine new render from a response handler re-painting the OLD cards, so
// request-generation provenance is no longer an acceptance basis at all.
test('contract FR1: an inert listing response is never accepted on request-generation provenance',async t=>{
 const f=await windowFixture(t,{script:responsePage('document.getElementById("post-container").innerHTML='+JSON.stringify(card('FRESH'))+';window.trace.push("rendered");'),api:json({})});
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+15000,10,5000));
 assert.equal(result.accepted,false,'a body carrying no listing identity must never certify a listing');
 assert.equal(result.code,'UNSUPPORTED_LISTING_FORMAT');
 assert.equal(result.readiness.binding.reason,'unknown-response-evidence');
 assert.equal(result.readiness.binding.basis,null,'there is exactly one acceptance basis and this is not it');
 assert.equal(W.localWindowReadiness(result.readiness),false);
});
test('contract FR1: a partially rendered carousel is not a bound listing',async t=>{
 const f=await windowFixture(t,{
  script:responsePage('document.getElementById("post-container").innerHTML='+JSON.stringify(card('A1',{shortcode:'A'}))+';'
   +'setTimeout(function(){'+commit+'},1500);'),
  api:json(posts(rec({code:'A',media:'A1',children:[{media:'A2'}]})))});
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+20000,10,8000));
 assert.equal(result.accepted,true);
 assert.equal(result.slides,2,'a carousel missing a child from the same response was accepted as the full listing');
 assert.equal(result.binding.basis,'response-tuples');
});
test('contract FR1: an out-of-order listing settlement is inconclusive, never an accepted window',async t=>{
 let held=null;
 const f=await windowFixture(t,{
  script:RENDERER+';function show(){fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
   +'fetch("/api/posts");'
   +'setTimeout(function(){fetch("/api/posts").then(function(r){return r.json();}).then(function(d){ffPaint(d);});},150);}',
  api:(route,u)=>{
   if(u.pathname!=='/api/posts')return route.fulfill({status:200,contentType:'application/json',body:'{}'});
   if(!held){held=route;return;}
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(posts(rec({code:'SECOND',media:'SECOND'})))});
  }});
 // Release the FIRST-issued listing response only after the second one has already settled, so
 // the newest-issued response is not the newest-settled: a real out-of-order arrival.
 const releasing=(async()=>{
  const end=Date.now()+9000;while(!held&&Date.now()<end)await pause(20);
  await pause(500);
  if(held)await held.fulfill({status:200,contentType:'application/json',body:JSON.stringify(posts(rec({code:'FIRST',media:'FIRST'})))}).catch(()=>{});
 })();
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+14000,10,5000));
 await releasing;
 assert.equal(result.accepted,false,'a listing response that settled out of issue order cannot bind a rendered listing');
 assert.equal(result.readiness?.binding?.reason,'out-of-order-response',JSON.stringify({code:result.code,cause:result.readiness?.cause,binding:result.readiness?.binding,transport:result.readiness?.transport}));
 assert.equal(result.readiness.cause,'unbound');
});
test('contract FR1: an oversized listing response is unknown evidence, not a licence to accept',async t=>{
 const f=await windowFixture(t,{
  script:responsePage('document.getElementById("post-container").innerHTML='+JSON.stringify(card('BIG'))+';window.trace.push("rendered");'),
  api:(route,u)=>route.fulfill({status:200,contentType:'application/json',
   body:u.pathname==='/api/posts'?JSON.stringify({p:[rec({code:'BIG',media:'BIG',date:'x'.repeat(1200000)})],pc:'x'}):'{}'})});
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+12000,10,4000));
 assert.equal(result.accepted,false,'an unreadably large response body must be inconclusive, never accepted');
 assert.equal(result.readiness.binding.reason,'unknown-response-evidence');
 assert.equal(result.readiness.cause,'unbound');
});
test('contract FR1: the accepting snapshot reads exactly the cards readRawCardsFromPage reads',async t=>{
 const browser=await launch(t),page=await browser.newPage();
 await page.setContent('<div id="profile-section"><span class="username-text">@example</span> 2 posts</div>'
  +'<div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">Posts</button></div>'
  +'<div id="post-container">'+card('v1',{shortcode:'MIX',type:'video'})+card('i2',{shortcode:'MIX'})+'</div>');
 await F.installRenderObservationProbe(page);
 const snapshot=await F.observeWindowSnapshot(page,{handle:'example',selector:'.g-recaptcha'});
 assert.deepEqual(snapshot.cards,await F.readRawCardsFromPage(page),'the coherent snapshot and the raw card read must never drift apart');
 assert.equal(snapshot.matched,true);assert.equal(snapshot.category,'POSTS');assert.equal(snapshot.sectionError,null);
 assert.ok(snapshot.probe&&Number.isInteger(snapshot.probe.commitGen)&&Number.isInteger(snapshot.probe.identityGen));
});
test('contract FR1: a local-only replacement inside the accepting seam cannot be returned as a matched snapshot',async t=>{
 const f=await windowFixture(t,{script:responsePage(commit),api:json(posts(rec({code:'NEW',media:'NEW'})))});
 const monitor=F.attachContinuationRequestMonitor(f.page,{pathname:null});t.after(()=>monitor.detach());
 let fired=false,lastRawAt=0,lastOp=null,firstSettled=0,settledReads=0;
 const wrapped=new Proxy(f.page,{get(target,prop){
  if(prop==='locator')return (selector,...rest)=>{
   const locator=target.locator(selector,...rest);
   if(selector!=='#post-container .post-card')return locator;
   return new Proxy(locator,{get(l,key){
    if(key!=='evaluateAll')return bind(l,key);
    return async(...args)=>{const raw=await l.evaluateAll(...args),s=monitor.snapshot();lastRawAt=Date.now();lastOp='raw';
     if(s.started>=2&&s.started===s.settled&&s.inFlight===0){firstSettled||=lastRawAt;settledReads++;}else{firstSettled=0;settledReads=0;}
     return raw;};
   }});
  };
  if(prop==='evaluate')return async(fn,arg)=>{
   const accepting=arg&&typeof arg==='object'&&!Array.isArray(arg)&&arg.handle==='example'&&arg.selector;
   const eligible=accepting&&!fired&&lastOp==='raw'&&Date.now()-lastRawAt<150&&settledReads>=3&&Date.now()-firstSettled>=500;
   if(accepting)lastOp='metadata';
   if(!eligible)return target.evaluate(fn,arg);
   fired=true;
   const seen=await target.evaluate(fn,arg);
   await target.evaluate(html=>{document.getElementById('post-container').innerHTML=html;},card('FINAL'));
   return seen;
  };
  return bind(target,prop);
 }});
 const result=await outcome(W.discover(wrapped,'example',f.budget,Date.now()+12000,10,4500));
 assert.equal(fired,true,'the accepting read must really have been intercepted');
 assert.deepEqual(await live(f.page),['FINAL'],'the fixture must really have replaced the card locally');
 if(result.accepted)assert.deepEqual(result.cards,['FINAL'],'the returned listing was verified against a different card generation');
 else assert.equal(result.code,'WINDOW_NOT_READY');
});

// A card that ticks its engagement counter, rewrites its caption and rotates its signed locator
// every 100ms: benign churn that must neither invalidate a stable identity nor ever stand in for
// the page painting a listing.
const richCard=(id,{shortcode=id}={})=>'<div class="post-card"><img class="post-image" data-type="image">'
 +'<a class="content-download-btn" href="/media?signature=one&id='+id+'"></a><span data-id="'+shortcode+'"></span>'
 +'<div class="post-content"><p>caption</p></div>'
 +'<span class="likes-trigger" data-id="'+shortcode+'"><span>1</span></span>'
 +'<span class="comments-trigger" data-id="'+shortcode+'"><span>1</span></span>'
 +'<div class="post-footer"><span class="icon-group"><span>1 January 2026</span></span></div></div>';
const ROTATE='window.rotations=0;setInterval(function(){var card=document.querySelector("#post-container .post-card");if(!card)return;'
 +'var id=card.querySelector("[data-id]").getAttribute("data-id");window.rotations++;'
 +'card.querySelector(".likes-trigger span").textContent=String(Date.now());'
 +'card.querySelector(".post-content p").textContent="caption-"+Date.now();'
 +'card.querySelector(".content-download-btn").href="/media?signature="+Date.now()+"&id="+id;},100);';
test('contract FR1: benign rotation inside the container is not the page painting a listing',async t=>{
 const f=await windowFixture(t,{
  script:'window.trace=[];function show(){document.getElementById("post-container").innerHTML='+JSON.stringify(richCard('OLD'))+';'+ROTATE
   +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
   +'fetch("/api/posts").then(function(r){return r.json();}).then(function(){window.trace.push("decoded");'
   +'setTimeout(function(){document.getElementById("post-container").innerHTML='+JSON.stringify(richCard('NEW'))+';window.trace.push("rendered");},2000);});}',
  api:json({})});
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+15000,10,6000));
 await f.page.waitForFunction(()=>window.trace.includes('rendered'));
 const rotations=await f.page.evaluate(()=>window.rotations);
 assert.ok(rotations>=5,'the fixture must really rotate engagement, caption and signed locator');
 assert.deepEqual([...new Set(await live(f.page))],['NEW'],'this card carries several data-id anchors; only the identity matters');
 if(result.accepted)assert.deepEqual(result.cards,['NEW'],'a benign rotation was accepted as evidence that the listing is current');
 else assert.equal(result.code,'UNSUPPORTED_LISTING_FORMAT');
});
test('contract FR1: an unrecognisable provider media locator is unknown evidence, never inert',async t=>{
 // A locator that cannot be reduced to a provider media identity - here one carrying a second
 // id - makes the record unsupported rather than "no items".
 // An opaque locator that reverses into an id providerMediaIdentity refuses - here one carrying
 // whitespace - is a locator this codebase cannot reduce, so the record is unsupported.
 const broken=rec({code:'CDN',media:'CDN'});broken.hu=[...'CDN ID'].reverse().join('');
 const f=await windowFixture(t,{script:responsePage(commit),api:(route,u)=>route.fulfill({status:200,contentType:'application/json',
  body:u.pathname==='/api/posts'?JSON.stringify(posts(broken)):'{}'})});
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+12000,10,4000));
 assert.equal(result.accepted,false,'a media locator this codebase cannot reduce to an identity must not be read as "no items"');
 assert.equal(result.readiness.binding.reason,'unknown-response-evidence');
 assert.equal(result.readiness.cause,'unbound');
});
test('contract FR1: a rendered card the current response does not identify cannot be certified',async t=>{
 const f=await windowFixture(t,{initial:card('KEEP'),
  script:responsePage('document.getElementById("post-container").insertAdjacentHTML("beforeend",'+JSON.stringify(card('NEW'))+');window.trace.push("rendered");'),
  api:json(posts(rec({code:'NEW',media:'NEW'})))});
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+12000,10,4000));
 assert.deepEqual(await live(f.page),['KEEP','NEW'],'the fixture must really leave a card the response never identified');
 assert.equal(result.accepted,false,'a listing wider than the response that identifies it is not a bound observation');
 assert.equal(result.readiness.binding.reason,'listing-exceeds-response-tuples');
});
test('contract FR1: unrelated API traffic cannot exhaust the bounded listing evidence',async t=>{
 const browser=await launch(t),context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',body:u.pathname==='/api/posts'?JSON.stringify(posts(rec({code:'NEW',media:'NEW'}))):'{}'});
  return route.fulfill({contentType:'text/html',body:'<div id="post-container"></div>'});
 });
 const page=await context.newPage();
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null,responseEvidence:{maxReceipts:4,maxBytes:1048576,timeoutMs:2000,maxActiveReads:4,maxBodies:64}});
 t.after(()=>monitor.detach());
 await page.goto(F.PROVIDER_PHOTO_URL,{waitUntil:'domcontentloaded'});
 await page.evaluate(async()=>{for(let i=0;i<8;i++)await fetch('/api/track?i='+i);await fetch('/api/posts');});
 const end=Date.now()+8000;
 while(!monitor.receipts().list.some(r=>r.path==='/api/posts')&&Date.now()<end)await pause(20);
 const receipts=monitor.receipts();
 assert.ok(monitor.snapshot().started>=9,'the fixture must really issue the unrelated traffic');
 assert.equal(receipts.overflow,null,'unrelated API traffic exhausted the listing evidence bound');
 assert.deepEqual([...new Set(receipts.list.map(r=>r.path))],['/api/posts']);
 assert.equal(receipts.list.length,1);
});
// --- FR2: ordinary terminal-error validity includes document generation -----------------
async function sectionFixture(t,{mode}){
 const browser=await launch(t),context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',route=>{
  const u=new URL(route.request().url());
  if(u.pathname==='/api/posts')return route.fulfill({status:403,contentType:'application/json',body:'{}'});
  if(u.pathname==='/next')return route.fulfill({contentType:'text/html',body:'<div id="post-container">'+card('NEW')+'</div>'});
  return route.fulfill({contentType:'text/html',body:mode==='stable'?'<div id="error-no-content">no content</div><div id="post-container"></div>'
   :mode==='navigation'?'<div id="error-no-content">STALE_OLD_DOCUMENT</div><div id="post-container"></div>'
   :'<div id="post-container">'+card('OLD')+'</div>'});
 });
 const page=await context.newPage();await page.goto(F.PROVIDER_PHOTO_URL);
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null});t.after(()=>monitor.detach());
 return {page,monitor};
}
test('contract FR2: a real navigation inside the atomic error read invalidates the retired document',async t=>{
 const f=await sectionFixture(t,{mode:'navigation'});
 let fired=false,before=null,after=null;
 const wrapped=new Proxy(f.page,{get(target,prop){
  if(prop!=='evaluate')return bind(target,prop);
  return async(fn,arg)=>{
   const seen=await target.evaluate(fn,arg);
   if(!fired&&Array.isArray(arg)&&arg.includes('#error-no-content')){
    fired=true;before={generation:f.monitor.generation(),transport:f.monitor.snapshot()};
    await target.goto(F.PROVIDER_ORIGIN+'/next',{waitUntil:'domcontentloaded'});
    after={generation:f.monitor.generation(),transport:f.monitor.snapshot()};
   }
   return seen;
  };
 }});
 const ready=await F.waitForSectionReady(wrapped,'posts',Date.now(),4000,f.monitor);
 assert.equal(fired,true);
 assert.deepEqual(before.transport,after.transport,'this reproduction must move no transport counter at all');
 assert.ok(after.generation>before.generation,'the fixture must really retire the document');
 assert.notEqual(ready.kind,'error','a retired document’s absence became terminal for its replacement');
 assert.equal(ready.kind,'cards','the replacement document’s listing is the observation that remains valid');
});
test('contract FR2: a stable ordinary absence with no transition is still terminal',async t=>{
 const f=await sectionFixture(t,{mode:'stable'});
 const ready=await F.waitForSectionReady(f.page,'posts',Date.now(),4000,f.monitor);
 assert.equal(ready.kind,'error');assert.equal(ready.status,'UNAVAILABLE');
});

// --- FR3: a positively observed refusal dominates every return --------------------------
test('contract FR3: a refusal settling inside the readiness read never returns cards',async t=>{
 const f=await sectionFixture(t,{mode:'cards'});
 let fired=false;
 const wrapped=new Proxy(f.page,{get(target,prop){
  if(prop!=='evaluate')return bind(target,prop);
  return async(fn,arg)=>{
   const seen=await target.evaluate(fn,arg);
   if(!fired&&Array.isArray(arg)&&arg.includes('#error-no-content')){
    fired=true;await target.evaluate(()=>fetch('/api/posts').then(r=>r.text()));
    const end=Date.now()+2000;while(f.monitor.inFlight()&&Date.now()<end)await pause(10);
    assert.equal(f.monitor.denial()?.status,403,'the fixture must really latch a refusal inside the read');
   }
   return seen;
  };
 }});
 const ready=await F.waitForSectionReady(wrapped,'posts',Date.now(),4000,f.monitor);
 assert.equal(fired,true);
 assert.equal(ready.kind,'blocked','a real HTTP refusal latched during readiness was bypassed and cards were returned');
 assert.equal(ready.blocked.status,403);
});
test('contract FR3: the last highlight group keeps a refusal and exposes no batch after it',async t=>{
 const browser=await launch(t),context=await browser.newContext({serviceWorkers:'block'});
 const html='<div id="profile-section"><span class="username-text">@example</span> 1 posts</div>'
  +'<div id="menu-wrapper"><button class="menu-item active" data-id="HIGHLIGHTS">Highlights</button></div>'
  +'<div id="highlights-container"><button class="highlight" onclick="group()"><span>group</span></button></div>'
  +'<div id="post-container"></div><script>window.groupClicked=false;function group(){window.groupClicked=true;'
  +'document.getElementById("post-container").innerHTML='+JSON.stringify(card('OLD'))+';}</script>';
 await context.route('**/*',route=>new URL(route.request().url()).pathname==='/api/stories'
  ?route.fulfill({status:403,contentType:'application/json',body:'{}'})
  :route.fulfill({contentType:'text/html',body:html}));
 const page=await context.newPage();await page.goto(F.PROVIDER_PHOTO_URL);
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null});t.after(()=>monitor.detach());
 let fired=false;const batches=[];
 const wrapped=new Proxy(page,{get(target,prop){
  if(prop!=='evaluate')return bind(target,prop);
  return async(fn,arg)=>{
   const seen=await target.evaluate(fn,arg);
   if(!fired&&Array.isArray(arg)&&arg.includes('#error-no-content')&&await target.evaluate(()=>window.groupClicked)){
    fired=true;await target.evaluate(()=>fetch('/api/stories').then(r=>r.text()));
    const end=Date.now()+2000;while(monitor.inFlight()&&Date.now()<end)await pause(10);
    assert.equal(monitor.denial()?.status,403);
   }
   return seen;
  };
 }});
 const scan=await F.scanReadyProfilePage(wrapped,{handle:'example',categories:['highlights'],mediaTypes:['image'],maxPages:5,maxTimeMs:6000,
  continuationMonitor:monitor,onDiscoveryBatch:async batch=>batches.push({items:batch.items.map(x=>x.shortcode),denialAtCallback:monitor.denial()})});
 assert.equal(fired,true);
 assert.ok(scan.sections.some(s=>s.evidence?.blocked?.status===403),'the completed scan lost a real refusal');
 assert.equal(batches.filter(b=>b.denialAtCallback).length,0,'a discovery batch was exposed after a positively observed refusal');
});
test('contract FR3: a refusal latched inside the profile read travels out and stops the scan',async t=>{
 const browser=await launch(t),context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',route=>new URL(route.request().url()).pathname==='/api/posts'
  ?route.fulfill({status:403,contentType:'application/json',body:'{}'})
  :route.fulfill({contentType:'text/html',body:'<div id="profile-section"><span class="username-text">@example</span> 1 posts</div><div id="post-container"></div>'}));
 const page=await context.newPage();await page.goto(F.PROVIDER_PHOTO_URL);
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null});t.after(()=>monitor.detach());
 let fired=false;
 const wrapped=new Proxy(page,{get(target,prop){
  if(prop!=='evaluate')return bind(target,prop);
  return async(fn,arg)=>{
   const seen=await target.evaluate(fn,arg);
   if(!fired&&typeof fn==='function'&&String(fn).includes('username-text')){
    fired=true;await target.evaluate(()=>fetch('/api/posts').then(r=>r.text()));
    const end=Date.now()+2000;while(monitor.inFlight()&&Date.now()<end)await pause(10);
    assert.equal(monitor.denial()?.status,403);
   }
   return seen;
  };
 }});
 const ready=await F.waitForProfileReady(wrapped,'example',{started:Date.now(),maxTimeMs:4000,continuationMonitor:monitor});
 assert.equal(fired,true);
 // The profile really did render, so readiness stays truthful - but the refusal must not be
 // spent as a successful observation: it travels out with it and stops the scan cold.
 assert.equal(ready.ready,true);
 assert.equal(ready.blocked?.status,403,'a refusal latched inside the profile read was dropped');
 const batches=[];
 const scan=await F.scanReadyProfilePage(page,{handle:'example',categories:['posts','reels'],mediaTypes:['image'],maxPages:3,maxTimeMs:5000,
  continuationMonitor:monitor,onDiscoveryBatch:async batch=>batches.push(batch.items.length)});
 assert.deepEqual(batches,[],'no discovery batch may be exposed after a positively observed refusal');
 assert.ok(scan.sections.length>0);
 for(const section of scan.sections){
  assert.notEqual(section.status,'COMPLETE');
  assert.equal(section.evidence?.blocked?.status,403,'every section must carry the refusal as evidence');
  assert.deepEqual(section.items||[],[]);
 }
});
