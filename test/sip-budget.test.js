'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SIP_POLICY,
  DEFAULT_SIP_BUDGET,
  validateSipBudgetConfig,
  sampleJitterMs,
  openSipBudget,
  detectInstagramWebFriction,
} = require('../src/sip-budget.js');
const { ArchiveError } = require('../src/index.js');

function tmpLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-sip-'));
  return path.join(dir, 'sip-budget.json');
}

test('default sip-sip budget matches researched safe velocity envelope', () => {
  assert.equal(DEFAULT_SIP_BUDGET.policy, 'authenticated-sip-v1');
  assert.equal(DEFAULT_SIP_BUDGET.maxPostsPerSip, 4);
  assert.equal(DEFAULT_SIP_BUDGET.maxFilesPerSip, 20);
  assert.equal(DEFAULT_SIP_BUDGET.maxRequestsPerHour, 18);
  assert.equal(DEFAULT_SIP_BUDGET.maxFilesPerHour, 20);
  assert.equal(DEFAULT_SIP_BUDGET.maxFilesPerDay, 80);
  assert.equal(DEFAULT_SIP_BUDGET.maxSipsPerDay, 4);
  assert.equal(DEFAULT_SIP_BUDGET.minCooldownMs, 3 * 3600000);
});

test('validateSipBudgetConfig rejects invalid bounds', () => {
  assert.throws(() => validateSipBudgetConfig({ maxPostsPerSip: 0 }, ArchiveError), /maxPostsPerSip/);
  assert.throws(() => validateSipBudgetConfig({ maxFilesPerSip: 25, maxFilesPerHour: 20 }, ArchiveError), /maxFilesPerSip cannot exceed maxFilesPerHour/);
  assert.throws(() => validateSipBudgetConfig({ minPostDelayMs: 20000, maxPostDelayMs: 10000 }, ArchiveError), /maxPostDelayMs/);
});

test('per-sip post and file caps enforce limits and arm between-sip cooldown on finishSip', () => {
  const file = tmpLedger();
  let now = 1700000000000;
  const sip1 = openSipBudget(file, 'run-1', { maxPostsPerSip: 2, maxFilesPerSip: 3 }, { ArchiveError, now: () => now, rng: () => 0.5 });

  sip1.admitRequest();
  sip1.admitPost();
  sip1.admitFile();
  sip1.admitFile();
  sip1.admitPost();
  assert.equal(sip1.canAdmitPost().ok, false);
  assert.throws(() => sip1.admitPost(), err => err.code === 'SIP_POST_LIMIT');

  sip1.admitFile();
  assert.equal(sip1.canAdmitFile().ok, false);
  assert.throws(() => sip1.admitFile(), err => err.code === 'SIP_FILE_LIMIT');

  const summary = sip1.finishSip();
  assert.equal(summary.sessionPosts, 2);
  assert.equal(summary.sessionFiles, 3);
  assert.ok(summary.nextSipNotBefore);

  // Immediate second sip is blocked by NEXT_SIP_COOLDOWN
  assert.throws(
    () => openSipBudget(file, 'run-2', {}, { ArchiveError, now: () => now + 60000 }),
    err => err.code === 'NEXT_SIP_COOLDOWN'
  );

  // Advance past 3h45m cooldown -> allowed
  now += 4 * 3600000;
  const sip2 = openSipBudget(file, 'run-2', {}, { ArchiveError, now: () => now, rng: () => 0 });
  assert.equal(sip2.state.sipsLastDay, 1);
  sip2.finishSip();
});

test('hourly request limit and daily file / sip limits are enforced across rolling windows', () => {
  const file = tmpLedger();
  let now = 1700000000000;
  const sip = openSipBudget(
    file,
    'run-hourly',
    { maxRequestsPerHour: 2, minCooldownMs: 0, maxCooldownJitterMs: 0 },
    { ArchiveError, now: () => now }
  );
  sip.admitRequest();
  sip.admitRequest();
  assert.throws(() => sip.admitRequest(), err => err.code === 'HOURLY_REQUEST_LIMIT');

  // Advance 61 minutes: hourly window clears
  now += 61 * 60000;
  sip.admitRequest();
  sip.finishSip();
});

test('recordChallenge trips circuit breaker and blocks subsequent runs until cleared', () => {
  const file = tmpLedger();
  let now = 1700000000000;
  const sip = openSipBudget(file, 'run-challenge', {}, { ArchiveError, now: () => now });
  const err = sip.recordChallenge('checkpoint_required', 401);
  assert.equal(err.code, 'SIP_CHALLENGED');
  sip.finishSip();

  now += 10 * 3600000;
  assert.throws(
    () => openSipBudget(file, 'run-after-challenge', {}, { ArchiveError, now: () => now }),
    e => e.code === 'SIP_CHALLENGED'
  );
});

test('detectInstagramWebFriction flags login redirects and rate-limit warnings', async () => {
  const loginPage = {
    evaluate: async () => ({
      href: 'https://www.instagram.com/accounts/login/',
      pathName: '/accounts/login/',
      bodyText: 'Log in to Instagram',
      hasLoginInput: true,
    }),
  };
  const r1 = await detectInstagramWebFriction(loginPage);
  assert.equal(r1.blocked, true);
  assert.equal(r1.kind, 'DENIED_AUTH');

  const rateLimitPage = {
    evaluate: async () => ({
      href: 'https://www.instagram.com/someprofile/',
      pathName: '/someprofile/',
      bodyText: 'Please wait a few minutes before you try again. Try Again Later.',
      hasLoginInput: false,
    }),
  };
  const r2 = await detectInstagramWebFriction(rateLimitPage);
  assert.equal(r2.blocked, true);
  assert.equal(r2.kind, 'RATE_LIMITED');

  const cleanPage = {
    evaluate: async () => ({
      href: 'https://www.instagram.com/callina.liang/',
      pathName: '/callina.liang/',
      bodyText: '107 posts',
      hasLoginInput: false,
    }),
  };
  const r3 = await detectInstagramWebFriction(cleanPage);
  assert.equal(r3.blocked, false);
});

test('sipInstagramWebProfile skips coveredShortcodes and sips only missing posts within budget', async () => {
  const { sipInstagramWebProfile } = require('../src/sip-budget.js');
  const file = tmpLedger();
  const sipBudget = openSipBudget(file, 'run-sip-web', { maxPostsPerSip: 2, minPostDelayMs: 0, maxPostDelayMs: 0 }, { ArchiveError, rng: () => 0 });
  const covered = new Set(['KNOWN1', 'KNOWN2']);
  const page = {
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      const s = String(fn);
      if (s.includes('hasLoginInput')) {
        return { href: 'https://www.instagram.com/callina.liang/', pathName: '/callina.liang/', bodyText: '107 posts', hasLoginInput: false };
      }
      if (s.includes('reportedTotal')) {
        return { reportedTotal: 107, codes: ['KNOWN1', 'KNOWN2', 'MISS1', 'MISS2', 'MISS3'] };
      }
      if (typeof arg === 'string') {
        return [{ shortcode: arg, mediaType: 'image', href: `https://instacognito.com/media?id=${arg}_0`, carouselIndex: 0, slideCount: 1 }];
      }
      return [];
    },
  };
  const res = await sipInstagramWebProfile(page, {
    handle: 'callina.liang',
    coveredShortcodes: covered,
    sipBudget,
    maxPages: 2,
    waitFn: async () => {},
  });
  assert.equal(res.sections[0].items.length, 2, 'only sips 2 missing posts per maxPostsPerSip');
  assert.deepEqual(res.sections[0].items.map(i => i.shortcode), ['MISS1', 'MISS2']);
  assert.equal(res.sipSummary.sessionPosts, 2);
  assert.equal(res.sipSummary.sessionFiles, 2);
});
