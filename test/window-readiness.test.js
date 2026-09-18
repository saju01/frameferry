'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const W=require('../src/sync-window.js');
// The listing responses this fixture serves use the REAL observed representation, so a healthy
// handle completes on the same evidence production requires rather than on an inert body.
const {rec,posts}=require('./fixtures/listing-page.js');
// What the page below actually paints for a handle in a given mode, expressed as the provider's
// own p/pc listing: the base card, the unparseable-date variant, or nothing at all.
const MIDDLE_PAINTS_NOTHING=['empty','no-api','403','429','503','challenge','closed','deadline',
 'in-flight','transport-failed','category','profile-drift','section-error'];
function listingFor(handle,mode){
 if(handle==='middle'&&MIDDLE_PAINTS_NOTHING.includes(mode))return {p:[],pc:''};
 return posts(rec({code:'POST',media:'POST',date:handle==='middle'&&mode==='bad-date'?'gibberish date':'1 January 2026'}));
}
const jpg=Buffer.from([255,216,255,224,1,2,3,4,255,217]);
async function fixture(t,mode){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-ready-'));
 const browser=await require('playwright').chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium'});
 t.after(async()=>{await browser.close();await fs.rm(root,{recursive:true,force:true});});
 const calls=[];let downloads=0;
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async()=>{downloads++;return new Response(jpg,{headers:{'content-type':'image/jpeg'}});};
 const html=
 '<input id="search-input"><button id="download-btn" onclick="show()">Search</button><div id="profile-section"></div><div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">Posts</button></div><div id="post-container"></div><div class="g-recaptcha" style="display:none"></div><script>'+
 'const mode='+JSON.stringify(mode)+';'+
 functionBody()+ '</script>';
 function functionBody(){return `function card(id='POST',date='1 January 2026'){return '<div class="post-card"><img class="post-image" data-type="image"><a class="content-download-btn" href="/media?id='+id+'&signature=PRIVATE"></a><span data-id="POST"></span><div class="post-content"><p>PRIVATE-CAPTION</p></div><span class="likes-trigger" data-id="POST"><span>1</span></span><span class="comments-trigger" data-id="POST"><span>1</span></span><div class="post-footer"><span class="icon-group"><span>'+date+'</span></span></div></div>';}
function show(){
 const handle=document.querySelector('#search-input').value,middle=handle==='middle';
 document.querySelector('#profile-section').innerHTML='<span class="username-text">@'+handle+'</span> 1 posts';
 const posts=document.querySelector('#post-container');
 if(!(middle&&mode==='no-api')){fetch('/api/profile').catch(()=>{});fetch('/api/posts').catch(()=>{});}
 if(!middle){posts.innerHTML=card();return;}
 if(['empty','no-api','delayed','403','429','503','challenge','closed','deadline','in-flight','transport-failed','category','profile-drift','section-error'].includes(mode))posts.innerHTML='';else posts.innerHTML=card();
 if(mode==='bad-date')posts.innerHTML=card('POST','gibberish date');
 if(mode==='delayed')setTimeout(()=>posts.innerHTML=card(),500);
 if(mode==='unstable')setInterval(()=>posts.innerHTML=card('ID'+Date.now()),100);
 if(mode==='date-churn')setInterval(()=>posts.innerHTML=card('POST',Date.now()+' hours ago'),100);
 if(mode==='chatter')setInterval(()=>{posts.querySelector('.likes-trigger span').textContent=Date.now();posts.querySelector('.comments-trigger span').textContent=Date.now();posts.querySelector('.post-content p').textContent='PRIVATE-CAPTION-'+Date.now();posts.querySelector('a').href='/media?signature=PRIVATE-'+Date.now()+'&id=POST';},100);

 if(['challenge','stable-challenge'].includes(mode))setTimeout(()=>{const el=document.createElement('div');el.id='challenge-form';el.textContent='verify';document.body.append(el);},250);
 if(mode==='closed')setTimeout(()=>window.closeFixtureBrowser(),250);
 if(mode==='category')document.querySelector('.menu-item').setAttribute('data-id','REELS');
 if(mode==='profile-drift')setTimeout(()=>document.querySelector('.username-text').textContent='@wrong',250);
 if(mode==='section-error'){const el=document.createElement('div');el.id='error-no-content';el.textContent='private detail';document.body.append(el);}
 if(['403','429','503','challenge','stable-challenge','closed','deadline'].includes(mode))setTimeout(()=>fetch('/api/must-not-run').catch(()=>{}),1800);
}`;}

 const wrap={newContext:async opts=>{
  const c=await browser.newContext(opts);
  await c.exposeFunction('closeFixtureBrowser',()=>browser.close());
  await c.route('**/*',async route=>{
   const u=new URL(route.request().url());calls.push(u.pathname);
   if(u.pathname.startsWith('/api/')){
    const handle=await route.request().frame().evaluate(()=>document.querySelector('#search-input').value);
    const target=handle==='middle'&&u.pathname===(mode.startsWith('initial-profile-')?'/api/profile':'/api/posts');
    if(target&&['transport-failed','initial-failed-stable','initial-profile-failed-stable'].includes(mode))return route.abort('failed');
    if(target&&['in-flight','initial-pending-stable','initial-profile-pending-stable'].includes(mode))return new Promise(()=>{});
    return route.fulfill({status:target&&mode==='403'?403:target&&mode==='429'?429:target&&mode==='503'?503:200,contentType:'application/json',
     body:u.pathname==='/api/posts'?JSON.stringify(listingFor(handle,mode)):'{}'});
   }
   await route.fulfill({status:200,contentType:'text/html',body:html});
  });return c;
 },close:async()=>{}};
 const deps={chromium:{launch:async()=>wrap},dnsLookup:async()=>[{address:'93.184.216.34',family:4}],readinessWaitMs:2400};
 const config={handles:['alpha','middle','zulu'].map(handle=>({handle,dateAfter:'2020-01-01'})),runId:'readiness',output:path.join(root,'out'),resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'ledger.json'),allowEstimatedDates:true,maxTimeMs:20000};
 return {config,deps,calls,downloads:()=>downloads};
}

for(const mode of ['empty','unstable','date-churn'])test('real DOM '+mode+' middle window is local, later healthy receipts still complete',async t=>{
 const f=await fixture(t,mode),d=await W.syncWindow(f.config,f.deps),h=d.handles.middle;
 assert.equal(d.status,'PARTIAL',JSON.stringify(d));assert.equal(d.stoppedGlobally,false);assert.equal(h.error.code,'WINDOW_NOT_READY');assert.equal(h.error.scope,'handle');assert.equal(h.failed,true);
 assert.equal(d.handles.alpha.status,'COMPLETE');assert.equal(d.handles.zulu.status,'COMPLETE');assert.equal(f.downloads(),2);assert.equal(f.calls.filter(x=>x==='/en/photo').length,3);assert.equal(h.readiness.transport.started,2);assert.equal(h.readiness.transport.settled,2);assert.deepEqual(h.readiness.transport.paths,{'/api/profile':1,'/api/posts':1});
 assert.equal(W.localWindowReadiness(h.readiness),true);assert.equal(h.readiness.cause,mode==='empty'?'empty':'unstable');assert.ok(h.readiness.samples>=2);assert.deepEqual(h.files,[]);assert.equal(h.observedAt,undefined);assert.equal(h.observations,undefined);assert.equal(d.fullHistoryComplete,false);
 assert.equal(JSON.stringify(d).includes('PRIVATE'),false);assert.equal(JSON.stringify(d).includes('/media?'),false);assert.deepEqual(JSON.parse(await fs.readFile(f.config.resultFile)),d);
 await assert.rejects(W.combineWindowResults({...f.config,runId:'compose',resultFile:f.config.resultFile+'.combined'},[f.config.resultFile]),/no verified window/);
});
for(const mode of ['delayed','chatter'])test('real DOM '+mode+' valid window completes without weakening identity/date gates',async t=>{
 const f=await fixture(t,mode),d=await W.syncWindow(f.config,f.deps);
 assert.equal(d.status,'COMPLETE',JSON.stringify(d));assert.equal(d.handles.middle.observedCards,1);assert.equal(f.downloads(),3);assert.equal(d.fullHistoryComplete,false);
});
for(const mode of ['403','429','503','challenge','stable-challenge','closed','deadline'])test('late '+mode+' during readiness is global and sends no subsequent request',async t=>{
 const f=await fixture(t,mode);
 if(mode==='deadline'){f.config.handles=f.config.handles.slice(1);f.config.maxTimeMs=1100;}
 const d=await W.syncWindow(f.config,f.deps);
 assert.equal(d.stoppedGlobally,true,JSON.stringify(d));assert.equal(d.handles.middle.error.scope,'global');assert.equal(d.handles.zulu.status,'NOT_COMPLETED');assert.equal(f.calls.includes('/api/must-not-run'),false);assert.equal(f.calls.filter(x=>x==='/en/photo').length,mode==='deadline'?1:2);assert.equal(f.downloads(),mode==='deadline'?0:1);
 if(['403','429','challenge','stable-challenge'].includes(mode))assert.equal(d.status,'BLOCKED');
 if(['403','429'].includes(mode))assert.ok(d.requests.denial);
 if(['challenge','stable-challenge'].includes(mode))assert.equal(d.handles.middle.readiness.challenge,true);
 if(mode==='closed')assert.equal(d.handles.middle.readiness.browserOpen,false);
 if(mode==='deadline')assert.equal(d.error.code,'TIME_LIMIT');
});
for(const mode of ['in-flight','transport-failed','initial-pending-stable','initial-failed-stable','initial-profile-pending-stable','initial-profile-failed-stable','category','profile-drift','section-error'])test('ambiguous '+mode+' evidence never permits local readiness isolation',async t=>{
 const f=await fixture(t,mode),d=await W.syncWindow(f.config,f.deps);
 assert.equal(d.stoppedGlobally,true,JSON.stringify(d));assert.equal(d.handles.middle.error.scope,'global');assert.equal(d.handles.zulu.status,'NOT_COMPLETED');assert.equal(f.downloads(),1);
 assert.equal(!!W.localWindowReadiness(d.handles.middle.readiness),false);
 const r=d.handles.middle.readiness;assert.equal(r.transport.paths['/api/posts'],1);
 if(mode.includes('pending')||mode==='in-flight')assert.equal(r.transport.inFlight,1);
 if(mode.includes('failed'))assert.equal(r.transport.failed,1);
 if(mode.includes('stable'))assert.ok(r.stableSamples>=2,'stable raw DOM alone must not complete while initial posts transport is unresolved');
});
test('signature ignores engagement and signed query only; media id, date, type, membership remain binding',()=>{
 const raw={shortcode:'POST',href:'https://instacognito.com/media?id=ID&signature=one',mediaType:'image',dateRaw:'1 January 2026',likes:'1',comments:'2',captionTruncated:'a'};
 const signature=W.windowSignature([raw]);assert.equal(W.windowSignature([{...raw,likes:'5',comments:'4',captionTruncated:'b',href:'https://instacognito.com/media?signature=two&id=ID'}]),signature);
 for(const patch of [{shortcode:'OTHER'},{href:'https://instacognito.com/media?id=OTHER&signature=one'},{mediaType:'video'},{dateRaw:'2 January 2026'}])assert.notEqual(W.windowSignature([{...raw,...patch}]),signature);
 assert.notEqual(W.windowSignature([raw,raw]),signature);
});

test('production 45-second local expiry leaves later handle runnable, without larger budget',async t=>{
 const f=await fixture(t,'empty');delete f.deps.readinessWaitMs;f.config.maxTimeMs=60000;f.config.handles=f.config.handles.slice(1);
 const d=await W.syncWindow(f.config,f.deps);assert.equal(d.stoppedGlobally,false,JSON.stringify(d));assert.equal(d.status,'PARTIAL');assert.equal(d.handles.middle.error.scope,'handle');assert.equal(d.handles.middle.readiness.waitMs,45000);assert.ok(d.handles.middle.readiness.elapsedMs>=45000);assert.equal(d.handles.zulu.status,'COMPLETE');assert.equal(f.downloads(),1);
});
test('pure local classifier rejects absent, malformed, transport and global deadline evidence',()=>{
 // `binding` is part of the readiness record under the render-binding contract: an empty window
 // attempted no binding, so its record carries null, and an unbound/unrendered window is never
 // positive local evidence at all.
 const d={schemaVersion:1,handle:'middle',phase:'window',cause:'empty',profileMatched:true,profileHasTotal:true,category:'POSTS',challenge:false,sectionError:null,browserOpen:true,rawCount:0,maxRawCount:0,samples:45,signatureChanges:0,stableSamples:0,binding:null,waitMs:45000,elapsedMs:45000,deadlineRemainingMs:5000,transport:{started:2,settled:2,failed:0,inFlight:0,paths:{'/api/posts':1,'/api/profile':1},statuses:{200:3}}};
 assert.equal(W.localWindowReadiness(d),true);
 // The accepted record under the proven-contract binding: one basis, the decoded schema shape,
 // and all-zero unmatched counters - an accepted window matched exhaustively by construction.
 const bound={basis:'response-tuples',reason:null,schema:{version:1,records:1,children:0,cards:1},unmatched:{missing:0,extra:0,mismatched:0},commitGen:2,identityGen:1};
 assert.equal(W.localWindowReadiness({...d,cause:'unstable',rawCount:1,maxRawCount:1,stableSamples:1,binding:bound}),true);
 for(const value of [null,{},[],{...d,binding:undefined},{...d,binding:{}},{...d,binding:bound},
  {...d,cause:'unbound',binding:null},{...d,cause:'unrendered',binding:null},
  {...d,cause:'unstable',rawCount:1,maxRawCount:1,stableSamples:1,binding:{...bound,basis:null}},
  {...d,cause:'unstable',rawCount:1,maxRawCount:1,stableSamples:1,binding:{...bound,reason:'unrendered-response-tuples'}},
  {...d,cause:'unstable',rawCount:1,maxRawCount:1,stableSamples:1,binding:{...bound,basis:'request-generation-provenance'}},
  {...d,cause:'unstable',rawCount:1,maxRawCount:1,stableSamples:1,binding:{...bound,unmatched:{missing:1,extra:0,mismatched:1}}},
  {...d,cause:'unstable',rawCount:1,maxRawCount:1,stableSamples:1,binding:{...bound,schema:{version:1,records:1,children:0}}},
  {...d,cause:'unstable',rawCount:1,maxRawCount:1,stableSamples:1,binding:{...bound,commitGen:-1}},{...d,transport:{...d.transport,started:0,settled:0,paths:{}}},{...d,transport:{...d.transport,paths:{'/api/posts':2}}},{...d,transport:{...d.transport,paths:{'/api/profile':2}}},{...d,transport:{...d.transport,started:3,settled:3}},{...d,deadlineRemainingMs:0},{...d,elapsedMs:44999},{...d,waitMs:45001},{...d,challenge:true},{...d,browserOpen:false},{...d,samples:0},{...d,rawCount:1},{...d,stableSamples:2},{...d,profileMatched:false},{...d,transport:{...d.transport,failed:1}},{...d,transport:{...d.transport,statuses:{403:1}}},{...d,transport:{...d.transport,statuses:{429:1}}},{...d,transport:{...d.transport,statuses:{503:1}}}])assert.equal(W.localWindowReadiness(value),false,JSON.stringify(value));
});

test('empty DOM with zero API requests cannot supply positive local readiness evidence',async t=>{
 const f=await fixture(t,'no-api'),d=await W.syncWindow(f.config,f.deps);
 assert.equal(d.stoppedGlobally,true);assert.equal(d.handles.middle.error.scope,'global');assert.equal(d.handles.middle.readiness.transport.started,0);assert.equal(W.localWindowReadiness(d.handles.middle.readiness),false);assert.equal(d.handles.zulu.status,'NOT_COMPLETED');assert.equal(f.downloads(),1);
});

// A card the date policy cannot read is evidence about ONE handle, not about the
// provider or this process, so it must not stop the handles queued behind it.
test('an unparseable card date isolates that handle instead of stopping the job',async t=>{
 const f=await fixture(t,'bad-date'),d=await W.syncWindow(f.config,f.deps),h=d.handles.middle;
 assert.equal(d.stoppedGlobally,false,JSON.stringify(d));assert.equal(d.status,'PARTIAL');
 assert.equal(h.error.code,'DATE_POLICY',JSON.stringify(h.error));assert.equal(h.error.scope,'handle');assert.equal(h.failed,true);assert.deepEqual(h.files,[]);
 assert.equal(h.scope,'current-visible-posts');assert.equal(h.dateAfter,'2020-01-01');
 assert.equal(d.handles.alpha.status,'COMPLETE');assert.equal(d.handles.zulu.status,'COMPLETE');assert.equal(f.downloads(),2);
 assert.equal(JSON.stringify(d).includes('PRIVATE'),false);
 assert.deepEqual(JSON.parse(await fs.readFile(f.config.resultFile)),d);
});
