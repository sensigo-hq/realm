// Source-text guards for the fs absence/unreachability contract (issue #183).
//
// Two independent anti-recurrence checks, both source-text (not type-reflection) — same
// discipline as purge-guard.test.ts's #107 declarer-enumeration guard:
//
//  1. No raw `unlink(` call may appear in store code outside the fs-io.ts primitive itself and
//     the one documented atomic-write.ts exemption. A future edit that reaches for
//     `unlink(...).catch(() => {})` instead of `deleteIfExists` silently reintroduces exactly the
//     bug #183 fixes — this test fails loudly on that drift instead.
//  2. Every store class WIRED into purge.ts's PerRunArtifactStore orchestrator (see
//     purge-guard.test.ts's WIRED_ORDER) must have a TCK-invoking contract test somewhere in the
//     repo — a store that adds `deleteAllForRun` and is wired into purge.ts but never actually
//     run through `perRunArtifactStoreContract` would silently ship unverified against the L1-L4
//     laws.
//
// A THIRD guard was considered and DEFERRED (issue #184's own STOP/report escape hatch): a
// source-text check asserting `JsonFileStore.deleteAllForRun` never acquires a key lock BEFORE
// (or without) its run-file lock — the GLOBAL LOCK ORDER invariant declared on `JsonFileStore`'s
// class docstring (run-file lock, then key lock nested inside it; never the reverse; see also the
// `save()`/`registerImportedKey()` SEQUENTIAL — not nested — precedent that invariant contrasts
// with). No robust source-text matcher was found: a same-file, line-number-order check (does
// `lockfile.lock(path` appear before `lockfile.lock(keyPath` textually) would (a) false-positive
// on a compliant reorder that happens to mention `keyPath` earlier in an unrelated comment or
// string, and (b) false-NEGATIVE on a rewrite that preserves textual order while no longer
// actually nesting the two locks (e.g. two SEQUENTIAL lock/release pairs in the same relative
// order, which look identical to this regex but do not share the ordering guarantee the real
// invariant requires) — giving false confidence in exactly the shape of regression this guard
// would exist to catch. A true structural (AST-scope) check is disproportionate for one method's
// one invariant and inconsistent with this repo's established source-text-guard convention. The
// invariant is therefore declared-only (the class docstring + this comment), not guarded — flagged
// here per issue #184's explicit instruction to defer rather than ship a flaky regex.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/cli/src/commands → packages/
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every non-test, non-declaration .ts file directly under (and recursively within) `root`. */
function walkTsSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

/** Every `.test.ts` file recursively within `root`. */
function walkTestFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.test.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

// -----------------------------------------------------------------------------------------------
// Guard 1: no raw `unlink(` in store code, outside the allow-list
// -----------------------------------------------------------------------------------------------

/** Files exempt from the raw-unlink ban, with why (issue #183). */
const ALLOW_LISTED_FILES: Record<string, string> = {
  'core/src/store/fs-io.ts':
    'the primitive itself — deleteIfExists wraps the one legitimate raw unlink call.',
  'core/src/store/atomic-write.ts':
    "best-effort cleanup of the WRITER'S OWN temp file on a failed atomic write — converting " +
    'it would let a failed temp-cleanup mask the real write error (see its own inline comment).',
};

/** Store-code scan roots (relative to PACKAGES_DIR): every file under core's store/ directory,
 *  plus json-trace-buffer-store.ts specifically (it lives in mcp-server/src/, not under a
 *  store/ subdirectory, but owns on-disk WAL artifacts exactly like the other two stores). */
function storeCodeFiles(): string[] {
  const coreStoreFiles = walkTsSourceFiles(join(PACKAGES_DIR, 'core', 'src', 'store'));
  const traceBufferStoreFile = join(
    PACKAGES_DIR,
    'mcp-server',
    'src',
    'json-trace-buffer-store.ts',
  );
  return [...coreStoreFiles, traceBufferStoreFile];
}

function relativeToPackages(file: string): string {
  return file.slice(PACKAGES_DIR.length + 1);
}

/** A conservative per-line match: `unlink` (word-boundary) followed by `(`, ignoring pure comment
 *  lines (`//` or `*` after trimming — covers both line comments and JSDoc continuation lines).
 *  Deliberately does NOT try to strip trailing inline comments — a false positive there would
 *  just mean examining one extra line by hand, which is cheap; a false NEGATIVE (missing a real
 *  call) is what this guard exists to prevent. */
const RAW_UNLINK_CALL = /\bunlink\s*\(/;

function findRawUnlinkCalls(file: string): number[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if (RAW_UNLINK_CALL.test(trimmed)) hits.push(i + 1);
  });
  return hits;
}

describe('store-fs-guard — no raw unlink outside fs-io.ts / the atomic-write.ts exemption (issue #183)', () => {
  it('at least one store-code file is scanned (the scan is wired correctly)', () => {
    expect(storeCodeFiles().length).toBeGreaterThan(0);
  });

  it('every ALLOW_LISTED_FILES entry still exists (no stale exemption)', () => {
    for (const rel of Object.keys(ALLOW_LISTED_FILES)) {
      const full = join(PACKAGES_DIR, rel);
      expect(statSync(full).isFile(), `allow-listed file no longer exists: ${rel}`).toBe(true);
    }
  });

  it('no raw unlink( call appears in store code outside the allow-list', () => {
    const violations: string[] = [];
    for (const file of storeCodeFiles()) {
      const rel = relativeToPackages(file);
      if (rel in ALLOW_LISTED_FILES) continue;
      const hits = findRawUnlinkCalls(file);
      for (const line of hits) violations.push(`${rel}:${line}`);
    }
    expect(
      violations,
      `Raw unlink() call(s) found outside the fs-io.ts/atomic-write.ts allow-list: ` +
        `${violations.join(', ')}. Use deleteIfExists from './fs-io.js' instead (issue #183) — ` +
        `or, if this really is a new legitimate exemption, add it to ALLOW_LISTED_FILES with a reason.`,
    ).toEqual([]);
  });

  it('the allow-listed files THEMSELVES still contain their expected raw unlink (sanity — proves the matcher is not just vacuously passing)', () => {
    for (const rel of Object.keys(ALLOW_LISTED_FILES)) {
      const full = join(PACKAGES_DIR, rel);
      const hits = findRawUnlinkCalls(full);
      expect(
        hits.length,
        `expected at least one raw unlink( in allow-listed ${rel}`,
      ).toBeGreaterThan(0);
    }
  });
});

// -----------------------------------------------------------------------------------------------
// Guard 2: every WIRED PerRunArtifactStore has a TCK-invoking contract test
// -----------------------------------------------------------------------------------------------

// Mirrors purge-guard.test.ts's WIRED_ORDER exactly (kept as an independent literal here rather
// than imported — these are two intentionally separate guard files, per issue #183's own
// instruction to add this as a new file; duplicating three class-name literals is cheaper than
// coupling the two guards' internals together).
const WIRED_STORES = ['JsonTraceBufferStore', 'FailedAttemptStore', 'JsonFileStore'];

/** Every `.test.ts` file anywhere in the repo that calls `perRunArtifactStoreContract(`,
 *  cross-referenced against which WIRED store class name(s) it also imports/references — a
 *  same-file co-occurrence proxy for "this store was actually run through the TCK" (source-text,
 *  not type-reflection, matching this repo's established anti-recurrence convention). */
function tckCoveredStores(): Set<string> {
  const covered = new Set<string>();
  const packages = ['core', 'cli', 'mcp-server', 'testing'];
  for (const pkg of packages) {
    const root = join(PACKAGES_DIR, pkg, 'src');
    for (const file of walkTestFiles(root)) {
      const src = readFileSync(file, 'utf8');
      if (!src.includes('perRunArtifactStoreContract(')) continue;
      for (const storeName of WIRED_STORES) {
        if (src.includes(storeName)) covered.add(storeName);
      }
    }
  }
  return covered;
}

describe('store-fs-guard — every WIRED PerRunArtifactStore has a TCK-invoking contract test (issue #183)', () => {
  it('at least one contract test file invokes perRunArtifactStoreContract (the scan is wired correctly)', () => {
    expect(tckCoveredStores().size).toBeGreaterThan(0);
  });

  it('EVERY store in WIRED_STORES is covered by a TCK-invoking test file', () => {
    const covered = tckCoveredStores();
    const uncovered = WIRED_STORES.filter((name) => !covered.has(name));
    expect(
      uncovered,
      `${uncovered.join(', ')} ${uncovered.length === 1 ? 'is' : 'are'} WIRED into purge.ts's ` +
        `orchestrator but no test file both imports it and calls perRunArtifactStoreContract(...) ` +
        `— add a *.contract.test.ts wiring it into the TCK (see json-file-store.contract.test.ts ` +
        `under packages/cli/src/store-contracts/ for the pattern).`,
    ).toEqual([]);
  });
});
