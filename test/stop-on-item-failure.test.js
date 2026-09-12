'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateOptions } = require('../src/discovery.js');

test('validateOptions accepts stopOnItemFailure', () => {
  assert.equal(validateOptions({}).stopOnItemFailure, false);
  assert.equal(validateOptions({ stopOnItemFailure: true }).stopOnItemFailure, true);
  assert.equal(validateOptions({ stopOnItemFailure: false }).stopOnItemFailure, false);
  assert.equal(validateOptions({ stopOnItemFailure: 'yes' }).stopOnItemFailure, true);
  assert.equal(validateOptions({ stopOnItemFailure: 0 }).stopOnItemFailure, false);
});

const bin = path.join(__dirname, '..', 'bin', 'frameferry.js');

test('CLI parser accepts --stop-on-item-failure for archive', () => {
  const result = spawnSync(process.execPath, [bin, 'archive', 'example', '--stop-on-item-failure', '--max-acquire-items'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, 'spawn must not error');
  assert.equal(result.signal, null, 'process must not be signalled');
  assert.equal(result.status, 1, 'parser rejects missing sentinel value with exit 1');
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.status, 'BAD_ARGS');
  assert.equal(parsed.error, '--max-acquire-items requires a value');
});

test('CLI parser rejects --stop-on-item-failure for non-archive commands', () => {
  const result = spawnSync(process.execPath, [bin, 'status', 'example', '--stop-on-item-failure', '--output', '/tmp/frameferry-stop-on-item-failure-test'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, 'spawn must not error');
  assert.equal(result.signal, null, 'process must not be signalled');
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.status, 'BAD_ARGS');
  assert.match(parsed.error, /--stop-on-item-failure is not valid for status/);
});

test('CLI parser treats --stop-on-item-failure as boolean (no value required)', () => {
  const result = spawnSync(process.execPath, [bin, 'archive', 'example', '--stop-on-item-failure', '--network-timeout-ms'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, 'spawn must not error');
  assert.equal(result.signal, null, 'process must not be signalled');
  assert.equal(result.status, 1, 'parser rejects missing sentinel value with exit 1');
  const parsed = JSON.parse(result.stderr);
  assert.equal(parsed.status, 'BAD_ARGS');
  assert.equal(parsed.error, '--network-timeout-ms requires a value');
});

test('default behavior does not stop on item failure', () => {
  assert.equal(validateOptions({}).stopOnItemFailure, false);
});

test('maxAcquireItems is independent from stopOnItemFailure', () => {
  const opts = validateOptions({ maxAcquireItems: 1, stopOnItemFailure: true });
  assert.equal(opts.maxAcquireItems, 1);
  assert.equal(opts.stopOnItemFailure, true);
  const opts2 = validateOptions({ maxAcquireItems: 1 });
  assert.equal(opts2.stopOnItemFailure, false);
});
