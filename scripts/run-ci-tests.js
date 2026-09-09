#!/usr/bin/env node
'use strict';

// Strict CI test wrapper for Node test runner.
// Runs `node --test` with --test-reporter=spec --test-reporter-destination=stderr
// and --test-reporter=tap --test-reporter-destination=stdout, then parses TAP
// for strict enforcement: any skip, todo, cancelled, failure, or empty results
// is a CI failure. Process non-zero exit is also a failure.
//
// Usage: node scripts/run-ci-tests.js [glob...]
// Default glob: test/*.test.js test/*.test.cjs

const { spawn } = require('node:child_process');

// parseTap parses TAP output and returns counts.
// Nested (indented) ok/not-ok lines are scanned for skip/todo/cancelled
// so that nested skips and todos are caught, but only top-level lines
// contribute to total/pass/fail counts and plan matching.
function parseTap(tapOutput) {
  const lines = tapOutput.split('\n');

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let todo = 0;
  let cancelled = 0;
  let total = 0;
  let sawPlan = false;
  let planCount = 0;
  let topLevelRealSubtests = 0;
  let topLevelFileSubtests = 0;
  // Per-file-wrapper state: track whether each file subtest contains any nested subtests.
  let inFileWrapper = false;
  let currentFileNestedSubtests = 0;
  let emptyFileCount = 0;

  const FILE_SUBTEST_RE = /^\/.*\.test\.[cm]?js$/;

  for (const line of lines) {
    // Top-level plan only: no leading whitespace
    const planMatch = line.match(/^1\.\.(\d+)$/);
    if (planMatch) {
      sawPlan = true;
      planCount = parseInt(planMatch[1], 10);
      continue;
    }

    const trimmed = line.trimStart();
    const isTopLevel = line.length > 0 && line === trimmed;

    // Top-level # Subtest: (no leading whitespace)
    if (isTopLevel && line.startsWith('# Subtest: ')) {
      const name = line.slice('# Subtest: '.length);
      if (FILE_SUBTEST_RE.test(name)) {
        // Starting a new file wrapper. Flush any open wrapper that never got a closing ok.
        if (inFileWrapper && currentFileNestedSubtests === 0) emptyFileCount++;
        topLevelFileSubtests++;
        inFileWrapper = true;
        currentFileNestedSubtests = 0;
      } else {
        topLevelRealSubtests++;
      }
      continue;
    }

    // Indented # Subtest: (inside a file wrapper) — counts as a real nested test
    if (!isTopLevel && trimmed.startsWith('# Subtest: ')) {
      if (inFileWrapper) currentFileNestedSubtests++;
      continue;
    }

    const isOk = trimmed.startsWith('ok ');
    const isNotOk = trimmed.startsWith('not ok ');
    if (!isOk && !isNotOk) continue;

    const hasSkip = /# SKIP/i.test(line);
    const hasTodo = /# TODO/i.test(line);
    const hasCancelled = /# (cancelled|aborted)/i.test(line);

    if (isTopLevel) {
      // Detect the closing ok/not ok line for the current file wrapper
      if (inFileWrapper) {
        const nameMatch = line.match(/^(?:ok|not ok) \d+ - (.+?)(?:\s+#.*)?$/);
        if (nameMatch && FILE_SUBTEST_RE.test(nameMatch[1])) {
          if (currentFileNestedSubtests === 0) emptyFileCount++;
          inFileWrapper = false;
        }
      }
      total++;
      if (isOk) {
        if (hasSkip) skipped++;
        else if (hasTodo) todo++;
        else passed++;
      } else {
        // not ok
        if (hasCancelled) cancelled++;
        else failed++;
      }
    } else {
      // Nested line: only track skip/todo/cancelled so they cause CI failure
      if (hasSkip) skipped++;
      else if (hasTodo) todo++;
      else if (hasCancelled) cancelled++;
    }
  }

  // Flush last file wrapper if its closing ok line was never seen
  if (inFileWrapper && currentFileNestedSubtests === 0) emptyFileCount++;

  return { passed, failed, skipped, todo, cancelled, total, topLevelRealSubtests, topLevelFileSubtests, emptyFileCount, sawPlan, planCount };
}

module.exports = { parseTap };

if (require.main !== module) return;

const globs = process.argv.slice(2);
if (!globs.length) globs.push('test/*.test.js', 'test/*.test.cjs');

const args = [
  '--test',
  '--test-reporter=tap', '--test-reporter-destination=stdout',
  '--test-reporter=spec', '--test-reporter-destination=stderr',
  ...globs,
];

const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
delete env.NODE_TEST_WORKER_ID;

const child = spawn(process.execPath, args, {
  stdio: ['ignore', 'pipe', 'inherit'],
  env,
  cwd: process.cwd(),
});

let tapOutput = '';
let spawnError = null;

child.on('error', (err) => {
  spawnError = err;
});

child.stdout.on('error', (err) => {
  process.stderr.write(`test-ci: stdout stream error: ${err.message}\n`);
  process.exit(1);
});

child.stdout.on('data', chunk => { tapOutput += chunk.toString(); });

child.on('close', (code, signal) => {
  if (spawnError) {
    process.stderr.write(`test-ci: failed to spawn test runner: ${spawnError.message}\n`);
    process.exit(1);
    return;
  }

  const { passed, failed, skipped, todo, cancelled, total, emptyFileCount, sawPlan, planCount } = parseTap(tapOutput);

  const errors = [];

  if (signal) errors.push(`process killed by signal ${signal}`);
  if (code !== 0 && code !== null) errors.push(`process exited with code ${code}`);
  if (!sawPlan) errors.push('no TAP plan line found (missing or malformed output)');
  if (total === 0) errors.push('no test results found');
  if (emptyFileCount > 0) errors.push(`${emptyFileCount} matched file(s) registered no tests`);
  if (failed > 0) errors.push(`${failed} test(s) failed`);
  if (skipped > 0) errors.push(`${skipped} test(s) skipped`);
  if (todo > 0) errors.push(`${todo} test(s) marked todo`);
  if (cancelled > 0) errors.push(`${cancelled} test(s) cancelled`);
  if (sawPlan && total !== planCount) errors.push(`plan declared ${planCount} tests but ${total} results found`);

  console.log('');
  console.log(`test-ci: ${passed} passed, ${failed} failed, ${skipped} skipped, ${todo} todo, ${total} total`);
  if (sawPlan) console.log(`test-ci: TAP plan 1..${planCount}`);

  if (errors.length) {
    console.error('');
    console.error('test-ci FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log('test-ci: all checks passed');
  process.exit(0);
});
