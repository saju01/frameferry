'use strict';
// Permanent regressions for the independent re-review findings RR1-RR5. Every page here
// is a real Chromium DOM fulfilled in-process from synthetic HTML, or an explicit stub;
// no provider traffic, no private paths, no signed locators and no import-data hacks.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),fsSync=require('node:fs'),os=require('node:os'),path=require('node:path');
const F=require('../src/index.js'),W=require('../src/sync-window.js'),{openBudget}=require('../src/request-budget.js');

async function tmp(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-rereview-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function launch(t){
 const {chromium}=require('playwright');
 const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath();
 assert.ok(fsSync.existsSync(executablePath),'required real DOM browser must exist; no skips');
 const browser=await chromium.launch({headless:true,executablePath});t.after(()=>browser.close());return browser;
}
const settle=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(condition,label,timeoutMs=8000){
 const end=Date.now()+timeoutMs;
 while(Date.now()<end){if(condition())return true;await settle(20);}
 assert.fail(label+' did not happen within '+timeoutMs+'ms');
}
const card=id=>'<div class="post-card"><img class="post-image" data-type="image">'
 +'<a class="content-download-btn" href="/media?id='+id+'"></a><span data-id="'+id+'"></span>'
 +'<div class="post-footer"><span class="icon-group"><span>1 January 2026</span></span></div></div>';
const PROFILE='document.getElementById("profile-section").innerHTML='
 +'\'<span class="username-text">@example</span> 1 posts\';';

// One synthetic provider page per mode. `api` records every /api/* request the browser
// really issued and whether it came from the intended main frame, so an "attribution"
// assertion can never pass by accident on a fixture that issued nothing at all.
async function windowFixture(t,mode){
 const browser=await launch(t);
 const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
 const root=await tmp(t),ledger=path.join(root,'ledger.json'),budget=openBudget(ledger,'rereview');
 t.after(()=>budget.close());
 const api=[];let heldPosts=null;
 const section=id=>'document.getElementById("post-container").innerHTML=\'<div id="'+id+'">unavailable</div>\';';
 const afterApis=body=>'function show(){Promise.all([fetch("/api/profile"),fetch("/api/posts")]).then(function(){'+PROFILE+body+'});}';
 // The real provider renders its profile and its listing from the responses to
 // browser-issued /api/profile and /api/posts, so every fixture below does too.
 const apiDriven=prelude=>'function show(){'+prelude
  +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
  +'fetch("/api/posts").then(function(r){return r.json();}).then(function(d){document.getElementById("post-container").innerHTML=d.html;});}';
 const script=mode==='subframe'?'function show(){'+PROFILE+'document.getElementById("post-container").innerHTML='+JSON.stringify(card('OLD'))+';}'
  :mode==='notfound'?afterApis(section('error-not-found'))
  :mode==='private'?afterApis(section('error-private'))
  :mode==='nocontent'?afterApis(section('error-no-content'))
  :mode==='settlement-race'?apiDriven('document.getElementById("post-container").innerHTML='+JSON.stringify(card('OLD'))+';')
  :apiDriven('');
 const html='<input id="search-input"><button id="download-btn" onclick="show()">Search</button>'
  +'<div id="profile-section"></div><div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">Posts</button></div>'
  +'<div id="post-container"></div>'+(mode==='subframe'?'<iframe src="/child"></iframe>':'')
  +'<script>'+script+'</script>';
 await context.route('**/*',async route=>{
  const request=route.request(),u=new URL(request.url());
  if(u.pathname.startsWith('/api/')){
   let main=false;try{main=request.frame()===page.mainFrame();}catch{main=false;}
   api.push({path:u.pathname,main});
   if(mode==='http-denied'&&u.pathname==='/api/profile')return route.fulfill({status:403,contentType:'application/json',body:'{}'});
   if(mode==='settlement-race'&&u.pathname==='/api/posts'&&!heldPosts){heldPosts=route;return;}
   return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({posts:1,html:card('NEW')})});
  }
  if(u.pathname==='/child')return route.fulfill({status:200,contentType:'text/html',body:'<script>fetch("/api/profile");fetch("/api/posts");</script>'});
  return route.fulfill({status:200,contentType:'text/html',body:html});
 });
 return {page,budget,ledger,api,
  postsHeld:()=>!!heldPosts,
  releasePosts:async()=>{
   assert.ok(heldPosts,'the fixture must really be holding the posts response');
   const held=heldPosts;heldPosts=null;
   await held.fulfill({status:200,contentType:'application/json',body:JSON.stringify({html:card('NEW')})});
   await page.waitForFunction(()=>document.querySelector('#post-container [data-id]')?.getAttribute('data-id')==='NEW');
  }};
}
const outcome=promise=>promise.then(value=>({accepted:true,cards:value.raw.map(x=>x.shortcode)}),
 e=>({accepted:false,code:e.code,readiness:e.details?.readiness}));

// --- RR1: ordinary absence is not a positively observed provider refusal ----------
test('rereview RR1: ordinary profile-not-found is unavailability, never a durable provider-wide denial',async t=>{
 const f=await windowFixture(t,'notfound');
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+8000,10,1500));
 assert.equal(result.accepted,false,'an absent profile must never be a settled window');
 assert.equal(f.budget.data.denial,null,'ordinary handle absence must not be persisted as a provider refusal');
 await f.page.close();f.budget.close();
 const next=openBudget(f.ledger,'next-run');t.after(()=>next.close());
 assert.equal(next.data.denial,null,'ordinary handle absence poisoned the shared provider ledger');
 next.reserve('discovery');
 assert.equal(next.data.requests,1,'a later run must still be admitted after an absent handle');
});
test('rereview RR1: a visible private access wall still latches a durable provider denial',async t=>{
 const f=await windowFixture(t,'private');
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+8000,10,1500));
 assert.equal(result.accepted,false);
 assert.equal(result.code,'PROVIDER_DENIED');
 assert.equal(f.budget.data.denial.kind,'DENIED_ACCESS_DOM');
 assert.equal(f.budget.data.denial.status,null,'no HTTP status may be invented for a DOM refusal');
 assert.equal(JSON.stringify(f.budget.data.denial).includes('<'),false,'no raw DOM may be stored as denial evidence');
 await f.page.close();f.budget.close();
 const next=openBudget(f.ledger,'next-run');t.after(()=>next.close());
 assert.ok(next.data.denial,'a positively observed access wall must survive a new run ID');
 assert.throws(()=>next.reserve('discovery'),e=>e.code==='PROVIDER_DENIED');
});
test('rereview RR1: an inconclusive no-content window is neither success nor a refusal',async t=>{
 const f=await windowFixture(t,'nocontent');
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+9000,10,1500));
 assert.equal(result.accepted,false,'an inconclusive section must never be a settled window');
 assert.equal(result.code,'WINDOW_NOT_READY');
 assert.equal(result.readiness.sectionError,'error-no-content');
 assert.equal(W.localWindowReadiness(result.readiness),false,'an inconclusive section is not positive local evidence');
 assert.equal(f.budget.data.denial,null,'an inconclusive section must not latch a provider refusal');
 await f.page.close();f.budget.close();
 const next=openBudget(f.ledger,'next-run');t.after(()=>next.close());
 assert.equal(next.data.denial,null);
});
test('rereview RR1: a genuine HTTP refusal during discovery still latches a durable denial',async t=>{
 const f=await windowFixture(t,'http-denied');
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+8000,10,1500));
 assert.equal(result.accepted,false);
 assert.equal(f.budget.data.denial.kind,'DENIED_AUTH');
 assert.equal(f.budget.data.denial.status,403);
 await f.page.close();f.budget.close();
 const next=openBudget(f.ledger,'next-run');t.after(()=>next.close());
 assert.throws(()=>next.reserve('discovery'),e=>e.code==='PROVIDER_DENIED');
});

// --- RR2: positive readiness is attributed to the intended main frame/generation ---
test('rereview RR2: child-frame provider traffic cannot certify the main-page window',async t=>{
 const f=await windowFixture(t,'subframe');
 const result=await outcome(W.discover(f.page,'example',f.budget,Date.now()+12000,10,4000));
 const child=f.api.filter(x=>!x.main).map(x=>x.path);
 assert.ok(child.includes('/api/profile')&&child.includes('/api/posts'),'the fixture must really settle child-frame profile/posts traffic');
 assert.equal(f.api.some(x=>x.main),false,'the main frame must really issue no API request in this fixture');
 assert.equal(result.accepted,false,'only unrelated child-frame APIs settled');
 assert.equal(result.code,'WINDOW_NOT_READY');
 assert.ok(result.readiness.transport.started>=2,'global request accounting must stay conservative over all traffic');
 assert.equal(W.localWindowReadiness(result.readiness),false,'unattributed transport is not positive local evidence');
});
test('rereview RR2: a healthy intended-frame window is still accepted',async t=>{
 const f=await windowFixture(t,'healthy');
 const value=await W.discover(f.page,'example',f.budget,Date.now()+25000,10,9000);
 assert.deepEqual(value.raw.map(x=>x.shortcode),['NEW']);
 assert.equal(f.api.every(x=>x.main),true,'the healthy fixture must issue its API traffic from the main frame');
 assert.ok(f.api.filter(x=>x.path==='/api/profile').length>=1&&f.api.filter(x=>x.path==='/api/posts').length>=1);
});
test('rereview RR2: the monitor separates conservative accounting from positive attribution',async t=>{
 const browser=await launch(t);
 const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  if(u.pathname==='/child')return route.fulfill({status:200,contentType:'text/html',body:'<script>fetch("/api/profile");fetch("/api/posts");</script>'});
  return route.fulfill({status:200,contentType:'text/html',body:'<iframe src="/child"></iframe>'});
 });
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null});t.after(()=>monitor.detach());
 await page.goto(F.PROVIDER_PHOTO_URL,{waitUntil:'load'});
 await waitFor(()=>monitor.snapshot().settled>=2,'child-frame provider traffic settling');
 assert.ok(monitor.snapshot().started>=2,'global accounting must keep counting child-frame traffic');
 assert.equal(monitor.attributed().started,0,'child-frame traffic must never be attributed to the main page');
 assert.deepEqual(monitor.attributed().paths,{});
 const beforeGeneration=monitor.generation();
 await page.evaluate(()=>Promise.all([fetch('/api/profile'),fetch('/api/posts')]));
 await waitFor(()=>monitor.attributed().settled>=2,'main-frame provider traffic settling');
 const attributed=monitor.attributed();
 assert.equal(attributed.started,2);assert.equal(attributed.inFlight,0);
 assert.deepEqual(attributed.paths,{'/api/profile':1,'/api/posts':1});
 assert.equal(attributed.generation,beforeGeneration,'no navigation or search happened');
 const after=monitor.beginGeneration();
 assert.ok(after>beforeGeneration,'a new search must start a new attribution generation');
 assert.equal(monitor.attributed().started,0,'a superseded generation cannot certify the new one');
 assert.deepEqual(monitor.attributed().paths,{});
 assert.ok(monitor.snapshot().started>=4,'global accounting must survive the generation change');
});
test('rereview RR2: a main-frame navigation retires the previous attribution generation',async t=>{
 const browser=await launch(t);
 const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  return route.fulfill({status:200,contentType:'text/html',body:'<div id="post-container"></div>'});
 });
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null});t.after(()=>monitor.detach());
 await page.goto(F.PROVIDER_PHOTO_URL,{waitUntil:'domcontentloaded'});
 await page.evaluate(()=>Promise.all([fetch('/api/profile'),fetch('/api/posts')]));
 await waitFor(()=>monitor.attributed().settled>=2,'main-frame provider traffic settling');
 const generation=monitor.generation();
 await page.goto(F.PROVIDER_PHOTO_URL+'?again=1',{waitUntil:'domcontentloaded'});
 await waitFor(()=>monitor.generation()>generation,'a main-frame navigation bumping the generation');
 assert.equal(monitor.attributed().started,0,'old-document traffic cannot certify the new document');
 assert.ok(monitor.snapshot().started>=2,'global accounting must survive the navigation');
});

// --- RR3: a sample is only evidence if the transport epoch held across the read ----
test('rereview RR3: a response settling after the last raw read cannot certify pre-response cards',async t=>{
 const f=await windowFixture(t,'settlement-race');
 let heldReads=0;
 // The proxy lets the discover loop accumulate stability on the OLD listing while
 // /api/posts is still pending, then lets one more raw-card read complete on OLD and
 // only THEN settles /api/posts and waits for NEW to render, before that earlier raw
 // array is handed back.
 const page=new Proxy(f.page,{get(target,prop){
  if(prop!=='locator'){const value=target[prop];return typeof value==='function'?value.bind(target):value;}
  return (selector,...rest)=>{
   const locator=target.locator(selector,...rest);
   if(selector!=='#post-container .post-card')return locator;
   return new Proxy(locator,{get(l,key){
    if(key!=='evaluateAll'){const value=l[key];return typeof value==='function'?value.bind(l):value;}
    return async(...args)=>{const raw=await l.evaluateAll(...args);if(f.postsHeld()&&++heldReads===2)await f.releasePosts();return raw;};
   }});
  };
 }});
 const result=await outcome(W.discover(page,'example',f.budget,Date.now()+20000,10,8000));
 const live=await F.readRawCardsFromPage(f.page);
 assert.ok(heldReads>=2,'the fixture must really have read the raw cards more than once while the posts response was pending');
 assert.deepEqual(live.map(x=>x.shortcode),['NEW'],'the fixture must really have replaced the listing');
 if(result.accepted)assert.deepEqual(result.cards,['NEW'],'cards accepted were never observed after the posts response settled');
 else assert.equal(result.code,'WINDOW_NOT_READY');
});

// --- RR4: absence of lock identity is never ownership ------------------------------
test('rereview RR4: a failed lock fstat must not delete a replacement owner',async t=>{
 const root=await tmp(t),file=path.join(root,'ledger.json'),lock=file+'.window-lock',real=fsSync.fstatSync;
 let caught=null;
 fsSync.fstatSync=()=>{
  fsSync.unlinkSync(lock);fsSync.writeFileSync(lock,JSON.stringify({runId:'replacement'}));
  const e=new Error('simulated fstat failure');e.code='EIO';throw e;
 };
 try{assert.throws(()=>openBudget(file,'failed'),e=>{caught=e;return e.code==='BAD_BUDGET';});}
 finally{fsSync.fstatSync=real;}
 assert.equal(fsSync.existsSync(lock),true,'unknown lock identity authorized replacement deletion');
 assert.equal(JSON.parse(fsSync.readFileSync(lock,'utf8')).runId,'replacement');
 assert.equal(caught.details.cleanup,'unknown-identity-left-in-place');
 assert.equal(JSON.stringify(caught.details).includes(root),false,'cleanup evidence must carry no path');
});
test('rereview RR4: an unprovable own lock is preserved and reported, never blindly unlinked',async t=>{
 const root=await tmp(t),file=path.join(root,'ledger.json'),lock=file+'.window-lock',real=fsSync.fstatSync;
 let caught=null;
 fsSync.fstatSync=()=>{const e=new Error('simulated fstat failure');e.code='EIO';throw e;};
 try{assert.throws(()=>openBudget(file,'unprovable'),e=>{caught=e;return e.code==='BAD_BUDGET';});}
 finally{fsSync.fstatSync=real;}
 assert.equal(fsSync.existsSync(lock),true,'an ambiguous lock must be left exactly where it is');
 assert.equal(caught.details.cleanup,'unknown-identity-left-in-place');
 assert.match(caught.message,/EIO/);
});

// --- RR5: ordinary terminal errors need a quiet epoch on BOTH sides of the read ----
function armedErrorRead(page,onObserved){
 let armed=true;
 return new Proxy(page,{get(target,prop){
  if(prop==='evaluate')return async(fn,arg)=>{
   if(armed&&Array.isArray(arg)&&arg.includes('#error-no-content')){armed=false;await onObserved();}
   return target.evaluate(fn,arg);
  };
  const value=target[prop];return typeof value==='function'?value.bind(target):value;
 }});
}
async function errorPage(t,body){
 const browser=await launch(t);const page=await browser.newPage();
 await page.setContent(body);page.setDefaultTimeout(5000);return page;
}
test('rereview RR5: a response that starts during the atomic error read is not terminal',async t=>{
 const page=await errorPage(t,'<div id="error-no-content">stale</div><div id="post-container"></div>');
 let pending=false;
 const wrapped=armedErrorRead(page,async()=>{
  pending=true;
  setTimeout(()=>{page.evaluate(html=>{document.getElementById('error-no-content')?.remove();document.getElementById('post-container').innerHTML=html;},card('NEW'))
   .then(()=>{pending=false;},()=>{pending=false;});},100);
 });
 const monitor={inFlight:()=>pending?1:0,denial:()=>null,snapshot:()=>({started:1,settled:pending?0:1,failed:0,inFlight:pending?1:0})};
 const r=await F.waitForSectionReady(wrapped,'posts',Date.now(),3000,monitor);
 assert.equal(r.kind,'cards','a stale pre-response error became terminal despite a live pending response: '+JSON.stringify(r));
});
test('rereview RR5: a request that starts and finishes inside the atomic error read is not terminal',async t=>{
 const browser=await launch(t);
 const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',body:'{}'});
  return route.fulfill({status:200,contentType:'text/html',body:'<div id="error-no-content">stale</div><div id="post-container"></div>'});
 });
 await page.goto(F.PROVIDER_PHOTO_URL,{waitUntil:'domcontentloaded'});
 page.setDefaultTimeout(5000);
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null});t.after(()=>monitor.detach());
 const wrapped=armedErrorRead(page,async()=>{
  await page.evaluate(()=>fetch('/api/posts').then(r=>r.text()));
  await waitFor(()=>monitor.snapshot().settled>=1&&monitor.snapshot().inFlight===0,'the injected response settling');
  setTimeout(()=>{page.evaluate(html=>{document.getElementById('error-no-content')?.remove();document.getElementById('post-container').innerHTML=html;},card('NEW')).catch(()=>{});},80);
 });
 const r=await F.waitForSectionReady(wrapped,'posts',Date.now(),4000,monitor);
 assert.ok(monitor.snapshot().started>=1&&monitor.snapshot().settled>=1,'the fixture must really start and finish a request inside the read');
 assert.equal(r.kind,'cards','an entire start-and-finish inside the read was invisible to the terminal-error gate: '+JSON.stringify(r));
});
test('rereview RR5: a response settling during the atomic error read still resolves to cards',async t=>{
 const page=await errorPage(t,'<div id="error-no-content">stale</div><div id="post-container"></div>');
 let pending=true;
 const wrapped=armedErrorRead(page,async()=>{
  await page.evaluate(html=>{document.getElementById('error-no-content')?.remove();document.getElementById('post-container').innerHTML=html;},card('NEW'));
  pending=false;
 });
 const monitor={inFlight:()=>pending?1:0,denial:()=>null,snapshot:()=>({started:1,settled:pending?0:1,failed:0,inFlight:pending?1:0})};
 const r=await F.waitForSectionReady(wrapped,'posts',Date.now(),3000,monitor);
 assert.equal(r.kind,'cards',JSON.stringify(r));
});
test('rereview RR5: a stable ordinary unavailable window with quiet transport stays terminal',async t=>{
 const browser=await launch(t);const page=await browser.newPage();
 await page.setContent('<div id="error-no-content">no content</div><div id="post-container"></div>');
 page.setDefaultTimeout(5000);
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null});t.after(()=>monitor.detach());
 const started=Date.now();
 const r=await F.waitForSectionReady(page,'posts',started,3000,monitor);
 assert.equal(r.kind,'error',JSON.stringify(r));
 assert.equal(r.status,'UNAVAILABLE');
 assert.ok(Date.now()-started<2500,'a quiet ordinary unavailable window must not be waited out');
});
test('rereview RR5: a genuine access wall is terminal even while a response is pending',async t=>{
 const browser=await launch(t);const page=await browser.newPage();
 await page.setContent('<div id="error-private">private</div><div id="post-container"></div>');
 page.setDefaultTimeout(5000);
 const monitor={inFlight:()=>1,denial:()=>null,snapshot:()=>({started:1,settled:0,failed:0,inFlight:1})};
 const started=Date.now();
 const r=await F.waitForSectionReady(page,'posts',started,3000,monitor);
 assert.equal(r.kind,'error',JSON.stringify(r));
 assert.equal(r.status,'BLOCKED');
 assert.ok(Date.now()-started<2500,'a positively observed access wall must not be waited out');
});
