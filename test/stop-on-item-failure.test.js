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
  const result = spawnSync(process.execPath, [bin, 'archive', 'example', '--stop-on-item-failure', '--output', '/tmp/frameferry-stop-on-item-failure-test'], { encoding: 'utf8', timeout: 5000 });
  assert.ok(!/is not valid for archive/.test(result.stderr || ''));
});

test('CLI parser rejects --stop-on-item-failure for non-archive commands', () => {
  const result = spawnSync(process.execPath, [bin, 'status', 'example', '--stop-on-item-failure', '--output', '/tmp/frameferry-stop-on-item-failure-test'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not valid for status/);
});

test('CLI parser treats --stop-on-item-failure as boolean (no value required)', () => {
  const result = spawnSync(process.execPath, [bin, 'archive', 'example', '--stop-on-item-failure', '--max-acquire-items', '1', '--output', '/tmp/frameferry-stop-on-item-failure-test'], { encoding: 'utf8', timeout: 5000 });
  assert.ok(!/requires a value/.test(result.stderr || ''));
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
