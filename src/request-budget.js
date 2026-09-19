'use strict';
// Public InstaCognito traffic: serialized accounting, not a signed-account quota or pacing rule.
// Preserve real provider denials and history. Optional maxRequests is a caller job bound.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ArchiveError, PROVIDER_ORIGIN } = require('./index.js');
const HOUR_MS = 3600000, MIN_REQUEST_INTERVAL_MS = 0;
const POLICY='public-provider-unpaced-v2';
const DENIAL_KINDS=new Set(['DENIED_AUTH','RATE_LIMITED','SERVICE_UNAVAILABLE','DENIED_CHALLENGE','DENIED_CONTENT_WALL','DENIED_CHALLENGE_DOM','DENIED_ACCESS_DOM']);
function retryAt(raw,at,truncated=false){
 if(truncated||typeof raw!=='string'||raw.length>100)return null;
 // Strip only HTTP OWS for parsing; the raw refusal evidence stays untouched.
 const text=raw.replace(/^[ \t]+|[ \t]+$/g,'');
 let value=null;
 if(/^\d+$/.test(text)){const seconds=Number(text);if(Number.isSafeInteger(seconds))value=Date.parse(at)+seconds*1000;}
 else if(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(text)){
  const parsed=Date.parse(text);if(Number.isFinite(parsed)&&new Date(parsed).toUTCString()===text)value=parsed;
 }
 return Number.isSafeInteger(value)&&Math.abs(value)<=8640000000000000?new Date(value).toISOString():null;
}
function disposition(refusal){
 if(!refusal||typeof refusal!=='object'||Array.isArray(refusal)||typeof refusal.id!=='string'||!refusal.id||!DENIAL_KINDS.has(refusal.kind)
  ||typeof refusal.at!=='string'||!Number.isFinite(Date.parse(refusal.at))||typeof refusal.session_id!=='string'||!refusal.session_id
  ||!(refusal.status===null||(Number.isInteger(refusal.status)&&refusal.status>=100&&refusal.status<=599)))throw new Error('invalid refusal evidence');
 const origin=refusal.provider_origin??PROVIDER_ORIGIN;
 if(typeof origin!=='string'||new URL(origin).origin!==origin)throw new Error('invalid refusal origin');
 let kind='attempt-only',until=null,time=null;
 if(origin!==PROVIDER_ORIGIN)kind='foreign-provider-history';
 else if([401,407].includes(refusal.status)||refusal.restriction==='authentication-required')kind='authentication-required';
 else if(refusal.status===451)kind='legal-restriction';
 else if(refusal.status===429||refusal.status===503){until=retryAt(refusal.retry_after_raw,refusal.at,refusal.retry_after_truncated);time=until?'known':'unknown';kind=until?'provider-cooldown':'retry-time-unknown';}
 else if(refusal.kind==='DENIED_AUTH'&&refusal.status!==403)kind='unknown-restriction';
 return {policy:POLICY,denial_id:refusal.id,observed_at:refusal.at,provider_origin:origin,disposition:kind,retry_at:until,retry_time:time};
}
function cap(value) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) throw new ArchiveError('BAD_BUDGET', 'optional maxRequests must be a positive safe integer');
  return value;
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
  //
  // But that removal is authorized by PROOF of ownership, never by its absence. When
  // fstat itself fails there is no acquired identity at all, and "I cannot tell whose
  // this is" must not become "therefore it is mine to delete": an operator who removed
  // a presumed stale lock and let a replacement run acquire the ledger would otherwise
  // have THAT run's lock unlinked by this failed one. An ambiguous pathname is left
  // exactly where it is and reported, with a closed-vocabulary cleanup verdict and no
  // path, inode or device in the evidence. This is ordinary best-effort cleanup under a
  // serialized lock protocol, not a claim of atomicity against hostile replacement.
  try { const stat=fs.fstatSync(fd); lockIdentity={dev:stat.dev,ino:stat.ino}; fs.writeSync(fd,JSON.stringify({pid:process.pid,runId})); }
  catch(e) {
    try{fs.closeSync(fd);}catch(ignored){}
    let cleanup='unknown-identity-left-in-place';
    if(lockIdentity){
      try{
        const stat=fs.lstatSync(lock);
        if(stat.dev===lockIdentity.dev&&stat.ino===lockIdentity.ino){fs.unlinkSync(lock);cleanup='removed-own-lock';}
        else cleanup='replaced-by-another-owner-left-in-place';
      }catch(err){cleanup=err.code==='ENOENT'?'already-absent':'cleanup-failed';}
    }
    fd=undefined;
    throw new ArchiveError('BAD_BUDGET','cannot record request ledger ownership ('+(e.code||e.message)+')',{cleanup});
  }
  let d,stopped=null,closeError=null,jobDeadline=Infinity;
  const stopController=new AbortController();
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
    // Refusals are immutable history, not an eternal provider ban. Re-derive dispositions
    // from original evidence on reopen, never from the reopen time or a mutable cached verdict.
    if(d.provider_origin!==undefined&&d.provider_origin!==PROVIDER_ORIGIN)throw new Error('foreign provider ledger');
    d.provider_origin=PROVIDER_ORIGIN;
    for(const key of ['denial_history','denial_dispositions','denial_run_latches']){
      if(d[key]===undefined)d[key]=[];
      if(!Array.isArray(d[key]))throw new Error('invalid refusal history');
    }
    const remember=refusal=>{
      const typed=disposition(refusal),old=d.denial_history.find(r=>r.id===refusal.id);
      if(old&&JSON.stringify(old)!==JSON.stringify(refusal))throw new Error('contradictory refusal history');
      if(!old)d.denial_history.push(refusal);
      const prior=d.denial_dispositions.find(x=>x.policy===POLICY&&x.denial_id===refusal.id);
      if(prior&&JSON.stringify(prior)!==JSON.stringify(typed))throw new Error('contradictory refusal disposition');
      if(!prior)d.denial_dispositions.push(typed);
      return typed;
    };
    if(d.denial)remember(d.denial);
    const ids=new Set();
    for(const r of d.denial_history){if(ids.has(r.id))throw new Error('duplicate refusal history');ids.add(r.id);remember(r);}
    for(const l of d.denial_run_latches)if(!l||typeof l.run_id!=='string'||!ids.has(l.denial_id))throw new Error('invalid refusal latch');
    const latch=refusal=>{
      if(!d.denial_run_latches.some(l=>l.run_id===runId&&l.denial_id===refusal.id))d.denial_run_latches.push({run_id:runId,denial_id:refusal.id});
    };
    d.denial=d.denial_history.find(r=>{
      const p=disposition(r);if(p.provider_origin!==PROVIDER_ORIGIN)return false;
      return r.session_id===runId||d.denial_run_latches.some(l=>l.run_id===runId&&l.denial_id===r.id)
        ||['authentication-required','legal-restriction','unknown-restriction'].includes(p.disposition)
        ||(p.retry_at!==null&&Date.now()<Date.parse(p.retry_at));
    })||null;
    if(d.denial)latch(d.denial);
    d.active_restriction=d.denial?disposition(d.denial):null;
    // Read the deprecated ceilings BEFORE the session rollover below overwrites
    // session_ceiling: history must be what the old ledger held, never this
    // caller's cap.
    const legacyCeilings=d.quota_policy?null:{session:d.session_ceiling??null,hour:d.hourly_ceiling??null};
    if (d.session_id!==runId) {
      d.prior_sessions=[...(d.prior_sessions||[]),{session_id:d.session_id,requests:d.requests,blocked:d.blocked,by_phase:d.by_phase,session_ceiling:d.session_ceiling,ended_at:d.updated_at}];
      d.session_id=runId; d.requests=0;d.blocked=0;d.by_phase={};d.session_ceiling=maximum;
    }
    // Deprecated local ceilings do not define a public-provider quota. Keep their history
    // for audit, but only an explicit current caller limit can bound this invocation.
    if (legacyCeilings) d.previous_local_ceilings=legacyCeilings;
    d.quota_policy=POLICY;d.session_ceiling=maximum;d.hourly_ceiling=null;d.min_request_interval_ms=MIN_REQUEST_INTERVAL_MS;
    const save=()=>{d.recent_request_ms=d.recent_request_ms.filter(t=>t>=Date.now()-HOUR_MS);d.updated_at=new Date().toISOString();atomic(file,d);};
    const assert=()=>{if(fd===undefined)throw new ArchiveError('BUDGET_CLOSED','request ledger is closed');if(stopped)throw stopped;if(d.denial)throw new ArchiveError('PROVIDER_DENIED','recorded provider denial '+d.denial.id+' remains in force');};
    // A recorded provider denial is the strongest stop a run can hold, and assert()
    // reads `stopped` before d.denial. Latching a lesser stop afterwards (a lapsed
    // deadline, a transport failure, an exhausted allowance) would therefore
    // downgrade PROVIDER_DENIED for the rest of the session, so it cannot replace
    // one — and a denial carried in from an earlier session outranks it too.
    const fail=(code,message)=>{
      if(stopped?.code!=='PROVIDER_DENIED'){
        stopped=code!=='PROVIDER_DENIED'&&d?.denial
          ?new ArchiveError('PROVIDER_DENIED','recorded provider denial '+d.denial.id+' remains in force')
          :new ArchiveError(code,message);
      }
      stopController.abort(stopped);return stopped;
    };
    const reserve=phase=>{
      assert();d.recent_request_ms=d.recent_request_ms.filter(t=>t>=Date.now()-HOUR_MS);
      if(d.session_ceiling!==null && d.requests>=d.session_ceiling){d.blocked++;save();throw fail('REQUEST_LIMIT','request allowance exhausted; incomplete scope retained');}
      d.requests++;d.by_phase[phase]=(d.by_phase[phase]||0)+1;d.recent_request_ms.push(Date.now());
      try{save();}catch(e){throw fail('LEDGER_WRITE_FAILED','cannot persist request reservation');}
    };
    let admissionTail=Promise.resolve();
    // An abort signal is a timer, and timers are ordered by when they were armed, not
    // by whose moment came first: after an event-loop stall crossing both timestamps,
    // a queued continuation can run while the deadline signal has not aborted
    // yet. Reading the absolute clock at the reservation boundary is what actually
    // keeps a lapsed job from debiting the ledger. It is thrown, never latched by
    // fail(): a deadline must not downgrade a recorded PROVIDER_DENIED.
    const expire=at=>{if(Number.isFinite(at)&&Date.now()>=at)throw new ArchiveError('TIME_LIMIT','job deadline reached before request reservation');};
    const admit=(phase,signal,deadlineAt)=>{
      const at=deadlineAt===undefined?jobDeadline:deadlineAt;
      const task=admissionTail.then(()=>{
        assert();signal?.throwIfAborted();expire(at);
        assert();signal?.throwIfAborted();expire(at);
        reserve(phase);
      });
      admissionTail=task.catch(()=>{});return task;
    };
    // Media acquisition is admitted through the same absolute boundary as discovery.
    const setDeadline=at=>{jobDeadline=Number.isFinite(at)?at:Infinity;return jobDeadline;};
    // A refusal is a refusal whether the provider spelled it as an HTTP status, as a
    // media endpoint serving HTML, or as a visible challenge/access wall in the page.
    // All three latch through here, so a DOM refusal is as durable as an HTTP one:
    // the evidence is persisted BEFORE the failure is raised, the FIRST denial is the
    // one that stands throughout this operation. Later run IDs enforce only actual restrictions.
    // Only a closed vocabulary and a real observed status are recorded - never page
    // text, markup, headers or locators.
    const deny=(kind,evidence)=>{
      if(fd===undefined)throw new ArchiveError('BUDGET_CLOSED','request ledger is closed');
      if(!DENIAL_KINDS.has(kind))throw new ArchiveError('BAD_BUDGET','unknown provider denial kind');
      const status=Number.isInteger(evidence?.status)?evidence.status:null;
      const raw=evidence?.retryAfterRaw===undefined||evidence?.retryAfterRaw===null?'':String(evidence.retryAfterRaw);
      const refusal={id:crypto.randomBytes(6).toString('hex'),kind,status,at:new Date().toISOString(),session_id:runId,retry_after_raw:raw.slice(0,100),provider_origin:PROVIDER_ORIGIN,
        ...(raw.length>100?{retry_after_truncated:true}:{}),...(evidence?.restriction==='authentication-required'?{restriction:'authentication-required'}:{})};
      // Keep every observed refusal: a later 401 must not disappear behind an earlier 403.
      // The first remains the current-operation stop; later runs evaluate all restrictions.
      remember(refusal);latch(refusal);d.denial ||= refusal;
      d.active_restriction=disposition(d.denial);
      // Cancellation remains authoritative even if persisting the refusal itself fails.
      try{save();}catch(e){fail('PROVIDER_DENIED','provider refusal; evidence persistence failed');throw new ArchiveError('LEDGER_WRITE_FAILED','cannot persist provider refusal');}
      // The FIRST denial is the one in force; a later refusal must not relabel it.
      return fail('PROVIDER_DENIED',d.denial.kind+'; no retry or further acquisition');
    };
    const inspect=(status,headers,url)=>{
      if(new URL(url).origin!==PROVIDER_ORIGIN)throw fail('PROVIDER_SCOPE','response is outside this provider budget');
      const get=k=>typeof headers?.get==='function'?headers.get(k):headers?.[k];
      let kind=null,restriction=null;
      if([401,403,407,451].includes(status))kind='DENIED_AUTH';
      else if(status===429)kind='RATE_LIMITED';
      else if(status===503&&get('retry-after')!=null)kind='SERVICE_UNAVAILABLE';
      else if(status>=300&&status<400){let loc=get('location');if(loc&&new RegExp('(^|/)(login|signin|challenge|checkpoint|captcha|auth)(/|$)','i').test(new URL(loc,url).pathname)){
        kind='DENIED_CHALLENGE';if(new RegExp('(^|/)(login|signin|auth)(/|$)','i').test(new URL(loc,url).pathname))restriction='authentication-required';
      }}
      if(kind)throw deny(kind,{status,retryAfterRaw:get('retry-after'),restriction});
    };
    const fetch=async(url,init)=>{assert();if(new URL(url).origin!==PROVIDER_ORIGIN)throw fail('PROVIDER_SCOPE','request is outside this provider budget');await admit('download',init?.signal,jobDeadline);const response=await globalThis.fetch(url,init);try{inspect(response.status,response.headers,url);if(String(response.headers.get('content-type')).includes('text/html'))throw deny('DENIED_CONTENT_WALL');}catch(e){await response.body?.cancel().catch(()=>{});throw e;}return response;};
    save();return {data:d,reserve,admit,inspect,deny,assert,fetch,close,fail,setDeadline,signal:stopController.signal,get cleanupError(){return closeError;}};
  } catch(e) {close();if(e instanceof ArchiveError)throw e;throw new ArchiveError('BAD_BUDGET','cannot read trustworthy request accounting');}
}
module.exports={openBudget,MIN_REQUEST_INTERVAL_MS};
