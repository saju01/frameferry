'use strict';
const {ArchiveError,validateProviderMediaUrl,PROVIDER_ORIGIN}=require('./index.js');
// Explicit bridge storage is bounded independently of the media size. Chromium's
// native fetch/network buffers and the rest of the page are NOT a bounded heap.
const BRIDGE_BYTES=16384;
async function boundedBrowserCleanup(task){
 let timer;
 try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new ArchiveError('BROWSER_CLEANUP','browser media cleanup timed out')),1000);})]);}
 finally{clearTimeout(timer);}
}
// A private CDP remote object in an isolated world: no page-world fetch, binding,
// Response overrides, cookie/header export or whole-response serialization.
async function browserMediaFetch(page,budget,url,{signal}={}){
 signal=AbortSignal.any([signal,budget.signal].filter(Boolean));
 validateProviderMediaUrl(url);budget.assert();signal?.throwIfAborted();
 if(new URL(page.url()).origin!==PROVIDER_ORIGIN)throw new ArchiveError('BROWSER_TRANSPORT','media requires the discovery origin');
 let cdp,objectId,closing,setupComplete=false;
 const assertActive=()=>{budget.assert();signal.throwIfAborted();};
 // Subscribe before even attaching. Each protocol await is raced, and a late
 // attachment/object is disposed rather than allowed to resume into native fetch.
 const active=async(task,dispose)=>{
  let abort;
  try{
   const result=await Promise.race([Promise.resolve(task).then(value=>{
    if(signal.aborted){if(dispose)Promise.resolve(dispose(value)).catch(()=>{});throw signal.reason;}
    return value;
   }),new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);
   assertActive();return result;
  }finally{signal.removeEventListener('abort',abort);}
 };
 const call=async(functionDeclaration,args=[],returnByValue=true)=>{
  const r=await cdp.send('Runtime.callFunctionOn',{objectId,functionDeclaration,arguments:args.map(value=>({value})),awaitPromise:true,returnByValue});
  if(r.exceptionDetails)throw new ArchiveError('BROWSER_TRANSPORT','browser media operation failed');
  return r.result.value;
 };
 const boundedCleanup=boundedBrowserCleanup;
 const close=reason=>{
  if(reason instanceof Error){
   let stopped=false;try{budget.assert();}catch(e){stopped=true;}
   if(!stopped)budget.fail(reason.code||'BROWSER_TRANSPORT','browser media acquisition failed');
  }
  return closing||=(async()=>{
  try{
   if(!setupComplete&&signal.aborted){
    // Setup may be waiting inside a stalled renderer. Target closure is owned
    // page cleanup, never browser/default-context termination.
    await boundedCleanup(page.close());
   }
   if(objectId)await boundedCleanup((async()=>{
    try{await call('async function(){try{if(this.reader){try{await this.reader.cancel();}finally{this.reader.releaseLock();this.reader=null;}}}finally{this.controller.abort();}}');}
    finally{await cdp.send('Runtime.releaseObject',{objectId});}
   })());
  }catch(e){
   // An unresponsive reader must not leave the source running. This is an owned
   // page, never an external/default page or the external browser itself.
   budget.fail('BROWSER_CLEANUP','browser media cleanup failed');
   await boundedCleanup(page.close());throw e;
  }finally{
   try{if(cdp&&!page.isClosed())await boundedCleanup(cdp.detach());}
   finally{signal.removeEventListener('abort',onAbort);}
  }
  })();
 };
 const onAbort=()=>{
  // A file timeout/caller abort is terminal for this window, including requests
  // already queued behind the page's pacing guard. Do not downgrade a denial.
  if(!budget.signal?.aborted)budget.fail(signal.reason instanceof ArchiveError?signal.reason.code:'TIMEOUT','browser media acquisition aborted');

  close().catch(()=>{});
 };
 signal.addEventListener('abort',onAbort,{once:true});
 try{
  assertActive();
  cdp=await active(page.context().newCDPSession(page),late=>boundedCleanup(late.detach()));
  const {frameTree}=await active(cdp.send('Page.getFrameTree'));
  const {executionContextId}=await active(cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'frameferry-media'}));
  const r=await active(cdp.send('Runtime.evaluate',{contextId:executionContextId,expression:'({controller:new AbortController(),reader:null})',returnByValue:false}),late=>late.result?.objectId?boundedCleanup(cdp.send('Runtime.releaseObject',{objectId:late.result.objectId})):undefined);
  if(r.exceptionDetails||!r.result.objectId)throw new ArchiveError('BROWSER_TRANSPORT','cannot create browser media reader');
  objectId=r.result.objectId;setupComplete=true;assertActive();
  const meta=await active(call(`async function(url){const r=await fetch(url,{credentials:'same-origin',redirect:'manual',signal:this.controller.signal});this.reader=r.body?r.body.getReader({mode:'byob'}):null;return {status:r.status,type:r.type,headers:{'content-type':r.headers.get('content-type'),'content-length':r.headers.get('content-length'),'retry-after':r.headers.get('retry-after')}};}`,[url]));
  budget.inspect(meta.status,meta.headers,url);
  if(meta.type==='opaqueredirect'||meta.status===0)throw new ArchiveError('BROWSER_REDIRECT','browser media redirects are unsupported; no hop followed');
  if(String(meta.headers['content-type']).toLowerCase().includes('text/html'))throw budget.deny('DENIED_CONTENT_WALL');
  let reading=false;
  const reader={async read(){
   if(reading)throw new ArchiveError('BROWSER_TRANSPORT','overlapping browser media pulls');
   budget.assert();signal?.throwIfAborted();reading=true;
   try{
    const value=await active(call(`async function(n){if(!this.reader)return null;const r=await this.reader.read(new Uint8Array(n));return r.done?null:Array.from(r.value);}`,[BRIDGE_BYTES]));
    budget.assert();signal?.throwIfAborted();
    if(value===null){await close();assertActive();return {done:true};}
    if(!Array.isArray(value)||value.length>BRIDGE_BYTES)throw new ArchiveError('BROWSER_TRANSPORT','invalid browser media chunk');
    return {done:false,value:Uint8Array.from(value)};
   }finally{reading=false;}
  },cancel:close,releaseLock(){}};
  // This gate remains authoritative after remote EOF cleanup, through publication.
  return {assertActive,status:meta.status,ok:meta.status>=200&&meta.status<300,headers:{get:k=>meta.headers[k.toLowerCase()]??null},body:{getReader:()=>reader,cancel:close},close};
 }catch(e){await close(e);throw e;}
}
module.exports={browserMediaFetch,BRIDGE_BYTES,boundedBrowserCleanup};
