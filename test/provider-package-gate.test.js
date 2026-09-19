'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {execFileSync}=require('node:child_process');
test('real package allowlist gate runs offline with lifecycle scripts disabled',()=>{
 const env={...process.env,npm_config_offline:'true',npm_config_ignore_scripts:'true',npm_config_cache:'/tmp/frameferry-package-cache'};
 delete env.NODE_TEST_CONTEXT;delete env.NODE_TEST_WORKER_ID;
 const output=execFileSync(process.execPath,['scripts/package-guard.js'],{cwd:path.resolve(__dirname,'..'),env,encoding:'utf8',timeout:65000});
 assert.match(output,/package-guard: [1-9][0-9]* files in pack output/);
 assert.match(output,/package-guard: all files pass allowlist and blocklist checks/);
 console.log(output.trim());
});
