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
const path = require('node:path');

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
child.stdout.on('data', chunk => { tapOutput += chunk.toString(); });

child.on('close', (code, signal) => {
  const lines = tapOutput.split('\n');

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let todo = 0;
  let cancelled = 0;
  let total = 0;
  let sawPlan = false;
  let planCount = 0;

  for (const line of lines) {
    const planMatch = line.match(/^1\.\.(\d+)$/);
    if (planMatch) {
      sawPlan = true;
      planCount = parseInt(planMatch[1], 10);
      continue;
    }
    if (line.startsWith('ok ')) {
      total++;
      if (/# SKIP/i.test(line)) { skipped++; }
      else if (/# TODO/i.test(line)) { todo++; }
      else { passed++; }
    } else if (line.startsWith('not ok ')) {
      total++;
      failed++;
    }
  }

  const errors = [];

  if (signal) errors.push(`process killed by signal ${signal}`);
  if (code !== 0 && code !== null) errors.push(`process exited with code ${code}`);
  if (!sawPlan) errors.push('no TAP plan line found (missing or malformed output)');
  if (total === 0) errors.push('no test results found');
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
