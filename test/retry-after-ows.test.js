'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openBudget } = require('../src/request-budget.js');
const ORIGIN = 'https://instacognito.com';
const EPOCH = Date.UTC(2026, 0, 1);
const RETRY_AT = '2026-01-01T00:00:07.000Z';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-retry-ows-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['Date'], now: EPOCH });
  return path.join(root, 'ledger.json');
}

async function nativeCooldown(t, status, raw) {
  const file = await fixture(t);
  let calls = 0, observedRaw;
  const server = http.createServer((_req, res) => {
    calls++;
    res.writeHead(status, { 'ReTrY-AfTeR': raw });
    res.end('synthetic refusal');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const nativeFetch = globalThis.fetch;
  // Redirect fixture routing only: actual native fetch/Headers and budget.fetch.
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const response = await nativeFetch('http://127.0.0.1:' + server.address().port, init);
    observedRaw = response.headers.get('retry-after');
    return response;
  });
  const first = openBudget(file, 'original');
  let refusal, stop;
  try {
    const signal = first.signal;
    await assert.rejects(first.fetch(ORIGIN + '/media', {}), { code: 'PROVIDER_DENIED' });
    stop = signal.reason;
    assert.equal(signal.aborted, true);
    assert.equal(first.signal, signal);
    assert.equal(stop.code, 'PROVIDER_DENIED');
    assert.equal(observedRaw, raw, 'native Headers retain trailing HTTP OWS');
    refusal = structuredClone(first.data.denial);
    assert.equal(refusal.retry_after_raw, raw);
    assert.equal(refusal.at, new Date(EPOCH).toISOString());
    assert.equal(refusal.status, status);
    assert.equal(first.data.requests, 1);
    assert.equal(first.data.active_restriction.disposition, 'provider-cooldown');
    assert.equal(first.data.active_restriction.retry_at, RETRY_AT);
    t.mock.timers.setTime(EPOCH + 7000);
    await assert.rejects(first.admit('download'), error => error === stop);
    assert.equal(first.signal.reason, stop);
    assert.equal(first.data.requests, 1);
  } finally { first.close(); }
  assert.equal(calls, 1);
  const initial = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const [ms, run, blocked] of [[0, 'immediate', true], [6999, 'held', true], [7000, 'free', false], [7001, 'original', true], [7001, 'held', true]]) {
    t.mock.timers.setTime(EPOCH + ms);
    const next = openBudget(file, run);
    try {
      if (blocked) {
        await assert.rejects(next.admit('download'), { code: 'PROVIDER_DENIED' });
        assert.equal(next.data.active_restriction.retry_at, RETRY_AT);
      } else {
        next.reserve('download');
        assert.equal(next.data.active_restriction, null);
        assert.equal(next.data.denial, null);
      }
      assert.equal(next.data.requests, blocked ? 0 : 1);
      assert.deepEqual(next.data.denial_history, [refusal]);
      assert.deepEqual(next.data.denial_dispositions, initial.denial_dispositions);
    } finally { next.close(); }
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(saved.denial_history, [refusal]);
    assert.deepEqual(saved.denial_dispositions, initial.denial_dispositions);
    assert.equal(saved.denial_dispositions[0].observed_at, refusal.at);
  }
}

for (const status of [429, 503]) {
  for (const raw of ['7', '7 ', '7\t', '7 \t ', 'Thu, 01 Jan 2026 00:00:07 GMT ', 'Thu, 01 Jan 2026 00:00:07 GMT\t']) {
    test(`native budget.fetch HTTP${status} ${JSON.stringify(raw)} enforces original cooldown and run latch`, t => nativeCooldown(t, status, raw));
  }
}

// Header adapters may retain leading OWS too; unlike a wire header parser,
// this inspect path must preserve the complete original value in its history.
for (const status of [429, 503]) {
  for (const raw of [' \t7\t ', '\t Thu, 01 Jan 2026 00:00:07 GMT \t']) {
    test(`inspect HTTP${status} preserves both OWS edges ${JSON.stringify(raw)}`, async t => {
      const file = await fixture(t), b = openBudget(file, 'original');
      let refusal;
      try {
        assert.throws(() => b.inspect(status, { 'retry-after': raw }, ORIGIN), { code: 'PROVIDER_DENIED' });
        refusal = structuredClone(b.data.denial);
        assert.equal(refusal.retry_after_raw, raw);
        assert.equal(b.data.active_restriction.retry_at, RETRY_AT);
      } finally { b.close(); }
      t.mock.timers.setTime(EPOCH + 6999);
      const held = openBudget(file, 'held');
      try {
        assert.throws(() => held.reserve('download'), { code: 'PROVIDER_DENIED' });
        assert.deepEqual(held.data.denial_history, [refusal]);
        assert.equal(held.data.active_restriction.observed_at, refusal.at);
        assert.equal(held.data.active_restriction.retry_at, RETRY_AT);
      } finally { held.close(); }
      t.mock.timers.setTime(EPOCH + 7000);
      const free = openBudget(file, 'free');
      try {
        free.reserve('download');
        assert.equal(free.data.active_restriction, null);
        assert.deepEqual(free.data.denial_history, [refusal]);
      } finally { free.close(); }
    });
  }
}

const invalid = [
  '', ' \t ', 'invalid', '-1', '+7', '7.0', '7e0',
  '7 0', '7\t0', '7\n', '7\r', '\n7', '7\r\n',
  '\u00a07\u00a0', '7\u2003', '7\u2028', '7\u2029', '7\v', '7\f',
  'Thu,\t01 Jan 2026 00:00:07 GMT', 'Thu, 01 Jan 2026 00:00:07 GMT\n',
  'Friday, 02-Jan-26 00:00:07 GMT', 'Jan 1 2026 00:00:07 GMT',
  'Fri, 01 Jan 2026 00:00:07 GMT', 'Mon, 30 Feb 2026 00:00:07 GMT',
  '9007199254740992', '8640000000000', '9'.repeat(101), '7' + ' '.repeat(100),
];
for (const status of [429, 503]) {
  for (const raw of invalid) {
    test(`HTTP${status} rejects non-HTTP/invalid/truncated Retry-After ${JSON.stringify(raw)}`, async t => {
      const file = await fixture(t), b = openBudget(file, 'original');
      let refusal, dispositions;
      try {
        assert.throws(() => b.inspect(status, { 'retry-after': raw }, ORIGIN), { code: 'PROVIDER_DENIED' });
        refusal = structuredClone(b.data.denial);
        dispositions = structuredClone(b.data.denial_dispositions);
        assert.equal(refusal.retry_after_raw, raw.slice(0, 100));
        assert.equal(refusal.retry_after_truncated, raw.length > 100 ? true : undefined);
        assert.equal(dispositions[0].disposition, 'retry-time-unknown');
        assert.equal(dispositions[0].retry_at, null);
        assert.equal(b.signal.aborted, true);
        const reason = b.signal.reason;
        await assert.rejects(b.admit('download'), error => error === reason);
        assert.equal(b.data.requests, 0);
      } finally { b.close(); }
      const next = openBudget(file, 'new-authorized-run');
      try {
        next.reserve('download');
        assert.equal(next.data.active_restriction, null);
        assert.deepEqual(next.data.denial_history, [refusal]);
        assert.deepEqual(next.data.denial_dispositions, dispositions);
      } finally { next.close(); }
      const original = openBudget(file, 'original');
      try { assert.throws(() => original.assert(), { code: 'PROVIDER_DENIED' }); }
      finally { original.close(); }
      const saved = JSON.parse(await fs.readFile(file, 'utf8'));
      assert.deepEqual(saved.denial_history, [refusal]);
      assert.deepEqual(saved.denial_dispositions, dispositions);
    });
  }
}
