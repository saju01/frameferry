'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scrapeCardSection, normalizeItems } = require('../src/index.js');

const card = (post, media, version = 'old', date = '1 January 2026') => ({
  shortcode: post, mediaType: 'image',
  href: 'https://instacognito.com/media?id=' + media + '&fixture=' + version,
  dateRaw: date, captionTruncated: 'fixture'
});
function pageFixture(initial, next, tick = null) {
  let raw = initial;
  let elapsed = 0;
  return {
    locator(selector) {
      return {
        evaluateAll: async fn => selector.includes('iframe') ? false
          : String(fn).includes('count: cards.length')
            ? { count: raw.length, ids: [...new Set(raw.map(c => c.shortcode))] }
            : raw.map(c => ({ ...c })),
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
    waitForTimeout: async ms => {
      elapsed += ms;
      if (tick) raw = tick(elapsed);
      await new Promise(resolve => setTimeout(resolve, ms));
    }
  };
}
const scan = page => scrapeCardSection(page, {
  category: 'posts', mediaTypes: ['image'], reportedTotal: 999,
  started: Date.now(), maxTimeMs: 1650, maxPages: 1
});

test('latest observed locator replaces an older locator without inventing a slide', async () => {
  const s = await scan(pageFixture([card('A', 'one')], [card('A', 'one', 'fresh'), card('B', 'two')]));
  const a = s.items.filter(i => i.shortcode === 'A');
  assert.equal(a.length, 1);
  assert.ok(a[0].href.endsWith('fixture=fresh'));
});

test('changing caption or date does not create a second identity for one provider slide', async () => {
  const updated = { ...card('A', 'one', 'fresh', '2 January 2026'), captionTruncated: 'changed' };
  const s = await scan(pageFixture([card('A', 'one')], [updated, card('B', 'two')]));
  const a = s.items.filter(i => i.shortcode === 'A');
  assert.equal(a.length, 1);
  assert.equal(a[0].dateRaw, '2 January 2026');
});

test('constant-size same-post render changes retain transient provider slides', async () => {
  const s = await scan(pageFixture([card('A', 'm1')], [card('A', 'm2')],
    elapsed => [card('A', elapsed === 250 ? 'm3' : 'm4')]));
  const actual = new Set(s.items.map(i => i.providerMediaFingerprint));
  const expected = normalizeItems(['m1', 'm2', 'm3', 'm4'].map(m => card('A', m))).items;
  for (const item of expected) assert.ok(actual.has(item.providerMediaFingerprint));
});

test('raw-card observation errors must not be swallowed as an empty successful batch', async () => {
  const page = pageFixture([card('A', 'one')], [card('B', 'two')]);
  const locate = page.locator;
  page.locator = selector => {
    const loc = locate(selector);
    const original = loc.evaluateAll;
    loc.evaluateAll = async fn => {
      if (selector === '#post-container .post-card' && !String(fn).includes('count: cards.length')) {
        throw new Error('fixture-observation-failed');
      }
      return original(fn);
    };
    return loc;
  };
  await assert.rejects(scan(page), /fixture-observation-failed/);
});
