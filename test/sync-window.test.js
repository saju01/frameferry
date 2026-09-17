'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const F=require('../src/index.js'),W=require('../src/sync-window.js'),{openBudget}=require('../src/request-budget.js'),{estimateDate}=require('../src/date-estimate.js');
const jpg=Buffer.from([255,216,255,224,1,2,3,4,255,217]);
async function tmp(t){const p=await fs.mkdtemp(path.join(os.tmpdir(),'ff-window-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));return p;}
const raw=(code='POST',label='8 hours ago')=>({shortcode:code,href:'https://instacognito.com/media?id='+code,mediaType:'image',dateRaw:label});
const completeWindow=(spec,observedAt,observations,files=[])=>({status:'COMPLETE',scope:'current-visible-posts',dateAfter:spec.dateAfter,observedAt,observedCards:observations.length,selectedCards:files.length,observations,files,coverage:W.witnessCoverage(spec,observations)});
test('opt-in estimates anchored to observation; raw core parser stays unchanged',()=>{
 const e=estimateDate('8 hours ago','2026-09-13T01:00:00Z','Europe/Amsterdam');assert.equal(e.iso,'2026-09-12T17:00:00.000Z');assert.equal(e.precision,'estimated');assert.equal(F.parseDateText('8 hours ago'),'8 hours ago');
 assert.equal(estimateDate('1 January 2026','2026-09-13T01:00:00Z','America/New_York').dayHi,'2026-01-01');
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
 const contexts=[];let requests=0,preview=0,browserCloses=0;
 const wrap={newContext:async opts=>{assert.equal(opts.serviceWorkers,'block');const c=await browser.newContext(opts);contexts.push(c);await c.route('**/*',async route=>{
  const u=new URL(route.request().url());if(u.pathname==='/media'){preview++;return route.abort();}
  requests++;
  const html='<input id="search-input"><button id="download-btn" onclick="show()">Search</button><div id="profile-section"></div><div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">Posts</button></div><div id="post-container"></div><script>function show(){document.getElementById("profile-section").innerHTML=\'<span class="username-text">@example</span> 1 posts\';document.getElementById("post-container").innerHTML=\'<div class="post-card"><img class="post-image" data-type="image" src="/media?id=POST"><a class="content-download-btn" href="/media?id=POST"></a><span data-id="POST"></span><div class="post-footer"><span class="icon-group"><span>8 hours ago</span></span></div></div>\';}</script>';
  const delayed = profileDelay ? html.replace('document.getElementById("profile-section").innerHTML=', 'setTimeout(()=>document.getElementById("profile-section").innerHTML=').replace(" 1 posts\';document.getElementById", " 1 posts\',"+profileDelay+");document.getElementById") : html;
  await route.fulfill({status:Array.isArray(status)?status[requests-1]||200:status,contentType:'text/html',body:delayed.replace('@example', "@'+document.getElementById(\"search-input\").value+'")});
 });return c;},close:async()=>{browserCloses++;}};
 return {chromium:{launch:async()=>wrap,connectOverCDP:async()=>wrap},counts:()=>({requests,preview,browserCloses}),dnsLookup:async()=>[{address:"93.184.216.34",family:4}],browser};
}
test('full browser discovery -> real downloadOne -> receipts; repeat is cache-only, no history claim',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t);let downloads=0;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});globalThis.fetch=async()=>{downloads++;return new Response(jpg,{headers:{'content-type':'image/jpeg','content-length':String(jpg.length)}});};
 const config={handles:[{handle:'example',dateAfter:'2020-01-01'}],runId:'first',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'first.json'),allowEstimatedDates:true};
 const first=await W.syncWindow(config,fixture);assert.equal(first.status,'COMPLETE',JSON.stringify(first));assert.equal(first.fullHistoryComplete,false);assert.equal(first.handles.example.files.length,1);assert.equal(first.totals.downloaded,1);assert.equal(fixture.counts().preview,0);
 assert.equal(JSON.stringify(first).includes('/media?id='),false);
 const second=await W.syncWindow({...config,runId:'second',resultFile:path.join(root,'second.json')},fixture);assert.equal(second.status,'COMPLETE');assert.equal(second.totals.reused,1);assert.equal(downloads,1);assert.equal(fixture.browser.isConnected(),true);
 const beforeAttachCloses=fixture.counts().browserCloses;
 const attached=await W.syncWindow({...config,runId:'attached',resultFile:path.join(root,'attached.json'),attachCdp:'http://127.0.0.1:9222'},fixture);assert.equal(attached.status,'COMPLETE');assert.equal(fixture.counts().browserCloses,beforeAttachCloses);
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
 const spec={handle:'example',dateAfter:'2026-01-01'},observations=[{stableId:'posts__'+'a'.repeat(64),shortcode:'OLD',category:'posts',selected:false,date:estimateDate('1 January 2025',at,'UTC')}];
 const part={schemaVersion:1,kind:'frameferry-sync-window',runId:'old',scope:'current-visible-posts',fullHistoryComplete:false,output,status:'PARTIAL',requests:{denial:null},handles:{example:completeWindow(spec,at,observations)}};
 const file=path.join(root,'part.json');await fs.writeFile(file,JSON.stringify(part));
 const cfg={handles:[spec],runId:'combined',output,resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'unused.json'),allowEstimatedDates:true};
 const d=await W.combineWindowResults(cfg,[file]);assert.equal(d.status,'COMPLETE');assert.equal(d.composition.additionalProviderRequests,0);assert.equal(JSON.parse(await fs.readFile(file)).status,'PARTIAL');
 delete part.handles.example.scope;await fs.writeFile(file,JSON.stringify(part));await assert.rejects(W.combineWindowResults({...cfg,resultFile:path.join(root,'noscope.json')},[file]),/incomplete witness window/);part.handles.example.scope='current-visible-posts';await fs.writeFile(file,JSON.stringify(part));
 await assert.rejects(W.combineWindowResults({...cfg,resultFile:path.join(root,'missing.json'),handles:[...cfg.handles,{handle:'other',dateAfter:'2026-01-01'}]},[file]),/no verified window/);
 part.handles.example.observedAt='2020-01-01T00:00:00Z';await fs.writeFile(file,JSON.stringify(part));await assert.rejects(W.combineWindowResults({...cfg,resultFile:path.join(root,'stale.json')},[file]),/stale/);
});

test('composition rejects mismatched selected IDs and malformed date provenance',async t=>{
 const root=await tmp(t),output=path.join(root,'cache');await fs.mkdir(output);const at=new Date().toISOString(),date=estimateDate('1 January 2026',at,'UTC'),a='posts__'+'a'.repeat(64),b='posts__'+'b'.repeat(64);
 const spec={handle:'example',dateAfter:'2026-01-01'},h=completeWindow(spec,at,[{stableId:a,shortcode:'POST',category:'posts',selected:true,date}],[{stableId:b,shortcode:'POST',date,profileHandle:'example',path:'wrong.jpg',sha256:'a'.repeat(64),bytes:1}]);
 const d={schemaVersion:1,kind:'frameferry-sync-window',runId:'source',scope:'current-visible-posts',fullHistoryComplete:false,output,status:'PARTIAL',requests:{denial:null},handles:{example:h}},file=path.join(root,'part.json');
 const cfg={handles:[spec],runId:'composed',output,resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'unused.json'),allowEstimatedDates:true};
 await fs.writeFile(file,JSON.stringify(d));await assert.rejects(W.combineWindowResults(cfg,[file]),/witness observation\/receipt mismatch/);
 h.files[0].stableId=a;h.coverage=W.witnessCoverage(spec,h.observations);
 h.observations[0].date={timeZone:'UTC'};await fs.writeFile(file,JSON.stringify(d));await assert.rejects(W.combineWindowResults(cfg,[file]));
 h.observations[0].date={...date,observedAt:'2020-01-01T00:00:00Z'};await fs.writeFile(file,JSON.stringify(d));await assert.rejects(W.combineWindowResults(cfg,[file]),/date provenance/);
});

test('cache reuse and composition require canonical media paths',async t=>{
 const root=await tmp(t),output=path.join(root,'cache'),paths=F.profilePaths(output,'example'),id='posts__'+'c'.repeat(64),sha=crypto.createHash('sha256').update(jpg).digest('hex'),badPath=path.relative(output,path.join(paths.mediaDir,'other.jpg'));
 await fs.mkdir(paths.mediaDir,{recursive:true});await fs.mkdir(paths.receiptDir,{recursive:true});await fs.writeFile(path.join(paths.mediaDir,'other.jpg'),jpg);
 const changed=crypto.createHash('sha256').update('/media?id=POST').digest('hex');
 const receipt={stableId:id,id,profileHandle:'example',providerMediaFingerprint:changed,shortcode:'POST',mediaType:'image',path:badPath,bytes:jpg.length,sha256:sha,sourceHost:'instacognito.com',runId:'old'};
 await fs.writeFile(path.join(paths.receiptDir,id+'.json'),JSON.stringify(receipt));
 let fetched=false;const budget={assert(){},fetch:async()=>{fetched=true;throw Error('must not fetch');}};
 await assert.rejects(W.acquireSelection([{item:{stableId:id,providerMediaFingerprint:changed,href:'https://instacognito.com/media?id=POST',mediaType:'image'},date:{},selected:true}],paths,'example','run',budget,{maxBytes:1024,maxFileBytes:1024,deadline:Date.now()+1000,dnsLookup:async()=>[{address:'93.184.216.34',family:4}]}, {downloaded:0,reused:0,bytes:0}),/must not fetch/);
 assert.equal(fetched,true);
 const at=new Date().toISOString(),date=estimateDate('1 January 2026',at,'UTC'),obs={stableId:id,shortcode:'POST',category:'posts',selected:true,date},spec={handle:'example',dateAfter:'2026-01-01'};
 const h=completeWindow(spec,at,[obs],[{...receipt,date}]),part={schemaVersion:1,kind:'frameferry-sync-window',runId:'source',scope:'current-visible-posts',fullHistoryComplete:false,output,status:'COMPLETE',requests:{denial:null},handles:{example:h}},file=path.join(root,'part.json');
 await fs.writeFile(file,JSON.stringify(part));
 await assert.rejects(W.combineWindowResults({handles:[spec],runId:'combined',output,resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'unused.json')},[file]),/identity\/byte verification/);
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

// Wave 3: the job deadline must bound admission itself, not only forwarding.
const guardPage=()=>{let handler;const page={route:async(_,h)=>{handler=h;},on:()=>{}};return {page,send:(counters,type='document',pathname='/api/posts')=>handler({request:()=>({url:()=>F.PROVIDER_ORIGIN+pathname,resourceType:()=>type}),fallback:async()=>{counters.allowed++;},abort:async reason=>{counters.aborted++;counters.reasons.push(reason);}})};};
const counters=()=>({allowed:0,aborted:0,reasons:[]});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('a queued admission past the job deadline is neither reserved nor forwarded',async t=>{
 const file=path.join(await tmp(t),'budget.json'),b=openBudget(file,'deadline-admit'),g=guardPage(),c=counters();
 await W.installGuards(g.page,b,Date.now()+120);
 // Two concurrent provider routes: the second is queued behind the 500ms pacing
 // interval, which outlasts the remaining 120ms of job budget.
 await Promise.all([g.send(c),g.send(c)]);
 assert.equal(c.allowed,1,'only the pre-deadline request may be forwarded');
 assert.equal(c.aborted,1);assert.deepEqual(c.reasons,['blockedbyclient']);
 assert.equal(b.data.requests,1,'a post-deadline request must not be reserved');
 assert.equal(b.data.by_phase.discovery,1);assert.equal(b.data.recent_request_ms.length,1);
 assert.equal(JSON.parse(await fs.readFile(file)).requests,1,'the persisted ledger must not be debited after the deadline');
 b.close();
});

test('a recorded provider denial outranks the job deadline for queued admissions',async t=>{
 const file=path.join(await tmp(t),'budget.json'),b=openBudget(file,'deadline-denial'),g=guardPage(),c=counters();
 await W.installGuards(g.page,b,Date.now()+60);
 await g.send(c);
 const queued=g.send(c);
 assert.throws(()=>b.inspect(403,{},'https://instacognito.com'),/DENIED/);
 await queued;await pause(140);
 assert.equal(c.allowed,1);assert.equal(c.aborted,1);assert.equal(b.data.requests,1);
 assert.throws(()=>b.assert(),e=>e.code==='PROVIDER_DENIED','a lapsed deadline must never downgrade a recorded denial');
 b.close();
 const later=openBudget(file,'after-deadline-denial');
 assert.throws(()=>later.reserve('discovery'),e=>e.code==='PROVIDER_DENIED');later.close();
});

test('connect and launch timeouts never outlast the remaining job budget',async t=>{
 const root=await tmp(t),seen=[];
 const stub=()=>({newContext:async()=>{throw new Error('probe: no context needed');},close:async()=>{}});
 const chromium={connectOverCDP:async(_,options)=>{seen.push(options.timeout);return stub();},launch:async options=>{seen.push(options.timeout);return stub();}};
 const base=name=>({handles:[{handle:'example',dateAfter:'2026-01-01'}],runId:name,output:path.join(root,name),requestLedger:path.join(root,name+'-ledger.json'),resultFile:path.join(root,name+'-result.json'),maxTimeMs:1000});
 assert.equal((await W.syncWindow({...base('attach'),attachCdp:'http://127.0.0.1:1'},{chromium})).status,'PARTIAL');
 assert.equal((await W.syncWindow(base('launch'),{chromium})).status,'PARTIAL');
 assert.equal(seen.length,2);
 for(const timeout of seen)assert.ok(Number.isInteger(timeout)&&timeout>0&&timeout<=1000,'browser timeout '+timeout+' must be clamped to the remaining 1000ms job budget');
});

test('legacy local ceilings become history before a session rollover overwrites them',async t=>{
 const p=path.join(await tmp(t),'budget.json');
 await fs.writeFile(p,JSON.stringify({version:1,session_id:'OLD-SESSION',requests:7,blocked:1,session_ceiling:120,hourly_ceiling:140,by_phase:{discovery:7},recent_request_ms:[Date.now()],denial:null,prior_sessions:[]}));
 const b=openBudget(p,'NEW-RUN',99);
 assert.deepEqual(b.data.previous_local_ceilings,{session:120,hour:140},'historical ceilings, not this caller’s cap');
 assert.equal(b.data.quota_policy,'public-provider-paced-v1');assert.equal(b.data.session_ceiling,99);assert.equal(b.data.hourly_ceiling,null);
 assert.equal(b.data.session_id,'NEW-RUN');assert.equal(b.data.requests,0);assert.equal(b.data.prior_sessions.at(-1).session_id,'OLD-SESSION');
 assert.throws(()=>b.inspect(403,{},'https://instacognito.com'),/DENIED/);b.close();
 const c=openBudget(p,'LATER-RUN',99);
 assert.deepEqual(c.data.previous_local_ceilings,{session:120,hour:140},'migrated history stays frozen across later runs');
 assert.throws(()=>c.reserve('discovery'),e=>e.code==='PROVIDER_DENIED');c.close();
});

test('releasing the ledger lock is idempotent, best-effort and reports a real cleanup failure',async t=>{
 const dir=await tmp(t),p=path.join(dir,'budget.json'),lock=p+'.window-lock';
 const b=openBudget(p,'gone-lock');b.reserve('discovery');
 await fs.unlink(lock);
 assert.doesNotThrow(()=>b.close(),'a vanished lock must not throw out of cleanup');
 assert.equal(b.cleanupError,null);assert.doesNotThrow(()=>b.close());
 assert.equal(JSON.parse(await fs.readFile(p)).requests,1);
 const c=openBudget(p,'blocked-unlink');await fs.unlink(lock);await fs.mkdir(lock);
 assert.doesNotThrow(()=>c.close(),'an unremovable lock must not throw out of cleanup either');
 assert.ok(c.cleanupError,'a non-ENOENT cleanup failure must stay visible');
 assert.equal(c.cleanupError.code,'LEDGER_CLEANUP_FAILED');
 await fs.rmdir(lock);
});

test('ledger lock cleanup never replaces the real run outcome',async t=>{
 const root=await tmp(t);
 const run=async(name,tamper)=>{
  const ledger=path.join(root,name+'-ledger.json');
  const chromium={launch:async()=>{await tamper(ledger+'.window-lock');throw new Error('probe launch failure');}};
  return W.syncWindow({handles:[{handle:'example',dateAfter:'2026-01-01'}],runId:name,output:path.join(root,name),requestLedger:ledger,resultFile:path.join(root,name+'-result.json'),maxTimeMs:1000},{chromium});
 };
 const gone=await run('gone',lock=>fs.unlink(lock));
 assert.equal(gone.status,'PARTIAL');assert.equal(gone.stoppedGlobally,true);assert.match(gone.error.message,/probe launch failure/);
 assert.equal(gone.requests.ledgerCleanupError,undefined);
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'gone-result.json'))).error.message,gone.error.message);
 const stuck=await run('stuck',async lock=>{await fs.unlink(lock);await fs.mkdir(lock);});
 assert.match(stuck.error.message,/probe launch failure/,'the real failure must still be the reported outcome');
 assert.equal(stuck.requests.ledgerCleanupError.code,'LEDGER_CLEANUP_FAILED','a genuine cleanup failure must be recorded in the result');
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'stuck-result.json'))).requests.ledgerCleanupError.code,'LEDGER_CLEANUP_FAILED');
 await fs.rmdir(path.join(root,'stuck-ledger.json.window-lock'));
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
 delete d.handles.example.coverage;await fs.writeFile(cfg.resultFile,JSON.stringify(d));await assert.rejects(W.combineWindowResults({...cfg,runId:'legacy',resultFile:path.join(root,'legacy.json')},[cfg.resultFile]),/known-post evidence/);
 d.handles.example.coverage=combined.handles.example.coverage;d.handles.example.observations[0].shortcode='OTHER';await fs.writeFile(cfg.resultFile,JSON.stringify(d));await assert.rejects(W.combineWindowResults({...cfg,runId:'missing',resultFile:path.join(root,'missing.json')},[cfg.resultFile]),/witness observation\/receipt mismatch/);
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

// ---------------------------------------------------------------------------
// Typed-failure contract for job configuration, per-handle scope and date policy.
// Every rejection a caller can provoke must carry an ArchiveError code, because
// scheduled integrations branch on `code`, and an untyped platform error is also
// invisible to the handle-local/global isolation classifier.
const validJob=()=>({handles:[{handle:'example',dateAfter:'2026-01-01'}],runId:'typed-args',output:'/tmp/ff-typed-out',resultFile:'/tmp/ff-typed-out/result.json',requestLedger:'/tmp/ff-typed-out/ledger.json'});
const failure=fn=>{try{fn();return null;}catch(e){return e;}};
test('validate() reports every unusable job field as a typed ArchiveError, never a platform error',()=>{
 assert.equal(W.validate(validJob()).maxCards,1000);
 assert.equal(W.validate({...validJob(),timeZone:'Europe/Amsterdam'}).timeZone,'Europe/Amsterdam');
 assert.equal(W.validate({...validJob(),attachCdp:'http://127.0.0.1:1'}).attachCdp,'http://127.0.0.1:1');
 const rows=[
  ['out-of-range dateAfter','BAD_ARGS',{handles:[{handle:'example',dateAfter:'9999-99-99'}]}],
  ['rolled-over dateAfter','BAD_ARGS',{handles:[{handle:'example',dateAfter:'2026-02-31'}]}],
  ['unparseable dateAfter','BAD_ARGS',{handles:[{handle:'example',dateAfter:'nope'}]}],
  ['null handle entry','BAD_ARGS',{handles:[null]}],
  ['bare string handle entry','BAD_ARGS',{handles:['example']}],
  ['array handle entry','BAD_ARGS',{handles:[['example']]}],
  ['non-url attachCdp','BAD_CDP',{attachCdp:'not-a-url'}],
  ['numeric attachCdp','BAD_CDP',{attachCdp:7}],
  ['off-loopback attachCdp','BAD_CDP',{attachCdp:'http://192.168.1.2:9222'}],
  ['unknown timeZone','BAD_ARGS',{timeZone:'Mars/Olympus'}],
  ['numeric timeZone','BAD_ARGS',{timeZone:5}],
  ['numeric output','BAD_ARGS',{output:7}],
  ['empty output','BAD_ARGS',{output:''}],
  ['missing output','BAD_ARGS',{output:undefined}],
  ['object resultFile','BAD_ARGS',{resultFile:{}}],
  ['empty resultFile','BAD_ARGS',{resultFile:''}],
  ['missing resultFile','BAD_ARGS',{resultFile:undefined}],
  ['numeric requestLedger','BAD_ARGS',{requestLedger:7}],
  ['missing requestLedger','BAD_ARGS',{requestLedger:undefined}],
  ['non-object config','BAD_ARGS',null]
 ];
 for(const [label,code,patch] of rows){
  const e=failure(()=>W.validate(patch===null?null:{...validJob(),...patch}));
  assert.ok(e,label+' was accepted with no rejection');
  assert.ok(e instanceof F.ArchiveError,label+' threw an untyped '+e.name+' (code '+e.code+'): '+e.message);
  assert.equal(e.code,code,label+' -> '+e.code+': '+e.message);
 }
});
test('absolute calendar dates keep zone-independent day bounds west of UTC and far east',()=>{
 for(const timeZone of ['America/Los_Angeles','Pacific/Kiritimati','Europe/Amsterdam','UTC']){
  const e=estimateDate('1 January 2026','2026-09-17T12:00:00Z',timeZone);
  assert.deepEqual([e.day,e.dayLo,e.dayHi,e.precision],['2026-01-01','2026-01-01','2026-01-01','day'],timeZone);
 }
});
test('per-handle specs cannot carry job-wide policy, resource or transport fields',()=>{
 const patches=[{allowEstimatedDates:true},{timeZone:'UTC'},{maxBytes:1},{maxFileBytes:1},{maxCards:1},{maxTimeMs:1000},{maxRequests:1},{attachCdp:'http://127.0.0.1:1'},{browserExecutable:'/usr/bin/chromium'},{output:'/tmp/ff-other'},{resultFile:'/tmp/ff-other/result.json'},{requestLedger:'/tmp/ff-other/ledger.json'},{runId:'other'},{dateafter:'2026-01-01'},{allowEstimatedDates:true,timeZone:'UTC',maxBytes:1}];
 for(const patch of patches){
  const e=failure(()=>W.validate({...validJob(),handles:[{handle:'example',dateAfter:'2026-01-01',...patch}]}));
  assert.ok(e,'per-handle '+Object.keys(patch).join(',')+' was accepted');
  assert.ok(e instanceof F.ArchiveError&&e.code==='BAD_ARGS','per-handle '+Object.keys(patch).join(',')+' -> '+e.name+' '+e.code+': '+e.message);
  for(const key of Object.keys(patch))assert.match(e.message,new RegExp(key));
 }
 const ok=W.validate({...validJob(),handles:[{handle:'example',dateAfter:'2026-09-08',expectedPosts:[witness()],accessRequired:'authenticated-view',eligibility:'caller-selected'}]});
 assert.equal(ok.handles[0].eligibility,'caller-selected');
});
test('unparseable source dates are typed DATE_POLICY at both consuming seams',()=>{
 for(const label of ['999999999999999 days ago','31 February 2026','gibberish','13 Fakemonth 2026']){
  const e=failure(()=>W.select([raw('POST',label)],'2026-09-13T01:00:00Z',{dateAfter:'2026-09-12',allowEstimatedDates:true}));
  assert.ok(e,'select accepted '+label);
  assert.ok(e instanceof F.ArchiveError,'select threw an untyped '+e.name+' (code '+e.code+') for '+label+': '+e.message);
  assert.equal(e.code,'DATE_POLICY',label+' -> '+e.code);
 }
 const at='2026-09-13T00:00:00Z',id='posts__'+'a'.repeat(64),spec={handle:'example',dateAfter:'2026-09-08'},date={raw:'gibberish',iso:at,day:'2026-09-12',dayLo:'2026-09-12',dayHi:'2026-09-12',basis:'absolute_year',precision:'day',observedAt:at,timeZone:'UTC'};
 const h={status:'COMPLETE',scope:'current-visible-posts',dateAfter:spec.dateAfter,observedAt:at,observedCards:1,selectedCards:1,observations:[{stableId:id,shortcode:'KNOWN',category:'posts',selected:true,date}],files:[{stableId:id,shortcode:'KNOWN',profileHandle:'example',date}]};
 const e=failure(()=>W.validateWitnessWindow(spec,h,{timeZone:'UTC',allowEstimatedDates:true}));
 assert.ok(e,'validateWitnessWindow accepted an unparseable witness date');
 assert.ok(e instanceof F.ArchiveError,'validateWitnessWindow threw an untyped '+e.name+' (code '+e.code+'): '+e.message);
 assert.equal(e.code,'DATE_POLICY');
});
test('job-wide timezone and estimate policy govern selection; no per-handle override exists',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t),old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});globalThis.fetch=async()=>new Response(jpg,{headers:{'content-type':'image/jpeg'}});
 const cfg={handles:[{handle:'example',dateAfter:'2020-01-01'}],runId:'job-wide',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'far-east.json'),timeZone:'Pacific/Kiritimati',allowEstimatedDates:true};
 const d=await W.syncWindow(cfg,fixture);
 assert.equal(d.status,'COMPLETE',JSON.stringify(d));assert.equal(d.handles.example.observations[0].date.timeZone,'Pacific/Kiritimati');
 const strict=await W.syncWindow({...cfg,runId:'job-wide-strict',resultFile:path.join(root,'strict.json'),allowEstimatedDates:undefined},fixture);
 assert.equal(strict.stoppedGlobally,false,JSON.stringify(strict));assert.equal(strict.handles.example.error.code,'DATE_POLICY');assert.equal(strict.handles.example.error.scope,'handle');
});
test('a global stop leaves never-attempted handles as schema-consistent NOT_COMPLETED stubs',async t=>{
 const root=await tmp(t),fixture=await browserFixture(t,[200,403,200]);
 const cfg={handles:[{handle:'alpha',dateAfter:'2099-01-01'},{handle:'middle',dateAfter:'2026-01-01'},{handle:'zulu',dateAfter:'2098-12-31'}],runId:'stub-schema',output:path.join(root,'out'),requestLedger:path.join(root,'budget.json'),resultFile:path.join(root,'result.json'),allowEstimatedDates:true,maxTimeMs:6000};
 const d=await W.syncWindow(cfg,fixture);
 assert.equal(d.stoppedGlobally,true,JSON.stringify(d));assert.equal(d.handles.alpha.status,'COMPLETE');
 assert.equal(d.error.scope,'global');assert.equal(d.handles.middle.error.scope,'global');
 assert.deepEqual(d.handles.zulu,{status:'NOT_COMPLETED',failed:true,scope:'current-visible-posts',dateAfter:'2098-12-31',files:[]});
 for(const [handle,h] of Object.entries(d.handles)){
  assert.equal(h.scope,'current-visible-posts',handle+' lost the requested scope');
  assert.equal(h.dateAfter,{alpha:'2099-01-01',middle:'2026-01-01',zulu:'2098-12-31'}[handle],handle+' lost the requested dateAfter');
 }
 assert.deepEqual(JSON.parse(await fs.readFile(cfg.resultFile)),d);
});

// ---------------------------------------------------------------------------
// Wave 4. Two gates that were weaker than the evidence they claimed to check:
// cache reuse trusted bytes+filename without any identity field, and composition
// verified a result part's own file entry against itself instead of against the
// immutable receipt on disk.
const strictItem=(shortcode='POST',href='https://instacognito.com/media?id=POST')=>{
 const item={category:'posts',shortcode,carouselIndex:0,mediaType:'image',href,providerMediaFingerprint:F.providerMediaFingerprint(href)};
 item.stableId=F.stableMediaId(item);return item;
};
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
// A complete, internally consistent acquisition: canonical media file plus the
// receipt downloadOne would have written for it.
async function receiptFixture(t,handle='example'){
 const root=await tmp(t),output=path.join(root,'out'),paths=F.profilePaths(output,handle),item=strictItem();
 await fs.mkdir(paths.mediaDir,{recursive:true});await fs.mkdir(paths.receiptDir,{recursive:true});
 await fs.writeFile(path.join(paths.mediaDir,item.stableId+'.jpg'),jpg);
 const receipt={stableId:item.stableId,id:item.stableId,category:'posts',mediaType:'image',shortcode:item.shortcode,carouselIndex:0,
  identityBasis:'provider-media-fingerprint-v1',providerMediaFingerprint:item.providerMediaFingerprint,discoveryId:item.stableId,
  profileHandle:handle,path:path.relative(output,path.join(paths.mediaDir,item.stableId+'.jpg')),bytes:jpg.length,sha256:sha256(jpg),
  sourceHost:'instacognito.com',runId:'earlier'};
 const write=async r=>fs.writeFile(path.join(paths.receiptDir,item.stableId+'.json'),JSON.stringify(r));
 await write(receipt);
 return {root,output,paths,item,receipt,write,handle};
}
const noFetchBudget=()=>({assert(){},fetch:async()=>{throw new Error('must not fetch');}});
const reuseSelection=(f,item=f.item)=>{
 const totals={downloaded:0,reused:0,bytes:0};
 return W.acquireSelection([{item,date:{},selected:true}],f.paths,f.handle,'run',noFetchBudget(),
  {maxBytes:4096,maxFileBytes:4096,deadline:Date.now()+2000,dnsLookup:async()=>[{address:'93.184.216.34',family:4}]},totals)
  .then(out=>({out,totals}));
};
test('cache reuse rejects corrupt receipt metadata even with unchanged hash and filename',async t=>{
 const f=await receiptFixture(t);
 const clean=await reuseSelection(f);
 assert.equal(clean.totals.reused,1,'a coherent receipt must still be reused without a request');
 assert.equal(clean.out[0].stableId,f.item.stableId);
 // Every corruption below keeps the bytes, the sha256, the byte count, the
 // canonical filename and the stableId untouched: only receipt metadata lies.
 const corruptions=[
  ['contradicting shortcode',{shortcode:'OTHER'}],
  ['absent shortcode',{shortcode:null}],
  ['wrong category',{category:'reels'}],
  ['another handle',{profileHandle:'someone-else'}],
  ['media type contradicting the card',{mediaType:'video'}],
  ['rotated locator fingerprint',{providerMediaFingerprint:'0'.repeat(64)}]
 ];
 for(const [label,patch] of corruptions){
  await f.write({...f.receipt,...patch});
  await assert.rejects(reuseSelection(f),/must not fetch/,label+' was reused from cache instead of re-acquired');
 }
 // Byte proof alone is never identity, but it is still required.
 await f.write(f.receipt);await fs.writeFile(path.join(f.paths.mediaDir,f.item.stableId+'.jpg'),Buffer.concat([jpg,jpg]));
 await assert.rejects(reuseSelection(f),/must not fetch/,'altered bytes must still force re-acquisition');
 // An unreadable stored receipt is a typed refusal taken before any request, not a
 // platform error raised after a download has already been spent.
 await fs.writeFile(path.join(f.paths.receiptDir,f.item.stableId+'.json'),'{corrupt');
 const unreadable=await reuseSelection(f).then(()=>null,e=>e);
 assert.ok(unreadable instanceof F.ArchiveError&&unreadable.code==='BAD_RECEIPT','a malformed receipt file must refuse before acquisition, got: '+unreadable);
});

const compositionPart=(output,handle,at,observations,files,runId='source')=>({schemaVersion:1,kind:'frameferry-sync-window',runId,scope:'current-visible-posts',fullHistoryComplete:false,output,status:'COMPLETE',requests:{denial:null},handles:{[handle]:completeWindow({handle,dateAfter:'2026-01-01'},at,observations,files)}});
const compositionFile=(f,receipt,date)=>({stableId:receipt.stableId,shortcode:receipt.shortcode,mediaType:receipt.mediaType,path:receipt.path,bytes:receipt.bytes,sha256:receipt.sha256,profileHandle:receipt.profileHandle,sourceHost:receipt.sourceHost,date,receiptRunId:receipt.runId,reused:true});
const compositionObs=receipt=>({stableId:receipt.stableId,shortcode:receipt.shortcode,category:'posts',mediaType:receipt.mediaType});
async function compose(f,part,runId){
 const file=path.join(f.root,runId+'-part.json');await fs.writeFile(file,typeof part==='string'?part:JSON.stringify(part));
 return W.combineWindowResults({handles:[{handle:f.handle,dateAfter:'2026-01-01'}],runId,output:f.output,resultFile:path.join(f.root,runId+'-result.json'),requestLedger:path.join(f.root,'unused.json')},[file]);
}
test('composition binds every projected file to the immutable on-disk receipt',async t=>{
 const f=await receiptFixture(t),at=new Date().toISOString(),date=estimateDate('1 January 2026',at,'UTC');
 const good=await compose(f,compositionPart(f.output,f.handle,at,[{...compositionObs(f.receipt),date,selected:true}],[compositionFile(f,f.receipt,date)]),'bound');
 assert.equal(good.status,'COMPLETE',JSON.stringify(good));
 assert.equal(good.composition.additionalProviderRequests,0);
 assert.equal(good.handles[f.handle].sourceRunId,'source');
 // Bytes that merely exist under the media root are not a receipt. This entry is
 // canonical, hashes correctly and has no receipt on disk at all.
 const orphan='posts__'+'b'.repeat(64);
 await fs.writeFile(path.join(f.paths.mediaDir,orphan+'.jpg'),jpg);
 const forged={...f.receipt,stableId:orphan,id:orphan,path:path.relative(f.output,path.join(f.paths.mediaDir,orphan+'.jpg'))};
 await assert.rejects(compose(f,compositionPart(f.output,f.handle,at,[{...compositionObs(forged),date,selected:true}],[compositionFile(f,forged,date)]),'orphan'),
  e=>e instanceof F.ArchiveError&&e.code==='BAD_RECEIPT','a file entry with no on-disk receipt must never compose');
 // A receipt that does exist still governs every field the part reprojects.
 for(const patch of [{mediaType:'video'},{receiptRunId:'forged-run'},{sourceHost:'example.org'},{shortcode:'OTHER'},{bytes:jpg.length+1}]){
  const entry={...compositionFile(f,f.receipt,date),...patch};
  const obs={...compositionObs(f.receipt),date,selected:true,shortcode:entry.shortcode,mediaType:entry.mediaType};
  await assert.rejects(compose(f,compositionPart(f.output,f.handle,at,[obs],[entry]),'contradiction-'+Object.keys(patch)[0]),
   e=>e instanceof F.ArchiveError&&e.code==='BAD_RECEIPT',Object.keys(patch)[0]+' contradicting the on-disk receipt was composed anyway');
 }
});
test('composition requires a safe, schema-shaped source run ID and typed failures for malformed parts',async t=>{
 const f=await receiptFixture(t),at=new Date().toISOString(),date=estimateDate('1 January 2026',at,'UTC');
 const part=runId=>compositionPart(f.output,f.handle,at,[{...compositionObs(f.receipt),date,selected:true}],[compositionFile(f,f.receipt,date)],runId);
 for(const runId of ['../../etc/passwd','has space','',undefined,null,7,'x'.repeat(151)]){
  const doc=part(runId);if(runId===undefined)delete doc.runId;
  await assert.rejects(compose(f,doc,'runid-'+String(runId).slice(0,12).replace(/[^A-Za-z0-9]/g,'_')),
   e=>e instanceof F.ArchiveError&&e.code==='BAD_RESULT','unsafe source runId '+JSON.stringify(runId)+' was projected into the composed result');
 }
 const badOutput=part('source');badOutput.output=7;
 await assert.rejects(compose(f,badOutput,'bad-output'),e=>e instanceof F.ArchiveError&&e.code==='BAD_RESULT');
 for(const [label,body] of [['truncated','{"kind":"frameferry-sync-window"'],['not json','not json at all'],['bare array','[]'],['null','null']]){
  const e=await compose(f,body,'malformed-'+label.replace(/ /g,'-')).then(()=>null,x=>x);
  assert.ok(e,label+' part was accepted');
  assert.ok(e instanceof F.ArchiveError,label+' part threw an untyped '+e.name+': '+e.message);
  assert.equal(e.code,'BAD_RESULT',label+' -> '+e.code);
 }
 const absent=await W.combineWindowResults({handles:[{handle:f.handle,dateAfter:'2026-01-01'}],runId:'absent',output:f.output,resultFile:path.join(f.root,'absent.json'),requestLedger:path.join(f.root,'unused.json')},[path.join(f.root,'no-such-part.json')]).then(()=>null,x=>x);
 assert.ok(absent instanceof F.ArchiveError&&absent.code==='BAD_RESULT','an unreadable part must be a typed failure, not a platform error');
});
test('a witness observed after the window is not evidence about that window',async t=>{
 const at=new Date(Date.now()-60000).toISOString(),spec=w=>({handle:'example',dateAfter:'2026-09-08',expectedPosts:[w]});
 const base={shortcode:'KNOWN',category:'posts',minDayHi:'2026-09-12',source:'owner-direct-observation'};
 const date=estimateDate('13 September 2026',at,'UTC'),id='posts__'+'a'.repeat(64);
 const window=w=>{
  const h={status:'COMPLETE',scope:'current-visible-posts',dateAfter:'2026-09-08',observedAt:at,observedCards:1,selectedCards:1,
   observations:[{stableId:id,shortcode:'KNOWN',category:'posts',mediaType:'image',selected:true,date}],
   files:[{stableId:id,shortcode:'KNOWN',profileHandle:'example',date}]};
  h.coverage=W.witnessCoverage(spec(w),h.observations);return h;
 };
 const sameInstant={...base,sourceObservedAt:at};
 assert.equal(W.validateWitnessWindow(spec(sameInstant),window(sameInstant),{timeZone:'UTC'}).satisfied,true,'a witness observed with the window is still evidence');
 const earlier={...base,sourceObservedAt:new Date(Date.now()-120000).toISOString()};
 assert.equal(W.validateWitnessWindow(spec(earlier),window(earlier),{timeZone:'UTC'}).satisfied,true);
 const later={...base,sourceObservedAt:new Date().toISOString()};
 assert.throws(()=>W.validateWitnessWindow(spec(later),window(later),{timeZone:'UTC'}),
  e=>e instanceof F.ArchiveError&&/observed after the window/.test(e.message),'a witness recorded after the observation was accepted as evidence about it');
 assert.throws(()=>W.witnessCoverage(spec(later),window(later).observations,at),e=>/observed after the window/.test(e.message));
 assert.equal(W.witnessCoverage(spec(later),window(later).observations).satisfied,true,'an unbounded coverage check stays unchanged');
 assert.equal(W.validateExpectedPosts(spec(later)).length,1,'config-time validation keeps its existing contract');
});

// Item 3: the "denial recorded while an admission is queued AND the deadline
// lapses during the pacing wait" race. pause() rejects with the deadline reason
// before admit()'s post-wait assert() can report the stronger denial.
test('a denial recorded while an admission waits out pacing survives a lapsed deadline',async t=>{
 const p=path.join(await tmp(t),'budget.json'),b=openBudget(p,'denial-race'),ac=new AbortController();
 await b.admit('discovery');
 const queued=b.admit('download',ac.signal);
 await new Promise(resolve=>setTimeout(resolve,25));
 assert.throws(()=>b.inspect(403,{},'https://instacognito.com'),e=>e.code==='PROVIDER_DENIED');
 ac.abort(new F.ArchiveError('TIME_LIMIT','incremental job deadline reached'));
 // The queued caller is told the deadline lapsed, not that a denial was recorded:
 // pause() rejects with the abort reason before admit()'s post-wait assert() can
 // report the stronger stop. That ordering is cosmetic. installGuards discards this
 // code entirely (route.abort('blockedbyclient')), and every seam that publishes an
 // outcome re-derives the denial: the handle catch re-asserts the budget and
 // result.status comes from budget.data.denial. The invariants below are what a run
 // actually keeps, and they are what must never regress.
 await assert.rejects(queued,e=>e.code==='TIME_LIMIT');
 assert.equal(b.data.requests,1,'the queued admission must not be reserved');
 assert.ok(b.data.denial,'the denial must be recorded');
 assert.throws(()=>b.assert(),e=>e.code==='PROVIDER_DENIED','a lapsed deadline must not downgrade the denial');
 b.close();
 assert.ok(JSON.parse(await fs.readFile(p)).denial,'the denial must stay on the persisted ledger');
 const later=openBudget(p,'after-denial-race');assert.throws(()=>later.reserve('discovery'),e=>e.code==='PROVIDER_DENIED');later.close();
});
test('a recorded denial publishes BLOCKED from the ledger, not from the escaping error code',async t=>{
 const root=await tmp(t),ledger=path.join(root,'ledger.json');
 await fs.writeFile(ledger,JSON.stringify({version:1,session_id:'earlier',requests:3,blocked:0,session_ceiling:null,by_phase:{discovery:3},recent_request_ms:[Date.now()],denial:{id:'abc123',kind:'DENIED_AUTH',status:403,at:new Date().toISOString(),session_id:'earlier'},prior_sessions:[]}));
 let launches=0;const deps={chromium:{launch:async()=>{launches++;throw new Error('must not launch');}}};
 const d=await W.syncWindow({handles:[{handle:'example',dateAfter:'2026-01-01'}],runId:'denied-carryover',output:path.join(root,'out'),requestLedger:ledger,resultFile:path.join(root,'result.json'),maxTimeMs:2000},deps);
 assert.equal(d.status,'BLOCKED',JSON.stringify(d));assert.equal(d.stoppedGlobally,true);assert.equal(d.error.code,'PROVIDER_DENIED');
 assert.equal(d.requests.denial.id,'abc123');assert.equal(launches,0);assert.equal(d.handles.example.status,'NOT_COMPLETED');
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'result.json'))).requests.denial.id,'abc123');
});

// Item 4: fail() latched unconditionally, so any later lesser stop silently
// downgraded PROVIDER_DENIED for the rest of the run.
test('a later lesser stop can never downgrade a recorded provider denial',async t=>{
 const p=path.join(await tmp(t),'budget.json'),b=openBudget(p,'precedence');
 assert.throws(()=>b.inspect(403,{},'https://instacognito.com'),e=>e.code==='PROVIDER_DENIED');
 assert.equal(b.fail('TIME_LIMIT','incremental job deadline reached').code,'PROVIDER_DENIED','fail() must hand back the denial-derived stop');
 assert.throws(()=>b.assert(),e=>e.code==='PROVIDER_DENIED');
 assert.throws(()=>b.reserve('download'),e=>e.code==='PROVIDER_DENIED');
 b.close();
 const c=openBudget(p,'later-session');
 assert.equal(c.fail('DISCOVERY_TRANSPORT','provider discovery HTTP failure').code,'PROVIDER_DENIED','a denial carried in from the ledger outranks a fresh lesser stop');
 assert.throws(()=>c.assert(),e=>e.code==='PROVIDER_DENIED');c.close();
});
test('a transport failure after a denial keeps PROVIDER_DENIED on the discovery guard',async t=>{
 const p=path.join(await tmp(t),'budget.json'),b=openBudget(p,'guard-precedence');
 let onResponse=null;const page={route:async()=>{},on:(event,handler)=>{if(event==='response')onResponse=handler;}};
 await W.installGuards(page,b,Date.now()+5000);
 const response=status=>({url:()=>F.PROVIDER_ORIGIN+'/api/posts',status:()=>status,headers:()=>({})});
 onResponse(response(403));
 onResponse(response(500));
 assert.throws(()=>b.assert(),e=>e.code==='PROVIDER_DENIED','a later 5xx must not downgrade the recorded denial');
 assert.ok(b.data.denial);b.close();
});
