'use strict';
// Mechanism proof for the PASSIVE listing-response observer (see
// .review-evidence/passive-design.md). This file replaces the interposition-era mechanism
// claims disproved by the independent reviewer as PR-S1, PR-S1-accounting and CLOSURE-L3.
//
// The contract proved here is NEGATIVE where it matters: the observer must be invisible to the
// platform. It creates no Response, no ReadableStream, no reader, no clone, no tee and no queue;
// it hands the application a native promise carrying the native Response it already had; it looks
// only at values the application itself asked for. Every assertion is a counterexample and must
// never be relaxed into a success. For a listing request that promise is ONE chained native
// promise rather than the platform's own object - see test/passive-repair.test.js, which proves
// the global rejection recovery the previous side subscription suppressed (PASSIVE-L2).
//
// Real Chromium, real DOM, fulfilled in-process inside the no-network sandbox: no provider
// traffic, no signed locators, no private strings, no skips.
const test=require('node:test'),{after}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),fsSync=require('node:fs'),os=require('node:os'),path=require('node:path');
const F=require('../src/index.js'),W=require('../src/sync-window.js'),{openBudget}=require('../src/request-budget.js');
const SANITIZED=require('./fixtures/sanitized-listing.js');
const {rec,posts,card,document_,RENDERER,PROFILE}=require('./fixtures/listing-page.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));

let shared=null;
async function launch(){
 if(shared)return shared;
 const {chromium}=require('playwright');
 const executablePath=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath();
 assert.ok(fsSync.existsSync(executablePath),'required real DOM browser must exist; no skips');
 shared=await chromium.launch({headless:true,executablePath});return shared;
}
after(async()=>{if(shared)await shared.close();shared=null;});
async function pageFixture(t,html=''){
 const browser=await launch(),context=await browser.newContext({serviceWorkers:'block'});
 t.after(()=>context.close());
 await context.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));
 const page=await context.newPage();await page.goto(F.PROVIDER_PHOTO_URL);return {page,context};
}
async function budget(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-passive-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const b=openBudget(path.join(root,'ledger.json'),'passive');t.after(()=>b.close());return b;
}
// Counts every platform object and every second consumer the observer could introduce, and the
// largest string ever handed to JSON.stringify - the copy a naive parsed-body observer makes.
const INSTRUMENT=`(()=>{window.ffMeter={clones:0,tees:0,getReaders:0,defaultReads:0,byobReads:0,cancels:0,
  responses:0,streams:0,objectStringify:0,maxStringifyChars:0,maxBacking:0};
 const nClone=Response.prototype.clone;Response.prototype.clone=function(){ffMeter.clones++;return nClone.apply(this,arguments);};
 const nTee=ReadableStream.prototype.tee;ReadableStream.prototype.tee=function(){ffMeter.tees++;return nTee.apply(this,arguments);};
 const nGet=ReadableStream.prototype.getReader;ReadableStream.prototype.getReader=function(){ffMeter.getReaders++;return nGet.apply(this,arguments);};
 const note=s=>{if(s&&s.value&&s.value.buffer)ffMeter.maxBacking=Math.max(ffMeter.maxBacking,s.value.buffer.byteLength);return s;};
 const dr=ReadableStreamDefaultReader.prototype.read;
 ReadableStreamDefaultReader.prototype.read=function(){ffMeter.defaultReads++;return dr.apply(this,arguments).then(note);};
 const dc=ReadableStreamDefaultReader.prototype.cancel;
 ReadableStreamDefaultReader.prototype.cancel=function(){ffMeter.cancels++;return dc.apply(this,arguments);};
 if(window.ReadableStreamBYOBReader){const br=ReadableStreamBYOBReader.prototype.read;
  ReadableStreamBYOBReader.prototype.read=function(){ffMeter.byobReads++;return br.apply(this,arguments).then(note);};}
 window.Response=new Proxy(Response,{construct(t,a,n){ffMeter.responses++;return Reflect.construct(t,a,n);}});
 window.ReadableStream=new Proxy(ReadableStream,{construct(t,a,n){ffMeter.streams++;return Reflect.construct(t,a,n);}});
 const js=JSON.stringify;JSON.stringify=function(v){
  if(typeof v==='string'){if(v.length>ffMeter.maxStringifyChars)ffMeter.maxStringifyChars=v.length;}
  else ffMeter.objectStringify++;
  return js.apply(this,arguments);};
})()`;
const meter=page=>page.evaluate(()=>({...window.ffMeter}));
const report=page=>F.readListingBodyObservation(page);
const LIMITS={maxBytes:65536,maxActiveReads:2,maxRetainedBytes:65536,maxBodies:8,timeoutMs:4000};

// === GATE 1: an unread source is pulled no more than it would be with no observer at all ====
// A source with highWaterMark 0 produces NOTHING until something pulls it. The uninstrumented
// control establishes the baseline the observer must match exactly.
const COUNTING_SOURCE=`window.pulls=0;window.fixtureResponses=0;window.fixtureStreams=0;
window.fetch=()=>{window.fixtureStreams++;window.fixtureResponses++;
 return Promise.resolve(new Response(new ReadableStream({
  pull(c){window.pulls++;c.enqueue(new Uint8Array(new ArrayBuffer(65536),0,1));if(window.pulls>=64)c.close();}
 },{highWaterMark:0})));};`;
test('passive: an unread listing response is pulled exactly as much as with no observer at all',async t=>{
 const control=await pageFixture(t);
 await control.page.evaluate(INSTRUMENT);
 await control.page.evaluate(COUNTING_SOURCE);
 await control.page.evaluate(()=>{fetch('/api/posts').catch(()=>{});});
 await pause(400);
 const baseline={pulls:await control.page.evaluate(()=>window.pulls),meter:await meter(control.page)};

 const probed=await pageFixture(t);
 await probed.page.evaluate(INSTRUMENT);
 await probed.page.evaluate(COUNTING_SOURCE);
 await F.installRenderObservationProbe(probed.page,LIMITS);
 await probed.page.evaluate(()=>{fetch('/api/posts').catch(()=>{});});
 await pause(400);
 const pulls=await probed.page.evaluate(()=>window.pulls),m=await meter(probed.page),observed=await report(probed.page);
 // What the FIXTURE itself built, counted by the fixture, so the platform-object assertions
 // below are a statement about the OBSERVER's additions rather than a bare total.
 const fixture=await probed.page.evaluate(()=>({responses:window.fixtureResponses,streams:window.fixtureStreams}));
 console.log('UNREAD_SOURCE '+JSON.stringify({baseline,probed:{pulls,meter:m,fixture,observed}}));
 assert.equal(baseline.pulls,0,'the uninstrumented control must pull nothing');
 assert.equal(pulls,0,'the observer must not pull an unread source');
 assert.equal(m.getReaders,0,'the observer must acquire no reader');
 assert.equal(m.defaultReads,0,'the observer must perform no read');
 assert.equal(m.clones,0);assert.equal(m.tees,0);assert.equal(m.cancels,0);
 // Two independent statements of the same fact: every constructed platform object is one the
 // fixture built and counted itself, AND the totals equal the uninstrumented control's exactly.
 assert.equal(m.responses-fixture.responses,0,'the observer must construct no Response');
 assert.equal(m.streams-fixture.streams,0,'the observer must construct no ReadableStream and no queue');
 assert.equal(m.responses,baseline.meter.responses,'and no more than the uninstrumented control built');
 assert.equal(m.streams,baseline.meter.streams,'and no more streams than the uninstrumented control built');
 assert.equal(observed.bodies.length,1);
 assert.equal(observed.bodies[0].state,'unconsumed','an unread response is inconclusive, never read');
 assert.equal(observed.retainedBytes,0);
 assert.equal(observed.retainedBackingBytes,0);
 assert.equal(observed.activeTaps,0);
});

// === GATE 2: the application keeps a native promise, the native Response and native semantics
test('passive: fetch returns a native promise carrying the native Response object unchanged',async t=>{
 const body=JSON.stringify(posts(rec({code:'A',media:'M'})));
 const {page,context}=await pageFixture(t);
 await context.route('**/api/posts',r=>r.fulfill({contentType:'application/json',body}));
 await page.evaluate(INSTRUMENT);
 // An inner wrapper installed BEFORE the probe records the exact Response the layer underneath
 // produced. Whatever the probe hands the application must carry that very object.
 await page.evaluate(()=>{const inner=window.fetch;window.madeResponse=null;
  window.fetch=function(){const p=inner.apply(this,arguments);
   p.then(r=>{window.madeResponse=r;},()=>{});return p;};});
 await F.installRenderObservationProbe(page,LIMITS);
 const identity=await page.evaluate(async()=>{
  const returned=fetch('/api/posts');
  // CORRECTED for PASSIVE-L2: a listing fetch now returns ONE chained NATIVE promise carrying the
  // same native Response, instead of the platform's own promise object with a side rejection
  // handler attached to it. The withdrawn claim is promise-object identity alone; the Response,
  // its body, its metadata and the page's own global rejection recovery are all still native, and
  // test/passive-repair.test.js proves the recovery event that identity claim was costing.
  const nativePromise=returned instanceof Promise&&Object.getPrototypeOf(returned)===Promise.prototype
   &&returned.constructor===Promise;
  const response=await returned;
  const sameResponse=response===window.madeResponse;
  const sameBody=response.body===window.madeResponse.body;
  const own=Object.getOwnPropertyNames(response);
  let headersMutable=true;try{response.headers.set('x-probe','1');}catch(e){headersMutable=false;}
  const clone=response.clone();
  const byob=[];
  try{const rd=clone.body.getReader({mode:'byob'});
   for(;;){const s=await rd.read(new Uint8Array(new ArrayBuffer(16)));if(s.done)break;byob.push(s.value.byteLength);}}
  catch(e){byob.push('ERROR:'+e.constructor.name);}
  const usedBefore=response.bodyUsed;
  const text=await response.text();
  return {nativePromise,sameResponse,sameBody,own,headersMutable,
   url:response.url,type:response.type,redirected:response.redirected,
   cloneUrl:clone.url,cloneType:clone.type,byobBytes:byob,
   usedBefore,usedAfter:response.bodyUsed,text};
 });
 const m=await meter(page),observed=await report(page);
 console.log('NATIVE_IDENTITY '+JSON.stringify({identity,meter:m,observed}));
 assert.equal(identity.nativePromise,true,'fetch must return a native Promise, never a thenable of our own');
 assert.equal(identity.sameResponse,true,'the application must receive the very same Response object');
 assert.equal(identity.sameBody,true,'and the very same body stream object');
 assert.deepEqual(identity.own,[],'the observer must define no own property on the Response');
 assert.equal(identity.headersMutable,false,'network headers must stay immutable');
 assert.equal(identity.url,F.PROVIDER_ORIGIN+'/api/posts');
 assert.equal(identity.type,'basic');
 assert.equal(identity.redirected,false);
 assert.equal(identity.cloneUrl,F.PROVIDER_ORIGIN+'/api/posts','a clone must keep native URL metadata');
 assert.equal(identity.cloneType,'basic','a clone must keep its native type');
 assert.ok(identity.byobBytes.every(x=>typeof x==='number'),'a BYOB byte reader must still work: '+JSON.stringify(identity.byobBytes));
 assert.equal(identity.byobBytes.reduce((a,b)=>a+b,0),body.length,'BYOB must deliver the whole body');
 assert.equal(identity.usedBefore,false);
 assert.equal(identity.usedAfter,true,'bodyUsed must follow the application own consumption');
 assert.equal(identity.text,body,'the application must receive its body byte for byte');
 assert.equal(m.clones,1,'the only clone is the application own');
 assert.equal(m.tees,0);
 assert.equal(observed.bodies[0].state,'read');
 assert.equal(observed.bodies[0].via,'text');
});

test('passive: an application-driven cancellation and a rejected consumption are unchanged',async t=>{
 const {page}=await pageFixture(t);
 await page.evaluate(INSTRUMENT);
 await page.evaluate(()=>{window.fetch=()=>Promise.resolve(new Response(new ReadableStream({
  start(c){c.enqueue(new TextEncoder().encode('{"p":['));c.enqueue(new TextEncoder().encode('tail'));c.close();}})));});
 await F.installRenderObservationProbe(page,{...LIMITS,timeoutMs:600});
 const outcome=await page.evaluate(async()=>{
  const r=await fetch('/api/posts');
  const rd=r.body.getReader();
  const first=await rd.read();
  await rd.cancel('application choice');
  const after=await rd.read();
  // A SECOND response, so the malformed-body rejection is not entangled with the tee lifetime a
  // clone would impose on the first one.
  let rejected=null;
  try{await (await fetch('/api/posts')).json();}catch(e){rejected=e.constructor.name;}
  return {firstBytes:first.value.byteLength,doneAfterCancel:after.done,rejected};
 });
 const observed=await report(page),m=await meter(page);
 console.log('NATIVE_CANCEL '+JSON.stringify({outcome,meter:m,observed}));
 assert.equal(outcome.firstBytes,6);
 assert.equal(outcome.doneAfterCancel,true,'the application own cancellation must behave natively');
 assert.equal(outcome.rejected,'SyntaxError','a malformed json() must reject exactly as it natively does');
 assert.equal(m.cancels,1,'the only cancel is the application own');
 // The first response was consumed through the raw stream - not a supported observation path;
 // the second was consumed through json() and rejected, which is unreadable evidence.
 assert.equal(observed.bodies[0].state,'unconsumed');
 assert.equal(observed.bodies[1].state,'unreadable');
 assert.equal(observed.retainedBytes,0);
});

// === GATE 3: real p/pc consumption genuinely certifies the real-shaped listing ==============
const consumePage=how=>RENDERER+';window.trace=[];function show(){'
 +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
 +(how==='json'
  ?'fetch("/api/posts").then(function(r){return r.json();}).then(function(d){window.trace.push("decoded");ffPaint(d);window.trace.push("rendered");});}'
  :'fetch("/api/posts").then(function(r){return r.text();}).then(function(s){var d=JSON.parse(s);window.trace.push("decoded");ffPaint(d);window.trace.push("rendered");});}');
for(const how of ['json','text'])test('passive: a real p/pc listing consumed through '+how+'() certifies image, video and carousel cards',async t=>{
 const browser=await launch(),context=await browser.newContext({serviceWorkers:'block'});
 t.after(()=>context.close());
 await context.route('**/*',route=>{const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',
   body:JSON.stringify(u.pathname==='/api/posts'?SANITIZED.RESPONSE:{})});
  return route.fulfill({status:200,contentType:'text/html',body:document_(consumePage(how))});});
 const page=await context.newPage(),b=await budget(t);
 const r=await W.discover(page,'example',b,Date.now()+20000,200,9000);
 const observed=await report(page);
 console.log('SUPPORTED_CERTIFICATION '+JSON.stringify({how,basis:r.binding.basis,cards:r.raw.length,
  observed:observed.bodies.map(x=>({path:x.path,state:x.state,via:x.via,retainedBytes:x.retainedBytes}))}));
 assert.equal(r.binding.basis,'response-tuples');
 assert.equal(r.raw.length,13,'12 primaries plus one om child render as 13 cards');
 assert.equal(r.raw.filter(x=>x.mediaType==='image').length,6);
 assert.equal(r.raw.filter(x=>x.mediaType==='video').length,7);
 assert.deepEqual(r.raw.map(x=>[x.shortcode,x.mediaType,x.dateRaw]),
  SANITIZED.TUPLES.map(x=>[x.shortcode,x.mediaType,x.dateRaw]));
 assert.deepEqual(r.raw.map(x=>F.providerMediaIdentity(x.href)),SANITIZED.TUPLES.map(x=>'/media?id='+x.mediaId));
 const listing=observed.bodies.find(x=>x.path==='/api/posts');
 assert.equal(listing.state,'read');
 assert.equal(listing.via,how);
});
test('passive: an unchanged listing the response merely repeats is still certified',async t=>{
 const payload=posts(rec({code:'AAA',media:'M1'}),rec({code:'BBB',media:'M2',type:'video'}));
 const initial=card('M1',{shortcode:'AAA'})+card('M2',{shortcode:'BBB',type:'video'});
 const browser=await launch(),context=await browser.newContext({serviceWorkers:'block'});
 t.after(()=>context.close());
 const script=RENDERER+';window.trace=[];function show(){'
  +'fetch("/api/profile").then(function(r){return r.json();}).then(function(){'+PROFILE+'});'
  +'fetch("/api/posts").then(function(r){return r.json();}).then(function(){window.trace.push("no-render");});}';
 await context.route('**/*',route=>{const u=new URL(route.request().url());
  if(u.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',
   body:JSON.stringify(u.pathname==='/api/posts'?payload:{})});
  return route.fulfill({status:200,contentType:'text/html',body:document_(script,initial)});});
 const page=await context.newPage(),b=await budget(t);
 const r=await W.discover(page,'example',b,Date.now()+16000,50,7000);
 console.log('UNCHANGED_LISTING '+JSON.stringify({basis:r.binding.basis,cards:r.raw.map(x=>x.shortcode)}));
 assert.equal(r.binding.basis,'response-tuples','a quiet, unchanged, genuinely consumed listing must still bind');
 assert.deepEqual(r.raw.map(x=>x.shortcode),['AAA','BBB']);
});

// === GATE 4: nothing short of a supported, bounded, current, matching consumption certifies ==
const NEGATIVE=[
 {name:'never consumed',script:'fetch("/api/posts").catch(function(){});',expect:'unconsumed'},
 {name:'consumed through an unsupported path',script:'fetch("/api/posts").then(function(r){return r.arrayBuffer();});',expect:'unsupported'},
 {name:'consumed through the raw body stream',script:'fetch("/api/posts").then(function(r){var d=r.body.getReader();return (function pump(){return d.read().then(function(s){return s.done?null:pump();});})();});',expect:'unconsumed'},
 {name:'consumed on a clone instead of the response',script:'fetch("/api/posts").then(function(r){return r.clone().json();});',expect:'unconsumed'}
];
for(const c of NEGATIVE)test('passive: a listing '+c.name+' cannot certify anything',async t=>{
 const {page,context}=await pageFixture(t);
 await context.route('**/api/posts',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(SANITIZED.RESPONSE)}));
 await page.evaluate(INSTRUMENT);
 await F.installRenderObservationProbe(page,LIMITS);
 await page.evaluate(script=>{new Function(script)();},c.script);
 await pause(500);
 const observed=await report(page),m=await meter(page);
 console.log('NEGATIVE_PATH '+JSON.stringify({name:c.name,observed,meter:m}));
 assert.equal(observed.bodies[0].state,c.expect);
 assert.equal(observed.bodies[0].text,null);
 assert.equal(observed.retainedBytes,0,'an unobserved path retains nothing');
 assert.equal(observed.retainedBackingBytes,0);
 assert.equal(observed.activeTaps,0);
 assert.equal(m.tees,0,'the observer must never tee, whatever the application does');
});
test('passive: a body over the admission ceiling is refused and retains nothing',async t=>{
 const {page,context}=await pageFixture(t);
 await context.route('**/api/posts',r=>r.fulfill({contentType:'application/json',
  body:JSON.stringify({p:[],pc:'x'.repeat(4096)})}));
 await page.evaluate(INSTRUMENT);
 await F.installRenderObservationProbe(page,{...LIMITS,maxBytes:256,maxRetainedBytes:256});
 const appLen=await page.evaluate(async()=>(await (await fetch('/api/posts')).text()).length);
 await page.waitForFunction(()=>window.__ffWindowObservation.bodyReport(false).bodies[0].state!=='reading');
 const observed=await report(page),m=await meter(page);
 console.log('OVER_CEILING '+JSON.stringify({appLen,observed,meter:m}));
 assert.equal(observed.bodies[0].state,'oversized');
 assert.equal(observed.retainedBytes,0);
 assert.equal(observed.retainedBackingBytes,0);
 assert.ok(observed.refusedObservations>=1);
 assert.ok(appLen>4096,'the application still received its whole body');
 assert.equal(m.clones,0,'refusing must not require a second consumer either');
});
test('passive: a retired generation drops evidence and a late completion cannot resurrect it',async t=>{
 const {page}=await pageFixture(t);
 await page.evaluate(INSTRUMENT);
 // The response settles, the application calls json(), and the body then stays OPEN: the tap is
 // genuinely armed and outstanding when the new generation arrives.
 await page.evaluate(()=>{window.release=null;window.fetch=()=>Promise.resolve(new Response(new ReadableStream({
  start(c){window.release=()=>{c.enqueue(new TextEncoder().encode('{"p":[],"pc":"0123456789_0123"}'));c.close();};}})));});
 await F.installRenderObservationProbe(page,{...LIMITS,timeoutMs:20000});
 await page.evaluate(()=>{window.appJson=null;fetch('/api/posts').then(r=>r.json()).then(v=>{window.appJson=v;});});
 await page.waitForFunction(()=>window.__ffWindowObservation.bodyReport(false).bodies[0]?.state==='reading');
 const armed=await report(page);
 await F.beginRenderObservationGeneration(page);
 const retired=await report(page);
 await page.evaluate(()=>window.release());
 await page.waitForFunction(()=>window.appJson!==null);
 await pause(150);
 const late=await report(page),m=await meter(page);
 console.log('RETIRED_LATE '+JSON.stringify({armed,retired,late,meter:m}));
 assert.equal(armed.activeTaps,1,'the counterexample must have had a genuinely armed observation');
 assert.deepEqual(retired.bodies,[],'a new generation retires every body');
 assert.equal(retired.activeTaps,0,'and releases its accounting');
 assert.deepEqual(late.bodies,[],'a late completion must not resurrect a retired observation');
 assert.equal(late.activeTaps,0,'nor its accounting');
 assert.equal(late.retainedBytes,0);
 assert.deepEqual(await page.evaluate(()=>window.appJson),{p:[],pc:'0123456789_0123'},
  'the application own json() still resolves with its own value');
 assert.equal(m.cancels,0,'the observer must never cancel anything of the application own');
});

// === GATE 5: adversarial backing and parsed-field sizes cause no additional copy =============
test('passive: a tiny view on a huge backing buffer causes no observer copy or retention',async t=>{
 const {page}=await pageFixture(t);
 await page.evaluate(INSTRUMENT);
 await page.evaluate(()=>{window.fixtureResponses=0;window.fixtureStreams=0;
  window.fetch=()=>{window.fixtureStreams++;window.fixtureResponses++;
   return Promise.resolve(new Response(new ReadableStream({
    start(c){for(let i=0;i<32;i++)c.enqueue(new Uint8Array(new ArrayBuffer(1048576),0,1));c.close();}})));};});
 await F.installRenderObservationProbe(page,{...LIMITS,maxBytes:64,maxRetainedBytes:64});
 const before=await meter(page);
 const appBytes=await page.evaluate(async()=>{const r=await fetch('/api/posts');
  const rd=r.body.getReader();let n=0;for(;;){const s=await rd.read();if(s.done)break;n+=s.value.byteLength;}return n;});
 await pause(200);
 const observed=await report(page),m=await meter(page);
 const fixture=await page.evaluate(()=>({responses:window.fixtureResponses,streams:window.fixtureStreams}));
 console.log('HUGE_BACKING '+JSON.stringify({appBytes,observed,meter:m,before,fixture}));
 assert.equal(appBytes,32,'the application received every byte it asked for');
 assert.equal(m.maxBacking,1048576,'the counterexample really did deliver huge backing buffers');
 assert.equal(m.getReaders-before.getReaders,1,'only the application acquired a reader');
 // Fixture-created versus observer-added, stated explicitly: the fixture built one Response and
 // one body stream and says so; the observer added neither a queue nor a wrapper.
 assert.equal(fixture.streams,1);assert.equal(fixture.responses,1);
 assert.equal((m.streams-before.streams)-fixture.streams,0,'the observer created no stream to hold those views in');
 assert.equal((m.responses-before.responses)-fixture.responses,0,'the observer created no Response of its own');
 assert.equal(observed.retainedBytes,0,'the observer holds nothing of an unsupported path');
 assert.equal(observed.retainedBackingBytes,0);
});
test('passive: a huge parsed field is refused before it is ever copied',async t=>{
 const {page,context}=await pageFixture(t);
 const huge=JSON.stringify({p:[],pc:'P'.repeat(4*1024*1024)});
 await context.route('**/api/posts',r=>r.fulfill({contentType:'application/json',body:huge}));
 await page.evaluate(INSTRUMENT);
 await F.installRenderObservationProbe(page,{...LIMITS,maxBytes:4096,maxRetainedBytes:4096});
 const before=await meter(page);
 const appLen=await page.evaluate(async()=>(await (await fetch('/api/posts')).json()).pc.length);
 await page.waitForFunction(()=>window.__ffWindowObservation.bodyReport(false).bodies[0].state!=='reading');
 const observed=await report(page),m=await meter(page);
 console.log('HUGE_PARSED_FIELD '+JSON.stringify({appLen,observed,
  objectStringifyDelta:m.objectStringify-before.objectStringify,maxStringifyChars:m.maxStringifyChars}));
 assert.equal(appLen,4*1024*1024,'the application own parsed value is untouched');
 assert.equal(observed.bodies[0].state,'oversized');
 assert.equal(observed.retainedBytes,0);
 assert.equal(observed.retainedBackingBytes,0);
 assert.equal(m.objectStringify-before.objectStringify,0,
  'the observer must never serialize an arbitrary parsed object graph');
 assert.ok(m.maxStringifyChars<=4096,
  'no string beyond the admission budget may ever be copied: saw '+m.maxStringifyChars);
});
test('passive: a bounded parsed value is re-serialized faithfully, unknown remainder included',async t=>{
 const {page,context}=await pageFixture(t);
 // An unknown top-level field alongside the real one: the re-serialization must carry it, so the
 // strict decoder still refuses the body instead of accepting a convenient recognizable subset.
 const payload={...posts(rec({code:'A',media:'M'})),extra:{unknown:['remainder',1,true,null]}};
 await context.route('**/api/posts',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(payload)}));
 await page.evaluate(INSTRUMENT);
 await F.installRenderObservationProbe(page,LIMITS);
 await page.evaluate(()=>{fetch('/api/posts').then(r=>r.json()).then(v=>{window.appKeys=Object.keys(v);});});
 await page.waitForFunction(()=>window.__ffWindowObservation.bodyReport(false).bodies[0].state==='read');
 const text=await page.evaluate(key=>window[key].bodyReport(true).bodies[0].text,'__ffWindowObservation');
 console.log('FAITHFUL_SERIALIZATION '+JSON.stringify({length:text.length}));
 assert.deepEqual(JSON.parse(text),payload,'the observed text must reproduce the parsed value exactly');
 const decoded=F.decodeListingResponse(text);
 assert.equal(decoded.supported,false,'unknown remainder must still be refused by the strict decoder');
 assert.equal(decoded.reason,'unknown-listing-field');
});
