// gate-claim-stable-625.test.ts — issue #625 (the holder slice, PR-H): law GATE_CLAIM_STABLE_WHILE_OPEN.
//
// While a question is open, nothing in the engine other than the three writes that CLOSE it — the
// answer, the expiry, and the abort edge — changes or removes the claim of the step that opened it.
// This matters because the claim's token is the proof an answer may pass back (D4): if any other
// operation could replace or release the claim while the question is open, the token handed out on
// the opening reply would silently stop meaning anything.
//
// The cells below drive every ENGINE operation that could touch the claim; the commands that live
// in the CLI package (resume, cleanup, drain, purge, gc --heal, migrate --stamp-seals and the
// batch reclaim selector) are cell'd in `packages/cli/src/commands/gate-claim-stable-625.test.ts`
// — a core test cannot import a command.
//
// Each cell asserts (a) the claim is byte-identical before and after — token, holder, since,
// deadline — AND the question is still open; the operation either refuses or changes something else.
// Each carries the change that turns it red and what it prints on failure: synthetic ids only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { executeStep, submitHumanResponse } from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { reclaimStep } from './reclaim-step.js';
import { abandonRun } from './abandon-run.js';
import { captureEvidence } from '../evidence/snapshot.js';
import type { Attributed } from './holder.js';
import type { ClaimRecord, PendingGate, RunRecord } from '../types/run-record.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

const echo: StepDispatcher = async (_step, input) => ({ ...input });
const PROGRAM: Attributed = { by: 'alice@host', by_source: 'derived', channel: 'agent' };

let dir: string;
let store: JsonFileStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-gate-claim-stable-625-'));
  store = new JsonFileStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const gateStep = (): StepDefinition => ({
  description: 'Confirm',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on: [],
  gate: { choices: ['approve', 'reject'] },
});

/** `confirm` (gate) beside an independent `confirm2` (gate) and an independent agent step `side`. */
function workflow(extra: Record<string, StepDefinition> = {}): WorkflowDefinition {
  return {
    id: 'gate-claim-stable-wf',
    name: 'gate claim stable',
    version: 1,
    steps: {
      confirm: gateStep(),
      confirm2: gateStep(),
      side: { description: 'Side', execution: 'agent', depends_on: [] },
      ...extra,
    },
  };
}

interface Open {
  runId: string;
  gate: PendingGate;
  claim: ClaimRecord;
  token: string;
}

/** Opens the gate on `confirm`, taken by PROGRAM, and reads the claim and the gate back. */
async function open(def: WorkflowDefinition): Promise<Open> {
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  const reply = await executeStep(store, def, {
    runId: run.id,
    command: 'confirm',
    input: {},
    dispatcher: echo,
    driver: PROGRAM,
  });
  if (reply.status !== 'confirm_required')
    throw new Error(`fixture: gate not open (${reply.status})`);
  const after = await store.get(run.id);
  const claim = after.claims!['confirm']!;
  return { runId: run.id, gate: after.pending_gate!, claim, token: claim.token! };
}

/** The claim and the open question must be exactly what `open` returned. */
async function expectStable(o: Open): Promise<RunRecord> {
  const after = await store.get(o.runId);
  // (a) red when the operation replaced, re-minted or removed the claim (token / holder / since /
  //     deadline differ); (b) prints the claim before and after — synthetic values only.
  expect(after.claims?.['confirm']).toEqual(o.claim);
  expect(after.pending_gate?.gate_id).toBe(o.gate.gate_id);
  expect(after.in_progress_steps).toContain('confirm');
  return after;
}

describe('GATE_CLAIM_STABLE_WHILE_OPEN — operations that must NOT touch the open question’s claim', () => {
  it('reclaim (plain, --step, --step --force all reach this one call): the open-gate step is refused', async () => {
    const def = workflow();
    const o = await open(def);
    await expect(reclaimStep(store, o.runId, 'confirm')).rejects.toMatchObject({
      code: 'STATE_TRANSITION_DENIED',
    });
    await expectStable(o);
  });

  it('abandon: refused while the question is open — it never reaches the claim', async () => {
    const def = workflow();
    const o = await open(def);
    await expect(abandonRun(store, o.runId, 'cell')).rejects.toBeDefined();
    await expectStable(o);
  });

  it('a second execute_step on the gate step itself: the reply is not a new claim', async () => {
    const def = workflow();
    const o = await open(def);
    const again = await executeStep(store, def, {
      runId: o.runId,
      command: 'confirm',
      input: {},
      dispatcher: echo,
      driver: { by: 'bob@host', by_source: 'derived', channel: 'agent' },
    });
    // The second call is refused or reports the open question; either way the claim is the first one.
    expect(again.status).not.toBe('ok');
    await expectStable(o);
  });

  it('a sibling’s refused gate open (open_gate on `confirm2`, already_open): the open question’s claim is untouched', async () => {
    const def = workflow();
    // `confirm2` is claimed BEFORE the first gate opens (afterwards no sibling is eligible to be
    // claimed — the gate parks the run), so its open_gate reaches the transform and is refused there.
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const sibling = await store.claimStep(run.id, 'confirm2', def, PROGRAM);
    const siblingToken = sibling.claims!['confirm2']!.token;
    const reply = await executeStep(store, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: echo,
      driver: PROGRAM,
    });
    expect(reply.status).toBe('confirm_required');
    const mid = await store.get(run.id);
    const o: Open = {
      runId: run.id,
      gate: mid.pending_gate!,
      claim: mid.claims!['confirm']!,
      token: mid.claims!['confirm']!.token!,
    };
    const result = await store.settleStep!(
      run.id,
      {
        kind: 'open_gate',
        step: 'confirm2',
        ...(siblingToken !== undefined ? { claimToken: siblingToken } : {}),
        pendingGate: { ...o.gate, step_name: 'confirm2', gate_id: 'a-different-gate-id' },
        evidence: [],
      },
      def,
    );
    expect(result.applied).toBe(false);
    const after = await expectStable(o);
    expect(after.pending_gate?.step_name).toBe('confirm');
  });

  it('a sibling’s settle (an agent step claimed earlier completes while the question is open)', async () => {
    const def = workflow();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const taken = await store.claimStep(run.id, 'side', def, PROGRAM);
    const sideToken = taken.claims!['side']!.token;
    // The gate opens while `side` is still in progress.
    const reply = await executeStep(store, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: echo,
      driver: PROGRAM,
    });
    expect(reply.status).toBe('confirm_required');
    const mid = await store.get(run.id);
    const o: Open = {
      runId: run.id,
      gate: mid.pending_gate!,
      claim: mid.claims!['confirm']!,
      token: mid.claims!['confirm']!.token!,
    };
    const settled = await store.settleStep!(
      run.id,
      {
        kind: 'settle_step',
        step: 'side',
        outcome: 'complete',
        ...(sideToken !== undefined ? { claimToken: sideToken } : {}),
        evidence: [
          captureEvidence({
            stepId: 'side',
            startedAt: new Date(),
            completedAt: new Date(),
            input: {},
            output: {},
          }),
        ],
      },
      def,
    );
    expect(settled.applied).toBe(true);
    const after = await expectStable(o);
    expect(after.completed_steps).toContain('side');
  });

  it('a reclaim of a SIBLING (the dead claim of another step) leaves the open question’s claim alone', async () => {
    const def = workflow();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await store.claimStep(run.id, 'side', def, PROGRAM);
    await executeStep(store, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: echo,
      driver: PROGRAM,
    });
    const mid = await store.get(run.id);
    const o: Open = {
      runId: run.id,
      gate: mid.pending_gate!,
      claim: mid.claims!['confirm']!,
      token: mid.claims!['confirm']!.token!,
    };
    // Far enough in the future that the sibling's claim is past any deadline.
    await reclaimStep(store, run.id, 'side', { now: new Date(Date.now() + 10 * 24 * 3600_000) });
    const after = await expectStable(o);
    expect(after.in_progress_steps).not.toContain('side');
  });

  it('the answer closes the question — and only then does the claim go (the lawful closer #1)', async () => {
    const def = workflow();
    const o = await open(def);
    await submitHumanResponse(store, def, {
      runId: o.runId,
      gateId: o.gate.gate_id,
      choice: 'approve',
    });
    const after = await store.get(o.runId);
    expect(after.pending_gate).toBeUndefined();
    expect(after.claims?.['confirm']).toBeUndefined();
  });
});

describe('GATE_CLAIM_STABLE_WHILE_OPEN — a sibling’s write whose guard cascade WOULD abort', () => {
  it('guards wait on an open question, so the cascade does not run: the guard stays unsettled and the claim is untouched', async () => {
    const def = workflow({
      check: {
        description: 'Abort unless the side step said ok',
        execution: 'guard',
        depends_on: ['side'],
        abort_unless: ["side.verdict == 'ok'"],
      },
    });
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const taken = await store.claimStep(run.id, 'side', def, PROGRAM);
    const sideToken = taken.claims!['side']!.token;
    await executeStep(store, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: echo,
      driver: PROGRAM,
    });
    const mid = await store.get(run.id);
    const o: Open = {
      runId: run.id,
      gate: mid.pending_gate!,
      claim: mid.claims!['confirm']!,
      token: mid.claims!['confirm']!.token!,
    };
    const result = await store.settleStep!(
      run.id,
      {
        kind: 'settle_step',
        step: 'side',
        outcome: 'complete',
        ...(sideToken !== undefined ? { claimToken: sideToken } : {}),
        evidence: [
          captureEvidence({
            stepId: 'side',
            startedAt: new Date(),
            completedAt: new Date(),
            input: {},
            output: { verdict: 'bad' },
          }),
        ],
      },
      def,
    );
    expect(result.applied).toBe(true);
    // (a) red when a guard settles (and aborts) while a question is open — GUARD_WAITS_ON_OPEN_GATE
    //     broken — which would retire the question with no answer; (b) prints the run's sets.
    const after = await expectStable(o);
    expect(after.completed_steps).toContain('side');
    expect(after.completed_steps).not.toContain('check');
    expect(after.aborted_at).toBeUndefined();
  });
});

describe('GATE_CLAIM_STABLE_WHILE_OPEN — the abort edge is the lawful third closer: the claim and the question go TOGETHER', () => {
  it('a sibling step that settles with outcome `abort` retires the question and its claim in the same write', async () => {
    const def = workflow();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const taken = await store.claimStep(run.id, 'side', def, PROGRAM);
    const sideToken = taken.claims!['side']!.token;
    await executeStep(store, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: echo,
      driver: PROGRAM,
    });
    const open = await store.get(run.id);
    expect(open.pending_gate).toBeDefined();
    expect(open.claims?.['confirm']).toBeDefined();
    const result = await store.settleStep!(
      run.id,
      {
        kind: 'settle_step',
        step: 'side',
        outcome: 'abort',
        ...(sideToken !== undefined ? { claimToken: sideToken } : {}),
        evidence: [
          captureEvidence({
            stepId: 'side',
            startedAt: new Date(),
            completedAt: new Date(),
            input: {},
            output: {},
          }),
        ],
        abort: { stepId: 'side', abortMessage: 'stop' },
      },
      def,
    );
    expect(result.applied).toBe(true);
    const after = await store.get(run.id);
    // (a) red when the abort edge leaves the question open with its claim gone, or the claim behind
    //     with the question gone — the two must close together; (b) prints both.
    const gateGone = after.pending_gate === undefined;
    const claimGone = after.claims?.['confirm'] === undefined;
    expect({ gateGone, claimGone }).toEqual({ gateGone: true, claimGone: true });
  });
});
