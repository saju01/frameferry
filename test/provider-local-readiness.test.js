'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const F=require('../src/index.js'),W=require('../src/sync-window.js');
const {rec,posts,document_,RENDERER}=require('./fixtures/listing-page.js');
const {openBudget}=require('../src/request-budget.js');
test('inactive refusal history is visible separately, permits a new healthy result, and never rehabilitates old denied parts',async t=>{
 const f=await fixture(t,'healthy'),old=openBudget(f.config.requestLedger,'previous-owner-attempt');
 old.deny('DENIED_AUTH',{status:403});const refusal=structuredClone(old.data.denial);old.close();
 const result=await W.syncWindow(f.config,f.deps);
 assert.equal(result.status,'COMPLETE');assert.equal(result.requests.denial,null);
 assert.equal(result.requests.activeRestriction,null);assert.equal(result.requests.denialHistory[0].denial_id,refusal.id);
 assert.equal(result.requests.denialHistory[0].disposition,'attempt-only');
 const oldPart={...result,runId:'previous-owner-attempt',status:'BLOCKED',requests:{...result.requests,denial:refusal}};
 const file=f.config.resultFile+'.old-blocked';await fs.writeFile(file,JSON.stringify(oldPart));const bytes=await fs.readFile(file);
 await assert.rejects(W.combineWindowResults({...f.config,runId:'composed',resultFile:f.config.resultFile+'.compose'},[file]),{code:'BAD_RESULT'});
 assert.deepEqual(await fs.readFile(file),bytes);
});
async function fixture(t,mode){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-local-policy-')),browser=await require('playwright').chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium'});
 t.after(async()=>{await browser.close();await fs.rm(root,{recursive:true,force:true});});
 const calls=[],downloads=[];let middlePage;
 const script=RENDERER+';function show(){var h=document.getElementById("search-input").value;'
  +(mode==='notfound-unattributed'?'if(h==="middle"){document.getElementById("profile-section").innerHTML=\'<span class="username-text">@middle</span> 1 posts\';document.getElementById("post-container").innerHTML=\'<div id="error-not-found">Not found</div>\';return;}':'')
  +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){document.getElementById("profile-section").innerHTML=\'<span class="username-text">@\'+h+\'</span> 1 posts\';});'
  +'fetch("/api/posts").then(function(r){return r.json();}).then(function(d){ffPaint(d);'
  +(mode==='notfound'?'if(h==="middle")document.getElementById("post-container").innerHTML=\'<div id="error-not-found">Not found</div>\';':'')
  +(mode==='challenge'?'if(h==="middle")document.getElementById("post-container").innerHTML+=\'<div id="challenge-form">verify</div>\';':'')
  +(mode==='mismatch'?'if(h==="middle")document.querySelector(".username-text").textContent="@other";':'')
  +'});}';
 const bound=(o,k)=>typeof o[k]==='function'?o[k].bind(o):o[k];
 const wrapper={newContext:async options=>{
  const context=await browser.newContext(options);
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url()),request=route.request();
   let h='';if(u.pathname!=='/en/photo')h=await request.frame().evaluate(()=>document.querySelector('#search-input')?.value||'');
   calls.push({handle:h,path:u.pathname});
   if(u.pathname==='/media'){downloads.push(h);return route.fulfill({status:200,contentType:'image/jpeg',body:Buffer.from([255,216,255,224,1,2,3,4,255,217])});}
   if(u.pathname.startsWith('/api/')){
    const payload=posts(rec({code:'POST',media:'MEDIA'}));
    if(h==='middle'&&['unsupported','mismatch','missing-body','overflow','wrong-generation','late-challenge','close-failure'].includes(mode))payload.p[0].extra='synthetic unknown field';
    if(h==='middle'&&mode==='notfound')payload.p=[];
    if(h==='middle'&&u.pathname==='/api/posts'&&['401','429','503'].includes(mode))return route.fulfill({status:Number(mode),headers:{'retry-after':'60'},contentType:'application/json',body:'{}'});
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(u.pathname==='/api/posts'?payload:{})});
   }
   return route.fulfill({status:200,contentType:'text/html',body:document_(script)});
  });
  return new Proxy(context,{get(c,k){if(k!=='newPage')return bound(c,k);return async()=>{
   const p=await c.newPage();return new Proxy(p,{get(page,key){
    if(key==='evaluate')return async(fn,arg)=>{const seen=await page.evaluate(fn,arg);if(arg?.bodies&&seen?.matched){const h=await page.inputValue('#search-input');if(h==='middle'){middlePage=page;if(mode==='missing-body')seen.bodies.bodies=[];if(mode==='overflow')seen.bodies.overflow='synthetic';if(mode==='wrong-generation')seen.bodies.generation++;}}return seen;};
    if(key==='close')return async()=>{if(page===middlePage&&mode==='close-failure')throw new Error('synthetic close failure');if(page===middlePage&&mode==='late-challenge'){await page.evaluate(()=>{const e=document.createElement('div');e.id='challenge-form';e.textContent='verify';document.body.append(e);});await new Promise(r=>setTimeout(r,100));}return page.close();};
    return bound(page,key);
   }});
  };}});
 },close:async()=>{}};
 const config={handles:['alpha','middle','zulu'].map(handle=>({handle,dateAfter:'2020-01-01'})),runId:'local-policy',output:path.join(root,'out'),resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'ledger.json'),maxTimeMs:12000};
 return {config,calls,downloads,deps:{chromium:{launch:async()=>wrapper},readinessWaitMs:1700,dnsLookup:async()=>[{address:'93.184.216.34',family:4}]}};
}
for(const mode of ['notfound','unsupported'])test('attributed '+mode+' middle is local PARTIAL and healthy zulu still acquires',async t=>{
 const f=await fixture(t,mode),result=await W.syncWindow(f.config,f.deps);
 assert.equal(result.status,'PARTIAL');assert.equal(result.stoppedGlobally,false,JSON.stringify(result.handles.middle));
 assert.equal(result.handles.alpha.status,'COMPLETE');assert.equal(result.handles.zulu.status,'COMPLETE');
 assert.equal(result.handles.middle.error.code,mode==='notfound'?'HANDLE_UNAVAILABLE':'UNSUPPORTED_LISTING_FORMAT');
 assert.equal(result.handles.middle.error.scope,'handle');assert.deepEqual(result.handles.middle.files,[]);assert.equal(result.handles.middle.observedAt,undefined);
 assert.deepEqual(f.downloads,['alpha','zulu']);assert.equal(result.requests.denial,null);
 assert.deepEqual(JSON.parse(await fs.readFile(f.config.resultFile,'utf8')),result);
});
for(const mode of ['401','429','503','challenge','missing-body','overflow','wrong-generation','mismatch','notfound-unattributed','close-failure','late-challenge'])test('non-isolatable '+mode+' stops the following handle',async t=>{
 const f=await fixture(t,mode),result=await W.syncWindow(f.config,f.deps);
 assert.equal(result.stoppedGlobally,true);assert.equal(result.handles.middle.error.scope,'global');assert.equal(result.handles.zulu.status,'NOT_COMPLETED');
 assert.deepEqual(f.downloads,['alpha']);assert.notEqual(result.status,'COMPLETE');
 if(['401','429','503','challenge','late-challenge'].includes(mode)){assert.equal(result.status,'BLOCKED');assert.ok(result.requests.denial);}
});
