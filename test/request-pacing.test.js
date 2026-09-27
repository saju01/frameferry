'use strict';
// Optional caller pacing between serialized request admissions. Every test here uses
// deterministic mocked time and stubbed transports: no provider is contacted.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const W=require('../src/sync-window.js'),{openBudget,MIN_REQUEST_INTERVAL_MS,MAX_REQUEST_INTERVAL_MS}=require('../src/request-budget.js');
const ORIGIN='https://instacognito.com';
const epoch=Date.UTC(2026,0,1);
async function tmp(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-pacing-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
async function ledger(t,name='budget.json'){return path.join(await tmp(t),name);}
// Date AND setTimeout are mocked together: a pacing wait is only deterministic when the
// clock the interval is measured against and the timer that ends it advance as one.
function clock(t){t.mock.timers.enable({apis:['Date','setTimeout'],now:epoch});return ms=>t.mock.timers.tick(ms);}
// A tick fires timers synchronously; the admission continuations behind them are
// microtasks, so settle them before asserting on what did or did not happen.
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function track(promise){
 const state={settled:false,value:undefined,error:undefined};
 promise.then(value=>{state.settled=true;state.value=value;},error=>{state.settled=true;state.error=error;});
 return state;
}

test('an explicit interval spaces consecutive admissions from the last debited request',async t=>{
 const tick=clock(t),file=await ledger(t),b=openBudget(file,'paced',undefined,250);
 t.after(()=>b.close());
 // The first admission of a run has nothing to be spaced from and never waits.
 await b.admit('discovery');
 assert.equal(b.data.requests,1);assert.equal(Date.now(),epoch);
 const second=track(b.admit('download'));
 await flush();assert.equal(second.settled,false);assert.equal(b.data.requests,1);
 tick(249);await flush();
 assert.equal(second.settled,false,'the gap is the full configured interval, not a shorter one');
 assert.equal(b.data.requests,1);
 tick(1);await flush();
 assert.equal(second.settled,true);assert.equal(second.error,undefined);
 assert.equal(b.data.requests,2);
 assert.deepEqual(b.data.recent_request_ms,[epoch,epoch+250]);
});

test('concurrent admissions stay serialized and each one is spaced, across both phases',async t=>{
 const tick=clock(t),file=await ledger(t),b=openBudget(file,'concurrent',undefined,250);
 t.after(()=>b.close());
 const order=[];
 const all=Promise.all(['discovery','download','discovery'].map((phase,i)=>b.admit(phase).then(()=>order.push(i))));
 await flush();assert.deepEqual(order,[0],'a queued caller cannot slip past the interval');
 tick(250);await flush();assert.deepEqual(order,[0,1]);
 tick(249);await flush();assert.deepEqual(order,[0,1]);
 tick(1);await flush();assert.deepEqual(order,[0,1,2]);
 await all;
 assert.deepEqual(b.data.recent_request_ms,[epoch,epoch+250,epoch+500]);
 assert.deepEqual(b.data.by_phase,{discovery:2,download:1});
});

test('media acquisition is paced through the same admission gap as discovery',async t=>{
 const tick=clock(t),file=await ledger(t),b=openBudget(file,'download-pace',undefined,250);
 t.after(()=>b.close());
 let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(Buffer.from([255,216,255,217]),{headers:{'content-type':'image/jpeg'}});});
 await b.admit('discovery');
 const download=track(b.fetch(ORIGIN+'/media?id=ITEM',{}));
 await flush();
 assert.equal(calls,0,'the request is not forwarded before its interval has elapsed');
 assert.equal(b.data.requests,1);
 tick(250);await flush();
 assert.equal(calls,1);assert.equal(download.error,undefined);
 assert.equal(b.data.by_phase.download,1);assert.equal(b.data.requests,2);
});

test('a lapsed absolute deadline cuts a pacing wait short instead of sleeping past it',async t=>{
 const tick=clock(t),file=await ledger(t),b=openBudget(file,'deadline',undefined,1000);
 t.after(()=>b.close());
 await b.admit('discovery');
 const queued=track(b.admit('download',undefined,Date.now()+100));
 await flush();assert.equal(queued.settled,false);
 tick(100);await flush();
 assert.equal(queued.settled,true,'the wait ends at the deadline, not after the full interval');
 assert.equal(queued.error?.code,'TIME_LIMIT');
 assert.equal(Date.now(),epoch+100);
 assert.equal(b.data.requests,1,'a lapsed job never debits the ledger');
});

test('an aborted caller signal cuts a pacing wait short with no time elapsed',async t=>{
 clock(t);const file=await ledger(t),b=openBudget(file,'abort',undefined,1000),ac=new AbortController();
 t.after(()=>b.close());
 await b.admit('discovery');
 const queued=track(b.admit('download',ac.signal));
 await flush();assert.equal(queued.settled,false);
 ac.abort(new Error('caller abort'));
 await flush();
 assert.equal(queued.settled,true,'abort is observed promptly, without waiting out the interval');
 assert.equal(Date.now(),epoch);
 assert.match(String(queued.error?.message),/caller abort/);
 assert.equal(b.data.requests,1);
});

test('a refusal recorded during a pacing wait ends it and keeps denial precedence',async t=>{
 clock(t);const file=await ledger(t),b=openBudget(file,'denied-mid-wait',undefined,1000),ac=new AbortController();
 t.after(()=>b.close());
 await b.admit('discovery');
 const queued=track(b.admit('download',ac.signal));
 await flush();assert.equal(queued.settled,false);
 // Both stops arrive while the caller is waiting; the recorded denial must be the one reported.
 ac.abort(new Error('caller abort'));
 assert.throws(()=>b.inspect(429,{'retry-after':'60'},ORIGIN),{code:'PROVIDER_DENIED'});
 await flush();
 assert.equal(queued.settled,true);assert.equal(queued.error?.code,'PROVIDER_DENIED');
 assert.equal(Date.now(),epoch);
 assert.equal(b.data.requests,1);
});

test('closing a run releases a pacing wait and reports the ordinary closed refusal',async t=>{
 clock(t);const file=await ledger(t),b=openBudget(file,'closed-mid-wait',undefined,1000);
 await b.admit('discovery');
 const queued=track(b.admit('download'));
 await flush();assert.equal(queued.settled,false);
 b.close();
 await flush();
 assert.equal(queued.settled,true);assert.equal(queued.error?.code,'BUDGET_CLOSED');
 assert.equal(Date.now(),epoch);
 assert.equal(JSON.parse(await fs.readFile(file,'utf8')).requests,1);
});

test('the default remains unpaced: no interval, no timer and no change in admission order',async t=>{
 const file=await ledger(t),b=openBudget(file,'unpaced');
 let timers=0;const original=setTimeout;
 t.mock.method(globalThis,'setTimeout',(...args)=>{timers++;return original(...args);});
 const order=[];
 try{
  await Promise.all(['discovery','download','discovery'].map((phase,i)=>b.admit(phase).then(()=>order.push(i))));
  assert.deepEqual(order,[0,1,2]);
  assert.equal(timers,0,'the unpaced default must arm no wait of its own');
  assert.equal(b.data.requests,3);
  assert.equal(b.data.min_request_interval_ms,MIN_REQUEST_INTERVAL_MS);
  assert.equal(b.data.min_request_interval_ms,0);
  assert.equal(b.data.quota_policy,'public-provider-unpaced-v2');
 }finally{b.close();}
 // An explicit zero is the same documented behaviour, not a separate mode.
 const zero=openBudget(file,'explicit-zero',undefined,0);
 try{await zero.admit('discovery');assert.equal(timers,0);assert.equal(zero.data.min_request_interval_ms,0);}finally{zero.close();}
});

test('the effective interval is recorded in the ledger and republished on reopen',async t=>{
 const file=await ledger(t),b=openBudget(file,'records',undefined,250);
 try{
  await b.admit('discovery');
  assert.equal(b.data.min_request_interval_ms,250);
  const saved=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(saved.min_request_interval_ms,250);
  // Pacing is a caller job bound, not a new denial-interpretation policy, so the
  // versioned policy name and its dispositions are untouched by it.
  assert.equal(saved.quota_policy,'public-provider-unpaced-v2');
  assert.equal(saved.session_ceiling,null);
  assert.equal(saved.hourly_ceiling,null);
 }finally{b.close();}
 const next=openBudget(file,'reopened-without-pacing');
 try{
  assert.equal(next.data.min_request_interval_ms,0,'a later run states its own interval, never inherits one');
  assert.equal(next.data.quota_policy,'public-provider-unpaced-v2');
 }finally{next.close();}
 const again=openBudget(file,'reopened-with-pacing',undefined,MAX_REQUEST_INTERVAL_MS);
 try{assert.equal(again.data.min_request_interval_ms,MAX_REQUEST_INTERVAL_MS);}finally{again.close();}
});

test('an unusable interval is a typed refusal before the ledger is claimed',async t=>{
 const root=await tmp(t);
 for(const value of [-1,0.5,250.5,'250',null,NaN,Infinity,MAX_REQUEST_INTERVAL_MS+1,60000,Number.MAX_SAFE_INTEGER+2]){
  const file=path.join(root,'rejected.json');
  assert.throws(()=>openBudget(file,'bad-interval',undefined,value),{code:'BAD_BUDGET'},'rejects '+String(value));
  assert.equal(await fs.stat(file+'.window-lock').catch(()=>null),null,'no lock is left behind for '+String(value));
 }
});

test('sync-window accepts the caller interval and publishes it with the request accounting',async t=>{
 const root=await tmp(t),output=path.join(root,'out');await fs.mkdir(output);
 let launches=0;
 const deps={chromium:{launch:async()=>{launches++;throw new Error('browser intentionally unavailable');}}};
 const base={handles:[{handle:'example',dateAfter:'2026-01-01'}],runId:'paced-window',output,requestLedger:path.join(root,'budget.json')};
 const result=await W.syncWindow({...base,resultFile:path.join(root,'result.json'),minRequestIntervalMs:250},deps);
 assert.equal(launches,1);
 assert.equal(result.status,'PARTIAL');
 assert.equal(result.requests.minRequestIntervalMs,250);
 assert.equal(result.requests.quotaPolicy,'public-provider-unpaced-v2');
 assert.equal(result.requests.session,0);
 const published=JSON.parse(await fs.readFile(path.join(root,'result.json'),'utf8'));
 assert.equal(published.requests.minRequestIntervalMs,250);
 // Omitting the setting keeps the documented unpaced default in the published receipt.
 const unpaced=await W.syncWindow({...base,runId:'unpaced-window',resultFile:path.join(root,'unpaced.json')},deps);
 assert.equal(unpaced.requests.minRequestIntervalMs,0);
 // An unusable value is refused before any browser is launched.
 await assert.rejects(W.syncWindow({...base,runId:'bad-window',resultFile:path.join(root,'bad.json'),minRequestIntervalMs:-5},deps),{code:'BAD_BUDGET'});
 assert.equal(launches,2);
});

// A minimal guarded page: the same route/response seams installGuards binds, with no
// browser, no fixture and no provider. Only request admission is exercised here.
const guardPage=()=>{
 let handler;const page={route:async(_,h)=>{handler=h;},on:()=>{}};
 return {page,send:(counters,type='document',pathname='/api/posts')=>handler({
  request:()=>({url:()=>ORIGIN+pathname,resourceType:()=>type}),
  fallback:async()=>{counters.allowed++;},
  abort:async reason=>{counters.aborted++;counters.reasons.push(reason);}})};
};
const counters=()=>({allowed:0,aborted:0,reasons:[]});

test('the accepted maximum interval stays well below the deadlines a paced wait is spent from',async t=>{
 // A paced wait elapses INSIDE the deadlines the run already has, so no accepted
 // interval may be able to consume one on its own: 30s is the per-file acquisition
 // window and 45s the profile readiness wait a discovery request is issued under
 // (both in src/sync-window.js), and both are shorter than the job's own maxTimeMs.
 assert.equal(MIN_REQUEST_INTERVAL_MS,0);
 assert.equal(MAX_REQUEST_INTERVAL_MS,5000);
 assert.ok(MAX_REQUEST_INTERVAL_MS*6<=30000,'the ceiling must leave the 30s per-file window usable');
 assert.ok(MAX_REQUEST_INTERVAL_MS*6<=45000,'the ceiling must leave the 45s readiness wait usable');
 const file=await ledger(t);
 assert.throws(()=>openBudget(file,'too-slow',undefined,MAX_REQUEST_INTERVAL_MS+1),{code:'BAD_BUDGET',message:/from 0 to 5000/});
 const ok=openBudget(file,'at-ceiling',undefined,MAX_REQUEST_INTERVAL_MS);
 try{assert.equal(ok.data.min_request_interval_ms,5000);}finally{ok.close();}
});

test('an exhausted allowance is refused at once, not one interval later',async t=>{
 const tick=clock(t),file=await ledger(t),b=openBudget(file,'exhausted',1,250);
 t.after(()=>b.close());
 await b.admit('discovery');
 assert.equal(b.data.requests,1);
 const refused=track(b.admit('download'));
 await flush();
 assert.equal(refused.settled,true,'no gap is waited out before a refusal pacing could never have changed');
 assert.equal(refused.error?.code,'REQUEST_LIMIT');
 assert.equal(Date.now(),epoch,'the refusal costs no wall-clock time at all');
 // The accounting is exactly what reserve() records for an exhausted allowance,
 // persisted, not a second bespoke path that skips the blocked count.
 assert.equal(b.data.blocked,1);assert.equal(b.data.requests,1);
 const saved=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(saved.blocked,1);assert.equal(saved.requests,1);
 // And the latched stop stands: later time does not turn the refusal into an admission.
 tick(1000);await flush();
 await assert.rejects(b.admit('discovery'),{code:'REQUEST_LIMIT'});
 assert.equal(b.data.requests,1);assert.equal(b.data.blocked,1);
});

test('a recorded refusal still outranks an exhausted allowance in the same admission',async t=>{
 clock(t);const file=await ledger(t),b=openBudget(file,'exhausted-and-denied',1,250);
 t.after(()=>b.close());
 await b.admit('discovery');
 assert.throws(()=>b.inspect(403,{},ORIGIN),{code:'PROVIDER_DENIED'});
 const refused=track(b.admit('download'));
 await flush();
 assert.equal(refused.settled,true);
 assert.equal(refused.error?.code,'PROVIDER_DENIED','the early allowance check must not downgrade a recorded denial');
 assert.equal(b.data.blocked,0,'a denied admission is not also counted as allowance-blocked');
 assert.equal(Date.now(),epoch);
});

test('a queued admission waits only the remainder of the interval',async t=>{
 const tick=clock(t),file=await ledger(t),b=openBudget(file,'remainder',undefined,250);
 t.after(()=>b.close());
 await b.admit('discovery');
 // 100ms of the caller's own work has already passed since that debited request.
 tick(100);
 const second=track(b.admit('download'));
 await flush();assert.equal(second.settled,false);
 tick(149);await flush();
 assert.equal(second.settled,false,'the remainder is measured from the last debited request');
 assert.equal(b.data.requests,1);
 tick(1);await flush();
 assert.equal(second.settled,true);assert.equal(second.error,undefined);
 assert.equal(Date.now(),epoch+250,'one interval after the first request, not a full interval after queueing');
 assert.deepEqual(b.data.recent_request_ms,[epoch,epoch+250]);
 // A gap that has already fully elapsed owes nothing and arms no wait.
 tick(250);
 const third=track(b.admit('discovery'));
 await flush();
 assert.equal(third.settled,true,'an interval already elapsed must not be waited again');
 assert.equal(third.error,undefined);
 assert.equal(Date.now(),epoch+500);assert.equal(b.data.requests,3);
});

test('an admission that fails after waiting does not compound the next gap',async t=>{
 const tick=clock(t),file=await ledger(t),b=openBudget(file,'no-compound',undefined,250);
 t.after(()=>b.close());
 await b.admit('discovery');
 // This one waits out 100ms of the gap and then dies on its own short deadline.
 const doomed=track(b.admit('download',undefined,Date.now()+100));
 await flush();assert.equal(doomed.settled,false);
 tick(100);await flush();
 assert.equal(doomed.settled,true);assert.equal(doomed.error?.code,'TIME_LIMIT');
 assert.equal(b.data.requests,1,'a failed admission debits nothing');
 // The next caller is still spaced from the last DEBITED request, so only the
 // remaining 150ms is owed: the abandoned wait is not charged a second time.
 const next=track(b.admit('download'));
 await flush();assert.equal(next.settled,false);
 tick(149);await flush();assert.equal(next.settled,false,'the failed wait must not have reset the gap');
 tick(1);await flush();
 assert.equal(next.settled,true);assert.equal(next.error,undefined);
 assert.equal(Date.now(),epoch+250,'the gap is still one interval from the first request, not two');
 assert.equal(b.data.requests,2);
 assert.deepEqual(b.data.recent_request_ms,[epoch,epoch+250]);
});

test('a backward wall-clock step cannot stretch a wait beyond the configured interval',async t=>{
 const tick=clock(t),file=await ledger(t),b=openBudget(file,'clock-jump',undefined,250);
 t.after(()=>b.close());
 await b.admit('discovery');
 // The host clock steps back an hour after that request was debited. A remainder
 // computed from the now-future timestamp alone would be an hour long; the most the
 // caller asked to wait is the gap itself.
 const jumped=epoch-3600000;
 t.mock.timers.setTime(jumped);
 const second=track(b.admit('download'));
 await flush();assert.equal(second.settled,false);
 tick(249);await flush();assert.equal(second.settled,false);
 tick(1);await flush();
 assert.equal(second.settled,true,'the wait is capped at the interval, not at the size of the jump');
 assert.equal(second.error,undefined);
 assert.equal(Date.now(),jumped+250);assert.equal(b.data.requests,2);
});

test('browser request admission observes the caller interval before forwarding',async t=>{
 const tick=clock(t),file=await ledger(t),b=openBudget(file,'guarded',undefined,250);
 t.after(()=>b.close());
 const g=guardPage(),c=counters();
 await W.installGuards(g.page,b,Date.now()+60000);
 await g.send(c);
 assert.deepEqual([c.allowed,c.aborted],[1,0]);
 assert.equal(b.data.requests,1);
 const queued=track(g.send(c,'fetch','/media?id=ITEM'));
 await flush();
 assert.equal(c.allowed,1,'the next provider request is not forwarded inside the gap');
 assert.equal(b.data.requests,1);
 tick(250);await flush();
 assert.equal(queued.settled,true);
 assert.equal(c.allowed,2);assert.equal(c.aborted,0);
 assert.equal(b.data.requests,2);
 assert.equal(b.data.by_phase.download,1,'a /media fetch is admitted as a download and paced by the same gap');
 assert.deepEqual(b.data.recent_request_ms,[epoch,epoch+250]);
});

test('a caller deadline shorter than the interval aborts before forwarding and leaves accounting unchanged',async t=>{
 const tick=clock(t),file=await ledger(t),b=openBudget(file,'guard-deadline',undefined,1000);
 t.after(()=>b.close());
 const g=guardPage(),c=counters();
 await W.installGuards(g.page,b,Date.now()+100);
 await g.send(c);
 assert.deepEqual([c.allowed,c.aborted],[1,0]);
 const queued=track(g.send(c,'fetch','/media?id=ITEM'));
 await flush();assert.equal(queued.settled,false);
 tick(100);await flush();
 assert.equal(queued.settled,true,'the wait ends on the lapsed deadline, not after the full interval');
 assert.equal(c.allowed,1,'a request that outlived its deadline is never forwarded');
 assert.equal(c.aborted,1);assert.deepEqual(c.reasons,['blockedbyclient']);
 assert.equal(Date.now(),epoch+100);
 assert.equal(b.data.requests,1,'accounting is unchanged by the aborted admission');
 assert.equal(b.data.blocked,0);
 assert.deepEqual(b.data.recent_request_ms,[epoch]);
 assert.equal(JSON.parse(await fs.readFile(file,'utf8')).requests,1);
});

test('a completed session keeps the interval it ran under in prior_sessions',async t=>{
 const file=await ledger(t);
 const first=openBudget(file,'paced-session',undefined,250);
 try{await first.admit('discovery');}finally{first.close();}
 const second=openBudget(file,'unpaced-session');
 try{
  const prior=second.data.prior_sessions.at(-1);
  assert.equal(prior.session_id,'paced-session');
  assert.equal(prior.requests,1);
  assert.equal(prior.min_request_interval_ms,250,'history records how that session was paced, not this caller\'s value');
  assert.equal(second.data.min_request_interval_ms,0);
  await second.admit('discovery');
 }finally{second.close();}
 const third=openBudget(file,'later-session',undefined,1000);
 try{
  const [paced,unpaced]=third.data.prior_sessions.slice(-2);
  assert.equal(paced.min_request_interval_ms,250,'an earlier session record stays frozen across later runs');
  assert.equal(unpaced.session_id,'unpaced-session');
  assert.equal(unpaced.min_request_interval_ms,0,'an explicitly unpaced session is recorded as 0, not as absent');
  assert.equal(third.data.min_request_interval_ms,1000);
 }finally{third.close();}
 const saved=JSON.parse(await fs.readFile(file,'utf8'));
 assert.deepEqual(saved.prior_sessions.map(x=>x.min_request_interval_ms),[250,0]);
});

test('a ledger written before pacing rolls over with an unknown interval, never an invented one',async t=>{
 const file=await ledger(t);
 // Exactly the shape an earlier release persisted: no min_request_interval_ms at all.
 await fs.writeFile(file,JSON.stringify({version:1,session_id:'LEGACY',requests:3,blocked:1,session_ceiling:120,hourly_ceiling:140,by_phase:{discovery:3},recent_request_ms:[],denial:null,prior_sessions:[]}));
 const b=openBudget(file,'migrating',undefined,250);
 try{
  const prior=b.data.prior_sessions.at(-1);
  assert.equal(prior.session_id,'LEGACY');
  assert.equal(prior.requests,3);assert.equal(prior.blocked,1);
  assert.equal(prior.session_ceiling,120,'the old ledger\'s own ceiling, not this caller\'s cap');
  assert.equal(prior.min_request_interval_ms,null,'an unknown historical interval is null, never 0 and never this run\'s 250');
  assert.equal(b.data.min_request_interval_ms,250);
  assert.deepEqual(b.data.previous_local_ceilings,{session:120,hour:140});
 }finally{b.close();}
 const saved=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(saved.prior_sessions[0].min_request_interval_ms,null);
});
