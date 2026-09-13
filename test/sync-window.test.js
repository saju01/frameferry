'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const F=require('../src/index.js'),W=require('../src/sync-window.js'),{openBudget}=require('../src/request-budget.js'),{estimateDate}=require('../src/date-estimate.js');
const jpg=Buffer.from([255,216,255,224,1,2,3,4,255,217]);
async function tmp(t){const p=await fs.mkdtemp(path.join(os.tmpdir(),'ff-window-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));return p;}
const raw=(code='POST',label='8 hours ago')=>({shortcode:code,href:'https://instacognito.com/media?id='+code,mediaType:'image',dateRaw:label});
test('opt-in estimates anchored to observation; raw core parser stays unchanged',()=>{
 const e=estimateDate('8 hours ago','2026-09-13T01:00:00Z','Europe/Amsterdam');assert.equal(e.iso,'2026-09-12T17:00:00.000Z');assert.equal(e.precision,'estimated');assert.equal(F.parseDateText('8 hours ago'),'8 hours ago');
 assert.throws(()=>W.select([raw()],'2026-09-13T01:00:00Z',{dateAfter:'2026-09-12'}),/allowEstimatedDates/);
 assert.equal(W.select([raw()],'2026-09-13T01:00:00Z',{dateAfter:'2026-09-12',allowEstimatedDates:true})[0].selected,true);
});
test('cutoff conservatively includes overlap, older dates excluded, empty and malformed fail',()=>{
 assert.equal(W.select([raw('OLD','1 January 2025')],'2026-09-13T01:00:00Z',{dateAfter:'2026-09-12'})[0].selected,false);
 assert.throws(()=>W.select([],'2026-09-13T01:00:00Z',{}));assert.throws(()=>estimateDate('31 February 2026','2026-09-13T01:00:00Z'));
 assert.throws(()=>W.validate({handles:[{handle:'example',dateAfter:'nope'}]}));
});
test('ledger caps, serial ownership, cross-run rolling count and sticky denial',async t=>{
 const p=path.join(await tmp(t),'budget.json'),a=openBudget(p,'one',2);a.reserve('discovery');a.reserve('download');assert.throws(()=>a.reserve('download'),/allowance/);assert.throws(()=>openBudget(p,'other',2),/owned/);a.close();
 const b=openBudget(p,'two',2);assert.equal(b.data.recent_request_ms.length,2);assert.throws(()=>b.inspect(429,{'retry-after':'60'},'https://instacognito.com'),/RATE_LIMITED/);b.close();
 const c=openBudget(p,'three',2);assert.throws(()=>c.reserve('discovery'),/denial/);c.close();
 const d=JSON.parse(await fs.readFile(p));d.recent_request_ms=null;await fs.writeFile(p,JSON.stringify(d));assert.throws(()=>openBudget(p,'four',2),/trustworthy/);
});
test('all redirect hops count and 429 never retries',async t=>{
 const p=path.join(await tmp(t),'budget.json'),a=openBudget(p,'redirects',5);let calls=0;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async()=>{calls++;return new Response(null,{status:429,headers:{'retry-after':'30'}});};
 await assert.rejects(a.fetch('https://instacognito.com/media?id=x',{}),/RATE_LIMITED/);await assert.rejects(a.fetch('https://instacognito.com/media?id=x',{}));assert.equal(calls,1);assert.equal(a.data.requests,1);a.close();
});
async function browserFixture(t,status=200,profileDelay=0){
 const chromium=require('playwright').chromium;
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium'});t.after(()=>browser.close());
 const contexts=[];let requests=0,preview=0;
 const wrap={newContext:async opts=>{assert.equal(opts.serviceWorkers,'block');const c=await browser.newContext(opts);contexts.push(c);await c.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.pathname==='/media'){preview++;return route.abort();}
  requests++;
  const html='<input id="search-input"><button id="download-btn" onclick="show()">Search</button><div id="profile-section"></div><div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">Posts</button></div><div id="post-container"></div><script>function show(){document.getElementById("profile-section").innerHTML=\'<span class="username-text">@example</span> 1 posts\';document.getElementById("post-container").innerHTML=\'<div class="post-card"><img class="post-image" data-type="image" src="/media?id=POST"><a class="content-download-btn" href="/media?id=POST"></a><span data-id="POST"></span><div class="post-footer"><span class="icon-group"><span>8 hours ago</span></span></div></div>\';}</script>';
  const delayed = profileDelay ? html.replace('document.getElementById("profile-section").innerHTML=', 'setTimeout(()=>document.getElementById("profile-section").innerHTML=').replace(" 1 posts\';document.getElementById", " 1 posts\',"+profileDelay+");document.getElementById") : html;
  await route.fulfill({status:Array.isArray(status)?status[requests-1]||200:status,contentType:'text/html',body:delayed.replace('@example', "@'+document.getElementById(\"search-input\").value+'")});
 });return c;},close:async()=>{}};
 return {chromium:{launch:async()=>wrap,connectOverCDP:async()=>wrap},counts:()=>({requests,preview}),dnsLookup:async()=>[{address:"93.184.216.34",family:4}],browser};
}
test('full browser discovery -> real downloadOne -> receipts; repeat is cache-only, no history claim',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t);let downloads=0;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async()=>{downloads++;return new Response(jpg,{headers:{'content-type':'image/jpeg','content-length':String(jpg.length)}});};
 const config={handles:[{handle:'example',dateAfter:'2020-01-01'}],runId:'first',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'first.json'),allowEstimatedDates:true};
 const first=await W.syncWindow(config,fixture);assert.equal(first.status,'COMPLETE',JSON.stringify(first));assert.equal(first.fullHistoryComplete,false);assert.equal(first.handles.example.files.length,1);assert.equal(first.totals.downloaded,1);assert.equal(fixture.counts().preview,0);
 assert.equal(JSON.stringify(first).includes('/media?id='),false);
 const second=await W.syncWindow({...config,runId:'second',resultFile:path.join(root,'second.json')},fixture);assert.equal(second.status,'COMPLETE');assert.equal(second.totals.reused,1);assert.equal(downloads,1);assert.equal(fixture.browser.isConnected(),true);
});
test('browser denial stops before media, publishes non-success result and preserved ledger',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t,403);let downloads=0;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async()=>{downloads++;throw new Error('unexpected media fetch');};
 const config={handles:[{handle:'example',dateAfter:'2020-01-01'}],runId:'denied',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true,maxTimeMs:5000};
 const result=await W.syncWindow(config,fixture);assert.equal(result.status,'BLOCKED');assert.equal(downloads,0);assert.ok(result.requests.denial);assert.equal(JSON.parse(await fs.readFile(config.resultFile)).status,'BLOCKED');
});

test('every allowed provider resource reserves budget; previews/styles/fonts are blocked',async t=>{
 const file=path.join(await tmp(t),'budget.json'),b=openBudget(file,'resources',2);let routeHandler;
 const page={route:async(_,h)=>{routeHandler=h;},on:()=>{}};await W.installGuards(page,b);
 async function send(type){let allowed=0,aborted=0;await routeHandler({request:()=>({url:()=>F.PROVIDER_ORIGIN+'/asset',resourceType:()=>type}),fallback:async()=>{allowed++;},abort:async()=>{aborted++;}});return {allowed,aborted};}
 for(const type of ['image','media','stylesheet','font'])assert.deepEqual(await send(type),{allowed:0,aborted:1});
 assert.deepEqual(await send('script'),{allowed:1,aborted:0});assert.deepEqual(await send('other'),{allowed:1,aborted:0});assert.deepEqual(await send('document'),{allowed:0,aborted:1});assert.equal(b.data.requests,2);b.close();
});
test('redirect chain debits each physical HTTP call',async t=>{
 const file=path.join(await tmp(t),'budget.json'),b=openBudget(file,'chain',5);const original=globalThis.fetch;let calls=0;
 try {globalThis.fetch=async()=>{calls++;return calls===1?new Response(null,{status:302,headers:{location:'https://instacognito.com/media?id=next'}}):new Response(jpg,{headers:{'content-type':'image/jpeg'}});};
 const response=await F.fetchWithValidatedRedirects('https://instacognito.com/media?id=chain',{fetchImpl:b.fetch,remainingMs:1000,dnsLookup:async()=>[{address:'93.184.216.34',family:4}]});assert.equal(response.status,200);assert.equal(calls,2);assert.equal(b.data.requests,2);
 }finally{globalThis.fetch=original;b.close();}
});

test('profile metadata arriving after eight seconds is awaited, not retried or falsely completed',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t,200,9000);
 const result=await W.syncWindow({handles:[{handle:'example',dateAfter:'2099-01-01'}],runId:'slow',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true,maxTimeMs:20000},fixture);
 assert.equal(result.status,'COMPLETE',JSON.stringify(result));assert.equal(result.handles.example.observedCards,1);assert.equal(result.totals.downloaded,0);
});

test('composition requires every recent complete window and never promotes original partial result',async t=>{
 const root=await tmp(t),output=path.join(root,'cache');await fs.mkdir(output);const at=new Date().toISOString();
 const part={schemaVersion:1,kind:'frameferry-sync-window',runId:'old',scope:'current-visible-posts',fullHistoryComplete:false,output,status:'PARTIAL',requests:{denial:null},handles:{example:{status:'COMPLETE',dateAfter:'2026-01-01',observedCards:1,observedAt:at,selectedCards:0,files:[],observations:[{stableId:'posts__'+'a'.repeat(64),selected:false,date:estimateDate('1 January 2025',at,'UTC')}]}}};
 const file=path.join(root,'part.json');await fs.writeFile(file,JSON.stringify(part));
 const cfg={handles:[{handle:'example',dateAfter:'2026-01-01'}],runId:'combined',output,resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'unused.json'),allowEstimatedDates:true};
 const d=await W.combineWindowResults(cfg,[file]);assert.equal(d.status,'COMPLETE');assert.equal(d.composition.additionalProviderRequests,0);assert.equal(JSON.parse(await fs.readFile(file)).status,'PARTIAL');
 await assert.rejects(W.combineWindowResults({...cfg,resultFile:path.join(root,'missing.json'),handles:[...cfg.handles,{handle:'other',dateAfter:'2026-01-01'}]},[file]),/no verified window/);
 part.handles.example.observedAt='2020-01-01T00:00:00Z';await fs.writeFile(file,JSON.stringify(part));await assert.rejects(W.combineWindowResults({...cfg,resultFile:path.join(root,'stale.json')},[file]),/stale/);
});

test('composition rejects mismatched selected IDs and malformed date provenance',async t=>{
 const root=await tmp(t),output=path.join(root,'cache');await fs.mkdir(output);const at=new Date().toISOString(),date=estimateDate('1 January 2026',at,'UTC'),a='posts__'+'a'.repeat(64),b='posts__'+'b'.repeat(64);
 const h={status:'COMPLETE',dateAfter:'2026-01-01',observedAt:at,observedCards:1,selectedCards:1,observations:[{stableId:a,selected:true,date}],files:[{stableId:b,date,profileHandle:'example',path:'wrong.jpg',sha256:'a'.repeat(64),bytes:1}]};
 const d={schemaVersion:1,kind:'frameferry-sync-window',runId:'source',scope:'current-visible-posts',fullHistoryComplete:false,output,status:'PARTIAL',requests:{denial:null},handles:{example:h}},file=path.join(root,'part.json');
 const cfg={handles:[{handle:'example',dateAfter:'2026-01-01'}],runId:'composed',output,resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'unused.json'),allowEstimatedDates:true};
 await fs.writeFile(file,JSON.stringify(d));await assert.rejects(W.combineWindowResults(cfg,[file]),/identity\/byte verification/);
 h.observations[0].date={timeZone:'UTC'};await fs.writeFile(file,JSON.stringify(d));await assert.rejects(W.combineWindowResults(cfg,[file]));
 h.observations[0].date={...date,observedAt:'2020-01-01T00:00:00Z'};await fs.writeFile(file,JSON.stringify(d));await assert.rejects(W.combineWindowResults(cfg,[file]),/date provenance/);
});

test('public provider has no inherited 120/140 quota, and history/denial remain intact',async t=>{
 const p=path.join(await tmp(t),'budget.json'),a=openBudget(p,'old-policy');a.close();
 const old=JSON.parse(await fs.readFile(p));old.requests=140;old.recent_request_ms=Array(140).fill(Date.now());old.session_ceiling=120;old.hourly_ceiling=140;delete old.quota_policy;await fs.writeFile(p,JSON.stringify(old));
 const b=openBudget(p,'old-policy');b.reserve('discovery');assert.equal(b.data.requests,141);assert.equal(b.data.recent_request_ms.length,141);assert.equal(b.data.session_ceiling,null);assert.equal(b.data.hourly_ceiling,null);assert.equal(b.data.previous_local_ceilings.hour,140);
 assert.throws(()=>b.inspect(403,{},'https://instacognito.com'),/DENIED/);b.close();const c=openBudget(p,'new-policy');assert.throws(()=>c.reserve('discovery'),/denial/);c.close();
});
test('shared admission paces concurrent starts and denial prevents queued calls',async t=>{
 const p=path.join(await tmp(t),'budget.json'),b=openBudget(p,'pace');let times=[];
 await Promise.all(['discovery','download','discovery'].map(phase=>b.admit(phase).then(()=>times.push(performance.now()))));assert.equal(times.length,3);assert.ok(times[1]-times[0]>=480);assert.ok(times[2]-times[1]>=480);
 const pending=b.admit('download');assert.throws(()=>b.inspect(429,{'retry-after':'60'},'https://instacognito.com'),/RATE_LIMITED/);await assert.rejects(pending);assert.equal(b.data.requests,3);b.close();
});
test('expired download signal cannot send a queued request after pacing',async t=>{
 const p=path.join(await tmp(t),'budget.json'),b=openBudget(p,'abort'),ac=new AbortController();await b.admit('discovery');ac.abort();await assert.rejects(b.admit('download',ac.signal));assert.equal(b.data.requests,1);b.close();
});

test('closing a paced run rejects queued admissions before ledger/network mutation',async t=>{
 const p=path.join(await tmp(t),'budget.json'),b=openBudget(p,'close');await b.admit('discovery');const pending=b.admit('download');b.close();await assert.rejects(pending,/closed/);assert.equal(JSON.parse(await fs.readFile(p)).requests,1);
});

test('pacing survives close and reopen with a different run ID',async t=>{
 const p=path.join(await tmp(t),'budget.json'),a=openBudget(p,'run-a');await a.admit('discovery');const first=performance.now();a.close();
 const b=openBudget(p,'run-b');await b.admit('download');assert.ok(performance.now()-first>=480);assert.equal(b.data.recent_request_ms.length,2);assert.equal(b.data.requests,1);b.close();
});

const witness=(shortcode='KNOWN')=>({shortcode,category:'posts',minDayHi:'2026-09-12',source:'owner-direct-observation',sourceObservedAt:'2026-09-13T00:00:00Z'});
test('known-post config rejects malformed, duplicate, category and untrusted provenance fields',()=>{
 const valid={dateAfter:'2026-09-08',expectedPosts:[witness()]};assert.equal(W.validateExpectedPosts(valid).length,1);
 for(const w of [{...witness(),category:'stories'},{...witness(),minDayHi:'2026-02-31'},{...witness(),shortcode:'https://example.org'},{...witness(),source:'arbitrary'},{...witness(),sourceObservedAt:'nope'},{...witness(),sourceObservedAt:'2099-01-01T00:00:00Z'},{...witness(),url:'secret'}])assert.throws(()=>W.validateExpectedPosts({...valid,expectedPosts:[w]}));
 assert.throws(()=>W.validateExpectedPosts({...valid,expectedPosts:[witness(),witness()]}));assert.throws(()=>W.validateExpectedPosts({...valid,expectedPosts:null}));
});
test('known-post coverage matches category and date, not carousel position, and is not full-feed proof',()=>{
 const spec={dateAfter:'2026-09-08',expectedPosts:[witness()]},row={category:'posts',shortcode:'KNOWN',date:{dayHi:'2026-09-12'},selected:true};
 assert.equal(W.witnessCoverage(spec,[]).satisfied,false);
 assert.equal(W.witnessCoverage(spec,[{...row,category:'reels'}]).satisfied,false);
 assert.equal(W.witnessCoverage(spec,[{...row,date:{dayHi:'2026-08-13'}}]).satisfied,false);
 const ok=W.witnessCoverage(spec,[row,{...row,stableId:'different-slide'}]);assert.equal(ok.satisfied,true);assert.deepEqual(ok.observedWitnesses,['KNOWN']);assert.equal(ok.fullFeedComplete,false);
 assert.equal(W.witnessCoverage({...spec,dateAfter:'2026-09-13'},[]).satisfied,true);
});
test('real browser missing witness returns PARTIAL with evidence before any download',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t);const config={handles:[{handle:'example',dateAfter:'2026-09-08',expectedPosts:[witness()]}],runId:'known-gap',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true};
 let downloads=0;const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async()=>{downloads++;throw Error('must not download');};
 const d=await W.syncWindow(config,fixture);assert.equal(d.status,'PARTIAL');assert.equal(d.error.code,'FEED_COVERAGE_GAP');assert.equal(d.handles.example.status,'PARTIAL');assert.deepEqual(d.handles.example.coverage.missingWitnesses,['KNOWN']);assert.equal(downloads,0);assert.equal(d.fullHistoryComplete,false);
 assert.equal(JSON.parse(await fs.readFile(config.resultFile)).status,'PARTIAL');
});
test('real browser witness match succeeds and composition rechecks policy and observations',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t),old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async()=>new Response(jpg,{headers:{'content-type':'image/jpeg'}});
 const spec={handle:'example',dateAfter:'2020-01-01',expectedPosts:[{...witness('POST'),minDayHi:'2020-01-01'}]},cfg={handles:[spec],runId:'match',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true};
 const d=await W.syncWindow(cfg,fixture);assert.equal(d.status,'COMPLETE',JSON.stringify(d));assert.equal(d.handles.example.coverage.satisfied,true);assert.equal(d.handles.example.coverage.fullFeedComplete,false);
 const combined=await W.combineWindowResults({...cfg,runId:'combined',resultFile:path.join(root,'combined.json')},[cfg.resultFile]);assert.equal(combined.status,'COMPLETE');
 delete d.handles.example.coverage;await fs.writeFile(cfg.resultFile,JSON.stringify(d));await assert.rejects(W.combineWindowResults({...cfg,runId:'legacy',resultFile:path.join(root,'legacy.json')},[cfg.resultFile]),/known-post coverage/);
 d.handles.example.coverage=combined.handles.example.coverage;d.handles.example.observations[0].shortcode='OTHER';await fs.writeFile(cfg.resultFile,JSON.stringify(d));await assert.rejects(W.combineWindowResults({...cfg,runId:'missing',resultFile:path.join(root,'missing.json')},[cfg.resultFile]),/known-post coverage/);
});

test('pure destination validator recomputes date provenance even with coherent forged coverage',()=>{
 const at='2026-09-13T00:00:00Z',date=estimateDate('1 hour ago',at,'Europe/Amsterdam'),spec={handle:'example',dateAfter:'2026-09-08',expectedPosts:[witness()]},id='posts__'+'a'.repeat(64);
 const x={stableId:id,shortcode:'KNOWN',category:'posts',selected:true,date},file={stableId:id,shortcode:'KNOWN',profileHandle:'example',date};
 const h={status:'COMPLETE',scope:'current-visible-posts',dateAfter:spec.dateAfter,observedAt:at,observedCards:1,selectedCards:1,observations:[x],files:[file]};h.coverage=W.witnessCoverage(spec,h.observations);
 assert.equal(W.validateWitnessWindow(spec,h,{timeZone:'Europe/Amsterdam',allowEstimatedDates:true}).satisfied,true);
 for(const [key,value] of [['raw','13 August'],['iso','2026-09-12T12:00:00.000Z'],['observedAt','2026-09-12T00:00:00Z'],['timeZone','UTC'],['basis','absolute_year'],['precision','day']]){
  const forged=JSON.parse(JSON.stringify(h));forged.observations[0].date[key]=value;forged.files[0].date[key]=value;assert.throws(()=>W.validateWitnessWindow(spec,forged,{timeZone:'Europe/Amsterdam',allowEstimatedDates:true}),/date provenance/);
 }
});

// All pages are real Chromium DOMs, fulfilled in-process; no provider traffic.
test('partial middle handle retains witness gap and later healthy handle downloads',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t),old=globalThis.fetch;let calls=0;
 t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async()=>{calls++;return new Response(jpg,{headers:{'content-type':'image/jpeg'}});};
 const cfg={handles:[{handle:'alpha',dateAfter:'2020-01-01'},{handle:'middle',dateAfter:'2026-09-08',expectedPosts:[witness()]},{handle:'zulu',dateAfter:'2020-01-01'}],runId:'isolation',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true};
 const d=await W.syncWindow(cfg,fixture);
 assert.equal(d.status,'PARTIAL');assert.equal(d.handles.zulu.status,'COMPLETE','later healthy handle must run after a local gap');
 assert.equal(d.handles.alpha.status,'COMPLETE');assert.equal(d.stoppedGlobally,false);assert.equal(d.failureIsolation,'handle-local-v1');
 assert.deepEqual(d.handles.middle.coverage.missingWitnesses,['KNOWN']);assert.equal(d.handles.middle.error.code,'FEED_COVERAGE_GAP');assert.equal(d.handles.middle.error.scope,'handle');assert.deepEqual(d.handles.middle.files,[]);
 assert.equal(calls,2);assert.equal(fixture.counts().requests,3);assert.equal(d.totals.downloaded,2);
 assert.deepEqual(JSON.parse(await fs.readFile(cfg.resultFile)),d);
});
test('healthy zero-selection windows complete around a failed middle handle without downloads',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t),old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async()=>{throw Error('unexpected download');};
 const d=await W.syncWindow({handles:[{handle:'alpha',dateAfter:'2099-01-01'},{handle:'middle',dateAfter:'2026-09-08',expectedPosts:[witness()]},{handle:'zulu',dateAfter:'2099-01-01'}],runId:'empty-healthy',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true},fixture);
 assert.equal(d.status,'PARTIAL');assert.equal(d.handles.zulu.status,'COMPLETE');assert.equal(d.handles.zulu.selectedCards,0);assert.equal(d.totals.downloaded,0);assert.equal(fixture.counts().requests,3);
});
for(const denial of [403,429])test('global '+denial+' after a healthy handle stops later handles',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t,[200,denial,200]);
 const d=await W.syncWindow({handles:['alpha','middle','zulu'].map(handle=>({handle,dateAfter:'2099-01-01'})),runId:'global-denial',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true,maxTimeMs:6000},fixture);
 assert.equal(d.status,'BLOCKED');assert.equal(d.stoppedGlobally,true);assert.ok(d.requests.denial);assert.equal(d.handles.alpha.status,'COMPLETE');assert.equal(d.handles.middle.error.scope,'global');assert.equal(d.handles.zulu.status,'NOT_COMPLETED');assert.equal(fixture.counts().requests,2);
});
test('byte resource failure stops later handles instead of being isolated',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t),old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async()=>new Response(jpg,{headers:{'content-type':'image/jpeg','content-length':'2048'}});
 const d=await W.syncWindow({handles:['alpha','middle','zulu'].map(handle=>({handle,dateAfter:'2020-01-01'})),runId:'bytes',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true,maxBytes:1024},fixture);
 assert.equal(d.status,'PARTIAL');assert.equal(d.stoppedGlobally,true);assert.equal(d.error.code,'TOO_LARGE');assert.equal(d.handles.middle.status,'NOT_COMPLETED');assert.equal(fixture.counts().requests,1);
});

test('browser loss during category verification is global, not a local coverage gap',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t),launch=fixture.chromium.launch;
 fixture.chromium.launch=async()=>{const b=await launch(),newContext=b.newContext;b.newContext=async opts=>{const c=await newContext(opts),newPage=c.newPage.bind(c);c.newPage=async()=>{const p=await newPage(),locator=p.locator.bind(p);p.locator=selector=>selector==='#menu-wrapper .menu-item.active'?{first:()=>({getAttribute:async()=>{throw new Error('browser connection closed');}})}:locator(selector);return p;};return c;};return b;};
 const d=await W.syncWindow({handles:[{handle:'alpha',dateAfter:'2020-01-01',expectedPosts:[witness()]},{handle:'zulu',dateAfter:'2020-01-01'}],runId:'closed-browser',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true},fixture);
 assert.equal(d.status,'PARTIAL');assert.equal(d.stoppedGlobally,true);assert.equal(d.handles.alpha.error.scope,'global');assert.equal(d.handles.zulu.status,'NOT_COMPLETED');assert.equal(fixture.counts().requests,1);
});

test('authenticated-view middle hold creates no page or provider/media request and later healthy handle runs',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t),launch=fixture.chromium.launch,old=globalThis.fetch;let pages=0,downloads=0;
 t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async()=>{downloads++;return new Response(jpg,{headers:{'content-type':'image/jpeg'}});};
 fixture.chromium.launch=async()=>{const b=await launch(),nc=b.newContext;b.newContext=async opts=>{const c=await nc(opts),np=c.newPage.bind(c);c.newPage=async()=>{pages++;return np();};return c;};return b;};
 const held={handle:'middle',dateAfter:'2026-09-08',accessRequired:'authenticated-view',expectedPosts:[witness()]};
 const d=await W.syncWindow({handles:[{handle:'alpha',dateAfter:'2020-01-01'},held,{handle:'zulu',dateAfter:'2020-01-01'}],runId:'access-held',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true},fixture);
 assert.equal(d.status,'PARTIAL');assert.equal(d.stoppedGlobally,false);assert.equal(d.handles.alpha.status,'COMPLETE');assert.equal(d.handles.zulu.status,'COMPLETE');assert.equal(d.handles.middle.error.code,'ACCESS_REQUIRED');assert.equal(d.handles.middle.error.scope,'handle');assert.equal(d.handles.middle.failed,true);assert.equal(d.handles.middle.accessRequired,'authenticated-view');assert.deepEqual(d.handles.middle.coverage,W.witnessCoverage(held,[]));assert.deepEqual(d.handles.middle.files,[]);assert.equal(pages,2);assert.equal(fixture.counts().requests,2);assert.equal(downloads,2);assert.equal(d.requests.session,4);
});
test('invalid accessRequired values reject before browser, ledger or network initialization',async t=>{
 const root=await tmp(t);let launches=0;const deps={chromium:{launch:async()=>{launches++;throw Error('must not launch');}}};
 for(const accessRequired of [null,false,'','public','AUTHENTICATED-VIEW',42]){
  await assert.rejects(W.syncWindow({handles:[{handle:'example',dateAfter:'2020-01-01',accessRequired}],runId:'invalid-access',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json')},deps),/accessRequired must be authenticated-view/);
 }
 assert.equal(launches,0);assert.equal(await fs.stat(path.join(root,'budget.json')).catch(()=>null),null);
});
test('current access hold rejects stale COMPLETE witness evidence and result composition',async t=>{
 const root=await tmp(t),output=path.join(root,'out');await fs.mkdir(output);
 const spec={handle:'example',dateAfter:'2020-01-01',accessRequired:'authenticated-view'};
 assert.throws(()=>W.validateWitnessWindow(spec,{status:'COMPLETE'}),/held handle/);
 const part=path.join(root,'part.json');await fs.writeFile(part,JSON.stringify({kind:'frameferry-sync-window',schemaVersion:1,scope:'current-visible-posts',fullHistoryComplete:false,output,status:'COMPLETE',handles:{example:{status:'COMPLETE',dateAfter:spec.dateAfter}}}));
 await assert.rejects(W.combineWindowResults({handles:[spec],runId:'held-compose',output,requestLedger:path.join(root,'unused.json'),resultFile:path.join(root,'result.json')},[part]),/held handle/);
});
