#!/usr/bin/env node
// scripts/release.mjs — Coordinated npm release script for the Realm monorepo.
// Bumps all four packages to the same version, pins inter-package deps,
// publishes to npm in dependency order, then restores workspace "*" ranges.
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

// Internal deps each package declares (only deps entries, not devDependencies)
const INTERNAL_DEPS = {
  'packages/mcp-server': ['@sensigo/realm'],
  'packages/testing': ['@sensigo/realm'],
  'packages/cli': ['@sensigo/realm', '@sensigo/realm-mcp', '@sensigo/realm-testing'],
};

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

// ─── Step 4: Pin inter-package dependency ranges ─────────────────────────────
// Snapshot originals first so step 7 restores exactly what was there,
// regardless of what the original values were.

const originalDepRanges = {};
for (const [dir, internalDeps] of Object.entries(INTERNAL_DEPS)) {
  originalDepRanges[dir] = {};
  const { pkg } = readPkg(dir);
  for (const depName of internalDeps) {
    originalDepRanges[dir][depName] = pkg.dependencies?.[depName];
  }
}

console.log('Pinning inter-package dependency ranges...');
for (const [dir, internalDeps] of Object.entries(INTERNAL_DEPS)) {
  const { path, pkg } = readPkg(dir);
  for (const depName of internalDeps) {
    if (pkg.dependencies !== undefined && pkg.dependencies[depName] !== undefined) {
      pkg.dependencies[depName] = `^${version}`;
    }
  }
  writePkg(path, pkg);
  console.log(`  ${dir}/package.json — pinned: ${internalDeps.join(', ')}`);
}

// ─── Step 5: Build ───────────────────────────────────────────────────────────

console.log('Building...');
execSync('npm run build', { stdio: 'inherit', cwd: ROOT });

// ─── Step 6: Publish in dependency order ─────────────────────────────────────

console.log('Publishing packages...');
for (const { dir, name } of PACKAGES) {
  console.log(`  Publishing ${name}...`);
  try {
    execSync('npm publish --access public', {
      stdio: 'inherit',
      cwd: join(ROOT, dir),
    });
  } catch (err) {
    console.error(`Error: Failed to publish ${name}.`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// ─── Step 7: Restore original dep ranges from snapshot ───────────────────────

console.log('Restoring workspace dependency ranges...');
for (const [dir, internalDeps] of Object.entries(INTERNAL_DEPS)) {
  const { path, pkg } = readPkg(dir);
  for (const depName of internalDeps) {
    const original = originalDepRanges[dir][depName];
    if (original !== undefined && pkg.dependencies !== undefined) {
      pkg.dependencies[depName] = original;
    }
  }
  writePkg(path, pkg);
  console.log(`  ${dir}/package.json — restored: ${internalDeps.join(', ')}`);
}

// ─── Step 8: Git tag ─────────────────────────────────────────────────────────

console.log('Creating git commit and tag...');
execSync(
  'git add packages/*/package.json packages/*/src/index.ts packages/mcp-server/src/server.ts',
  { stdio: 'inherit', cwd: ROOT },
);
execSync(`git commit -m "chore: release v${version}"`, { stdio: 'inherit', cwd: ROOT });
execSync(`git tag v${version}`, { stdio: 'inherit', cwd: ROOT });

console.log(`\nReleased v${version}. Push with: git push && git push --tags`);
