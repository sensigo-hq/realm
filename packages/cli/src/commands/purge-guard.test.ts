// Source-text anti-recurrence guard for the #107 PerRunArtifactStore artifact set (the #123
// orphan-guard partition pattern — NOT type-reflection). Every `deleteAllForRun` CLASS-METHOD
// declaration across the whole monorepo must be classified WIRED (and wired, in that exact order,
// into purge.ts's orchestrator array) or EXCLUDED-with-reason. A future store that adds a
// `deleteAllForRun` and forgets to wire it into the purge orchestrator would otherwise silently
// leak that store's artifacts on every purge — this test fails loudly on that drift instead.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/cli/src/commands → packages/
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCANNED_PACKAGES = ['core', 'cli', 'mcp-server', 'testing'];

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
      if (!trimmed.endsWith('{')) return; // interface declaration (ends ';') — not a class impl
      const className = enclosingClass(lines, i);
      if (className === undefined) return; // not expected for a real class method
      declarers.push({ file, className });
    });
  }
  return declarers;
}

// The partition. WIRED_ORDER must equal purge.ts's `artifactStores: PerRunArtifactStore[]` — in
// the SAME order, since `runStore` (JsonFileStore) being last is the crash-anchor invariant.
const WIRED_ORDER = ['JsonTraceBufferStore', 'FailedAttemptStore', 'JsonFileStore'];
const EXCLUDED: Record<string, string> = {
  InMemoryTraceBufferStore: 'test-only in-memory store — never purged (no on-disk artifacts)',
};

describe('#107 PerRunArtifactStore.deleteAllForRun — declarer enumeration (anti-recurrence)', () => {
  const declarers = findDeclarers();

  it('at least one declarer is discovered (the scan is wired correctly)', () => {
    expect(declarers.length).toBeGreaterThan(0);
  });

  it('EVERY deleteAllForRun class-method declarer is classified WIRED or EXCLUDED-with-reason', () => {
    const unclassified = declarers
      .map((d) => d.className)
      .filter((name) => !WIRED_ORDER.includes(name) && !(name in EXCLUDED));
    expect(
      unclassified,
      `Unclassified deleteAllForRun declarer(s): ${unclassified.join(', ')}. Wire it into ` +
        `purge.ts's artifactStores orchestrator (and list it in WIRED_ORDER) or document why it ` +
        `is excluded (add it to EXCLUDED with a reason).`,
    ).toEqual([]);
  });

  it('the WIRED set matches exactly (nothing missing)', () => {
    const found = new Set(declarers.map((d) => d.className));
    for (const name of WIRED_ORDER) {
      expect(
        found.has(name),
        `${name} is listed WIRED but has no deleteAllForRun declaration`,
      ).toBe(true);
    }
  });

  it('no classification entry is stale (every WIRED/EXCLUDED name still has a declaration)', () => {
    const present = new Set(declarers.map((d) => d.className));
    for (const name of [...WIRED_ORDER, ...Object.keys(EXCLUDED)]) {
      expect(present.has(name), `${name} is classified but no longer has a declaration`).toBe(true);
    }
  });

  it("purge.ts's orchestrator array matches WIRED_ORDER exactly, in order — runStore (JsonFileStore) LAST", () => {
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
      order[order.length - 1],
      'runStore (JsonFileStore) must be LAST — the crash anchor',
    ).toBe('JsonFileStore');
  });

  it('the TraceBufferStore interface declaration is excluded structurally (ends ";", not "{")', () => {
    const file = join(PACKAGES_DIR, 'core', 'src', 'store', 'trace-buffer-store.ts');
    const src = readFileSync(file, 'utf8');
    const interfaceLine = src
      .split('\n')
      .find((l) => l.trim().startsWith('deleteAllForRun') && l.trim().endsWith(';'));
    expect(interfaceLine, 'expected to find the interface declaration line').toBeDefined();
  });
});
