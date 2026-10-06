// refusal-and-expiry-625.test.ts — issue #625 PR-2a, over the MCP tools:
// - decision C94 (the review walk's J9-R1): `execute_step` by name on a step refused before its claim
//   (a failed precondition, an agent step or an `auto` step) beside a ready agent step replies
//   `resolve_precondition` with the ready step in `next_actions` and in `blocked_reason.eligible_steps`
//   — never `stop`, never the refused step; with nothing else to call, `report_to_user` and the way out.
// - decision C95 (the walk's J3-a): an open question whose time is up and that declares `on_expiry`
//   is owed engine work — `get_run_state` says `advance_owed` and offers `advance_run`, which carries
//   it out (`settle_default`: the run goes on and completes; `abort`: it ends). A question not yet
//   expired, or with no `on_expiry`, stays `awaiting_human` — and names the question by its answer act
//   (decision C103), with no claim token.
// - decisions C103, C104 (the scoped walk's W2-R1, W1-R1): `advance_run` at an open question names it
//   and offers `submit_human_response`; `execute_step` on a step that is not eligible says why, offers
//   the answer behind a question, and with nothing to call replies `report_to_user` and the way out.
// - decisions C117-C120 (the walk on the merged head, W3-R1, W1-Y2, W1-R1, W5-R1): a wrong gate id on
//   an expired question offers `advance_run` and says its time is up (on an open one, the answer);
//   `advance_run`'s reply carries empty `data` and `evidence`; `execute_step` whose own expiry ended
//   the run replies `blocked` and `stop`.
// - decisions C135, C136 (the walk on round 16, W2-Y1, W5-Y3): a refused answer whose choice was not
//   recorded keeps `report_to_user` and its hint ends with what the run owes; a `blocked` reply whose
//   `next_actions` hold only `advance_run` says to call it.
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
  ExtensionRegistry,
  executeStep,
  answerAction,
  type WorkflowDefinition,
  type ResponseEnvelope,
} from '@sensigo/realm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { handleExecuteStep } from './execute-step.js';
import { handleAdvanceRun, registerAdvanceRun } from './advance-run.js';
import { handleSubmitHumanResponse } from './submit-human-response.js';
import { handleGetRunState } from './get-run-state.js';
import { handleStartRun } from './start-run.js';

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
        `gate '${gateId}' on 'confirm' had expired — this advance_run call first carried out its declared ${
          onExpiry === 'settle_default'
            ? "settle_default: the default choice 'approve' was recorded"
            : 'abort: the run ended'
        } (enacted_via: advance_run).`,
      );
    });
  }

  for (const [label, onExpiry, expired] of [
    ['not yet expired', 'settle_default', false],
    ['a finding only (no on_expiry), expired', undefined, true],
  ] as const) {
    it(`C95 CONTROL — ${label}: awaiting_human, only the answer offered (C103, no token); advance_run touches nothing`, async () => {
      const d = gated(`rae-ctl-${expired ? 'f' : 'n'}`, onExpiry);
      const { runId, gateId } = await expiredGate(d, expired);
      const state = await handleGetRunState({ run_id: runId }, { runStore, workflowStore });
      // (a) red when the view offers `advance_run` here, or get_run_state names no answer (C103), or
      // the answer carries a claim token; (b) prints status and act.
      expect({ status: state.next_actions_status, next: state.next_actions }).toEqual({
        status: 'awaiting_human',
        next: [
          answerAction(runId, {
            step: 'confirm',
            gate_id: gateId,
            choices: ['approve', 'reject'],
          }),
        ],
      });
      // The key, not the word: since C134 the act's text names claim_token (who passes one back).
      expect(JSON.stringify(state.next_actions)).not.toContain('"claim_token"');
      await handleAdvanceRun({ run_id: runId }, { runStore, workflowStore });
      // (a) red when advance_run settles or aborts this question; (b) prints the gate.
      expect((await runStore.get(runId)).pending_gate?.gate_id).toBe(gateId);
    });
  }

  it('C103, W2-R1: advance_run at an open question names it and offers submit_human_response (no token, no agent_action)', async () => {
    const d = gated('rae-oq', undefined);
    const { runId, gateId } = await expiredGate(d, false);
    const reply = await handleAdvanceRun({ run_id: runId }, { runStore, workflowStore });
    // (a) red when the reply offers nothing at a question, sets an agent_action, or says "No step is
    // ready."; (b) prints the reply.
    expect({
      status: reply.status,
      agent_action: reply.agent_action,
      hint: reply.context_hint,
      next: reply.next_actions,
    }).toEqual({
      status: 'ok',
      agent_action: undefined,
      hint: `Run '${runId}': nothing ran. Waiting on the question on step 'confirm' (choices: approve, reject) — answer it with submit_human_response.`,
      next: [
        answerAction(runId, { step: 'confirm', gate_id: gateId, choices: ['approve', 'reject'] }),
      ],
    });
  });

  it('C103: start_run matched by its key at an open question names it — the answer offered (no token), the hint says the question', async () => {
    const d = gated('rae-start', undefined);
    await workflowStore.register(d);
    const first = await handleStartRun(
      { workflow_id: d.id, params: {}, idempotency_key: 'k1' },
      { runStore, workflowStore },
    );
    expect(first.status).toBe('confirm_required');
    const gateId = (await runStore.get(first.run_id)).pending_gate!.gate_id;
    const again = await handleStartRun(
      { workflow_id: d.id, params: {}, idempotency_key: 'k1' },
      { runStore, workflowStore },
    );
    // (a) red when the matched run's reply offers nothing at its question, carries the opener's
    // token, or its hint does not name the question; (b) prints the reply.
    expect({ deduped: again.deduped, hint: again.context_hint, next: again.next_actions }).toEqual({
      deduped: true,
      hint: `Matched existing run '${first.run_id}' (idempotent) in phase 'gate_waiting'; no new run created. Waiting on the question on step 'confirm' (choices: approve, reject) — answer it with submit_human_response.`,
      next: [
        answerAction(first.run_id, {
          step: 'confirm',
          gate_id: gateId,
          choices: ['approve', 'reject'],
        }),
      ],
    });
  });

  it('C104, W1-R1: execute_step on a step behind an open question names it and offers the answer; behind a stranded step, report_to_user and the way out', async () => {
    const d = gated('rae-ne', undefined);
    const { runId } = await expiredGate(d, false);
    const behind = await handleExecuteStep(
      { run_id: runId, command: 'after', params: {} },
      { runStore, workflowStore },
    );
    // (a) red when the question is not named, its answer not offered, or the routing is not
    // resolve_precondition; (b) prints the reply.
    expect({ ...routing(behind), hint: behind.context_hint }).toEqual({
      status: 'blocked',
      agent_action: 'resolve_precondition',
      next: ['submit_human_response:'],
      eligible_steps: [],
      hint: "Step 'after' cannot be called now: it waits on the question on step 'confirm' (choices: approve, reject) — answer it with submit_human_response.",
    });
    const strand: WorkflowDefinition = {
      id: 'rae-strand',
      name: 'strand',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        a: J9R1.steps['a']!,
        c: { description: 'After a.', execution: 'auto', depends_on: ['a'] },
      },
    };
    await workflowStore.register(strand);
    const { run } = await runStore.create({
      workflowId: strand.id,
      workflowVersion: 1,
      params: {},
    });
    const stuck = await handleExecuteStep(
      { run_id: run.id, command: 'c', params: {} },
      { runStore, workflowStore },
    );
    // (a) red when resolve_precondition comes back with nothing to call, or the way out is dropped;
    // (b) prints the reply.
    expect(routing(stuck)).toEqual({
      status: 'blocked',
      agent_action: 'report_to_user',
      next: [],
      eligible_steps: [],
    });
    expect(stuck.context_hint).toBe(
      "Step 'c' cannot be called now: a step it depends on cannot run ('a'). 'a' cannot run (precondition): Precondition failed for step 'a'. Precondition failed: 'b.output.go == true'. Resolved value: undefined. " +
        WAY_OUT,
    );
  });
  it('C117, C118, W3-R1: a wrong gate id on an EXPIRED question offers advance_run and says its time is up — get_run_state agrees', async () => {
    const d = gated('rae-w3r1', 'settle_default');
    const { runId, gateId } = await expiredGate(d, true);
    const reply = await handleSubmitHumanResponse(
      { run_id: runId, gate_id: 'not-the-gate', choice: 'reject' },
      { runStore, workflowStore },
    );
    const state = await handleGetRunState({ run_id: runId }, { runStore, workflowStore });
    // (a) red when the refusal offers the answer (no clock: "ask the user again"), routes to
    // report_to_user with something to call, or the hint does not say the time is up; (b) prints them.
    expect({
      status: reply.status,
      agent_action: reply.agent_action,
      next: reply.next_actions.map((a) => a.instruction?.tool),
      hint: reply.context_hint,
      state: state.next_actions_status,
      stateNext: state.next_actions.map((a) => a.instruction?.tool),
    }).toEqual({
      status: 'error',
      agent_action: 'resolve_precondition',
      next: ['advance_run'],
      hint: `Gate 'not-the-gate' is not the open gate and matches no committed resolution. The question on step 'confirm' (gate '${gateId}') can no longer be answered: its time is up — call advance_run to carry out its declared settle_default.`,
      state: 'advance_owed',
      stateNext: ['advance_run'],
    });
    // (a) red when the refusal's act is not the view's (the one composition); (b) prints both.
    expect(reply.next_actions).toEqual(state.next_actions);
    // (a) red when the refusal carried the expiry out (it refuses; advance_run does that); (b) prints it.
    expect((await runStore.get(runId)).pending_gate?.gate_id).toBe(gateId);
  });

  it('C117 CONTROL: the same wrong gate id on an open question whose time is not up offers the answer — resolve_precondition, the question named', async () => {
    const d = gated('rae-w3r1-ctl', 'settle_default');
    const { runId, gateId } = await expiredGate(d, false);
    const reply = await handleSubmitHumanResponse(
      { run_id: runId, gate_id: 'not-the-gate', choice: 'reject' },
      { runStore, workflowStore },
    );
    // (a) red when an unexpired question offers advance_run, or the answer is not offered; (b) prints it.
    expect({
      agent_action: reply.agent_action,
      next: reply.next_actions,
      hint: reply.context_hint,
    }).toEqual({
      agent_action: 'resolve_precondition',
      next: [
        answerAction(runId, { step: 'confirm', gate_id: gateId, choices: ['approve', 'reject'] }),
      ],
      hint: `Gate 'not-the-gate' is not the open gate and matches no committed resolution. The open question is on step 'confirm' (gate '${gateId}') — answer it as next_actions says.`,
    });
  });

  it("C119, W1-R1: advance_run's MCP reply carries empty data and evidence, as execute_step's", async () => {
    const base = gated('rae-w1r1', 'settle_default');
    // `after` runs a handler whose output is not empty, so neither half would be empty by chance.
    const d: WorkflowDefinition = {
      ...base,
      steps: { ...base.steps, after: { ...base.steps['after']!, handler: 'stamp' } },
    };
    const { runId } = await expiredGate(d, true);
    const registry = new ExtensionRegistry();
    registry.register('handler', 'stamp', {
      id: 'stamp',
      execute: async () => ({ data: { stamped: true } }),
    } as never);
    const server = new McpServer({ name: 'test', version: '0' });
    registerAdvanceRun(server, { runStore, workflowStore, registry });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0' });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'advance_run', arguments: { run_id: runId } });
      const reply = JSON.parse(
        (result.content as Array<{ type: string; text: string }>)[0]!.text,
      ) as ResponseEnvelope;
      // (a) red when the tool passes the core reply's evidence (the step it ran) through; (b) prints
      // the fields — and that a step did run, so the evidence would not have been empty.
      expect({
        data: reply.data,
        evidence: reply.evidence,
        ran: reply.chained_auto_steps?.map((c) => c.step),
        phase: reply.run_phase,
      }).toEqual({ data: {}, evidence: [], ran: ['after'], phase: 'completed' });
      // (a) red when the run's own evidence is lost (the reply empties; the record keeps); (b) prints it.
      expect((await runStore.get(runId)).evidence.map((e) => e.step_id)).toContain('after');
      // (a) red when the core reply was empty anyway (the cell would prove nothing); (b) prints it.
      const core = await handleAdvanceRun(
        { run_id: (await expiredGate(d, true)).runId },
        {
          runStore,
          workflowStore,
          registry,
        },
      );
      expect({ data: core.data, evidence: core.evidence.length > 0 }).toEqual({
        data: { stamped: true },
        evidence: true,
      });
    } finally {
      await client.close();
    }
  });

  it('C120, W5-R1: execute_step on the step after an expired abort question — blocked and stop: this call ended the run', async () => {
    const d = gated('rae-w5r1', 'abort');
    const { runId, gateId } = await expiredGate(d, true);
    const reply = await handleExecuteStep(
      { run_id: runId, command: 'after', params: {} },
      { runStore, workflowStore },
    );
    // (a) red when the reply is not blocked/stop, offers something, or drops the line that says this
    // call ended the run; (b) prints the reply.
    expect({
      status: reply.status,
      agent_action: reply.agent_action,
      next: reply.next_actions,
      hint: reply.context_hint,
      phase: reply.run_phase,
      line: reply.warnings.filter((w) => w.includes('had expired')),
    }).toEqual({
      status: 'blocked',
      agent_action: 'stop',
      next: [],
      hint: "Step 'after' cannot be called now: the run has ended (aborted).",
      phase: 'aborted',
      line: [
        `gate '${gateId}' on 'confirm' had expired — this execute_step call first carried out its declared abort: the run ended (enacted_via: execute_step).`,
      ],
    });
  });

  it('C135, W2-Y1: a late answer the expiry beat keeps report_to_user and its hint ends with what the run owes — get_run_state agrees', async () => {
    const d = gated('rae-c135-late', 'settle_default');
    const { runId, gateId } = await expiredGate(d, true);
    const reply = await handleSubmitHumanResponse(
      { run_id: runId, gate_id: gateId, choice: 'reject' },
      { runStore, workflowStore },
    );
    const state = await handleGetRunState({ run_id: runId }, { runStore, workflowStore });
    // (a) red when the hint does not say what the run owes, the routing changes, or the refusal's
    // next_actions are not get_run_state's; (b) prints them.
    expect({
      status: reply.status,
      agent_action: reply.agent_action,
      recorded: reply.answer_recorded,
      hint: reply.context_hint,
      next: reply.next_actions.map((a) => a.instruction?.tool),
    }).toEqual({
      status: 'error',
      agent_action: 'report_to_user',
      recorded: false,
      hint: `Gate '${gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded. Owed to the engine: 'after' — call advance_run.`,
      next: ['advance_run'],
    });
    expect(reply.next_actions).toEqual(state.next_actions);
  });

  it('C135: an answer another choice beat keeps report_to_user and its hint ends with what the run owes', async () => {
    const d = gated('rae-c135-conflict', undefined);
    const { runId, gateId } = await expiredGate(d, false);
    const first = await handleSubmitHumanResponse(
      { run_id: runId, gate_id: gateId, choice: 'approve' },
      { runStore, workflowStore },
    );
    expect(first.status).toBe('ok');
    const reply = await handleSubmitHumanResponse(
      { run_id: runId, gate_id: gateId, choice: 'reject' },
      { runStore, workflowStore },
    );
    // (a) red when the hint does not say what the run owes, or the routing changes; (b) prints it.
    expect({
      status: reply.status,
      agent_action: reply.agent_action,
      hint: reply.context_hint,
      next: reply.next_actions.map((a) => a.instruction?.tool),
    }).toEqual({
      status: 'error',
      agent_action: 'report_to_user',
      hint: `Gate '${gateId}' was already resolved with choice 'approve' — your choice 'reject' was not recorded. Owed to the engine: 'after' — call advance_run.`,
      next: ['advance_run'],
    });
  });

  it("C136, W5-Y3: execute_step on the question's own step after that call carried its expiry out — the suggestion says to call advance_run, the only call next_actions holds", async () => {
    const d = gated('rae-c136', 'settle_default');
    const { runId, gateId } = await expiredGate(d, true);
    const reply = await handleExecuteStep(
      { run_id: runId, command: 'confirm', params: {} },
      { runStore, workflowStore },
    );
    // (a) red when the suggestion names steps next_actions does not hold, or the reply changes;
    // (b) prints the reply.
    expect({
      ...routing(reply),
      suggestion: reply.blocked_reason?.suggestion,
      hint: reply.context_hint,
      line: reply.warnings,
    }).toEqual({
      status: 'blocked',
      agent_action: 'resolve_precondition',
      next: ['advance_run:'],
      eligible_steps: ['after'],
      suggestion: 'Call advance_run, as next_actions says.',
      hint: "Step 'confirm' cannot be called now: it has already completed. Owed to the engine: 'after' — call advance_run.",
      line: [
        `gate '${gateId}' on 'confirm' had expired — this execute_step call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: execute_step).`,
      ],
    });
  });
});
