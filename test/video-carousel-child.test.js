'use strict';
// Entirely synthetic: no captured locators, captions, handles or provider responses.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const F=require('../src/index.js'),W=require('../src/sync-window.js'),{openBudget}=require('../src/request-budget.js');
const {rec,posts,document_,responsePage,paintNow}=require('./fixtures/listing-page.js');
const tuple=r=>({shortcode:r.shortcode,mediaIdentity:F.providerMediaIdentity(r.href),mediaType:r.mediaType,dateRaw:r.dateRaw});
function synthetic(large=false){
 const expected=[],roots=[];
 const add=(code,media,type,date)=>{expected.push({shortcode:code,mediaIdentity:'/media?id='+media,mediaType:type,dateRaw:date});return rec({code,media,type,date});};
 for(let i=0;i<(large?12:1);i++){
  const code='POST'+i,date=(i+1)+' January 2026';
  const root=add(code,'ROOT'+i,large&&i>=9?'video':'image',date);
  const n=large?(i<8?10:i===8?6:0):2;
  if(n)root.om=Array.from({length:n},(_,j)=>add(code,'CHILD'+i+'_'+j,(large?i<4&&j===0:j===0)?'video':'image',date));
  roots.push(root);
 }
 return {payload:posts(...roots),expected};
}
for(const large of [false,true])test('decoder supports '+(large?'98-card heterogeneous':'minimal mixed')+' video-child carousel in full order',()=>{
 const {payload,expected}=synthetic(large),decoded=F.decodeListingResponse(JSON.stringify(payload));
 assert.equal(decoded.supported,true,decoded.reason);
 assert.deepEqual(decoded.tuples,expected);
 assert.equal(decoded.records,large?12:1);assert.equal(decoded.children,large?86:2);
 assert.equal(decoded.tuples.filter(x=>x.mediaType==='video').length,large?7:1);
});
async function fixture(t,{payload,script=responsePage(paintNow),observe=null}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-video-child-'));
 const browser=await require('playwright').chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/chromium'});
 const media=[];let page;
 const jpg=Buffer.from([255,216,255,224,1,2,3,4,255,217]);
 const mp4=Buffer.from('000000186674797069736f6d0000000069736f6d69736f32','hex');
 const expectedBytes=id=>id==='CHILD0_0'?mp4:jpg;
 const wrap={newContext:async options=>{
  const context=await browser.newContext(options);
  await context.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.pathname==='/media'){
    const id=u.searchParams.get('id');media.push(id);
    return route.fulfill({status:200,contentType:id==='CHILD0_0'?'video/mp4':'image/jpeg',body:expectedBytes(id)});
   }
   if(u.pathname.startsWith('/api/'))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(u.pathname==='/api/posts'?payload:{})});
   return route.fulfill({status:200,contentType:'text/html',body:document_(script)});
  });
  context.on('page',p=>{page=p;});
  if(!observe)return context;
  const bound=(o,k)=>typeof o[k]==='function'?o[k].bind(o):o[k];
  return new Proxy(context,{get(c,k){
   if(k!=='newPage')return bound(c,k);
   return async()=>new Proxy(await c.newPage(),{get(p,key){
    if(key!=='evaluate')return bound(p,key);
    return async(fn,arg)=>{const seen=await p.evaluate(fn,arg);if(arg?.bodies&&seen?.bodies)observe(seen);return seen;};
   }});
  }});
 },close:async()=>{}};
 // Close the browser before deleting ledger/storage; no racing independent teardown hooks.
 t.after(async()=>{await browser.close();await fs.rm(root,{recursive:true,force:true});});
 const config={handles:[{handle:'example',dateAfter:'2020-01-01'}],runId:'video-child',output:path.join(root,'out'),resultFile:path.join(root,'result.json'),requestLedger:path.join(root,'ledger.json'),maxTimeMs:20000};
 return {root,config,media,page:()=>page,expectedBytes,deps:{chromium:{launch:async()=>wrap},dnsLookup:async()=>[{address:'93.184.216.34',family:4}],readinessWaitMs:3000},wrap};
}
for(const large of [false,true])test('real renderer binds every '+(large?'98-card':'minimal')+' mixed video-child tuple',async t=>{
 const {payload,expected}=synthetic(large),f=await fixture(t,{payload});
 const context=await f.wrap.newContext({serviceWorkers:'block'}),page=await context.newPage();
 const budget=openBudget(f.config.requestLedger,'discovery');
 let found,error;
 try{found=await W.discover(page,'example',budget,Date.now()+15000,200,3000);}catch(e){error=e;}finally{budget.close();}
 const dom=(await F.readRawCardsFromPage(page)).map(tuple);
 assert.deepEqual(dom,expected,'the actual renderer must have painted every tuple independently of decoder acceptance');
 assert.ok(found,'rendered video children incorrectly rejected: '+JSON.stringify({decoder:F.decodeListingResponse(JSON.stringify(payload)).reason,code:error?.code,binding:error?.details?.readiness?.binding}));
 assert.deepEqual(found.raw.map(tuple),expected);assert.equal(found.binding.basis,'response-tuples');
 assert.equal(found.binding.schema.cards,expected.length);assert.equal(f.media.length,0);
});
test('real video-child readiness flows through acquisition, persisted receipts and cache reuse',async t=>{
 const {payload,expected}=synthetic(),f=await fixture(t,{payload});
 const result=await W.syncWindow(f.config,f.deps);
 assert.equal(result.status,'COMPLETE',JSON.stringify(result.handles.example.readiness));
 assert.deepEqual(JSON.parse(await fs.readFile(f.config.resultFile,'utf8')),result);
 assert.equal(result.handles.example.observedCards,3);assert.equal(result.handles.example.files.length,3);
 assert.equal(result.totals.downloaded,3);assert.equal(result.fullHistoryComplete,false);
 assert.deepEqual(f.media,['ROOT0','CHILD0_0','CHILD0_1']);
 const paths=F.profilePaths(f.config.output,'example');
 for(const [i,file] of result.handles.example.files.entries()){
  const receipt=JSON.parse(await fs.readFile(path.join(paths.receiptDir,file.stableId+'.json'),'utf8'));
  const bytes=await fs.readFile(path.join(f.config.output,file.path));
  assert.equal(file.mediaType,expected[i].mediaType);assert.equal(receipt.mediaType,file.mediaType);
  assert.deepEqual(bytes,f.expectedBytes(f.media[i]));
  assert.equal(receipt.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
 }
 const second=await W.syncWindow({...f.config,runId:'reuse',resultFile:f.config.resultFile+'.reuse'},f.deps);
 assert.equal(second.status,'COMPLETE');assert.equal(second.totals.reused,3);assert.equal(f.media.length,3);
});
test('decoder accepts absent captions on a root and its children without dropping tuples',()=>{
 const {payload,expected}=synthetic();delete payload.p[0].c;for(const child of payload.p[0].om)delete child.c;
 const decoded=F.decodeListingResponse(JSON.stringify(payload));
 assert.equal(decoded.supported,true,decoded.reason);assert.deepEqual(decoded.tuples,expected);
});
test('real renderer with absent root and child captions completes acquisition',async t=>{
 const {payload}=synthetic();delete payload.p[0].c;for(const child of payload.p[0].om)delete child.c;
 const f=await fixture(t,{payload}),result=await W.syncWindow(f.config,f.deps);
 assert.equal(result.status,'COMPLETE',JSON.stringify(result.handles.example.readiness));
 assert.equal(result.handles.example.observedCards,3);assert.equal(result.totals.downloaded,3);
 assert.deepEqual(JSON.parse(await fs.readFile(f.config.resultFile,'utf8')),result);
});
test('optional captions do not relax present caption types/bounds or other required fields',()=>{
 for(const child of [false,true])for(const patch of [r=>{r.c=null;},r=>{r.c=42;},r=>{r.c='x'.repeat(8193);},r=>{delete r.pd;},r=>{delete r.co;},r=>{delete r.hu;}]){
  const {payload}=synthetic();patch(child?payload.p[0].om[0]:payload.p[0]);
  assert.equal(F.decodeListingResponse(JSON.stringify(payload)).supported,false);
 }
});
test('video-child extension retains malformed variants, metadata and decoder bounds',()=>{
 for(const patch of [r=>{delete r.vhu;},r=>{r.vu=1;r.vhu=1;},r=>{r.vhu='different';},r=>{r.om=[];},r=>{r.pd=null;},r=>{r.extra='unknown';},r=>{r.vu='x'.repeat(8193);r.vhu=r.vu;}]){
  const {payload}=synthetic();patch(payload.p[0].om[0]);assert.equal(F.decodeListingResponse(JSON.stringify(payload)).supported,false);
 }
 for(const limits of [{maxRecords:0},{maxChildren:1},{maxTuples:2},{maxTextLength:1}]){
  assert.equal(F.decodeListingResponse(JSON.stringify(synthetic().payload),limits).reason,'listing-exceeds-decoder-bound');
 }
});
for(const [name,change] of [
 ['missing child','d.p[0].om.pop();'],['duplicate child','d.p[0].om.push(d.p[0].om[0]);'],
 ['child order','d.p[0].om.reverse();'],['child date','d.p[0].om[0].pd="2 January 2026";'],
 ['child type','delete d.p[0].om[0].vu;delete d.p[0].om[0].vhu;'],
 ['child identity','d.p[0].om[0].vhu="DIFFERENT";'],['child association','d.p[0].om[0].co="OTHER";']
])test('real video-child renderer cannot certify changed '+name,async t=>{
 const {payload}=synthetic(),f=await fixture(t,{payload,script:responsePage(change+paintNow)}),result=await W.syncWindow(f.config,f.deps);
 assert.notEqual(result.status,'COMPLETE');assert.equal(f.media.length,0);assert.equal(result.handles.example.readiness.binding.basis,null);
 assert.ok(['unrendered-response-tuples','listing-exceeds-response-tuples','listing-tuple-mismatch'].includes(result.handles.example.readiness.binding.reason));
});
// Synthetic sentinels must never be copied into diagnostics, even from corrupted observer data.
const SECRET='PRIVATE_SENTINEL_https://example.invalid/?token=never-persist';
const diagnosticCases=[
 {detail:'unknown-listing-field',mutate:p=>{p.p[0].om[0].c=null;}},
 {detail:'unsupported-listing-variant',mutate:p=>{p.p[0].om[0].om=[];}},
 {detail:'listing-exceeds-decoder-bound',mutate:p=>{p.p[0].om[0].c='x'.repeat(8193);}},
 {detail:'unreadable-listing-body',observe:s=>{s.bodies.bodies[0].text=null;}},
 {detail:'unparseable-listing-body',observe:s=>{s.bodies.bodies[0].text=SECRET;}},
 {detail:'unknown-listing-representation',observe:s=>{s.bodies.bodies[0].text='null';}},
 {detail:'body-observation-overflow',observe:s=>{s.bodies.overflow=SECRET;}},
 {detail:'response-body-count-mismatch',observe:s=>{s.bodies.bodies=[];}},
 {detail:'missing-response-body',observe:s=>{s.bodies.bodies[0].ordinal=999;}},
 ...['reading','unconsumed','unobserved','unreadable','oversized','released','cancelled'].map(state=>({detail:'body-'+state,observe:s=>{s.bodies.bodies[0].state=state;s.bodies.bodies[0].text=SECRET;}})),
 {detail:'body-state-unknown',observe:s=>{s.bodies.bodies[0].state=SECRET;}}
];
for(const c of diagnosticCases)test('persisted readiness gives closed-vocabulary detail '+c.detail,async t=>{
 const {payload}=synthetic();payload.pc=SECRET;payload.p[0].c=SECRET;c.mutate?.(payload);
 let snapshots=0;
 const f=await fixture(t,{payload,observe:c.observe?s=>{snapshots++;c.observe(s);}:null});
 const result=await W.syncWindow(f.config,f.deps),stored=JSON.parse(await fs.readFile(f.config.resultFile,'utf8'));
 assert.deepEqual(stored,result);assert.notEqual(stored.status,'COMPLETE');assert.equal(f.media.length,0);
 const readiness=stored.handles.example.readiness;
 assert.equal(readiness.binding.reason,c.detail==='body-reading'?'response-evidence-pending':'unknown-response-evidence');
 assert.equal(readiness.binding.detail,c.detail);
 assert.equal(readiness.binding.basis,null);assert.equal(W.localWindowReadiness(readiness),false);
 if(c.observe)assert.ok(snapshots>0,'the actual accepting snapshot must be intercepted');
 assert.equal(JSON.stringify(stored).includes('PRIVATE_SENTINEL'),false);
 assert.equal(JSON.stringify(stored).includes('/media?'),false);
 assert.ok(readiness.binding.detail.length<64);
});
test('real shared observer body overflow retains its distinct sanitized detail',async t=>{
 const {payload}=synthetic(),f=await fixture(t,{payload,script:responsePage(paintNow+'fetch("/api/posts").then(function(r){return r.json();});')});
 const context=await f.wrap.newContext({serviceWorkers:'block'}),page=await context.newPage(),budget=openBudget(f.config.requestLedger,'body-overflow');
 let error;
 try{await W.discover(page,'example',budget,Date.now()+15000,200,3000,{responseEvidence:{maxReceipts:8,maxBodies:1}});}catch(e){error=e;}finally{budget.close();}
 assert.equal(error?.code,'WINDOW_NOT_READY');assert.equal(error.details.readiness.binding.reason,'render-observation-unavailable');
 assert.equal(error.details.readiness.binding.detail,'body-observation-overflow');
 assert.equal((await F.readRenderObservation(page)).overflow,'body-observation-overflow');
});
test('receipt overflow is diagnosed separately without copying raw overflow text',async t=>{
 const {payload}=synthetic();
 const f=await fixture(t,{payload,script:responsePage(paintNow+'fetch("/api/posts").then(function(r){return r.json();});')});
 const context=await f.wrap.newContext({serviceWorkers:'block'}),page=await context.newPage(),budget=openBudget(f.config.requestLedger,'overflow');
 let error;
 try{await W.discover(page,'example',budget,Date.now()+15000,200,3000,{responseEvidence:{maxReceipts:1}});}catch(e){error=e;}finally{budget.close();}
 assert.equal(error?.code,'WINDOW_NOT_READY');assert.equal(error.details.readiness.binding.reason,'unknown-response-evidence');
 assert.equal(error.details.readiness.binding.detail,'receipt-observation-overflow');
});
