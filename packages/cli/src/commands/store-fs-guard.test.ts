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

/** This guard's OWN file — excluded from its own scan below (issue #197 PR-1, design §12: fixing
 *  the self-scan false positive that was DISCOVERED but deliberately left unfixed during issue
 *  #207, per Guard 3's own doc below). Without this, the guard trivially "covers" every store
 *  forever: this file's own doc comments and the `WIRED_STORES` array literal contain both the
 *  store class name strings AND the literal substring `perRunArtifactStoreContract(` (inside the
 *  string-literal argument to `.includes(...)` a few lines below), so scanning this file always
 *  finds a false co-occurrence regardless of whether any REAL wiring test exists — the same
 *  self-exclusion technique Guard 3 already uses for the analogous fenced-TCK scan. */
const THIS_GUARD_FILE_ISSUE_183 = fileURLToPath(import.meta.url);

/** Every `.test.ts` file anywhere in the repo (other than this guard's own file) that calls
 *  `perRunArtifactStoreContract(`, cross-referenced against which WIRED store class name(s) it
 *  also imports/references — a same-file co-occurrence proxy for "this store was actually run
 *  through the TCK" (source-text, not type-reflection, matching this repo's established
 *  anti-recurrence convention). */
function tckCoveredStores(): Set<string> {
  const covered = new Set<string>();
  const packages = ['core', 'cli', 'mcp-server', 'testing'];
  for (const pkg of packages) {
    const root = join(PACKAGES_DIR, pkg, 'src');
    for (const file of walkTestFiles(root)) {
      if (file === THIS_GUARD_FILE_ISSUE_183) continue;
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

// -----------------------------------------------------------------------------------------------
// Guard 3: every store declaring the fenced trio has a fenced-TCK-invoking contract test
// (issue #207 — same Guard-2 co-occurrence pattern, a new independent literal for the same
// duplication-over-coupling reason as WIRED_STORES above)
// -----------------------------------------------------------------------------------------------

const WIRED_FENCED_STORES = ['JsonTraceBufferStore', 'InMemoryTraceBufferStore'];

/** This guard's OWN file — excluded from its own scan below (issue #207). Without this, the
 *  guard would trivially "cover" every store forever: this file's own doc comments and the
 *  `WIRED_FENCED_STORES` array literal itself contain both the store class name strings AND the
 *  literal substring `fencedTraceBufferContract(` (inside the string-literal argument to
 *  `.includes(...)` a few lines below), so scanning this file would always find a false
 *  co-occurrence regardless of whether any REAL wiring test exists. This same self-referential gap
 *  existed, unnoticed, in Guard 2's `tckCoveredStores` above too — left unfixed at the time (out of
 *  issue #207's scope) but FIXED in issue #197 PR-1 (design §12 scheduled it with this PR; see
 *  `THIS_GUARD_FILE_ISSUE_183` above, the same technique applied there). */
const THIS_GUARD_FILE = fileURLToPath(import.meta.url);

/** Every `.test.ts` file anywhere in the repo (other than this guard's own file) that calls
 *  `fencedTraceBufferContract(`, cross-referenced against which WIRED_FENCED_STORES class
 *  name(s) it also imports/references — the same same-file co-occurrence proxy
 *  `tckCoveredStores` uses above, for the fenced TCK. */
function fencedTckCoveredStores(): Set<string> {
  const covered = new Set<string>();
  const packages = ['core', 'cli', 'mcp-server', 'testing'];
  for (const pkg of packages) {
    const root = join(PACKAGES_DIR, pkg, 'src');
    for (const file of walkTestFiles(root)) {
      if (file === THIS_GUARD_FILE) continue;
      const src = readFileSync(file, 'utf8');
      if (!src.includes('fencedTraceBufferContract(')) continue;
      for (const storeName of WIRED_FENCED_STORES) {
        if (src.includes(storeName)) covered.add(storeName);
      }
    }
  }
  return covered;
}

describe('store-fs-guard — every fenced-trio-declaring store has a fenced-TCK-invoking contract test (issue #207)', () => {
  it('at least one contract test file invokes fencedTraceBufferContract (the scan is wired correctly)', () => {
    expect(fencedTckCoveredStores().size).toBeGreaterThan(0);
  });

  it('EVERY store in WIRED_FENCED_STORES is covered by a fenced-TCK-invoking test file', () => {
    const covered = fencedTckCoveredStores();
    const uncovered = WIRED_FENCED_STORES.filter((name) => !covered.has(name));
    expect(
      uncovered,
      `${uncovered.join(', ')} ${uncovered.length === 1 ? 'declares' : 'declare'} the fenced trio ` +
        `but no test file both imports it and calls fencedTraceBufferContract(...) — add a ` +
        `*-fenced.contract.test.ts wiring it into the TCK (see ` +
        `json-trace-buffer-store-fenced.contract.test.ts under packages/cli/src/store-contracts/ ` +
        `for the pattern).`,
    ).toEqual([]);
  });
});

// -----------------------------------------------------------------------------------------------
// Guard 4: exact-count allow-list for every raw `traceBufferStore.delete(`/`.deleteAllForRun(`
// call site remaining after the fenced-trio adoption (issue #207 PR-2)
// -----------------------------------------------------------------------------------------------
//
// Scoped to core + mcp-server ONLY (stable receiver name: a local variable or `options.` field
// literally named `traceBufferStore`) — purge.ts/gc.ts use store-TYPED receivers (`store`,
// looped over `artifactStores`/`OrphanSweepableStore[]`) and stay under their own orchestration
// guards (purge-guard.test.ts's WIRED_ORDER, gc.ts's own fenced-dispatch tests), not this one.
//
// A raw (unfenced) `traceBufferStore.delete(`/`.deleteAllForRun(` call site is a DELIBERATE,
// residual, unguarded destruction — every one still standing after issue #207 PR-2 must be
// enumerated here with a one-line contract-clause justification. A NEW raw call site appearing
// anywhere in-scope, the count at an existing site drifting, or (the specific regression this
// guard exists to catch) the :1478 capability-block delete creeping back in, all fail this test.
const RAW_TRACE_BUFFER_STORE_DELETE = /\btraceBufferStore\??\.(delete|deleteAllForRun)\s*\(/;

/** file (relative to PACKAGES_DIR) → exact expected raw call-site count, each with the one-line
 *  contract-clause justification issue #207 PR-2 requires. */
const RAW_DELETE_ALLOW_LIST: Record<string, { count: number; reason: string }> = {
  'core/src/engine/execution-loop.ts': {
    count: 4,
    reason:
      'the LEGACY failure-settle delete (persist-gated on store.update succeeding — #186 posture) ' +
      'and the LEGACY success-settle delete (clause (a) of the unified deletion contract: the ' +
      'settlement already committed and is durably visible, so this delete never races an ' +
      'unsettled step), PLUS their two MIGRATED-path twins (issue #279 increment 1, PR-B): the ' +
      "fail site's migrated delete (gated on result.applied — BU-12, the settleStep equivalent " +
      "of the same persist-gate) and the complete site's migrated delete (same clause-(a) " +
      'reasoning, now gated on settleStep having committed instead of store.update). All FOUR are ' +
      'intentionally UNFENCED for the identical reason: none can race a concurrent append_trace ' +
      'once the run is claimed (appends are refused once in_progress/settled, per ' +
      "append_trace.ts's own eligibility check) — the migration changes WHICH store method " +
      'commits the settlement, not this invariant. The capability-block delete (formerly a fifth ' +
      "site here) was REMOVED entirely, not fenced — see execution-loop.ts's own comment at that " +
      'call site.',
  },
  'core/src/engine/reclaim-step.ts': {
    count: 1,
    reason:
      "the non-declaring-store fallback (clearStaleWal) — byte-frozen, today's order (after the " +
      'un-claiming update, best-effort, warned) — the normative fallback for a store that cannot ' +
      'fence the clear at all; the declaring-store path uses deleteFenced instead (see ' +
      'clearStaleWalFenced, same file).',
  },
};

function traceBufferStoreDeleteScanFiles(): string[] {
  return [
    ...walkTsSourceFiles(join(PACKAGES_DIR, 'core', 'src')),
    ...walkTsSourceFiles(join(PACKAGES_DIR, 'mcp-server', 'src')),
  ];
}

function countRawTraceBufferStoreDeletes(file: string): number {
  const lines = readFileSync(file, 'utf8').split('\n');
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (RAW_TRACE_BUFFER_STORE_DELETE.test(trimmed)) count++;
  }
  return count;
}

describe('store-fs-guard — exact-count allow-list for raw traceBufferStore delete/deleteAllForRun call sites (issue #207 PR-2)', () => {
  it('at least one file is scanned (the scan is wired correctly)', () => {
    expect(traceBufferStoreDeleteScanFiles().length).toBeGreaterThan(0);
  });

  it('every RAW_DELETE_ALLOW_LIST entry still exists as a file', () => {
    for (const rel of Object.keys(RAW_DELETE_ALLOW_LIST)) {
      const full = join(PACKAGES_DIR, rel);
      expect(statSync(full).isFile(), `allow-listed file no longer exists: ${rel}`).toBe(true);
    }
  });

  it('every raw call site is inside the allow-list, at EXACTLY the expected count — no new site, no drifted count, no :1478-style delete creeping back', () => {
    const violations: string[] = [];
    for (const file of traceBufferStoreDeleteScanFiles()) {
      const rel = relativeToPackages(file);
      const actual = countRawTraceBufferStoreDeletes(file);
      const expected = RAW_DELETE_ALLOW_LIST[rel]?.count ?? 0;
      if (actual !== expected) {
        violations.push(`${rel}: expected ${expected}, found ${actual}`);
      }
    }
    expect(
      violations,
      `Raw traceBufferStore delete/deleteAllForRun call-site count mismatch: ` +
        `${violations.join('; ')}. A new (or removed) call site must be reflected in ` +
        `RAW_DELETE_ALLOW_LIST with a one-line contract-clause justification — or, if this is the ` +
        `:1478 capability-block delete creeping back, remove it (see execution-loop.ts's own ` +
        `comment there for why it must not exist).`,
    ).toEqual([]);
  });

  it('the allow-listed files THEMSELVES still contain their expected raw call sites (sanity — proves the matcher is not just vacuously passing)', () => {
    for (const [rel, { count }] of Object.entries(RAW_DELETE_ALLOW_LIST)) {
      const full = join(PACKAGES_DIR, rel);
      const actual = countRawTraceBufferStoreDeletes(full);
      expect(actual, `expected exactly ${count} raw call site(s) in allow-listed ${rel}`).toBe(
        count,
      );
    }
  });
});

// -----------------------------------------------------------------------------------------------
// Guard 5: exact-count allow-list for every raw `traceBufferStore.append(` call site (D3 §7(a),
// restored — issue #207 correction; same conventions as Guard 4)
// -----------------------------------------------------------------------------------------------
//
// Scoped to core + mcp-server ONLY, same stable-receiver-name rationale as Guard 4. A raw
// (unfenced) `traceBufferStore.append(` call site is a DELIBERATE, residual, unfenced write —
// every one still standing after issue #207 PR-2 must be enumerated here with a one-line
// contract-clause justification. A NEW raw call site appearing anywhere in-scope, or the count at
// an existing site drifting, fails this test.
const RAW_TRACE_BUFFER_STORE_APPEND = /\btraceBufferStore\??\.append\s*\(/;

/** file (relative to PACKAGES_DIR) → exact expected raw call-site count, each with the one-line
 *  contract-clause justification issue #207 (correction) requires. */
const RAW_APPEND_ALLOW_LIST: Record<string, { count: number; reason: string }> = {
  'mcp-server/src/tools/append-trace.ts': {
    count: 2,
    reason:
      'the empty-entries probe (writes nothing — raw unlocked path, point-in-time semantics, ' +
      'unconditional regardless of capability, D3 §2) and the capability-absent fallback ' +
      '(Window A stays open for a non-declaring store; deduped console.warn + envelope advisory ' +
      "disclose it — see this file's own capability-absent branch comment).",
  },
};

function traceBufferStoreAppendScanFiles(): string[] {
  return [
    ...walkTsSourceFiles(join(PACKAGES_DIR, 'core', 'src')),
    ...walkTsSourceFiles(join(PACKAGES_DIR, 'mcp-server', 'src')),
  ];
}

function countRawTraceBufferStoreAppends(file: string): number {
  const lines = readFileSync(file, 'utf8').split('\n');
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (RAW_TRACE_BUFFER_STORE_APPEND.test(trimmed)) count++;
  }
  return count;
}

describe('store-fs-guard — exact-count allow-list for raw traceBufferStore.append( call sites (issue #207 correction, D3 §7(a))', () => {
  it('at least one file is scanned (the scan is wired correctly)', () => {
    expect(traceBufferStoreAppendScanFiles().length).toBeGreaterThan(0);
  });

  it('every RAW_APPEND_ALLOW_LIST entry still exists as a file', () => {
    for (const rel of Object.keys(RAW_APPEND_ALLOW_LIST)) {
      const full = join(PACKAGES_DIR, rel);
      expect(statSync(full).isFile(), `allow-listed file no longer exists: ${rel}`).toBe(true);
    }
  });

  it('every raw call site is inside the allow-list, at EXACTLY the expected count — no new site, no drifted count', () => {
    const violations: string[] = [];
    for (const file of traceBufferStoreAppendScanFiles()) {
      const rel = relativeToPackages(file);
      const actual = countRawTraceBufferStoreAppends(file);
      const expected = RAW_APPEND_ALLOW_LIST[rel]?.count ?? 0;
      if (actual !== expected) {
        violations.push(`${rel}: expected ${expected}, found ${actual}`);
      }
    }
    expect(
      violations,
      `Raw traceBufferStore.append( call-site count mismatch: ${violations.join('; ')}. A new ` +
        `(or removed) call site must be reflected in RAW_APPEND_ALLOW_LIST with a one-line ` +
        `contract-clause justification.`,
    ).toEqual([]);
  });

  it('the allow-listed files THEMSELVES still contain their expected raw call sites (sanity — proves the matcher is not just vacuously passing)', () => {
    for (const [rel, { count }] of Object.entries(RAW_APPEND_ALLOW_LIST)) {
      const full = join(PACKAGES_DIR, rel);
      const actual = countRawTraceBufferStoreAppends(full);
      expect(actual, `expected exactly ${count} raw call site(s) in allow-listed ${rel}`).toBe(
        count,
      );
    }
  });
});
