#!/usr/bin/env node
// scripts/check-versions.mjs — issue #620 PR-A (D3). The command line for `checkRelease`
// (scripts/lib/check-release.mjs): one version names one artifact, and `publish.yml` publishes
// exactly the release set, dependencies first. Run on every PR (ci.yml, no flag) and against the
// tagged tree in publish.yml (`--tag "$GITHUB_REF_NAME"`).
//
// Usage: node scripts/check-versions.mjs [--root <dir>] [--tag <ref>]

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './lib/check-release.mjs';
import { readReleaseSet, publishedSet } from './lib/release-set.mjs';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root =
  rootIdx !== -1 ? args[rootIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');
const tagIdx = args.indexOf('--tag');
const tag = tagIdx !== -1 ? args[tagIdx + 1] : undefined;

const errors = checkRelease(root, { tag });
if (errors.length > 0) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}

const set = readReleaseSet(root);
const published = publishedSet(set);
const [version] = [...new Set(set.map((m) => m.version))];
let line = `✓ ${published.length} packages at ${version}; publish.yml publishes them all, dependencies first`;
if (tag !== undefined) line += `; tag ${tag} names that version`;
console.log(line);
