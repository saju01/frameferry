'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {setup,transport,F}=require('./fixtures/browser-lifecycle.cjs');
const {syncWindow}=require('../src/sync-window.js');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const contents=async p=>({media:await fs.readdir(p.mediaDir).catch(()=>[]),receipts:await fs.readdir(p.receiptDir).catch(()=>[])});
for(const mode of ['shared-denial','caller-abort'])test('R1 '+mode+' during EOF release must reject without a receipt',async t=>{
 const x=await transport(t),ac=new AbortController(),original=x.context.newCDPSession.bind(x.context);let stopped=false;
 x.context.newCDPSession=async page=>{const cdp=await original(page),send=cdp.send.bind(cdp);cdp.send=async(method,args)=>{const r=await send(method,args);if(method==='Runtime.releaseObject'&&!stopped){stopped=true;if(mode==='shared-denial')x.budget.deny('DENIED_AUTH',{status:403});else ac.abort(new F.ArchiveError('CALLER_ABORT','review EOF abort'));}return r;};return cdp;};
 const outcome=await x.download({signal:ac.signal}).then(r=>({resolved:true,receipt:r.receipt.stableId}),e=>({resolved:false,code:e.code}));
 const files=await contents(x.paths);console.log('REVIEW_EOF',JSON.stringify({mode,stopped,outcome,files,denial:x.budget.data.denial?.kind}));
 assert.equal(stopped,true);assert.equal(outcome.resolved,false,'a stop before EOF returns to writer must reject, not publish a receipt');assert.deepEqual(files,{media:[],receipts:[]});
});


for(const mode of ['caller','shared'])test('R1 '+mode+' stop during final filesystem preparation rejects without publication',async t=>{
 const x=await transport(t),ac=new AbortController(),lstat=fs.lstat;let stopped=false;
 fs.lstat=async(...args)=>{const result=await lstat(...args).catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(String(args[0]).endsWith(x.item.stableId+'.jpg')&&!stopped){stopped=true;if(mode==='caller')ac.abort(new F.ArchiveError('CALLER_ABORT','publication abort'));else x.budget.deny('DENIED_AUTH',{status:403});}if(result===null)throw Object.assign(new Error('absent'),{code:'ENOENT'});return result;};
 try{await assert.rejects(x.download({signal:ac.signal}));}finally{fs.lstat=lstat;}
 assert.equal(stopped,true);assert.deepEqual(await contents(x.paths),{media:[],receipts:[]});
});

for(const [id,seam] of [['challenge-form','dispatch'],['error-private','stalled'],['challenge-form','EOF'],['error-private','EOF']])test('R2 visible '+id+' at '+seam+' stops acquisition without a receipt',async t=>{
 const x=await setup(t,{stall:seam==='stalled'}),original=x.browser.newContext.bind(x.browser);let injected=false;
 x.browser.newContext=async options=>{const c=await original(options),np=c.newPage.bind(c),nc=c.newCDPSession.bind(c);
 const inject=async p=>{if(injected)return;injected=true;await p.evaluate(id=>{const el=document.createElement('div');el.id=id;el.textContent='refused';document.body.append(el);},id);};
 c.newPage=async()=>{const p=await np();if(seam==='dispatch')await p.route('**/media?*',async route=>{await inject(p);return route.fallback();});return p;};
 c.newCDPSession=async p=>{const cdp=await nc(p),send=cdp.send.bind(cdp);let pulls=0;cdp.send=async(method,args)=>{if(seam==='stalled'&&method==='Runtime.callFunctionOn'&&args.functionDeclaration.includes('this.reader.read')&&++pulls===2)setTimeout(()=>inject(p).catch(()=>{}),60);const r=await send(method,args);if(seam==='EOF'&&method==='Runtime.releaseObject')await inject(p);return r;};return cdp;};return c;};
 const start=Date.now(),result=await syncWindow(x.config,x.deps);assert.equal(injected,true);assert.equal(result.status,'BLOCKED');assert.equal(result.requests.denial.kind,id==='challenge-form'?'DENIED_CHALLENGE_DOM':'DENIED_ACCESS_DOM');assert.equal(result.totals.downloaded,0);assert.ok(Date.now()-start<6000,'DOM refusal must cancel a stalled source');assert.ok(x.hits.filter(h=>h.path==='/media').length<=1);assert.deepEqual(await contents(F.profilePaths(x.config.output,'example')),{media:[],receipts:[]});
});

for(const phase of ['attach','Page.getFrameTree','Page.createIsolatedWorld','Runtime.evaluate'])test('R3 file deadline bounds '+phase+' and disposes late setup without fetching',async t=>{
 const x=await transport(t),original=x.context.newCDPSession.bind(x.context);let release,waiting=false,detached=0;
 const gate=new Promise(r=>release=r);
 x.context.newCDPSession=async p=>{const cdp=await original(p),send=cdp.send.bind(cdp),detach=cdp.detach.bind(cdp);cdp.detach=async()=>{detached++;return detach();};if(phase==='attach'){waiting=true;await gate;}cdp.send=async(method,args)=>{const r=await send(method,args);if(method===phase){waiting=true;await gate;}return r;};return cdp;};
 let settled=false;const pending=x.download({remainingMs:80}).then(()=>{settled=true;return 'success';},e=>{settled=true;return e.code;});
 await pause(1300);const bounded=settled;release();const code=await pending;await pause(100);
 assert.equal(waiting,true);assert.equal(bounded,true);assert.notEqual(code,'success');assert.equal(x.hits.filter(h=>h.path==='/media').length,0);assert.ok(detached>0||x.page.isClosed());assert.deepEqual(await contents(x.paths),{media:[],receipts:[]});
});

for(const phase of ['page','context'])test('R3 owned '+phase+' cleanup is bounded without closing external resources',async t=>{
 const x=await setup(t),original=x.browser.newContext.bind(x.browser);let release,waiting=false;
 const gate=new Promise(r=>release=r);
 x.browser.newContext=async options=>{const c=await original(options);if(phase==='context'){const close=c.close.bind(c);c.close=async()=>{await close();waiting=true;await gate;};}else{const np=c.newPage.bind(c);c.newPage=async()=>{const p=await np(),close=p.close.bind(p);p.close=async()=>{await close();waiting=true;await gate;};return p;};}return c;};
 let settled=false;const pending=syncWindow(x.config,x.deps).then(r=>{settled=true;return r;});
 while(!waiting)await pause(10);await pause(1300);const bounded=settled;release();const result=await pending;
 assert.equal(bounded,true);assert.equal(result.status,'PARTIAL');assert.equal(result.error.code,'BROWSER_CLEANUP');
});

for(const mode of ['caller','shared'])test('R1 '+mode+' stop at receipt staging leaves no owned artifacts',async t=>{
 const x=await transport(t),ac=new AbortController(),write=fs.writeFile;let stopped=false;
 fs.writeFile=async(...args)=>{const r=await write(...args);if(String(args[0]).startsWith(x.paths.receiptDir+path.sep)&&String(args[0]).endsWith('.part')){stopped=true;if(mode==='caller')ac.abort(new F.ArchiveError('CALLER_ABORT','stage abort'));else x.budget.deny('DENIED_AUTH',{status:403});}return r;};
 try{await assert.rejects(x.download({signal:ac.signal}));}finally{fs.writeFile=write;}assert.equal(stopped,true);assert.deepEqual(await contents(x.paths),{media:[],receipts:[]});
});
test('R1 stopped reacquisition preserves a pre-existing verified media and receipt byte for byte',async t=>{
 const x=await transport(t),prior=await x.download(),receiptFile=path.join(x.paths.receiptDir,x.item.stableId+'.json'),mediaFile=path.join(x.paths.root,prior.receipt.path),bytes=await fs.readFile(receiptFile),mediaBytes=await fs.readFile(mediaFile),original=x.context.newCDPSession.bind(x.context);
 x.context.newCDPSession=async p=>{const cdp=await original(p),send=cdp.send.bind(cdp);cdp.send=async(method,args)=>{const r=await send(method,args);if(method==='Runtime.releaseObject')x.budget.deny('DENIED_AUTH',{status:403});return r;};return cdp;};
 await assert.rejects(x.download(),{code:'PROVIDER_DENIED'});assert.deepEqual(await fs.readFile(receiptFile),bytes);assert.deepEqual(await fs.readFile(mediaFile),mediaBytes);assert.equal(await F.verifyReceipt(x.paths,prior.receipt),true);assert.equal((await contents(x.paths)).media.length,1);
});
test('R1 denial at second file EOF retains only the successfully committed first file',async t=>{
 const x=await setup(t),original=x.browser.newContext.bind(x.browser);let releases=0;
 x.browser.newContext=async options=>{const c=await original(options),nc=c.newCDPSession.bind(c);await c.route('**/api/seam-denial',route=>route.fulfill({status:403,body:'denied'}));c.newCDPSession=async p=>{const cdp=await nc(p),send=cdp.send.bind(cdp);cdp.send=async(method,args)=>{const r=await send(method,args);if(method==='Runtime.releaseObject'&&++releases===2)await p.evaluate(()=>fetch('/api/seam-denial').then(r=>r.status));return r;};return cdp;};return c;};
 const result=await syncWindow(x.config,x.deps),paths=F.profilePaths(x.config.output,'example'),files=await contents(paths);assert.equal(result.status,'BLOCKED');assert.equal(result.totals.downloaded,1);assert.equal(files.media.length,1);assert.equal(files.receipts.length,1);assert.equal(await F.verifyReceipt(paths,JSON.parse(await fs.readFile(path.join(paths.receiptDir,files.receipts[0])))),true);
});
test('R1 failed receipt commit rolls back only the newly owned media',async t=>{
 const x=await transport(t),native=require('node:fs'),rename=native.renameSync;let injected=false;
 native.renameSync=(from,to)=>{if(String(to)===path.join(x.paths.receiptDir,x.item.stableId+'.json')){injected=true;throw Object.assign(new Error('receipt commit failure'),{code:'ENOSPC'});}return rename(from,to);};
 try{await assert.rejects(x.download(),{code:'ENOSPC'});}finally{native.renameSync=rename;}assert.equal(injected,true);assert.deepEqual(await contents(x.paths),{media:[],receipts:[]});
});
for(const mode of ['caller','shared'])test('R3 '+mode+' cancellation bounds pre-fetch attachment',async t=>{
 const x=await transport(t),ac=new AbortController(),nc=x.context.newCDPSession.bind(x.context);let release,waiting=false;
 const gate=new Promise(r=>release=r);x.context.newCDPSession=async p=>{const s=await nc(p);waiting=true;await gate;return s;};
 let settled=false;const pending=x.download({signal:ac.signal}).then(()=>{settled=true;return 'success';},e=>{settled=true;return e.code;});while(!waiting)await pause(10);
 if(mode==='caller')ac.abort(new F.ArchiveError('CALLER_ABORT','setup abort'));else x.budget.deny('DENIED_AUTH',{status:403});await pause(1200);const bounded=settled;release();assert.equal(await pending,mode==='caller'?'CALLER_ABORT':'PROVIDER_DENIED');assert.equal(bounded,true);await pause(50);assert.equal(x.hits.filter(h=>h.path==='/media').length,0);
});
test('R2 final filesystem-stage DOM refusal blocks publication',async t=>{
 const x=await setup(t),nc=x.browser.newContext.bind(x.browser),write=fs.writeFile;let page,injected=false;
 x.browser.newContext=async o=>{const c=await nc(o),np=c.newPage.bind(c);c.newPage=async()=>page=await np();return c;};
 fs.writeFile=async(...args)=>{const v=await write(...args);if(String(args[0]).includes('receipts')&&String(args[0]).endsWith('.part')){injected=true;await page.evaluate(()=>{const e=document.createElement('div');e.id='challenge-form';e.textContent='refused';document.body.append(e);});}return v;};
 let result;try{result=await syncWindow(x.config,x.deps);}finally{fs.writeFile=write;}assert.equal(injected,true);assert.equal(result.status,'BLOCKED');assert.equal(result.totals.downloaded,0);assert.deepEqual(await contents(F.profilePaths(x.config.output,'example')),{media:[],receipts:[]});
});
test('R2 hidden challenge and hidden access wall do not refuse ordinary multi-file acquisition',async t=>{
 const x=await setup(t),nc=x.browser.newContext.bind(x.browser);
 x.browser.newContext=async o=>{const c=await nc(o),np=c.newPage.bind(c);c.newPage=async()=>{const p=await np();await p.route('**/media?*',async route=>{await p.evaluate(()=>{for(const id of ['challenge-form','error-private']){const el=document.createElement('div');el.id=id;el.textContent='hidden';el.style.display='none';document.body.append(el);}});return route.fallback();});return p;};return c;};
 const result=await syncWindow(x.config,x.deps);assert.equal(result.status,'COMPLETE');assert.equal(result.totals.downloaded,2);assert.equal(result.requests.denial,null);
});
