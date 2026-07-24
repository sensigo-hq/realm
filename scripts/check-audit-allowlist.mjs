#!/usr/bin/env node
// issue #238 PR1 (D6), extended by PR2 (D3) — the allowlist GHSA-id guard.
//
// audit-ci.jsonc (tier-1, PR-blocking) and audit-ci.tier2.jsonc (tier-2, weekly scheduled) are
// the single sources of truth for every accepted advisory suppression. Their `allowlist` entries
// have two legal shapes (per audit-ci's own AllowlistObject type): a bare STRING (suppresses ALL
// advisories for a package/module — the module-allowlist hazard) or an object with exactly one
// key (an advisory id scoped to a single GHSA). This script asserts EVERY entry in BOTH configs —
// whichever shape — resolves to a GHSA id, so a future edit can never silently widen either gate
// into a package-wide bypass.
//
// PR2 (R12, single-source allowlist): tier-2 is the BROADER audit (moderate+, incl. dev), so
// anything tier-1 (the strict, prod+high gate) suppresses as not_affected must ALSO be suppressed
// at tier-2 — otherwise the weekly scheduled run would file a tracking issue for an advisory
// already adjudicated. This script therefore also asserts tier-1 ⊆ tier-2 (tier-2 may carry
// additional entries tier-1 lacks; tier-1 may not carry any tier-2 lacks). A missing tier-2 config
// file is a fail-closed THROW, never a silent pass — the two allowlists must never drift apart,
// and an absent tier-2 config makes that guarantee unverifiable.
//
// The config files use `//` line comments (JSONC) AND — since they're formatted by this repo's
// own `prettier --write .` (wired into `npm run format`/`format:check`) — trailing commas on their
// multi-line objects/arrays. A bare `JSON.parse` throws on BOTH; `strip-json-comments` alone only
// strips comments and still throws on the trailing commas prettier adds. `json5` parses both
// constructs natively (a strict superset of JSON), so this script parses with it, never with
// `JSON.parse` directly.

import { readFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import JSON5 from 'json5';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TIER1_CONFIG_PATH = join(ROOT, 'audit-ci.jsonc');
const TIER2_CONFIG_PATH = join(ROOT, 'audit-ci.tier2.jsonc');

const GHSA_PATTERN = /^GHSA-/;

/**
 * Reads and JSON5-parses one audit-ci config's `allowlist` array. Deliberately does NOT catch a
 * missing-file error here — an absent config (tier-1 OR tier-2) must fail this script loudly
 * (fail-closed), never silently return an empty allowlist.
 */
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

/**
 * Validates one config's allowlist — every entry GHSA-id-scoped. Returns the set of valid GHSA
 * ids found (for the cross-config subset check) and whether validation failed.
 */
function validateAllowlist(configPath) {
  const label = basename(configPath);
  const allowlist = loadAllowlist(configPath);
  let failed = false;
  const validIds = new Set();

  if (allowlist.length === 0) {
    console.log(`✓ ${label} allowlist guard: allowlist is empty — nothing to check.`);
    return { failed, validIds };
  }

  for (let i = 0; i < allowlist.length; i++) {
    const entry = allowlist[i];
    let ids;
    try {
      ids = extractIds(entry, i);
    } catch (err) {
      console.error(`✗ ${label}: ${err.message}`);
      failed = true;
      continue;
    }
    for (const id of ids) {
      if (!GHSA_PATTERN.test(id)) {
        console.error(
          `✗ ${label}: allowlist[${i}]: '${id}' is not a GHSA id (must match /^GHSA-/). A ` +
            `non-GHSA-scoped entry — especially a bare string — suppresses ALL advisories for ` +
            `that package, which defeats the audit gate. Replace it with a GHSA-id-keyed object entry.`,
        );
        failed = true;
      } else {
        console.log(`✓ ${label}: allowlist[${i}]: '${id}' is a valid GHSA-scoped entry.`);
        validIds.add(id);
      }
    }
  }

  return { failed, validIds };
}

function main() {
  let failed = false;

  const tier1 = validateAllowlist(TIER1_CONFIG_PATH);
  failed = failed || tier1.failed;

  const tier2 = validateAllowlist(TIER2_CONFIG_PATH);
  failed = failed || tier2.failed;

  // R12: single-source allowlist — tier-1 ⊆ tier-2. Every id tier-1 (the strict gate) suppresses
  // must also be suppressed at tier-2 (the broad gate), or the weekly scheduled run would file a
  // tracking issue for an advisory already adjudicated not_affected. Tier-2 may carry additional
  // entries tier-1 lacks (a moderate-only finding tier-1 never even sees); tier-1 may not carry
  // any id tier-2 lacks. Only checked when both configs individually passed their own GHSA-id
  // validation — a malformed entry has no well-defined id to check membership for.
  if (!tier1.failed && !tier2.failed) {
    const missingFromTier2 = [...tier1.validIds].filter((id) => !tier2.validIds.has(id));
    if (missingFromTier2.length > 0) {
      for (const id of missingFromTier2) {
        console.error(
          `✗ tier-1 ⊆ tier-2 violation: '${id}' is allowlisted in audit-ci.jsonc (tier-1) but ` +
            `MISSING from audit-ci.tier2.jsonc (tier-2). Add the identical GHSA-id-keyed entry ` +
            `(same notes + expiry) to audit-ci.tier2.jsonc, or the weekly scheduled audit will file ` +
            `a tracking issue for an advisory already adjudicated not_affected at tier-1.`,
        );
      }
      failed = true;
    } else {
      console.log('✓ tier-1 ⊆ tier-2: every tier-1 allowlist entry is also present in tier-2.');
    }
  }

  if (failed) {
    console.error('\naudit allowlist guard FAILED — see errors above.');
    process.exit(1);
  }

  console.log('\naudit allowlist guard passed — every entry is GHSA-scoped, tier-1 ⊆ tier-2.');
}

main();
