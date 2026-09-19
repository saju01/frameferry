'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const F=require('../src/index.js'),{syncWindow}=require('../src/sync-window.js');
const fixture=require('./fixtures/listing-page.js');
const {browserMediaFetch,BRIDGE_BYTES}=require('../src/browser-media-transport.js');
const {openBudget}=require('../src/request-budget.js');
const {installGuards}=require('../src/sync-window.js');
const publicDns=async()=>[{address:'93.184.216.34',family:4}];
const media=Buffer.alloc(196631,37);media.set([255,216,255,224]);
async function setup(t,{status=200,html=false,redirect=false,stall=false,declared=null}={}){
 // All endpoints below are synthetic; host mapping is confined to this test browser.
 if(process.env.INSTACOGNITO_SANDBOX){assert.deepEqual(Object.keys(os.networkInterfaces()).filter(n=>n!=='lo'),[]);}
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ff-browser-media-'));
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'key.pem'),'-out',path.join(dir,'cert.pem'),'-days','1','-subj','/CN=instacognito.com'],{stdio:'ignore'});
 const hits=[],sockets=new Set();let closedMedia=0;
 const server=https.createServer({key:await fs.readFile(path.join(dir,'key.pem')),cert:await fs.readFile(path.join(dir,'cert.pem'))},(req,res)=>{
  const u=new URL(req.url,'https://instacognito.com');hits.push({path:u.pathname,cookie:req.headers.cookie||'',id:u.searchParams.get('id')});
  if(u.pathname==='/media'){
   res.on('close',()=>closedMedia++);
   if(!req.headers.cookie?.includes('fixture_session=ready')){res.writeHead(403);return res.end('session required');}
   if(redirect){res.writeHead(302,{location:'https://forbidden.invalid/target'});return res.end();}
   res.writeHead(status,{'content-type':html?'text/html':'image/jpeg',...(declared===null?{}:{'content-length':String(declared)})});res.flushHeaders();
   if(status!==200||html)return res.end(html?'<html>access denied</html>':'refused');
   let offset=0;const timer=setInterval(()=>{if(stall&&offset)return;const chunk=media.subarray(offset,offset+8192);offset+=chunk.length;res.write(chunk);if(offset===media.length){clearInterval(timer);res.end();}},5);res.on('close',()=>clearInterval(timer));return;
  }
  if(u.pathname==='/api/profile'){res.setHeader('content-type','application/json');return res.end('{}');}
  if(u.pathname==='/api/posts'){res.setHeader('content-type','application/json');return res.end(JSON.stringify(fixture.posts(fixture.rec({code:'ONE',media:'first'}),fixture.rec({code:'TWO',media:'second'}))));}
  res.setHeader('content-type','text/html');res.setHeader('set-cookie','fixture_session=ready; Secure; HttpOnly; SameSite=Strict; Path=/');
  res.end(fixture.document_(fixture.responsePage(fixture.paintNow)));
 });
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port;
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--no-proxy-server','--ignore-certificate-errors','--host-resolver-rules=MAP instacognito.com 127.0.0.1:'+port+', MAP forbidden.invalid 127.0.0.1:'+port+', MAP * ~NOTFOUND']});
 t.after(async()=>{await browser.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
 const config={runId:'offline-browser',handles:[{handle:'example',dateAfter:'2026-01-01'}],output:path.join(dir,'out'),resultFile:path.join(dir,'result.json'),requestLedger:path.join(dir,'ledger.json'),maxTimeMs:15000,maxFileBytes:1048576,maxBytes:2097152};
 const deps={chromium:{launch:async()=>browser},dnsLookup:publicDns,readinessWaitMs:3000};
 return {dir,server,port,browser,hits,config,deps,closedMedia:()=>closedMedia};
}
test('syncWindow downloads canonical bytes in the discovery browser session, exactly once per file',async t=>{
 const x=await setup(t);
 const nativeStatus=await new Promise((resolve,reject)=>{https.get({hostname:'127.0.0.1',port:x.port,path:'/media?id=native',rejectUnauthorized:false},r=>{r.resume();r.on('end',()=>resolve(r.statusCode));}).on('error',reject);});
 assert.equal(nativeStatus,403);x.hits.length=0;
 const result=await syncWindow(x.config,x.deps);
 assert.equal(result.status,'COMPLETE',JSON.stringify(result.error));assert.equal(result.totals.downloaded,2);
 assert.equal(x.hits.filter(h=>h.path==='/media').length,2);assert.ok(x.hits.filter(h=>h.path==='/media').every(h=>h.cookie.includes('fixture_session=ready')));
 const ledger=JSON.parse(await fs.readFile(x.config.requestLedger));assert.equal(ledger.by_phase.download,2);assert.equal(ledger.requests,x.hits.length);assert.equal(ledger.by_phase.discovery,x.hits.length-2);
 const paths=F.profilePaths(x.config.output,'example');
 for(const file of result.handles.example.files){const receipt=JSON.parse(await fs.readFile(path.join(paths.receiptDir,file.stableId+'.json')));assert.equal(await F.verifyReceipt(paths,receipt),true);assert.equal(receipt.sha256,crypto.createHash('sha256').update(media).digest('hex'));assert.deepEqual(await fs.readFile(path.join(paths.root,receipt.path)),media);}
 assert.equal((await fs.readdir(paths.mediaDir)).filter(n=>n.endsWith('.part')).length,0);
});
async function transport(t,options={}){
 const x=await setup(t,options),context=await x.browser.newContext(),page=await context.newPage();
 const budget=openBudget(x.config.requestLedger,'direct');t.after(()=>budget.close());
 await installGuards(page,budget,Date.now()+10000);await page.goto('https://instacognito.com/');
 const calls=[];const original=context.newCDPSession.bind(context);
 context.newCDPSession=async p=>{const cdp=await original(p),send=cdp.send.bind(cdp);cdp.send=async(method,args)=>{calls.push({method,args});return send(method,args);};return cdp;};
 const item=F.normalizeItems([{shortcode:'ONE',mediaType:'image',href:'https://instacognito.com/media?id=first'}],{category:'posts',mediaTypes:['image']}).items[0];
 const paths=F.profilePaths(x.config.output,'example');
 const download=(extra={})=>F.downloadOne(item,paths,{handle:'example',runId:'direct',fetchImpl:(u,i)=>browserMediaFetch(page,budget,u,i),dnsLookup:publicDns,remainingMs:3000,...extra});
 return {...x,context,page,budget,calls,item,paths,download};
}
test('cumulative byte limit cancels the remote reader and removes the partial file',async t=>{
 const x=await transport(t,{stall:true});
 await assert.rejects(x.download({maxBytes:1024}),{code:'TOO_LARGE'});
 assert.equal(x.calls.filter(c=>c.method==='Runtime.releaseObject').length,1,'remote media handle must be released before rejection');
 await new Promise(r=>setTimeout(r,30));assert.equal(x.closedMedia(),1,'source read must be cancelled');
 assert.deepEqual(await fs.readdir(x.paths.mediaDir),[]);assert.deepEqual(await fs.readdir(x.paths.receiptDir),[]);
});
test('stalled browser body times out with cleanup completed before rejection',async t=>{
 const x=await transport(t,{stall:true});
 const start=Date.now();await assert.rejects(x.download({remainingMs:900}),{code:'TIMEOUT'});
 assert.ok(Date.now()-start<2000);
 assert.equal(x.calls.filter(c=>c.method==='Runtime.releaseObject').length,1);
 assert.deepEqual(await fs.readdir(x.paths.mediaDir),[]);assert.deepEqual(await fs.readdir(x.paths.receiptDir),[]);
});

test('shared denial aborts an already stalled browser read immediately',async t=>{
 const x=await transport(t,{stall:true});
 const promise=x.download();const rejected=assert.rejects(promise,{code:'PROVIDER_DENIED'});
 while(x.calls.filter(c=>c.args?.functionDeclaration?.includes('this.reader.read')).length<2)await new Promise(r=>setTimeout(r,10));
 const start=Date.now();x.budget.deny('DENIED_AUTH',{status:403});await rejected;
 assert.ok(Date.now()-start<700,'a sticky stop must halt the source, not wait for file timeout');
 assert.equal(x.calls.filter(c=>c.method==='Runtime.releaseObject').length,1);
 assert.deepEqual(await fs.readdir(x.paths.mediaDir),[]);
});


test('bounded BYOB pulls have no prefetch and ignore page-world fetch spoofing',async t=>{
 const x=await transport(t);
 await x.page.evaluate(()=>{window.fetch=()=>{throw new Error('page-controlled fetch');};window.Response=function(){throw new Error('page-controlled Response');};});
 const response=await browserMediaFetch(x.page,x.budget,x.item.href),reader=response.body.getReader();
 const pulls=()=>x.calls.filter(c=>c.args?.functionDeclaration?.includes('this.reader.read'));
 assert.equal(pulls().length,0);await new Promise(r=>setTimeout(r,50));assert.equal(pulls().length,0);
 let bytes=0,chunks=0;const hash=crypto.createHash('sha256');
 for(;;){const r=await reader.read();if(r.done)break;assert.ok(r.value.length<=BRIDGE_BYTES);bytes+=r.value.length;chunks++;hash.update(r.value);const n=pulls().length;await new Promise(r=>setTimeout(r,3));assert.equal(pulls().length,n);}
 assert.ok(chunks>1);assert.equal(bytes,media.length);assert.equal(hash.digest('hex'),crypto.createHash('sha256').update(media).digest('hex'));
 assert.ok(pulls().every(c=>c.args.arguments[0].value===BRIDGE_BYTES));assert.equal(x.calls.filter(c=>c.method==='Runtime.releaseObject').length,1);
});
for(const [name,options,code] of [
 ['redirect',{redirect:true},'BROWSER_REDIRECT'],['401',{status:401},'PROVIDER_DENIED'],['403',{status:403},'PROVIDER_DENIED'],['429',{status:429},'PROVIDER_DENIED'],['HTML wall',{html:true},'PROVIDER_DENIED'],['oversize Content-Length',{declared:3000000},'TOO_LARGE'],['HTTP error',{status:500},'DISCOVERY_TRANSPORT'],
])test(name+' stops syncWindow at the first file without a receipt or redirect hop',async t=>{
 const x=await setup(t,options),result=await syncWindow(x.config,x.deps);
 assert.notEqual(result.status,'COMPLETE');assert.equal(result.error.code,code);assert.equal(result.totals.downloaded,0);
 assert.equal(x.hits.filter(h=>h.path==='/media').length,1);assert.equal(x.hits.filter(h=>h.path==='/target').length,0);
 const paths=F.profilePaths(x.config.output,'example');assert.deepEqual(await fs.readdir(paths.mediaDir).catch(()=>[]),[]);assert.deepEqual(await fs.readdir(paths.receiptDir).catch(()=>[]),[]);
 if(code==='PROVIDER_DENIED'){assert.ok(result.requests.denial);const n=x.hits.length;const retry=await syncWindow({...x.config,resultFile:path.join(x.dir,'retry.json')},x.deps);assert.equal(retry.error.code,'PROVIDER_DENIED');assert.equal(x.hits.length,n);assert.equal(retry.requests.session,result.requests.session);}
});
test('remaining total bytes preserve the first canonical receipt and reject the next file',async t=>{
 const x=await setup(t);x.config.maxBytes=media.length+1024;
 const result=await syncWindow(x.config,x.deps);assert.equal(result.error.code,'TOO_LARGE');assert.equal(result.totals.downloaded,1);
 const paths=F.profilePaths(x.config.output,'example');assert.equal((await fs.readdir(paths.receiptDir)).length,1);const files=await fs.readdir(paths.mediaDir);assert.equal(files.length,1);assert.ok(!files[0].endsWith('.part'));
});

test('caller abort cancels a stalled download and removes its partial file',async t=>{
 const x=await transport(t,{stall:true}),ac=new AbortController();
 const rejected=assert.rejects(x.download({signal:ac.signal}),{code:'CALLER_ABORT'});
 while(x.calls.filter(c=>c.args?.functionDeclaration?.includes('this.reader.read')).length<2)await new Promise(r=>setTimeout(r,10));
 const start=Date.now();ac.abort(new F.ArchiveError('CALLER_ABORT','synthetic caller abort'));await rejected;
 assert.ok(Date.now()-start<700);assert.equal(x.calls.filter(c=>c.method==='Runtime.releaseObject').length,1);assert.deepEqual(await fs.readdir(x.paths.mediaDir),[]);
});

test('abort waits for remote release and propagates cleanup failure',async t=>{
 const x=await transport(t,{stall:true}),original=x.context.newCDPSession.bind(x.context);let released=false;
 x.context.newCDPSession=async page=>{const cdp=await original(page),send=cdp.send.bind(cdp);cdp.send=async(method,args)=>{if(method==='Runtime.releaseObject'){await new Promise(r=>setTimeout(r,80));await send(method,args);released=true;throw new F.ArchiveError('CLEANUP_TEST','synthetic release failure');}return send(method,args);};return cdp;};
 await assert.rejects(x.download({remainingMs:900}),{code:'CLEANUP_TEST'});assert.equal(released,true);
 assert.deepEqual(await fs.readdir(x.paths.mediaDir),[]);assert.deepEqual(await fs.readdir(x.paths.receiptDir),[]);
});

test('page cleanup failure cannot publish a COMPLETE handle',async t=>{
 const x=await setup(t),newContext=x.browser.newContext.bind(x.browser);
 x.browser.newContext=async options=>{const context=await newContext(options),newPage=context.newPage.bind(context);context.newPage=async()=>{const page=await newPage(),close=page.close.bind(page);page.close=async()=>{await close();throw new F.ArchiveError('CLEANUP_TEST','synthetic page close failure');};return page;};return context;};
 const result=await syncWindow(x.config,x.deps);assert.equal(result.status,'PARTIAL');assert.equal(result.error.code,'CLEANUP_TEST');assert.notEqual(result.handles.example.status,'COMPLETE');
});

test('timeout at a held browser admission neither sends nor debits a late media request',async t=>{
 const x=await transport(t);await x.budget.admit('discovery');const n=x.budget.data.requests,hits=x.hits.length;
 let enter,release;const entered=new Promise(r=>{enter=r;}),gate=new Promise(r=>{release=r;}),admit=x.budget.admit;
 x.budget.admit=async(...args)=>{enter();await gate;return admit(...args);};
 const rejected=assert.rejects(x.download({remainingMs:80}));await entered;
 try{await rejected;}finally{release();}
 await new Promise(r=>setTimeout(r,30));
 assert.equal(x.hits.length,hits);assert.equal(x.budget.data.requests,n,'cancelled queued media must not be debited');
});

test('late automatic traffic cannot leave the still-open page after a shared stop',async t=>{
 const x=await transport(t);x.budget.deny('DENIED_AUTH',{status:403});const n=x.hits.length;
 await x.page.evaluate(async()=>{await Promise.all(['/api/late','https://forbidden.invalid/late'].map(u=>fetch(u).catch(()=>{})));});
 assert.equal(x.hits.length,n);
});

test('disk write failure cancels the browser reader without receipt or part',async t=>{
 const x=await transport(t,{stall:true}),open=fs.open;
 fs.open=async(...args)=>{const fh=await open(...args);if(String(args[0]).endsWith('.part'))fh.write=async()=>{throw Object.assign(new Error('synthetic disk failure'),{code:'ENOSPC'});};return fh;};
 try{await assert.rejects(x.download(),{code:'ENOSPC'});}finally{fs.open=open;}
 assert.equal(x.calls.filter(c=>c.method==='Runtime.releaseObject').length,1);assert.deepEqual(await fs.readdir(x.paths.mediaDir),[]);assert.deepEqual(await fs.readdir(x.paths.receiptDir),[]);
});
test('page loss during a stalled read fails closed without a receipt or part',async t=>{
 const x=await transport(t,{stall:true}),rejected=assert.rejects(x.download());
 while(x.calls.filter(c=>c.args?.functionDeclaration?.includes('this.reader.read')).length<2)await new Promise(r=>setTimeout(r,10));
 await x.page.close();await rejected;assert.deepEqual(await fs.readdir(x.paths.mediaDir),[]);assert.deepEqual(await fs.readdir(x.paths.receiptDir),[]);
});
test('absolute syncWindow deadline stops a stalled source and prevents the second file',async t=>{
 const x=await setup(t,{stall:true});x.config.maxTimeMs=2500;const start=Date.now();
 const result=await syncWindow(x.config,x.deps);assert.notEqual(result.status,'COMPLETE');assert.ok(['TIMEOUT','TIME_LIMIT'].includes(result.error.code),JSON.stringify(result.error));assert.ok(Date.now()-start<4000);assert.equal(x.hits.filter(h=>h.path==='/media').length,1);
 const paths=F.profilePaths(x.config.output,'example');assert.deepEqual(await fs.readdir(paths.mediaDir),[]);assert.deepEqual(await fs.readdir(paths.receiptDir),[]);
});
for(const status of [200,403])test('attached real CLI streams with status '+status+' and exits preserving the external default context',async t=>{
 const x=await setup(t,{status});await x.browser.close();
 const {spawn}=require('node:child_process'),exe=process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||chromium.executablePath();
 const child=spawn(exe,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--disable-background-networking','--disable-default-apps','--disable-sync','--no-proxy-server','--ignore-certificate-errors','--host-resolver-rules=MAP instacognito.com 127.0.0.1:'+x.port+', MAP * ~NOTFOUND','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+path.join(x.dir,'external-profile'),'about:blank'],{stdio:['ignore','ignore','pipe']});
 let controller;
 try{
  const port=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('CDP startup timeout')),5000);child.stderr.on('data',b=>{text+=b;const match=text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});child.once('error',reject);});
  const endpoint='http://127.0.0.1:'+port;controller=await chromium.connectOverCDP(endpoint);const sentinel=controller.contexts()[0].pages()[0];await sentinel.setContent('<title>external-sentinel</title>');
  const preload=path.join(x.dir,'offline-dns.cjs');await fs.writeFile(preload,"require('node:dns/promises').lookup=async(host)=>{if(host!=='instacognito.com')throw new Error('unexpected fixture DNS');return [{address:'93.184.216.34',family:4}];};");
  x.config.attachCdp=endpoint;const job=path.join(x.dir,'job.json');await fs.writeFile(job,JSON.stringify(x.config));
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const cli=spawn(process.execPath,['--require',preload,path.resolve(__dirname,'../bin/frameferry.js'),'sync-window','--config',job],{env,stdio:['ignore','pipe','pipe']});let output='',error='',timedOut=false;cli.stdout.on('data',b=>output+=b);cli.stderr.on('data',b=>error+=b);
  const timer=setTimeout(()=>{timedOut=true;cli.kill('SIGKILL');},12000);const exit=await new Promise((resolve,reject)=>{cli.once('error',reject);cli.once('exit',resolve);});clearTimeout(timer);
  assert.equal(timedOut,false,error);assert.equal(exit,status===200?0:1,error);const result=JSON.parse(await fs.readFile(x.config.resultFile));assert.equal(result.status,status===200?'COMPLETE':'BLOCKED');
  const cdp=await controller.newBrowserCDPSession();await cdp.send('Browser.getVersion');await cdp.detach();assert.equal(await sentinel.title(),'external-sentinel');assert.equal(controller.contexts().length,1,'owned context released');
  if(status===200){const paths=F.profilePaths(x.config.output,'example');for(const f of result.handles.example.files){const receipt=JSON.parse(await fs.readFile(path.join(paths.receiptDir,f.stableId+'.json')));assert.equal(await F.verifyReceipt(paths,receipt),true);assert.equal(receipt.sha256,crypto.createHash('sha256').update(media).digest('hex'));}}
  assert.equal(x.hits.filter(h=>h.path==='/media').length,status===200?2:1);console.log('BROWSER_CLI',JSON.stringify({exit,status:result.status,downloaded:result.totals.downloaded,externalSurvived:true}));
 }finally{await controller?.close();child.kill('SIGTERM');await new Promise(r=>{if(child.exitCode!==null||child.signalCode!==null)return r();child.once('exit',r);setTimeout(()=>{child.kill('SIGKILL');r();},2000).unref();});}
});

test('unresponsive remote cleanup closes the owned page and fails within a bound',async t=>{
 const x=await transport(t,{stall:true}),original=x.context.newCDPSession.bind(x.context);
 x.context.newCDPSession=async page=>{const cdp=await original(page),send=cdp.send.bind(cdp);cdp.send=(method,args)=>method==='Runtime.callFunctionOn'&&args.functionDeclaration.includes('this.reader.cancel')?new Promise(()=>{}):send(method,args);return cdp;};
 let timer;const outcome=await Promise.race([x.download({maxBytes:1024}).then(()=>({code:'UNEXPECTED_SUCCESS'}),e=>e),new Promise(r=>{timer=setTimeout(()=>r({code:'TEST_CLEANUP_STALLED'}),2500);})]);clearTimeout(timer);
 assert.equal(outcome.code,'BROWSER_CLEANUP');assert.equal(x.page.isClosed(),true);assert.deepEqual(await fs.readdir(x.paths.mediaDir),[]);
});

test('byte refusal latches the shared stop before later page traffic',async t=>{
 const x=await transport(t,{stall:true});await assert.rejects(x.download({maxBytes:1024}),{code:'TOO_LARGE'});
 const n=x.hits.length;await x.page.evaluate(()=>fetch('/api/late').catch(()=>{}));assert.equal(x.hits.length,n);assert.throws(()=>x.budget.assert(),{code:'TOO_LARGE'});
});

test('owned context cleanup failure is persisted as non-success after acquisition',async t=>{
 const x=await setup(t),newContext=x.browser.newContext.bind(x.browser);
 x.browser.newContext=async options=>{const c=await newContext(options),close=c.close.bind(c);c.close=async()=>{await close();throw new F.ArchiveError('CLEANUP_TEST','synthetic context cleanup failure');};return c;};
 const result=await syncWindow(x.config,x.deps);assert.equal(result.status,'PARTIAL');assert.equal(result.stoppedGlobally,true);assert.equal(result.error.code,'BROWSER_CLEANUP');assert.equal(JSON.parse(await fs.readFile(x.config.resultFile)).status,'PARTIAL');
});
