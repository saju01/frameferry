'use strict';

// Authenticated "sip-sip" rolling budget and attached-browser Instagram Web discovery
// for FrameFerry v0.4.0. Never handles credentials, logins, cookies, or mobile APIs:
// attaches only to an already-open local browser context via CDP and enforces conservative
// session, hourly, daily, and inter-sip cooldown budgets.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SIP_POLICY = 'authenticated-sip-v1';
const HOUR_MS = 3600000;
const DAY_MS = 86400000;

const DEFAULT_SIP_BUDGET = Object.freeze({
  policy: SIP_POLICY,
  maxPostsPerSip: 4,
  maxFilesPerSip: 20,
  maxRequestsPerHour: 18,
  maxFilesPerHour: 20,
  maxFilesPerDay: 80,
  maxSipsPerDay: 4,
  minCooldownMs: 3 * HOUR_MS,      // 3 hours minimum between sips
  maxCooldownJitterMs: 90 * 60000, // +0..90 min random jitter
  minPostDelayMs: 8000,            // 8..18s between post opens
  maxPostDelayMs: 18000,
  minMediaDelayMs: 5000,           // 5..12s between slide saves
  maxMediaDelayMs: 12000,
});

function validateSipBudgetConfig(overrides = {}, ArchiveError = Error) {
  if (overrides == null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new ArchiveError('BAD_BUDGET', 'sipBudget must be an object');
  }
  const cfg = { ...DEFAULT_SIP_BUDGET };
  const positiveIntKeys = [
    'maxPostsPerSip',
    'maxFilesPerSip',
    'maxRequestsPerHour',
    'maxFilesPerHour',
    'maxFilesPerDay',
    'maxSipsPerDay',
  ];
  const nonNegIntKeys = [
    'minCooldownMs',
    'maxCooldownJitterMs',
    'minPostDelayMs',
    'maxPostDelayMs',
    'minMediaDelayMs',
    'maxMediaDelayMs',
  ];
  for (const k of positiveIntKeys) {
    if (overrides[k] !== undefined) {
      if (!Number.isSafeInteger(overrides[k]) || overrides[k] < 1) {
        throw new ArchiveError('BAD_BUDGET', `${k} must be a positive safe integer`);
      }
      cfg[k] = overrides[k];
    }
  }
  for (const k of nonNegIntKeys) {
    if (overrides[k] !== undefined) {
      if (!Number.isSafeInteger(overrides[k]) || overrides[k] < 0) {
        throw new ArchiveError('BAD_BUDGET', `${k} must be a non-negative safe integer`);
      }
      cfg[k] = overrides[k];
    }
  }
  if (cfg.maxPostDelayMs < cfg.minPostDelayMs) {
    throw new ArchiveError('BAD_BUDGET', 'maxPostDelayMs must be >= minPostDelayMs');
  }
  if (cfg.maxMediaDelayMs < cfg.minMediaDelayMs) {
    throw new ArchiveError('BAD_BUDGET', 'maxMediaDelayMs must be >= minMediaDelayMs');
  }
  if (cfg.maxFilesPerSip > cfg.maxFilesPerHour) {
    throw new ArchiveError('BAD_BUDGET', 'maxFilesPerSip cannot exceed maxFilesPerHour');
  }
  if (cfg.maxFilesPerHour > cfg.maxFilesPerDay) {
    throw new ArchiveError('BAD_BUDGET', 'maxFilesPerHour cannot exceed maxFilesPerDay');
  }
  return Object.freeze(cfg);
}

function sampleJitterMs(minMs, maxMs, rng = Math.random) {
  if (maxMs <= minMs) return minMs;
  const u = Math.max(0, Math.min(1, Number(rng())));
  return Math.round(minMs + u * (maxMs - minMs));
}

function atomicWrite(file, doc) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function openSipBudget(file, runId, overrides = {}, options = {}) {
  const ArchiveError = options.ArchiveError || Error;
  const nowFn = options.now || (() => Date.now());
  const rng = options.rng || Math.random;

  if (!file || typeof runId !== 'string' || !/^[A-Za-z0-9._-]{1,150}$/.test(runId)) {
    throw new ArchiveError('BAD_BUDGET', 'sip ledger path and safe run ID required');
  }
  const config = validateSipBudgetConfig(overrides, ArchiveError);
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  if (fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink()) {
    throw new ArchiveError('BAD_BUDGET', 'sip ledger cannot be a symlink');
  }

  let doc = {
    policy: SIP_POLICY,
    created_at: new Date(nowFn()).toISOString(),
    updated_at: new Date(nowFn()).toISOString(),
    challenged: null,
    next_sip_not_before_ms: null,
    request_timestamps_ms: [],
    file_timestamps_ms: [],
    sip_sessions: [],
  };

  if (fs.existsSync(resolved)) {
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ArchiveError('BAD_BUDGET', 'corrupt sip ledger');
    }
    doc = {
      ...doc,
      ...raw,
      request_timestamps_ms: Array.isArray(raw.request_timestamps_ms) ? raw.request_timestamps_ms.filter(Number.isFinite) : [],
      file_timestamps_ms: Array.isArray(raw.file_timestamps_ms) ? raw.file_timestamps_ms.filter(Number.isFinite) : [],
      sip_sessions: Array.isArray(raw.sip_sessions) ? raw.sip_sessions : [],
    };
  }

  const prune = now => {
    doc.request_timestamps_ms = doc.request_timestamps_ms.filter(t => t > now - HOUR_MS);
    doc.file_timestamps_ms = doc.file_timestamps_ms.filter(t => t > now - DAY_MS);
    doc.sip_sessions = doc.sip_sessions.filter(s => s && Number.isFinite(s.started_at_ms) && s.started_at_ms > now - DAY_MS);
  };

  const save = now => {
    prune(now);
    doc.updated_at = new Date(now).toISOString();
    atomicWrite(resolved, doc);
  };

  const now0 = nowFn();
  prune(now0);

  if (doc.challenged) {
    const err = new ArchiveError('SIP_CHALLENGED', `authenticated sip session halted by prior challenge (${doc.challenged.reason || 'challenge'}); manual verification required`);
    err.details = { challenged: doc.challenged };
    throw err;
  }

  if (Number.isFinite(doc.next_sip_not_before_ms) && now0 < doc.next_sip_not_before_ms) {
    const retryAt = new Date(doc.next_sip_not_before_ms).toISOString();
    const err = new ArchiveError('NEXT_SIP_COOLDOWN', `between-sip cooldown active until ${retryAt}`);
    err.retryAt = retryAt;
    err.details = { retryAt, remainingMs: doc.next_sip_not_before_ms - now0 };
    throw err;
  }

  if (doc.sip_sessions.length >= config.maxSipsPerDay) {
    const oldest = doc.sip_sessions[0].started_at_ms;
    const retryAt = new Date(oldest + DAY_MS).toISOString();
    const err = new ArchiveError('DAILY_SIP_LIMIT', `daily sip session cap (${config.maxSipsPerDay}/24h) reached until ${retryAt}`);
    err.retryAt = retryAt;
    throw err;
  }

  let sessionStarted = false;
  let sessionPosts = 0;
  let sessionFiles = 0;
  let sessionRequests = 0;
  let closed = false;

  const ensureSessionRecorded = now => {
    if (!sessionStarted) {
      sessionStarted = true;
      doc.sip_sessions.push({ run_id: runId, started_at_ms: now, posts: 0, files: 0, requests: 0 });
    }
    const cur = doc.sip_sessions[doc.sip_sessions.length - 1];
    if (cur && cur.run_id === runId) {
      cur.posts = sessionPosts;
      cur.files = sessionFiles;
      cur.requests = sessionRequests;
    }
  };

  const checkHealthy = () => {
    if (closed) throw new ArchiveError('BUDGET_CLOSED', 'sip ledger is closed');
    if (doc.challenged) throw new ArchiveError('SIP_CHALLENGED', `session challenged: ${doc.challenged.reason}`);
  };

  const admitRequest = () => {
    checkHealthy();
    const now = nowFn();
    prune(now);
    if (doc.request_timestamps_ms.length >= config.maxRequestsPerHour) {
      const retryAt = new Date(doc.request_timestamps_ms[0] + HOUR_MS).toISOString();
      const err = new ArchiveError('HOURLY_REQUEST_LIMIT', `hourly sip request ceiling (${config.maxRequestsPerHour}/hr) reached`);
      err.retryAt = retryAt;
      throw err;
    }
    sessionRequests++;
    doc.request_timestamps_ms.push(now);
    ensureSessionRecorded(now);
    save(now);
  };

  const canAdmitPost = () => {
    if (closed || doc.challenged) return { ok: false, reason: 'challenged-or-closed' };
    if (sessionPosts >= config.maxPostsPerSip) return { ok: false, reason: 'sip-post-limit' };
    return { ok: true, reason: null };
  };

  const admitPost = () => {
    checkHealthy();
    const check = canAdmitPost();
    if (!check.ok) throw new ArchiveError('SIP_POST_LIMIT', `per-sip post limit (${config.maxPostsPerSip}) reached`);
    const now = nowFn();
    sessionPosts++;
    ensureSessionRecorded(now);
    save(now);
  };

  const canAdmitFile = () => {
    if (closed || doc.challenged) return { ok: false, reason: 'challenged-or-closed' };
    const now = nowFn();
    prune(now);
    if (sessionFiles >= config.maxFilesPerSip) return { ok: false, reason: 'sip-file-limit' };
    const filesLastHour = doc.file_timestamps_ms.filter(t => t > now - HOUR_MS).length;
    if (filesLastHour >= config.maxFilesPerHour) return { ok: false, reason: 'hourly-file-limit' };
    if (doc.file_timestamps_ms.length >= config.maxFilesPerDay) return { ok: false, reason: 'daily-file-limit' };
    return { ok: true, reason: null };
  };

  const admitFile = () => {
    checkHealthy();
    const now = nowFn();
    prune(now);
    const check = canAdmitFile();
    if (!check.ok) {
      const err = new ArchiveError('SIP_FILE_LIMIT', `sip file budget exhausted (${check.reason})`);
      err.details = { stopReason: check.reason };
      throw err;
    }
    sessionFiles++;
    doc.file_timestamps_ms.push(now);
    ensureSessionRecorded(now);
    save(now);
  };

  const recordChallenge = (reason = 'session-challenged', status = null) => {
    const now = nowFn();
    doc.challenged = {
      id: crypto.randomBytes(6).toString('hex'),
      run_id: runId,
      at: new Date(now).toISOString(),
      reason: String(reason).slice(0, 120),
      status: Number.isInteger(status) ? status : null,
    };
    save(now);
    const err = new ArchiveError('SIP_CHALLENGED', `authenticated session challenged (${doc.challenged.reason}); circuit breaker tripped`);
    err.details = { challenged: doc.challenged };
    return err;
  };

  const finishSip = () => {
    if (closed) return null;
    const now = nowFn();
    if (sessionStarted && !doc.challenged && config.minCooldownMs > 0) {
      const jitter = sampleJitterMs(0, config.maxCooldownJitterMs, rng);
      doc.next_sip_not_before_ms = now + config.minCooldownMs + jitter;
    }
    save(now);
    closed = true;
    return {
      policy: SIP_POLICY,
      runId,
      sessionPosts,
      sessionFiles,
      sessionRequests,
      nextSipNotBefore: doc.next_sip_not_before_ms ? new Date(doc.next_sip_not_before_ms).toISOString() : null,
      filesLastHour: doc.file_timestamps_ms.filter(t => t > now - HOUR_MS).length,
      filesLastDay: doc.file_timestamps_ms.length,
      sipsLastDay: doc.sip_sessions.length,
    };
  };

  return {
    config,
    get state() {
      const now = nowFn();
      prune(now);
      return {
        policy: SIP_POLICY,
        sessionPosts,
        sessionFiles,
        sessionRequests,
        requestsLastHour: doc.request_timestamps_ms.length,
        filesLastHour: doc.file_timestamps_ms.filter(t => t > now - HOUR_MS).length,
        filesLastDay: doc.file_timestamps_ms.length,
        sipsLastDay: doc.sip_sessions.length,
        nextSipNotBefore: doc.next_sip_not_before_ms ? new Date(doc.next_sip_not_before_ms).toISOString() : null,
        challenged: doc.challenged,
      };
    },
    admitRequest,
    canAdmitPost,
    admitPost,
    canAdmitFile,
    admitFile,
    recordChallenge,
    finishSip,
    nextPostDelayMs: () => sampleJitterMs(config.minPostDelayMs, config.maxPostDelayMs, rng),
    nextMediaDelayMs: () => sampleJitterMs(config.minMediaDelayMs, config.maxMediaDelayMs, rng),
  };
}

// Inspect an attached-browser Instagram page for login walls, challenges, or rate-limit banners.
async function detectInstagramWebFriction(page) {
  const obs = await page.evaluate(() => {
    const href = String(location.href || '');
    const pathName = String(location.pathname || '');
    const bodyText = String(document.body?.innerText || '').slice(0, 4000);
    const hasLoginInput = !!document.querySelector('input[name="username"], input[name="password"]');
    return { href, pathName, bodyText, hasLoginInput };
  }).catch(() => ({ href: '', pathName: '', bodyText: '', hasLoginInput: false }));

  if (/\/(accounts\/login|challenge|checkpoint|suspended)\b/i.test(obs.pathName) || obs.hasLoginInput) {
    return { blocked: true, kind: 'DENIED_AUTH', reason: 'instagram-web session requires login or checkpoint verification' };
  }
  if (/try again later|we restrict certain activity|automated behavior|suspicious activity/i.test(obs.bodyText)) {
    return { blocked: true, kind: 'RATE_LIMITED', reason: 'instagram-web rate-limit or automation warning banner detected' };
  }
  return { blocked: false, kind: null, reason: null };
}

// Attached-browser sip discovery on an already logged-in Instagram Web session.
// Reads the profile grid, skips shortcodes already covered in coveredShortcodes,
// opens at most maxPostsPerSip missing posts with human jitter, and returns standard
// FrameFerry section records without ever touching credentials or cookies.
async function sipInstagramWebProfile(page, {
  handle,
  categories = ['posts'],
  mediaTypes = ['image', 'video'],
  coveredShortcodes = new Set(),
  sipBudget,
  maxPages = 6,
  waitFn = ms => page.waitForTimeout(ms),
} = {}) {
  const category = categories[0] || 'posts';
  sipBudget.admitRequest();
  const profileUrl = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await waitFn(2500);

  const friction = await detectInstagramWebFriction(page);
  if (friction.blocked) {
    throw sipBudget.recordChallenge(friction.reason, friction.kind === 'RATE_LIMITED' ? 429 : 401);
  }

  const meta = await page.evaluate(() => {
    const text = String(document.body?.innerText || '');
    const m = text.match(/(\d[\d,]*)\s+posts/i);
    const total = m ? Number(m[1].replace(/,/g, '')) : null;
    const links = [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
      .map(a => a.getAttribute('href') || '')
      .map(h => {
        const match = h.match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
        return match ? match[1] : null;
      })
      .filter(Boolean);
    return { reportedTotal: Number.isSafeInteger(total) ? total : null, codes: [...new Set(links)] };
  });

  const seenCodes = new Set(meta.codes);
  let pages = 0;
  while (pages < maxPages) {
    const missingSoFar = [...seenCodes].filter(sc => !coveredShortcodes.has(sc));
    if (missingSoFar.length >= sipBudget.config.maxPostsPerSip) break;
    if (!sipBudget.canAdmitPost().ok) break;
    pages++;
    sipBudget.admitRequest();
    await page.evaluate(() => window.scrollBy(0, 900));
    await waitFn(sipBudget.nextPostDelayMs());
    const stepFriction = await detectInstagramWebFriction(page);
    if (stepFriction.blocked) {
      throw sipBudget.recordChallenge(stepFriction.reason, stepFriction.kind === 'RATE_LIMITED' ? 429 : 401);
    }
    const moreCodes = await page.evaluate(() =>
      [...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')]
        .map(a => {
          const m = (a.getAttribute('href') || '').match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
          return m ? m[1] : null;
        })
        .filter(Boolean)
    );
    const beforeSize = seenCodes.size;
    for (const c of moreCodes) seenCodes.add(c);
    if (seenCodes.size === beforeSize) break;
  }

  const items = [];
  for (const sc of seenCodes) {
    if (coveredShortcodes.has(sc)) continue;
    if (!sipBudget.canAdmitPost().ok || !sipBudget.canAdmitFile().ok) break;
    sipBudget.admitPost();
    sipBudget.admitRequest();
    await waitFn(sipBudget.nextPostDelayMs());
    const slides = await page.evaluate(shortcode => {
      const a = document.querySelector(`a[href*="/p/${shortcode}"], a[href*="/reel/${shortcode}"]`);
      const img = a?.querySelector('img');
      const src = img?.currentSrc || img?.src || null;
      return src ? [{ shortcode, mediaType: 'image', href: src, carouselIndex: 0, slideCount: 1 }] : [];
    }, sc);
    for (const s of slides) {
      if (!mediaTypes.includes(s.mediaType)) continue;
      if (!sipBudget.canAdmitFile().ok) break;
      sipBudget.admitFile();
      items.push({
        ...s,
        category,
        dateRaw: null,
        captionTruncated: null,
      });
    }
  }

  const sipSummary = sipBudget.finishSip();
  return {
    profile: { handle, reportedPostCount: meta.reportedTotal },
    sipSummary,
    sections: [{
      category,
      status: meta.reportedTotal != null && seenCodes.size >= meta.reportedTotal ? 'COMPLETE' : 'PARTIAL',
      reportedTotal: meta.reportedTotal,
      uniquePostCount: seenCodes.size,
      hitLimit: true,
      noGrowth: false,
      items,
      evidence: {
        source: 'instagram-web-sip',
        stopCause: 'sip-budget',
        pages,
        sipSummary,
      },
    }],
  };
}

module.exports = {
  SIP_POLICY,
  DEFAULT_SIP_BUDGET,
  validateSipBudgetConfig,
  sampleJitterMs,
  openSipBudget,
  detectInstagramWebFriction,
  sipInstagramWebProfile,
};
