'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {openBudget}=require('../src/request-budget.js');
const ORIGIN='https://instacognito.com';
const epoch=Date.UTC(2026,0,1);
function clock(t){t.mock.timers.enable({apis:['Date'],now:epoch});return ms=>t.mock.timers.setTime(epoch+ms);}
async function legacy(t,denial){const file=path.join(await tmp(t),'legacy.json');await fs.writeFile(file,JSON.stringify({version:1,session_id:'old',requests:7,blocked:2,session_ceiling:120,hourly_ceiling:140,by_phase:{discovery:7},recent_request_ms:[epoch],denial,prior_sessions:[]}));return file;}
for(const kind of ['DENIED_AUTH','DENIED_CONTENT_WALL','DENIED_CHALLENGE_DOM','DENIED_ACCESS_DOM'])test('new run preserves '+kind+' history without inventing an eternal technical ban',async t=>{
 clock(t);const file=path.join(await tmp(t),'budget.json'),b=openBudget(file,'old');
 b.reserve('discovery');
 if(kind==='DENIED_AUTH')assert.throws(()=>b.inspect(403,{},ORIGIN));else b.deny(kind);
 const refusal=structuredClone(b.data.denial);assert.throws(()=>b.assert(),{code:'PROVIDER_DENIED'});b.close();
 const later=openBudget(file,'new');try{later.assert();assert.equal(later.data.denial,null);assert.deepEqual(later.data.denial_history,[refusal]);assert.equal(later.data.prior_sessions[0].requests,1);await later.admit('discovery');}finally{later.close();}
 const saved=JSON.parse(await fs.readFile(file,'utf8')),again=openBudget(file,'new');
 try{assert.deepEqual(again.data.denial_history,saved.denial_history);assert.deepEqual(again.data.denial_dispositions,saved.denial_dispositions);}finally{again.close();}
});
for(const header of ['60','Thu, 01 Jan 2026 00:01:00 GMT'])test('Retry-After '+header+' uses original observation time and expires only for a new run',async t=>{
 const set=clock(t),file=path.join(await tmp(t),'cooldown.json'),b=openBudget(file,'old');
 assert.throws(()=>b.inspect(429,{'retry-after':header},ORIGIN));const original=structuredClone(b.data.denial);
 set(60000);assert.throws(()=>b.assert(),{code:'PROVIDER_DENIED'});b.close();
 set(59999);const held=openBudget(file,'held');assert.throws(()=>held.reserve('discovery'),{code:'PROVIDER_DENIED'});assert.deepEqual(held.data.denial,original);held.close();
 set(60000);const free=openBudget(file,'free');try{free.reserve('discovery');assert.equal(free.data.denial,null);assert.deepEqual(free.data.denial_history,[original]);assert.equal(free.data.denial_dispositions[0].retry_at,'2026-01-01T00:01:00.000Z');}finally{free.close();}
 const old=openBudget(file,'old');try{assert.throws(()=>old.assert(),{code:'PROVIDER_DENIED'},'reusing the refused run ID cannot evade its latch');}finally{old.close();}
});
for(const header of [undefined,'','invalid','-1','0','Wed, 31 Dec 2025 23:59:59 GMT','9'.repeat(101)])test('unknown/elapsed Retry-After '+String(header).slice(0,15)+' is terminal now, never an eternal retry loop',async t=>{
 clock(t);const file=path.join(await tmp(t),'retry.json'),b=openBudget(file,'old');assert.throws(()=>b.inspect(429,{'retry-after':header},ORIGIN));assert.throws(()=>b.reserve('download'),{code:'PROVIDER_DENIED'});b.close();
 const next=openBudget(file,'owner-authorized-next');try{next.assert();assert.equal(next.data.denial,null);assert.equal(next.data.denial_dispositions[0].retry_time,['0','Wed, 31 Dec 2025 23:59:59 GMT'].includes(header)?'known':'unknown');}finally{next.close();}
});
for(const status of [401,407,451])test('actual HTTP '+status+' remains an unresolved cross-run prerequisite',async t=>{
 const set=clock(t),file=path.join(await tmp(t),'restriction.json'),b=openBudget(file,'old');assert.throws(()=>b.inspect(status,{},ORIGIN));b.close();set(86400000);
 const next=openBudget(file,'new');try{await assert.rejects(next.admit('discovery'),{code:'PROVIDER_DENIED'});}finally{next.close();}
});
test('503 Retry-After creates a temporary provider restriction with immutable history',async t=>{
 const set=clock(t),file=path.join(await tmp(t),'503.json'),b=openBudget(file,'old');assert.throws(()=>b.inspect(503,{'retry-after':'10'},ORIGIN),{code:'PROVIDER_DENIED'});b.close();
 set(9999);const next=openBudget(file,'held');assert.throws(()=>next.assert(),{code:'PROVIDER_DENIED'});next.close();set(10000);
 const free=openBudget(file,'free');try{free.assert();assert.equal(free.data.denial,null);assert.equal(free.data.denial_history[0].status,503);}finally{free.close();}
});
test('legacy migration preserves original refusal and session counters and is idempotent',async t=>{
 clock(t);const refusal={id:'legacy',kind:'DENIED_AUTH',status:403,at:'2025-12-31T00:00:00.000Z',session_id:'old',retry_after_raw:''},file=await legacy(t,refusal);
 const b=openBudget(file,'new');try{b.assert();assert.equal(b.data.denial,null);assert.deepEqual(b.data.denial_history,[refusal]);assert.equal(b.data.prior_sessions[0].blocked,2);assert.deepEqual(b.data.prior_sessions[0].by_phase,{discovery:7});assert.equal(b.data.denial_dispositions[0].policy,'public-provider-unpaced-v2');assert.equal(b.data.denial_dispositions[0].observed_at,refusal.at);assert.equal('handle' in b.data.denial_dispositions[0],false);}finally{b.close();}
 const before=JSON.parse(await fs.readFile(file,'utf8')),again=openBudget(file,'new');try{assert.deepEqual(again.data.denial_dispositions,before.denial_dispositions);}finally{again.close();}
});
test('foreign provider evidence cannot poison this provider or authorize another provider request',async t=>{
 clock(t);const refusal={id:'foreign',kind:'DENIED_AUTH',status:401,at:new Date().toISOString(),session_id:'old',provider_origin:'https://other.example.invalid'},file=await legacy(t,refusal);
 const b=openBudget(file,'new');try{b.assert();assert.equal(b.data.denial,null);assert.deepEqual(b.data.denial_history,[refusal]);assert.throws(()=>b.inspect(403,{},'https://other.example.invalid'),{code:'PROVIDER_SCOPE'});assert.equal(b.data.denial,null);}finally{b.close();}
});
test('malformed legacy refusal is an explicit accounting blocker, not silently discarded',async t=>{
 const file=await legacy(t,{id:'broken',kind:'RATE_LIMITED',status:429,at:'unknown',session_id:'old',retry_after_raw:'60'});
 await assert.rejects(async()=>openBudget(file,'new'),{code:'BAD_BUDGET'});
});
test('budget fetch refuses a foreign origin before accounting or network forwarding',async t=>{
 const file=path.join(await tmp(t),'origin.json'),b=openBudget(file,'origin');let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('x');});
 try{await assert.rejects(b.fetch('https://other.example.invalid/media',{}),{code:'PROVIDER_SCOPE'});assert.equal(calls,0);assert.equal(b.data.requests,0);assert.equal(b.data.denial,null);}finally{b.close();}
});
test('a later real authentication refusal is retained without replacing the first current-operation stop',async t=>{
 clock(t);const file=path.join(await tmp(t),'first-refusal.json'),b=openBudget(file,'old');
 assert.throws(()=>b.inspect(403,{},ORIGIN));const first=structuredClone(b.data.denial);
 assert.throws(()=>b.inspect(401,{},ORIGIN));assert.deepEqual(b.data.denial,first);assert.equal(b.signal.reason.code,'PROVIDER_DENIED');b.close();
 const next=openBudget(file,'new');try{assert.throws(()=>next.assert(),{code:'PROVIDER_DENIED'});assert.equal(next.data.denial.status,401);assert.deepEqual(next.data.denial_history[0],first);assert.equal(next.data.denial_history.length,2);}finally{next.close();}
});
test('closed budget cannot accept a late refusal or mutate durable history',async t=>{
 const file=path.join(await tmp(t),'closed.json'),b=openBudget(file,'closed');b.close();const bytes=await fs.readFile(file);
 assert.throws(()=>b.deny('DENIED_AUTH',{status:401}),{code:'BUDGET_CLOSED'});assert.deepEqual(await fs.readFile(file),bytes);
});
test('refusal and session history are not truncated after twenty new attempts',async t=>{
 clock(t);const file=path.join(await tmp(t),'many.json');const originals=[];
 for(let i=0;i<25;i++){const b=openBudget(file,'run-'+i);b.reserve('discovery');b.deny('DENIED_AUTH',{status:403});originals.push(structuredClone(b.data.denial));b.close();}
 const b=openBudget(file,'last');try{assert.deepEqual(b.data.denial_history,originals);assert.equal(b.data.prior_sessions.length,25);assert.equal(b.data.prior_sessions.reduce((n,s)=>n+s.requests,0),25);}finally{b.close();}
});
for(const age of [10000,60000])test('legacy 429 expiry uses its original timestamp, age '+age,async t=>{
 const set=clock(t),refusal={id:'legacy-429',kind:'RATE_LIMITED',status:429,at:new Date().toISOString(),session_id:'old',retry_after_raw:'60'},file=await legacy(t,refusal);set(age);
 const b=openBudget(file,'new');try{if(age<60000)assert.throws(()=>b.assert(),{code:'PROVIDER_DENIED'});else b.assert();assert.deepEqual(b.data.denial_history,[refusal]);assert.equal(b.data.denial_dispositions[0].retry_at,'2026-01-01T00:01:00.000Z');}finally{b.close();}
});
for(const pathname of ['/login','/captcha'])test('provider redirect '+pathname+' has an explicit evidenced lifetime',async t=>{
 clock(t);const file=path.join(await tmp(t),'redirect.json'),b=openBudget(file,'old');assert.throws(()=>b.inspect(302,{location:pathname},ORIGIN));b.close();
 const next=openBudget(file,'new');try{if(pathname==='/login')assert.throws(()=>next.assert(),{code:'PROVIDER_DENIED'});else next.assert();assert.equal(next.data.denial_history[0].kind,'DENIED_CHALLENGE');}finally{next.close();}
});
async function tmp(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-policy-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('public-provider admissions and reopen add no pacing timers and retain explicit caps',async t=>{
 const file=path.join(await tmp(t),'budget.json'),b=openBudget(file,'first',3);
 let timers=0;const original=setTimeout;
 t.mock.method(globalThis,'setTimeout',(...args)=>{timers++;return original(...args);});
 try{await Promise.all([b.admit('discovery'),b.admit('discovery'),b.admit('download')]);assert.equal(b.data.requests,3);assert.equal(timers,0);assert.equal(b.data.quota_policy,'public-provider-unpaced-v2');await assert.rejects(b.admit('download'),{code:'REQUEST_LIMIT'});}finally{b.close();}
 const next=openBudget(file,'next');try{await next.admit('discovery');assert.equal(timers,0);assert.equal(next.data.recent_request_ms.length,4);}finally{next.close();}
});
test('standalone archive has zero default delay but preserves an explicit caller delay',async t=>{
 const timers=require('node:timers/promises'),file=require.resolve('../src/index.js'),cached=require.cache[file],waits=[];
 const original=timers.setTimeout;let F;
 try{timers.setTimeout=async ms=>{waits.push(ms);};delete require.cache[file];F=require(file);}finally{timers.setTimeout=original;if(cached)require.cache[file]=cached;else delete require.cache[file];}
 const root=await tmp(t),jpg=Buffer.from([255,216,255,224,1,2,3,4,255,217]);
 for(const explicit of [false,true]){
  waits.length=0;
  const result=await F.archiveProfile({handle:'example',output:path.join(root,explicit?'explicit':'default'),...(explicit?{delayMs:17}:{}),
   sections:[{category:'posts',status:'COMPLETE',reportedTotal:1,items:[{shortcode:'POST',href:'https://instacognito.com/media?id=ITEM',mediaType:'image',dateRaw:'1 January 2026'}]}],
   dnsLookup:async()=>[{address:'93.184.216.34',family:4}],fetchImpl:async()=>new Response(jpg,{headers:{'content-type':'image/jpeg'}})});
  assert.equal(result.acquisition.runDownloaded,1);
  assert.deepEqual(waits,explicit?[17]:[]);
 }
});
test('unpaced serial queue rechecks abort, denial, close and absolute deadline before debit',async t=>{
 for(const kind of ['abort','denial','close','deadline']){
  const b=openBudget(path.join(await tmp(t),kind+'.json'),kind),ac=new AbortController();
  const queued=b.admit('discovery',ac.signal,kind==='deadline'?Date.now()-1:undefined);
  if(kind==='abort')ac.abort(new Error('caller abort'));
  if(kind==='denial')assert.throws(()=>b.inspect(403,{},'https://instacognito.com'));
  if(kind==='close')b.close();
  await assert.rejects(queued);assert.equal(b.data.requests,0);b.close();
 }
});
