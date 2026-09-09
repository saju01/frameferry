#!/usr/bin/env node
'use strict';

// Package content guard: validates npm pack --dry-run output against an
// allowlist of expected paths and rejects files that should never ship.
// This is supplemental validation, not a perfect secret scanner.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Exact root filenames — matched by strict equality only, not startsWith.
const ALLOWED_EXACT_ROOTS = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'SKILL.md',
  'SECURITY.md',
  'CHANGELOG.md',
]);

// Directory prefixes — entries must end with '/' and are matched with startsWith.
const ALLOWED_DIR_PREFIXES = [
  'bin/',
  'src/',
  'scripts/',
  'test/',
  'references/',
];

// Forbidden file extensions (credentials, crypto material, archives, databases, locks)
const BLOCKED_EXTENSIONS = [
  /\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.cert$/i,
  /\.sqlite\d*$/i,
  /\.tar\.gz$/i,
  /\.tgz$/i,
  /\.zip$/i,
  /\.7z$/i,
  /\.rar$/i,
  /\.part$/i,
  /\.lock$/i,
];

// Forbidden exact basenames (matched against the last path segment)
const BLOCKED_BASENAMES = [
  /^credentials?\.[a-z]+$/i,
  /^secrets?\.[a-z]+$/i,
  /^receipt\.[a-z]+$/i,
  /^manifest\.json$/i,
  /^status\.json$/i,
  /^owner\.json$/i,
  /^discovery\.jsonl$/i,
];

// Forbidden directory components (exact path segment names, not substrings)
// Matched against each /-delimited segment of the entry path.
const BLOCKED_DIR_COMPONENTS = new Set([
  'node_modules',
  '.frameferry',
  '.openclaw',
  '.claude',
  'state',
  'media',
]);

function blockedReason(filePath) {
  for (const re of BLOCKED_EXTENSIONS) {
    if (re.test(filePath)) return `extension matches ${re}`;
  }

  const basename = filePath.split('/').pop();
  for (const re of BLOCKED_BASENAMES) {
    if (re.test(basename)) return `basename matches ${re}`;
  }

  const segments = filePath.split('/');
  // Check all segments except the last one (that's the basename, handled above)
  for (let i = 0; i < segments.length - 1; i++) {
    if (BLOCKED_DIR_COMPONENTS.has(segments[i])) {
      return `directory component '${segments[i]}' is forbidden`;
    }
  }

  return null;
}

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

  const pkg = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!pkg || typeof pkg !== 'object' || !Array.isArray(pkg.files)) {
    console.error('package-guard: npm pack JSON is missing a files array');
    process.exit(1);
  }

  const files = pkg.files;
  if (!files.length) {
    console.error('package-guard: npm pack reported zero files');
    process.exit(1);
  }

  const errors = [];

  for (const entry of files) {
    if (typeof entry !== 'object' || entry === null || typeof entry.path !== 'string' || !entry.path) {
      errors.push('MALFORMED: pack entry is missing a valid path string');
      continue;
    }
    const filePath = entry.path;

    const allowed = ALLOWED_EXACT_ROOTS.has(filePath) ||
      ALLOWED_DIR_PREFIXES.some(prefix => filePath.startsWith(prefix));
    if (!allowed) {
      errors.push(`UNEXPECTED: ${filePath} (not in allowlist)`);
    }

    const reason = blockedReason(filePath);
    if (reason) {
      errors.push(`BLOCKED: ${filePath} — ${reason}`);
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
