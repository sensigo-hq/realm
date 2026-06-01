#!/usr/bin/env node
// scripts/pin-deps.mjs — Pins inter-package "*" dep ranges to the current release
// version before npm publish. Called by .github/workflows/publish.yml in CI.
// Safe to run multiple times (idempotent: if already ^X.Y.Z, the regex still matches "*").

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Internal deps each package declares (only dependencies entries, not devDependencies)
const INTERNAL_DEPS = {
  'packages/mcp-server': ['@sensigo/realm'],
  'packages/testing': ['@sensigo/realm'],
  'packages/cli': ['@sensigo/realm', '@sensigo/realm-mcp', '@sensigo/realm-testing'],
};

/** Read and parse a package.json. */
function readPkg(relPath) {
  const full = join(ROOT, relPath, 'package.json');
  return { path: full, pkg: JSON.parse(readFileSync(full, 'utf-8')) };
}

/** Write a package.json object back to disk. */
function writePkg(fullPath, pkg) {
  writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
}

// Derive version from core — it will already be bumped by the release commit.
const { pkg: corePkg } = readPkg('packages/core');
const version = corePkg.version;

if (!version || typeof version !== 'string') {
  console.error('Error: Could not read version from packages/core/package.json');
  process.exit(1);
}

console.log(`Pinning inter-package dep ranges to ^${version}...`);

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

console.log('Done.');
