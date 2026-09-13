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
function validate(config){
 if(!config||!Array.isArray(config.handles)||!config.handles.length||config.handles.length>100)throw new F.ArchiveError('BAD_ARGS','1..100 explicit handles required');
 const seen=new Set();
 for(const h of config.handles){F.validateHandle(h.handle);if(seen.has(h.handle))throw new F.ArchiveError('BAD_ARGS','duplicate handle');seen.add(h.handle);
  if(typeof h.dateAfter!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(h.dateAfter)||new Date(h.dateAfter).toISOString().slice(0,10)!==h.dateAfter)throw new F.ArchiveError('BAD_ARGS','explicit calendar dateAfter required');
 }
 if(typeof config.runId!=='string'||!/^[A-Za-z0-9._-]{1,150}$/.test(config.runId))throw new F.ArchiveError('BAD_ARGS','safe runId required');
 if(!config.output||!config.resultFile||!config.requestLedger)throw new F.ArchiveError('BAD_ARGS','output, resultFile and requestLedger required');
 if(config.attachCdp){const u=new URL(config.attachCdp);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new F.ArchiveError('BAD_CDP','explicit loopback CDP required');}
 new Intl.DateTimeFormat('en-US',{timeZone:config.timeZone||'UTC'});
 return {...config,maxTimeMs:number(config.maxTimeMs,600000,1000,1200000,'maxTimeMs'),maxFileBytes:number(config.maxFileBytes,52428800,1024,268435456,'maxFileBytes'),maxBytes:number(config.maxBytes,1073741824,1024,2147483648,'maxBytes'),maxCards:number(config.maxCards,1000,1,10000,'maxCards')};
}
function select(raw,observedAt,options){
 if(!raw.length)throw new F.ArchiveError('EMPTY_WINDOW','no visible post cards; not nothing-new');
 const indexed=F.normalizeItems(raw.map(x=>({...x,observedAt})),{category:'posts',mediaTypes:['image','video']}).items;
 if(indexed.length!==raw.length)throw new F.ArchiveError('AMBIGUOUS_WINDOW','normalization changed visible card count; refusing silent drops');
 return indexed.map(item=>{
  if(!item.shortcode||!item.stableId||!item.href)throw new F.ArchiveError('BAD_ITEM','visible post lacks bound identity or media URL');
  F.validateProviderMediaUrl(item.href);
  const date=estimateDate(item.dateRaw,observedAt,options.timeZone||'UTC');
  if(date.precision==='estimated'&&options.allowEstimatedDates!==true)throw new F.ArchiveError('DATE_POLICY','ambiguous source date requires explicit allowEstimatedDates');
  return {item,date,selected:date.dayHi>=options.dateAfter};
 });
}
async function installGuards(page,budget){
 await page.route('**/*',async route=>{
  const req=route.request();const u=new URL(req.url());
  // Cosmetic previews never leave the browser. Media acquisition uses downloadOne.
  if(['image','media','stylesheet','font'].includes(req.resourceType()))return route.abort('blockedbyclient');
  if(u.origin!==F.PROVIDER_ORIGIN)return route.fallback();
  try{budget.assert();budget.reserve('discovery');}
  catch(e){return route.abort('blockedbyclient');}
  return route.fallback();
 });
 page.on('response',res=>{
  try{const u=new URL(res.url());if(u.origin===F.PROVIDER_ORIGIN)budget.inspect(res.status(),res.headers(),res.url());}
  catch(e){budget.fail(e.code||'PROVIDER_DENIED',e.message);}
 });
}
async function discover(page,handle,budget,deadline,maxCards){
 page.setDefaultTimeout(Math.max(1,Math.min(45000,deadline-Date.now())));
 await installGuards(page,budget);budget.assert();
 await page.goto(F.PROVIDER_PHOTO_URL,{waitUntil:'domcontentloaded'});budget.assert();
 await page.fill('input#search-input',handle);await page.click('button#download-btn');
 const ready=await F.waitForProfileReady(page,handle,{started:Date.now(),maxTimeMs:Math.max(1,deadline-Date.now()),waitMs:Math.min(30000,Math.max(1,deadline-Date.now()))});
 budget.assert();if(!ready.ready||ready.blocked)throw new F.ArchiveError('PROFILE_NOT_READY','requested public profile not ready: '+JSON.stringify(ready));
 const end=Math.min(deadline,Date.now()+45000);let last=null;
 while(Date.now()<end){
  budget.assert();const raw=await F.readRawCardsFromPage(page);
  if(raw.length>maxCards)throw new F.ArchiveError('WINDOW_LIMIT','visible window exceeds item bound');
  const signature=JSON.stringify(raw);
  if(raw.length&&signature===last){budget.assert();return {raw,observedAt:new Date().toISOString()};}
  last=signature;await sleep(1000);
 }
 throw new F.ArchiveError('WINDOW_NOT_READY','visible post window did not stabilize');
}
async function acquireSelection(rows,paths,handle,runId,budget,options,totals){
 const out=[];
 for(const {item,date,selected} of rows){
  if(!selected)continue;budget.assert();if(Date.now()>=options.deadline)throw new F.ArchiveError('TIME_LIMIT','incremental job deadline reached');
  const receiptPath=path.join(paths.receiptDir,item.stableId+'.json');
  let receipt=await F.readJson(receiptPath,null),reused=false;
  // Never alias legacy carousel positions or rotating locators without byte proof.
  if(receipt&&receipt.profileHandle===handle&&receipt.stableId===item.stableId&&receipt.providerMediaFingerprint===item.providerMediaFingerprint&&await F.verifyReceipt(paths,receipt))reused=true;
  else {
   const remaining=options.maxBytes-totals.bytes;if(remaining<1)throw new F.ArchiveError('BYTE_LIMIT','incremental byte allowance exhausted');
   const result=await F.downloadOne(item,paths,{handle,runId,fetchImpl:budget.fetch,stopOnDenial:true,dnsLookup:options.dnsLookup,maxBytes:Math.min(options.maxFileBytes,remaining),remainingMs:Math.min(30000,options.deadline-Date.now()),completedMap:{}});
   if(result.conflict)throw new F.ArchiveError('IDENTITY_CONFLICT','conflicting media bytes held unchanged');
   receipt=result.receipt;totals.downloaded++;totals.bytes+=receipt.bytes;
  }
  if(!await F.verifyReceipt(paths,receipt))throw new F.ArchiveError('BAD_RECEIPT','selected receipt bytes failed verification');
  if(reused)totals.reused++;
  out.push({stableId:receipt.stableId,shortcode:receipt.shortcode,mediaType:receipt.mediaType,path:receipt.path,bytes:receipt.bytes,sha256:receipt.sha256,profileHandle:receipt.profileHandle,sourceHost:receipt.sourceHost,date,receiptRunId:receipt.runId,reused});
 }
 return out;
}
async function syncWindow(input,deps={}){
 const config=validate(input),root=await F.safeOutputRoot(config.output),resultFile=path.resolve(config.resultFile);
 await F.ensureSafeDir(path.dirname(resultFile),path.dirname(resultFile));
 if(await fs.lstat(resultFile).catch(e=>e.code==='ENOENT'?null:Promise.reject(e)))throw new F.ArchiveError('EXISTS','result already exists; use a new run result path');
 const budget=openBudget(config.requestLedger,config.runId,config.maxRequests),deadline=Date.now()+config.maxTimeMs;
 const result={schemaVersion:1,kind:'frameferry-sync-window',runId:config.runId,scope:'current-visible-posts',fullHistoryComplete:false,output:root,handles:{},totals:{downloaded:0,reused:0,bytes:0},status:'RUNNING'};
 let browser,context;
 try{
  budget.assert();
  const chromium=deps.chromium||require('playwright').chromium;
  browser=config.attachCdp?await chromium.connectOverCDP(config.attachCdp,{timeout:20000}):await chromium.launch({headless:true,executablePath:config.browserExecutable,timeout:20000});
  // Own isolated context with service workers blocked; close only owned resources.
  context=await browser.newContext({serviceWorkers:'block'});
  for(const spec of config.handles){
   budget.assert();if(Date.now()>=deadline)throw new F.ArchiveError('TIME_LIMIT','job deadline reached');
   const page=await context.newPage();let observation;
   try{observation=await discover(page,spec.handle,budget,deadline,config.maxCards);}finally{await page.close().catch(()=>{});}
   const rows=select(observation.raw,observation.observedAt,{...config,...spec});
   const paths=F.profilePaths(root,spec.handle);await F.ensureSafeDir(paths.stateDir,root);
   const files=await F.withLock(paths,config.runId,()=>acquireSelection(rows,paths,spec.handle,config.runId,budget,{...config,deadline,dnsLookup:deps.dnsLookup},result.totals));
   result.handles[spec.handle]={status:'COMPLETE',scope:'current-visible-posts',observedAt:observation.observedAt,observedCards:rows.length,dateAfter:spec.dateAfter,eligibility:spec.eligibility||'caller-selected',selectedCards:files.length,observations:rows.map(({item,date,selected})=>({stableId:item.stableId,shortcode:item.shortcode,mediaType:item.mediaType,date,selected})),files};
   await F.atomicWriteJson(resultFile+'.progress',result);
  }
  result.status='COMPLETE';return result;
 }catch(e){result.status=budget.data.denial?'BLOCKED':'PARTIAL';result.error={code:e.code||'FAILED',message:F.redactSignedUrls(e.message)};for(const h of config.handles)if(!result.handles[h.handle])result.handles[h.handle]={status:'NOT_COMPLETED',failed:true,files:[]};return result;}
 finally{
  if(context)await context.close().catch(()=>{});if(browser)await browser.close().catch(()=>{});
  result.finishedAt=new Date().toISOString();result.requests={session:budget.data.requests,hour:budget.data.recent_request_ms.length,blocked:budget.data.blocked,limit:budget.data.session_ceiling,denial:budget.data.denial};
  try{await F.atomicWriteJson(resultFile,result);}finally{budget.close();}
 }
}
module.exports={syncWindow,validate,select,discover,installGuards,acquireSelection};
