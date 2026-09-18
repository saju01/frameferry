'use strict';
// Focused repair proof for the three findings of .review-evidence/PASSIVE-INDEPENDENT-REVIEW.json
// against the passive observer described in .review-evidence/passive-design.md:
//
//   PASSIVE-S1  a wide parsed object made the observer allocate a COMPLETE key list before any
//               admission decision, so observer-owned enumeration storage scaled with the
//               application's arbitrary object width rather than with maxBytes.
//   PASSIVE-L1  a string value or key was escaped - materialised - before its escaped size was
//               admitted, so 200 NUL characters produced a 1202-character escaped copy under a
//               256-byte ceiling.
//   PASSIVE-L2  the observer's side rejection handlers marked dropped native json()/text() and
//               fetch promises handled, so a page relying on the global `unhandledrejection`
//               event for recovery stopped receiving it.
//
// Every test here is a counterexample first: each one was executed RED against the reviewed head
// d9341b7 before the repair, and must never be relaxed into a success. The passive design itself
// is NOT re-litigated here - no observer read, clone, tee, queue or Response replacement is
// introduced, and the mechanism gates in test/passive-mechanism.test.js remain authoritative for
// that contract.
//
// Real Chromium, real DOM, fulfilled in-process inside the no-network sandbox: no provider
// traffic, no signed locators, no private strings, no skips.
const test = require('node:test'), { after } = require('node:test'), assert = require('node:assert/strict');
const fsSync = require('node:fs');
const F = require('../src/index.js');
const { rec, posts } = require('./fixtures/listing-page.js');
const KEY = '__ffWindowObservation';
const LIMITS = { maxBytes: 256, maxRetainedBytes: 256, maxActiveReads: 2, maxBodies: 8, timeoutMs: 4000 };

let shared = null;
async function launch() {
 if (shared) return shared;
 const { chromium } = require('playwright');
 const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
 assert.ok(fsSync.existsSync(executablePath), 'required real DOM browser must exist; no skips');
 shared = await chromium.launch({ headless: true, executablePath }); return shared;
}
after(async () => { if (shared) await shared.close(); shared = null; });
// One browser, a FRESH isolated context per case. The document carries the recovery target the
// global-rejection cases assert on, and /api/posts is fulfilled in-process.
async function fixture(t, body) {
 const browser = await launch(), context = await browser.newContext({ serviceWorkers: 'block' });
 t.after(() => context.close());
 await context.route('**/*', route => new URL(route.request().url()).pathname === '/api/posts'
  ? route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body })
  : route.fulfill({ status: 200, contentType: 'text/html', body: '<div id="fallback">not-recovered</div>' }));
 const page = await context.newPage(); await page.goto(F.PROVIDER_PHOTO_URL);
 return { page, context };
}
// Counts the OBSERVER's whole-key-list enumeration of a marked object, the escaped copies it
// materialises, and every second body consumer it could introduce. Installed BEFORE the probe,
// so everything it records afterwards is the observer's own additional work.
const METER = `(()=>{const M=window.ffMeter={listCalls:0,maxList:0,apis:[],graphStringify:0,
  maxEscapedInput:0,maxEscapedOutput:0,clones:0,tees:0,getReaders:0,reads:0,cancels:0};
 const marked=v=>{try{return v!==null&&typeof v==='object'&&Object.prototype.hasOwnProperty.call(v,'ffMark');}catch(e){return false;}};
 const wrapList=(owner,name)=>{const native=owner[name];if(typeof native!=='function')return;
  owner[name]=function(v){const out=native.apply(this,arguments);
   if(marked(v)){M.listCalls++;M.apis.push(name);if(out&&typeof out.length==='number')M.maxList=Math.max(M.maxList,out.length);}
   return out;};};
 for(const n of ['keys','values','entries','getOwnPropertyNames','getOwnPropertySymbols'])wrapList(Object,n);
 wrapList(Reflect,'ownKeys');
 const js=JSON.stringify;JSON.stringify=function(v){const out=js.apply(this,arguments);
  // Only ADVERSARIAL strings are recorded, so an unrelated small serialisation elsewhere in the
  // page can never be mistaken for the observer's escaped copy.
  if(typeof v==='string'&&v.length>=100){M.maxEscapedInput=Math.max(M.maxEscapedInput,v.length);
   M.maxEscapedOutput=Math.max(M.maxEscapedOutput,out.length);}
  else if(marked(v))M.graphStringify++;
  return out;};
 const cl=Response.prototype.clone;Response.prototype.clone=function(){M.clones++;return cl.apply(this,arguments);};
 const te=ReadableStream.prototype.tee;ReadableStream.prototype.tee=function(){M.tees++;return te.apply(this,arguments);};
 const gr=ReadableStream.prototype.getReader;ReadableStream.prototype.getReader=function(){M.getReaders++;return gr.apply(this,arguments);};
 const rd=ReadableStreamDefaultReader.prototype.read;ReadableStreamDefaultReader.prototype.read=function(){M.reads++;return rd.apply(this,arguments);};
 const cn=ReadableStreamDefaultReader.prototype.cancel;ReadableStreamDefaultReader.prototype.cancel=function(){M.cancels++;return cn.apply(this,arguments);};
})()`;
const meter = page => page.evaluate(() => ({ ...window.ffMeter }));
const report = page => F.readListingBodyObservation(page);
const settled = page => page.waitForFunction(k => { const s = window[k].bodyReport(false).bodies[0]; return s && s.state !== 'reading'; }, KEY);
const noExtraConsumer = m => {
 assert.equal(m.clones, 0, 'the observer must clone nothing'); assert.equal(m.tees, 0);
 assert.equal(m.getReaders, 0, 'the observer must acquire no reader'); assert.equal(m.reads, 0); assert.equal(m.cancels, 0);
};

// === PASSIVE-S1: observer-owned enumeration is bounded BEFORE admission =====================
const wide = n => { const o = { ffMark: 1 }; for (let i = 0; i < n; i++) o['k' + i] = 0; return o; };
const SHAPES = [
 { name: 'root', body: () => JSON.stringify({ ...wide(50000), p: [], pc: 'x' }),
   read: async () => (await (await fetch('/api/posts')).json()).k49999 },
 // Deliberately NOT the reviewer's `wide` field name, and two levels down: the bound must be a
 // property of the walk itself, never of a recognised key.
 { name: 'nested', body: () => JSON.stringify({ p: [], pc: 'x', details: { summary: 's', payload: wide(50000) } }),
   read: async () => (await (await fetch('/api/posts')).json()).details.payload.k49999 }
];
for (const shape of SHAPES) test('passive repair (PASSIVE-S1): a WIDE ' + shape.name + ' object is refused without a complete observer key list', async t => {
 const { page } = await fixture(t, shape.body());
 await page.evaluate(METER);
 await F.installRenderObservationProbe(page, LIMITS);
 const appValue = await page.evaluate(shape.read);
 await settled(page);
 const observed = await report(page), m = await meter(page);
 console.log('REPAIR_WIDE_' + shape.name.toUpperCase() + ' ' + JSON.stringify({ appValue, meter: m,
  body: observed.bodies[0], retainedBytes: observed.retainedBytes }));
 assert.equal(appValue, 0, 'the application own parsed value is untouched');
 assert.equal(observed.bodies[0].state, 'oversized', 'a too-wide value is refused honestly, never summarised');
 assert.equal(observed.bodies[0].text, null, 'and nothing of it is retained');
 assert.equal(observed.retainedBytes, 0);
 assert.equal(observed.retainedBackingBytes, 0);
 assert.ok(observed.refusedObservations >= 1);
 assert.equal(m.graphStringify, 0, 'the observer must never serialise an arbitrary parsed object graph');
 assert.equal(m.listCalls, 0,
  'the observer obtained a whole-key-list of the wide object through ' + JSON.stringify(m.apis)
  + '; largest list ' + m.maxList + ' entries under maxBytes=' + LIMITS.maxBytes);
 assert.equal(m.maxList, 0);
 noExtraConsumer(m);
});
// The bound the repair actually claims, measured: how many of an object's own properties the
// observer READS at all. Enumerable accessors count each read exactly once, so this is a
// statement about the observer's own visits - NOT a heap-wide guarantee, and NOT a claim about
// the engine-internal enumeration the platform performs for a for-in walk.
test('passive repair (PASSIVE-S1): the observer visits at most a byte-budget worth of properties', async t => {
 const { page } = await fixture(t, JSON.stringify({ p: [], pc: 'x' }));
 await page.evaluate(METER);
 await page.evaluate(count => {
  window.visits = 0; const target = {};
  Object.defineProperty(target, 'ffMark', { enumerable: true, configurable: true, get() { window.visits++; return 1; } });
  for (let i = 0; i < count; i++) Object.defineProperty(target, 'k' + i, { enumerable: true, configurable: true, get() { window.visits++; return 0; } });
  // The page's OWN json(), installed before the probe patches over it, so the value the
  // application receives - and the value the observer sees - is this instrumented wide object.
  const inner = Response.prototype.json;
  Object.defineProperty(Response.prototype, 'json', { configurable: true, writable: true,
   value: function () { return inner.apply(this, arguments).then(() => target); } });
 }, 50000);
 await F.installRenderObservationProbe(page, LIMITS);
 const appMark = await page.evaluate(async () => (await (await fetch('/api/posts')).json()).ffMark);
 await settled(page);
 const observed = await report(page), m = await meter(page), visits = await page.evaluate(() => window.visits);
 console.log('REPAIR_WIDE_VISITS ' + JSON.stringify({ appMark, visits, meter: m, body: observed.bodies[0] }));
 assert.equal(appMark, 1, 'the application own read still works');
 assert.equal(observed.bodies[0].state, 'oversized');
 assert.equal(observed.retainedBytes, 0);
 assert.equal(m.listCalls, 0, 'no whole-key-list of the wide object may be obtained');
 assert.ok(visits <= LIMITS.maxBytes + 1,
  'the observer read ' + visits + ' properties of a 50001-property object under maxBytes=' + LIMITS.maxBytes);
 noExtraConsumer(m);
});

// === PASSIVE-L1: escaped UTF-8 size is admitted BEFORE the escaped copy exists ==============
const ESCAPERS = [
 { name: 'string value', expect: 200, body: () => JSON.stringify({ p: [], pc: ' '.repeat(200) }),
   read: async () => (await (await fetch('/api/posts')).json()).pc.length },
 { name: 'object key', expect: 2, body: () => JSON.stringify({ p: [], [' '.repeat(200)]: 1 }),
   read: async () => Object.keys(await (await fetch('/api/posts')).json()).length }
];
for (const c of ESCAPERS) test('passive repair (PASSIVE-L1): an over-budget escaped ' + c.name + ' is refused before it is materialised', async t => {
 const { page } = await fixture(t, c.body());
 await page.evaluate(METER);
 await F.installRenderObservationProbe(page, LIMITS);
 const appValue = await page.evaluate(c.read);
 await settled(page);
 const observed = await report(page), m = await meter(page);
 console.log('REPAIR_ESCAPE ' + JSON.stringify({ name: c.name, appValue, meter: m, body: observed.bodies[0] }));
 assert.equal(appValue, c.expect, 'the application own parsed value is untouched');
 assert.equal(observed.bodies[0].state, 'oversized');
 assert.equal(observed.retainedBytes, 0);
 assert.equal(observed.bodies[0].text, null);
 assert.equal(m.maxEscapedOutput, 0,
  'the observer escaped a ' + m.maxEscapedInput + '-character ' + c.name + ' into ' + m.maxEscapedOutput
  + ' characters under maxBytes=' + LIMITS.maxBytes + ' before refusing it');
 noExtraConsumer(m);
});
// Exact-boundary admission AND byte-for-byte equality with the platform's own JSON. The
// comparison is made INSIDE the page against the application's own parsed value, so no lone
// surrogate can be mangled by crossing the protocol.
const BOUNDARY = { p: [], pc: 'q"\\ \b\t\n\f\r é 漢 \u{1F600} \uD800 end' };
const BOUNDARY_JSON = JSON.stringify(BOUNDARY), BOUNDARY_BYTES = Buffer.byteLength(BOUNDARY_JSON, 'utf8');
for (const over of [false, true]) test('passive repair (PASSIVE-L1): an escaped value of exactly ' + BOUNDARY_BYTES
 + ' bytes is ' + (over ? 'refused one byte under the ceiling' : 'admitted at the ceiling, byte for byte'), async t => {
 const { page } = await fixture(t, BOUNDARY_JSON);
 const maxBytes = over ? BOUNDARY_BYTES - 1 : BOUNDARY_BYTES;
 await page.evaluate(METER);
 await F.installRenderObservationProbe(page, { ...LIMITS, maxBytes, maxRetainedBytes: maxBytes });
 await page.evaluate(() => { window.__probeValue = null;
  fetch('/api/posts').then(r => r.json()).then(v => { window.__probeValue = v; }); });
 await page.waitForFunction(() => window.__probeValue !== null);
 await settled(page);
 const observed = await report(page), m = await meter(page);
 const compared = await page.evaluate(k => { const body = window[k].bodyReport(true).bodies[0];
  if (typeof body.text !== 'string') return { text: false };
  return { text: true, equalsNativeJson: body.text === JSON.stringify(window.__probeValue),
   utf8Bytes: new TextEncoder().encode(body.text).length }; }, KEY);
 console.log('REPAIR_BOUNDARY ' + JSON.stringify({ maxBytes, expectedBytes: BOUNDARY_BYTES, compared,
  body: { state: observed.bodies[0].state, retainedBytes: observed.bodies[0].retainedBytes }, meter: m }));
 if (over) {
  assert.equal(observed.bodies[0].state, 'oversized', 'one byte over the ceiling must be refused');
  assert.equal(observed.retainedBytes, 0);
  assert.equal(compared.text, false, 'nothing may be retained from a refused value');
 } else {
  assert.equal(observed.bodies[0].state, 'read', 'a value of exactly maxBytes must still be admitted');
  assert.equal(compared.equalsNativeJson, true, 'the admitted text must equal the platform own JSON exactly');
  assert.equal(compared.utf8Bytes, BOUNDARY_BYTES, 'and measure exactly the bytes the ceiling admitted');
  assert.equal(observed.retainedBytes, BOUNDARY_BYTES);
 }
 noExtraConsumer(m);
});
test('passive repair: a healthy listing is still observed, faithful and decodable', async t => {
 const payload = posts(rec({ code: 'A', media: 'M' }));
 const { page } = await fixture(t, JSON.stringify(payload));
 await page.evaluate(METER);
 await F.installRenderObservationProbe(page, { ...LIMITS, maxBytes: 65536, maxRetainedBytes: 65536 });
 await page.evaluate(() => { window.__probeValue = null;
  fetch('/api/posts').then(r => r.json()).then(v => { window.__probeValue = v; }); });
 await page.waitForFunction(() => window.__probeValue !== null);
 await settled(page);
 const observed = await report(page), m = await meter(page);
 const compared = await page.evaluate(k => { const body = window[k].bodyReport(true).bodies[0];
  return { equalsNativeJson: body.text === JSON.stringify(window.__probeValue), text: body.text }; }, KEY);
 const decoded = F.decodeListingResponse(compared.text);
 console.log('REPAIR_HEALTHY ' + JSON.stringify({ state: observed.bodies[0].state,
  supported: decoded.supported, tuples: decoded.tuples && decoded.tuples.length, meter: m }));
 assert.equal(observed.bodies[0].state, 'read', 'healthy json() observation must remain useful');
 assert.equal(observed.bodies[0].via, 'json');
 assert.equal(compared.equalsNativeJson, true);
 assert.deepEqual(JSON.parse(compared.text), payload);
 assert.equal(decoded.supported, true, 'and must still decode through the unchanged strict decoder');
 assert.equal(decoded.tuples.length, 1);
 noExtraConsumer(m);
});

// === PASSIVE-L2: real global rejection recovery =============================================
// The dropped promise is created in a PAGE TIMER, outside the active evaluation, exactly as the
// independent reviewer's valid control did: a promise created inside an evaluation that is still
// running is not an honest unhandled-rejection control.
const RECOVERY = `(()=>{window.errors=[];window.dropped=null;window.caught=null;
 addEventListener('unhandledrejection',event=>{event.preventDefault();
  window.errors.push({name:event.reason&&event.reason.constructor?event.reason.constructor.name:String(event.reason),
   samePromise:event.promise===window.dropped});
  const el=document.getElementById('fallback');if(el)el.textContent='recovered';});})()`;
async function rejectionCase(t, { kind, probed, handled }) {
 const { page, context } = await fixture(t, '{malformed');
 if (kind === 'fetch') await context.route('**/api/posts', route => route.abort('failed'));
 await page.evaluate(METER);
 await page.evaluate(RECOVERY);
 if (probed) await F.installRenderObservationProbe(page, LIMITS);
 await page.evaluate(async ([kind, handled]) => {
  const start = promise => { window.dropped = promise;
   if (handled) promise.then(() => {}, e => { window.caught = e && e.constructor ? e.constructor.name : String(e); }); };
  if (kind === 'json') { const response = await fetch('/api/posts'); setTimeout(() => start(response.json()), 50); }
  else setTimeout(() => start(fetch('/api/posts')), 50);
 }, [kind, handled]);
 await page.waitForTimeout(700);
 const outcome = await page.evaluate(() => ({ errors: window.errors, caught: window.caught,
  fallback: document.getElementById('fallback').textContent }));
 const m = await meter(page);
 await context.close();
 return { ...outcome, meter: m };
}
for (const kind of ['json', 'fetch']) test('passive repair (PASSIVE-L2): a dropped ' + kind
 + ' rejection still reaches the page own global recovery handler', async t => {
 const native = await rejectionCase(t, { kind, probed: false, handled: false });
 const probed = await rejectionCase(t, { kind, probed: true, handled: false });
 console.log('REPAIR_RECOVERY ' + JSON.stringify({ kind, native, probed }));
 assert.equal(native.errors.length, 1, 'the uninstrumented control must actually fire the global handler');
 assert.equal(native.errors[0].samePromise, true,
  'and the event must carry the promise the application itself received');
 assert.equal(native.fallback, 'recovered', 'and the page recovery DOM must run');
 assert.deepEqual(probed.errors, native.errors,
  'the observer must not suppress - or duplicate - the native global ' + kind + ' rejection event');
 assert.equal(probed.fallback, native.fallback, 'and the page recovery DOM must still run');
 noExtraConsumer(probed.meter);
});
for (const kind of ['json', 'fetch']) test('passive repair (PASSIVE-L2): a caught ' + kind
 + ' rejection produces no global event and no orphan rejection', async t => {
 const native = await rejectionCase(t, { kind, probed: false, handled: true });
 const probed = await rejectionCase(t, { kind, probed: true, handled: true });
 console.log('REPAIR_CAUGHT ' + JSON.stringify({ kind, native, probed }));
 assert.deepEqual(native.errors, [], 'a handled rejection fires no global event natively');
 assert.deepEqual(probed.errors, [],
  'the observer must create no extra orphan rejected promise for a handled ' + kind + ' rejection');
 assert.equal(probed.caught, native.caught, 'the application must catch the very same rejection reason');
 assert.equal(probed.fallback, 'not-recovered');
 noExtraConsumer(probed.meter);
});
// The corrected identity contract: the application receives a NATIVE promise carrying the SAME
// native Response and the SAME parsed value - not necessarily the same promise OBJECT.
test('passive repair (PASSIVE-L2): the returned promise is native and carries the same Response and value', async t => {
 const payload = posts(rec({ code: 'A', media: 'M' }));
 const { page } = await fixture(t, JSON.stringify(payload));
 await page.evaluate(METER);
 await page.evaluate(() => {
  const innerFetch = window.fetch; window.madeResponse = null;
  window.fetch = function () { const p = innerFetch.apply(this, arguments); p.then(r => { window.madeResponse = r; }, () => {}); return p; };
  const innerJson = Response.prototype.json; window.madeValue = null;
  Object.defineProperty(Response.prototype, 'json', { configurable: true, writable: true,
   value: function () { const p = innerJson.apply(this, arguments); p.then(v => { window.madeValue = v; }, () => {}); return p; } });
 });
 await F.installRenderObservationProbe(page, { ...LIMITS, maxBytes: 65536, maxRetainedBytes: 65536 });
 const identity = await page.evaluate(async () => {
  const returned = fetch('/api/posts');
  const nativeFetchPromise = returned instanceof Promise && Object.getPrototypeOf(returned) === Promise.prototype
   && returned.constructor === Promise;
  const response = await returned;
  const jsonPromise = response.json();
  const nativeJsonPromise = jsonPromise instanceof Promise && Object.getPrototypeOf(jsonPromise) === Promise.prototype
   && jsonPromise.constructor === Promise;
  const value = await jsonPromise;
  let headersMutable = true; try { response.headers.set('x-probe', '1'); } catch (e) { headersMutable = false; }
  return { nativeFetchPromise, nativeJsonPromise,
   sameResponse: response === window.madeResponse, sameBody: response.body === window.madeResponse.body,
   sameValue: value === window.madeValue, own: Object.getOwnPropertyNames(response), headersMutable,
   url: response.url, type: response.type, redirected: response.redirected, bodyUsed: response.bodyUsed };
 });
 const observed = await report(page), m = await meter(page);
 console.log('REPAIR_RETURNED_PROMISE ' + JSON.stringify({ identity, body: observed.bodies[0], meter: m }));
 assert.equal(identity.nativeFetchPromise, true, 'fetch must return a native Promise');
 assert.equal(identity.nativeJsonPromise, true, 'json() must return a native Promise');
 assert.equal(identity.sameResponse, true, 'carrying the very same native Response object');
 assert.equal(identity.sameBody, true, 'with the very same native body stream');
 assert.equal(identity.sameValue, true, 'and the very same parsed value the platform produced');
 assert.deepEqual(identity.own, [], 'the observer must define no own property on the Response');
 assert.equal(identity.headersMutable, false, 'network headers must stay immutable');
 assert.equal(identity.url, F.PROVIDER_ORIGIN + '/api/posts');
 assert.equal(identity.type, 'basic');
 assert.equal(identity.redirected, false);
 assert.equal(identity.bodyUsed, true, 'bodyUsed must follow the application own consumption');
 assert.equal(observed.bodies[0].state, 'read');
 noExtraConsumer(m);
});
