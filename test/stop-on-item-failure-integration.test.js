'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const lib = require('../src/index.js');

const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

function streamOf(buf) {
  return new ReadableStream({ start(c) { c.enqueue(buf); c.close(); } });
}

function okRes(body = jpg, mime = 'image/jpeg') {
  return {
    status: 200, ok: true, url: 'https://instacognito.com/media?id=x',
    headers: { get: k => k === 'content-type' ? mime : k === 'content-length' ? String(body.length) : null },
    body: streamOf(body)
  };
}

async function tmp(t) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-soif-'));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return path.join(d, 'out');
}

async function readManifest(out) {
  return JSON.parse(await fs.readFile(path.join(out, '.frameferry', 'example', 'manifest.json'), 'utf8'));
}

async function readStatus(out) {
  return JSON.parse(await fs.readFile(path.join(out, '.frameferry', 'example', 'status.json'), 'utf8'));
}

test('stopOnItemFailure bad-first: 1 failed 2 pending, status counts correct, PARTIAL', async (t) => {
  const out = await tmp(t);
  let attempts = 0;
  const items = [
    { shortcode: 'BAD', mediaType: 'video', href: 'https://instacognito.com/media?id=bad' },
    { shortcode: 'OK1', mediaType: 'image', href: 'https://instacognito.com/media?id=ok1' },
    { shortcode: 'OK2', mediaType: 'image', href: 'https://instacognito.com/media?id=ok2' },
  ];
  const result = await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 3,
    items, dnsLookup: publicDns, delayMs: 0,
    stopOnItemFailure: true,
    checkpointEveryItems: 1000,
    fetchImpl: async () => { attempts++; return okRes(); },
  });

  assert.equal(result.status, 'PARTIAL');
  assert.equal(attempts, 1);

  const manifest = await readManifest(out);
  assert.equal(Object.keys(manifest.failed).length, 1);
  assert.equal(Object.keys(manifest.pending).length, 2);

  const status = await readStatus(out);
  assert.equal(status.failedCount, 1);
  assert.equal(status.pendingCount, 2);
  assert.equal(status.cumulative.failedCount, 1);
  assert.equal(status.cumulative.pendingCount, 2);
  assert.equal(status.acquisition.runFailed, 1);
  assert.equal(status.acquisition.runPending, 2);
  assert.equal(status.downloadedCount, 0);

  const receiptFiles = await fs.readdir(path.join(out, 'receipts', 'example')).catch(() => []);
  assert.equal(receiptFiles.length, 0);
  const mediaFiles = await fs.readdir(path.join(out, 'media', 'example')).catch(() => []);
  assert.equal(mediaFiles.length, 0);

  for (const val of Object.values(manifest.pending)) {
    assert.match(val.error, /acquisition stopped after item failure/);
  }
});

test('stopOnItemFailure success-then-bad: 1 downloaded 1 failed 1 pending, receipt for success only', async (t) => {
  const out = await tmp(t);
  let attempts = 0;
  const items = [
    { shortcode: 'OK', mediaType: 'image', href: 'https://instacognito.com/media?id=ok' },
    { shortcode: 'BAD', mediaType: 'video', href: 'https://instacognito.com/media?id=bad' },
    { shortcode: 'SKIP', mediaType: 'image', href: 'https://instacognito.com/media?id=skip' },
  ];
  const result = await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 3,
    items, dnsLookup: publicDns, delayMs: 0,
    stopOnItemFailure: true,
    checkpointEveryItems: 1000,
    fetchImpl: async () => { attempts++; return okRes(); },
  });

  assert.equal(result.status, 'PARTIAL');
  assert.equal(attempts, 2);
  assert.equal(result.downloadedCount, 1);

  const manifest = await readManifest(out);
  assert.equal(Object.keys(manifest.completed).length, 1);
  assert.equal(Object.keys(manifest.failed).length, 1);
  assert.equal(Object.keys(manifest.pending).length, 1);

  const status = await readStatus(out);
  assert.equal(status.failedCount, 1);
  assert.equal(status.pendingCount, 1);
  assert.equal(status.completedCount, 1);

  const receiptFiles = await fs.readdir(path.join(out, 'receipts', 'example'));
  assert.equal(receiptFiles.length, 1);
  const mediaFiles = await fs.readdir(path.join(out, 'media', 'example'));
  assert.equal(mediaFiles.length, 1);

  const pendingVal = Object.values(manifest.pending)[0];
  assert.match(pendingVal.error, /acquisition stopped after item failure/);
});

test('stopOnItemFailure resume: second run picks up pending items', async (t) => {
  const out = await tmp(t);
  const items = [
    { shortcode: 'BAD', mediaType: 'video', href: 'https://instacognito.com/media?id=bad' },
    { shortcode: 'OK1', mediaType: 'image', href: 'https://instacognito.com/media?id=ok1' },
    { shortcode: 'OK2', mediaType: 'image', href: 'https://instacognito.com/media?id=ok2' },
  ];
  await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 3,
    items, dnsLookup: publicDns, delayMs: 0,
    stopOnItemFailure: true,
    checkpointEveryItems: 1000,
    fetchImpl: async () => okRes(),
  });

  let resumeAttempts = 0;
  const allImage = items.map(i => ({ ...i, mediaType: 'image' }));
  const result2 = await lib.archiveProfile({
    handle: 'example', output: out, mode: 'sync', reportedTotal: 3,
    items: allImage, dnsLookup: publicDns, delayMs: 0,
    fetchImpl: async () => { resumeAttempts++; return okRes(); },
  });

  assert.equal(result2.status, 'COMPLETE');
  assert.equal(resumeAttempts, 3);
  const manifest = await readManifest(out);
  assert.equal(Object.keys(manifest.completed).length, 3);
  assert.equal(Object.keys(manifest.pending).length, 0);
  assert.equal(Object.keys(manifest.failed).length, 0);
});

test('default behavior (no stopOnItemFailure) continues after failure', async (t) => {
  const out = await tmp(t);
  let attempts = 0;
  const items = [
    { shortcode: 'BAD', mediaType: 'video', href: 'https://instacognito.com/media?id=bad' },
    { shortcode: 'OK1', mediaType: 'image', href: 'https://instacognito.com/media?id=ok1' },
    { shortcode: 'OK2', mediaType: 'image', href: 'https://instacognito.com/media?id=ok2' },
  ];
  const result = await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 3,
    items, dnsLookup: publicDns, delayMs: 0,
    checkpointEveryItems: 1000,
    fetchImpl: async () => { attempts++; return okRes(); },
  });

  assert.equal(result.status, 'PARTIAL');
  assert.equal(attempts, 3);
  assert.equal(result.downloadedCount, 2);

  const manifest = await readManifest(out);
  assert.equal(Object.keys(manifest.completed).length, 2);
  assert.equal(Object.keys(manifest.failed).length, 1);
  assert.equal(Object.keys(manifest.pending).length, 0);
});

test('maxAcquireItems is independent from stopOnItemFailure', async (t) => {
  const out = await tmp(t);
  let attempts = 0;
  const items = [
    { shortcode: 'A', mediaType: 'image', href: 'https://instacognito.com/media?id=a' },
    { shortcode: 'B', mediaType: 'image', href: 'https://instacognito.com/media?id=b' },
    { shortcode: 'C', mediaType: 'image', href: 'https://instacognito.com/media?id=c' },
  ];
  const result = await lib.archiveProfile({
    handle: 'example', output: out, reportedTotal: 3,
    items, dnsLookup: publicDns, delayMs: 0,
    stopOnItemFailure: true,
    maxAcquireItems: 1,
    checkpointEveryItems: 1000,
    fetchImpl: async () => { attempts++; return okRes(); },
  });

  assert.equal(attempts, 1);
  assert.equal(result.downloadedCount, 1);
  assert.equal(result.status, 'PARTIAL');

  const manifest = await readManifest(out);
  assert.equal(Object.keys(manifest.completed).length, 1);
  assert.equal(Object.keys(manifest.pending).length, 2);
  assert.equal(Object.keys(manifest.failed).length, 0);
});
