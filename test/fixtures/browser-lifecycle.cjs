'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const F=require('../../src/index.js'),{syncWindow}=require('../../src/sync-window.js');
const fixture=require('./listing-page.js');
const {browserMediaFetch,BRIDGE_BYTES}=require('../../src/browser-media-transport.js');
const {openBudget}=require('../../src/request-budget.js');
const {installGuards}=require('../../src/sync-window.js');
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

module.exports={setup,transport,media,F,browserMediaFetch};
