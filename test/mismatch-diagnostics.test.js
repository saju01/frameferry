'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../src/index.js');

const jpg = Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4,0xff,0xd9]);
const mp4 = Buffer.from([0,0,0,20,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,0,0,0,0,0]);
const dnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function fetchReturning(body, mime, { status = 200, url = 'https://instacognito.com/media?id=one' } = {}) {
  return async () => ({
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: { get: k => k === 'content-type' ? mime : k === 'content-length' ? String(body.length) : null },
    body: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } })
  });
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-mismatch-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = lib.profilePaths(root, 'example');
  return paths;
}

test('MEDIA_TYPE_MISMATCH carries structured details', async (t) => {
  const paths = await setup(t);
  const item = lib.normalizeItems([{ shortcode: 'A', mediaType: 'video', href: 'https://instacognito.com/media?id=one' }]).items[0];
  await assert.rejects(
    lib.downloadOne(item, paths, { handle: 'example', runId: 'test', fetchImpl: fetchReturning(jpg, 'image/jpeg'), dnsLookup }),
    err => {
      assert.equal(err.code, 'MEDIA_TYPE_MISMATCH');
      assert.equal(typeof err.details, 'object');
      assert.equal(err.details.expectedMediaType, 'video');
      assert.equal(err.details.actualMediaType, 'image');
      assert.equal(err.details.magicContainer, 'jpg');
      assert.equal(err.details.mimeClass, 'image');
      assert.equal(err.details.contentTypeToken, 'image/jpeg');
      assert.equal(err.details.httpStatus, 200);
      assert.equal(typeof err.details.declaredLength, 'number');
      assert.ok(err.details.declaredLength >= 0);
      assert.equal(typeof err.details.streamedBytes, 'number');
      assert.ok(err.details.streamedBytes >= 0);
      return true;
    }
  );
});

test('sanitizeFailedItem propagates mismatchDiagnostics when gated by errorCode', () => {
  const item = {
    stableId: 'test-id', shortcode: 'A', category: 'posts', mediaType: 'video',
    _mismatchDiagnostics: { expectedMediaType: 'video', actualMediaType: 'image', magicContainer: 'jpg', mimeClass: 'image', contentTypeToken: 'image/jpeg', httpStatus: 200, declaredLength: 10, streamedBytes: 10 }
  };
  const result = lib.sanitizeFailedItem(item, 'some error', 0, 1, 'MEDIA_TYPE_MISMATCH');
  assert.ok(result.mismatchDiagnostics);
  assert.equal(result.mismatchDiagnostics.expectedMediaType, 'video');
  assert.equal(result.mismatchDiagnostics.actualMediaType, 'image');
  assert.equal(result.mismatchDiagnostics.magicContainer, 'jpg');
  assert.equal(result.mismatchDiagnostics.mimeClass, 'image');
  assert.equal(result.mismatchDiagnostics.contentTypeToken, 'image/jpeg');
  assert.equal(result.mismatchDiagnostics.httpStatus, 200);
  assert.equal(result.mismatchDiagnostics.declaredLength, 10);
  assert.equal(result.mismatchDiagnostics.streamedBytes, 10);
});

test('sanitizeFailedItem omits mismatchDiagnostics for non-MEDIA_TYPE_MISMATCH errors', () => {
  const item = { stableId: 'test-id', shortcode: 'B', category: 'posts', mediaType: 'video' };
  const result = lib.sanitizeFailedItem(item, 'download failed', 0, 1, 'DOWNLOAD_FAILED');
  assert.equal(result.mismatchDiagnostics, undefined);
});

test('sanitizeFailedItem omits mismatchDiagnostics when errorCode is null (backward compat)', () => {
  const item = {
    stableId: 'test-id', shortcode: 'A', category: 'posts', mediaType: 'video',
    _mismatchDiagnostics: { expectedMediaType: 'video', actualMediaType: 'image', magicContainer: 'jpg', mimeClass: 'image', contentTypeToken: 'image/jpeg', httpStatus: 200, declaredLength: 10, streamedBytes: 10 }
  };
  const result = lib.sanitizeFailedItem(item, 'some error', 0, 1);
  assert.equal(result.mismatchDiagnostics, undefined);
});

test('mismatchDiagnostics enforces allowlisted enum values', () => {
  const item = {
    stableId: 'x', shortcode: 'X', category: 'posts', mediaType: 'video',
    _mismatchDiagnostics: { expectedMediaType: 'INJECTED', actualMediaType: 'bad', magicContainer: 'exe', mimeClass: null, contentTypeToken: 'a'.repeat(100), httpStatus: -1, declaredLength: NaN, streamedBytes: Infinity }
  };
  const result = lib.sanitizeFailedItem(item, 'err', 0, 1, 'MEDIA_TYPE_MISMATCH');
  assert.equal(result.mismatchDiagnostics.expectedMediaType, 'unknown');
  assert.equal(result.mismatchDiagnostics.actualMediaType, 'unknown');
  assert.equal(result.mismatchDiagnostics.magicContainer, 'unknown');
  assert.equal(result.mismatchDiagnostics.mimeClass, 'unknown');
  assert.equal(result.mismatchDiagnostics.contentTypeToken, null);
  assert.equal(result.mismatchDiagnostics.httpStatus, null);
  assert.equal(result.mismatchDiagnostics.declaredLength, null);
  assert.equal(result.mismatchDiagnostics.streamedBytes, null);
});

test('sanitizeContentTypeToken redaction via downloadOne error details', async (t) => {
  const paths = await setup(t);
  const item = lib.normalizeItems([{ shortcode: 'A', mediaType: 'video', href: 'https://instacognito.com/media?id=one' }]).items[0];

  await assert.rejects(
    lib.downloadOne(item, paths, { handle: 'example', runId: 'test', fetchImpl: fetchReturning(jpg, 'image/jpeg; boundary=something'), dnsLookup }),
    err => { assert.equal(err.details.contentTypeToken, 'image/jpeg'); return true; }
  );

  const item2 = lib.normalizeItems([{ shortcode: 'B', mediaType: 'video', href: 'https://instacognito.com/media?id=two' }]).items[0];
  await assert.rejects(
    lib.downloadOne(item2, paths, { handle: 'example', runId: 'test', fetchImpl: fetchReturning(jpg, ''), dnsLookup }),
    err => { assert.equal(err.details.contentTypeToken, null); return true; }
  );

  const item3 = lib.normalizeItems([{ shortcode: 'C', mediaType: 'video', href: 'https://instacognito.com/media?id=three' }]).items[0];
  await assert.rejects(
    lib.downloadOne(item3, paths, { handle: 'example', runId: 'test', fetchImpl: fetchReturning(jpg, 'x'.repeat(100)), dnsLookup }),
    err => { assert.equal(err.details.contentTypeToken, null); return true; }
  );
});

test('magicContainer allowlist accepts exactly jpg/png/mp4/webp/unknown and rejects all others', () => {
  const base = { expectedMediaType: 'video', actualMediaType: 'image', mimeClass: 'image', contentTypeToken: 'image/jpeg', httpStatus: 200, declaredLength: 10, streamedBytes: 10 };
  for (const valid of ['jpg', 'png', 'mp4', 'webp', 'unknown']) {
    const item = { stableId: 'mc', shortcode: 'MC', category: 'posts', _mismatchDiagnostics: { ...base, magicContainer: valid } };
    const result = lib.sanitizeFailedItem(item, 'err', 0, 1, 'MEDIA_TYPE_MISMATCH');
    assert.equal(result.mismatchDiagnostics.magicContainer, valid, 'should accept ' + valid);
  }
  for (const bad of ['exe', 'gif', 'avi', '', null, undefined, 42, true, 'a'.repeat(200), { toString() { return 'jpg'; } }]) {
    const item = { stableId: 'mc', shortcode: 'MC', category: 'posts', _mismatchDiagnostics: { ...base, magicContainer: bad } };
    const result = lib.sanitizeFailedItem(item, 'err', 0, 1, 'MEDIA_TYPE_MISMATCH');
    assert.equal(result.mismatchDiagnostics.magicContainer, 'unknown', 'should reject ' + JSON.stringify(bad));
  }
});

test('downloadOne MEDIA_TYPE_MISMATCH includes magicContainer for mp4 magic', async (t) => {
  const paths = await setup(t);
  const item = lib.normalizeItems([{ shortcode: 'V', mediaType: 'image', href: 'https://instacognito.com/media?id=v' }]).items[0];
  await assert.rejects(
    lib.downloadOne(item, paths, { handle: 'example', runId: 'test', fetchImpl: fetchReturning(mp4, 'video/mp4'), dnsLookup }),
    err => {
      assert.equal(err.details.magicContainer, 'mp4');
      assert.equal(err.details.actualMediaType, 'video');
      assert.equal(err.details.expectedMediaType, 'image');
      return true;
    }
  );
});

test('no signed URL leaks into sanitized error or diagnostics', () => {
  const item = {
    stableId: 'y', shortcode: 'Y', category: 'posts', mediaType: 'video',
    _mismatchDiagnostics: { expectedMediaType: 'video', actualMediaType: 'image', magicContainer: 'jpg', mimeClass: 'image', contentTypeToken: 'image/jpeg', httpStatus: 200, declaredLength: 10, streamedBytes: 10 }
  };
  const result = lib.sanitizeFailedItem(item, 'https://instacognito.com/media?id=one&sig=SECRET&token=XYZ', 0, 1, 'MEDIA_TYPE_MISMATCH');
  assert.ok(!result.error.includes('SECRET'));
  assert.ok(!result.error.includes('token=XYZ'));
  const diagText = JSON.stringify(result.mismatchDiagnostics);
  assert.ok(!diagText.includes('http://'));
  assert.ok(!diagText.includes('https://'));
});
