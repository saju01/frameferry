'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lib = require('../src/index.js');
const d = lib.discovery;
const card = (post, media, version = '1') => ({ shortcode: post, mediaType: 'image', href: 'https://instacognito.com/media?id=' + media + '&fixture=' + version });
const jpg = Buffer.from([255,216,255,224,1,2,3,4,255,217]);
const response = () => ({ ok: true, status: 200, headers: { get: k => k === 'content-length' ? String(jpg.length) : 'image/jpeg' }, body: new ReadableStream({ start(c) { c.enqueue(jpg); c.close(); } }) });
const root = () => fsp.mkdtemp(path.join(os.tmpdir(), 'ff-direct-'));
const archive = (output, items, extra = {}) => lib.archiveProfile({ output, items, handle: 'example', reportedTotal: 1, delayMs: 0, dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }], fetchImpl: async () => response(), ...extra });

test('fingerprint ID is independent of reversed, partial, disjoint carousel windows and metadata', () => {
  const full = lib.normalizeItems([card('A','a'),card('A','b'),card('A','c')]).items;
  for (const raws of [[card('A','c'),card('A','a')], [card('A','b')], [{...card('A','c','fresh'),dateRaw:'changed',caption:'changed'}]]) {
    for (const item of lib.normalizeItems(raws).items) assert.equal(item.stableId, full.find(i => i.providerMediaFingerprint === item.providerMediaFingerprint).stableId);
  }
  assert.notEqual(lib.normalizeItems([card('A','a')], {category:'posts'}).items[0].stableId, lib.normalizeItems([card('A','a')], {category:'reels'}).items[0].stableId);
});

test('unsupported and malformed media locators never become provider fingerprints', () => {
  for (const href of ['junk', 'https://foreign.test/media?id=a', 'http://instacognito.com/media?id=a', 'https://instacognito.com/media', 'https://instacognito.com/media?id=', 'https://instacognito.com/media?id=a&id=b', 'https://instacognito.com/media?id=%00', 'https://instacognito.com/media?id=a%20b', 'https://instacognito.com/media/?id=a', 'https://user@instacognito.com/media?id=a']) assert.equal(lib.providerMediaFingerprint(href), null, href);
  assert.match(lib.providerMediaFingerprint(card('A','a').href), /^[0-9a-f]{64}$/);
});

test('legacy alias uses matching fingerprint and verified bytes without changing canonical files', async () => {
  const output = await root(); await archive(output,[card('A','a')]);
  const paths = lib.profilePaths(output,'example'); const m = await lib.readJson(paths.manifest); const [modern,receipt] = Object.entries(m.completed)[0];
  const legacy = {...receipt,stableId:'A-0',id:'A-0',path:'media/example/A-0.jpg'};
  await fsp.rename(path.join(output,receipt.path),path.join(output,legacy.path));
  await fsp.unlink(path.join(paths.receiptDir,modern+'.json')); await lib.atomicWriteJson(path.join(paths.receiptDir,'A-0.json'),legacy);
  m.completed = {'A-0':legacy}; await lib.atomicWriteJson(paths.manifest,m);
  const beforeReceipt = await fsp.readFile(path.join(paths.receiptDir,'A-0.json'));
  const beforeBytes = await fsp.readFile(path.join(output,legacy.path));
  let fetches=0; await archive(output,[card('A','a','fresh')],{fetchImpl:async()=>{fetches++;throw Error('must reuse');}});
  const after = await lib.readJson(paths.manifest);
  assert.equal(fetches,0); assert.deepEqual(Object.keys(after.completed),['A-0']);
  assert.equal(after.identityAliases[modern].canonicalId,'A-0');
  assert.deepEqual(await fsp.readFile(path.join(paths.receiptDir,'A-0.json')),beforeReceipt);
  assert.deepEqual(await fsp.readFile(path.join(output,legacy.path)),beforeBytes);
});

test('legacy index-only pending record stays held and never consumes an unrelated slide', async () => {
  const output=await root();const paths=lib.profilePaths(output,'example');
  await lib.atomicWriteJson(paths.manifest,{handle:'example',completed:{},pending:{'A-0':{stableId:'A-0',shortcode:'A',category:'posts',error:'awaiting rediscovery'}},failed:{},runs:[]});
  let calls=0; const status=await archive(output,[card('A','unknown')],{fetchImpl:async()=>{calls++;return response();}});
  const m=await lib.readJson(paths.manifest);assert.equal(calls,0);assert.ok(m.pending['A-0']);assert.equal(Object.keys(m.completed).length,0);assert.equal(status.status,'PARTIAL');
});

test('pending and failed records retain sanitized fingerprint and latest metadata provenance', async () => {
  const output=await root();const raw={...card('A','a','fresh'),dateRaw:'2 January 2026'};
  await archive(output,[raw],{acquisitionMaxTimeMs:0});const m=await lib.readJson(lib.profilePaths(output,'example').manifest);const item=Object.values(m.pending)[0];
  assert.equal(item.providerMediaFingerprint,lib.providerMediaFingerprint(raw.href));assert.equal(item.metadataProvenance.dateRaw,raw.dateRaw);assert.equal(JSON.stringify(m).includes('media?id='),false);
});

test('CLI/API options reject fractional, negative, infinite and incompatible budgets', () => {
  for(const key of ['maxPages','maxTimeMs','slicePages','sliceTimeMs','checkpointEveryItems','maxAcquireItems','discoveryMaxTimeMs','acquisitionMaxTimeMs']) {
    for(const value of [-1,0.5,Infinity,NaN]) assert.throws(()=>d.validateOptions({[key]:value}),{code:'BAD_ARGS'});
  }
  assert.throws(()=>d.validateOptions({maxTimeMs:1000,discoveryMaxTimeMs:1001}),{code:'BAD_ARGS'});
  assert.equal(d.validateOptions({acquisitionMaxTimeMs:0}).acquisitionMaxTimeMs,0);
});

test('append-only discovery checkpoints survive process kill and reject insufficient replay budget', async () => {
  const output=await root();const file=path.join(output,'discovery.jsonl');
  const childCode = 'const lib=require('+JSON.stringify(path.resolve(__dirname,'../src/index.js'))+');(async()=>{const l=await lib.discovery.openLedger(process.argv[1],{handle:"example",runId:"crash",runtime:{}});await l.checkpoint({items:lib.normalizeItems([{shortcode:"AFTER20",href:"https://instacognito.com/media?id=deep"}]).items,frontier:{category:"posts",pages:23,elapsedMs:5000},stopCause:"slice-boundary"});process.stdout.write("CHECKPOINT");setInterval(()=>{},1000);})();';
  const child=spawn(process.execPath,['-e',childCode,file],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(Error('child exited '+code)));});
  child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));
  await fsp.appendFile(file,'{"torn":');
  const ledger=await d.openLedger(file,{handle:'example',runId:'recovery',runtime:{}});
  assert.equal(ledger.observed.size,1);assert.equal(ledger.frontier.posts.pages,23);
  assert.throws(()=>d.replayRequirement(ledger.frontier,d.validateOptions({maxPages:12})),{code:'REPLAY_BUDGET'});
  assert.doesNotThrow(()=>d.replayRequirement(ledger.frontier,d.validateOptions({maxPages:30})));
  await ledger.close('test-finished');const text=await fsp.readFile(file,'utf8');assert.equal(text.includes('media?id='),false);assert.ok(text.includes('recoveredTail'));
});

async function browserFixture(t) {
  const {chromium}=require('playwright');const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath();
  assert.ok(fs.existsSync(executablePath),'required real DOM browser must exist; no skips');
  const browser=await chromium.launch({headless:true,executablePath});t.after(()=>browser.close());
  const page=await browser.newPage();return page;
}
function htmlCard(post,media) {return '<article class="post-card"><span class="likes-trigger" data-id="'+post+'"></span><a class="content-download-btn" href="https://instacognito.com/media?id='+media+'">d</a></article>';}

test('real DOM constant-size rapid generations preserve removed subtrees and newest locator',async t=>{
  const page=await browserFixture(t);await page.setContent('<div id="post-container">'+htmlCard('A','one')+'</div>');
  await d.installCapture(page);
  await page.evaluate(html=>{const c=document.getElementById('post-container');c.innerHTML=html[0];c.innerHTML=html[1];c.innerHTML=html[2];},[htmlCard('A','two'),htmlCard('A','three'),htmlCard('A','four')]);
  const captured=await d.drainCapture(page);const items=lib.normalizeItems(captured.batches.flatMap(b=>b.cards)).items;
  for(const media of ['one','two','three','four'])assert.ok(items.some(i=>i.providerMediaFingerprint===lib.providerMediaFingerprint(card('A',media).href)));
  assert.equal(captured.gap,null);assert.ok(captured.batches.length<=64);
});

test('real DOM generation overflow fails explicitly rather than claiming complete retention',async t=>{
  const page=await browserFixture(t);await page.setContent('<div id="post-container">'+htmlCard('A','a')+'</div>');await d.installCapture(page);
  await page.evaluate(async html=>{for(let i=0;i<70;i++){document.getElementById('post-container').innerHTML=html;await Promise.resolve();}},htmlCard('A','b'));
  const captured=await d.drainCapture(page);assert.equal(captured.gap,'generation-buffer-overflow');assert.ok(captured.batches.length<=64);
});

test('delayed category tab replacement never labels old posts as reels',async t=>{
  const page=await browserFixture(t);await page.setContent('<div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">posts</button><button class="menu-item" data-id="REELS">reels</button></div><div id="post-container">'+htmlCard('OLDPOST','a')+'</div>');
  await page.evaluate(html=>{document.querySelector('[data-id="REELS"]').onclick=()=>{document.querySelector('[data-id="POSTS"]').classList.remove('active');document.querySelector('[data-id="REELS"]').classList.add('active');setTimeout(()=>document.getElementById('post-container').innerHTML=html,700);};},htmlCard('REEL','r'));
  const started=Date.now();await lib.switchToCategoryTab(page,'reels',2500);const ready=await lib.waitForSectionReady(page,'reels',started,2500);
  assert.equal(ready.kind,'cards');assert.ok(Date.now()-started>=600);const got=await lib.extractItemsFromPage(page,{category:'reels'});assert.equal(got.items[0].shortcode,'REEL');
});

test('30-page real DOM traversal reaches after page20 across bounded slices on one session',async t=>{
  const page=await browserFixture(t);await page.setContent('<div id="post-container">'+htmlCard('P1','m1')+'</div>');
  await page.evaluate(()=>{window.fixturePage=1;window.triggers=0;Element.prototype.scrollIntoView=function(){if(window.fixturePage>=30)return;window.triggers++;const p=++window.fixturePage;document.getElementById('post-container').innerHTML='<article class="post-card"><span data-id="P'+p+'"></span><a class="content-download-btn" href="https://instacognito.com/media?id=m'+p+'">d</a></article>';};});
  const output=await root();const ledger=await d.openLedger(path.join(output,'ledger.jsonl'),{handle:'example',runId:'deep',runtime:{}});t.after(()=>ledger.close('test-finished'));
  const slices=[];const started=Date.now();const result=await lib.scrapeCardSection(page,{category:'posts',mediaTypes:['image','video'],reportedTotal:30,started,maxTimeMs:60000,maxPages:35,slicePages:5,sliceTimeMs:5000,resumeTargets:new Set([lib.normalizeItems([card('P25','m25')]).items[0].stableId]),onDiscoveryBatch:async batch=>{await ledger.checkpoint(batch);slices.push(batch.frontier.slice);}});
  assert.equal(result.uniquePostCount,30);assert.ok(result.items.some(i=>i.shortcode==='P25'));assert.ok(Math.max(...slices)>4);assert.equal(await page.evaluate(()=>window.triggers),29);assert.equal(ledger.observed.size,30);
});

for(const scenario of [{name:'4.7s response',responseMs:4700,renderMs:0,budget:7500},{name:'near deadline response',responseMs:4700,renderMs:0,budget:5100},{name:'delayed DOM after response',responseMs:100,renderMs:1000,budget:4000},{name:'never-settling response',responseMs:10000,renderMs:0,budget:1100}]) {
  test('real DOM pending controller: '+scenario.name,async t=>{
    const page=await browserFixture(t);let inflight=1,requests=1;const timers=[];t.after(()=>timers.forEach(clearTimeout));
    await page.setContent('<div id="post-container">'+htmlCard('A','a')+'</div>');await page.evaluate(()=>{window.scrolls=0;Element.prototype.scrollIntoView=function(){window.scrolls++;};});
    timers.push(setTimeout(()=>{inflight=0;timers.push(setTimeout(()=>page.evaluate(html=>document.getElementById('post-container').innerHTML+=html,htmlCard('B','b')).catch(()=>{}),scenario.renderMs));},scenario.responseMs));
    const result=await lib.scrapeCardSection(page,{category:'posts',mediaTypes:['image','video'],reportedTotal:2,started:Date.now(),maxTimeMs:scenario.budget,maxPages:12,continuationMonitor:{inFlight:()=>inflight,count:()=>requests,denial:()=>null},sliceTimeMs:2000});
    if(scenario.responseMs<scenario.budget)assert.ok(result.items.some(i=>i.shortcode==='B'));else assert.equal(result.evidence.stopCause,'awaiting-response');
    assert.equal(result.noGrowth,false);if(scenario.renderMs===0)assert.equal(await page.evaluate(()=>window.scrolls),0);
  });
}

test('saved discovery high-water frontier never regresses after a short interrupted replay',async()=>{
  const output=await root(),file=path.join(output,'ledger.jsonl');
  let ledger=await d.openLedger(file,{handle:'example',runId:'first',runtime:{}});
  await ledger.checkpoint({items:lib.normalizeItems([card('P25','m25')]).items,frontier:{category:'posts',pages:25,elapsedMs:40000},stopCause:'page-limit'});await ledger.close('page-limit');
  ledger=await d.openLedger(file,{handle:'example',runId:'short-replay',runtime:{}});
  await ledger.checkpoint({items:[],frontier:{category:'posts',pages:2,elapsedMs:500},stopCause:'observation-error'});await ledger.close('interrupted');
  ledger=await d.openLedger(file,{handle:'example',runId:'third',runtime:{}});
  assert.equal(ledger.frontier.posts.pages,25);assert.equal(ledger.frontier.posts.currentPages,2);await ledger.close('test-finished');
});

test('actual process kill during acquisition preserves first receipt and all unacquired work',async()=>{
  const output=await root();const library=path.resolve(__dirname,'../src/index.js');
  const childCode='const lib=require('+JSON.stringify(library)+');let calls=0;lib.archiveProfile({handle:"example",output:process.argv[1],reportedTotal:2,checkpointEveryItems:1,delayMs:0,items:[{shortcode:"A",href:"https://instacognito.com/media?id=a"},{shortcode:"B",href:"https://instacognito.com/media?id=b"}],dnsLookup:async()=>[{address:"93.184.216.34",family:4}],fetchImpl:async()=>{if(++calls===2){process.stdout.write("ACQUISITION-CHECKPOINT");await new Promise(()=>{setInterval(()=>{},1000)});}const b=Buffer.from([255,216,255,224,1,2,3,4,255,217]);return{ok:true,status:200,headers:{get:k=>k==="content-length"?String(b.length):"image/jpeg"},body:new ReadableStream({start(c){c.enqueue(b);c.close();}})};}}).catch(e=>{console.error(e);process.exitCode=2});';
  const child=spawn(process.execPath,['-e',childCode,output],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',c=>reject(Error('child exit '+c)));});
  child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));
  const paths=lib.profilePaths(output,'example');const before=await lib.readJson(paths.manifest);
  assert.equal(Object.keys(before.completed).length,1);assert.equal(Object.keys(before.pending).length,1);
  assert.equal((await lib.statusProfile({handle:'example',output})).status,'INTERRUPTED');
  let fetches=0;const status=await archive(output,[card('A','a'),card('B','b')],{reportedTotal:2,fetchImpl:async()=>{fetches++;return response();}});
  assert.equal(fetches,1);assert.equal(status.reusedCount,1);assert.equal(status.status,'COMPLETE');assert.equal((await lib.readJson(paths.owner)).terminal,true);
});

test('scoped metrics distinguish 100 prior, 12 scan, 4 new observed and 2 newly acquired posts',async()=>{
  const output=await root();const make=i=>card('P'+i,'m'+i);
  await archive(output,Array.from({length:100},(_,i)=>make(i+1)),{reportedTotal:104});
  const items=[...Array.from({length:8},(_,i)=>make(i+1)),...Array.from({length:4},(_,i)=>make(i+101))];
  const status=await archive(output,items,{reportedTotal:104,maxAcquireItems:2});
  assert.equal(status.scan.rawUniquePostCount,12);assert.equal(status.scan.uniqueMediaIdentityCount,12);assert.equal(status.observedCumulativePostCount,104);assert.equal(status.acquiredPostCount,102);
  assert.equal(status.acquisition.runDownloaded,2);assert.equal(status.cumulative.pendingCount,2);assert.equal(status.cumulative.failedCount,0);assert.ok(status.scan.categories.posts.advertisedObservedAt);
});

test('no acquisition starts after a provider 403 denial and outstanding queue remains durable',async()=>{
  const output=await root();let calls=0;
  await assert.rejects(()=>archive(output,[card('A','a'),card('B','b')],{reportedTotal:2,fetchImpl:async()=>{calls++;return{ok:false,status:403,headers:{get:()=>null},body:null};}}),{code:'DENIED'});
  assert.equal(calls,1);const paths=lib.profilePaths(output,'example'),m=await lib.readJson(paths.manifest);assert.equal(Object.keys(m.pending).length,2);assert.equal((await lib.readJson(paths.owner)).terminal,true);
});

async function routedOwnedBrowser(t) {
  const {chromium}=require('playwright');const launch=chromium.launch.bind(chromium);let ownedPage;
  const html='<!doctype html><input id="search-input"><button id="download-btn">search</button><section id="profile-section"><span class="username-text"></span><b id="total"></b></section><div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">posts</button></div><div id="post-container"></div><script>window.searches=0;document.getElementById("download-btn").onclick=async()=>{const generation=++window.searches;await fetch("/api/posts",{method:"POST"});document.querySelector(".username-text").textContent="@example";document.getElementById("total").textContent="1 posts";const card=document.createElement("article");card.className="post-card";const id=document.createElement("span");id.dataset.id="A";const a=document.createElement("a");a.className="content-download-btn";a.href="https://instacognito.com/media?id=a&fixture="+generation;card.append(id,a);document.getElementById("post-container").replaceChildren(card);};</script>';
  t.mock.method(chromium,'launch',async opts=>{
    const browser=await launch(opts);const newPage=browser.newPage.bind(browser);
    browser.newPage=async()=>{ownedPage=await newPage();await ownedPage.route('**/*',async route=>{const url=new URL(route.request().url());if(url.pathname==='/en/photo')await route.fulfill({status:200,contentType:'text/html',body:html});else if(url.pathname==='/api/posts'){await new Promise(r=>setTimeout(r,300));await route.fulfill({status:200,contentType:'application/json',body:'{}'});}else throw Error('unexpected fixture request '+url.pathname);});return ownedPage;};return browser;
  });
  return()=>ownedPage;
}

test('supported owned browser stays open through consumption and refreshes locators via a new UI generation',async t=>{
  const pageRef=await routedOwnedBrowser(t);let consumed=false;
  const scan=await lib.scrapeWithPlaywright({handle:'example',maxPages:8,maxTimeMs:5000,browserExecutable:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,requireTerminal:false,consumeScan:async(scan,session)=>{
    consumed=true;assert.equal(pageRef().isClosed(),false);const first=scan.sections[0].items[0];assert.ok(first.href.endsWith('fixture=1'));
    const refreshed=await session.refresh(new Set([first.stableId]),4000);assert.equal(refreshed.blocked,null);assert.equal(refreshed.items.length,1);assert.ok(refreshed.items[0].href.endsWith('fixture=2'));assert.equal(refreshed.items[0].stableId,first.stableId);return scan;
  }});
  assert.ok(consumed);assert.equal(scan.sections[0].itemCount,1);assert.equal(pageRef().isClosed(),true);
});

test('discovery-only end-to-end writes isolated ledger/runtime and never acquires media',async t=>{
  const pageRef=await routedOwnedBrowser(t),output=await root();let fetches=0;
  const result=await lib.archiveProfile({handle:'example',output,maxPages:8,maxTimeMs:6000,discoveryMaxTimeMs:4000,browserExecutable:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,discoveryOnly:true,targetPosts:['A'],fetchImpl:async()=>{fetches++;throw Error('no acquisition');}});
  assert.equal(fetches,0);assert.equal(result.status,'PARTIAL');assert.equal(result.scan.rawUniquePostCount,1);assert.equal(result.sections[0].evidence.stopCause,'targets-observed');assert.equal(pageRef().isClosed(),true);
  const paths=lib.profilePaths(output,'example');assert.equal(fs.existsSync(paths.manifest),false);assert.equal(fs.existsSync(path.join(paths.stateDir,'discovery.jsonl')),true);assert.ok(result.runtime.sourceDigest);assert.equal((await lib.readJson(paths.owner)).terminal,true);
});

test('acquisition uses only latest matching locator and never persists it in provenance',async()=>{
  const output=await root();let calls=0;const fresh={...card('A','a','fresh'),dateRaw:'2 January 2026',captionTruncated:'fixture caption'};
  const status=await archive(output,[card('A','a','old'),fresh],{fetchImpl:async url=>{calls++;assert.ok(url.endsWith('fixture=fresh'));return response();}});
  assert.equal(calls,1);assert.equal(status.completedCount,1);const m=await lib.readJson(lib.profilePaths(output,'example').manifest);assert.equal(Object.values(m.completed)[0].metadataProvenance.dateRaw,fresh.dateRaw);assert.equal(JSON.stringify(m).includes('media?id='),false);
});

test('verified receipt never clears a preexisting conflict without review',async()=>{
  const output=await root();await archive(output,[card('A','a')]);const paths=lib.profilePaths(output,'example');let m=await lib.readJson(paths.manifest);const id=Object.keys(m.completed)[0];m.conflicts={[id]:{stableId:id,expectedSha256:m.completed[id].sha256,observedSha256:'f'.repeat(64),reason:'review-required'}};await lib.atomicWriteJson(paths.manifest,m);
  const status=await archive(output,[card('A','a','fresh')]);m=await lib.readJson(paths.manifest);assert.ok(m.conflicts[id]);assert.equal(status.status,'PARTIAL');assert.equal(status.conflictCount,1);
});

test('receipt resolution rejects category, fingerprint and handle contradictions',async()=>{
  const output=await root();await archive(output,[card('A','a')]);const paths=lib.profilePaths(output,'example'),m=await lib.readJson(paths.manifest);const [id,receipt]=Object.entries(m.completed)[0];
  for(const corrupt of [{...receipt,category:'reels'},{...receipt,providerMediaFingerprint:'f'.repeat(64)},{...receipt,profileHandle:'foreign'}]) {
    const result=await lib.reconcileAgainstReceipts(paths,{[id]:corrupt},{[id]:{stableId:id,error:'awaiting rediscovery'}},'example');assert.deepEqual(result.resolved,[]);assert.ok(result.retained[id]);
  }
});

test('corrupt committed or foreign discovery ledger fails closed rather than starting empty',async()=>{
  const output=await root(),file=path.join(output,'ledger.jsonl');await fsp.writeFile(file,'not-json'+String.fromCharCode(10));await assert.rejects(()=>d.openLedger(file,{handle:'example',runId:'r',runtime:{}}),{code:'DISCOVERY_CORRUPT'});
  await fsp.writeFile(file,JSON.stringify({schemaVersion:1,handle:'foreign',sequence:1})+String.fromCharCode(10));await assert.rejects(()=>d.openLedger(file,{handle:'example',runId:'r',runtime:{}}),{code:'DISCOVERY_BINDING'});
});

test('a discovery denial permits local receipt bookkeeping but no subsequent provider acquisition',async()=>{
  const output=await root();let calls=0;
  const status=await lib.archiveProfile({handle:'example',output,delayMs:0,sections:[{category:'posts',status:'PARTIAL',reportedTotal:2,hitLimit:true,evidence:{blocked:{status:429,reason:'fixture denial'}},items:[card('A','a')]}],fetchImpl:async()=>{calls++;throw Error('must not acquire');}});
  assert.equal(calls,0);assert.equal(status.status,'PARTIAL');assert.equal(status.cumulative.pendingCount,1);
});

test('sandbox proof has only loopback interfaces and a separate network namespace',()=>{
  if(process.env.INSTACOGNITO_SANDBOX){
    assert.equal(process.env.INSTACOGNITO_SANDBOX,'bwrap-copy-no-net');
    assert.deepEqual(Object.values(os.networkInterfaces()).flat().filter(a=>!a.internal),[]);
    console.log('inner-netns='+fs.readlinkSync('/proc/self/ns/net')+' network-interfaces=loopback-only');
  }
});

test('archive 429 with Retry-After zero still defers immediately without a second request',async()=>{
  const output=await root();let calls=0;
  await assert.rejects(()=>archive(output,[card('A','a')],{fetchImpl:async()=>{calls++;return{ok:false,status:429,headers:{get:k=>k==='retry-after'?'0':null},body:null};}}),{code:'DEFERRED'});
  assert.equal(calls,1);const paths=lib.profilePaths(output,'example');assert.equal((await lib.readJson(paths.owner)).terminal,true);assert.equal(Object.keys((await lib.readJson(paths.manifest)).pending).length,1);
});

// Live Sep7 evidence: provider /media id changed for byte-identical scoped media.
async function byteEvidenceFixture({ stripFingerprint = false, duplicateLegacy = false } = {}) {
  const output = await root(), evidence = await root();
  await archive(output, [card('A','old-token')]);
  const paths = lib.profilePaths(output,'example'), m = await lib.readJson(paths.manifest);
  const [modern,r] = Object.entries(m.completed)[0];
  const legacy = {...r,stableId:'A-0',id:'A-0',path:'media/example/A-0.jpg'};
  if (stripFingerprint) delete legacy.providerMediaFingerprint;
  await fsp.rename(path.join(output,r.path),path.join(output,legacy.path));
  await fsp.unlink(path.join(paths.receiptDir,modern+'.json'));
  await lib.atomicWriteJson(path.join(paths.receiptDir,'A-0.json'),legacy);
  m.completed = {'A-0':legacy};
  if (duplicateLegacy) {
    const two={...legacy,stableId:'A-1',id:'A-1',carouselIndex:1,path:'media/example/A-1.jpg'};
    await fsp.copyFile(path.join(output,legacy.path),path.join(output,two.path));
    await lib.atomicWriteJson(path.join(paths.receiptDir,'A-1.json'),two);m.completed['A-1']=two;
  }
  m.pending={'B-0':{stableId:'B-0',category:'posts',shortcode:'B',carouselIndex:0,error:'awaiting rediscovery',attempts:0}};
  await lib.atomicWriteJson(paths.manifest,m);
  await archive(evidence,[card('A','new-token')]);
  return {output,evidence,paths,legacy};
}
for (const stripFingerprint of [false,true]) test('verified quarantine bytes bind rotated provider fingerprint; legacy immutable '+stripFingerprint,async()=>{
 const {output,evidence,paths,legacy}=await byteEvidenceFixture({stripFingerprint});
 const receiptBefore=await fsp.readFile(path.join(paths.receiptDir,'A-0.json'));
 const bytesBefore=await fsp.readFile(path.join(output,legacy.path));let fetches=0;
 await archive(output,[card('A','new-token')],{byteEvidenceRoot:evidence,fetchImpl:async()=>{fetches++;throw Error('byte-proof reuse must not fetch');}});
 const after=await lib.readJson(paths.manifest);const id=lib.normalizeItems([card('A','new-token')]).items[0].stableId;
 assert.equal(fetches,0);assert.deepEqual(Object.keys(after.completed),['A-0']);
 assert.equal(after.identityAliases[id]?.canonicalId,'A-0');
 assert.equal(after.identityAliases[id]?.evidence,'scoped-quarantine-byte-proof');
 assert.ok(after.pending['B-0'],'unmapped owed legacy id must survive');
 assert.deepEqual(await fsp.readFile(path.join(paths.receiptDir,'A-0.json')),receiptBefore);
 assert.deepEqual(await fsp.readFile(path.join(output,legacy.path)),bytesBefore);
});
test('byte evidence cannot choose between two canonical slides with identical bytes',async()=>{
 const {output,evidence,paths}=await byteEvidenceFixture({stripFingerprint:true,duplicateLegacy:true});
 await archive(output,[card('A','new-token')],{byteEvidenceRoot:evidence,maxAcquireItems:0});
 const m=await lib.readJson(paths.manifest),id=lib.normalizeItems([card('A','new-token')]).items[0].stableId;
 assert.equal(m.identityAliases[id],undefined);assert.ok(m.pending[id]);assert.equal(Object.keys(m.completed).length,2);
});
test('corrupt quarantine bytes reject compatibility before any provider acquisition',async()=>{
 const {output,evidence}=await byteEvidenceFixture({stripFingerprint:true});const ep=lib.profilePaths(evidence,'example');
 const m=await lib.readJson(ep.manifest),r=Object.values(m.completed)[0];await fsp.writeFile(path.join(evidence,r.path),Buffer.from('corrupt'));
 await assert.rejects(archive(output,[card('A','new-token')],{byteEvidenceRoot:evidence}),e=>e.code==='BYTE_EVIDENCE');
});
test('foreign-handle quarantine manifest is rejected',async()=>{
 const {output,evidence}=await byteEvidenceFixture();const ep=lib.profilePaths(evidence,'example'),m=await lib.readJson(ep.manifest);m.handle='other';await lib.atomicWriteJson(ep.manifest,m);
 await assert.rejects(archive(output,[card('A','new-token')],{byteEvidenceRoot:evidence}),e=>e.code==='BYTE_EVIDENCE');
});
test('canonical directory cannot double as independent byte evidence',async()=>{
 const {output}=await byteEvidenceFixture();
 await assert.rejects(archive(output,[card('A','new-token')],{byteEvidenceRoot:output}),e=>e.code==='BYTE_EVIDENCE');
});

test('quarantine byte proof cannot cross a post or category',async()=>{
 const {output,evidence,paths}=await byteEvidenceFixture({stripFingerprint:true});
 const m=await lib.readJson(paths.manifest);
 for(const category of ['posts','reels']) {
  const other=await root();await archive(other,[card(category==='posts'?'C':'A','new-token')],{categories:[category]});
  const proof=await lib.loadByteEvidence(paths,other,m.completed,'example',10000);
  assert.equal(Object.keys(proof.aliases).length,0);
 }
});
test('different quarantine bytes are held rather than bound to a legacy index',async()=>{
 const {output,evidence,paths}=await byteEvidenceFixture({stripFingerprint:true});
 const other=await root();const changed=Buffer.from([255,216,255,224,9,8,7,6,255,217]);
 await archive(other,[card('A','new-token')],{fetchImpl:async()=>({ok:true,status:200,headers:{get:k=>k==='content-length'?String(changed.length):'image/jpeg'},body:new ReadableStream({start(c){c.enqueue(changed);c.close();}})})});
 const proof=await lib.loadByteEvidence(paths,other,(await lib.readJson(paths.manifest)).completed,'example',10000);
 assert.equal(Object.keys(proof.aliases).length,0);
});
test('active evidence owner is refused and canonical conflicts survive valid proof',async()=>{
 const {output,evidence,paths}=await byteEvidenceFixture({stripFingerprint:true});const ep=lib.profilePaths(evidence,'example');
 const owner=await lib.readJson(ep.owner),copy={...owner,terminal:false};await lib.atomicWriteJson(ep.owner,copy);
 await assert.rejects(archive(output,[card('A','new-token')],{byteEvidenceRoot:evidence}),e=>e.code==='BYTE_EVIDENCE');
 await lib.atomicWriteJson(ep.owner,owner);const m=await lib.readJson(paths.manifest);m.conflicts={'A-0':{expectedSha256:m.completed['A-0'].sha256,observedSha256:'0'.repeat(64)}};await lib.atomicWriteJson(paths.manifest,m);
 await archive(output,[card('A','new-token')],{byteEvidenceRoot:evidence});const after=await lib.readJson(paths.manifest);
 assert.deepEqual(after.conflicts,m.conflicts);assert.ok(after.pending['B-0']);
});
test('quarantine receipt disagreement, oversized claim and symlink fail closed',async()=>{
 for(const variant of ['metadata','oversized','symlink']) {
  const {output,evidence,paths}=await byteEvidenceFixture();const ep=lib.profilePaths(evidence,'example'),m=await lib.readJson(ep.manifest);const [id,r]=Object.entries(m.completed)[0];
  if(variant==='metadata'){r.dateRaw='forged';await lib.atomicWriteJson(ep.manifest,m);}
  if(variant==='oversized'){r.bytes=536870913;await lib.atomicWriteJson(ep.manifest,m);}
  if(variant==='symlink'){const file=path.join(evidence,r.path),saved=file+'.original';await fsp.rename(file,saved);await fsp.symlink(saved,file);}
  await assert.rejects(archive(output,[card('A','new-token')],{byteEvidenceRoot:evidence}),e=>e.code==='BYTE_EVIDENCE');
 }
});

test('readiness retains one pending response past eight seconds without abandoning it',async t=>{
 const page=await browserFixture(t);await page.setContent('<div id="post-container"></div>');
 const start=Date.now();let pending=true;
 const timer=setTimeout(async()=>{await page.evaluate(html=>document.getElementById('post-container').innerHTML=html,htmlCard('LATE','m'));pending=false;},8500);t.after(()=>clearTimeout(timer));
 const monitor={inFlight:()=>pending?1:0,denial:()=>null,snapshot:()=>({started:1,settled:pending?0:1,inFlight:pending?1:0,failed:0})};
 const result=await lib.waitForSectionReady(page,'posts',start,12000,monitor);
 assert.equal(result.kind,'cards');assert.ok(Date.now()-start>=8400);
 assert.equal(result.transport.inFlight,0);
});
test('readiness deadline reports pending transport rather than empty source',async t=>{
 const page=await browserFixture(t);await page.setContent('<div id="post-container"></div>');
 const monitor={inFlight:()=>1,denial:()=>null,snapshot:()=>({started:1,settled:0,inFlight:1,failed:0})};
 const r=await lib.waitForSectionReady(page,'posts',Date.now(),450,monitor);
 assert.equal(r.kind,'awaiting-response');assert.equal(r.transport.inFlight,1);
});
test('readiness denial preserves transport evidence and never waits out refusal',async t=>{
 const page=await browserFixture(t);await page.setContent('<div id="post-container"></div>');
 const denial={kind:'denied',status:429,retryAt:'2026-09-08T00:00:00Z',reason:'rate limited'};
 const monitor={inFlight:()=>1,denial:()=>denial,snapshot:()=>({started:1,settled:0,inFlight:1,failed:0})};
 const r=await lib.waitForSectionReady(page,'posts',Date.now(),12000,monitor);
 assert.equal(r.kind,'blocked');assert.equal(r.blocked.status,429);assert.equal(r.transport.inFlight,1);
});

test('pending readiness reaches PARTIAL caller evidence and never starts category traversal',async t=>{
 const page=await browserFixture(t);await page.setContent('<section id="profile-section"><span class="username-text">example</span><span>2 posts</span></section><div id="menu-wrapper"><button class="menu-item active" data-id="POSTS">posts</button></div><div id="post-container"></div>');
 const monitor={inFlight:()=>1,denial:()=>null,snapshot:()=>({started:1,settled:0,inFlight:1,failed:0})};
 const scan=await lib.scanReadyProfilePage(page,{handle:'example',categories:['posts'],maxTimeMs:750,maxPages:10,started:Date.now(),continuationMonitor:monitor});
 assert.equal(scan.sections[0].status,'PARTIAL');assert.equal(scan.sections[0].evidence.stopCause,'awaiting-response');assert.equal(scan.sections[0].evidence.transport.inFlight,1);assert.equal(scan.sections[0].items.length,0);
});
test('stale no-content is not terminal while a category response is pending',async t=>{
 const page=await browserFixture(t);await page.setContent('<div id="error-no-content">no content</div><div id="post-container"></div>');
 let pending=true;const timer=setTimeout(async()=>{await page.evaluate(html=>{document.getElementById('error-no-content').remove();document.getElementById('post-container').innerHTML=html;},htmlCard('A','m'));pending=false;},250);t.after(()=>clearTimeout(timer));
 const monitor={inFlight:()=>pending?1:0,denial:()=>null,snapshot:()=>({inFlight:pending?1:0})};
 const r=await lib.waitForSectionReady(page,'posts',Date.now(),1500,monitor);assert.equal(r.kind,'cards');
});
test('denial arriving during readiness is latched before any cards can be accepted',async t=>{
 const page=await browserFixture(t);await page.setContent('<div id="post-container"></div>');const start=Date.now();
 const denial={kind:'denied',status:403,reason:'refused'};const monitor={inFlight:()=>1,denial:()=>Date.now()-start>250?denial:null,snapshot:()=>({inFlight:1})};
 const r=await lib.waitForSectionReady(page,'posts',start,1500,monitor);assert.equal(r.kind,'blocked');assert.equal(r.blocked.status,403);assert.ok(Date.now()-start<1200);
});
