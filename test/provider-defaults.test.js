'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const D=require('../src/discovery.js');
test('standalone runtime receipt reports zero default delay and preserves explicit caller delay',()=>{
 for(const delayMs of [undefined,0,17,500]){
  const effective=D.validateOptions(delayMs===undefined?{}:{delayMs});
  assert.equal(D.runtimeReceipt(effective).effectiveOptions.delayMs,delayMs??0);
 }
});
test('real CLI option flow uses zero default post-download delay and preserves explicit delay',()=>{
 const root=path.resolve(__dirname,'..'),env={...process.env};delete env.NODE_TEST_CONTEXT;delete env.NODE_TEST_WORKER_ID;
 for(const value of [undefined,'0','17','500']){
  // Replace only the acquisition seam; run the real CLI argument parser and option forwarding.
  const script='const F=require("./src/index.js");F.archiveProfile=async opts=>({status:"COMPLETE",delayMs:opts.delayMs});'
   +'process.argv=[process.execPath,"bin/frameferry.js","archive","example","--output","/tmp/unused-default-fixture","--json",...'+JSON.stringify(value===undefined?[]:['--delay-ms',value])+'];require("./bin/frameferry.js");';
  const result=JSON.parse(execFileSync(process.execPath,['-e',script],{cwd:root,env,encoding:'utf8',timeout:10000}));
  assert.equal(result.delayMs,value===undefined?0:Number(value));
 }
});
