'use strict';
// Bounded incremental observation, NOT full-profile/history completeness.
// Uses FrameFerry's DOM extraction, identity normalization, receipt verification
// and downloader. Destinations (e.g. Immich) consume this receipt-only result.
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const F=require('./index.js');
const {openBudget}=require('./request-budget.js');
const {estimateDate}=require('./date-estimate.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function number(n,def,min,max,label){n=n===undefined?def:n;if(!Number.isInteger(n)||n<min||n>max)throw new F.ArchiveError('BAD_ARGS',label+' outside supported bounds');return n;}
// A handle entry carries only which handle, from when, and the caller's witness/
// access/eligibility metadata. Policy (timeZone, allowEstimatedDates), resource
// bounds and transport are job-wide by design: a per-handle copy would silently
// weaken the whole job's stated policy for one handle, so it is rejected here and
// never read from a spec below.
const HANDLE_SPEC_KEYS=['handle','dateAfter','expectedPosts','accessRequired','eligibility'];
function requiredPathString(config,key){
 const value=config[key];
 if(typeof value!=='string'||!value.trim())throw new F.ArchiveError('BAD_ARGS',key+' must be a non-empty path string');
 return value;
}
function validate(config){
 if(!config||typeof config!=='object'||Array.isArray(config))throw new F.ArchiveError('BAD_ARGS','an explicit sync-window configuration object is required');
 if(!Array.isArray(config.handles)||!config.handles.length||config.handles.length>100)throw new F.ArchiveError('BAD_ARGS','1..100 explicit handles required');
 const seen=new Set();
 for(const h of config.handles){
  if(!h||typeof h!=='object'||Array.isArray(h))throw new F.ArchiveError('BAD_ARGS','each handle entry must be an object with an explicit handle and dateAfter');
  const unsupported=Object.keys(h).filter(key=>!HANDLE_SPEC_KEYS.includes(key)).sort();
  if(unsupported.length)throw new F.ArchiveError('BAD_ARGS','unsupported per-handle field(s) '+unsupported.join(', ')+'; job policy and resource bounds are job-wide, not per handle');
  F.validateHandle(h.handle);if(seen.has(h.handle))throw new F.ArchiveError('BAD_ARGS','duplicate handle');seen.add(h.handle);
  // Date.parse rejects an out-of-range calendar field with NaN; the round trip
  // catches a well-formed label that the platform silently rolls over instead.
  if(typeof h.dateAfter!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(h.dateAfter)||!Number.isFinite(Date.parse(h.dateAfter))||new Date(h.dateAfter).toISOString().slice(0,10)!==h.dateAfter)throw new F.ArchiveError('BAD_ARGS','explicit calendar dateAfter required');
  if(Object.hasOwn(h,'accessRequired')&&h.accessRequired!=='authenticated-view')throw new F.ArchiveError('BAD_ARGS','accessRequired must be authenticated-view when present');
  validateExpectedPosts(h);
 }
 if(typeof config.runId!=='string'||!/^[A-Za-z0-9._-]{1,150}$/.test(config.runId))throw new F.ArchiveError('BAD_ARGS','safe runId required');
 for(const key of ['output','resultFile','requestLedger'])requiredPathString(config,key);
 if(config.attachCdp!==undefined&&config.attachCdp!==null){
  // Only an absent attachment means "launch"; anything else must be a usable
  // loopback endpoint, not a value that fails deep inside the browser client.
  let u=null;
  if(typeof config.attachCdp==='string'){try{u=new URL(config.attachCdp);}catch(e){u=null;}}
  if(!u||u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new F.ArchiveError('BAD_CDP','explicit loopback CDP required');
 }
 if(config.timeZone!==undefined){
  if(typeof config.timeZone!=='string')throw new F.ArchiveError('BAD_ARGS','timeZone must be a supported IANA time zone name');
  try{new Intl.DateTimeFormat('en-US',{timeZone:config.timeZone});}
  catch(e){throw new F.ArchiveError('BAD_ARGS','timeZone must be a supported IANA time zone name');}
 }
 return {...config,maxTimeMs:number(config.maxTimeMs,600000,1000,1200000,'maxTimeMs'),maxFileBytes:number(config.maxFileBytes,52428800,1024,268435456,'maxFileBytes'),maxBytes:number(config.maxBytes,1073741824,1024,2147483648,'maxBytes'),maxCards:number(config.maxCards,1000,1,10000,'maxCards')};
}
// estimateDate reports an unusable date label as a plain platform Error, which the
// handle-local classifier (keyed on `code`) cannot see and which destinations
// cannot branch on. Both consuming seams need a typed, code-bearing failure.
function typedEstimateDate(raw,observedAt,timeZone,label){
 try{return estimateDate(raw,observedAt,timeZone);}
 catch(e){if(e&&e.code)throw e;throw new F.ArchiveError('DATE_POLICY',label+': '+(e&&e.message||'unusable source date'));}
}
function select(raw,observedAt,options){
 if(!raw.length)throw new F.ArchiveError('EMPTY_WINDOW','no visible post cards; not nothing-new');
 const indexed=F.normalizeItems(raw.map(x=>({...x,observedAt})),{category:'posts',mediaTypes:['image','video']}).items;
 if(indexed.length!==raw.length)throw new F.ArchiveError('AMBIGUOUS_WINDOW','normalization changed visible card count; refusing silent drops');
 return indexed.map(item=>{
  if(!item.shortcode||!item.stableId||!item.href)throw new F.ArchiveError('BAD_ITEM','visible post lacks bound identity or media URL');
  F.validateProviderMediaUrl(item.href);
  const date=typedEstimateDate(item.dateRaw,observedAt,options.timeZone||'UTC','unusable source date for visible post');
  if(date.precision==='estimated'&&options.allowEstimatedDates!==true)throw new F.ArchiveError('DATE_POLICY','ambiguous source date requires explicit allowEstimatedDates');
  return {item,date,selected:date.dayHi>=options.dateAfter};
 });
}
// Caller-supplied evidence of known recent Posts. This is a necessary condition,
// never proof that a provider listing is current or that the whole feed is complete.
function validateExpectedPosts(spec,observedAt){
 const witnesses=spec.expectedPosts===undefined?[]:spec.expectedPosts;
 if(!Array.isArray(witnesses)||witnesses.length>50)throw new F.ArchiveError('BAD_ARGS','expectedPosts must contain at most 50 witnesses');
 // When a concrete window is being judged, the witness must predate it: evidence
 // recorded AFTER the listing was observed says nothing about that listing.
 // Without a window (config validation, a held handle) there is nothing to bound.
 let limit=null;
 if(observedAt!==undefined&&observedAt!==null){
  limit=Date.parse(observedAt);
  if(!Number.isFinite(limit))throw new F.ArchiveError('BAD_RESULT','a window observation timestamp is required to bound witness provenance');
 }
 const seen=new Set(),keys=['category','minDayHi','shortcode','source','sourceObservedAt'];
 for(const w of witnesses){
  if(!w||typeof w!=='object'||Object.keys(w).sort().join(',')!==keys.join(',')||w.category!=='posts'||typeof w.shortcode!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(w.shortcode)||seen.has(w.shortcode))throw new F.ArchiveError('BAD_ARGS','invalid or duplicate Posts witness');
  seen.add(w.shortcode);
  if(typeof w.minDayHi!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(w.minDayHi)||!Number.isFinite(Date.parse(w.minDayHi))||new Date(w.minDayHi).toISOString().slice(0,10)!==w.minDayHi)throw new F.ArchiveError('BAD_ARGS','invalid witness date');
  if(!['owner-direct-observation','verified-receipt'].includes(w.source)||typeof w.sourceObservedAt!=='string'||!/(Z|[+-][0-9]{2}:[0-9]{2})$/.test(w.sourceObservedAt)||!Number.isFinite(Date.parse(w.sourceObservedAt))||Date.parse(w.sourceObservedAt)>Date.now()+1000)throw new F.ArchiveError('BAD_ARGS','invalid witness provenance');
  if(limit!==null&&Date.parse(w.sourceObservedAt)>limit)throw new F.ArchiveError('BAD_ARGS','witness '+w.shortcode+' was observed after the window it is offered as evidence about');
 }
 return witnesses;
}
function witnessCoverage(spec,observations,observedAt){
 const expectedPosts=validateExpectedPosts(spec,observedAt);
 const applicable=expectedPosts.filter(w=>w.minDayHi>=spec.dateAfter),observedWitnesses=[],missingWitnesses=[],conflictingWitnesses=[];
 for(const w of applicable){
  const cards=observations.filter(x=>x.category==='posts'&&x.shortcode===w.shortcode);
  if(!cards.length)missingWitnesses.push(w.shortcode);
  else if(cards.some(x=>!x.selected||!x.date?.dayHi||x.date.dayHi<w.minDayHi))conflictingWitnesses.push(w.shortcode);
  else observedWitnesses.push(w.shortcode);
 }
 return {policy:'known-posts-v1',scope:'current-visible-posts',fullFeedComplete:false,expectedPosts,observedWitnesses,missingWitnesses,conflictingWitnesses,satisfied:!missingWitnesses.length&&!conflictingWitnesses.length};
}
// Pure validation shared with receipt destinations; no browser, filesystem or network.
function validateWitnessWindow(spec,h,options={}){
 validateExpectedPosts(spec);
 if(spec.accessRequired!==undefined)throw new F.ArchiveError('ACCESS_REQUIRED','held handle cannot supply a complete window');
 if(h.status!=='COMPLETE'||h.scope!=='current-visible-posts'||h.dateAfter!==spec.dateAfter||!Number.isFinite(Date.parse(h.observedAt))||!Array.isArray(h.observations)||h.observations.length!==h.observedCards||!Array.isArray(h.files)||h.selectedCards!==h.files.length)throw new F.ArchiveError('BAD_RESULT','incomplete witness window');
 const ids=new Set(),selected=new Map();
 for(const x of h.observations){
  if(x.category!=='posts'||typeof x.shortcode!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(x.shortcode)||!/^posts__[a-f0-9]{64}$/.test(x.stableId)||ids.has(x.stableId))throw new F.ArchiveError('BAD_RESULT','unbound witness observation');ids.add(x.stableId);
  const date=x.date||{},expected=typedEstimateDate(date.raw,h.observedAt,options.timeZone||'UTC','invalid witness date provenance');
  if(Object.keys(expected).some(k=>date[k]!==expected[k])||x.selected!==(expected.dayHi>=spec.dateAfter)||(date.precision==='estimated'&&options.allowEstimatedDates!==true))throw new F.ArchiveError('DATE_POLICY','invalid witness date provenance');
  if(x.selected)selected.set(x.stableId,x);
 }
 if(selected.size!==h.files.length)throw new F.ArchiveError('BAD_RESULT','witness selected/file coverage mismatch');
 const files=new Set();
 for(const f of h.files){const x=selected.get(f.stableId);if(!x||files.has(f.stableId)||f.shortcode!==x.shortcode||f.profileHandle!==spec.handle||JSON.stringify(f.date)!==JSON.stringify(x.date))throw new F.ArchiveError('BAD_RESULT','witness observation/receipt mismatch');files.add(f.stableId);}
 const proof=witnessCoverage(spec,h.observations,h.observedAt);
 if(!proof.satisfied||JSON.stringify(h.coverage)!==JSON.stringify(proof))throw new F.ArchiveError('FEED_COVERAGE_GAP','missing or conflicting known-post evidence');
 return proof;
}
function canonicalReceiptMediaPath(paths,receipt){
 if(!receipt||typeof receipt.stableId!=='string'||typeof receipt.path!=='string')return false;
 const ext=path.extname(receipt.path);
 return !!ext&&receipt.path===path.relative(paths.root,path.join(paths.mediaDir,receipt.stableId+ext));
}
async function verifyCanonicalReceipt(paths,receipt,stableId,handle){
 return !!receipt&&receipt.stableId===stableId&&receipt.profileHandle===handle&&canonicalReceiptMediaPath(paths,receipt)&&await F.verifyReceipt(paths,receipt);
}
// F.verifyReceipt rehashes the file, so bytes are proved, but it reads no identity
// field at all: unchanged bytes under an unchanged canonical filename let corrupt
// receipt metadata through. The core downloader's own gate additionally binds the
// category encoded in the ID, requires a shortcode, and for a fingerprint-bound
// posts__<64hex> ID recomputes stableMediaId(receipt), so any reuse here must clear
// it too — cache reuse is never allowed to be weaker than downloadOne's.
async function verifyStrictReceipt(paths,receipt,stableId,handle){
 return F.receiptMatchesIdentity(receipt,stableId,handle)&&await verifyCanonicalReceipt(paths,receipt,stableId,handle);
}
// An internally consistent receipt can still describe different media than the card
// being selected: the fingerprint-bound ID covers category, shortcode and locator,
// never the media type. An explicit card claim must not be contradicted; a card that
// claims no type ('unknown' is what normalizeItems records for an unlabelled card)
// makes no claim to contradict, exactly as downloadOne treats it.
function receiptAgreesWithObservation(receipt,item){
 if(!receipt||!item)return false;
 if(F.receiptCategory(receipt)!==(item.category||'posts'))return false;
 if(!receipt.shortcode||receipt.shortcode!==item.shortcode)return false;
 return !item.mediaType||item.mediaType==='unknown'||receipt.mediaType===item.mediaType;
}
// A receipt file that cannot be read or parsed is absent evidence, not a platform
// fault: where no acquisition can follow, the caller gets the documented typed
// refusal from the gate above instead of a raw SyntaxError.
const readReceipt=async file=>F.readJson(file,null).catch(()=>null);
async function installGuards(page,budget,deadline=Infinity){
 const statuses={};
 const assertTime=()=>{budget.assert();if(Date.now()>=deadline)throw budget.fail('TIME_LIMIT','incremental job deadline reached');};
 // reserve() runs INSIDE admit, after its last internal check, so only a
 // deadline-linked abort can stop a request queued behind the pacing interval
 // from being debited and forwarded once the job deadline has passed. The abort
 // reason is a plain typed error and never budget.fail(): latching TIME_LIMIT as
 // the sticky stop from a timer would overwrite a recorded provider denial, which
 // must keep precedence.
 let deadlineAbort=null,expireDeadline=()=>{},deadlineTimer=null;
 const deadlineSignal=()=>{
  if(!Number.isFinite(deadline))return undefined;
  if(!deadlineAbort){
   const controller=new AbortController();deadlineAbort=controller;
   expireDeadline=()=>{if(!controller.signal.aborted)controller.abort(new F.ArchiveError('TIME_LIMIT','incremental job deadline reached'));};
   deadlineTimer=setTimeout(expireDeadline,Math.max(0,deadline-Date.now()));deadlineTimer.unref?.();
  }
  // A timer can lag; never let a lapsed deadline hand out an unaborted signal.
  if(Date.now()>=deadline)expireDeadline();
  return deadlineAbort.signal;
 };
 // One guarded page per handle: do not leave its deadline timer armed once closed.
 page.on('close',()=>{if(deadlineTimer)clearTimeout(deadlineTimer);});
 await page.route('**/*',async route=>{
  const req=route.request();const u=new URL(req.url());
  // Cosmetic previews never leave the browser. Media acquisition uses downloadOne.
  if(['image','media','stylesheet','font'].includes(req.resourceType()))return route.abort('blockedbyclient');
  if(u.origin!==F.PROVIDER_ORIGIN)return route.fallback();
  try{assertTime();await budget.admit('discovery',deadlineSignal());assertTime();}
  catch(e){return route.abort('blockedbyclient');}
  return route.fallback();
 });
 page.on('response',res=>{
  try{const u=new URL(res.url());if(u.origin===F.PROVIDER_ORIGIN){const status=res.status();statuses[status]=(statuses[status]||0)+1;budget.inspect(status,res.headers(),res.url());if(status>=400)throw budget.fail('DISCOVERY_TRANSPORT','provider discovery HTTP failure');}}
  catch(e){budget.fail(e.code||'PROVIDER_DENIED',e.message);}
 });
 return ()=>({...statuses});
}
async function discover(page,handle,budget,deadline,maxCards,waitMs=45000){
 // Shorter waits are an injected offline-test seam, never an expanded job budget.
 waitMs=number(waitMs,45000,1,45000,'readiness wait');
 page.setDefaultTimeout(Math.max(1,Math.min(45000,deadline-Date.now())));
 const monitor=F.attachContinuationRequestMonitor(page,{pathname:null}),started=Date.now();
 let statuses=()=>({}),windowStarted=null,last=null;
 const d={schemaVersion:1,handle,phase:'profile',cause:null,profileMatched:false,profileHasTotal:false,category:null,challenge:false,sectionError:null,browserOpen:false,rawCount:0,maxRawCount:0,samples:0,signatureChanges:0,stableSamples:0,waitMs,elapsedMs:0,deadlineRemainingMs:0,transport:null};
 const capture=()=>{d.browserOpen=!page.isClosed()&&page.context().browser().isConnected();d.elapsedMs=Date.now()-(windowStarted??started);d.deadlineRemainingMs=Math.max(0,deadline-Date.now());d.transport={...monitor.snapshot(),statuses:statuses()};return JSON.parse(JSON.stringify(d));};
 const assertTime=()=>{budget.assert();if(Date.now()>=deadline)throw budget.fail('TIME_LIMIT','incremental job deadline reached');};
 const inspect=async()=>{
  assertTime();
  const seen=await page.evaluate(({handle,selector})=>{
   const visible=el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
   const section=document.querySelector('#profile-section'),name=section?.querySelector('.username-text')?.textContent||'';
   const category=document.querySelector('#menu-wrapper .menu-item.active')?.getAttribute('data-id');
   return {matched:name.replace(/^@/,'').trim().toLowerCase()===handle.toLowerCase(),text:section?.innerText||'',category:['POSTS','REELS','STORIES','HIGHLIGHTS'].includes(category)?category:null,
    challenge:[...document.querySelectorAll(selector)].some(visible),sectionError:['error-private','error-not-found','error-no-content'].find(id=>{const el=document.getElementById(id);return el&&visible(el);})||null};
  },{handle,selector:WINDOW_CHALLENGE_SELECTOR});
  Object.assign(d,{profileMatched:seen.matched,profileHasTotal:F.parseReportedTotal(seen.text)!==null,category:seen.category,challenge:seen.challenge,sectionError:seen.sectionError,browserOpen:!page.isClosed()&&page.context().browser().isConnected()});
  // Latch DOM refusals just like transport refusals, before any later admission.
  if(d.challenge||['error-private','error-not-found'].includes(d.sectionError))throw budget.fail('DENIED','provider challenge or access refusal during window readiness');
  assertTime();
  if(!d.browserOpen)throw new F.ArchiveError('BROWSER_CLOSED','browser closed during window readiness');
 };
 try{
  statuses=await installGuards(page,budget,deadline);assertTime();
  await page.goto(F.PROVIDER_PHOTO_URL,{waitUntil:'domcontentloaded'});assertTime();
  await page.fill('input#search-input',handle);await page.click('button#download-btn');
  const ready=await F.waitForProfileReady(page,handle,{started:Date.now(),maxTimeMs:Math.max(1,deadline-Date.now()),waitMs:Math.min(30000,Math.max(1,deadline-Date.now())),continuationMonitor:monitor});
  Object.assign(d,{profileMatched:ready.matched,profileHasTotal:ready.hasTotal});
  await inspect();
  if(ready.blocked)throw budget.fail('DENIED','provider blocked profile discovery');
  if(!ready.ready)throw new F.ArchiveError('PROFILE_NOT_READY','requested public profile not ready');
  windowStarted=Date.now();d.phase='window';const end=Math.min(deadline,windowStarted+waitMs);
  while(Date.now()<end){
   await inspect();const raw=await F.readRawCardsFromPage(page);
   d.samples++;d.rawCount=raw.length;d.maxRawCount=Math.max(d.maxRawCount,raw.length);
   if(raw.length>maxCards)throw new F.ArchiveError('WINDOW_LIMIT','visible window exceeds item bound');
   const signature=windowSignature(raw);
   if(last!==null&&signature!==last)d.signatureChanges++;
   d.stableSamples=raw.length?(signature===last?d.stableSamples+1:1):0;last=signature;
   if(d.stableSamples>=2){
    await inspect();
    const transport=monitor.snapshot();
    if(d.profileMatched&&d.profileHasTotal&&d.category==='POSTS'&&!d.sectionError&&!transport.inFlight&&!transport.failed){return {raw,observedAt:new Date().toISOString()};}
   }
   await sleep(Math.min(1000,Math.max(1,end-Date.now())));
  }
  await inspect();d.cause=d.maxRawCount===0?'empty':'unstable';
  throw new F.ArchiveError('WINDOW_NOT_READY','visible post window readiness expired', {readiness:capture()});
 }catch(e){
  // No DOM text, locator, caption, API payload or signed URL is persisted.
  e.details={...e.details,readiness:capture()};throw e;
 }finally{monitor.detach();}
}
// Stability follows selection-relevant identity, type and date, not engagement or
// captions. Signed query rotation is ignored only for the SAME provider media id.
// A rotating id is NOT equivalent bytes and must still reset the window.
function windowSignature(raw){
 return JSON.stringify(raw.map(x=>[x.shortcode||null,F.providerMediaFingerprint(x.href)||x.href||null,x.mediaType||null,x.dateRaw||null]));
}
const WINDOW_CHALLENGE_SELECTOR='iframe[src*="captcha" i], iframe[src*="challenge" i], iframe[title*="challenge" i], .g-recaptcha, .h-captcha, #challenge-form, #cf-challenge-running, [data-captcha]';
function localWindowReadiness(d){
 const keys=['schemaVersion','handle','phase','cause','profileMatched','profileHasTotal','category','challenge','sectionError','browserOpen','rawCount','maxRawCount','samples','signatureChanges','stableSamples','waitMs','elapsedMs','deadlineRemainingMs','transport'];
 const exact=(value,fields)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...fields].sort().join(',');
 const count=(n,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(n)&&n>=0&&n<=max;
 if(!exact(d,keys)||d.schemaVersion!==1||typeof d.handle!=='string'||!/^[A-Za-z0-9._]{1,30}$/.test(d.handle))return false;
 if(d.phase!=='window'||!['empty','unstable'].includes(d.cause)||d.profileMatched!==true||d.profileHasTotal!==true||d.category!=='POSTS'||d.challenge!==false||d.sectionError!==null||d.browserOpen!==true)return false;
 if(!count(d.waitMs,45000)||d.waitMs<1||!count(d.elapsedMs,1200000)||d.elapsedMs<d.waitMs||!count(d.deadlineRemainingMs,1200000)||d.deadlineRemainingMs<1)return false;
 if(!count(d.samples)||d.samples<2||!count(d.rawCount,10000)||!count(d.maxRawCount,10000)||d.maxRawCount<d.rawCount||!count(d.stableSamples,1)||!count(d.signatureChanges)||d.signatureChanges>=d.samples)return false;
 if(d.cause==='empty'?d.maxRawCount!==0||d.stableSamples!==0:d.maxRawCount===0)return false;
 const t=d.transport;
 if(!exact(t,['started','settled','failed','inFlight','paths','statuses'])||!count(t.started)||t.started<2||t.started!==t.settled||t.failed!==0||t.inFlight!==0)return false;
 if(!t.paths||typeof t.paths!=='object'||Array.isArray(t.paths)||Object.entries(t.paths).some(([key,n])=>!['/api/profile','/api/posts','/api/reels','/api/stories','/api/highlights','other-api'].includes(key)||!count(n)||n<1))return false;
 if(!(t.paths['/api/profile']>=1)||!(t.paths['/api/posts']>=1)||Object.values(t.paths).reduce((sum,n)=>sum+n,0)!==t.started)return false;
 return !!t.statuses&&Object.values(t.statuses).reduce((sum,n)=>sum+n,0)>=t.settled&&typeof t.statuses==='object'&&!Array.isArray(t.statuses)&&Object.keys(t.statuses).length>0&&Object.entries(t.statuses).every(([status,n])=>/^[23][0-9]{2}$/.test(status)&&count(n)&&n>0);
}
async function acquireSelection(rows,paths,handle,runId,budget,options,totals){
 const out=[];
 for(const {item,date,selected} of rows){
  if(!selected)continue;budget.assert();if(Date.now()>=options.deadline)throw new F.ArchiveError('TIME_LIMIT','incremental job deadline reached');
  const receiptPath=path.join(paths.receiptDir,item.stableId+'.json');
  // Fail closed on an unreadable stored receipt BEFORE any request: downloadOne
  // would hit the same file only after streaming the media, spending a provider
  // request to reach the identical refusal.
  let receipt=await F.readJson(receiptPath,null).catch(e=>{throw new F.ArchiveError('BAD_RECEIPT','stored receipt for '+item.stableId+' is unreadable ('+(e.code||'malformed JSON')+')');}),reused=false;
  // Never alias legacy carousel positions or rotating locators without byte proof,
  // and never trust proved bytes as proof of identity.
  if(receipt&&receipt.providerMediaFingerprint===item.providerMediaFingerprint&&receiptAgreesWithObservation(receipt,item)&&await verifyStrictReceipt(paths,receipt,item.stableId,handle))reused=true;
  else {
   const remaining=options.maxBytes-totals.bytes;if(remaining<1)throw new F.ArchiveError('BYTE_LIMIT','incremental byte allowance exhausted');
   const result=await F.downloadOne(item,paths,{handle,runId,fetchImpl:budget.fetch,stopOnDenial:true,dnsLookup:options.dnsLookup,maxBytes:Math.min(options.maxFileBytes,remaining),remainingMs:Math.min(30000,options.deadline-Date.now()),completedMap:{},acceptExistingReceipt:r=>canonicalReceiptMediaPath(paths,r)});
   if(result.conflict)throw new F.ArchiveError('IDENTITY_CONFLICT','conflicting media bytes held unchanged');
   receipt=result.receipt;totals.downloaded++;totals.bytes+=receipt.bytes;
  }
  if(!receiptAgreesWithObservation(receipt,item)||!await verifyStrictReceipt(paths,receipt,item.stableId,handle))throw new F.ArchiveError('BAD_RECEIPT','selected receipt failed identity/path/byte verification');
  if(reused)totals.reused++;
  out.push({stableId:receipt.stableId,shortcode:receipt.shortcode,mediaType:receipt.mediaType,path:receipt.path,bytes:receipt.bytes,sha256:receipt.sha256,profileHandle:receipt.profileHandle,sourceHost:receipt.sourceHost,date,receiptRunId:receipt.runId,reused});
 }
 return out;
}
// Only positively classified handle-local failures may continue. Unknown errors,
// browser loss, disk/byte/time limits and denial remain global fail-stops.
const HANDLE_LOCAL_ERRORS=new Set(['ACCESS_REQUIRED','FEED_COVERAGE_GAP','EMPTY_WINDOW','AMBIGUOUS_WINDOW','BAD_ITEM','DATE_POLICY']);
async function syncWindow(input,deps={}){
 const config=validate(input),root=await F.safeOutputRoot(config.output),resultFile=path.resolve(config.resultFile);
 await F.ensureSafeDir(path.dirname(resultFile),path.dirname(resultFile));
 if(await fs.lstat(resultFile).catch(e=>e.code==='ENOENT'?null:Promise.reject(e)))throw new F.ArchiveError('EXISTS','result already exists; use a new run result path');
 const budget=openBudget(config.requestLedger,config.runId,config.maxRequests),deadline=Date.now()+config.maxTimeMs;
 const result={schemaVersion:1,kind:'frameferry-sync-window',runId:config.runId,scope:'current-visible-posts',fullHistoryComplete:false,failureIsolation:'handle-local-v1',stoppedGlobally:false,output:root,handles:{},totals:{downloaded:0,reused:0,bytes:0},status:'RUNNING'};
 let browser,context,ownsBrowser=false;
 try{
  budget.assert();
  const chromium=deps.chromium||require('playwright').chromium;
  // A browser handshake is part of the job, not extra to it: never wait past the deadline.
  const browserTimeout=()=>Math.max(1,Math.min(20000,deadline-Date.now()));
  if(config.attachCdp)browser=await chromium.connectOverCDP(config.attachCdp,{timeout:browserTimeout()});
  else {browser=await chromium.launch({headless:true,executablePath:config.browserExecutable,timeout:browserTimeout()});ownsBrowser=true;}
  // Own isolated context with service workers blocked; close only owned resources.
  context=await browser.newContext({serviceWorkers:'block'});
  for(const spec of config.handles){
   budget.assert();if(Date.now()>=deadline)throw new F.ArchiveError('TIME_LIMIT','job deadline reached');
   const h=result.handles[spec.handle]={status:'PARTIAL',failed:true,scope:'current-visible-posts',dateAfter:spec.dateAfter,files:[]};
   try{
   if(spec.accessRequired==='authenticated-view'){
    Object.assign(h,{accessRequired:spec.accessRequired,observedCards:0,selectedCards:0,observations:[],coverage:witnessCoverage(spec,[])});
    throw new F.ArchiveError('ACCESS_REQUIRED','authenticated view required; no provider request attempted for '+spec.handle);
   }
   const page=await context.newPage();let observation;
   try{observation=await discover(page,spec.handle,budget,deadline,config.maxCards,deps.readinessWaitMs);
    if(spec.expectedPosts?.length){const category=await page.locator('#menu-wrapper .menu-item.active').first().getAttribute('data-id').catch(e=>{if(e.name==='TimeoutError')return null;throw e;});if(category!=='POSTS')throw new F.ArchiveError('FEED_COVERAGE_GAP','cannot verify Posts category for known-post witnesses');}
   }finally{await page.close().catch(()=>{});}
   // Only job-wide policy plus this handle's own cutoff; never a spec-level override.
   const rows=select(observation.raw,observation.observedAt,{dateAfter:spec.dateAfter,timeZone:config.timeZone,allowEstimatedDates:config.allowEstimatedDates});
   const observations=rows.map(({item,date,selected})=>({stableId:item.stableId,shortcode:item.shortcode,category:'posts',mediaType:item.mediaType,date,selected}));
   const coverage=witnessCoverage(spec,observations,observation.observedAt);
   Object.assign(h,{observedAt:observation.observedAt,observedCards:rows.length,selectedCards:rows.filter(x=>x.selected).length,observations,coverage});
   if(!coverage.satisfied){
    throw new F.ArchiveError('FEED_COVERAGE_GAP','known recent post absent or date-conflicting in provider listing for '+spec.handle+'; cutoff must not advance');
   }
   const paths=F.profilePaths(root,spec.handle);await F.ensureSafeDir(paths.stateDir,root);
   const files=await F.withLock(paths,config.runId,()=>acquireSelection(rows,paths,spec.handle,config.runId,budget,{...config,deadline,dnsLookup:deps.dnsLookup},result.totals));
   result.handles[spec.handle]={status:'COMPLETE',scope:'current-visible-posts',observedAt:observation.observedAt,observedCards:rows.length,dateAfter:spec.dateAfter,eligibility:spec.eligibility||'caller-selected',selectedCards:files.length,observations,coverage,files};
   }catch(e){
    // A sticky budget stop takes precedence over a coincident local parse gap.
    try{budget.assert();}catch(stop){e=stop;}
    const readiness=e.details?.readiness;
    const local=(HANDLE_LOCAL_ERRORS.has(e.code)||(e.code==='WINDOW_NOT_READY'&&localWindowReadiness(readiness)))&&Date.now()<deadline;
    if(readiness)h.readiness=readiness;
    h.error={code:e.code||'FAILED',message:F.redactSignedUrls(e.message),scope:local?'handle':'global'};
    if(!local)throw e;
    result.error ||= h.error;
   }
   await F.atomicWriteJson(resultFile+'.progress',result);
  }
  result.status=Object.values(result.handles).every(h=>h.status==='COMPLETE')?'COMPLETE':'PARTIAL';return result;
 }catch(e){result.stoppedGlobally=true;result.status=budget.data.denial||['DENIED','PROVIDER_DENIED','RATE_LIMITED'].includes(e.code)?'BLOCKED':'PARTIAL';result.error={code:e.code||'FAILED',message:F.redactSignedUrls(e.message),scope:'global'};for(const h of config.handles)if(!result.handles[h.handle])result.handles[h.handle]={status:'NOT_COMPLETED',failed:true,scope:'current-visible-posts',dateAfter:h.dateAfter,files:[]};return result;}
 finally{
  if(context)await context.close().catch(()=>{});if(ownsBrowser&&browser)await browser.close().catch(()=>{});
  result.finishedAt=new Date().toISOString();result.requests={session:budget.data.requests,hour:budget.data.recent_request_ms.length,blocked:budget.data.blocked,limit:budget.data.session_ceiling,quotaPolicy:budget.data.quota_policy,minRequestIntervalMs:budget.data.min_request_interval_ms,denial:budget.data.denial};
  // Release the ledger lock first: cleanup is best-effort and cannot throw, so a
  // genuine cleanup failure is published as evidence instead of replacing the
  // real run outcome from this finally block.
  const cleanupError=budget.close();
  if(cleanupError)result.requests.ledgerCleanupError={code:cleanupError.code||'LEDGER_CLEANUP_FAILED',message:F.redactSignedUrls(cleanupError.message)};
  await F.atomicWriteJson(resultFile,result);
 }
}

// Complete one bounded observation round from immutable recent partial results.
// This performs NO provider requests and never relabels the original results.
async function combineWindowResults(input,sourceFiles){
 const config=validate(input),root=await F.safeOutputRoot(config.output);
 if(!Array.isArray(sourceFiles)||!sourceFiles.length||sourceFiles.length>10)throw new F.ArchiveError('BAD_ARGS','1..10 result parts required');
 // A held handle can never be completed from result parts, so it is refused before
 // any caller-supplied document is read at all rather than after.
 for(const spec of config.handles)if(spec.accessRequired!==undefined)throw new F.ArchiveError('ACCESS_REQUIRED','held handle cannot be completed from result parts');
 const resultFile=path.resolve(config.resultFile);
 if(await fs.lstat(resultFile).catch(e=>e.code==='ENOENT'?null:Promise.reject(e)))throw new F.ArchiveError('EXISTS','result path must be new');
 const parts=[];
 for(const file of sourceFiles){
  // A caller-supplied part is evidence, not trusted input: an unreadable file and
  // malformed JSON are both "this part is not a result", and scheduled integrations
  // branch on `code`, so neither may surface as a raw platform error.
  let raw,d;
  try{raw=await fs.readFile(file);}catch(e){throw new F.ArchiveError('BAD_RESULT','result part cannot be read ('+(e.code||e.message)+')');}
  try{d=JSON.parse(raw);}catch(e){throw new F.ArchiveError('BAD_RESULT','result part is not parseable JSON');}
  // The part's own runId is republished as sourceRunId, so it must satisfy the same
  // safe-ID shape `validate` enforces for a run of our own, and the declared output
  // must be a string before it can be resolved against this job's root.
  if(!d||typeof d!=='object'||Array.isArray(d))throw new F.ArchiveError('BAD_RESULT','result part must be a result document');
  if(typeof d.runId!=='string'||!/^[A-Za-z0-9._-]{1,150}$/.test(d.runId))throw new F.ArchiveError('BAD_RESULT','result part lacks a safe run ID');
  if(d.kind!=='frameferry-sync-window'||d.schemaVersion!==1||d.scope!=='current-visible-posts'||d.fullHistoryComplete!==false||typeof d.output!=='string'||path.resolve(d.output)!==root||!['COMPLETE','PARTIAL'].includes(d.status)||d.requests?.denial)throw new F.ArchiveError('BAD_RESULT','incompatible or denied result part');
  parts.push({doc:d,sha256:crypto.createHash('sha256').update(raw).digest('hex'),runId:d.runId});
 }
 const handles={};
 for(const spec of config.handles){
  if(spec.accessRequired!==undefined)throw new F.ArchiveError('ACCESS_REQUIRED','held handle cannot be completed from result parts');
  const candidates=parts.map(p=>({part:p,value:p.doc.handles?.[spec.handle]})).filter(x=>x.value?.status==='COMPLETE'&&x.value.dateAfter===spec.dateAfter).sort((a,b)=>Date.parse(b.value.observedAt)-Date.parse(a.value.observedAt));
  const picked=candidates[0];if(!picked)throw new F.ArchiveError('MISSING_WINDOW','no verified window for '+spec.handle);
  const h=picked.value,age=Date.now()-Date.parse(h.observedAt);
  if(!Number.isFinite(age)||age<0||age>15*60000)throw new F.ArchiveError('STALE_WINDOW','window observation is stale');
  if(!Number.isInteger(h.observedCards)||h.observedCards<1||!Array.isArray(h.files)||h.selectedCards!==h.files.length||!Array.isArray(h.observations)||h.observations.length!==h.observedCards)throw new F.ArchiveError('BAD_RESULT','window evidence is structurally incomplete');
  const coverage=validateWitnessWindow(spec,h,config);
  const selected=new Map(h.observations.filter(x=>x.selected).map(x=>[x.stableId,x]));
  if(selected.size!==h.files.length)throw new F.ArchiveError('BAD_RESULT','duplicate selected identity');
  const paths=F.profilePaths(root,spec.handle),ids=new Set();
  for(const f of h.files){
   if(ids.has(f.stableId)||!selected.has(f.stableId)||JSON.stringify(f.date)!==JSON.stringify(selected.get(f.stableId).date))throw new F.ArchiveError('BAD_RECEIPT','result file failed identity/byte verification');
   // The immutable receipt on disk is the evidence, never the part document being
   // composed. Verifying the part's own file entry against itself only proved that
   // SOME media with those bytes exists under the media root, so a doctored entry —
   // or one with no receipt at all — composed as if it had been acquired.
   const receipt=await readReceipt(path.join(paths.receiptDir,f.stableId+'.json'));
   if(!receiptAgreesWithObservation(receipt,selected.get(f.stableId))||!await verifyStrictReceipt(paths,receipt,f.stableId,spec.handle))throw new F.ArchiveError('BAD_RECEIPT','result file failed identity/byte verification');
   for(const key of ['shortcode','mediaType','path','bytes','sha256','profileHandle','sourceHost'])if(f[key]!==receipt[key])throw new F.ArchiveError('BAD_RECEIPT','result file '+key+' contradicts the immutable on-disk receipt');
   if(f.receiptRunId!==receipt.runId)throw new F.ArchiveError('BAD_RECEIPT','result file receiptRunId contradicts the immutable on-disk receipt');
   ids.add(f.stableId);
  }
  handles[spec.handle]={...h,coverage,eligibility:spec.eligibility||'caller-selected',sourceRunId:picked.part.runId};
 }
 const d={schemaVersion:1,kind:'frameferry-sync-window',runId:config.runId,scope:'current-visible-posts',fullHistoryComplete:false,output:root,status:'COMPLETE',handles,totals:{downloaded:0,reused:Object.values(handles).reduce((n,h)=>n+h.files.length,0),bytes:0},composition:{maxObservationAgeMs:900000,additionalProviderRequests:0,sourceResults:parts.map(p=>({runId:p.runId,sha256:p.sha256,status:p.doc.status}))},finishedAt:new Date().toISOString()};
 await F.ensureSafeDir(path.dirname(resultFile),path.dirname(resultFile));await F.atomicWriteJson(resultFile,d);return d;
}

module.exports={windowSignature,localWindowReadiness,syncWindow,combineWindowResults,validate,select,discover,installGuards,acquireSelection,validateExpectedPosts,witnessCoverage,validateWitnessWindow};
