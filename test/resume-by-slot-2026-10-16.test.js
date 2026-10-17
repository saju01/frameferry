'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const lib = require('../src/index.js');

const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
function res(body = jpg, type = 'image/jpeg') {
  const lower = { 'content-type': type, 'content-length': String(body.length) };
  let sent = false;
  return { status: 200, ok: true, url: 'https://instacognito.com/media?id=x', headers: { get: k => lower[String(k).toLowerCase()] || null },
    body: new ReadableStream({ pull(c) { if (sent) { c.close(); return; } sent = true; c.enqueue(body); } }) };
}
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'ff-slot-'));
const section = items => ({ category: 'posts', status: 'COMPLETE', items, reportedTotal: 2 });
const items = tag => [
  { shortcode: 'A', carouselIndex: 0, href: `https://instacognito.com/media?id=A0${tag}`, mediaType: 'image', slideCount: 2 },
  { shortcode: 'A', carouselIndex: 1, href: `https://instacognito.com/media?id=A1${tag}`, mediaType: 'image', slideCount: 2 },
  { shortcode: 'B', carouselIndex: 0, href: `https://instacognito.com/media?id=B0${tag}`, mediaType: 'image', slideCount: 1 },
];
async function run(out, opts, fetchImpl) {
  return lib.archiveProfile({ handle: 'example', output: out, dnsLookup: publicDns, delayMs: 0, fetchImpl, ...opts });
}

test('rotated fingerprints: WITHOUT resumeBySlot every slot is downloaded again (default unchanged)', async () => {
  const out = path.join(await tmp(), 'out'); let calls = 0;
  await run(out, { sections: [section(items('v1'))] }, async () => { calls++; return res(); });
  assert.equal(calls, 3);
  calls = 0;
  const r = await run(out, { sections: [section(items('v2'))] }, async () => { calls++; return res(); });
  assert.equal(calls, 3);
  assert.ok(r.downloadedCount >= 1);
});

test('rotated fingerprints: WITH resumeBySlot verified slots are reused and nothing is fetched', async () => {
  const out = path.join(await tmp(), 'out'); let calls = 0;
  await run(out, { sections: [section(items('v1'))] }, async () => { calls++; return res(); });
  calls = 0;
  const r = await run(out, { sections: [section(items('v2'))], resumeBySlot: true }, async () => { calls++; return res(); });
  assert.equal(calls, 0);
  assert.equal(r.downloadedCount, 0);
  assert.equal(r.reusedCount, 3);
  assert.equal(r.pendingCount, 0);
  assert.equal(r.status, 'COMPLETE');
});

test('resumeBySlot only skips slots that are covered; a new slide is still downloaded', async () => {
  const out = path.join(await tmp(), 'out'); let calls = 0;
  await run(out, { sections: [section(items('v1').slice(0, 2))] }, async () => { calls++; return res(); });
  calls = 0;
  const r = await run(out, { sections: [section(items('v2'))], resumeBySlot: true }, async () => { calls++; return res(); });
  assert.equal(calls, 1);
  assert.equal(r.reusedCount, 2);
  assert.equal(r.downloadedCount, 1);
});

test('resumeBySlot refuses a slot whose media type disagrees', async () => {
  const out = path.join(await tmp(), 'out'); let calls = 0;
  await run(out, { sections: [section([{ shortcode: 'A', carouselIndex: 0, href: 'https://instacognito.com/media?id=A0v1', mediaType: 'image', slideCount: 1 }])] }, async () => { calls++; return res(); });
  calls = 0;
  await run(out, { sections: [section([{ shortcode: 'A', carouselIndex: 0, href: 'https://instacognito.com/media?id=A0v2', mediaType: 'video', slideCount: 1 }])], resumeBySlot: true },
    async () => { calls++; return res(Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0, 0, 0, 0]), 'video/mp4'); });
  assert.equal(calls, 1);
});

test('resumeBySlot refuses a slot whose slide count changed (post grew from 2 to 3 slides)', async () => {
  const out = path.join(await tmp(), 'out'); let calls = 0;
  const cards = (n, tag) => Array.from({ length: n }, (_, i) => ({ shortcode: 'A', carouselIndex: i, href: `https://instacognito.com/media?id=A${i}${tag}`, mediaType: 'image' }));
  await run(out, { sections: [section(cards(2, 'v1'))] }, async () => { calls++; return res(); });
  assert.equal(calls, 2);
  calls = 0;
  await run(out, { sections: [section(cards(3, 'v2'))], resumeBySlot: true }, async () => { calls++; return res(); });
  // slide count differs (2 vs 3): the reorder hazard, so nothing is trusted by slot and all 3 are fetched
  assert.equal(calls, 3);
});

test('resumeBySlot never trusts a receipt whose bytes no longer verify', async () => {
  const out = path.join(await tmp(), 'out'); let calls = 0;
  await run(out, { sections: [section(items('v1'))] }, async () => { calls++; return res(); });
  const media = path.join(out, 'media', 'example');
  for (const f of await fsp.readdir(media)) await fsp.writeFile(path.join(media, f), Buffer.concat([jpg, Buffer.from('tampered')]));
  calls = 0;
  const r = await run(out, { sections: [section(items('v2'))], resumeBySlot: true }, async () => { calls++; return res(); });
  assert.equal(calls, 3);
  assert.equal(r.reusedCount, 0);
});

test('resumeBySlot resolves carried pending entries whose slot is proved, without discovery', async () => {
  const out = path.join(await tmp(), 'out');
  await run(out, { sections: [section([{ shortcode: 'A', carouselIndex: 0, href: 'https://instacognito.com/media?id=A0v1', mediaType: 'image' }])] }, async () => res());
  const m = path.join(out, '.frameferry', 'example', 'manifest.json');
  const man = JSON.parse(await fsp.readFile(m, 'utf8'));
  man.pending = { 'posts__stale-rotated-id': { stableId: 'posts__stale-rotated-id', category: 'posts', shortcode: 'A', carouselIndex: 0, mediaType: 'image', slideCount: 1, attempts: 1, error: 'awaiting rediscovery' } };
  await fsp.writeFile(m, JSON.stringify(man));
  await run(out, { sections: [section([])], resumeBySlot: true }, async () => res());
  const after = JSON.parse(await fsp.readFile(m, 'utf8'));
  assert.equal(Object.keys(after.pending || {}).includes('posts__stale-rotated-id'), false);
});

test('resumeBySlot also clears a carried stale entry whose slot gets downloaded in the SAME run', async () => {
  const out = path.join(await tmp(), 'out');
  await run(out, { sections: [section([{ shortcode: 'A', carouselIndex: 0, href: 'https://instacognito.com/media?id=A0v1', mediaType: 'image' }])] }, async () => res());
  const m = path.join(out, '.frameferry', 'example', 'manifest.json');
  const man = JSON.parse(await fsp.readFile(m, 'utf8'));
  man.pending = { 'posts__stale-b': { stableId: 'posts__stale-b', category: 'posts', shortcode: 'B', carouselIndex: 0, mediaType: 'image', slideCount: 1, attempts: 1, error: 'awaiting rediscovery', providerMediaFingerprint: 'f'.repeat(64), identityBasis: 'provider-media-fingerprint-v1' } };
  await fsp.writeFile(m, JSON.stringify(man));
  const r = await run(out, { sections: [section([
    { shortcode: 'A', carouselIndex: 0, href: 'https://instacognito.com/media?id=A0v2', mediaType: 'image' },
    { shortcode: 'B', carouselIndex: 0, href: 'https://instacognito.com/media?id=B0v2', mediaType: 'image' }])], resumeBySlot: true }, async () => res());
  const after = JSON.parse(await fsp.readFile(m, 'utf8'));
  assert.equal(Object.keys(after.pending || {}).includes('posts__stale-b'), false);
  assert.equal(r.pendingCount, 0);
});

test('retainVisibleBatch assigns batch-local carouselIndex and slideCount across multiple generations of the same post', async () => {
  const c = (post, slide, ver) => ({
    shortcode: post, mediaType: 'image',
    href: `https://instacognito.com/media?id=${post}_${slide}_${ver}`,
    dateRaw: '1 January 2026', captionTruncated: 'cap'
  });
  let raw = [c('P1', 0, 'v1'), c('P1', 1, 'v1')];
  const next = [c('P1', 0, 'v2'), c('P1', 1, 'v2'), c('P2', 0, 'v2')];
  const page = {
    locator(sel) {
      return {
        evaluateAll: async fn => sel.includes('iframe') ? false
          : String(fn).includes('count: cards.length')
            ? { count: raw.length, ids: [...new Set(raw.map(x => x.shortcode))] }
            : raw.map(x => ({ ...x })),
        count: async () => 0
      };
    },
    evaluate: async (_fn, arg) => {
      if (Array.isArray(arg)) {
        if (arg[1]) raw = next;
        return { sentinelIndex: 0, sentinelId: raw[0]?.shortcode, sentinelSource: 'observed' };
      }
      return true;
    },
    waitForTimeout: async ms => new Promise(r => setTimeout(r, ms))
  };
  const s = await lib.scrapeCardSection(page, {
    category: 'posts', mediaTypes: ['image'], reportedTotal: 99,
    started: Date.now(), maxTimeMs: 1650, maxPages: 1, resumeBySlot: true
  });
  const p1 = s.items.filter(i => i.shortcode === 'P1');
  assert.equal(p1.length, 2, 'dedupeSlotPositions keeps 2 slides for P1 instead of 4');
  assert.deepEqual(p1.map(i => i.carouselIndex), [0, 1]);
  assert.deepEqual(p1.map(i => i.slideCount), [2, 2]);
  assert.ok(p1.every(i => i.href.endsWith('_v2')), 'keeps freshest locator per slot');
});

test('scrapeCardSection under resumeBySlot stops pagination when duplicate DOM growth yields no new media identities for 2 consecutive steps', async () => {
  const c = (post, slide, ver) => ({
    shortcode: post, mediaType: 'image',
    href: `https://instacognito.com/media?id=${post}_${slide}_${ver}`,
    dateRaw: '1 January 2026', captionTruncated: 'cap'
  });
  let raw = [c('P1', 0, 'v1'), c('P1', 1, 'v1')];
  let scrollTriggers = 0;
  const page = {
    locator(sel) {
      return {
        evaluateAll: async fn => sel.includes('iframe') ? false
          : String(fn).includes('count: cards.length')
            ? { count: raw.length, ids: [...new Set(raw.map(x => x.shortcode))] }
            : raw.map(x => ({ ...x })),
        count: async () => 0
      };
    },
    evaluate: async (_fn, arg) => {
      if (Array.isArray(arg)) {
        if (arg[1]) {
          scrollTriggers++;
          // Simulate provider appending duplicate cards with already-seen fingerprints on every scroll trigger
          raw = [...raw, c('P1', 0, 'v1'), c('P1', 1, 'v1')];
        }
        return { sentinelIndex: 0, sentinelId: raw[0]?.shortcode, sentinelSource: 'observed' };
      }
      return true;
    },
    waitForTimeout: async () => {}
  };
  const s = await lib.scrapeCardSection(page, {
    category: 'posts', mediaTypes: ['image'], reportedTotal: 99,
    started: Date.now(), maxTimeMs: 30000, maxPages: 20, resumeBySlot: true
  });
  assert.equal(s.evidence.pages, 2, 'stops after 2 consecutive stagnant media steps instead of burning all 20 pages');
  assert.equal(s.evidence.stopCause, 'no-trigger');
});
