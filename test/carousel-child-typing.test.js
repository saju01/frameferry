'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const lib = require('../src/index.js');

function cardHtml(dataType, id, likes) {
  const typeAttr = dataType ? ' data-type="' + dataType + '"' : '';
  return '<article class="post-card">' +
    '<div class="post-image"' + typeAttr + '></div>' +
    '<div class="post-content"><a class="content-download-btn" href="https://instacognito.com/media?id=' + id + '">d</a></div>' +
    '<div class="post-footer"><div class="icon-group likes-trigger" data-id="MIX"><span>' + likes + '</span></div></div>' +
    '</article>';
}
const MIXED_CARDS_HTML = cardHtml('video', 'vid1', 5) + cardHtml('image', 'img2', 3) + cardHtml(null, 'unk3', 1);

test('readRawCardsFromPage does not inherit media type across sibling carousel children', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no chromium binary'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div id="post-container">' + MIXED_CARDS_HTML + '</div>');
  const items = await lib.readRawCardsFromPage(page);
  assert.equal(items.length, 3);
  assert.equal(items[0].mediaType, 'video');
  assert.ok(items[0].href.endsWith('id=vid1'));
  assert.equal(items[1].mediaType, 'image');
  assert.ok(items[1].href.endsWith('id=img2'));
  assert.equal(items[2].mediaType, 'unknown');
  assert.ok(items[2].href.endsWith('id=unk3'));
  assert.ok(items.every(i => i.shortcode === 'MIX'));
});

test('installCapture extract does not inherit media type across sibling carousel children', async (t) => {
  let chromium;
  try { chromium = require('playwright').chromium; } catch { t.skip('playwright unavailable'); return; }
  const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath();
  if (!exe || !fs.existsSync(exe)) { t.skip('no chromium binary'); return; }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('data:text/html,<html><body><div id="post-container"></div></body></html>');
  await lib.discovery.installCapture(page);
  await lib.discovery.resetCapture(page, 'posts');
  await page.evaluate((html) => {
    document.getElementById('post-container').innerHTML = html;
  }, MIXED_CARDS_HTML);
  await new Promise(r => setTimeout(r, 100));
  const drained = await lib.discovery.drainCapture(page);
  const cards = drained.batches.flatMap(b => b.cards);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].mediaType, 'video');
  assert.ok(cards[0].href.endsWith('id=vid1'));
  assert.equal(cards[1].mediaType, 'image');
  assert.ok(cards[1].href.endsWith('id=img2'));
  assert.equal(cards[2].mediaType, 'unknown');
  assert.ok(cards[2].href.endsWith('id=unk3'));
  assert.ok(cards.every(c => c.shortcode === 'MIX'));
});

test('extractItemsFromRawCards preserves per-card media type through normalizeItems', () => {
  const raw = [
    { shortcode: 'MIX', mediaType: 'video', href: 'https://instacognito.com/media?id=vid1' },
    { shortcode: 'MIX', mediaType: 'image', href: 'https://instacognito.com/media?id=img2' },
    { shortcode: 'MIX', href: 'https://instacognito.com/media?id=unk3' },
  ];
  // Unknown-typed cards are never excluded by the media-types filter (only known types that
  // aren't in the allowlist are dropped), so all three cards survive here.
  const result = lib.extractItemsFromRawCards(raw, { category: 'posts', mediaTypes: ['image', 'video'] });
  assert.equal(result.items.length, 3);
  const byHref = href => result.items.find(i => i.href === href);
  assert.equal(byHref('https://instacognito.com/media?id=vid1').mediaType, 'video');
  assert.equal(byHref('https://instacognito.com/media?id=img2').mediaType, 'image');
  assert.equal(byHref('https://instacognito.com/media?id=unk3').mediaType, 'unknown');
});
