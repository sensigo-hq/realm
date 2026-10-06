// advance-expiry-625.test.ts — issue #625 PR-2a, decision C95: an open question whose time is up and
// that declares `on_expiry` is owed engine work. `advanceRun` carries it out first — the same
// `enactExpiredGateIfDue` `executeStep`'s Step 1.5 calls, its disclosure in the reply's `warnings` —
// then runs what it made owed. The run's view reports it when given a clock (`describePending`'s
// `now`): the act is `advance_run`, the status `advance_owed`. A question with no `on_expiry` (a
// finding only), or not yet expired, is never touched.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceRun, buildNextActions, executeStep } from './execution-loop.js';
import {
  describePending,
  describeNext,
  composeNextActionsStatusWord,
  dueExpiry,
  owedList,
} from './pending.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

type OnExpiry = 'settle_default' | 'abort' | undefined;

/** `confirm` (a gate, 60 s, `on_expiry` as given), then a bare `auto` step `after`. */
function def(onExpiry: OnExpiry): WorkflowDefinition {
  return {
    id: `ae-${onExpiry ?? 'finding'}`,
    name: 'advance expiry',
    version: 1,
    steps: {
      confirm: {
        description: 'Confirm.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          timeout_seconds: 60,
          ...(onExpiry !== undefined ? { on_expiry: onExpiry } : {}),
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: { description: 'After.', execution: 'auto', depends_on: ['confirm'] },
    },
  };
}

describe('#625 PR-2a, C95 — advance carries out a due expiry, and the view names it as owed', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-ae-625-')));
  });

  /** A run at its open question; returns the run id, the gate id, and a clock past its expiry. */
  async function atGate(d: WorkflowDefinition) {
    const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    const gate = (await store.get(run.id)).pending_gate!;
    return {
      runId: run.id,
      gateId: gate.gate_id,
      past: new Date(new Date(gate.expires_at!).getTime() + 5_000),
      before: new Date(new Date(gate.expires_at!).getTime() - 5_000),
    };
  }

  it('settle_default through advanceRun: the default is settled, the owed step runs, the run completes; the disclosure is in warnings', async () => {
    const d = def('settle_default');
    const { runId, gateId, past } = await atGate(d);
    const reply = await advanceRun(store, d, { runId, now: past });
    const after = await store.get(runId);
    // (a) red when advanceRun no longer carries the expiry out first (nothing runs, the question
    // stays open); (b) prints the record's state.
    expect({
      phase: after.run_phase,
      gate: after.pending_gate?.gate_id,
      choice: after.settled?.['confirm']?.choice,
      resolved_by: after.settled?.['confirm']?.resolved_by,
      completed: after.completed_steps,
    }).toEqual({
      phase: 'completed',
      gate: undefined,
      choice: 'approve',
      resolved_by: 'timeout',
      completed: ['confirm', 'after'],
    });
    // (a) red when the disclosure is dropped or names the wrong call; (b) prints the warnings.
    expect(reply.warnings).toContain(
      `gate '${gateId}' on 'confirm' had expired — this advanceRun call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: advanceRun).`,
    );
    // (a) red when the owed step the expiry made is not run in the same call; (b) prints the steps.
    expect(reply.chained_auto_steps?.map((c) => c.step)).toEqual(['after']);
  });

  it('abort through advanceRun: the run ends aborted, nothing after the question runs; the hint says the expiry was carried out', async () => {
    const d = def('abort');
    const { runId, gateId, past } = await atGate(d);
    const reply = await advanceRun(store, d, { runId, now: past });
    const after = await store.get(runId);
    // (a) red when the abort is not carried out; (b) prints the record's state.
    expect({
      phase: after.run_phase,
      terminal: after.terminal_state,
      completed: after.completed_steps,
    }).toEqual({
      phase: 'aborted',
      terminal: true,
      completed: [],
    });
    // (a) red when the hint says "already terminal; nothing ran" of a run this call ended; (b) prints it.
    expect(reply.context_hint).toBe(
      `Run '${runId}': its expired question was carried out as declared (see warnings); no step ran. The run ended (aborted).`,
    );
    expect(reply.warnings).toContain(
      `gate '${gateId}' on 'confirm' had expired — this advanceRun call first carried out its declared abort: the run ended (enacted_via: advanceRun).`,
    );
  });

  it('CONTROL — not yet expired: never touched; nothing ran, the question stays open', async () => {
    const d = def('settle_default');
    const { runId, gateId, before } = await atGate(d);
    const reply = await advanceRun(store, d, { runId, now: before });
    const after = await store.get(runId);
    // (a) red when an unexpired question is carried out; (b) prints the record's gate and the hint.
    expect({
      gate: after.pending_gate?.gate_id,
      warnings: reply.warnings,
      hint: reply.context_hint,
    }).toEqual({
      gate: gateId,
      warnings: [],
      // decision C103: the open question is named, with its choices and the act.
      hint: `Run '${runId}': nothing ran. Waiting on the question on step 'confirm' (choices: approve, reject) — answer it with submit_human_response.`,
    });
  });

  it('CONTROL — a question with no on_expiry (a finding only): never touched, even past its time', async () => {
    const d = def(undefined);
    const { runId, gateId, past } = await atGate(d);
    const reply = await advanceRun(store, d, { runId, now: past });
    const after = await store.get(runId);
    // (a) red when a finding-only question is settled or aborted; (b) prints the gate and the warnings.
    expect({
      gate: after.pending_gate?.gate_id,
      phase: after.run_phase,
      warnings: reply.warnings,
    }).toEqual({
      gate: gateId,
      phase: 'gate_waiting',
      warnings: [],
    });
    // (a) red when the view offers an act for it; (b) prints the view's act.
    expect(describePending(d, after, undefined, past).act).toBeUndefined();
  });

  it('the view, given a clock: a due expiry is owed engine work — the advance_run act, advance_owed, its words; before its time is up, nothing', async () => {
    const d = def('settle_default');
    const { runId, gateId, past, before } = await atGate(d);
    const run = await store.get(runId);
    const view = describePending(d, run, undefined, past);
    // (a) red when the view no longer reports a due expiry; (b) prints it.
    expect(view.expiry_due).toEqual({
      gate_id: gateId,
      step: 'confirm',
      on_expiry: 'settle_default',
    });
    expect(composeNextActionsStatusWord(view)).toBe('advance_owed');
    // (a) red when the act or its words change; (b) prints them.
    expect(view.act?.instruction).toEqual({
      tool: 'advance_run',
      params: { run_id: runId },
      call_with: { run_id: runId },
    });
    expect(view.act?.human_readable).toBe(
      "Call advance_run to carry out the expired question on 'confirm' (its declared settle_default), then run what it leaves owed. It runs with this server's extensions and environment.",
    );
    expect(view.act?.orientation).toBe(
      "Run is active. Engine work is owed: the expired question on 'confirm' (its declared settle_default).",
    );
    expect(owedList(view)).toBe("the expired question on 'confirm' (its declared settle_default)");
    expect(describeNext(view, run)).toBe(
      " Owed to the engine: the expired question on 'confirm' (its declared settle_default) — call advance_run.",
    );
    expect(buildNextActions(d, run, undefined, past).map((a) => a.instruction?.tool)).toEqual([
      'advance_run',
    ]);
    // (a) red when a view before the expiry reads one; (b) prints the acts.
    expect(describePending(d, run, undefined, before).act).toBeUndefined();
    expect(dueExpiry(run.pending_gate, before)).toBeUndefined();
  });
});
