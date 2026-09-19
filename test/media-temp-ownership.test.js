'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),native=require('node:fs'),path=require('node:path');
const {setup,transport,F}=require('./fixtures/browser-lifecycle.cjs');
const W=require('../src/sync-window.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const contents=async p=>({media:await fs.readdir(p.mediaDir).catch(()=>[]),receipts:await fs.readdir(p.receiptDir).catch(()=>[])});
async function waitFor(fn,ms=1000){const end=Date.now()+ms;while(!fn()&&Date.now()<end)await pause(10);assert.ok(fn(),'seam reached');}

test('REREVIEW media temporary-path collision preserves foreign part',async t=>{
 const x=await transport(t),open=fs.open;let foreign;
 fs.open=async(file,...args)=>{if(String(file).startsWith(x.paths.mediaDir+path.sep)&&String(file).endsWith('.part')&&!foreign){foreign=file;await fs.writeFile(file,'other-owner',{flag:'wx'});}return open(file,...args);};
 let code;try{code=await x.download().then(()=> 'success',e=>e.code);}finally{fs.open=open;}
 const preserved=foreign?await fs.readFile(foreign,'utf8').catch(e=>e.code):null;
 console.log('REREVIEW_MEDIA_COLLISION',JSON.stringify({code,preserved,files:await contents(x.paths)}));assert.equal(code,'EEXIST');assert.equal(preserved,'other-owner');
});

test('A1 exclusive media part failure cleans only the successfully created part',async t=>{
 const x=await transport(t),open=fs.open;let owned,closed=false;
 fs.open=async(file,...args)=>{
  const fh=await open(file,...args);
  if(String(file).startsWith(x.paths.mediaDir+path.sep)&&String(file).endsWith('.part')){
   owned=file;const close=fh.close.bind(fh);fh.close=async()=>{closed=true;return close();};
   fh.write=async()=>{throw Object.assign(new Error('fixture disk full'),{code:'ENOSPC'});};
  }
  return fh;
 };
 try{await assert.rejects(x.download(),{code:'ENOSPC'});}finally{fs.open=open;}
 assert.ok(owned);assert.ok(closed);assert.deepEqual(await contents(x.paths),{media:[],receipts:[]});
});

test('A1 successful exclusive media part still produces verified canonical media and receipt',async t=>{
 const x=await transport(t),got=await x.download(),files=await contents(x.paths);
 assert.equal(await F.verifyReceipt(x.paths,got.receipt),true);
 assert.deepEqual(files,{media:[x.item.stableId+'.jpg'],receipts:[x.item.stableId+'.json']});
});

test('A1 failed exclusive creation preserves preexisting verified media and receipt',async t=>{
 const x=await transport(t),got=await x.download(),receiptFile=path.join(x.paths.receiptDir,x.item.stableId+'.json'),mediaFile=path.join(x.paths.root,got.receipt.path);
 const priorReceipt=await fs.readFile(receiptFile),priorMedia=await fs.readFile(mediaFile),open=fs.open,foreignBytes=Buffer.from([0,255,31,42,7]);let foreign;
 fs.open=async(file,...args)=>{if(String(file).startsWith(x.paths.mediaDir+path.sep)&&String(file).endsWith('.part')){foreign=file;await fs.writeFile(file,foreignBytes,{flag:'wx'});}return open(file,...args);};
 try{await assert.rejects(x.download(),{code:'EEXIST'});}finally{fs.open=open;}
 assert.ok(foreign);assert.deepEqual(await fs.readFile(foreign),foreignBytes);
 assert.deepEqual(await fs.readFile(receiptFile),priorReceipt);assert.deepEqual(await fs.readFile(mediaFile),priorMedia);
 assert.equal(await F.verifyReceipt(x.paths,got.receipt),true);
 assert.equal((await contents(x.paths)).media.length,2);assert.equal((await contents(x.paths)).receipts.length,1);
});
