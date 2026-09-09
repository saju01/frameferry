'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const lib=require('../src/index.js');
const {chromium}=require('playwright');
test('capture reset works after reloading the same Page document',async t=>{
 const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});t.after(()=>browser.close());
 const page=await browser.newPage();
 await page.goto('data:text/html,<html><body><div id="post-container"></div></body></html>');
 await lib.discovery.installCapture(page);await lib.discovery.resetCapture(page,'posts');
 assert.equal(await page.evaluate(()=>typeof window.__ffCapture.reset),'function');
 await page.reload({waitUntil:'domcontentloaded'});
 assert.equal(await page.evaluate(()=>typeof window.__ffCapture),'undefined');
 await lib.discovery.installCapture(page);await lib.discovery.resetCapture(page,'posts');
 assert.equal(await page.evaluate(()=>typeof window.__ffCapture.reset),'function');
});
