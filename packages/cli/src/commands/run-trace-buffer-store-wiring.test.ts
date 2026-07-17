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
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

describe("realm run's executeChain call receives a defined traceBufferStore (issue #207 PR-2)", () => {
  const src = readFileSync(join(DIR, 'run.ts'), 'utf8');

  it('constructs a JsonTraceBufferStore beside the run store', () => {
    expect(src).toMatch(/new JsonTraceBufferStore\(store\.runsDirPath\)/);
  });

  it("passes traceBufferStore into executeChain's options", () => {
    const callMatch = /executeChain\(store, definition, \{[\s\S]*?\}\)/.exec(src);
    expect(callMatch, 'expected to find the executeChain(...) call site').not.toBeNull();
    expect(callMatch![0]).toMatch(/\btraceBufferStore\b/);
  });
});

describe("realm agent's runAgent calls receive a defined traceBufferStore (issue #207 PR-2)", () => {
  const src = readFileSync(join(DIR, 'agent.ts'), 'utf8');

  it('constructs a JsonTraceBufferStore beside the concrete JsonFileStore', () => {
    expect(src).toMatch(/new JsonTraceBufferStore\(store\.runsDirPath\)/);
  });

  it('both runAgent(...) call sites (attach path and fresh-workflow path) pass traceBufferStore', () => {
    const callMatches = [...src.matchAll(/runAgent\(\s*\{[\s\S]*?\},\s*\{/g)];
    expect(callMatches.length, 'expected exactly 2 runAgent(...) call sites').toBe(2);
    for (const m of callMatches) {
      expect(m[0]).toMatch(/\btraceBufferStore\b/);
    }
  });
});
