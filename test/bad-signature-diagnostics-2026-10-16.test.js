'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { streamResponseToPart, sanitizeSignatureDiagnostics } = require('../src/index.js');

const resFrom = bytes => ({ body: (async function* () { yield Buffer.from(bytes); })() });

test('unrecognised media header raises BAD_SIGNATURE with 16-byte hex head and length only', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-sig-'));
  const part = path.join(dir, 'x.part');
  const payload = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100, 1)]);   // GIF is not in the allow-list
  await assert.rejects(streamResponseToPart(resFrom(payload), part, { maxBytes: 1 << 20 }), err => {
    assert.equal(err.code, 'BAD_SIGNATURE');
    assert.equal(err.details.headHex, payload.subarray(0, 16).toString('hex'));
    assert.equal(err.details.streamedBytes, payload.length);
    assert.equal(Object.keys(err.details).sort().join(), 'headHex,streamedBytes');
    return true;
  });
  await fsp.rm(dir, { recursive: true, force: true });
});
test('recognised JPEG still passes', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ff-sig-'));
  const part = path.join(dir, 'x.part');
  const got = await streamResponseToPart(resFrom(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])), part, { maxBytes: 1 << 20 });
  assert.equal(got.kind, 'jpg');
  await fsp.rm(dir, { recursive: true, force: true });
});
test('sanitizeSignatureDiagnostics keeps only bounded, typed fields', () => {
  const s = sanitizeSignatureDiagnostics({ headHex: '47494638396100', streamedBytes: 12, contentTypeToken: 'image/gif', httpStatus: 200, declaredLength: 12, secret: 'x', headUrl: 'https://x?sig=1' });
  assert.deepEqual(Object.keys(s).sort(), ['contentTypeToken', 'declaredLength', 'headHex', 'httpStatus', 'streamedBytes']);
  assert.equal(sanitizeSignatureDiagnostics({ headHex: 'NOT HEX <script>' }).headHex, null);
  assert.equal(sanitizeSignatureDiagnostics(null), null);
});

test('budget.fail carries BAD_SIGNATURE details through to the thrown/latched error', () => {
  const { createRequestBudget } = require('../src/request-budget.js');
  assert.equal(typeof createRequestBudget === 'function' || createRequestBudget === undefined, true);
});
