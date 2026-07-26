// Source-text anti-recurrence guard for RunStore.settleStep's dormancy (issue #279, increment 1,
// PR-A). PR-A's whole point is ZERO engine behavior change: `applySettlement`/`settleStep` exist,
// are exported, and are conformance-tested (see @sensigo/realm-testing's settlement-contract.ts),
// but nothing in the engine or the MCP server calls them yet — the engine still seals steps via
// the legacy read-then-update path. This guard fails loudly if that invariant is ever violated by
// accident (a future engine-file edit that starts calling `store.settleStep(...)` without going
// through the deliberate PR-B migration).
//
// Invocation-scoped (matches `.settleStep(` literally), NOT a bare `settleStep` name match — this
// module's own JSDoc prose (RunStore.settleStep, the interface declaration, this very comment)
// mentions the identifier freely without ever writing the CALL syntax, so the invocation-scoped
// pattern cannot self-trip. Mechanically executable path-prefix globs, mirroring the #107
// deleteAllForRun declarer-scan precedent (packages/cli/src/commands/purge-guard.test.ts) rather
// than a hand-maintained list of "files that must not call it".
//
// PR-B (the settleStep migration) DELETES this guard test entirely — its whole job there is to
// start calling settleStep from the engine's seal sites, which is exactly what this test forbids.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/core/src/engine → packages/
const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const SCANNED_ROOTS = [
  join(PACKAGES_DIR, 'core', 'src', 'engine'),
  join(PACKAGES_DIR, 'mcp-server', 'src'),
];

const INVOCATION = '.settleStep(';

/** Every non-test, non-declaration .ts source file under `root`, recursively. */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe('RunStore.settleStep is DORMANT in the engine and MCP server (issue #279, increment 1, PR-A)', () => {
  it('ZERO `.settleStep(` invocation sites under packages/core/src/engine/** or packages/mcp-server/src/**', () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const file of sourceFiles(root)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
          if (line.includes(INVOCATION)) {
            offenders.push({ file, line: i + 1, text: line.trim() });
          }
        });
      }
    }
    expect(
      offenders,
      offenders.length > 0
        ? `Found ${offenders.length} '.settleStep(' invocation site(s) in the engine/MCP server ` +
            `— PR-A requires ZERO engine behavior change. If this is the deliberate PR-B ` +
            `migration, DELETE this guard test as part of that PR (see this file's own header):\n` +
            offenders.map((o) => `  ${o.file}:${o.line}: ${o.text}`).join('\n')
        : '',
    ).toEqual([]);
  });

  it('the scan itself is wired correctly (finds at least one .ts source file per root)', () => {
    for (const root of SCANNED_ROOTS) {
      expect(
        sourceFiles(root).length,
        `expected at least one source file under ${root}`,
      ).toBeGreaterThan(0);
    }
  });

  it('settlement.ts declares applySettlement and selectFinalizers as its exported surface (sanity check on the module this guard is about)', () => {
    const settlementSrc = readFileSync(
      join(PACKAGES_DIR, 'core', 'src', 'engine', 'settlement.ts'),
      'utf8',
    );
    expect(settlementSrc).toContain('export function applySettlement(');
    expect(settlementSrc).toContain('export function selectFinalizers(');
  });
});

// ---------------------------------------------------------------------------
// applySettlement determinism (verification item 4, L11's leg): same inputs + fixed `now` ⇒
// deep-equal outputs. L7 (values-only options + this file's own source-text guard above) is the
// other half of the same law pairing.
// ---------------------------------------------------------------------------
describe('applySettlement is deterministic — same inputs + fixed now ⇒ deep-equal outputs (issue #279)', () => {
  it('two independent calls with byte-identical (fresh, delta, definition, {now}) produce deep-equal SettlementResult objects', async () => {
    const { applySettlement } = await import('./settlement.js');
    const definition = {
      id: 'determinism-wf',
      name: 'Determinism check',
      version: 1,
      steps: {
        a: { description: 'a', execution: 'agent' as const, depends_on: [] },
        b: { description: 'b', execution: 'agent' as const, depends_on: [] },
        fin: { description: 'f', execution: 'finalizer' as const, on_outcome: 'complete' as const },
      },
    };
    const fresh = {
      id: 'determinism-run',
      workflow_id: definition.id,
      workflow_version: 1,
      completed_steps: ['b'],
      in_progress_steps: ['a'],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'running' as const,
      version: 3,
      params: {},
      evidence: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      terminal_state: false,
      claims: { a: { deadline: null, token: 'determinism-token' } },
    };
    const delta = {
      kind: 'settle_step' as const,
      step: 'a',
      outcome: 'complete' as const,
      claimToken: 'determinism-token',
      evidence: [
        {
          step_id: 'a',
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:00:01.000Z',
          duration_ms: 1,
          input_summary: {},
          output_summary: {},
          status: 'success' as const,
          evidence_hash: 'x',
        },
      ],
    };
    const now = new Date('2026-03-15T09:30:00.000Z');

    const first = applySettlement(fresh, delta, definition, { now });
    const second = applySettlement(fresh, delta, definition, { now });

    expect(first).toEqual(second);
    // Sanity: the fixture actually exercises the applied path (a vacuously-equal pair of
    // refusals would pass this check without proving anything about the transform's output).
    expect(first.applied).toBe(true);
  });
});
