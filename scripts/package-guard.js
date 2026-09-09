#!/usr/bin/env node
'use strict';

// Package content guard: validates npm pack --dry-run output against an
// allowlist of expected paths and rejects files that should never ship.
// This is supplemental validation, not a perfect secret scanner.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const ALLOWED_PREFIXES = [
  'package.json',
  'README.md',
  'LICENSE',
  'SKILL.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'bin/',
  'src/',
  'scripts/',
  'test/',
  'references/',
];

const BLOCKED_PATTERNS = [
  /\.env$/i,
  /credentials/i,
  /\.tar\.gz$/,
  /\.tgz$/,
  /\.zip$/,
  /\.7z$/,
  /\.rar$/,
  /\.part$/,
  /\.sqlite/i,
  /receipt/i,
  /manifest\.json$/,
  /status\.json$/,
  /owner\.json$/,
  /\.lock$/,
  /discovery\.jsonl$/,
  /node_modules\//,
  /\.frameferry\//,
  /\.openclaw\//,
  /\.claude\//,
  /media\//,
  /state\//,
  /auth/i,
  /secret/i,
  /token/i,
  /\.pem$/,
  /\.key$/,
  /\.cert$/,
  /canary/i,
  /backfill/i,
];

const BLOCKED_CONTENT_PATTERNS = [
  /\/home\/saju/,
  /syrn/,
  /missbusty/i,
];

function run() {
  let output;
  try {
    output = execFileSync(process.execPath, [
      path.join(path.dirname(process.execPath), 'npm'),
      'pack', '--dry-run', '--json',
    ], { encoding: 'utf8', timeout: 30000, cwd: process.cwd() });
  } catch (err) {
    // npm pack --dry-run --json writes to stdout even on some error paths;
    // also the npm binary path might differ
    try {
      output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
        encoding: 'utf8', timeout: 30000, cwd: process.cwd(),
      });
    } catch (err2) {
      console.error('package-guard: failed to run npm pack --dry-run --json');
      console.error(err2.message);
      process.exit(1);
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    console.error('package-guard: npm pack output is not valid JSON');
    console.error(output.slice(0, 500));
    process.exit(1);
  }

  const files = (Array.isArray(parsed) ? parsed[0] : parsed).files || [];
  if (!files.length) {
    console.error('package-guard: npm pack reported zero files');
    process.exit(1);
  }

  const errors = [];

  for (const entry of files) {
    const filePath = entry.path;

    const allowed = ALLOWED_PREFIXES.some(prefix =>
      filePath === prefix || filePath.startsWith(prefix)
    );
    if (!allowed) {
      errors.push(`UNEXPECTED: ${filePath} (not in allowlist)`);
    }

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(filePath)) {
        errors.push(`BLOCKED: ${filePath} matches ${pattern}`);
      }
    }

    for (const pattern of BLOCKED_CONTENT_PATTERNS) {
      if (pattern.test(filePath)) {
        errors.push(`PRIVATE: ${filePath} matches content pattern ${pattern}`);
      }
    }
  }

  console.log(`package-guard: ${files.length} files in pack output`);
  for (const f of files) {
    console.log(`  ${f.path} (${f.size} bytes)`);
  }

  if (errors.length) {
    console.error('');
    console.error('package-guard FAILED:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log('package-guard: all files pass allowlist and blocklist checks');
}

run();
