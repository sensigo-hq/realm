// Source-text anti-recurrence guard for the #107 PerRunArtifactStore artifact set (the #123
// orphan-guard partition pattern — NOT type-reflection). Every `deleteAllForRun` CLASS-METHOD
// declaration across the whole monorepo must be classified WIRED (and wired, in that exact order,
// into purge.ts's orchestrator array), WIRED THROUGH THE HOME'S PURGE (#616 PR-2c c9: a SQLite
// store, whose rows of a run the home's purge deletes by the store's own deleter) or
// EXCLUDED-with-reason. A future store that adds a
// `deleteAllForRun` and forgets to wire it into the purge orchestrator would otherwise silently
// leak that store's artifacts on every purge — this test fails loudly on that drift instead.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/cli/src/commands → packages/
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED_PACKAGES = ['core', 'cli', 'mcp-server', 'testing', 'store-sqlite'];

/** Every non-test, non-declaration .ts source file under a package's src/. */
function sourceFiles(pkg: string): string[] {
  const root = join(PACKAGES_DIR, pkg, 'src');
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

/**
 * Matcher discipline (issue #107, exact): a line matching this, trimmed, that ENDS in '{' is a
 * class-method declaration. An interface declaration ends ';' (excluded below). A call site such
 * as `store.deleteAllForRun(...)` is never anchored at line start after `^\s*` — it is always
 * preceded by a receiver + '.', which is not whitespace — so it never matches this pattern at all;
 * the explicit `.`-prefix check below is deliberate belt-and-suspenders for a hypothetical
 * continuation-line call site (`.deleteAllForRun(...)` on its own line). Deliberately does NOT key
 * on `async` — a future non-async implementation must still be caught.
 */
const DECL_LINE = /^\s*(async\s+)?deleteAllForRun\s*\(/;

interface Declarer {
  file: string;
  className: string;
}

/** Finds the class name enclosing a declaration by scanning upward for the nearest `class Foo`. */
function enclosingClass(lines: string[], atIndex: number): string | undefined {
  for (let i = atIndex; i >= 0; i--) {
    const m = /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/.exec(lines[i]!);
    if (m) return m[1];
  }
  return undefined;
}

function findDeclarers(): Declarer[] {
  const declarers: Declarer[] = [];
  for (const file of SCANNED_PACKAGES.flatMap(sourceFiles)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!DECL_LINE.test(trimmed)) return;
      if (trimmed.startsWith('.')) return; // hypothetical continuation-line call site
      // A class implementation's declaration line ends '{' when the signature fits on one line,
      // and '(' when the parameter list wraps. Both forms are declarations; an INTERFACE
      // declaration ends ';' and is excluded either way.
      //
      // The '(' form was added for issue #189: widening the return type to
      // `Promise<ArtifactDeletionReport>` pushed every implementation's signature past the line
      // limit, so the formatter wrapped them all — and a matcher keyed only on '{' silently found
      // ZERO declarers. The guard's own non-vacuity cell caught it, which is the one reason this
      // was not a silent hole: a source-text guard that stops matching does not fail, it stops
      // guarding.
      if (!trimmed.endsWith('{') && !trimmed.endsWith('(')) return;
      const className = enclosingClass(lines, i);
      if (className === undefined) return; // not expected for a real class method
      declarers.push({ file, className });
    });
  }
  return declarers;
}

// The partition. WIRED_ORDER must equal purge.ts's `artifactStores: PerRunArtifactStore[]` array
// literal exactly, in order — the NON-anchor stores purge.ts's deletion loop iterates BEFORE the
// anchor. ANCHOR (issue #184) is JsonFileStore: it is deliberately ABSENT from that array now —
// its deleteAllForRun is invoked separately, by purgeRuns itself, structurally LAST and only on
// total success (the crash-anchor property moved from positional — "runStore is the last array
// element" — to structural — "purgeRuns's own control flow guarantees it"). ANCHOR must still be
// classified (it has a real deleteAllForRun declaration and its own TCK contract test — see
// store-fs-guard.test.ts's WIRED⇒TCK check, which is UNCHANGED and still expects JsonFileStore
// covered) — it just never appears in WIRED_ORDER or the array-literal check below.
// #616 PR-2c c10a-3a: the door's stores are the SQLite home's, so the array holds the SQLite classes
// (also WIRED THROUGH THE HOME'S PURGE below: the classification is membership-or, no conflict).
const WIRED_ORDER = ['SqliteTraceBufferStore', 'SqliteFailedAttemptStore'];
const ANCHOR = 'JsonFileStore';
const EXCLUDED: Record<string, string> = {
  InMemoryTraceBufferStore: 'test-only in-memory store — never purged (no on-disk artifacts)',
  // #616 PR-2c c10a-3a: the door opens the SQLite home, so no command purges through these two; the
  // MCP program has no purge. PR-3 deletes them with the JSON store.
  JsonTraceBufferStore:
    "the JSON store's class — no `realm` command purges through it since the door opened the SQLite home (#616 PR-2c c10a-3a); purge.test.ts drives the JSON per-store path until PR-3 deletes it",
  JsonFileFailedAttemptStore:
    "the JSON store's class — no `realm` command purges through it since the door opened the SQLite home (#616 PR-2c c10a-3a); purge.test.ts drives the JSON per-store path until PR-3 deletes it",
};
// #616 PR-2c c9 (SEAMS S15; MA 4's point 5: each store's own code deletes its own rows, called by
// purge): on a SQLite home, purge hands the selected runs to the home's purge
// (`store-sqlite/src/home-purge.ts`), which deletes each store's rows of a run in its batch by that
// store's ONE package-internal deleter — the same function the store's own `deleteAllForRun` calls.
// These stores are not in purge.ts's array (the JSON stores' path); the home's purge is their wiring.
const STORE_SQLITE_SRC = join(PACKAGES_DIR, 'store-sqlite', 'src');
const HOME_PURGE = join(STORE_SQLITE_SRC, 'home-purge.ts');
const WIRED_THROUGH_HOME_PURGE: Record<string, { file: string; deleter: string }> = {
  SqliteRunStore: { file: 'run-store.ts', deleter: 'deleteRunIfDeletable' },
  SqliteTraceBufferStore: { file: 'trace-buffer-store.ts', deleter: 'deleteTraceRowsOfRun' },
  SqliteFailedAttemptStore: {
    file: 'failed-attempt-store.ts',
    deleter: 'deleteFailedAttemptRowsOfRun',
  },
};

describe('#107/#184 PerRunArtifactStore.deleteAllForRun — declarer enumeration (anti-recurrence)', () => {
  const declarers = findDeclarers();

  it('at least one declarer is discovered (the scan is wired correctly)', () => {
    expect(declarers.length).toBeGreaterThan(0);
  });

  it('EVERY deleteAllForRun class-method declarer is classified WIRED, ANCHOR, WIRED THROUGH THE HOME’S PURGE, or EXCLUDED-with-reason', () => {
    const unclassified = declarers
      .map((d) => d.className)
      .filter(
        (name) =>
          !WIRED_ORDER.includes(name) &&
          name !== ANCHOR &&
          !(name in WIRED_THROUGH_HOME_PURGE) &&
          !(name in EXCLUDED),
      );
    expect(
      unclassified,
      `Unclassified deleteAllForRun declarer(s): ${unclassified.join(', ')}. Wire it into ` +
        `purge.ts's artifactStores orchestrator (and list it in WIRED_ORDER), pass it as the ` +
        `anchorStore param (and set ANCHOR to its name), delete its rows in the SQLite home's purge ` +
        `by its own deleter (and list it in WIRED_THROUGH_HOME_PURGE), or document why it is ` +
        `excluded (add it to EXCLUDED with a reason).`,
    ).toEqual([]);
  });

  it('the WIRED set and the ANCHOR both match exactly (nothing missing)', () => {
    const found = new Set(declarers.map((d) => d.className));
    for (const name of [...WIRED_ORDER, ANCHOR]) {
      expect(
        found.has(name),
        `${name} is listed WIRED/ANCHOR but has no deleteAllForRun declaration`,
      ).toBe(true);
    }
  });

  it('no classification entry is stale (every WIRED/ANCHOR/EXCLUDED name still has a declaration)', () => {
    const present = new Set(declarers.map((d) => d.className));
    for (const name of [
      ...WIRED_ORDER,
      ANCHOR,
      ...Object.keys(WIRED_THROUGH_HOME_PURGE),
      ...Object.keys(EXCLUDED),
    ]) {
      expect(present.has(name), `${name} is classified but no longer has a declaration`).toBe(true);
    }
  });

  it("purge.ts's artifactStores array matches WIRED_ORDER exactly, in order, and the ANCHOR (JsonFileStore) is ABSENT from it (issue #184)", () => {
    const purgeSrc = readFileSync(join(PACKAGES_DIR, 'cli', 'src', 'commands', 'purge.ts'), 'utf8');
    const arrayMatch = /PerRunArtifactStore\[\]\s*=\s*\[([\s\S]*?)\];/.exec(purgeSrc);
    expect(arrayMatch, "purge.ts's artifactStores array literal was not found").not.toBeNull();
    const body = arrayMatch![1]!;
    // Each element line carries a trailing `// ClassName` comment identifying which store it is —
    // source-text, not type-reflection, per the #123 orphan-guard precedent.
    const order = [...body.matchAll(/\/\/\s*([A-Z]\w+)/g)].map((m) => m[1]);
    expect(order, `expected order ${WIRED_ORDER.join(', ')}, found ${order.join(', ')}`).toEqual(
      WIRED_ORDER,
    );
    expect(
      order,
      `${ANCHOR} must be ABSENT from artifactStores — it is now the structural anchor, passed to ` +
        `purgeRuns separately as anchorStore (a future edit re-adding it here reintroduces ` +
        `anchor-before-children with no test catching it)`,
    ).not.toContain(ANCHOR);
  });

  it("the door's run store is passed as the anchorStore argument to purgeRuns, not inside artifactStores, and the home's purge fourth (issue #184; #616 PR-2c c10a-3a)", () => {
    const purgeSrc = readFileSync(join(PACKAGES_DIR, 'cli', 'src', 'commands', 'purge.ts'), 'utf8');
    // purgeRuns(<options object>, <anchorStore var>, <artifactStores var>, home.purge) — #616 PR-2c
    // c10a-3a: the fourth argument is the home's own purge (c9's store path).
    const callMatch = /purgeRuns\(\s*\{[\s\S]*?\},\s*(\w+),\s*(\w+),\s*home\.purge,?\s*\)/.exec(
      purgeSrc,
    );
    expect(callMatch, 'purgeRuns(...) call site was not found').not.toBeNull();
    const anchorVarName = callMatch![1]!;
    // #616 PR-2a (iii): the anchor is the one door's run store (`home.runStore`); since #616 PR-2c
    // c10a-3a the door takes that store from the SQLite home (`realmHome.runStore`, wrapped for the
    // #715 (b) test-clock notice, which keeps the same instance kind). (1) red when purge.ts takes its
    // anchor from anything but the door's run store, or hands purgeRuns no home purge, or the door's
    // run store stops being the home's; (2) prints the variable name, or the file that no longer
    // matches.
    const anchorDeclMatch = new RegExp(
      `\\bconst\\s+${anchorVarName}\\s*=\\s*home\\.runStore\\s*;`,
    ).exec(purgeSrc);
    expect(
      anchorDeclMatch,
      `expected purgeRuns's 2nd argument ('${anchorVarName}') to be the door's run store ` +
        `('home.runStore') — the anchorStore param must be the SQLite home's run store`,
    ).not.toBeNull();
    const homeSrc = readFileSync(join(PACKAGES_DIR, 'cli', 'src', 'lib', 'home.ts'), 'utf8');
    expect(
      homeSrc,
      "lib/home.ts must take its run store from the SQLite home ('withTestClockNotice(realmHome.runStore, …)')",
    ).toMatch(/\bconst\s+runStore\s*=\s*withTestClockNotice\(\s*realmHome\.runStore\b/);
  });

  it('#616 PR-2c c9: every store WIRED THROUGH THE HOME’S PURGE declares its one deleter, calls it from its own deleteAllForRun, and the home’s purge calls it', () => {
    const purgeSrc = readFileSync(HOME_PURGE, 'utf8');
    const calls = (src: string, name: string): number =>
      [...src.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].length;
    const wiring = Object.fromEntries(
      Object.entries(WIRED_THROUGH_HOME_PURGE).map(([store, { file, deleter }]) => {
        const src = readFileSync(join(STORE_SQLITE_SRC, file), 'utf8');
        return [
          store,
          {
            declared: src.includes(`export function ${deleter}(`),
            // The declaration is one match; the store's own deleteAllForRun is the other.
            calledByItsStore: calls(src, deleter) >= 2,
            calledByHomePurge: calls(purgeSrc, deleter) > 0,
          },
        ];
      }),
    );
    // (1) red when the home's purge stops calling one store's deleter (that store's rows of a purged
    //     run would be left behind on a SQLite home), when a store's deleter is renamed or no longer
    //     exported, or when its own deleteAllForRun stops calling it (two copies of the statements);
    //     (2) prints each store's three answers.
    const all = { declared: true, calledByItsStore: true, calledByHomePurge: true };
    expect(wiring).toEqual(
      Object.fromEntries(Object.keys(WIRED_THROUGH_HOME_PURGE).map((store) => [store, all])),
    );
  });

  it('the TraceBufferStore interface declaration is excluded structurally (ends ";", not "{")', () => {
    const file = join(PACKAGES_DIR, 'core', 'src', 'store', 'trace-buffer-store.ts');
    const src = readFileSync(file, 'utf8');
    const interfaceLine = src
      .split('\n')
      .find((l) => l.trim().startsWith('deleteAllForRun') && l.trim().endsWith(';'));
    expect(interfaceLine, 'expected to find the interface declaration line').toBeDefined();
  });

  it("the fenced variant (issue #207 PR-2) is called from WITHIN the same per-run artifact loop as the legacy fallback — the fenced call site does not bypass WIRED_ORDER's artifact-before-anchor structure", () => {
    const purgeSrc = readFileSync(join(PACKAGES_DIR, 'cli', 'src', 'commands', 'purge.ts'), 'utf8');
    // The fenced call must appear TEXTUALLY BETWEEN the per-run loop's `for (const store of
    // artifactStores)` and the structural anchor call `anchorStore.deleteAllForRun(` — i.e.
    // inside the same loop the legacy fallback (asserted by WIRED_ORDER/ANCHOR above) already
    // lives in, never after the anchor delete.
    const loopStart = purgeSrc.indexOf('for (const store of artifactStores)');
    const fencedCall = purgeSrc.indexOf('store.deleteAllForRunFenced(');
    const anchorDeleteCall = purgeSrc.indexOf(
      'await anchorStore.deleteAllForRun(run.id, dirEntries, {',
    );
    expect(loopStart, 'expected to find the per-run artifactStores loop').toBeGreaterThan(-1);
    expect(fencedCall, 'expected to find a store.deleteAllForRunFenced( call site').toBeGreaterThan(
      -1,
    );
    expect(
      anchorDeleteCall,
      'expected to find the structural anchor deleteAllForRun call',
    ).toBeGreaterThan(-1);
    expect(fencedCall).toBeGreaterThan(loopStart);
    expect(fencedCall).toBeLessThan(anchorDeleteCall);
  });
});
