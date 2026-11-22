// owed-undriven-592f1.test.ts — Q1 (#592) unit f1 (prompt q1-f1-owed-undriven.md), checks 1, 2 and 5
// at the shared predicate: `owed_undriven` fires on a `running` run with no step in progress, a
// definition in hand, work the engine owes (a guard to decide or an `auto` step to run) and no change
// for the owed threshold (default one minute) — and nowhere else.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import {
  classifyRunHealth,
  DEFAULT_OWED_THRESHOLD_MS,
  RUN_HEALTH_KINDS,
  RUN_HEALTH_STUCK_EXCLUDED,
  type RunHealthFinding,
} from './run-health.js';
import type { RunRecord, PendingGate } from '../types/run-record.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { writtenSnapshot } from './snapshot.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: ago(3_600_000),
    updated_at: ago(61_000),
    terminal_state: false,
    ...over,
  };
}

const def = (steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id: 'wf',
  name: 'wf',
  version: 1,
  steps,
});
const route: StepDefinition = {
  description: 'Route it.',
  execution: 'auto',
  handler: 'route_h',
  depends_on: [],
};
const AUTO = def({ route });
const GUARD = def({
  gated_step: { description: 'g', execution: 'agent', depends_on: [] },
  guard_after: {
    description: 'guard',
    execution: 'guard',
    depends_on: ['gated_step'],
    abort_unless: ['gated_step.status == "open"'],
  },
});
const AGENT = def({ ask: { description: 'Ask.', execution: 'agent', depends_on: [] } });
/** An `auto` step whose input its schema refuses (the run has no `n`): refused before its claim. */
const REFUSED = def({
  x: {
    description: 'X',
    execution: 'auto',
    depends_on: [],
    input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
  },
});

const owedOf = (findings: RunHealthFinding[]) => findings.filter((f) => f.kind === 'owed_undriven');
const kinds = (findings: RunHealthFinding[]) => findings.map((f) => f.kind);

describe('Q1 (#592) unit f1 — the word', () => {
  it('RUN_HEALTH_KINDS lists owed_undriven after cannot_go_on, and it selects a run for --stuck', () => {
    // (a) red when the word leaves the list, moves, or joins the kinds that never select a run;
    //     (b) prints its neighbours and the membership.
    const i = RUN_HEALTH_KINDS.indexOf('owed_undriven');
    expect({
      before: RUN_HEALTH_KINDS[i - 1],
      after: RUN_HEALTH_KINDS[i + 1],
      excluded: RUN_HEALTH_STUCK_EXCLUDED.has('owed_undriven'),
      threshold: DEFAULT_OWED_THRESHOLD_MS,
    }).toEqual({
      before: 'cannot_go_on',
      after: 'definition_unresolvable',
      excluded: false,
      threshold: 60_000,
    });
  });
});

describe('Q1 (#592) unit f1 — check 1: the finding fires', () => {
  it('(a) an auto step owed, unchanged for 61 s: one owed_undriven finding with the step, the reason, since, idle_ms and the evidence', () => {
    const run = makeRun();
    // (a) red when the branch is removed, or the finding's shape changes; (b) prints it.
    expect(owedOf(classifyRunHealth(writtenSnapshot(run, NOW), { definition: AUTO }))).toEqual([
      {
        kind: 'owed_undriven',
        step: 'route',
        reason: "the engine owes 'route', and the run last changed 1m ago (2026-07-20T11:58:59Z)",
        since: run.updated_at,
        idle_ms: 61_000,
        evidence: { owed: ['route'], owed_threshold_ms: 60_000 },
      },
    ]);
  });

  it('(b) a guard owed, unchanged for 61 s: owed_undriven names the guard, beside guard_awaiting_settlement', () => {
    const run = makeRun({ completed_steps: ['gated_step'] });
    const findings = classifyRunHealth(writtenSnapshot(run, NOW), { definition: GUARD });
    // (a) red when a guard is not counted as owed, or the two findings do not co-fire; (b) prints
    //     the kinds and the owed finding.
    expect({
      kinds: kinds(findings),
      step: owedOf(findings)[0]?.step,
      owed: owedOf(findings)[0]?.evidence,
    }).toEqual({
      kinds: ['guard_awaiting_settlement', 'owed_undriven'],
      step: 'guard_after',
      owed: { owed: ['guard_after'], owed_threshold_ms: 60_000 },
    });
  });
});

describe('Q1 (#592) unit f1 — check 2: each conjunct', () => {
  it('a step in progress, another auto step ready beside it: none', () => {
    // `other` is owed whatever `route` does: only the in-progress conjunct keeps the finding away.
    const d = def({ route, other: { ...route, description: 'Other.', handler: 'other_h' } });
    const run = makeRun({ in_progress_steps: ['route'], claims: { route: { deadline: null } } });
    // (a) red when the in-progress conjunct is dropped (`other` is then named); (b) prints the kinds.
    expect(kinds(classifyRunHealth(writtenSnapshot(run, NOW), { definition: d }))).not.toContain(
      'owed_undriven',
    );
  });

  it('nothing owed to the engine: a running run whose next step is an agent step gets none (never_claimed_idle at 24 h, as today)', () => {
    const run = makeRun({ updated_at: ago(25 * 3_600_000) });
    // (a) red when an agent step counts as owed; (b) prints the kinds.
    expect(kinds(classifyRunHealth(writtenSnapshot(run, NOW), { definition: AGENT }))).toEqual([
      'never_claimed_idle',
    ]);
  });

  it('a run whose only step is refused before its claim: cannot_go_on, not owed_undriven', () => {
    const run = makeRun();
    // (a) red when a refused step counts as owed; (b) prints the kinds.
    expect(kinds(classifyRunHealth(writtenSnapshot(run, NOW), { definition: REFUSED }))).toEqual([
      'cannot_go_on',
    ]);
  });

  it('no definition: none', () => {
    // (a) red when the finding fires without a definition; (b) prints the kinds.
    expect(kinds(classifyRunHealth(writtenSnapshot(makeRun(), NOW)))).toEqual([]);
  });

  it('unchanged for 59 s: none; for exactly 60 s: one', () => {
    const at = (ms: number) =>
      owedOf(
        classifyRunHealth(writtenSnapshot(makeRun({ updated_at: ago(ms) }), NOW), {
          definition: AUTO,
        }),
      ).length;
    // (a) red when the age gate is dropped or moved; (b) prints both counts.
    expect([at(59_000), at(60_000)]).toEqual([0, 1]);
  });

  it('a terminal run: none', () => {
    const run = makeRun({
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
    });
    // (a) red when the finding fires on an ended run; (b) prints the kinds.
    expect(kinds(classifyRunHealth(writtenSnapshot(run, NOW), { definition: AUTO }))).toEqual([]);
  });

  it('the owed threshold option: 0 flags a run owed for 5 s; 7 days omits one owed for two minutes', () => {
    const count = (updated: number, owedThresholdMs: number) =>
      owedOf(
        classifyRunHealth(writtenSnapshot(makeRun({ updated_at: ago(updated) }), NOW), {
          definition: AUTO,
          owedThresholdMs,
        }),
      ).length;
    // (a) red when the option does not reach the gate; (b) prints both counts.
    expect([count(5_000, 0), count(120_000, 7 * 86_400_000)]).toEqual([1, 0]);
  });
});

describe('Q1 (#592) unit f1 — check 5: beside the other findings', () => {
  it('capability: with no registry the step is owed (unknown) and the finding fires; with a registry that lacks its handler the step is not owed and it does not', () => {
    const run = makeRun();
    const empty = new ExtensionRegistry();
    // (a) red when the registry is not passed to the composition, or a step this program cannot run
    //     counts as owed; (b) prints both counts.
    expect([
      owedOf(classifyRunHealth(writtenSnapshot(run, NOW), { definition: AUTO })).length,
      owedOf(classifyRunHealth(writtenSnapshot(run, NOW), { definition: AUTO, registry: empty }))
        .length,
    ]).toEqual([1, 0]);
  });

  it('a gate-waiting run with an expired question and an auto step beside it, nothing in progress: gate_expired_awaiting_drive alone', () => {
    const gate: PendingGate = {
      gate_id: 'gate-1',
      step_name: 'approve',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: ago(3_600_000),
      expires_at: ago(1_800_000),
      on_expiry: 'settle_default',
      default_choice: 'approve',
    };
    const run = makeRun({ pending_gate: gate, run_phase: 'gate_waiting' });
    const d = def({
      approve: { description: 'Approve?', execution: 'agent', depends_on: [] },
      route,
    });
    // (a) red when the phase conjunct is dropped (the owed sibling then fires); (b) prints the kinds.
    expect(kinds(classifyRunHealth(writtenSnapshot(run, NOW), { definition: d }))).toEqual([
      'gate_expired_awaiting_drive',
    ]);
  });

  it('a failed drive older than a minute: drive_failing and owed_undriven together', () => {
    const run = makeRun({
      updated_at: ago(120_000),
      drive_failures: {
        first_failed_at: ago(120_000),
        total: 1,
        entries: [
          {
            at: ago(120_000),
            step: '',
            provider: 'unknown',
            error_class: 'startup_failure',
            message: 'no key',
            elapsed_ms: 5,
            evidence_count: 0,
          },
        ],
      },
    });
    // (a) red when one hides the other; (b) prints the kinds.
    expect(kinds(classifyRunHealth(writtenSnapshot(run, NOW), { definition: AUTO }))).toEqual([
      'drive_failing',
      'owed_undriven',
    ]);
  });
});
