// refusal-and-expiry-625.test.ts — issue #625 PR-2a, over the MCP tools:
// - decision C94 (the review walk's J9-R1): `execute_step` by name on a step refused before its claim
//   (a failed precondition, an agent step or an `auto` step) beside a ready agent step replies
//   `resolve_precondition` with the ready step in `next_actions` and in `blocked_reason.eligible_steps`
//   — never `stop`, never the refused step; with nothing else to call, `report_to_user` and the way out.
// - decision C95 (the walk's J3-a): an open question whose time is up and that declares `on_expiry`
//   is owed engine work — `get_run_state` says `advance_owed` and offers `advance_run`, which carries
//   it out (`settle_default`: the run goes on and completes; `abort`: it ends). A question not yet
//   expired, or with no `on_expiry`, stays `awaiting_human`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  executeStep,
  type WorkflowDefinition,
  type ResponseEnvelope,
} from '@sensigo/realm';
import { handleExecuteStep } from './execute-step.js';
import { handleAdvanceRun } from './advance-run.js';
import { handleGetRunState } from './get-run-state.js';

const WAY_OUT =
  'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';

/** The walk's J9-R1 workflow: `b` ready; `a` (agent) and `blk` (auto) need `b` first. */
const J9R1: WorkflowDefinition = {
  id: 'j9r1-mcp',
  name: 'J9-R1',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    b: { description: 'Answer b.', execution: 'agent', depends_on: [] },
    a: {
      description: 'Answer a.',
      execution: 'agent',
      depends_on: [],
      preconditions: ['b.output.go == true'],
    },
    blk: {
      description: 'A bare auto step.',
      execution: 'auto',
      depends_on: [],
      preconditions: ['b.output.go == true'],
    },
  },
};

/** `confirm` (a gate, 60 s, `on_expiry` as given), then a bare `auto` step `after`. */
function gated(id: string, onExpiry: 'settle_default' | 'abort' | undefined): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
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

function routing(reply: ResponseEnvelope) {
  return {
    status: reply.status,
    agent_action: reply.agent_action,
    next: reply.next_actions.map(
      (a) => `${a.instruction?.tool}:${a.instruction?.params['command'] ?? ''}`,
    ),
    eligible_steps: reply.blocked_reason?.eligible_steps,
  };
}

describe('#625 PR-2a, C94 and C95 — over the MCP tools', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-rae-625-'));
    runStore = new JsonFileStore(join(dir, 'runs'));
    workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  });

  it('C94, J9-R1: execute_step on `a` (agent, precondition) and on `blk` (auto, precondition) beside the ready `b`', async () => {
    await workflowStore.register(J9R1);
    const { run } = await runStore.create({ workflowId: J9R1.id, workflowVersion: 1, params: {} });
    for (const command of ['a', 'blk']) {
      const reply = await handleExecuteStep(
        { run_id: run.id, command, params: {} },
        { runStore, workflowStore },
      );
      // (a) red when the reply says `stop`, offers nothing, or names the refused step as callable;
      // (b) prints the routing.
      expect({ command, ...routing(reply) }).toEqual({
        command,
        status: 'blocked',
        agent_action: 'resolve_precondition',
        next: ['execute_step:b'],
        eligible_steps: ['b'],
      });
      // (a) red when the way out is added while `b` can run; (b) prints the hint.
      expect(reply.context_hint).toBe(`Precondition failed for step '${command}'.`);
    }
  });

  it('C94, nothing else can run: report_to_user, nothing to call, and the way out (C66) stays', async () => {
    const d: WorkflowDefinition = {
      ...J9R1,
      id: 'j9r1-mcp-alone',
      steps: { a: J9R1.steps['a']! },
    };
    await workflowStore.register(d);
    const { run } = await runStore.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    const reply = await handleExecuteStep(
      { run_id: run.id, command: 'a', params: {} },
      { runStore, workflowStore },
    );
    // (a) red when `stop` or `resolve_precondition` comes back with nothing to call; (b) prints it.
    expect(routing(reply)).toEqual({
      status: 'blocked',
      agent_action: 'report_to_user',
      next: [],
      eligible_steps: [],
    });
    // (a) red when the way out is dropped; (b) prints the hint.
    expect(reply.context_hint).toBe(`Precondition failed for step 'a'. ${WAY_OUT}`);
  });

  /** A registered run at its open question, the question's time already up (stored `expires_at` moved back). */
  async function expiredGate(d: WorkflowDefinition, expired: boolean) {
    await workflowStore.register(d);
    const { run } = await runStore.create({ workflowId: d.id, workflowVersion: 1, params: {} });
    await executeStep(runStore, d, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    const r = await runStore.get(run.id);
    if (expired) {
      await runStore.update({
        ...r,
        pending_gate: {
          ...r.pending_gate!,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      });
    }
    return { runId: run.id, gateId: r.pending_gate!.gate_id };
  }

  for (const [onExpiry, phase] of [
    ['settle_default', 'completed'],
    ['abort', 'aborted'],
  ] as const) {
    it(`C95, ${onExpiry}: get_run_state says advance_owed and offers advance_run; advance_run carries it out (${phase})`, async () => {
      const d = gated(`rae-${onExpiry}`, onExpiry);
      const { runId, gateId } = await expiredGate(d, true);
      const state = await handleGetRunState({ run_id: runId }, { runStore, workflowStore });
      // (a) red when a due expiry reads `awaiting_human` with nothing to call; (b) prints status and act.
      expect({
        status: state.next_actions_status,
        next: state.next_actions.map((a) => a.instruction?.tool),
      }).toEqual({ status: 'advance_owed', next: ['advance_run'] });
      const reply = await handleAdvanceRun({ run_id: runId }, { runStore, workflowStore });
      const after = await runStore.get(runId);
      // (a) red when advance_run leaves the question open; (b) prints the phase and the gate.
      expect({ phase: after.run_phase, gate: after.pending_gate }).toEqual({
        phase,
        gate: undefined,
      });
      // (a) red when the disclosure leaves the reply; (b) prints the warnings.
      expect(reply.warnings).toContain(
        `gate '${gateId}' on 'confirm' had expired — enacted declared ${onExpiry} before this advance_run call (enacted_via: advance_run).`,
      );
    });
  }

  for (const [label, onExpiry, expired] of [
    ['not yet expired', 'settle_default', false],
    ['a finding only (no on_expiry), expired', undefined, true],
  ] as const) {
    it(`C95 CONTROL — ${label}: awaiting_human, nothing to call; advance_run touches nothing`, async () => {
      const d = gated(`rae-ctl-${expired ? 'f' : 'n'}`, onExpiry);
      const { runId, gateId } = await expiredGate(d, expired);
      const state = await handleGetRunState({ run_id: runId }, { runStore, workflowStore });
      // (a) red when the view offers an act here; (b) prints status and act.
      expect({ status: state.next_actions_status, next: state.next_actions }).toEqual({
        status: 'awaiting_human',
        next: [],
      });
      await handleAdvanceRun({ run_id: runId }, { runStore, workflowStore });
      // (a) red when advance_run settles or aborts this question; (b) prints the gate.
      expect((await runStore.get(runId)).pending_gate?.gate_id).toBe(gateId);
    });
  }
});
