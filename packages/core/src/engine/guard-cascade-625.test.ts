// guard-cascade-625.test.ts — issue #625 (PR-1): a guard is settled by the write that makes it
// eligible, and every reply and every printed line about it is minted once.
//
// What these cells pin, through the REAL engine and a REAL JsonFileStore:
//   - the three guard-ending sentences, `guards` and `ended_by` (with `reason`) on the ANSWER path
//     and on the STEP path — one cell per sentence per path;
//   - a guard that passes and lets the run go on: `guards` only, the reply's own sentence kept;
//   - a failed step's own write settles the guard it leaves eligible, and the reply stays the
//     step's failure;
//   - the cascade never makes an answer unrecordable (`when: 42`, `abort_unless: [42]`, and a
//     `when` whose throwing leaf sits behind a leaf that is false before the answer);
//   - an expiry reply keeps BOTH facts, and a late answer carries the typed fact
//     `answer_recorded: false` — never a person's replayed answer;
//   - a store WITHOUT `settleStep` settles no guard in the write (the legacy two-write shape);
//   - the lines a surface prints (`describeAnswerEnding`, `describeGuardLines`, …) and the facts a
//     late-answer line reads from the record (`lateAnswerOutcome`).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { declareReleaseLine } from '../release-line.js';
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import {
  advanceRun,
  describeAnswerEnding,
  describeEndedBy,
  describeGuardEndingLines,
  describeGuardLines,
  executeChain,
  executeStep,
  guardEndingOf,
  guardPassedLine,
  lateAnswerOutcome,
  submitHumanResponse,
} from './execution-loop.js';
import { applySettlement } from './settlement.js';
import { captureEvidence } from '../evidence/snapshot.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { StepHandler } from '../extensions/step-handler.js';
import type {
  RunStore,
  CreateRunOptions,
  LoadBearingRunRecordField,
} from '../store/store-interface.js';
import type { RunRecord } from '../types/run-record.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';
import type { ResponseEnvelope } from '../types/response-envelope.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const echo: StepDispatcher = async (_name, input) => ({ ...input });

/** The sentence a late answer whose choice matched the expiry's default has always carried. */
const LATE_SAME_CHOICE =
  'the outcome matches your choice, but it was settled by timeout; your response was not recorded.';

type GateConfig = NonNullable<StepDefinition['gate']>;

/**
 * gate `confirm` → guard `check` (reads the gate's answer) [→ more steps]. `guard` overrides the
 * guard's fields; `gate` adds to the gate's config (e.g. an expiry); `more` adds steps.
 */
function gateThenGuard(opts?: {
  guard?: Partial<StepDefinition>;
  gate?: Partial<GateConfig>;
  more?: Record<string, StepDefinition>;
}): WorkflowDefinition {
  return {
    id: 'guard-cascade-answer-wf',
    name: 'Guard cascade — answer path',
    version: 1,
    steps: {
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'], ...opts?.gate },
      },
      check: {
        description: 'Check',
        execution: 'guard',
        depends_on: ['confirm'],
        abort_unless: ["confirm.choice == 'approve'"],
        ...opts?.guard,
      },
      ...opts?.more,
    },
  };
}

/** step `work` → guard `check` (reads the step's output) [→ more steps]. */
function stepThenGuard(opts?: {
  guard?: Partial<StepDefinition>;
  more?: Record<string, StepDefinition>;
}): WorkflowDefinition {
  return {
    id: 'guard-cascade-step-wf',
    name: 'Guard cascade — step path',
    version: 1,
    steps: {
      work: { description: 'Work', execution: 'agent', depends_on: [] },
      check: {
        description: 'Check',
        execution: 'guard',
        depends_on: ['work'],
        abort_unless: ['work.ok == true'],
        ...opts?.guard,
      },
      ...opts?.more,
    },
  };
}

const FINISH: Record<string, StepDefinition> = {
  finish: { description: 'Finish', execution: 'agent', depends_on: ['check'] },
};

/** A gate that expires one second after it opens and settles `defaultChoice`. */
const expiring = (defaultChoice: string): Partial<GateConfig> => ({
  timeout_seconds: 1,
  on_expiry: 'settle_default',
  default_choice: defaultChoice,
});

async function withStore<T>(fn: (store: JsonFileStore) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'realm-guard-cascade-625-'));
  try {
    return await fn(new JsonFileStore(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Creates a run and opens the gate on `confirm`. Returns the run id, the gate id and an instant
 *  past the gate's expiry (meaningful only for an expiring gate). */
async function openGate(
  store: RunStore,
  def: WorkflowDefinition,
): Promise<{ runId: string; gateId: string; afterExpiry: Date }> {
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  const opened = await executeStep(store, def, {
    runId: run.id,
    command: 'confirm',
    input: {},
    dispatcher: echo,
  });
  if (opened.status !== 'confirm_required') {
    throw new Error(`fixture: the gate did not open (status ${opened.status})`);
  }
  const gate = (await store.get(run.id)).pending_gate!;
  const afterExpiry =
    gate.expires_at !== undefined
      ? new Date(new Date(gate.expires_at).getTime() + 60_000)
      : new Date();
  return { runId: run.id, gateId: gate.gate_id, afterExpiry };
}

/** Which membership array, if any, holds `step`. */
function membershipOf(run: RunRecord, step: string): string {
  if (run.completed_steps.includes(step)) return 'completed';
  if (run.failed_steps.includes(step)) return 'failed';
  if (run.skipped_steps.includes(step)) return 'skipped';
  return 'none';
}

/** The step names a reply's next actions offer. */
const offeredSteps = (reply: ResponseEnvelope): unknown[] =>
  reply.next_actions.map((a) => a.instruction?.params['command']);

/** The guard's own evidence entries on a record. */
const guardEntries = (run: RunRecord, step = 'check') =>
  run.evidence.filter((e) => e.step_id === step);

/**
 * A store that does NOT declare `settleStep` — the legacy shape every engine site falls back to
 * (wraps a real JsonFileStore; a core test cannot import realm-testing's in-memory store).
 */
class NoSettleStepStore implements RunStore {
  // issue #620 PR-C: a test double declares this realm's release line.
  static {
    declareReleaseLine(this);
  }
  readonly persistsClaims: boolean;
  readonly persistedRunRecordFields?: ReadonlySet<LoadBearingRunRecordField>;
  constructor(private readonly inner: JsonFileStore) {
    this.persistsClaims = inner.persistsClaims;
    this.persistedRunRecordFields = inner.persistedRunRecordFields;
  }
  create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
    return this.inner.create(options);
  }
  get(runId: string): Promise<RunRecord> {
    return this.inner.get(runId);
  }
  update(record: RunRecord): Promise<RunRecord> {
    return this.inner.update(record);
  }
  list(workflowId?: string): Promise<RunRecord[]> {
    return this.inner.list(workflowId);
  }
  claimStep(runId: string, stepName: string, definition: WorkflowDefinition): Promise<RunRecord> {
    return this.inner.claimStep(runId, stepName, definition);
  }
  // settleStep intentionally OMITTED.
}

// ---------------------------------------------------------------------------
// The ANSWER path
// ---------------------------------------------------------------------------

describe('issue #625 — an answer settles the guard it makes eligible, in its own write', () => {
  it('a guard that ABORTS: the reply says "Guard step \'check\' aborted the run.", names the guard in ended_by with its reason, and stays ok', async () => {
    await withStore(async (store) => {
      const def = gateThenGuard({ guard: { abort_message: 'Not approved — stopping.' } });
      const { runId, gateId } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'reject' });

      // (a) red when the answer's status follows the guard's outcome instead of the answer's own
      //     (the answer WAS recorded); (b) prints the status word.
      expect(reply.status).toBe('ok');
      // (a) red when the store stops passing `cascadeGuards`, or the reply rule drops `guards`;
      //     (b) prints the `guards` value.
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'abort' }]);
      // (a) red when `ended_by` takes the gate step's name or arm, or loses `reason`;
      //     (b) prints the `ended_by` object.
      expect(reply.ended_by).toEqual({
        arm: 'guard_abort',
        step: 'check',
        reason: 'Not approved — stopping.',
      });
      // (a) red when the sentence is replaced (e.g. by "Run completed (phase: 'aborted')") or
      //     reworded; (b) prints the sentence.
      expect(reply.context_hint).toBe("Guard step 'check' aborted the run.");
      // (a) red when the reply keeps the gate's preview/choice as data, or keeps next actions on
      //     an ended run; (b) prints the two values.
      expect(reply.data).toEqual({});
      expect(reply.next_actions).toEqual([]);
      // (a) red when the reply's evidence is not the guard's own entry; (b) prints step ids.
      expect(reply.evidence.map((e) => e.step_id)).toEqual(['check']);
      // (a) red when the reply reports the pre-guard phase; (b) prints the phase.
      expect(reply.run_phase).toBe('aborted');
      // The reply's command is still the gate's step — `ended_by` is where the guard is named.
      // (a) red when the command is rewritten to the guard; (b) prints the command.
      expect(reply.command).toBe('confirm');

      const record = await store.get(runId);
      // ONE write: the answer and the guard's settlement share the same version bump.
      // (a) red when the guard is settled by a second write; (b) prints the reply's and the
      //     record's versions.
      expect(record.version).toBe(reply.run_version);
      // (a) red when the answer is lost or the guard is left unsettled; (b) prints the values.
      expect(record.settled?.['confirm']?.choice).toBe('reject');
      expect(membershipOf(record, 'check')).toBe('skipped');
      expect(record.sealed_by).toEqual({ arm: 'guard_abort', step: 'check' });
      // A guard writes no `settled` entry (the published law GUARD_NO_ENTRY).
      // (a) red when the cascade writes one; (b) prints the entry.
      expect(record.settled?.['check']).toBeUndefined();
      // ONE evidence entry for the guard.
      // (a) red when the guard is evaluated or recorded twice; (b) prints the count.
      expect(guardEntries(record)).toHaveLength(1);
    });
  });

  it('a guard that ABORTS with no authored abort_message: ended_by carries no reason', async () => {
    await withStore(async (store) => {
      const def = gateThenGuard();
      const { runId, gateId } = await openGate(store, def);
      const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'reject' });
      // (a) red when a reason is fabricated for an abort whose author wrote none (e.g. the
      //     default evidence error sentence is used); (b) prints the `ended_by` object.
      expect(reply.ended_by).toEqual({ arm: 'guard_abort', step: 'check' });
    });
  });

  it('a guard that cannot RESOLVE a path: the reply says "…failed with a resolution error. Run is terminated." and the reason is the guard\'s recorded error', async () => {
    await withStore(async (store) => {
      const def = gateThenGuard({ guard: { abort_unless: ['nope.field == true'] } });
      const { runId, gateId } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'approve' });

      // (a) red when a failed guard turns the recorded answer into an error reply;
      //     (b) prints the status word.
      expect(reply.status).toBe('ok');
      // (a) red when the cascade does not settle the guard; (b) prints `guards`.
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'resolution_error' }]);
      // (a) red when the sentence is replaced or reworded; (b) prints the sentence.
      expect(reply.context_hint).toBe(
        "Guard step 'check' failed with a resolution error. Run is terminated.",
      );
      // (a) red when `reason` is dropped, or is not the guard's own recorded evidence error;
      //     (b) prints the `ended_by` object.
      expect(reply.ended_by).toEqual({
        arm: 'guard_resolution_error',
        step: 'check',
        reason:
          "Guard resolution error: unresolvable path 'nope.field' (condition: nope.field == true)",
      });
      // (a) red when the phase is not the failed seal; (b) prints the phase.
      expect(reply.run_phase).toBe('failed');
      const record = await store.get(runId);
      // (a) red when the seal sentence loses the path; (b) prints the sentence.
      expect(record.terminal_reason).toBe(
        "Guard step 'check' failed: unresolvable path 'nope.field'",
      );
    });
  });

  it('a guard that PASSES and completes the run: the reply says "…passed and completed the run." and ended_by carries no reason', async () => {
    await withStore(async (store) => {
      const def = gateThenGuard();
      const { runId, gateId } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'approve' });

      // (a) red when the cascade does not settle the guard; (b) prints `guards`.
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'pass' }]);
      // (a) red when the sentence is replaced or reworded; (b) prints the sentence.
      expect(reply.context_hint).toBe("Guard step 'check' passed and completed the run.");
      // (a) red when a reason is invented for a completing pass, or the gate's arm is used;
      //     (b) prints the `ended_by` object.
      expect(reply.ended_by).toEqual({ arm: 'guard_pass_complete', step: 'check' });
      // (a) red when the reply reports the pre-guard phase; (b) prints the phase.
      expect(reply.run_phase).toBe('completed');
      expect(reply.status).toBe('ok');
    });
  });

  it('a guard that PASSES and lets the run go on: the reply gains guards only — its own sentence, data and next action stay', async () => {
    await withStore(async (store) => {
      const def = gateThenGuard({ more: FINISH });
      const { runId, gateId } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'approve' });

      // (a) red when the cascade does not settle the guard; (b) prints `guards`.
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'pass' }]);
      // (a) red when a non-ending guard is reported as having ended the run; (b) prints the value.
      expect(reply.ended_by).toBeUndefined();
      // (a) red when the guard's sentence replaces the answer's own on a run that goes on;
      //     (b) prints the sentence.
      expect(reply.context_hint).toBe(
        "Gate 'confirm' resolved with choice 'approve'. Ready for the agent: 'finish'.",
      );
      // (a) red when the reply's data is emptied on a run that goes on; (b) prints the choice.
      expect(reply.data['choice']).toBe('approve');
      // The step the guard unlocked is offered by the SAME reply — no further call names the guard.
      // (a) red when the next action is computed before the guard was settled; (b) prints the
      //     offered step names.
      expect(offeredSteps(reply)).toEqual(['finish']);
      // (a) red when the removed #279 advisory comes back; (b) prints the warnings.
      expect(reply.warnings.filter((w) => w.includes('converges'))).toEqual([]);
      const record = await store.get(runId);
      // (a) red when the guard is left eligible; (b) prints its membership.
      expect(membershipOf(record, 'check')).toBe('completed');
      expect(record.terminal_state).toBe(false);
    });
  });

  it('each finalizer the ending selects runs in the answering call, after the write — the reply names the guard, the record has the outcome', async () => {
    await withStore(async (store) => {
      const def = gateThenGuard({
        guard: { abort_message: 'Not approved — stopping.' },
        more: {
          notify: {
            description: 'Notify',
            execution: 'finalizer',
            on_outcome: 'abort',
            handler: 'notify-handler',
          },
        },
      });
      let calls = 0;
      const handler: StepHandler = {
        id: 'notify-handler',
        execute: async () => {
          calls += 1;
          return { data: {} };
        },
      };
      const registry = new ExtensionRegistry();
      registry.register('handler', 'notify-handler', handler);
      const { runId, gateId } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, {
        runId,
        gateId,
        choice: 'reject',
        registry,
      });
      const record = await store.get(runId);

      // (a) red when the guard-caused ending does not drain the finalizer its outcome selects
      //     (the site drains when the write transitioned); (b) prints the call count.
      expect(calls).toBe(1);
      expect(record.finalizer_ledger?.['notify']?.status).toBe('completed');
      // The reply's evidence stays the GUARD's entry — not the finalizer's, appended by the drain.
      // (a) red when the evidence is read after the drain; (b) prints step ids.
      expect(reply.evidence.map((e) => e.step_id)).toEqual(['check']);
      // What a surface prints after this answer: the ending first, the reason, then the finalizer.
      // (a) red when the composer drops a line, reorders them, or rewords the finalizer line;
      //     (b) prints the lines.
      expect(describeAnswerEnding(reply, record)).toEqual([
        "Guard step 'check' aborted the run.",
        'Reason: Not approved — stopping.',
        "finalizer 'notify': completed",
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// The STEP path
// ---------------------------------------------------------------------------

describe("issue #625 — a finished step's own write settles the guard it makes eligible", () => {
  const drive = (store: RunStore, def: WorkflowDefinition, runId: string, output: unknown) =>
    executeChain(store, def, {
      runId,
      command: 'work',
      input: {},
      dispatcher: async () => output as Record<string, unknown>,
    });

  it("a guard that ABORTS: the step's reply says \"Guard step 'check' aborted the run.\" — never \"Run completed (phase: 'aborted')\"", async () => {
    await withStore(async (store) => {
      const def = stepThenGuard({ guard: { abort_message: 'Work was not ok.' } });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const reply = await drive(store, def, run.id, { ok: false });

      // (a) red when the step's own "Run completed (phase: …)" sentence is kept; (b) prints it.
      expect(reply.context_hint).toBe("Guard step 'check' aborted the run.");
      // (a) red when the reply rule is not applied on the step path; (b) prints the values.
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'abort' }]);
      expect(reply.ended_by).toEqual({
        arm: 'guard_abort',
        step: 'check',
        reason: 'Work was not ok.',
      });
      // As the chain has always answered for a guard that ended a run.
      // (a) red when the step's own output or evidence is kept on a guard-ended reply;
      //     (b) prints the values.
      expect(reply.status).toBe('ok');
      expect(reply.data).toEqual({});
      expect(reply.evidence.map((e) => e.step_id)).toEqual(['check']);
      expect(reply.next_actions).toEqual([]);
      expect(reply.run_phase).toBe('aborted');
      // The published field keeps listing every step the engine ran on its own.
      // (a) red when the cascaded guard is not appended, or carries a phase other than the one
      //     it sealed; (b) prints the list.
      expect(reply.chained_auto_steps).toEqual([{ step: 'check', run_phase: 'aborted' }]);
      const record = await store.get(run.id);
      // (a) red when the step and its guard are two writes; (b) prints both versions.
      expect(record.version).toBe(reply.run_version);
      expect(guardEntries(record)).toHaveLength(1);
    });
  });

  it('a guard that cannot RESOLVE a path: "…failed with a resolution error. Run is terminated."', async () => {
    await withStore(async (store) => {
      const def = stepThenGuard({ guard: { abort_unless: ['work.missing == true'] } });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const reply = await drive(store, def, run.id, { ok: true });

      // (a) red when the sentence is replaced or reworded; (b) prints the sentence.
      expect(reply.context_hint).toBe(
        "Guard step 'check' failed with a resolution error. Run is terminated.",
      );
      // (a) red when `reason` is dropped or is not the guard's recorded error; (b) prints it.
      expect(reply.ended_by).toEqual({
        arm: 'guard_resolution_error',
        step: 'check',
        reason:
          "Guard resolution error: unresolvable path 'work.missing' (condition: work.missing == true)",
      });
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'resolution_error' }]);
      expect(reply.run_phase).toBe('failed');
      expect(reply.chained_auto_steps).toEqual([{ step: 'check', run_phase: 'failed' }]);
    });
  });

  it('a guard that PASSES and completes the run: "…passed and completed the run."', async () => {
    await withStore(async (store) => {
      const def = stepThenGuard();
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const reply = await drive(store, def, run.id, { ok: true });

      // (a) red when the sentence is replaced or reworded; (b) prints the sentence.
      expect(reply.context_hint).toBe("Guard step 'check' passed and completed the run.");
      // (a) red when a reason is invented for a completing pass; (b) prints the object.
      expect(reply.ended_by).toEqual({ arm: 'guard_pass_complete', step: 'check' });
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'pass' }]);
      expect(reply.run_phase).toBe('completed');
      expect(reply.chained_auto_steps).toEqual([{ step: 'check', run_phase: 'completed' }]);
    });
  });

  it('a guard that PASSES and lets the run go on: the step keeps its own output and sentence, and the next step is offered', async () => {
    await withStore(async (store) => {
      const def = stepThenGuard({ more: FINISH });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const reply = await drive(store, def, run.id, { ok: true });

      // (a) red when the cascade does not settle the guard; (b) prints the values.
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'pass' }]);
      expect(reply.ended_by).toBeUndefined();
      // (a) red when a non-ending guard empties the step's own reply; (b) prints the values.
      expect(reply.data).toEqual({ ok: true });
      expect(reply.context_hint).toBe("Step 'work' completed. Ready for the agent: 'finish'.");
      expect(offeredSteps(reply)).toEqual(['finish']);
      // (a) red when a guard that let the run go on is listed with a phase other than 'running';
      //     (b) prints the list.
      expect(reply.chained_auto_steps).toEqual([{ step: 'check', run_phase: 'running' }]);
    });
  });

  it("an AUTO step whose write settles two guards: its own entry and the guard that let the run go on carry 'running'; the guard that ended the run carries the sealed phase", async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'guard-cascade-auto-chain-wf',
        name: 'Guard cascade — auto step, two guards',
        version: 1,
        steps: {
          fetch: { description: 'Fetch', execution: 'auto', depends_on: [] },
          first: {
            description: 'First',
            execution: 'guard',
            depends_on: ['fetch'],
            abort_unless: ['fetch.ok == true'],
          },
          second: {
            description: 'Second',
            execution: 'guard',
            depends_on: ['first'],
            abort_unless: ['fetch.ready == true'],
          },
        },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const reply = await executeChain(store, def, {
        runId: run.id,
        command: 'fetch',
        input: {},
        dispatcher: async () => ({ ok: true, ready: false }),
      });

      // (a) red when the loop stops after one guard, or the order is not the order settled;
      //     (b) prints `guards`.
      expect(reply.guards).toEqual([
        { step: 'first', outcome: 'pass' },
        { step: 'second', outcome: 'abort' },
      ]);
      // (a) red when the auto step's own entry carries the post-guard phase ('aborted') — on a
      //     store without the cascade it was listed 'running', then the guard 'aborted';
      //     (b) prints the list.
      expect(reply.chained_auto_steps).toEqual([
        { step: 'fetch', run_phase: 'running' },
        { step: 'first', run_phase: 'running' },
        { step: 'second', run_phase: 'aborted' },
      ]);
      // (a) red when `ended_by` names the first guard or the step; (b) prints the object.
      expect(reply.ended_by).toEqual({ arm: 'guard_abort', step: 'second' });
      const record = await store.get(run.id);
      // (a) red when the step and its two guards are more than one write; (b) prints versions.
      expect(record.version).toBe(reply.run_version);
    });
  });

  it("a FAILED step's own write settles the guard it leaves eligible; the reply stays the step's failure and gains guards and ended_by only", async () => {
    await withStore(async (store) => {
      // `check` runs whether `work` succeeded or not (`all_done`) and has nothing to abort on.
      const def = stepThenGuard({ guard: { trigger_rule: 'all_done', abort_unless: [] } });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const reply = await executeChain(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => {
          throw new Error('work exploded');
        },
      });

      // The step's failure is still the reply.
      // (a) red when the guard's ending overwrites a failed step's status, errors, evidence or
      //     sentence; (b) prints each value.
      expect(reply.status).toBe('error');
      expect(reply.errors.join(' ')).toContain('work exploded');
      expect(reply.evidence.map((e) => e.step_id)).toEqual(['work']);
      expect(reply.context_hint).toBe("Step 'work' failed. Run is terminated.");
      // …and it says what its own write then settled.
      // (a) red when a failed step's write does not settle the guard it leaves eligible, or the
      //     reply omits it; (b) prints the values.
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'pass' }]);
      expect(reply.ended_by).toEqual({ arm: 'guard_pass_complete', step: 'check' });
      // A non-ok reply builds no chained_auto_steps (the chain returns it as it is).
      // (a) red when the chain appends to a failed step's reply; (b) prints the value.
      expect(reply.chained_auto_steps).toBeUndefined();
      const record = await store.get(run.id);
      // (a) red when the guard is left eligible after the failed step; (b) prints the values.
      expect(membershipOf(record, 'check')).toBe('completed');
      expect(record.failed_steps).toEqual(['work']);
      expect(record.run_phase).toBe('completed');
      expect(record.sealed_by).toEqual({ arm: 'guard_pass_complete', step: 'check' });
    });
  });
});

// ---------------------------------------------------------------------------
// The cascade never makes a write unrecordable
// ---------------------------------------------------------------------------

describe('issue #625 — a guard that cannot be evaluated is settled as a resolution error; the answer is still recorded', () => {
  /** A guard field the loader would refuse — a hand-built or older registered definition. */
  const unevaluable = (field: 'when' | 'abort_unless', value: unknown): Partial<StepDefinition> =>
    ({ [field]: value }) as Partial<StepDefinition>;

  it('when: 42 on a guard — the answer is recorded, the guard fails with its \'when\' named, never "unresolvable path"', async () => {
    await withStore(async (store) => {
      const def = gateThenGuard({ guard: unevaluable('when', 42) });
      const { runId, gateId } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'approve' });

      // (a) red when the `when` handling is removed: the answer's write throws and the reply is
      //     ENGINE_STORE_FAILED "Failed to persist gate response" (what it was before #625);
      //     (b) prints the status and the errors.
      expect(reply.status).toBe('ok');
      expect(reply.errors).toEqual([]);
      // (a) red when the guard is skipped instead of settled; (b) prints `guards`.
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'resolution_error' }]);
      const record = await store.get(runId);
      // (a) red when the answer itself is lost; (b) prints the recorded choice.
      expect(record.settled?.['confirm']?.choice).toBe('approve');
      const [entry] = guardEntries(record);
      // The cause is the whole diagnostic: what could not be evaluated, and the thrown message.
      // (a) red when the cause names the wrong key or drops the thrown message; (b) prints the
      //     guard's recorded error.
      expect(entry?.error).toMatch(/^its 'when' could not be evaluated: .+/);
      // (a) red when the reply's reason is not the guard's own recorded error; (b) prints both.
      expect(reply.ended_by).toEqual({
        arm: 'guard_resolution_error',
        step: 'check',
        reason: entry?.error,
      });
      // The seal sentence has ONE mint, and for this guard it quotes the cause — a path sentence
      // here would be false (no path failed to resolve).
      // (a) red when the arm's sentence ignores `cause`; (b) prints the sentence.
      expect(record.terminal_reason).toBe(`Guard step 'check' failed: ${entry?.error}`);
      expect(record.terminal_reason).not.toContain('unresolvable path');
      expect(record.sealed_by).toEqual({ arm: 'guard_resolution_error', step: 'check' });
    });
  });

  it("abort_unless: [42] on a guard — the answer is recorded, the guard fails with its 'abort_unless' named", async () => {
    await withStore(async (store) => {
      const def = gateThenGuard({ guard: unevaluable('abort_unless', [42]) });
      const { runId, gateId } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'approve' });

      // (a) red when the cascade lets the evaluation's throw escape; (b) prints status and errors.
      expect(reply.status).toBe('ok');
      expect(reply.errors).toEqual([]);
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'resolution_error' }]);
      const record = await store.get(runId);
      const [entry] = guardEntries(record);
      // (a) red when the cause names the wrong key; (b) prints the recorded error.
      expect(entry?.error).toMatch(/^its 'abort_unless' could not be evaluated: .+/);
      expect(record.terminal_reason).toBe(`Guard step 'check' failed: ${entry?.error}`);
      expect(record.settled?.['confirm']?.choice).toBe('approve');
    });
  });

  it('a when whose throwing leaf sits BEHIND a leaf that is false before the answer — still recorded (each leaf is checked on its own)', async () => {
    await withStore(async (store) => {
      // Before the answer `confirm.choice == 'approve'` is false, so an evaluation that stops at
      // the first false leaf never reaches 42 — and would only throw inside the answer's own
      // write, once the first leaf is true.
      const def = gateThenGuard({
        guard: unevaluable('when', ["confirm.choice == 'approve'", 42]),
      });
      const { runId, gateId } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'approve' });

      // (a) red when the check for a throwing `when` evaluates the clause as a whole (stopping at
      //     the first false leaf) instead of leaf by leaf; (b) prints status and errors.
      expect(reply.status).toBe('ok');
      expect(reply.errors).toEqual([]);
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'resolution_error' }]);
    });
  });

  it('a second failed step beside the guard: the multi-failure sentence quotes the cause once', async () => {
    await withStore(async (store) => {
      const def: WorkflowDefinition = {
        id: 'guard-cascade-multi-failure-wf',
        name: 'Guard cascade — a failed step and an unevaluable guard',
        version: 1,
        steps: {
          work: { description: 'Work', execution: 'agent', depends_on: [] },
          check: {
            description: 'Check',
            execution: 'guard',
            depends_on: ['work'],
            trigger_rule: 'all_done',
            abort_unless: [],
            ...unevaluable('when', 42),
          },
        },
      };
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeChain(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: async () => {
          throw new Error('work exploded');
        },
      });
      const record = await store.get(run.id);
      const cause = guardEntries(record)[0]?.error;
      // (a) red when the store's seal check refuses the cascade's own seal, or the multi-failure
      //     sentence drops the guard's cause; (b) prints the sentence.
      expect(record.failed_steps).toEqual(['work', 'check']);
      expect(record.terminal_reason).toMatch(/^2 steps failed: check \("its 'when' could not/);
      expect(record.terminal_reason).toContain(`check ("${cause}")`);
    });
  });

  it('WITHOUT the option the transform throws exactly as before; WITH it the same delta applies', async () => {
    const def = gateThenGuard({ guard: unevaluable('when', 42) });
    const fresh: RunRecord = {
      id: 'pure-when-42',
      workflow_id: def.id,
      workflow_version: 1,
      completed_steps: [],
      in_progress_steps: ['confirm'],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'gate_waiting',
      version: 2,
      params: {},
      evidence: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      terminal_state: false,
      claims: { confirm: { deadline: null, token: 't' } },
      pending_gate: {
        gate_id: 'g-1',
        step_name: 'confirm',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: '2026-01-01T00:00:00.000Z',
      },
    };
    const delta = { kind: 'settle_gate' as const, gateId: 'g-1', choice: 'approve', evidence: [] };
    const now = new Date('2026-01-01T00:01:00.000Z');
    // (a) red when the totality is applied unconditionally — a store without `settleStep` would
    //     then stop throwing where it throws today; (b) prints whether the call threw.
    expect(() => applySettlement(fresh, delta, def, { now })).toThrow();
    const cascaded = applySettlement(fresh, delta, def, { now, cascadeGuards: true });
    // (a) red when the option no longer makes the write recordable; (b) prints `applied`.
    expect(cascaded.applied).toBe(true);
    // The guard's evidence is stamped with the transform's own `now`, against the fresh version.
    // (a) red when the cascade stamps wall-clock time; (b) prints the timestamp.
    if (cascaded.applied) {
      expect(guardEntries(cascaded.run)[0]?.started_at).toBe(now.toISOString());
    }
  });
});

// ---------------------------------------------------------------------------
// An expiry reply keeps BOTH facts; a late answer is never a recorded one
// ---------------------------------------------------------------------------

describe('issue #625 — a late answer on an expired gate: both facts on the reply, and the typed fact answer_recorded: false', () => {
  const aborting = () =>
    gateThenGuard({
      gate: expiring('reject'),
      guard: { abort_message: 'Not approved (timed out to reject).' },
    });
  const passing = () => gateThenGuard({ gate: expiring('approve'), more: FINISH });

  it('SAME choice, the guard ends the run: ok, the expiry sentence FOLLOWED BY the guard sentence', async () => {
    await withStore(async (store) => {
      const def = aborting();
      const { runId, gateId, afterExpiry } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, {
        runId,
        gateId,
        choice: 'reject',
        now: afterExpiry,
      });

      expect(reply.status).toBe('ok');
      // (a) red when the guard's sentence REPLACES the expiry sentence (or the reverse);
      //     (b) prints the sentence.
      expect(reply.context_hint).toBe(`${LATE_SAME_CHOICE} Guard step 'check' aborted the run.`);
      // (a) red when the late reply is not marked, so a surface prints "Responded:";
      //     (b) prints the value.
      expect(reply.answer_recorded).toBe(false);
      // (a) red when the expiry's write does not settle the guard, or the reply omits it;
      //     (b) prints the values.
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'abort' }]);
      expect(reply.ended_by).toEqual({
        arm: 'guard_abort',
        step: 'check',
        reason: 'Not approved (timed out to reject).',
      });
      expect(reply.run_phase).toBe('aborted');
      const record = await store.get(runId);
      // (a) red when the choice is attributed to the person; (b) prints the entry.
      expect(record.settled?.['confirm']).toMatchObject({
        choice: 'reject',
        resolved_by: 'timeout',
      });
      // What the `Not recorded:` line reads — from the record, never from the reply's text.
      // (a) red when the choice or the phase is not the record's; (b) prints the object.
      expect(lateAnswerOutcome(reply, record)).toEqual({ choice: 'reject', phase: 'aborted' });
      // (a) red when the composer drops the expiry sentence or joins it to the guard's on one
      //     line; (b) prints the lines.
      expect(describeAnswerEnding(reply, record)).toEqual([
        LATE_SAME_CHOICE,
        "Guard step 'check' aborted the run.",
        'Reason: Not approved (timed out to reject).',
      ]);
    });
  });

  it('DIFFERENT choice, the guard ends the run: refused, the refusal FOLLOWED BY the guard sentence; errors[0] stays the refusal alone', async () => {
    await withStore(async (store) => {
      const def = aborting();
      const { runId, gateId, afterExpiry } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, {
        runId,
        gateId,
        choice: 'approve',
        now: afterExpiry,
      });

      const refusal = `Gate '${gateId}' was settled by timeout with choice 'reject' — your choice 'approve' was not recorded.`;
      // (a) red when a guard's ending turns a refused answer into an ok one; (b) prints status.
      expect(reply.status).toBe('error');
      // (a) red when the guard's sentence is appended to the error itself; (b) prints errors.
      expect(reply.errors).toEqual([refusal]);
      // (a) red when the refused reply does not say the run ended; (b) prints the sentence.
      expect(reply.context_hint).toBe(`${refusal} Guard step 'check' aborted the run.`);
      expect(reply.answer_recorded).toBe(false);
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'abort' }]);
      expect(reply.ended_by).toEqual({
        arm: 'guard_abort',
        step: 'check',
        reason: 'Not approved (timed out to reject).',
      });
      const record = await store.get(runId);
      expect(lateAnswerOutcome(reply, record)).toEqual({ choice: 'reject', phase: 'aborted' });
      // (a) red when the refused form's lines lose the refusal, the ending or the reason;
      //     (b) prints the lines.
      expect(describeAnswerEnding(reply, record)).toEqual([
        refusal,
        "Guard step 'check' aborted the run.",
        'Reason: Not approved (timed out to reject).',
      ]);
    });
  });

  it('a guard that PASSED is on BOTH forms of the expiry reply — including the refused one — and neither carries ended_by', async () => {
    await withStore(async (store) => {
      const def = passing();
      const same = await openGate(store, def);
      const sameReply = await submitHumanResponse(store, def, {
        runId: same.runId,
        gateId: same.gateId,
        choice: 'approve',
        now: same.afterExpiry,
      });
      // (a) red when the same-choice late reply drops the guard or the typed fact, or gains a
      //     guard sentence it has no reason to carry; (b) prints the values.
      expect(sameReply.status).toBe('ok');
      expect(sameReply.answer_recorded).toBe(false);
      expect(sameReply.guards).toEqual([{ step: 'check', outcome: 'pass' }]);
      expect(sameReply.ended_by).toBeUndefined();
      expect(sameReply.context_hint).toBe(LATE_SAME_CHOICE);
      const sameRecord = await store.get(same.runId);
      expect(lateAnswerOutcome(sameReply, sameRecord)).toEqual({
        choice: 'approve',
        phase: 'running',
      });
      expect(describeAnswerEnding(sameReply, sameRecord)).toEqual([
        LATE_SAME_CHOICE,
        "Guard step 'check' passed.",
      ]);

      const other = await openGate(store, def);
      const otherReply = await submitHumanResponse(store, def, {
        runId: other.runId,
        gateId: other.gateId,
        choice: 'reject',
        now: other.afterExpiry,
      });
      // (a) red when the REFUSED expiry reply drops `guards` — a person who wanted the other
      //     choice would not learn the guard passed; (b) prints the values.
      expect(otherReply.status).toBe('error');
      expect(otherReply.answer_recorded).toBe(false);
      expect(otherReply.guards).toEqual([{ step: 'check', outcome: 'pass' }]);
      expect(otherReply.ended_by).toBeUndefined();
      const otherRecord = await store.get(other.runId);
      expect(lateAnswerOutcome(otherReply, otherRecord)).toEqual({
        choice: 'approve',
        phase: 'running',
      });
      expect(describeAnswerEnding(otherReply, otherRecord)).toEqual([
        `Gate '${other.gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
        "Guard step 'check' passed.",
      ]);
    });
  });

  it('an answer that was RECORDED never carries answer_recorded — on time, and replayed by a person', async () => {
    await withStore(async (store) => {
      const def = passing();
      const { runId, gateId } = await openGate(store, def);
      const onTime = await submitHumanResponse(store, def, { runId, gateId, choice: 'approve' });
      // (a) red when the field is stamped on every answer; (b) prints whether the key exists.
      expect('answer_recorded' in onTime).toBe(false);
      const record = await store.get(runId);
      expect(lateAnswerOutcome(onTime, record)).toBeUndefined();

      const replay = await submitHumanResponse(store, def, { runId, gateId, choice: 'approve' });
      // A person's own answer, sent twice: it WAS recorded (the first time).
      // (a) red when the already-resolved reply is marked for a gate a person settled;
      //     (b) prints status and whether the key exists.
      expect(replay.status).toBe('ok');
      expect('answer_recorded' in replay).toBe(false);
      const conflict = await submitHumanResponse(store, def, { runId, gateId, choice: 'reject' });
      expect(conflict.status).toBe('error');
      expect('answer_recorded' in conflict).toBe(false);
    });
  });

  it('a gate ANOTHER writer expired first (a drain, the timer, the sweeper): the late answer is marked, and carries no guards — that write reported its own', async () => {
    await withStore(async (store) => {
      const def = passing();
      const { runId, gateId, afterExpiry } = await openGate(store, def);
      // The other writer: the same call `realm run drain --expired --force` and the timer make.
      const enacted = await store.settleStep(runId, { kind: 'expire_gate', gateId }, def, {
        now: afterExpiry,
      });
      // (a) red when the enacting write does not report the guard it settled; (b) prints it.
      expect(enacted.applied && enacted.guards).toEqual([{ step: 'check', outcome: 'pass' }]);

      const same = await submitHumanResponse(store, def, {
        runId,
        gateId,
        choice: 'approve',
        now: afterExpiry,
      });
      // (a) red when the already-resolved reply for a gate its expiry settled is not marked — a
      //     surface would print "Responded:"; (b) prints the values.
      expect(same.status).toBe('ok');
      expect(same.answer_recorded).toBe(false);
      expect(same.guards).toBeUndefined();
      const record = await store.get(runId);
      expect(lateAnswerOutcome(same, record)).toEqual({ choice: 'approve', phase: 'running' });
      // (a) red when the composer prints nothing for this reply; (b) prints the lines.
      expect(describeAnswerEnding(same, record)).toEqual([LATE_SAME_CHOICE]);

      const different = await submitHumanResponse(store, def, {
        runId,
        gateId,
        choice: 'reject',
        now: afterExpiry,
      });
      // (a) red when the conflict reply for a gate its expiry settled is not marked;
      //     (b) prints the values.
      expect(different.status).toBe('error');
      expect(different.answer_recorded).toBe(false);
      expect(different.guards).toBeUndefined();
      expect(lateAnswerOutcome(different, record)).toEqual({ choice: 'approve', phase: 'running' });
    });
  });

  it('an expiry that ABORTED the run settled no choice: the reply is marked, and there is no choice for a "Not recorded" line', async () => {
    await withStore(async (store) => {
      const def = gateThenGuard({ gate: { timeout_seconds: 1, on_expiry: 'abort' } });
      const { runId, gateId, afterExpiry } = await openGate(store, def);
      const reply = await submitHumanResponse(store, def, {
        runId,
        gateId,
        choice: 'approve',
        now: afterExpiry,
      });
      // (a) red when the abort disposition's reply is left unmarked; (b) prints the values.
      expect(reply.status).toBe('error');
      expect(reply.answer_recorded).toBe(false);
      // The gate's own expiry ended the run — no guard was eligible, so none is reported.
      expect(reply.guards).toBeUndefined();
      expect(reply.ended_by).toBeUndefined();
      // (a) red when a choice is invented for a gate whose expiry settled none; (b) prints it.
      expect(lateAnswerOutcome(reply, await store.get(runId))).toBeUndefined();
    });
  });

  it("an expiry enacted by a step's own call (no reply of its own): the disclosure line names what its guards did", async () => {
    await withStore(async (store) => {
      // `after` waits on the guard; calling it while the gate is expired enacts the expiry first.
      const more: Record<string, StepDefinition> = {
        after: { description: 'After', execution: 'auto', depends_on: ['check'] },
      };
      const passingDef = gateThenGuard({ gate: expiring('approve'), more });
      const passed = await openGate(store, passingDef);
      const ran = await executeStep(store, passingDef, {
        runId: passed.runId,
        command: 'after',
        input: {},
        dispatcher: echo,
        now: passed.afterExpiry,
      });
      // The guard passed in the expiry's own write, so `after` is eligible in this same call.
      // (a) red when the expiry's write leaves the guard unsettled — `after` is then refused as
      //     not eligible; (b) prints the status.
      expect(ran.status).toBe('ok');
      // (a) red when the disclosure line does not name the guard the expiry's write settled;
      //     (b) prints the warnings that mention the enactment.
      expect(ran.warnings.filter((w) => w.includes('enacted_via: execute_step'))).toEqual([
        expect.stringContaining("Guard step 'check' passed."),
      ]);

      const abortingDef = gateThenGuard({
        gate: expiring('reject'),
        guard: { abort_message: 'Not approved (timed out to reject).' },
        more,
      });
      const aborted = await openGate(store, abortingDef);
      const refused = await executeStep(store, abortingDef, {
        runId: aborted.runId,
        command: 'after',
        input: {},
        dispatcher: echo,
        now: aborted.afterExpiry,
      });
      // (a) red when the disclosure line does not say the guard ended the run, or drops its
      //     reason; (b) prints the warnings that mention the enactment.
      expect(refused.warnings.filter((w) => w.includes('enacted_via: execute_step'))).toEqual([
        expect.stringContaining(
          "Guard step 'check' aborted the run. Reason: Not approved (timed out to reject).",
        ),
      ]);
      expect((await store.get(aborted.runId)).run_phase).toBe('aborted');
    });
  });
});

// ---------------------------------------------------------------------------
// A store WITHOUT settleStep
// ---------------------------------------------------------------------------

describe('issue #625 — a store WITHOUT settleStep settles no guard in the write (the legacy two-write shape is unchanged)', () => {
  const withLegacyStore = <T>(fn: (store: RunStore) => Promise<T>): Promise<T> =>
    withStore((inner) => fn(new NoSettleStepStore(inner)));

  it('after an ANSWER: no guards on the reply, the guard still eligible, no seal', async () => {
    await withLegacyStore(async (store) => {
      const def = gateThenGuard({ guard: { abort_message: 'Not approved — stopping.' } });
      const { runId, gateId } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, { runId, gateId, choice: 'reject' });

      // (a) red when the legacy answer path starts settling guards; (b) prints the values.
      expect(reply.status).toBe('ok');
      expect(reply.guards).toBeUndefined();
      expect(reply.ended_by).toBeUndefined();
      const record = await store.get(runId);
      expect(membershipOf(record, 'check')).toBe('none');
      expect(record.terminal_state).toBe(false);
      expect(record.sealed_by).toBeUndefined();
      expect(record.run_phase).toBe('running');
    });
  });

  it('after an EXPIRY enacted by a late answer: no guards on the reply, the guard still eligible, no seal', async () => {
    await withLegacyStore(async (store) => {
      const def = gateThenGuard({
        gate: expiring('reject'),
        guard: { abort_message: 'Not approved (timed out to reject).' },
      });
      const { runId, gateId, afterExpiry } = await openGate(store, def);

      const reply = await submitHumanResponse(store, def, {
        runId,
        gateId,
        choice: 'reject',
        now: afterExpiry,
      });

      // The legacy expiry leg calls the pure transform and persists its result — WITHOUT the
      // option. With it, this write would seal the run through a guard on a store whose cleanup
      // steps nothing here could then run.
      // (a) red when that direct call sets `cascadeGuards`; (b) prints the values.
      expect(reply.status).toBe('ok');
      expect(reply.guards).toBeUndefined();
      expect(reply.ended_by).toBeUndefined();
      // (a) red when the guard's sentence is appended on a store that settled no guard;
      //     (b) prints the sentence.
      expect(reply.context_hint).toBe(LATE_SAME_CHOICE);
      const record = await store.get(runId);
      expect(record.settled?.['confirm']).toMatchObject({
        choice: 'reject',
        resolved_by: 'timeout',
      });
      expect(membershipOf(record, 'check')).toBe('none');
      expect(record.terminal_state).toBe(false);
      expect(record.sealed_by).toBeUndefined();
      // The one additive field this store's late reply gains: the typed fact about the ANSWER.
      // (a) red when a late answer on a store without settleStep is not marked; (b) prints it.
      expect(reply.answer_recorded).toBe(false);
    });
  });

  it('the same expiry on a store WITH settleStep settles the guard in that write (the control for the cell above)', async () => {
    await withStore(async (store) => {
      const def = gateThenGuard({
        gate: expiring('reject'),
        guard: { abort_message: 'Not approved (timed out to reject).' },
      });
      const { runId, gateId, afterExpiry } = await openGate(store, def);
      const reply = await submitHumanResponse(store, def, {
        runId,
        gateId,
        choice: 'reject',
        now: afterExpiry,
      });
      // (a) red when the two fixtures stop differing only in the store — the cell above would
      //     then prove nothing; (b) prints the values.
      expect(reply.guards).toEqual([{ step: 'check', outcome: 'abort' }]);
      expect(membershipOf(await store.get(runId), 'check')).toBe('skipped');
    });
  });
});

// ---------------------------------------------------------------------------
// advanceRun, called on its own
// ---------------------------------------------------------------------------

describe("issue #625 — advanceRun (the chain's tail) called without the chain's state", () => {
  it('on a record left with an eligible guard: it settles the guard and lists it, as executeChain does', async () => {
    await withStore(async (store) => {
      const def = stepThenGuard({ more: FINISH });
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      // `store.update` is a write that settles no guard — the record a resume or a run's
      // creation can also leave.
      const leftover = await store.update({
        ...run,
        completed_steps: ['work'],
        evidence: [
          captureEvidence({
            stepId: 'work',
            startedAt: new Date(),
            completedAt: new Date(),
            input: {},
            output: { ok: true },
          }),
        ],
      });
      expect(membershipOf(leftover, 'check')).toBe('none');

      const reply = await advanceRun(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echo,
      });

      // (a) red when the tail's guard loop is not reached from a direct call, or the wrapper
      //     drops the accumulated list; (b) prints the values.
      expect(reply.status).toBe('ok');
      expect(reply.chained_auto_steps).toEqual([{ step: 'check', run_phase: 'running' }]);
      expect(offeredSteps(reply)).toEqual(['finish']);
      expect(membershipOf(await store.get(run.id), 'check')).toBe('completed');
    });
  });

  it('on a record with nothing for the engine to run: a neutral ok reply, no steps listed', async () => {
    await withStore(async (store) => {
      const def = stepThenGuard();
      const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

      const reply = await advanceRun(store, def, {
        runId: run.id,
        command: 'work',
        input: {},
        dispatcher: echo,
      });

      // (a) red when a direct call runs or claims the agent step, or invents a list;
      //     (b) prints the values.
      expect(reply.status).toBe('ok');
      expect(reply.context_hint).toBe(`Run '${run.id}': nothing ran. Ready for the agent: 'work'.`);
      expect(reply.chained_auto_steps).toBeUndefined();
      expect((await store.get(run.id)).version).toBe(run.version);
    });
  });
});

// ---------------------------------------------------------------------------
// The readers a surface holding a settlement RESULT uses
// ---------------------------------------------------------------------------

describe('issue #625 — guardEndingOf and the printed lines, from a settlement result', () => {
  /** A record with the gate open, ready for a pure `settle_gate`. */
  function gateOpenRecord(def: WorkflowDefinition): RunRecord {
    return {
      id: 'pure-reader',
      workflow_id: def.id,
      workflow_version: 1,
      completed_steps: [],
      in_progress_steps: ['confirm'],
      failed_steps: [],
      skipped_steps: [],
      run_phase: 'gate_waiting',
      version: 2,
      params: {},
      evidence: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      terminal_state: false,
      claims: { confirm: { deadline: null, token: 't' } },
      pending_gate: {
        gate_id: 'g-1',
        step_name: 'confirm',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: '2026-01-01T00:00:00.000Z',
      },
    };
  }
  const answer = (def: WorkflowDefinition, choice: string, cascadeGuards = true) =>
    applySettlement(
      gateOpenRecord(def),
      {
        kind: 'settle_gate',
        gateId: 'g-1',
        choice,
        evidence: [
          {
            ...captureEvidence({
              stepId: 'confirm',
              startedAt: new Date('2026-01-01T00:00:00.000Z'),
              completedAt: new Date('2026-01-01T00:01:00.000Z'),
              input: { choice },
              output: { choice },
            }),
            kind: 'gate_response' as const,
          },
        ],
      },
      def,
      { now: new Date('2026-01-01T00:01:00.000Z'), cascadeGuards },
    );

  it('a guard that ended the run: the ending, then its Reason line', () => {
    const result = answer(gateThenGuard({ guard: { abort_message: 'Not approved.' } }), 'reject');
    // (a) red when the reader drops a field, takes the gate's step, or mints another sentence;
    //     (b) prints the object.
    expect(guardEndingOf(result)).toEqual({
      step: 'check',
      outcome: 'abort',
      arm: 'guard_abort',
      sentence: "Guard step 'check' aborted the run.",
      reason: 'Not approved.',
    });
    // (a) red when the Reason line is dropped or truncated; (b) prints the lines.
    expect(describeGuardEndingLines(result)).toEqual([
      "Guard step 'check' aborted the run.",
      'Reason: Not approved.',
    ]);
    expect(describeGuardLines(result)).toEqual(describeGuardEndingLines(result));
  });

  it('a guard that passed and let the run go on: no ending, one passed line', () => {
    const result = answer(gateThenGuard({ more: FINISH }), 'approve');
    // (a) red when a non-ending guard is read as an ending; (b) prints the values.
    expect(guardEndingOf(result)).toBeUndefined();
    expect(describeGuardEndingLines(result)).toEqual([]);
    // (a) red when the passed line is reworded or dropped; (b) prints the lines.
    expect(describeGuardLines(result)).toEqual(["Guard step 'check' passed."]);
    expect(guardPassedLine('check')).toBe("Guard step 'check' passed.");
  });

  it('a write that settled no guard, and a refused one: nothing to print', () => {
    const noCascade = answer(gateThenGuard(), 'approve', false);
    // (a) red when the readers invent an ending for a result with no `guards`; (b) prints them.
    expect(guardEndingOf(noCascade)).toBeUndefined();
    expect(describeGuardLines(noCascade)).toEqual([]);
    const refused = applySettlement(
      gateOpenRecord(gateThenGuard()),
      { kind: 'settle_gate', gateId: 'not-the-gate', choice: 'approve', evidence: [] },
      gateThenGuard(),
      { cascadeGuards: true },
    );
    expect(refused.applied).toBe(false);
    expect(guardEndingOf(refused)).toBeUndefined();
    expect(describeGuardLines(refused)).toEqual([]);
  });

  it('describeEndedBy reads the same two lines off a reply that carries ended_by, and nothing off one that does not', () => {
    const base: ResponseEnvelope = {
      command: 'confirm',
      run_id: 'r',
      run_version: 3,
      status: 'error',
      data: {},
      evidence: [],
      warnings: [],
      errors: ['refused'],
      context_hint: 'refused',
      next_actions: [],
    };
    // (a) red when the reply reader mints a different sentence than the result reader, or drops
    //     the reason; (b) prints the lines.
    expect(
      describeEndedBy({
        ...base,
        guards: [{ step: 'check', outcome: 'resolution_error' }],
        ended_by: { arm: 'guard_resolution_error', step: 'check', reason: 'why' },
      }),
    ).toEqual([
      "Guard step 'check' failed with a resolution error. Run is terminated.",
      'Reason: why',
    ]);
    expect(
      describeEndedBy({
        ...base,
        guards: [{ step: 'check', outcome: 'pass' }],
        ended_by: { arm: 'guard_pass_complete', step: 'check' },
      }),
    ).toEqual(["Guard step 'check' passed and completed the run."]);
    expect(describeEndedBy(base)).toEqual([]);
    // A recorded answer whose write settled no guard prints nothing extra.
    expect(
      describeAnswerEnding({ ...base, status: 'ok', errors: [] }, gateOpenRecord(gateThenGuard())),
    ).toEqual([]);
  });
});
