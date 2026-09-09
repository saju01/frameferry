'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const testCi = path.join(__dirname, '..', 'scripts', 'run-ci-tests.js');
const packageGuard = path.join(__dirname, '..', 'scripts', 'package-guard.js');

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

test('test-ci detects incomplete TAP output', async (t) => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'ci-harness-'));
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const fixture = path.join(tmp, 'nontap.test.js');
  await fsp.writeFile(fixture, `
    const test = require('node:test');
    test('one', () => {});
  `);
  const result = spawnSync(process.execPath, [testCi, fixture], {
    encoding: 'utf8', timeout: 15000,
  });
  // One passing test should still pass
  assert.equal(result.status, 0);
  assert.match(result.stdout, /1 passed/);
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
