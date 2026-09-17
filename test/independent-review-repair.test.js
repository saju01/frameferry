'use strict';
// Regressions for the independent review findings R1-R6. Every page here is a real
// Chromium DOM fulfilled in-process from synthetic HTML, or an explicit stub; no
// provider traffic, no private paths and no signed locators are involved.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),fsSync=require('node:fs'),os=require('node:os'),path=require('node:path');
const F=require('../src/index.js'),W=require('../src/sync-window.js'),{openBudget}=require('../src/request-budget.js'),{estimateDate}=require('../src/date-estimate.js');
const NUL='\u0000';

async function tmp(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-review-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const heldConfig=(root,handles)=>({handles:handles.map(handle=>({handle,dateAfter:'2026-01-01',accessRequired:'authenticated-view'})),runId:'review-proto',output:path.join(root,'out'),resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'ledger.json'),maxTimeMs:2000});
// syncWindow opens a context even when every handle is held; it must never open a page.
const stubChromium={chromium:{launch:async()=>({newContext:async()=>({newPage:async()=>{throw new Error('a held handle must not open a page');},close:async()=>{}}),close:async()=>{}})}};

// --- R1: prototype-key handles -------------------------------------------------
test('a literal __proto__ handle keeps an own result entry and cannot report COMPLETE',async t=>{
 const root=await tmp(t);
 const d=await W.syncWindow(heldConfig(root,['__proto__']),stubChromium);
 assert.notEqual(d.status,'COMPLETE',JSON.stringify(d));
 assert.ok(Object.hasOwn(d.handles,'__proto__'),'the requested handle lost its own result entry');
 assert.equal(d.handles['__proto__'].error.code,'ACCESS_REQUIRED');
 assert.equal(d.handles['__proto__'].status,'PARTIAL');
 const onDisk=JSON.parse(await fs.readFile(path.join(root,'result.json')));
 assert.ok(Object.hasOwn(onDisk.handles,'__proto__'),'the persisted result dropped the requested handle');
 assert.equal(onDisk.status,d.status);
});
test('prototype-named handles are each covered exactly once and never repaired away',async t=>{
 const root=await tmp(t),names=['__proto__','constructor','toString','valueOf'];
 const d=await W.syncWindow(heldConfig(root,names),stubChromium);
 assert.deepEqual(Object.keys(d.handles).sort(),[...names].sort());
 for(const name of names){
  assert.ok(Object.hasOwn(d.handles,name),name+' lost its own result entry');
  assert.equal(d.handles[name].error.code,'ACCESS_REQUIRED',name);
  assert.equal(d.handles[name].dateAfter,'2026-01-01',name);
 }
 assert.equal(d.status,'PARTIAL');
});
test('composition keeps a prototype-named handle as an own entry of the composed result',async t=>{
 const root=await tmp(t),output=path.join(root,'cache');await fs.mkdir(output);
 const at=new Date().toISOString(),spec={handle:'__proto__',dateAfter:'2026-01-01'};
 const observations=[{stableId:'posts__'+'a'.repeat(64),shortcode:'OLD',category:'posts',selected:false,date:estimateDate('1 January 2025',at,'UTC')}];
 const observed={status:'COMPLETE',scope:'current-visible-posts',dateAfter:spec.dateAfter,observedAt:at,observedCards:1,selectedCards:0,observations,files:[],coverage:W.witnessCoverage(spec,observations)};
 const handles={};Object.defineProperty(handles,'__proto__',{value:observed,writable:true,enumerable:true,configurable:true});
 const part={schemaVersion:1,kind:'frameferry-sync-window',runId:'source',scope:'current-visible-posts',fullHistoryComplete:false,output,status:'COMPLETE',requests:{denial:null},handles};
 const file=path.join(root,'part.json');await fs.writeFile(file,JSON.stringify(part));
 assert.ok(JSON.parse(await fs.readFile(file,'utf8')).handles['__proto__'],'fixture must really offer a __proto__ handle entry');
 const d=await W.combineWindowResults({handles:[spec],runId:'composed',output,resultFile:path.join(root,'composed.json'),requestLedger:path.join(root,'unused.json'),allowEstimatedDates:true},[file]);
 assert.ok(Object.hasOwn(d.handles,'__proto__'),'composition dropped the requested handle');
 assert.equal(d.handles['__proto__'].sourceRunId,'source');
 assert.ok(Object.hasOwn(JSON.parse(await fs.readFile(path.join(root,'composed.json'))).handles,'__proto__'));
});

// --- shared real-DOM fixture for R2/R3 ----------------------------------------
const CARD='<div class="post-card"><img class="post-image" data-type="image"><a class="content-download-btn" href="/media?id=POST"></a><span data-id="POST"></span><div class="post-footer"><span class="icon-group"><span>1 January 2026</span></span></div></div>';
async function windowFixture(t,{challenge=false,api=true}={}){
 const {chromium}=require('playwright');const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath();
 assert.ok(fsSync.existsSync(executablePath),'required real DOM browser must exist; no skips');
 const browser=await chromium.launch({headless:true,executablePath});t.after(()=>browser.close());
 const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
 const root=await tmp(t),ledger=path.join(root,'ledger.json'),budget=openBudget(ledger,'review-probe');t.after(()=>budget.close());
 let apiRequests=0;
 const script=api
  ?'function show(){var h=document.getElementById("search-input").value;'
   +'fetch("/api/profile",{method:"POST"}).then(function(r){return r.json();}).then(function(p){document.getElementById("profile-section").innerHTML=\'<span class="username-text">@\'+h+\'</span> \'+p.posts+\' posts\';});'
   +'fetch("/api/posts",{method:"POST"}).then(function(r){return r.json();}).then(function(d){document.getElementById("post-container").innerHTML=d.html;});}'
  :'function show(){var h=document.getElementById("search-input").value;'
   +'document.getElementById("profile-section").innerHTML=\'<span class="username-text">@\'+h+\'</span> 1 posts\';'
   +'document.getElementById("post-container").innerHTML='+JSON.stringify(CARD)+';}';
 const html='<input id="search-input"><button id="download-btn" onclick="show()">Search</button><div id="profile-section"></div>'
  +'<div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">Posts</button></div><div id="post-container"></div>'
  +(challenge?'<div id="challenge-form">verify</div>':'')+'<script>'+script+'</script>';
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/')){apiRequests++;return route.fulfill({status:200,contentType:'application/json',body:u.pathname==='/api/profile'?'{"posts":1}':JSON.stringify({html:CARD})});}
  return route.fulfill({status:200,contentType:'text/html',body:html});
 });
 return {root,ledger,page,budget,apiRequests:()=>apiRequests};
}

// --- R2: a visible DOM challenge must latch a durable denial --------------------
test('a visible provider challenge latches a denial that survives ledger reopen',async t=>{
 const f=await windowFixture(t,{challenge:true});
 await assert.rejects(W.discover(f.page,'example',f.budget,Date.now()+8000,10,1500));
 assert.ok(f.budget.data.denial,'a visible challenge must persist structured denial evidence');
 assert.equal(typeof f.budget.data.denial.id,'string');
 assert.equal(f.budget.data.denial.status,null,'no HTTP status may be invented for a DOM refusal');
 const serialized=JSON.stringify(f.budget.data.denial);
 assert.equal(serialized.includes('challenge-form'),false,'no raw DOM may be stored as denial evidence');
 assert.equal(serialized.includes('<'),false);
 await f.page.close();f.budget.close();
 const later=openBudget(f.ledger,'next-run');t.after(()=>later.close());
 assert.ok(later.data.denial,'the recorded denial must survive a new run ID');
 assert.throws(()=>later.reserve('discovery'),e=>e.code==='PROVIDER_DENIED');
 assert.throws(()=>later.assert(),e=>e.code==='PROVIDER_DENIED');
});
// An untouched budget proves nothing about classification: this control drives real
// discovery, spends real reservations, and only then asserts that an ordinary settled
// observation latched no refusal - here or for any later run on the same ledger.
test('an ordinary window observation is not a provider refusal',async t=>{
 const f=await windowFixture(t,{challenge:false});
 const value=await W.discover(f.page,'example',f.budget,Date.now()+20000,10,8000);
 assert.equal(value.raw.length,1);
 assert.ok(f.apiRequests()>=2,'the control must really exercise discovery API traffic');
 assert.ok(f.budget.data.requests>=3,'an untouched budget cannot validate classification');
 assert.equal(f.budget.data.denial,null,'an ordinary settled observation must latch no provider refusal');
 await f.page.close();f.budget.close();
 const later=openBudget(f.ledger,'next-run');t.after(()=>later.close());
 assert.equal(later.data.denial,null,'no refusal may survive an ordinary observation');
 later.reserve('discovery');
 assert.equal(later.data.requests,1,'a later run must still be admitted after an ordinary observation');
});

// --- R3: success needs positive settled profile/posts transport evidence --------
test('a stable card window with no API transport at all is refused',async t=>{
 const f=await windowFixture(t,{api:false});
 const outcome=await W.discover(f.page,'example',f.budget,Date.now()+9000,10,1500).then(value=>({accepted:true,cards:value.raw.length}),e=>({accepted:false,code:e.code,readiness:e.details?.readiness}));
 assert.equal(f.apiRequests(),0,'the fixture must really issue no API request');
 assert.equal(outcome.accepted,false,'stable DOM alone must not become a settled observation');
 assert.equal(outcome.code,'WINDOW_NOT_READY');
 assert.equal(outcome.readiness.transport.started,0);
 assert.equal(W.localWindowReadiness(outcome.readiness),false,'absent transport is not positive local evidence');
});
test('a window whose profile and posts responses settled is accepted',async t=>{
 const f=await windowFixture(t,{api:true});
 const value=await W.discover(f.page,'example',f.budget,Date.now()+20000,10,8000);
 assert.equal(value.raw.length,1);
 assert.ok(f.apiRequests()>=2);
});

// --- R4: the absolute deadline binds the reservation boundary ------------------
test('a lagging pacing timer cannot debit a reservation after the absolute deadline',async t=>{
 const root=await tmp(t),budget=openBudget(path.join(root,'ledger.json'),'timer-lag');t.after(()=>budget.close());
 let handler,allowed=0,aborted=0;
 const page={route:async(_,h)=>{handler=h;},on(){}};
 await W.installGuards(page,budget,Date.now()+650);
 const send=()=>handler({request:()=>({url:()=>F.PROVIDER_ORIGIN+'/api/posts',resourceType:()=>'fetch'}),fallback:async()=>{allowed++;},abort:async()=>{aborted++;}});
 await send();
 const queued=send();
 await new Promise(resolve=>setTimeout(()=>{const end=performance.now()+750;while(performance.now()<end);resolve();},100));
 await queued;
 assert.equal(budget.data.requests,1,'a request admitted after the deadline was debited to the ledger');
 assert.equal(allowed,1);
 assert.equal(aborted,1);
});
test('a recorded denial still outranks the deadline at the reservation boundary',async t=>{
 const root=await tmp(t),budget=openBudget(path.join(root,'ledger.json'),'denial-first');t.after(()=>budget.close());
 assert.throws(()=>budget.inspect(403,{},F.PROVIDER_ORIGIN+'/api/posts'),e=>e.code==='PROVIDER_DENIED');
 let handler,aborted=0;
 const page={route:async(_,h)=>{handler=h;},on(){}};
 await W.installGuards(page,budget,Date.now()-1);
 await handler({request:()=>({url:()=>F.PROVIDER_ORIGIN+'/api/posts',resourceType:()=>'fetch'}),fallback:async()=>{throw new Error('must not forward');},abort:async()=>{aborted++;}});
 assert.equal(aborted,1);
 assert.equal(budget.data.denial.kind,'DENIED_AUTH','a lapsed deadline must not replace the recorded denial');
});

// --- R5: cleanup must prove lock ownership -------------------------------------
test('an old ledger owner leaves a replacement owner lock in place and reports the loss',async t=>{
 const root=await tmp(t),file=path.join(root,'ledger.json'),lock=file+'.window-lock';
 const a=openBudget(file,'owner-a');
 await fs.unlink(lock);
 const b=openBudget(file,'owner-b');t.after(()=>b.close());
 const error=a.close();
 assert.equal(fsSync.existsSync(lock),true,'the replacement owner lock was unlinked by the previous owner');
 assert.ok(error,'losing the lock must be reported, not silently ignored');
 assert.equal(a.close(),error,'cleanup stays idempotent');
 assert.equal(JSON.parse(await fs.readFile(lock,'utf8')).runId,'owner-b');
});
test('a normal owner still releases its own lock exactly once',async t=>{
 const root=await tmp(t),file=path.join(root,'ledger.json'),lock=file+'.window-lock';
 const a=openBudget(file,'solo');
 assert.equal(fsSync.existsSync(lock),true);
 assert.equal(a.close(),null);
 assert.equal(fsSync.existsSync(lock),false);
 assert.equal(a.close(),null);
 const b=openBudget(file,'after');assert.equal(b.close(),null);
});
test('a failed owner record removes the lock it created instead of orphaning it',async t=>{
 const root=await tmp(t),file=path.join(root,'ledger.json'),lock=file+'.window-lock';
 const real=fsSync.writeSync;
 fsSync.writeSync=()=>{const e=new Error('simulated write failure');e.code='EIO';throw e;};
 try{assert.throws(()=>openBudget(file,'write-fails'),e=>e instanceof F.ArchiveError);}
 finally{fsSync.writeSync=real;}
 assert.equal(fsSync.existsSync(lock),false,'a lock created by a failed open was orphaned');
 const b=openBudget(file,'recovered');assert.equal(b.close(),null);
});

// --- R6: the readiness error seam must be one bounded observation ---------------
async function realPage(t){
 const {chromium}=require('playwright');const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath();
 assert.ok(fsSync.existsSync(executablePath),'required real DOM browser must exist; no skips');
 const browser=await chromium.launch({headless:true,executablePath});t.after(()=>browser.close());
 return browser.newPage();
}
// Deterministically reproduces the parent full-suite race: the error node is removed
// the instant the readiness seam first observes it, whichever page API it uses to
// look. A seam that reads visibility and text as two separate round trips blocks for
// the page default timeout and then reports the vanished node as terminal.
function racingPage(page,selector,onObserved){
 let armed=true;
 const trip=async(promise,relevant)=>{const value=await promise;if(relevant&&armed){armed=false;await onObserved();}return value;};
 const wrapLocator=(locator,relevant)=>new Proxy(locator,{get(target,prop){
  const value=target[prop];
  if(typeof value!=='function')return value;
  return (...args)=>{const out=value.apply(target,args);
   if(['first','nth','last','locator','filter'].includes(prop))return wrapLocator(out,relevant);
   return out&&typeof out.then==='function'?trip(out,relevant):out;};
 }});
 return new Proxy(page,{get(target,prop){
  if(prop==='locator')return sel=>wrapLocator(target.locator(sel),String(sel).includes(selector));
  if(prop==='evaluate')return (fn,arg)=>trip(target.evaluate(fn,arg),JSON.stringify(arg===undefined?null:arg).includes(selector));
  const value=target[prop];
  return typeof value==='function'?value.bind(target):value;
 }});
}
test('a section error read is one bounded observation, never a stale second read',async t=>{
 const page=await realPage(t);
 await page.setContent('<div id="error-no-content">no content</div><div id="post-container"></div>');
 page.setDefaultTimeout(5000);
 const wrapped=racingPage(page,'error-no-content',()=>page.evaluate(()=>document.getElementById('error-no-content').remove()));
 const started=Date.now();
 const observed=await F.extractSectionError(wrapped);
 const elapsed=Date.now()-started;
 assert.ok(elapsed<1500,'the readiness error read blocked for '+elapsed+'ms on a node that disappeared');
 assert.ok(observed===null||observed.reason==='no content','a vanished node produced invented error evidence: '+JSON.stringify(observed));
});
test('stale no-content while a response is pending is neither terminal nor a stall',async t=>{
 const page=await realPage(t);
 await page.setContent('<div id="error-no-content">no content</div><div id="post-container"></div>');
 page.setDefaultTimeout(5000);
 let pending=true;
 const wrapped=racingPage(page,'error-no-content',async()=>{
  await page.evaluate(html=>{document.getElementById('error-no-content').remove();document.getElementById('post-container').innerHTML=html;},
   '<article class="post-card"><span class="likes-trigger" data-id="A"></span><a class="content-download-btn" href="https://instacognito.com/media?id=m">d</a></article>');
  pending=false;
 });
 const monitor={inFlight:()=>pending?1:0,denial:()=>null,snapshot:()=>({inFlight:pending?1:0})};
 const started=Date.now();
 const r=await F.waitForSectionReady(wrapped,'posts',started,1500,monitor);
 const elapsed=Date.now()-started;
 assert.equal(r.kind,'cards',JSON.stringify(r));
 assert.ok(elapsed<3000,'readiness overran its 1500ms budget by blocking on a vanished error node ('+elapsed+'ms)');
});

// --- schema gaps the review asked to close -------------------------------------
test('malformed handle, policy and path types fail typed before any side effect',async t=>{
 const root=await tmp(t);let launches=0;
 const deps={chromium:{launch:async()=>{launches++;throw new Error('must not launch');}}};
 const base=()=>({handles:[{handle:'example',dateAfter:'2020-01-01'}],runId:'schema',output:path.join(root,'out'),resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'ledger.json')});
 const cases=[
  ['non-string handle',{handles:[{handle:123,dateAfter:'2020-01-01'}]}],
  ['object handle',{handles:[{handle:{},dateAfter:'2020-01-01'}]}],
  ['null handle',{handles:[{handle:null,dateAfter:'2020-01-01'}]}],
  ['numeric browserExecutable',{browserExecutable:7}],
  ['empty browserExecutable',{browserExecutable:''}],
  ['NUL browserExecutable',{browserExecutable:'/usr/bin/chromium'+NUL+'x'}],
  ['string allowEstimatedDates',{allowEstimatedDates:'yes'}],
  ['numeric allowEstimatedDates',{allowEstimatedDates:1}],
  ['NUL output',{output:path.join(root,'out')+NUL}],
  ['NUL resultFile',{resultFile:path.join(root,'result.json')+NUL}],
  ['NUL requestLedger',{requestLedger:path.join(root,'ledger.json')+NUL}]
 ];
 for(const [label,patch] of cases){
  await assert.rejects(W.syncWindow({...base(),...patch},deps),e=>{
   assert.ok(e instanceof F.ArchiveError,label+' threw an untyped '+e.name+': '+e.message);
   assert.ok(['BAD_ARGS','BAD_HANDLE'].includes(e.code),label+' reported '+e.code);
   return true;
  },label);
 }
 assert.equal(launches,0);
 assert.equal(fsSync.existsSync(path.join(root,'ledger.json')),false,'no ledger may be created for a rejected configuration');
});
// A file-entry case only proves the file guard if the observation it carries is
// genuinely selected under the job's date policy. Flipping `selected` on an
// out-of-window card fails DATE_POLICY first and never reaches the guard at all, so the
// selected cases below use a card the cutoff really admits and demand BAD_RESULT.
test('null observation and file entries are typed result failures, not TypeErrors',async()=>{
 const at=new Date().toISOString(),spec={handle:'example',dateAfter:'2026-01-01'};
 const id='posts__'+'a'.repeat(64);
 const observation={stableId:id,shortcode:'OLD',category:'posts',selected:false,date:estimateDate('1 January 2025',at,'UTC')};
 const good={status:'COMPLETE',scope:'current-visible-posts',dateAfter:spec.dateAfter,observedAt:at,observedCards:1,selectedCards:0,observations:[observation],files:[],coverage:W.witnessCoverage(spec,[observation])};
 assert.equal(W.validateWitnessWindow(spec,good,{allowEstimatedDates:true}).satisfied,true);
 const inWindow={stableId:id,shortcode:'NEW',category:'posts',selected:true,date:estimateDate('1 January 2026',at,'UTC')};
 assert.equal(inWindow.date.dayHi>=spec.dateAfter,true,'the file-entry fixture must really be selected by the cutoff');
 const file={stableId:id,shortcode:inWindow.shortcode,profileHandle:spec.handle,date:inWindow.date};
 const selectedGood={...good,observations:[inWindow],selectedCards:1,files:[file],coverage:W.witnessCoverage(spec,[inWindow])};
 assert.equal(W.validateWitnessWindow(spec,selectedGood,{allowEstimatedDates:true}).satisfied,true,'the selected baseline must pass date policy and reach the file guard');
 for(const [label,patch,code] of [
  ['null observation',{observations:[null]},'BAD_RESULT'],
  ['array observation',{observations:[[]]},'BAD_RESULT'],
  ['string observation',{observations:['posts']},'BAD_RESULT'],
  ['null file',{observations:[inWindow],selectedCards:1,files:[null],coverage:selectedGood.coverage},'BAD_RESULT'],
  ['array file',{observations:[inWindow],selectedCards:1,files:[[]],coverage:selectedGood.coverage},'BAD_RESULT']
 ]){
  const h={...good,...patch};
  assert.throws(()=>W.validateWitnessWindow(spec,h,{allowEstimatedDates:true}),e=>{
   assert.ok(e instanceof F.ArchiveError,label+' threw an untyped '+e.name+': '+e.message);
   assert.equal(e.code,code,label+' reported '+e.code+' instead of '+code);
   return true;
  },label);
 }
});
