'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeListingResponse } = require('../src/index.js');

// Live /api/posts shape observed 2026-10-16 (shape only): roots carry iu,hu,lc,cc,pd,c,id,co and optional
// vu,vhu,om; carousel children carry the same WITHOUT `id`.
const base = { iu: 'a', hu: 'b', lc: '1', cc: '2', pd: '2 hours ago', c: '', co: 'SHORT' };
const body = o => JSON.stringify(o);

test('carousel children without `id` are supported (live shape)', () => {
  const r = decodeListingResponse(body({ p: [{ ...base, id: '1', om: [{ ...base, hu: 'c' }, { ...base, hu: 'd' }] }], pc: 'cur' }));
  assert.equal(r.supported, true);
  assert.equal(r.records, 1);
  assert.equal(r.children, 2);
  assert.equal(r.tuples.length, 3);
});
test('carousel children WITH `id` still supported (old shape)', () => {
  assert.equal(decodeListingResponse(body({ p: [{ ...base, id: '1', om: [{ ...base, id: '2' }] }] })).supported, true);
});
test('root items still REQUIRE `id`', () => {
  const r = decodeListingResponse(body({ p: [{ ...base }] }));
  assert.equal(r.supported, false);
  assert.equal(r.reason, 'unknown-listing-field');
});
test('a PRESENT child `id` must still be a string', () => {
  const r = decodeListingResponse(body({ p: [{ ...base, id: '1', om: [{ ...base, id: 5 }] }] }));
  assert.equal(r.supported, false);
});
test('unknown child key is refused and reported by NAME and TYPE only, never value', () => {
  const r = decodeListingResponse(body({ p: [{ ...base, id: '1', om: [{ ...base, zz: 'SECRET-VALUE' }] }] }));
  assert.equal(r.supported, false);
  assert.equal(r.reason, 'unknown-listing-field');
  assert.equal(r.fields.where, 'child');
  assert.ok(r.fields.keys.includes('zz:string'));
  assert.ok(!JSON.stringify(r).includes('SECRET-VALUE'));
});
test('unknown root key reported by name/type', () => {
  const r = decodeListingResponse(body({ p: [], pc: 'x', meta: { a: 1 } }));
  assert.equal(r.supported, false);
  assert.equal(r.fields.where, 'root');
  assert.ok(r.fields.keys.includes('meta:object'));
});
test('wrong-typed required field names the offending key', () => {
  const r = decodeListingResponse(body({ p: [{ ...base, id: '1', lc: 5 }] }));
  assert.equal(r.supported, false);
  assert.equal(r.fields.bad, 'lc');
});
test('video items carrying optional `vc` view-count string, items omitting `lc`/`cc`, and carousel children omitting `co` (inheriting parent `co`) are supported (2026-10-19 live shape)', () => {
  const { lc, ...noLc } = base;
  const { co, ...childNoCo } = noLc;
  const r = decodeListingResponse(body({
    p: [
      { ...base, id: '1', co: 'PARENT_SC', vu: 'v', vhu: 'v', vc: '12.4k', om: [{ ...childNoCo, id: '2', hu: 'c', vu: 'v2', vhu: 'v2', vc: '900' }] },
      { ...noLc, id: '2', hu: 'd' }
    ],
    pc: 'cur'
  }));
  assert.equal(r.supported, true);
  assert.equal(r.records, 2);
  assert.equal(r.children, 1);
  assert.equal(r.tuples.length, 3);
  assert.equal(r.tuples[0].shortcode, 'PARENT_SC');
  assert.equal(r.tuples[1].shortcode, 'PARENT_SC');
  const rootNoCo = decodeListingResponse(body({ p: [{ ...childNoCo, id: '1' }] }));
  assert.equal(rootNoCo.supported, false);
  assert.equal(rootNoCo.fields.bad, 'co');
  const badVc = decodeListingResponse(body({ p: [{ ...base, id: '1', vc: 123 }] }));
  assert.equal(badVc.supported, false);
  assert.equal(badVc.fields.bad, 'vc');
});
test('field diagnostics are bounded (<= 8 keys, short safe names only)', () => {
  const many = {}; for (let i = 0; i < 20; i++) many['k' + i] = 'v';
  const r = decodeListingResponse(body({ p: [{ ...base, id: '1', ...many }] }));
  assert.ok(r.fields.keys.length <= 8);
  const weird = decodeListingResponse(body({ p: [{ ...base, id: '1', ['x'.repeat(40)]: 'v', 'a b': 'v' }] }));
  assert.ok(weird.fields.keys.every(k => /^[A-Za-z0-9_]{1,16}:/.test(k)));
});
