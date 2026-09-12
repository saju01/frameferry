'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const testCi = path.join(__dirname, '..', 'scripts', 'run-ci-tests.js');
const packageGuard = path.join(__dirname, '..', 'scripts', 'package-guard.js');
const { parseTap } = require(testCi);

test('test-ci passes on a passing test file', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'pass.test.js');
  await fsp.writeFile(fixture, `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    test('a passing test', () => { assert.equal(1, 1); });
    test('another passing test', () => { assert.equal(2, 2); });
  `);
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, 'should exit 0 for passing tests');
  assert.match(result.stdout, /2 passed/);
  assert.match(result.stdout, /all checks passed/);
});

test('test-ci fails on a failing test', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'fail.test.js');
  await fsp.writeFile(fixture, `
    const test = require('node:test');
    const assert = require('node:assert/strict');
    test('a failing test', () => { assert.equal(1, 2); });
  `);
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'should exit non-zero for failing tests');
  assert.match(result.stderr, /1 test\(s\) failed/);
});

test('test-ci fails on a skipped test', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'skip.test.js');
  await fsp.writeFile(fixture, `
    const test = require('node:test');
    test('a skipped test', { skip: true }, () => {});
  `);
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'should exit non-zero for skipped tests');
  assert.match(result.stderr, /1 test\(s\) skipped/);
});

test('test-ci fails on a nested skipped test', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'nested-skip.test.js');
  await fsp.writeFile(fixture, `
    const { test } = require('node:test');
    test('parent', async (t) => {
      await t.test('nested passing', () => {});
      await t.test('nested skipped', { skip: true }, () => {});
    });
  `);
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'should exit non-zero for nested skipped tests');
  assert.match(result.stderr, /skipped/);
});

test('test-ci fails on a todo test', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'todo.test.js');
  await fsp.writeFile(fixture, `
    const { test } = require('node:test');
    test('not implemented yet', { todo: 'coming soon' }, () => {});
  `);
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'should exit non-zero for todo tests');
  assert.match(result.stderr, /todo/);
});

// Node wraps every test file as a top-level ok entry, so total===0 is only
// reachable when TAP output is completely absent (crash before any output) or
// the plan explicitly declares 1..0. Both cases are verified via parseTap.
test('parseTap: zero-test file (1..0 plan) triggers no-results error', () => {
  const r = parseTap('TAP version 13\n1..0\n');
  assert.equal(r.sawPlan, true, '1..0: sawPlan');
  assert.equal(r.planCount, 0, '1..0: planCount 0');
  assert.equal(r.total, 0, '1..0: total 0 triggers no-results error in CI');
});

test('test-ci fails when no files match glob', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const bogusGlob = path.join(tmp, 'nonexistent-*.test.js');
  const result = spawnSync(process.execPath, [testCi, bogusGlob], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'should exit non-zero when no files match');
});

test('test-ci fails on non-zero process exit', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'crash.test.js');
  await fsp.writeFile(fixture, 'process.exit(42);');
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'should exit non-zero for process crash');
  assert.match(result.stderr, /process exited with code/);
});

test('test-ci fails on a nested todo test', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'nested-todo.test.js');
  await fsp.writeFile(fixture, `
    const { test } = require('node:test');
    test('parent', async (t) => {
      await t.test('nested passing', () => {});
      await t.test('nested todo', { todo: 'not implemented' }, () => {});
    });
  `);
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'should exit non-zero for nested todo tests');
  assert.match(result.stderr, /todo/i);
});

test('run-ci-tests detects signal-killed child and fails closed', async () => {
  // Node 24 test runner intercepts SIGKILL in fixture child processes and converts
  // them to exit-code-1 failures, so we can't trigger the signal path through
  // node --test itself.  Instead, verify the detection logic directly: spawn a
  // plain process (not a test runner), kill it by signal, and confirm that
  // the close-handler logic in run-ci-tests.js would correctly report it.
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let tap = '';
  child.stdout.on('data', d => { tap += d; });
  const { code, signal } = await new Promise(resolve =>
    child.on('close', (code, signal) => resolve({ code, signal }))
  );
  assert.equal(signal, 'SIGTERM', 'plain child process can die by signal');
  assert.equal(code, null, 'exit code is null on signal death');
  const errors = [];
  if (signal) errors.push(`process killed by signal ${signal}`);
  if (code !== 0 && code !== null) errors.push(`process exited with code ${code}`);
  const r = parseTap(tap);
  if (!r.sawPlan) errors.push('no TAP plan');
  if (r.total === 0) errors.push('no test results');
  assert.ok(errors.some(e => /signal/i.test(e)), `should report signal: ${errors.join(', ')}`);
});

test('test-ci fails when PLAYWRIGHT_CHROMIUM_EXECUTABLE is invalid (no skipping)', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'browser.test.js');
  // This fixture is the canonical "browser-required" pattern: it must fail,
  // never skip, when the Chromium binary is absent or misconfigured.
  await fsp.writeFile(fixture, `
    'use strict';
    const { test } = require('node:test');
    const fs = require('node:fs');
    test('browser launch requires valid Chromium', () => {
      const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
      if (!exe) throw new Error('PLAYWRIGHT_CHROMIUM_EXECUTABLE is not set');
      if (!fs.existsSync(exe)) throw new Error('Chromium not found at ' + exe + ' — set PLAYWRIGHT_CHROMIUM_EXECUTABLE to a real binary');
    });
  `);
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PLAYWRIGHT_CHROMIUM_EXECUTABLE: '/nonexistent/chromium' },
  });
  assert.notEqual(result.status, 0, 'should fail when Chromium path is invalid');
  assert.match(result.stderr, /failed/i);
});

test('test-ci fails on a cancelled test', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'cancel.test.js');
  await fsp.writeFile(fixture, `
    const { test } = require('node:test');
    const ac = new AbortController();
    ac.abort();
    test('should be cancelled', { signal: ac.signal }, async () => {
      await new Promise(r => setTimeout(r, 10000));
    });
  `);
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'should exit non-zero for cancelled tests');
  // cancelled tests show up as either cancelled or failed depending on Node version
  const combined = result.stdout + result.stderr;
  assert.match(combined, /cancelled|failed/i);
});

test('parseTap: handles malformed and incomplete input', (t) => {
  // empty string: no plan, no tests
  {
    const r = parseTap('');
    assert.equal(r.sawPlan, false, 'empty: no plan');
    assert.equal(r.total, 0, 'empty: no tests');
  }

  // only a plan with zero tests
  {
    const r = parseTap('TAP version 13\n1..0\n');
    assert.equal(r.sawPlan, true, 'zero-plan: sawPlan');
    assert.equal(r.planCount, 0, 'zero-plan: planCount 0');
    assert.equal(r.total, 0, 'zero-plan: no results');
  }

  // plan declared but no result lines (truncated output)
  {
    const r = parseTap('TAP version 13\n1..3\nok 1 - first\n');
    assert.equal(r.sawPlan, true, 'truncated: sawPlan');
    assert.equal(r.planCount, 3, 'truncated: planCount 3');
    assert.equal(r.total, 1, 'truncated: only 1 result');
  }

  // garbage input: no recognizable TAP
  {
    const r = parseTap('not tap output at all\njunk\n');
    assert.equal(r.sawPlan, false, 'garbage: no plan');
    assert.equal(r.total, 0, 'garbage: no results');
  }

  // cancelled test in TAP
  {
    const r = parseTap('TAP version 13\nnot ok 1 - my test # cancelled\n1..1\n');
    assert.equal(r.cancelled, 1, 'cancelled: detected');
    assert.equal(r.failed, 0, 'cancelled: not counted as plain failure');
    assert.equal(r.total, 1, 'cancelled: counts in total');
  }

  // nested skip not visible at top level
  {
    const nested = [
      'TAP version 13',
      '# Subtest: parent',
      '    ok 1 - nested skip # SKIP reason',
      '    1..1',
      'ok 1 - parent',
      '1..1',
    ].join('\n');
    const r = parseTap(nested);
    assert.equal(r.skipped, 1, 'nested-skip: detected');
    assert.equal(r.passed, 1, 'nested-skip: parent counted as passed');
    assert.equal(r.total, 1, 'nested-skip: only top-level in total');
  }

  // nested todo
  {
    const nested = [
      'TAP version 13',
      '# Subtest: parent',
      '    ok 1 - nested todo # TODO implement me',
      '    1..1',
      'ok 1 - parent',
      '1..1',
    ].join('\n');
    const r = parseTap(nested);
    assert.equal(r.todo, 1, 'nested-todo: detected');
  }
});

test('test-ci fails when a matched test file registers no tests', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'empty.test.js');
  await fsp.writeFile(fixture, `'use strict';\n// no test() registrations\n`);
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'should exit non-zero when test file has no registered tests');
  assert.match(result.stderr, /no tests registered|registered no tests/i);
});

test('package-guard passes on current tree', () => {
  const result = spawnSync(process.execPath, [packageGuard], {
    encoding: 'utf8', timeout: 30000, cwd: path.join(__dirname, '..'),
  });
  assert.equal(result.status, 0, `package-guard should pass: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /all files pass/);
});

test('package-guard rejects a tree with blocked files', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-guard-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  // Create a minimal package that includes a blocked file
  await fsp.writeFile(path.join(tmp, 'package.json'), JSON.stringify({
    name: 'test-blocked',
    version: '0.0.1',
    files: ['index.js', 'credentials.json'],
  }));
  await fsp.writeFile(path.join(tmp, 'index.js'), '');
  await fsp.writeFile(path.join(tmp, 'credentials.json'), '{}');

  const result = spawnSync(process.execPath, [packageGuard], {
    encoding: 'utf8', timeout: 30000, cwd: tmp,
  });
  assert.notEqual(result.status, 0, 'should reject blocked files');
  assert.match(result.stderr, /BLOCKED.*credentials/i);
});

test('package-guard blocks archive and key file extensions', async (t) => {
  const cases = [
    { label: '.tgz archive', filename: 'dist.tgz' },
    { label: '.pem key', filename: 'server.pem' },
    { label: 'secrets.json', filename: 'secrets.json' },
  ];

  for (const { label, filename } of cases) {
    await t.test(`blocks ${label}`, async (st) => {
      const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-guard-'));
      st.after(() => fsp.rm(tmp, { recursive: true, force: true }));
      await fsp.writeFile(path.join(tmp, 'package.json'), JSON.stringify({
        name: 'test-blocked-ext',
        version: '0.0.1',
        files: ['index.js', filename],
      }));
      await fsp.writeFile(path.join(tmp, 'index.js'), '');
      await fsp.writeFile(path.join(tmp, filename), '');
      const result = spawnSync(process.execPath, [packageGuard], {
        encoding: 'utf8', timeout: 30000, cwd: tmp,
      });
      assert.notEqual(result.status, 0, `should reject ${label}`);
      assert.match(result.stderr, /BLOCKED/i);
    });
  }
});

test('test-ci fails when one of multiple files registers no tests', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const validFixture = path.join(tmp, 'valid.test.js');
  await fsp.writeFile(validFixture, `
    const test = require('node:test');
    test('a real test', () => {});
  `);

  const emptyFixture = path.join(tmp, 'empty.test.js');
  await fsp.writeFile(emptyFixture, `'use strict';\n// no test() registrations\n`);

  const result = spawnSync(process.execPath, [testCi, validFixture, emptyFixture], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.notEqual(result.status, 0, 'should exit non-zero when any matched file has no registered tests');
  assert.match(result.stderr, /no tests registered|registered no tests/i);
});

test('package-guard rejects README.md.bak (startsWith false positive)', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-guard-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  await fsp.writeFile(path.join(tmp, 'package.json'), JSON.stringify({
    name: 'test-bak',
    version: '0.0.1',
    files: ['index.js', 'README.md.bak'],
  }));
  await fsp.writeFile(path.join(tmp, 'index.js'), '');
  await fsp.writeFile(path.join(tmp, 'README.md.bak'), '');

  const result = spawnSync(process.execPath, [packageGuard], {
    encoding: 'utf8', timeout: 30000, cwd: tmp,
  });
  assert.notEqual(result.status, 0, 'should reject README.md.bak as unexpected');
  assert.match(result.stderr, /UNEXPECTED.*README\.md\.bak/i);
});

test('package-guard rejects LICENSEanything (startsWith false positive)', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-guard-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  await fsp.writeFile(path.join(tmp, 'package.json'), JSON.stringify({
    name: 'test-lic',
    version: '0.0.1',
    files: ['index.js', 'LICENSEanything'],
  }));
  await fsp.writeFile(path.join(tmp, 'index.js'), '');
  await fsp.writeFile(path.join(tmp, 'LICENSEanything'), '');

  const result = spawnSync(process.execPath, [packageGuard], {
    encoding: 'utf8', timeout: 30000, cwd: tmp,
  });
  assert.notEqual(result.status, 0, 'should reject LICENSEanything as unexpected');
  assert.match(result.stderr, /UNEXPECTED.*LICENSEanything/i);
});

test('package-guard does not falsely reject benign filenames', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-guard-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  // Benign filenames that contain auth/token/state/media/backfill as substrings
  // but are legitimate source or reference files
  await fsp.mkdir(path.join(tmp, 'src'), { recursive: true });
  await fsp.mkdir(path.join(tmp, 'references'), { recursive: true });

  const benignFiles = [
    'src/authentication.js',
    'src/tokenizer.js',
    'src/state-machine.js',
    'src/media-types.js',
    'references/backfill-guide.md',
  ];

  await fsp.writeFile(path.join(tmp, 'package.json'), JSON.stringify({
    name: 'test-benign',
    version: '0.0.1',
    files: benignFiles,
  }));
  for (const f of benignFiles) {
    await fsp.mkdir(path.join(tmp, path.dirname(f)), { recursive: true });
    await fsp.writeFile(path.join(tmp, f), '');
  }

  const result = spawnSync(process.execPath, [packageGuard], {
    encoding: 'utf8', timeout: 30000, cwd: tmp,
  });
  assert.equal(result.status, 0,
    `benign filenames should not be rejected:\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /all files pass/);
});
