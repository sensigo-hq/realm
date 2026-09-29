// Source-text wiring check: the CLI executors (`realm run`, `realm agent`) construct a
// JsonTraceBufferStore and thread it through to executeChain (issue #207 PR-2, D3 §5
// mixed-wiring gap — CLI executors previously passed no `traceBufferStore` at all, so acknowledged
// appends were neither adopted nor refused when a CLI runner settled). Both run.ts's and agent.ts's
// action() bodies are inline Commander callback logic (run.ts additionally reads from
// readline/stdin) — like purge.ts's own .action(), neither has a dedicated behavioral test file
// (see purge-guard.test.ts's own precedent for this class of CLI action). A source-text check is
// the proportionate, honest substitute: confirms the wiring exists without attempting to drive an
// interactive session or a full provider/workflow resolution in a unit test. `run-agent.test.ts`
// separately proves the DEEPER contract behaviorally (runAgent → executeChain actually adopts a
// pre-seeded WAL entry when deps.traceBufferStore is supplied) — this file only proves the CLI
// action sites actually supply it.
//
// issue #616 PR-0, D5 (review finding F4) — the pairing moved from CALL time to CONSTRUCTION
// time: a trace buffer now fences against the run store it was BUILT with, so a host that builds
// it over a different store fences against the wrong one, silently. `JsonTraceBufferStore`'s
// constructor requiring a reader (D2) catches a MISSING one; it cannot catch a WRONG one. The
// seven-host table below pins, for every production construction site, that the reader argument
// names the exact run store that host writes (or, for `export.ts`, reads) — replacing the two
// narrower `run.ts`/`agent.ts` constructor pins this file carried before D5, which pinned the SAME
// fact under the pre-D2 argument order and would otherwise duplicate the new table's first two
// rows.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

describe("realm run's executeChain call receives a defined traceBufferStore (issue #207 PR-2)", () => {
  const src = readFileSync(join(DIR, 'run.ts'), 'utf8');

  it("passes traceBufferStore into executeChain's options", () => {
    const callMatch = /executeChain\(store, definition, \{[\s\S]*?\}\)/.exec(src);
    expect(callMatch, 'expected to find the executeChain(...) call site').not.toBeNull();
    expect(callMatch![0]).toMatch(/\btraceBufferStore\b/);
  });
});

describe("realm agent's runAgent calls receive a defined traceBufferStore (issue #207 PR-2)", () => {
  const src = readFileSync(join(DIR, 'agent.ts'), 'utf8');

  it('both runAgent(...) call sites (attach path and fresh-workflow path) pass traceBufferStore', () => {
    const callMatches = [...src.matchAll(/runAgent\(\s*\{[\s\S]*?\},\s*\{/g)];
    expect(callMatches.length, 'expected exactly 2 runAgent(...) call sites').toBe(2);
    for (const m of callMatches) {
      expect(m[0]).toMatch(/\btraceBufferStore\b/);
    }
  });
});

/** Resolves `@sensigo/realm-mcp`'s package root from a KNOWN exported entry point (`main`), so
 *  `server.ts`'s source is readable from this package without a fragile `../../../` relative path
 *  that would break silently if either package moved. */
function mcpServerSrcPath(file: string): string {
  const distIndex = fileURLToPath(import.meta.resolve('@sensigo/realm-mcp'));
  // distIndex is `.../packages/mcp-server/dist/index.js` — the package root is two levels up.
  const pkgRoot = join(dirname(distIndex), '..');
  return join(pkgRoot, 'src', file);
}

/** One JsonTraceBufferStore construction per production host, and the run store its reader
 *  argument must name — the exact source-text pin issue #616 PR-0 D5 requires. Read on `60a21eb`
 *  and on the D2-shaped build alike: the argument POSITION changed, the NAMES did not. */
const HOSTS: Array<{ file: string; path: string; readerName: string }> = [
  { file: 'run.ts', path: join(DIR, 'run.ts'), readerName: 'store' },
  { file: 'agent.ts', path: join(DIR, 'agent.ts'), readerName: 'store' },
  { file: 'reclaim.ts', path: join(DIR, 'reclaim.ts'), readerName: 'store' },
  { file: 'gc.ts', path: join(DIR, 'gc.ts'), readerName: 'runStore' },
  { file: 'purge.ts', path: join(DIR, 'purge.ts'), readerName: 'runStore' },
  { file: 'export.ts', path: join(DIR, 'export.ts'), readerName: 'runStore' },
  { file: 'server.ts', path: mcpServerSrcPath('server.ts'), readerName: 'effectiveRunStore' },
];

/** The D5 pin: the reader argument is EXACTLY `readerName` — whitespace-tolerant, a trailing comma
 *  or a third (lock-profile) argument allowed, but nothing may continue the name (`storeForTrace`,
 *  `store.inner`, `stores[0]` are different stores and must not satisfy the pin). The name is
 *  escaped, so a dotted reader (`deps.runStore`) is matched literally, never as a wildcard. */
function readerPin(readerName: string): RegExp {
  const name = readerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `new\\s+JsonTraceBufferStore\\(\\s*[A-Za-z0-9_.]+\\s*,\\s*${name}\\s*(?:,[\\s\\S]{0,80}?)?\\)`,
  );
}

describe('issue #616 PR-0 (D5) — every host fences against the run store it actually writes (or, for export, reads)', () => {
  it('the reader pin accepts the host store in every layout and rejects a different store whose name starts with it', () => {
    const accepted = [
      'new JsonTraceBufferStore(store.runsDirPath, store);',
      'new JsonTraceBufferStore(\n  store.runsDirPath,\n  store,\n);',
      'new JsonTraceBufferStore(dir, store, GENEROUS_LOCK_PROFILE)',
    ];
    const rejected = [
      'new JsonTraceBufferStore(store.runsDirPath, storeForTrace);',
      'new JsonTraceBufferStore(store.runsDirPath, store.inner);',
      'new JsonTraceBufferStore(store.runsDirPath, stores[0]);',
      'new JsonTraceBufferStore(store.runsDirPath, otherStore);',
    ];
    for (const src of accepted) expect(src, src).toMatch(readerPin('store'));
    for (const src of rejected) expect(src, src).not.toMatch(readerPin('store'));
    // A dotted reader is matched literally: its `.` is not a wildcard.
    expect('new JsonTraceBufferStore(dir, deps.runStore)').toMatch(readerPin('deps.runStore'));
    expect('new JsonTraceBufferStore(dir, depsXrunStore)').not.toMatch(readerPin('deps.runStore'));
  });

  for (const { file, path, readerName } of HOSTS) {
    it(`${file} pins the reader to '${readerName}', and builds exactly one JsonTraceBufferStore`, () => {
      const src = readFileSync(path, 'utf8');
      // Whitespace-tolerant, a trailing comma allowed: the repo's pre-commit hook runs
      // `prettier --write .`, which re-flows `server.ts`'s construction onto one line once the
      // reader moves to second place — a rigid pin would fail for a reason that is not this test's.
      const pinned = readerPin(readerName);
      expect(
        src,
        `${file} must construct JsonTraceBufferStore with '${readerName}' as its reader`,
      ).toMatch(pinned);
      const occurrences = [...src.matchAll(/new\s+JsonTraceBufferStore\(/g)];
      expect(occurrences.length, `${file} must build exactly one JsonTraceBufferStore`).toBe(1);
    });
  }
});
