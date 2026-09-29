#!/usr/bin/env node
// scripts/pin-deps.mjs — issue #620 PR-A (D4). Run by publish.yml, after `check-versions.mjs
// --tag` on a tag push (which has already required a final shared version); on a manual dispatch
// dry run, the tree may be at a development version, so this script does not itself require one.
//
// Pins every internal dependency of every published member to exactly the shared version, in
// `dependencies`, `optionalDependencies` and `peerDependencies`. The source tree keeps `"*"`
// (checkRelease's job is to enforce that); this is the only place a realm package is required at
// a range other than exactly its sibling's version — no published tarball ever carries a caret or
// tilde on another realm package.
//
// Usage: node scripts/pin-deps.mjs [--root <dir>]

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readWorkspaceNames,
  readReleaseSet,
  publishedSet,
  internalDeps,
} from './lib/release-set.mjs';

const die = (msg) => {
  console.error(`Error: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const root =
  rootIdx !== -1 ? args[rootIdx + 1] : join(dirname(fileURLToPath(import.meta.url)), '..');

const workspaceNames = new Set(readWorkspaceNames(root));
const set = readReleaseSet(root);
const published = publishedSet(set);
const setByName = new Map(set.map((m) => [m.name, m]));

// ── check everything first; write nothing if any check fails ─────────────────────────────────
const versions = [...new Set(set.map((m) => m.version))];
if (versions.length !== 1) {
  die(
    `the packages do not share one version (${set.map((m) => `${m.dir}=${m.version}`).join(', ')}) — make them equal.`,
  );
}
const [V] = versions;

for (const m of published) {
  for (const dep of internalDeps(m.pkg, workspaceNames)) {
    const depMember = setByName.get(dep.name);
    if (!depMember) {
      die(
        `${m.name} depends on ${dep.name}, a workspace package outside the release set (it has no exports or main) — give it an entry or remove the dependency.`,
      );
    }
    if (depMember.private) {
      die(
        `${m.name} depends on ${dep.name}, which is private and never published — make ${dep.name} public or remove the dependency.`,
      );
    }
    if (dep.spec !== '*' && dep.spec !== V) {
      die(
        `${m.name} depends on ${dep.name} at ${dep.spec} — write "*" in the source; pin-deps sets the exact version when publishing.`,
      );
    }
  }
}

// ── write: pin every internal spec to exactly V ───────────────────────────────────────────────
for (const m of published) {
  const deps = internalDeps(m.pkg, workspaceNames);
  if (deps.length === 0) continue;
  for (const dep of deps) m.pkg[dep.field][dep.name] = V;
  writeFileSync(join(root, m.dir, 'package.json'), JSON.stringify(m.pkg, null, 2) + '\n');
  const n = deps.length;
  console.log(`${m.name}: pinned ${n} internal dependenc${n === 1 ? 'y' : 'ies'} to exactly ${V}`);
}
