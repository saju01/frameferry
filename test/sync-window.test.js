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
  const html='<input id="search-input"><button id="download-btn" onclick="show()">Search</button><div id="profile-section"></div><div id="post-container"></div><script>function show(){document.getElementById("profile-section").innerHTML=\'<span class="username-text">@example</span> 1 posts\';document.getElementById("post-container").innerHTML=\'<div class="post-card"><img class="post-image" data-type="image" src="/media?id=POST"><a class="content-download-btn" href="/media?id=POST"></a><span data-id="POST"></span><div class="post-footer"><span class="icon-group"><span>8 hours ago</span></span></div></div>\';}</script>';
  const delayed = profileDelay ? html.replace('document.getElementById("profile-section").innerHTML=', 'setTimeout(()=>document.getElementById("profile-section").innerHTML=').replace(" 1 posts\';document.getElementById", " 1 posts\',"+profileDelay+");document.getElementById") : html;
  await route.fulfill({status,contentType:'text/html',body:delayed});
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
