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
// EIGHT `.settleStep(` invocation sites: the three PR-B shipped (complete/fail/handler-abort)
// plus the five PR-D just migrated (gate-open/gate-resolution/guard-chain/capability-release/
// compensating-unclaim) — all inside execution-loop.ts (the only migrated file), with
// packages/mcp-server/src/** staying clean (it constructs no deltas of its own; it only calls
// into execution-loop.ts's exported functions).
//
// issue #291 (Deliverable 4a): submitHumanResponse's migrated path gained a NINTH site — the
// `expire_gate` settleStep call issued when the [F3] `gate_expired_pending` write-free refusal
// fired ([F3] shape c: the caller reacted to the refusal with its OWN settleStep). A future
// accidental extra `.settleStep(` call site (or a stray call outside the files named below) fails
// this test loudly, the same anti-recurrence discipline the deleted PR-A guard had, inverted.
//
// #715 (b) — the set, member by member, and the mechanism that puts each one here (12):
//   execution-loop.ts (11): complete, fail, handler-abort (PR-B); gate-open, gate-resolution,
//     guard-chain, capability-release, compensating-unclaim (PR-D); expire_gate in
//     `enactExpiredGateIfDue` (#291 4b); lease_finalizer and mark_finalizer in `drainFinalizers` —
//     before #715 (b) these two were calls through a bound alias (`const settleStep =
//     store.settleStep?.bind(store)`, the dormancy guard C.1 deletes) that this literal scan
//     could not see; they are direct calls now.
//   abandon-run.ts (1): the `seal_run` delta (D-21) — the run-level seal moved off `update()`.
// GONE: #291 4a's second write — the late answer's expiry is enacted INSIDE the settle_gate write
// (A.8 (iii)), so submitHumanResponse no longer issues an `expire_gate` after a refusal.
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
// The twelve members, each with its mechanism, are listed in the header (#715 (b)).
const EXPECTED_SITE_COUNT = 12;
const MIGRATED_FILE = join(PACKAGES_DIR, 'core', 'src', 'engine', 'execution-loop.ts');
const SEAL_RUN_FILE = join(PACKAGES_DIR, 'core', 'src', 'engine', 'abandon-run.ts');

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

describe('RunStore.settleStep is MIGRATED at exactly twelve sites — increment 2 PR-D + issue #291 + #715 (b)', () => {
  it('the scan itself is wired correctly (finds at least one .ts source file per root)', () => {
    for (const root of SCANNED_ROOTS) {
      expect(
        sourceFiles(root).length,
        `expected at least one source file under ${root}`,
      ).toBeGreaterThan(0);
    }
  });

  it(`EXACTLY ${EXPECTED_SITE_COUNT} '.settleStep(' invocation sites exist (complete/fail/handler-abort/gate-open/gate-resolution/guard-chain/capability-release/compensating-unclaim/expire-gate-execute-step/lease-finalizer/mark-finalizer/seal-run-abandon)`, () => {
    const sites = findInvocationSites();
    expect(
      sites.length,
      sites.length !== EXPECTED_SITE_COUNT
        ? `Expected exactly ${EXPECTED_SITE_COUNT} '.settleStep(' invocation site(s), found ` +
            `${sites.length}:\n${sites.map((s) => `  ${s.file}:${s.line}: ${s.text}`).join('\n')}`
        : '',
    ).toBe(EXPECTED_SITE_COUNT);
  });

  it('every invocation site lives in execution-loop.ts, but the ONE seal_run in abandon-run.ts — none anywhere else (mcp-server stays clean)', () => {
    const sites = findInvocationSites();
    const elsewhere = sites.filter((s) => s.file !== MIGRATED_FILE);
    // (a) red when a settle call appears in any other file, or abandon-run.ts's seal leaves or
    // doubles; (b) prints each site found outside execution-loop.ts.
    expect(
      elsewhere.map((s) => s.file),
      `'.settleStep(' invocation site(s) OUTSIDE execution-loop.ts:\n` +
        elsewhere.map((s) => `  ${s.file}:${s.line}: ${s.text}`).join('\n'),
    ).toEqual([SEAL_RUN_FILE]);
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

    const first = applySettlement(fresh, delta, definition, { at: now });
    const second = applySettlement(fresh, delta, definition, { at: now });

    expect(first).toEqual(second);
    // Sanity: the fixture actually exercises the applied path (a vacuously-equal pair of
    // refusals would pass this check without proving anything about the transform's output).
    expect(first.applied).toBe(true);
  });
});
