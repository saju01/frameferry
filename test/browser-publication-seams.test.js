'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {setup,transport,F}=require('./fixtures/browser-lifecycle.cjs');
const {syncWindow}=require('../src/sync-window.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const contents=async p=>({media:await fs.readdir(p.mediaDir).catch(()=>[]),receipts:await fs.readdir(p.receiptDir).catch(()=>[])});
for(const seam of ['prefetch','commit'])test('R3 file deadline bounds retained-page refusal check at '+seam,async t=>{
 const x=await setup(t),download=F.downloadOne,observe=F.observeWindowSnapshot,write=fs.writeFile;
 let release,waiting=false,inDownload=false,staged=false,settled=false;
 const gate=new Promise(r=>release=r);
 F.downloadOne=(item,paths,opts)=>{inDownload=true;return download(item,paths,{...opts,remainingMs:seam==='prefetch'?80:1200});};
 fs.writeFile=async(...args)=>{const r=await write(...args);if(String(args[0]).includes('receipts')&&String(args[0]).endsWith('.part'))staged=true;return r;};
 F.observeWindowSnapshot=async(p,args)=>{const r=await observe(p,args);if(args.refusalOnly&&inDownload&&(seam==='prefetch'||staged)){waiting=true;await gate;}return r;};
 let result,bounded;
 try{
  const pending=syncWindow(x.config,x.deps).then(r=>{settled=true;return r;});
  while(!waiting&&!settled)await pause(10);assert.equal(waiting,true);
  await pause(1500);bounded=settled;release();result=await pending;
 }finally{release();F.downloadOne=download;F.observeWindowSnapshot=observe;fs.writeFile=write;}
 assert.equal(bounded,true,'file timeout must bound the DOM check, not just the later CDP setup');assert.equal(result.status,'PARTIAL');assert.equal(result.error.code,'TIMEOUT');assert.equal(result.totals.downloaded,0);assert.deepEqual(await contents(F.profilePaths(x.config.output,'example')),{media:[],receipts:[]});
});

test('R2 refusal remains observed until the retained page actually closes',async t=>{
 const x=await setup(t),nc=x.browser.newContext.bind(x.browser);let injected=false;
 x.browser.newContext=async o=>{const c=await nc(o),np=c.newPage.bind(c);c.newPage=async()=>{const p=await np(),close=p.close.bind(p);p.close=async()=>{if(!injected){injected=true;await p.evaluate(()=>{const e=document.createElement('div');e.id='challenge-form';e.textContent='refused';document.body.append(e);});await pause(150);}return close();};return p;};return c;};
 const result=await syncWindow(x.config,x.deps);assert.equal(injected,true);assert.equal(result.status,'BLOCKED');assert.equal(result.requests.denial.kind,'DENIED_CHALLENGE_DOM');assert.notEqual(result.handles.example.status,'COMPLETE');
 // Both files committed before this refusal. They remain valid earlier work.
 assert.equal(result.totals.downloaded,2);assert.equal((await contents(F.profilePaths(x.config.output,'example'))).receipts.length,2);
});

test('R1 receipt-stage name collision never deletes an artifact this acquisition did not create',async t=>{
 const x=await transport(t),write=fs.writeFile;let foreign;
 fs.writeFile=async(file,...args)=>{if(String(file).startsWith(x.paths.receiptDir+path.sep)&&String(file).endsWith('.part')){foreign=file;await write(file,'other-owner',{flag:'wx'});}return write(file,...args);};
 try{await assert.rejects(x.download(),{code:'EEXIST'});}finally{fs.writeFile=write;}
 assert.ok(foreign);assert.equal(await fs.readFile(foreign,'utf8'),'other-owner');assert.deepEqual(await fs.readdir(x.paths.mediaDir),[]);assert.equal((await fs.readdir(x.paths.receiptDir)).filter(n=>n.endsWith('.json')).length,0);
});
