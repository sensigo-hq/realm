// agent-refused-625.test.ts — issue #625 PR-2a, decision C82 over the MCP tools: an agent step the
// run refuses before its claim (a failed precondition, or a `trust` value the engine refuses) is
// never offered. `start_run`'s hint names it with its check instead of "Ready for the agent", and
// offers no `execute_step` for it; `get_run_state` carries it in `agent_refused`; a by-name
// `execute_step` on it gets C66's way out when nothing else can run. Each at the head of the run and
// after another step (chained), each with a control.
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
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import { handleGetRunState } from './get-run-state.js';
import { handleExecuteStep } from './execute-step.js';

const WAY_OUT =
  'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.';

const agent = (extra: Partial<StepDefinition> = {}, depends_on: string[] = []): StepDefinition =>
  ({ description: 'An agent step.', execution: 'agent', depends_on, ...extra }) as StepDefinition;

function def(id: string, steps: Record<string, StepDefinition>): WorkflowDefinition {
  return { id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps };
}

const PRE: Partial<StepDefinition> = { preconditions: ['run.params.ok == true'] };
const TRUST = { trust: 'bogus_value' } as unknown as Partial<StepDefinition>;
const PRE_REFUSAL =
  "Precondition failed for step 'ask'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.";
const TRUST_REFUSAL =
  "'trust: \"bogus_value\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.";

/** `prep` (a bare auto step: it records the run's params, decision C3) then `ask`, whose
 *  precondition reads it. */
const CHAINED: Record<string, StepDefinition> = {
  prep: { description: 'Prep.', execution: 'auto', depends_on: [] },
  ask: agent({ preconditions: ['prep.ok == true'] }, ['prep']),
};

const tools = (actions: Array<{ instruction: { tool: string; call_with: unknown } | null }>) =>
  actions.map((a) =>
    a.instruction === null
      ? null
      : [a.instruction.tool, (a.instruction.call_with as Record<string, unknown>)['command']],
  );

describe('#625 PR-2a, C82 — an agent step refused before its claim, over the MCP tools', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-agent-refused-625-'));
    runStore = new JsonFileStore(join(dir, 'runs'));
    workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  });

  async function start(d: WorkflowDefinition, params: Record<string, unknown> = {}) {
    await workflowStore.register(d);
    const r = await handleStartRun({ workflow_id: d.id, params }, { runStore, workflowStore });
    return { r, hint: r.context_hint.split(r.run_id).join('<run>') };
  }

  it('start_run, head: the hint names the step and the way out — no "Ready for the agent", no execute_step', async () => {
    const { r, hint } = await start(def('ar-head', { ask: agent(PRE) }));
    // (a) red when the view offers the agent step unchecked; (b) prints the hint and the actions.
    expect({ hint, next: tools(r.next_actions) }).toEqual({
      hint: `Run '<run>' created for workflow 'ar-head'. 'ask' cannot run (precondition): ${PRE_REFUSAL} ${WAY_OUT}`,
      next: [],
    });
  });

  it('CONTROL — start_run, head: beside a ready agent step, the refused one is named and the ready one offered (no way out)', async () => {
    const { r, hint } = await start(def('ar-head-ready', { ask: agent(PRE), ok: agent() }));
    expect({ hint, next: tools(r.next_actions) }).toEqual({
      hint: `Run '<run>' created for workflow 'ar-head-ready'. Ready for the agent: 'ok'. 'ask' cannot run (precondition): ${PRE_REFUSAL}`,
      next: [['execute_step', 'ok']],
    });
  });

  it('start_run, chained: after the engine ran the step before it, the refused agent step is named with the way out', async () => {
    const { r, hint } = await start(def('ar-chained', CHAINED));
    // `prep` records the run's params ({}), so `prep.ok == true` fails.
    expect({ status: r.status, hint, next: tools(r.next_actions) }).toEqual({
      status: 'ok',
      hint:
        "Step 'prep' completed. 'ask' cannot run (precondition): Precondition failed for step 'ask'. Precondition failed: 'prep.ok == true'. Resolved value: undefined. " +
        WAY_OUT,
      next: [],
    });
  });

  it('CONTROL — start_run, chained: the precondition passes, the agent step is offered', async () => {
    const { r, hint } = await start(def('ar-chained-ok', CHAINED), { ok: true });
    // `prep` records `{ ok: true }`, so the precondition passes.
    expect({ hint, next: tools(r.next_actions) }).toEqual({
      hint: "Step 'prep' completed. Ready for the agent: 'ask'.",
      next: [['execute_step', 'ask']],
    });
  });

  it('get_run_state carries agent_refused (head), with no next action; CONTROL: a ready agent step has none', async () => {
    const { r } = await start(def('ar-state', { ask: agent(PRE) }));
    const state = await handleGetRunState({ run_id: r.run_id }, { runStore, workflowStore });
    // (a) red when get_run_state drops the field or the view offers the step; (b) prints the reply.
    expect({
      status: state.next_actions_status,
      next: tools(state.next_actions as never),
      agent_refused: state.agent_refused,
      engine_runnable: state.engine_runnable,
    }).toEqual({
      status: 'ok',
      next: [],
      agent_refused: [
        { step: 'ask', runnable_here: false, refused_by: 'precondition', refusal: PRE_REFUSAL },
      ],
      engine_runnable: undefined,
    });
    const ready = await start(def('ar-state-ok', { ok: agent() }));
    const control = await handleGetRunState(
      { run_id: ready.r.run_id },
      { runStore, workflowStore },
    );
    expect({ next: tools(control.next_actions as never), has: 'agent_refused' in control }).toEqual(
      { next: [['execute_step', 'ok']], has: false },
    );
  });

  it('get_run_state carries a refused trust (#508’s read-time voice)', async () => {
    const { r } = await start(def('ar-state-trust', { ask: agent(TRUST) }));
    const state = await handleGetRunState({ run_id: r.run_id }, { runStore, workflowStore });
    expect(state.agent_refused).toEqual([
      { step: 'ask', runnable_here: false, refused_by: 'trust', refusal: TRUST_REFUSAL },
    ]);
  });

  describe('a by-name execute_step on the refused agent step (C66)', () => {
    it('precondition, nothing else can run: the refusal, then the way out', async () => {
      const { r } = await start(def('ar-bn-pre', { ask: agent(PRE) }));
      const reply = await handleExecuteStep(
        { run_id: r.run_id, command: 'ask', params: {} },
        { runStore, workflowStore },
      );
      // (a) red when the by-name way out reads engine steps only; (b) prints status and hint.
      expect({ status: reply.status, hint: reply.context_hint }).toEqual({
        status: 'blocked',
        hint: `Precondition failed for step 'ask'. ${WAY_OUT}`,
      });
    });

    it('CONTROL — precondition, an agent step is ready: the refusal byte-identical', async () => {
      const { r } = await start(def('ar-bn-pre-ready', { ask: agent(PRE), ok: agent() }));
      const reply = await handleExecuteStep(
        { run_id: r.run_id, command: 'ask', params: {} },
        { runStore, workflowStore },
      );
      expect({ status: reply.status, hint: reply.context_hint }).toEqual({
        status: 'blocked',
        hint: "Precondition failed for step 'ask'.",
      });
    });

    it('trust, nothing else can run: the refusal, then the way out', async () => {
      const { r } = await start(def('ar-bn-trust', { ask: agent(TRUST) }));
      const reply = await handleExecuteStep(
        { run_id: r.run_id, command: 'ask', params: {} },
        { runStore, workflowStore },
      );
      expect({
        status: reply.status,
        error_code: reply.error_code,
        hint: reply.context_hint,
      }).toEqual({
        status: 'error',
        error_code: 'VALIDATION_TRUST_VALUE',
        hint: `Error during 'ask'. Run phase: 'running'. ${WAY_OUT}`,
      });
    });
  });
});
