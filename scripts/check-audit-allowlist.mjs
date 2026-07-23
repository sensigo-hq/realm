#!/usr/bin/env node
// issue #238 PR1, D6 — the allowlist GHSA-id guard.
//
// audit-ci.jsonc's `allowlist` is the single source of truth for every accepted advisory
// suppression in the release-audit gate. Its entries have two legal shapes (per audit-ci's own
// AllowlistObject type): a bare STRING (suppresses ALL advisories for a package/module — the
// module-allowlist hazard) or an object with exactly one key (an advisory id scoped to a single
// GHSA). This script asserts EVERY entry — whichever shape — resolves to a GHSA id, so a future
// edit can never silently widen the gate into a package-wide bypass.
//
// The config file uses `//` line comments (JSONC) AND — since it's formatted by this repo's own
// `prettier --write .` (wired into `npm run format`/`format:check`) — trailing commas on its
// multi-line objects/arrays. A bare `JSON.parse` throws on BOTH; `strip-json-comments` alone only
// strips comments and still throws on the trailing commas prettier adds. `json5` parses both
// constructs natively (a strict superset of JSON), so this script parses with it, never with
// `JSON.parse` directly.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import JSON5 from 'json5';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONFIG_PATH = join(ROOT, 'audit-ci.jsonc');

const GHSA_PATTERN = /^GHSA-/;

function loadAllowlist(configPath) {
  const raw = readFileSync(configPath, 'utf-8');
  const config = JSON5.parse(raw);
  return Array.isArray(config.allowlist) ? config.allowlist : [];
}

/**
 * Returns the id string(s) an allowlist entry actually suppresses, or throws a descriptive error
 * if the entry's shape is not one of audit-ci's two legal forms.
 */
function extractIds(entry, index) {
  if (typeof entry === 'string') {
    // A bare-string entry suppresses ALL advisories for the named package — the module-allowlist
    // hazard. It is only acceptable here if the "package name" is itself spelled as a GHSA id
    // (which would be nonsensical) — in practice this branch exists to REJECT bare-string entries
    // outright, since no legitimate GHSA-scoped suppression is ever expressed as a bare string.
    return [entry];
  }
  if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
    const keys = Object.keys(entry);
    if (keys.length !== 1) {
      throw new Error(
        `allowlist[${index}]: object entries must have exactly one key (the GHSA id) — found ${keys.length}: ${JSON.stringify(keys)}`,
      );
    }
    return keys;
  }
  throw new Error(
    `allowlist[${index}]: unrecognized entry shape (expected a string or a single-key object): ${JSON.stringify(entry)}`,
  );
}

function main() {
  const allowlist = loadAllowlist(CONFIG_PATH);
  let failed = false;

  if (allowlist.length === 0) {
    console.log('✓ audit-ci.jsonc allowlist guard: allowlist is empty — nothing to check.');
    return;
  }

  for (let i = 0; i < allowlist.length; i++) {
    const entry = allowlist[i];
    let ids;
    try {
      ids = extractIds(entry, i);
    } catch (err) {
      console.error(`✗ ${err.message}`);
      failed = true;
      continue;
    }
    for (const id of ids) {
      if (!GHSA_PATTERN.test(id)) {
        console.error(
          `✗ allowlist[${i}]: '${id}' is not a GHSA id (must match /^GHSA-/). A non-GHSA-scoped ` +
            `entry — especially a bare string — suppresses ALL advisories for that package, which ` +
            `defeats the audit gate. Replace it with a GHSA-id-keyed object entry.`,
        );
        failed = true;
      } else {
        console.log(`✓ allowlist[${i}]: '${id}' is a valid GHSA-scoped entry.`);
      }
    }
  }

  if (failed) {
    console.error('\naudit-ci.jsonc allowlist guard FAILED — see errors above.');
    process.exit(1);
  }

  console.log('\naudit-ci.jsonc allowlist guard passed — every entry is GHSA-scoped.');
}

main();
