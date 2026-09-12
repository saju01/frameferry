'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../src/index.js');

const jpg = Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,4,0xff,0xd9]);
const dnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function fetchReturning(body, mime) {
  return async () => ({
    status: 200,
    ok: true,
    url: 'https://instacognito.com/media?id=x',
    headers: { get: k => k === 'content-type' ? mime : k === 'content-length' ? String(body.length) : null },
    body: new ReadableStream({ start(c) { c.enqueue(body); c.close(); } })
  });
}

async function tmpPaths(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-completion-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return lib.profilePaths(root, 'example');
}

test('failed item produces no media file and no receipt', async (t) => {
  const paths = await tmpPaths(t);
  const item = lib.normalizeItems([{ shortcode: 'A', mediaType: 'video', href: 'https://instacognito.com/media?id=one' }]).items[0];
  await assert.rejects(
    lib.downloadOne(item, paths, { handle: 'example', runId: 'test', fetchImpl: fetchReturning(jpg, 'image/jpeg'), dnsLookup }),
    { code: 'MEDIA_TYPE_MISMATCH' }
  );
  const receiptFiles = await fs.readdir(paths.receiptDir).catch(() => []);
  assert.equal(receiptFiles.length, 0);
  const mediaFiles = await fs.readdir(paths.mediaDir).catch(() => []);
  assert.equal(mediaFiles.filter(f => !f.endsWith('.part')).length, 0);
  // temp .part files must be cleaned up on failure too
  assert.equal(mediaFiles.length, 0);
});

test('successful item followed by failed item leaves correct receipts', async (t) => {
  const paths = await tmpPaths(t);
  const good = lib.normalizeItems([{ shortcode: 'GOOD', mediaType: 'image', href: 'https://instacognito.com/media?id=good' }]).items[0];
  const bad = lib.normalizeItems([{ shortcode: 'BAD', mediaType: 'video', href: 'https://instacognito.com/media?id=bad' }]).items[0];

  const goodResult = await lib.downloadOne(good, paths, { handle: 'example', runId: 'test', fetchImpl: fetchReturning(jpg, 'image/jpeg'), dnsLookup });
  await assert.rejects(
    lib.downloadOne(bad, paths, { handle: 'example', runId: 'test', fetchImpl: fetchReturning(jpg, 'image/jpeg'), dnsLookup }),
    { code: 'MEDIA_TYPE_MISMATCH' }
  );

  const receiptFiles = await fs.readdir(paths.receiptDir).catch(() => []);
  assert.equal(receiptFiles.length, 1);
  assert.ok(receiptFiles[0].startsWith(goodResult.receipt.stableId));

  const mediaFiles = await fs.readdir(paths.mediaDir).catch(() => []);
  assert.equal(mediaFiles.length, 1);
});

test('decideOutcome returns PARTIAL when failed entries exist', () => {
  const result = lib.decideOutcome({ reportedTotal: 2, uniquePostCount: 2, failed: 1, pending: 0 });
  assert.equal(result.status, 'PARTIAL');
});

test('decideOutcome returns PARTIAL when pending entries exist', () => {
  const result = lib.decideOutcome({ reportedTotal: 2, uniquePostCount: 2, failed: 0, pending: 1 });
  assert.equal(result.status, 'PARTIAL');
});

test('decideOutcome returns PARTIAL when failed/pending outstanding regardless of reportedTotal value', () => {
  // reportedTotal of 0 (not null) still routes through the failed/pending checks rather than
  // short-circuiting to ACTION_REQUIRED or COMPLETE.
  const resultZero = lib.decideOutcome({ reportedTotal: 0, uniquePostCount: 0, failed: 1, pending: 0 });
  assert.equal(resultZero.status, 'PARTIAL');
  const resultPending = lib.decideOutcome({ reportedTotal: 0, uniquePostCount: 0, failed: 0, pending: 1 });
  assert.equal(resultPending.status, 'PARTIAL');
  // Only a null reportedTotal (unparseable) escapes the failed/pending gate entirely.
  const resultNull = lib.decideOutcome({ reportedTotal: null, uniquePostCount: 0, failed: 1, pending: 0 });
  assert.equal(resultNull.status, 'ACTION_REQUIRED');
});

test('sanitizeFailedItem backward compatibility: 4-arg calls still work', () => {
  const result = lib.sanitizeFailedItem({ stableId: 'id', shortcode: 'SC', category: 'posts' }, 'error msg', 0, 1);
  assert.equal(result.stableId, 'id');
  assert.equal(result.error, 'error msg');
  assert.equal(result.mismatchDiagnostics, undefined);
});
