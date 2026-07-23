#!/usr/bin/env node
// scripts/release.mjs — Coordinated release script for the Realm monorepo.
// Bumps all four packages to the same version, builds, and creates the release
// git commit and tag. Publishing to npm is handled by .github/workflows/publish.yml
// which is triggered when the tag is pushed after the release PR is merged.
//
// Usage: npm run release -- --version 0.1.0

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Packages in dependency order (core first, cli last)
const PACKAGES = [
  { dir: 'packages/core', name: '@sensigo/realm' },
  { dir: 'packages/mcp-server', name: '@sensigo/realm-mcp' },
  { dir: 'packages/testing', name: '@sensigo/realm-testing' },
  { dir: 'packages/cli', name: '@sensigo/realm-cli' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read and parse a package.json. */
function readPkg(relPath) {
  const full = join(ROOT, relPath, 'package.json');
  return { path: full, pkg: JSON.parse(readFileSync(full, 'utf-8')) };
}

/** Write a package.json object back to disk. */
function writePkg(fullPath, pkg) {
  writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

// ─── Step 1: Parse and validate --version ────────────────────────────────────

const args = process.argv.slice(2);
const versionIdx = args.indexOf('--version');

if (versionIdx === -1 || args[versionIdx + 1] === undefined) {
  console.error('Error: --version <semver> is required.');
  console.error('Usage: npm run release -- --version 0.1.0');
  process.exit(1);
}

const version = args[versionIdx + 1];
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/;

if (!SEMVER_RE.test(version)) {
  console.error(`Error: "${version}" is not a valid semver string.`);
  console.error('Expected format: MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-prerelease');
  process.exit(1);
}

console.log(`Releasing v${version}...`);

// ─── Step 2: Check working tree is clean ─────────────────────────────────────

const gitStatus = execSync('git status --porcelain', { encoding: 'utf-8' });
if (gitStatus.trim().length > 0) {
  console.error('Error: Working tree is dirty. Commit or stash changes before releasing.');
  process.exit(1);
}

// ─── Step 3: Bump versions in all four package.json files ────────────────────

console.log('Bumping package versions...');
for (const { dir } of PACKAGES) {
  const { path, pkg } = readPkg(dir);
  pkg.version = version;
  writePkg(path, pkg);
  console.log(`  ${dir}/package.json → ${version}`);
}

// ─── Step 3a: Bump version strings in source files ──────────────────────────
// Keep these in sync with the 5 locations checked by scripts/check-versions.mjs.

console.log('Bumping version strings in source files...');
const SOURCE_VERSIONS = [
  {
    file: 'packages/core/src/index.ts',
    pattern: /export const VERSION = '[^']+'/,
    replacement: `export const VERSION = '${version}'`,
  },
  {
    file: 'packages/mcp-server/src/index.ts',
    pattern: /export const VERSION = '[^']+'/,
    replacement: `export const VERSION = '${version}'`,
  },
  {
    file: 'packages/testing/src/index.ts',
    pattern: /export const VERSION = '[^']+'/,
    replacement: `export const VERSION = '${version}'`,
  },
  {
    file: 'packages/mcp-server/src/server.ts',
    pattern: /version: '[^']+'/,
    replacement: `version: '${version}'`,
  },
  {
    file: 'packages/cli/src/index.ts',
    pattern: /\.version\('[^']+'\)/,
    replacement: `.version('${version}')`,
  },
];

for (const { file, pattern, replacement } of SOURCE_VERSIONS) {
  const fullPath = join(ROOT, file);
  const original = readFileSync(fullPath, 'utf-8');
  if (!pattern.test(original)) {
    console.error(`Error: Version pattern not found in ${file}. Cannot update version.`);
    process.exit(1);
  }
  const updated = original.replace(pattern, replacement);
  writeFileSync(fullPath, updated, 'utf-8');
  console.log(`  ${file} → ${version}`);
}

// ─── Step 3b: Sync package-lock.json self-versions ──────────────────────────
// The four workspace self-version entries in package-lock.json must match the
// just-bumped package.json versions, or the committed lockfile drifts — a stale
// self-version that the next `npm install` reconciles as a noisy, unrelated diff.
// `--package-lock-only` rewrites the lockfile from package.json without touching
// node_modules; on an otherwise-in-sync tree the only change is the four self-versions.
console.log('Syncing package-lock.json...');
execSync('npm install --package-lock-only', { stdio: 'inherit', cwd: ROOT });

// ─── Step 4: Build ───────────────────────────────────────────────────────────

console.log('Building...');
execSync('npm run build', { stdio: 'inherit', cwd: ROOT });

// ─── Step 5: Git tag ─────────────────────────────────────────────────────────

console.log('Creating git commit and tag...');
execSync(
  'git add package-lock.json packages/*/package.json packages/*/src/index.ts packages/mcp-server/src/server.ts',
  { stdio: 'inherit', cwd: ROOT },
);
execSync(`git commit -m "chore: release v${version}"`, { stdio: 'inherit', cwd: ROOT });
execSync(`git tag v${version}`, { stdio: 'inherit', cwd: ROOT });

console.log(`\nRelease commit and tag v${version} created.`);
console.log('Next steps:');
console.log('  1. Push branch:  git push -u origin HEAD');
console.log('  2. Open and merge the release PR (merge commit, not squash)');
console.log('  3. Push the tag: git switch main && git pull && git push --tags');
console.log('     The tag push triggers GitHub Actions to publish to npm.');
