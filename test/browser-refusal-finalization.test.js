'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),native=require('node:fs'),path=require('node:path');
const {setup,transport,F}=require('./fixtures/browser-lifecycle.cjs');
const W=require('../src/sync-window.js');

// Hold delivery, not observation: every result below came from the real fixture DOM.
for(const mode of ['healthy','success','rejection','never','late-refusal','late-rejection','deadline','shared-denial'])test('R2 finalization '+mode+' is bounded and cannot mutate a closed ledger',async t=>{
 const x=await setup(t),nc=x.browser.newContext.bind(x.browser),observe=F.observeWindowSnapshot,clock=Date.now;
 let closing=false,captured=false,delivered=false,release,closedAt,clockOffset=0,samples=0,max=0,inFlight=0;
 const gate=new Promise(r=>release=r);
 F.observeWindowSnapshot=async(p,args)=>{
  if(!args.refusalOnly)return observe(p,args);
  inFlight++;max=Math.max(max,inFlight);samples++;
  try{
   const r=await observe(p,args);
   if(closing&&mode!=='healthy'){
    captured=true;await gate;delivered=true;
    if(mode==='rejection'||mode==='late-rejection')throw new Error('held observation failed');
   }
   return r;
  }finally{inFlight--;}
 };
 x.browser.newContext=async o=>{
  const c=await nc(o),np=c.newPage.bind(c);
  await c.route('**/api/seam-denial',route=>route.fulfill({status:403,body:'denied'}));
  c.newPage=async()=>{
   const p=await np(),close=p.close.bind(p);
   p.close=async()=>{
    if(!closing){
     closing=true;
     if(mode==='late-refusal')await p.evaluate(()=>{const e=document.createElement('div');e.id='challenge-form';e.textContent='refused';document.body.append(e);});
     if(mode!=='healthy')await waitFor(()=>captured,600);
     if(mode==='shared-denial')await p.evaluate(()=>fetch('/api/seam-denial').then(r=>r.status));
     await close();closedAt=clock();
     if(mode==='deadline'){clockOffset=x.config.maxTimeMs;Date.now=()=>clock()+clockOffset;}
     if(['success','rejection','shared-denial'].includes(mode))setTimeout(release,150);
    }else await close();
   };return p;
  };return c;
 };
 let result,before,after,samplesAtReturn;
 try{
  result=await W.syncWindow(x.config,x.deps);
  if(mode==='success')assert.equal(delivered,true,'successful close must await its admitted observation');
  assert.ok(clock()-closedAt<1800,'finalization must not wait for a stuck sample');
  samplesAtReturn=samples;
  assert.equal(await fs.stat(x.config.requestLedger+'.window-lock').catch(e=>e.code),'ENOENT');
  before=await fs.readFile(x.config.requestLedger);const stored=await fs.readFile(x.config.resultFile);
  release();await pause(180);
  after=await fs.readFile(x.config.requestLedger);
  assert.deepEqual(after,before,'late sample must never save through a released ledger');
  assert.deepEqual(await fs.readFile(x.config.resultFile),stored);
  assert.equal(samples,samplesAtReturn,'no observations admitted after finalization');
 }finally{release();Date.now=clock;F.observeWindowSnapshot=observe;}
 assert.equal(max,1);assert.ok(samples>0);
 if(mode==='healthy'||mode==='success')assert.equal(result.status,'COMPLETE');
 else{
  assert.notEqual(result.status,'COMPLETE');assert.notEqual(result.handles.example.status,'COMPLETE');
  if(mode==='deadline')assert.equal(result.error.code,'TIME_LIMIT');
  if(mode==='rejection')assert.equal(result.error.code,'BROWSER_TRANSPORT');
  if(['never','late-refusal','late-rejection'].includes(mode))assert.equal(result.error.code,'BROWSER_CLEANUP');
  if(mode==='shared-denial'){assert.equal(result.status,'BLOCKED');assert.equal(result.requests.denial.kind,'DENIED_AUTH');}
 }
 const paths=F.profilePaths(x.config.output,'example'),files=await contents(paths);
 assert.equal(files.media.length,2);assert.equal(files.receipts.length,2);
 for(const name of files.receipts)assert.equal(await F.verifyReceipt(paths,JSON.parse(await fs.readFile(path.join(paths.receiptDir,name)))),true);
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const contents=async p=>({media:await fs.readdir(p.mediaDir).catch(()=>[]),receipts:await fs.readdir(p.receiptDir).catch(()=>[])});
async function waitFor(fn,ms=1000){const end=Date.now()+ms;while(!fn()&&Date.now()<end)await pause(10);assert.ok(fn(),'seam reached');}

for(const id of ['challenge-form','error-private'])test('REREVIEW pending '+id+' snapshot at owned page close cannot be discarded',async t=>{
 const x=await setup(t),nc=x.browser.newContext.bind(x.browser),observe=F.observeWindowSnapshot;
 let closing=false,captured=false,release;const gate=new Promise(r=>release=r);
 F.observeWindowSnapshot=async(p,args)=>{const r=await observe(p,args);if(args.refusalOnly&&closing&&(r.challenge||r.sectionError==='error-private')){captured=true;await gate;}return r;};
 x.browser.newContext=async o=>{const c=await nc(o),np=c.newPage.bind(c);c.newPage=async()=>{const p=await np(),close=p.close.bind(p);p.close=async()=>{
  if(!closing){closing=true;await p.evaluate(id=>{const e=document.createElement('div');e.id=id;e.textContent='refused';document.body.append(e);},id);await waitFor(()=>captured,600);}
  const r=await close();setTimeout(release,150);return r;
 };return p;};return c;};
 let result;try{result=await W.syncWindow(x.config,x.deps);await pause(220);}finally{release();F.observeWindowSnapshot=observe;}
 const ledger=JSON.parse(await fs.readFile(x.config.requestLedger)),stored=JSON.parse(await fs.readFile(x.config.resultFile)),files=await contents(F.profilePaths(x.config.output,'example'));
 console.log('REREVIEW_PENDING_REFUSAL',JSON.stringify({id,captured,status:result.status,handle:result.handles.example.status,denial:ledger.denial,storedStatus:stored.status,files}));
 assert.equal(captured,true);assert.equal(result.status,'BLOCKED');assert.ok(ledger.denial);assert.notEqual(result.handles.example.status,'COMPLETE');
});

for(const id of ['challenge-form','error-private'])test('REREVIEW control '+id+' delivered before page closure latches denial',async t=>{
 const x=await setup(t),nc=x.browser.newContext.bind(x.browser),observe=F.observeWindowSnapshot;let closing=false,captured=false;
 F.observeWindowSnapshot=async(p,args)=>{const r=await observe(p,args);if(args.refusalOnly&&closing&&(r.challenge||r.sectionError==='error-private'))captured=true;return r;};
 x.browser.newContext=async o=>{const c=await nc(o),np=c.newPage.bind(c);c.newPage=async()=>{const p=await np(),close=p.close.bind(p);p.close=async()=>{if(!closing){closing=true;await p.evaluate(id=>{const e=document.createElement('div');e.id=id;e.textContent='refused';document.body.append(e);},id);await waitFor(()=>captured,600);await pause(20);}return close();};return p;};return c;};
 let result;try{result=await W.syncWindow(x.config,x.deps);}finally{F.observeWindowSnapshot=observe;}
 const ledger=JSON.parse(await fs.readFile(x.config.requestLedger));console.log('REREVIEW_CLOSE_CONTROL',JSON.stringify({id,captured,status:result.status,denial:ledger.denial?.kind}));assert.equal(result.status,'BLOCKED');assert.equal(ledger.denial.kind,id==='challenge-form'?'DENIED_CHALLENGE_DOM':'DENIED_ACCESS_DOM');assert.notEqual(result.handles.example.status,'COMPLETE');
});
