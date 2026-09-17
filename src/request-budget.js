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
  const lock=file+'.window-lock'; let fd;
  try { fd=fs.openSync(lock,'wx',0o600); fs.writeSync(fd,JSON.stringify({pid:process.pid,runId})); }
  catch(e) { throw new ArchiveError('BUDGET_LOCKED','request ledger already owned; inspect stale locks explicitly'); }
  let d,stopped=null,closeError=null;
  // Cleanup is the last thing a run does, from a `finally`: a throw here would
  // replace the real outcome. So it is idempotent and best-effort. A missing lock
  // is the desired end state, not a fault; any other failure is recorded on the
  // budget (and returned) so a genuine persistence problem stays visible without
  // masking the outcome it would otherwise overwrite.
  const close=()=>{
    if(fd!==undefined){
      const handle=fd;fd=undefined;
      try{fs.closeSync(handle);}catch(e){if(e.code!=='EBADF')closeError=closeError||new ArchiveError('LEDGER_CLEANUP_FAILED','cannot close request ledger lock ('+(e.code||e.message)+')',{cause:e.code||null});}
      try{fs.unlinkSync(lock);}catch(e){if(e.code!=='ENOENT')closeError=closeError||new ArchiveError('LEDGER_CLEANUP_FAILED','cannot release request ledger lock ('+(e.code||e.message)+')',{cause:e.code||null});}
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
    const admit=(phase,signal)=>{
      const task=admissionTail.then(async()=>{
        assert();signal?.throwIfAborted();
        const wait=MIN_REQUEST_INTERVAL_MS-(performance.now()-lastAdmitted);
        if(wait>0)await pause(wait,signal);
        assert();signal?.throwIfAborted();reserve(phase);lastAdmitted=performance.now();
      });
      admissionTail=task.catch(()=>{});return task;
    };
    const inspect=(status,headers,url)=>{
      const get=k=>typeof headers?.get==='function'?headers.get(k):headers?.[k];
      let kind=null;
      if([401,403,407,451].includes(status))kind='DENIED_AUTH';
      else if(status===429)kind='RATE_LIMITED';
      else if(status>=300&&status<400){let loc=get('location');if(loc&&new RegExp('(^|/)(login|signin|challenge|checkpoint|captcha|auth)(/|$)','i').test(new URL(loc,url).pathname))kind='DENIED_CHALLENGE';}
      if(kind){d.denial=d.denial||{id:crypto.randomBytes(6).toString('hex'),kind,status,at:new Date().toISOString(),session_id:runId,retry_after_raw:String(get('retry-after')||'').slice(0,100)};save();throw fail('PROVIDER_DENIED',kind+'; no retry or further acquisition');}
    };
    const fetch=async(url,init)=>{await admit('download',init?.signal);const response=await globalThis.fetch(url,init);try{inspect(response.status,response.headers,url);if(String(response.headers.get('content-type')).includes('text/html')){d.denial={id:crypto.randomBytes(6).toString('hex'),kind:'DENIED_CONTENT_WALL',at:new Date().toISOString(),session_id:runId};save();throw fail('PROVIDER_DENIED','media endpoint returned HTML');}}catch(e){await response.body?.cancel().catch(()=>{});throw e;}return response;};
    save();return {data:d,reserve,admit,inspect,assert,fetch,close,fail,get cleanupError(){return closeError;}};
  } catch(e) {close();if(e instanceof ArchiveError)throw e;throw new ArchiveError('BAD_BUDGET','cannot read trustworthy request accounting');}
}
module.exports={openBudget,MIN_REQUEST_INTERVAL_MS};
