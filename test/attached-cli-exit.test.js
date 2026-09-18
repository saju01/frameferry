'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const {chromium}=require('playwright');
const exe=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath();
const cli=path.resolve(__dirname,'../bin/frameferry.js');
async function runCli(dir,attachCdp){
 const cfg={runId:attachCdp?'attached-control':'owned-control',handles:[{handle:'offline_control',dateAfter:'2026-09-18',accessRequired:'authenticated-view'}],output:path.join(dir,'cache'),resultFile:path.join(dir,'result.json'),requestLedger:path.join(dir,'ledger.json'),maxTimeMs:5000,maxFileBytes:1024,maxBytes:1024,browserExecutable:exe};
 if(attachCdp)cfg.attachCdp=attachCdp;
 await fs.writeFile(path.join(dir,'job.json'),JSON.stringify(cfg));
 const child=spawn(process.execPath,[cli,'sync-window','--config',path.join(dir,'job.json')],{stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='',timedOut=false;
 child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);
 const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),1000).unref()},7000);
 const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});clearTimeout(timer);
 const receipt=JSON.parse(await fs.readFile(cfg.resultFile,'utf8'));
 assert.equal(receipt.status,'PARTIAL');assert.equal(receipt.handles.offline_control.error.code,'ACCESS_REQUIRED');assert.equal(receipt.requests.session,0);assert.equal(receipt.totals.downloaded,0);
 return {timedOut,exit,receiptStatus:receipt.status,sourceRequests:receipt.requests.session,stdoutFinal:stdout.includes('"status":"PARTIAL"'),stderr};
}
test('owned-browser CLI naturally exits after a zero-provider receipt',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ff-owned-exit-'));
 const result=await runCli(dir);console.log('OWNED_CONTROL',JSON.stringify(result));assert.equal(result.timedOut,false);assert.equal(result.exit.code,1);
});
test('attached-browser CLI naturally exits and preserves external browser/context',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ff-attached-exit-'));
 const browserProcess=spawn(exe,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--disable-background-networking','--disable-default-apps','--disable-sync','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+path.join(dir,'browser-profile'),'about:blank'],{stdio:['ignore','ignore','pipe']});
 let controller;
 try{
  const port=await new Promise((resolve,reject)=>{let buffer='';const timer=setTimeout(()=>reject(new Error('isolated CDP startup timed out')),5000);browserProcess.stderr.on('data',x=>{buffer+=x;const m=buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(Number(m[1]));}});browserProcess.once('error',reject);});
  const endpoint='http://127.0.0.1:'+port;controller=await chromium.connectOverCDP(endpoint);const sentinel=controller.contexts()[0];const page=sentinel.pages()[0];await page.setContent('<title>owned-sentinel</title>');
  const result=await runCli(dir,endpoint);const cdp=await controller.newBrowserCDPSession();await cdp.send('Browser.getVersion');await cdp.detach();
  result.externalBrowserSurvived=true;result.sentinelSurvived=await page.title()==='owned-sentinel';
  console.log('ATTACHED_CONTROL',JSON.stringify(result));assert.equal(result.sentinelSurvived,true);assert.equal(result.timedOut,false,'CLI published its final receipt but did not naturally exit');assert.equal(result.exit.code,1);
 }finally{if(controller)await controller.close().catch(()=>{});browserProcess.kill('SIGTERM');await new Promise(resolve=>{if(browserProcess.exitCode!==null||browserProcess.signalCode!==null)return resolve();browserProcess.once('exit',resolve);setTimeout(()=>{browserProcess.kill('SIGKILL');resolve()},2000).unref()});}
});
