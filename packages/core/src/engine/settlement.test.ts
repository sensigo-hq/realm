// Source-text POSITIVE pin for RunStore.settleStep's migration (issue #279). PR-A shipped this
// file's ORIGINAL guard here: a ZERO-invocation-sites assertion proving the engine never called
// settleStep while the substrate was still dormant. PR-B migrated the three seal sites
// (complete/fail/handler-abort) onto settleStep — that guard was deleted (as its own header said
// it would be) and replaced with a positive three-site pin. PR-C added four MORE delta kinds
// (open_gate/settle_gate/settle_guard/release_step) but stayed engine-inert for them, adding its
// OWN temporary zero-construction-sites guard. PR-D (increment 2, this file's current state)
// migrates the five remaining legacy write sites (gate-open, gate-resolution, guard-chain,
// capability-block release, compensating un-claim) onto settleStep — deleting PR-C's
// engine-inertness guard (its whole premise is now false) and widening this positive pin to
// EXACTLY EIGHT `.settleStep(` invocation sites: the three PR-B shipped (complete/fail/
// handler-abort) plus the five PR-D just migrated (gate-open/gate-resolution/guard-chain/
// capability-release/compensating-unclaim) — all inside execution-loop.ts (the only migrated
// file), with packages/mcp-server/src/** staying clean (it constructs no deltas of its own; it
// only calls into execution-loop.ts's exported functions). A future accidental NINTH call site (or
// a stray call outside execution-loop.ts) fails this test loudly, the same anti-recurrence
// discipline the deleted PR-A guard had, inverted.
//
// Invocation-scoped (matches `.settleStep(` literally, not a bare `settleStep` name match) so this
// module's own JSDoc prose can mention the identifier freely without self-tripping the count.
// Mechanically executable path-prefix globs, mirroring the #107 deleteAllForRun declarer-scan
// precedent (packages/cli/src/commands/purge-guard.test.ts).
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
// complete/fail/handler-abort (PR-B) + gate-open/gate-resolution/guard-chain/capability-release/
// compensating-unclaim (PR-D, increment 2).
const EXPECTED_SITE_COUNT = 8;
const MIGRATED_FILE = join(PACKAGES_DIR, 'core', 'src', 'engine', 'execution-loop.ts');

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

function findInvocationSites(): { file: string; line: number; text: string }[] {
  const sites: { file: string; line: number; text: string }[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const file of sourceFiles(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes(INVOCATION)) {
          sites.push({ file, line: i + 1, text: line.trim() });
        }
      });
    }
  }
  return sites;
}

describe('RunStore.settleStep is MIGRATED at exactly eight sites — increment 2, PR-D', () => {
  it('the scan itself is wired correctly (finds at least one .ts source file per root)', () => {
    for (const root of SCANNED_ROOTS) {
      expect(
        sourceFiles(root).length,
        `expected at least one source file under ${root}`,
      ).toBeGreaterThan(0);
    }
  });

  it(`EXACTLY ${EXPECTED_SITE_COUNT} '.settleStep(' invocation sites exist (complete/fail/handler-abort/gate-open/gate-resolution/guard-chain/capability-release/compensating-unclaim)`, () => {
    const sites = findInvocationSites();
    expect(
      sites.length,
      sites.length !== EXPECTED_SITE_COUNT
        ? `Expected exactly ${EXPECTED_SITE_COUNT} '.settleStep(' invocation site(s), found ` +
            `${sites.length}:\n${sites.map((s) => `  ${s.file}:${s.line}: ${s.text}`).join('\n')}`
        : '',
    ).toBe(EXPECTED_SITE_COUNT);
  });

  it('every invocation site lives in execution-loop.ts — none anywhere else (mcp-server stays clean)', () => {
    const sites = findInvocationSites();
    const elsewhere = sites.filter((s) => s.file !== MIGRATED_FILE);
    expect(
      elsewhere,
      elsewhere.length > 0
        ? `Found '.settleStep(' invocation site(s) OUTSIDE execution-loop.ts (increment 2 ` +
            `territory — gate-open/gate-resolution/guard seals must stay on the legacy path this ` +
            `increment):\n${elsewhere.map((s) => `  ${s.file}:${s.line}: ${s.text}`).join('\n')}`
        : '',
    ).toEqual([]);
  });

  it('settlement.ts declares applySettlement and selectFinalizers as its exported surface (sanity check on the module this pin is about)', () => {
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
