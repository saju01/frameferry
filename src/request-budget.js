'use strict';
// Public InstaCognito traffic: shared accounting and pacing, not a signed-account quota.
// Preserve real provider denials and history. Optional maxRequests is a caller job bound.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ArchiveError } = require('./index.js');
const HOUR_MS = 3600000, MIN_REQUEST_INTERVAL_MS = 500;
function cap(value) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new ArchiveError('BAD_BUDGET', 'optional maxRequests must be a positive safe integer');
  return value;
}
// The pacing wait must be cancellable: an admission queued behind others is
// otherwise stuck for the full interval even once its caller's deadline or abort
// has passed, and it would then still reserve on the far side of that wait.
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { detach(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); detach(); reject(signal.reason); };
    const detach = () => { signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
function atomic(file, doc) {
  const tmp=file+'.tmp-'+process.pid;
  fs.writeFileSync(tmp, JSON.stringify(doc,null,2), {mode:0o600});
  fs.renameSync(tmp,file);
}
function openBudget(file, runId, limit) {
  if (!file || typeof runId !== 'string' || !/^[A-Za-z0-9._-]{1,150}$/.test(runId)) throw new ArchiveError('BAD_BUDGET','ledger path and safe run ID required');
  const maximum=cap(limit); file=path.resolve(file);
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new ArchiveError('BAD_BUDGET','ledger cannot be a symlink');
  const lock=file+'.window-lock'; let fd,lockIdentity=null;
  try { fd=fs.openSync(lock,'wx',0o600); }
  catch(e) { throw new ArchiveError('BUDGET_LOCKED','request ledger already owned; inspect stale locks explicitly'); }
  // The lock is identified by the inode this owner created, not by its pathname:
  // cleanup below refuses to unlink anything else. If the owner record cannot be
  // written we never held a usable claim, so the lock WE created is removed here
  // rather than left behind as a stale claim nobody owns.
  try { const stat=fs.fstatSync(fd); lockIdentity={dev:stat.dev,ino:stat.ino}; fs.writeSync(fd,JSON.stringify({pid:process.pid,runId})); }
  catch(e) {
    try{fs.closeSync(fd);}catch(ignored){}
    try{const stat=fs.lstatSync(lock);if(!lockIdentity||(stat.dev===lockIdentity.dev&&stat.ino===lockIdentity.ino))fs.unlinkSync(lock);}catch(ignored){}
    fd=undefined;
    throw new ArchiveError('BAD_BUDGET','cannot record request ledger ownership ('+(e.code||e.message)+')');
  }
  let d,stopped=null,closeError=null,jobDeadline=Infinity;
  // Cleanup is the last thing a run does, from a `finally`: a throw here would
  // replace the real outcome. So it is idempotent and best-effort. A missing lock
  // is the desired end state, not a fault; any other failure is recorded on the
  // budget (and returned) so a genuine persistence problem stays visible without
  // masking the outcome it would otherwise overwrite. Releasing by pathname alone
  // would delete whatever now sits there: an operator who removed a presumed stale
  // lock and let a replacement run acquire the ledger would have THAT run's lock
  // unlinked by this one, and the two runs would then share the accounting. So only
  // the inode this owner created is unlinked; anything else is reported as lost
  // ownership and left exactly where it is.
  const close=()=>{
    if(fd!==undefined){
      const handle=fd;fd=undefined;
      try{fs.closeSync(handle);}catch(e){if(e.code!=='EBADF')closeError=closeError||new ArchiveError('LEDGER_CLEANUP_FAILED','cannot close request ledger lock ('+(e.code||e.message)+')',{cause:e.code||null});}
      try{
        const stat=fs.lstatSync(lock);
        if(lockIdentity&&(stat.dev!==lockIdentity.dev||stat.ino!==lockIdentity.ino))closeError=closeError||new ArchiveError('LEDGER_OWNERSHIP_LOST','request ledger lock was replaced by another owner; leaving it in place',{cause:null});
        else fs.unlinkSync(lock);
      }catch(e){if(e.code!=='ENOENT')closeError=closeError||new ArchiveError('LEDGER_CLEANUP_FAILED','cannot release request ledger lock ('+(e.code||e.message)+')',{cause:e.code||null});}
    }
    return closeError;
  };
  try {
    if (fs.existsSync(file)) {
      d=JSON.parse(fs.readFileSync(file,'utf8'));
      if (d.version!==1 || !Number.isInteger(d.requests) || d.requests<0 || !Array.isArray(d.recent_request_ms) || d.recent_request_ms.some(x=>!Number.isFinite(x)) || (d.denial!==null && (!d.denial || !d.denial.id || !d.denial.kind))) throw new Error('invalid evidence');
    } else d={version:1,session_id:runId,requests:0,blocked:0,session_ceiling:maximum,by_phase:{},recent_request_ms:[],denial:null,prior_sessions:[]};
    // Read the deprecated ceilings BEFORE the session rollover below overwrites
    // session_ceiling: history must be what the old ledger held, never this
    // caller's cap.
    const legacyCeilings=d.quota_policy?null:{session:d.session_ceiling??null,hour:d.hourly_ceiling??null};
    if (d.session_id!==runId) {
      d.prior_sessions=[...(d.prior_sessions||[]),{session_id:d.session_id,requests:d.requests,ended_at:d.updated_at}].slice(-20);
      d.session_id=runId; d.requests=0;d.blocked=0;d.by_phase={};d.session_ceiling=maximum;
    }
    // Deprecated local ceilings do not define a public-provider quota. Keep their history
    // for audit, but only an explicit current caller limit can bound this invocation.
    if (legacyCeilings) d.previous_local_ceilings=legacyCeilings;
    d.quota_policy='public-provider-paced-v1';d.session_ceiling=maximum;d.hourly_ceiling=null;d.min_request_interval_ms=MIN_REQUEST_INTERVAL_MS;
    const save=()=>{d.recent_request_ms=d.recent_request_ms.filter(t=>t>=Date.now()-HOUR_MS);d.updated_at=new Date().toISOString();atomic(file,d);};
    const assert=()=>{if(fd===undefined)throw new ArchiveError('BUDGET_CLOSED','request ledger is closed');if(stopped)throw stopped;if(d.denial)throw new ArchiveError('PROVIDER_DENIED','recorded provider denial '+d.denial.id+' remains in force');};
    // A recorded provider denial is the strongest stop a run can hold, and assert()
    // reads `stopped` before d.denial. Latching a lesser stop afterwards (a lapsed
    // deadline, a transport failure, an exhausted allowance) would therefore
    // downgrade PROVIDER_DENIED for the rest of the session, so it cannot replace
    // one — and a denial carried in from an earlier session outranks it too.
    const fail=(code,message)=>{
      if(stopped?.code==='PROVIDER_DENIED')return stopped;
      if(code!=='PROVIDER_DENIED'&&d?.denial)return stopped=new ArchiveError('PROVIDER_DENIED','recorded provider denial '+d.denial.id+' remains in force');
      stopped=new ArchiveError(code,message);return stopped;
    };
    const reserve=phase=>{
      assert();d.recent_request_ms=d.recent_request_ms.filter(t=>t>=Date.now()-HOUR_MS);
      if(d.session_ceiling!==null && d.requests>=d.session_ceiling){d.blocked++;save();throw fail('REQUEST_LIMIT','request allowance exhausted; incomplete scope retained');}
      d.requests++;d.by_phase[phase]=(d.by_phase[phase]||0)+1;d.recent_request_ms.push(Date.now());
      try{save();}catch(e){throw fail('LEDGER_WRITE_FAILED','cannot persist request reservation');}
    };
    const latestRequest=d.recent_request_ms.reduce((latest,t)=>Math.max(latest,t),0);
    const priorAge=Math.min(MIN_REQUEST_INTERVAL_MS,Math.max(0,Date.now()-latestRequest));
    let admissionTail=Promise.resolve(),lastAdmitted=performance.now()-priorAge;
    // An abort signal is a timer, and timers are ordered by when they were armed, not
    // by whose moment came first: after an event-loop stall crossing both timestamps,
    // the pacing timer's continuation runs while the deadline signal has not aborted
    // yet. Reading the absolute clock at the reservation boundary is what actually
    // keeps a lapsed job from debiting the ledger. It is thrown, never latched by
    // fail(): a deadline must not downgrade a recorded PROVIDER_DENIED.
    const expire=at=>{if(Number.isFinite(at)&&Date.now()>=at)throw new ArchiveError('TIME_LIMIT','job deadline reached before request reservation');};
    const admit=(phase,signal,deadlineAt)=>{
      const at=deadlineAt===undefined?jobDeadline:deadlineAt;
      const task=admissionTail.then(async()=>{
        assert();signal?.throwIfAborted();expire(at);
        const wait=MIN_REQUEST_INTERVAL_MS-(performance.now()-lastAdmitted);
        if(wait>0)await pause(wait,signal);
        assert();signal?.throwIfAborted();expire(at);
        reserve(phase);lastAdmitted=performance.now();
      });
      admissionTail=task.catch(()=>{});return task;
    };
    // Media acquisition is admitted through the same absolute boundary as discovery.
    const setDeadline=at=>{jobDeadline=Number.isFinite(at)?at:Infinity;return jobDeadline;};
    // A refusal is a refusal whether the provider spelled it as an HTTP status, as a
    // media endpoint serving HTML, or as a visible challenge/access wall in the page.
    // All three latch through here, so a DOM refusal is as durable as an HTTP one:
    // the evidence is persisted BEFORE the failure is raised, the FIRST denial is the
    // one that stands, and it keeps standing for later run IDs on the same ledger.
    // Only a closed vocabulary and a real observed status are recorded - never page
    // text, markup, headers or locators.
    const DENIAL_KINDS=new Set(['DENIED_AUTH','RATE_LIMITED','DENIED_CHALLENGE','DENIED_CONTENT_WALL','DENIED_CHALLENGE_DOM','DENIED_ACCESS_DOM']);
    const deny=(kind,evidence)=>{
      if(!DENIAL_KINDS.has(kind))throw new ArchiveError('BAD_BUDGET','unknown provider denial kind');
      if(!d.denial){
        const status=Number.isInteger(evidence?.status)?evidence.status:null;
        const retryAfter=evidence?.retryAfterRaw===undefined||evidence?.retryAfterRaw===null?'':String(evidence.retryAfterRaw).slice(0,100);
        d.denial={id:crypto.randomBytes(6).toString('hex'),kind,status,at:new Date().toISOString(),session_id:runId,retry_after_raw:retryAfter};
        save();
      }
      // The FIRST denial is the one in force; a later refusal must not relabel it.
      return fail('PROVIDER_DENIED',d.denial.kind+'; no retry or further acquisition');
    };
    const inspect=(status,headers,url)=>{
      const get=k=>typeof headers?.get==='function'?headers.get(k):headers?.[k];
      let kind=null;
      if([401,403,407,451].includes(status))kind='DENIED_AUTH';
      else if(status===429)kind='RATE_LIMITED';
      else if(status>=300&&status<400){let loc=get('location');if(loc&&new RegExp('(^|/)(login|signin|challenge|checkpoint|captcha|auth)(/|$)','i').test(new URL(loc,url).pathname))kind='DENIED_CHALLENGE';}
      if(kind)throw deny(kind,{status,retryAfterRaw:get('retry-after')});
    };
    const fetch=async(url,init)=>{await admit('download',init?.signal,jobDeadline);const response=await globalThis.fetch(url,init);try{inspect(response.status,response.headers,url);if(String(response.headers.get('content-type')).includes('text/html'))throw deny('DENIED_CONTENT_WALL');}catch(e){await response.body?.cancel().catch(()=>{});throw e;}return response;};
    save();return {data:d,reserve,admit,inspect,deny,assert,fetch,close,fail,setDeadline,get cleanupError(){return closeError;}};
  } catch(e) {close();if(e instanceof ArchiveError)throw e;throw new ArchiveError('BAD_BUDGET','cannot read trustworthy request accounting');}
}
module.exports={openBudget,MIN_REQUEST_INTERVAL_MS};
