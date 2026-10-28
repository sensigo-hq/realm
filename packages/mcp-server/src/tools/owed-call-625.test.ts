// owed-call-625.test.ts — issue #625 PR-2a, the MCP side of the owed call: decision C1 (a deduped
// start_run runs nothing), C10 (start_run's derived phase), the advance_owed status word and the
// summary's `engine_runnable` / `pending_guards`, C8 (get_run_state judges the capability check with
// the server's registry), and start_run_batch's per-entry next_actions.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import { handleStartRunBatch } from './start-run-batch.js';
import { handleGetRunState } from './get-run-state.js';
import { handleAdvanceRun } from './advance-run.js';
import { handleSubmitHumanResponse } from './submit-human-response.js';
import { handleExecuteStep } from './execute-step.js';

const owedDef: WorkflowDefinition = {
  id: 'owed-wf',
  name: 'owed',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    write: { description: 'Write.', execution: 'agent', depends_on: [] },
    after: { description: 'After.', execution: 'auto', depends_on: ['write'] },
    finish: { description: 'Finish.', execution: 'agent', depends_on: ['after'] },
  },
};

const headDef: WorkflowDefinition = {
  id: 'head-wf',
  name: 'head',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    head: { description: 'Head.', execution: 'auto', depends_on: [] },
    finish: { description: 'Finish.', execution: 'agent', depends_on: ['head'] },
  },
};

const handlerDef: WorkflowDefinition = {
  id: 'handler-wf',
  name: 'handler',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { enrich: { description: 'Enrich.', execution: 'auto', depends_on: [], handler: 'h' } },
};

describe('#625 PR-2a — the owed call over the MCP handlers', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-owed-625-'));
    runStore = new JsonFileStore(join(dir, 'runs'));
    workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    for (const d of [owedDef, headDef, handlerDef]) await workflowStore.register(d);
  });

  it('C1: a deduped start_run runs NOTHING — the owed step stays owed and the reply names the act', async () => {
    const first = await handleStartRun(
      { workflow_id: headDef.id, params: { a: 1 }, idempotency_key: 'k' },
      { runStore, workflowStore },
    );
    expect(first.deduped).toBe(false);
    expect(first.chained_auto_steps?.map((c) => c.step)).toEqual(['head']);
    // Make the run owe engine work again: a run whose head step is still owed.
    const { run } = await runStore.create({
      workflowId: owedDef.id,
      workflowVersion: 1,
      params: { a: 1 },
      idempotencyKey: 'k2',
    });
    const updated = await runStore.update({
      ...run,
      completed_steps: ['write'],
      evidence: [
        {
          step_id: 'write',
          started_at: run.created_at,
          completed_at: run.created_at,
          duration_ms: 0,
          input_summary: {},
          output_summary: {},
          status: 'success',
          evidence_hash: 'x',
        },
      ],
    });
    const deduped = await handleStartRun(
      { workflow_id: owedDef.id, params: { other: 2 }, idempotency_key: 'k2' },
      { runStore, workflowStore },
    );
    expect(deduped.deduped).toBe(true);
    expect(deduped.chained_auto_steps).toBeUndefined();
    expect((await runStore.get(run.id)).version).toBe(updated.version);
    expect((await runStore.get(run.id)).completed_steps).toEqual(['write']);
    expect(deduped.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
  });

  it("C10: start_run's chained reply reports the DERIVED phase", async () => {
    const r = await handleStartRun(
      { workflow_id: headDef.id, params: {} },
      { runStore, workflowStore },
    );
    expect(r.run_phase).toBe('running');
    expect(r.context_hint).toBe("Step 'head' completed. Ready for the agent: 'finish'.");
  });

  it('get_run_state: advance_owed, the act alone, and engine_runnable', async () => {
    const { run } = await runStore.create({
      workflowId: headDef.id,
      workflowVersion: 1,
      params: {},
    });
    const state = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(state.next_actions_status).toBe('advance_owed');
    expect(state.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
    expect(state.engine_runnable).toEqual([{ step: 'head', runnable_here: true }]);
    expect(state.pending_guards).toBeUndefined();
  });

  it('C8: with the server registry, a capability refusal withdraws the act; with none it is unknown', async () => {
    const { run } = await runStore.create({
      workflowId: handlerDef.id,
      workflowVersion: 1,
      params: {},
    });
    const unknown = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(unknown.engine_runnable).toEqual([{ step: 'enrich', runnable_here: 'unknown' }]);
    expect(unknown.next_actions_status).toBe('advance_owed');
    const refused = await handleGetRunState(
      { run_id: run.id },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(refused.engine_runnable).toEqual([
      {
        step: 'enrich',
        runnable_here: false,
        refused_by: 'capability',
        refusal: "handler 'h' is not registered here",
        basis: 'registry',
        // #872 (a) (add-only): the handler or adapter refused, as data.
        requirement: { kind: 'handler', name: 'h' },
      },
    ]);
    expect(refused.next_actions).toEqual([]);
    // decision C33: this server cannot run the only owed step — said before any attempt.
    expect(refused.next_actions_status).toBe('blocked_on_capability');
    // A registry provider that throws is never a new failure on a poll: the view keeps the observer
    // reading (unknown); #729 PR-0 (A-5, Q19): nothing it would run is offered, and a warning says why.
    const fallback = await handleGetRunState(
      { run_id: run.id },
      {
        runStore,
        workflowStore,
        registryProvider: async () => {
          throw new Error('extensions broken');
        },
      },
    );
    expect(fallback.engine_runnable?.[0]?.runnable_here).toBe('unknown');
  });

  it('C33: the capability check reads the freshest fact — this registry, else the run marker, else unknown', async () => {
    const { advanceRun } = await import('@sensigo/realm');
    const { run } = await runStore.create({
      workflowId: handlerDef.id,
      workflowVersion: 1,
      params: {},
    });
    // An earlier runner that lacked the handler attempted the step: the marker is on the record.
    await advanceRun(runStore, handlerDef, { runId: run.id, registry: new ExtensionRegistry() });
    expect((await runStore.get(run.id)).capability_blocks?.['enrich']).toBeDefined();

    // No registry: the marker is the freshest fact — refused, in the past tense, and no act.
    const noRegistry = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    expect(noRegistry.engine_runnable).toEqual([
      {
        step: 'enrich',
        runnable_here: false,
        refused_by: 'capability',
        refusal: "handler 'h' was not registered in the runner that last attempted it",
        // decision C41: the summary says what the refusal was judged from.
        basis: 'marker',
        // #872 (a) (add-only): the handler or adapter refused, as data.
        requirement: { kind: 'handler', name: 'h' },
      },
    ]);
    expect(noRegistry.next_actions).toEqual([]);
    expect(noRegistry.next_actions_status).toBe('blocked_on_capability');

    // A registry that HAS the handler wins over the old marker: runnable, the act, advance_owed.
    const capable = new ExtensionRegistry();
    capable.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) } as never);
    const canRun = await handleGetRunState(
      { run_id: run.id },
      { runStore, workflowStore, registry: capable },
    );
    expect(canRun.engine_runnable).toEqual([{ step: 'enrich', runnable_here: true }]);
    expect(canRun.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
    expect(canRun.next_actions_status).toBe('advance_owed');
    // The marker stays visible as history.
    expect(canRun.capability_blocks?.map((b) => b.step)).toEqual(['enrich']);

    // A registry that lacks it: refused here, no act, blocked_on_capability.
    const lacks = await handleGetRunState(
      { run_id: run.id },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(lacks.engine_runnable?.[0]).toEqual({
      step: 'enrich',
      runnable_here: false,
      refused_by: 'capability',
      refusal: "handler 'h' is not registered here",
      basis: 'registry',
      // #872 (a) (add-only): the handler or adapter refused, as data.
      requirement: { kind: 'handler', name: 'h' },
    });
    expect(lacks.next_actions).toEqual([]);
    expect(lacks.next_actions_status).toBe('blocked_on_capability');
  });

  it('C46: a server that HAS the handler reports no capability_block finding for the step (the marker stays as history); one that lacks it, or passes none, keeps the finding', async () => {
    const { advanceRun } = await import('@sensigo/realm');
    const { run } = await runStore.create({
      workflowId: handlerDef.id,
      workflowVersion: 1,
      params: {},
    });
    await advanceRun(runStore, handlerDef, { runId: run.id, registry: new ExtensionRegistry() });
    const capable = new ExtensionRegistry();
    capable.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) } as never);
    const canRun = await handleGetRunState(
      { run_id: run.id },
      { runStore, workflowStore, registry: capable },
    );
    expect(canRun.engine_runnable).toEqual([{ step: 'enrich', runnable_here: true }]);
    expect(canRun.run_health).toBeUndefined();
    expect((canRun.warnings ?? []).some((w) => w.includes('active run-health finding'))).toBe(
      false,
    );
    expect(canRun.capability_blocks?.map((b) => b.step)).toEqual(['enrich']);
    for (const registry of [new ExtensionRegistry(), undefined]) {
      const lacking = await handleGetRunState(
        { run_id: run.id },
        { runStore, workflowStore, ...(registry !== undefined ? { registry } : {}) },
      );
      expect(lacking.run_health?.map((f) => [f.kind, f.step])).toEqual([
        ['capability_block', 'enrich'],
      ]);
      expect(lacking.warnings ?? []).toContain(
        "this run has 1 active run-health finding(s) — see 'run_health' for detail.",
      );
    }
  });

  it('C45: a created run on which nothing ran says what comes next in its hint — an engine step that cannot run is named', async () => {
    const refusedDef: WorkflowDefinition = {
      id: 'refused-head-wf',
      name: 'refused head',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        compute: {
          description: 'Compute.',
          execution: 'auto',
          depends_on: [],
          input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
        },
        summarize: { description: 'Summarize.', execution: 'agent', depends_on: [] },
      },
    };
    await workflowStore.register(refusedDef);
    const r = await handleStartRun(
      { workflow_id: refusedDef.id, params: { text: 'x' } },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(r.chained_auto_steps).toBeUndefined();
    expect(r.context_hint).toBe(
      `Run '${r.run_id}' created for workflow 'refused-head-wf'. Ready for the agent: 'summarize'. 'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'.`,
    );
    expect(r.next_actions.map((a) => a.instruction?.tool)).toEqual(['execute_step']);
    // A deduped match keeps its own sentence (nothing is created, nothing ran), then says what comes
    // next, as every reply that hands a run back does (decision C64: `handBackHint`).
    const again = await handleStartRun(
      { workflow_id: refusedDef.id, params: { text: 'x' }, idempotency_key: 'c45' },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    const deduped = await handleStartRun(
      { workflow_id: refusedDef.id, params: { text: 'x' }, idempotency_key: 'c45' },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(again.deduped).toBe(false);
    expect(deduped.deduped).toBe(true);
    expect(deduped.context_hint).toBe(
      `Matched existing run '${again.run_id}' (idempotent) in phase 'running'; no new run created. Ready for the agent: 'summarize'. 'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'.`,
    );
    // A superseding run (on_terminal_match: rerun) on which nothing ran names what comes next too.
    const { abandonRun } = await import('@sensigo/realm');
    await abandonRun(runStore, again.run_id);
    const rerun = await handleStartRun(
      {
        workflow_id: refusedDef.id,
        params: { text: 'x' },
        idempotency_key: 'c45',
        on_terminal_match: 'rerun',
      },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(rerun.deduped).toBe(false);
    expect(rerun.context_hint).toBe(
      `Run '${rerun.run_id}' created for workflow 'refused-head-wf'; it supersedes run '${again.run_id}' under the same idempotency key (on_terminal_match). Ready for the agent: 'summarize'. 'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'.`,
    );
  });

  it('start_run_batch: each started entry carries next_actions; no step runs', async () => {
    const batch = await handleStartRunBatch(
      { workflow_id: headDef.id, items: [{ params: {} }, { params: { b: 1 } }] },
      { runStore, workflowStore },
    );
    for (const entry of batch.started) {
      expect(entry.next_actions.map((a) => a.instruction?.tool)).toEqual(['advance_run']);
      expect((await runStore.get(entry.run_id)).completed_steps).toEqual([]);
    }
  });

  it("C25: advance_run's reply ends with one clause per step another process claimed", async () => {
    const { run } = await runStore.create({
      workflowId: headDef.id,
      workflowVersion: 1,
      params: {},
    });
    const realClaim = runStore.claimStep.bind(runStore);
    let first = true;
    runStore.claimStep = async (...args: Parameters<JsonFileStore['claimStep']>) => {
      if (first) {
        first = false;
        await realClaim(args[0], args[1], args[2], {
          by: 'other@host',
          by_source: 'derived',
          channel: 'agent',
        });
      }
      return realClaim(...args);
    };
    const reply = await handleAdvanceRun({ run_id: run.id }, { runStore, workflowStore });
    expect(reply.chained_auto_steps).toBeUndefined();
    expect(reply.context_hint).toBe(
      // decision C205: nothing is ready because 'head' is in flight elsewhere — wait for it.
      `Run '${run.id}': nothing ran. No step is ready: 'head' is in flight elsewhere — wait for it, then call get_run_state. 'head' was claimed by another process, so it did not run here.`,
    );
  });

  it('advance_run: continued_by is the absent form when the host passed no driver', async () => {
    const { run } = await runStore.create({
      workflowId: headDef.id,
      workflowVersion: 1,
      params: {},
    });
    const reply = await handleAdvanceRun({ run_id: run.id }, { runStore, workflowStore });
    expect(reply.continued_by).toEqual({ by: null, absent_cause: 'driver_not_recorded' });
    expect(reply.chained_auto_steps?.map((c) => c.step)).toEqual(['head']);
  });

  // decision C52: on a CREATED run, a capability block from advanceRun is not the call's failure.
  const capHeadDef: WorkflowDefinition = {
    id: 'cap-head-wf',
    name: 'cap head',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      enrich: { description: 'Enrich.', execution: 'auto', depends_on: [], handler: 'h' },
      ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
    },
  };
  // #729 (the Q3 unit, C1): core's hint says what is so — no door word (`next_actions`) in core; the
  // MCP reply of the call that attempted the step ends with the door's capability sentence (below).
  const BLOCK =
    "Step 'enrich' is blocked: its handler 'h' is not registered in this runner. The run is NOT terminated — the step remains eligible, so a runner that provides this handler can execute it.";
  const CAPABILITY =
    "'enrich' cannot run here (capability): handler 'h' is not registered here — load the missing extension, or run the step on a runner that has it.";

  it('C52: start_run on a created run whose engine attempt is capability-blocked returns the creation reply — ok, the step named, the block in warnings', async () => {
    await workflowStore.register(capHeadDef);
    const r = await handleStartRun(
      { workflow_id: capHeadDef.id, params: {} },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(r.status).toBe('ok');
    expect(r.error_code).toBeUndefined();
    expect(r.agent_action).toBeUndefined();
    expect(r.errors).toEqual([]);
    expect(r.context_hint).toBe(
      `Run '${r.run_id}' created for workflow 'cap-head-wf'. Ready for the agent: 'ask'. 'enrich' cannot run here (capability): handler 'h' is not registered here — load the missing extension, or run the step on a runner that has it.`,
    );
    // decision C58: the step was reached and blocked, so its pre-flight warning ("If reached it will
    // block") is dropped beside the block that happened — exactly one warning about 'enrich'.
    expect(r.warnings).toEqual([BLOCK]);
    expect(r.warnings.filter((w) => w.includes("'enrich'"))).toHaveLength(1);
    expect(r.next_actions.map((a) => a.instruction?.tool)).toEqual(['execute_step']);
    // The attempt was made and recorded: the marker is on the record, and the reply's version is
    // the record's.
    const after = await runStore.get(r.run_id);
    expect(after.capability_blocks?.['enrich']).toBeDefined();
    expect(r.run_version).toBe(after.version);
    expect(r.run_phase).toBe('running');
  });

  it('C52 control: advance_run on the same capability case still returns the error — its own attempt failed', async () => {
    await workflowStore.register(capHeadDef);
    const { run } = await runStore.create({
      workflowId: capHeadDef.id,
      workflowVersion: 1,
      params: {},
    });
    const reply = await handleAdvanceRun(
      { run_id: run.id },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(reply.status).toBe('error');
    expect(reply.error_code).toBe('ENGINE_HANDLER_NOT_REGISTERED');
    // #729 (the Q3 unit, C1): core's two sentences, then the door's way out (cannotRunClause).
    expect(reply.context_hint).toBe(`${BLOCK} ${CAPABILITY}`);
  });

  it('C52 control: a FAILED engine step on a created run still returns the error reply', async () => {
    const failDef: WorkflowDefinition = {
      id: 'fail-head-wf',
      name: 'fail head',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        boom: { description: 'Boom.', execution: 'auto', depends_on: [], handler: 'boom' },
        ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
      },
    };
    await workflowStore.register(failDef);
    const registry = new ExtensionRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error('boom failed');
      },
    } as never);
    const r = await handleStartRun(
      { workflow_id: failDef.id, params: {} },
      { runStore, workflowStore, registry },
    );
    expect(r.status).toBe('error');
    expect(r.error_code).not.toBe('ENGINE_HANDLER_NOT_REGISTERED');
    expect(r.context_hint).not.toContain(`created for workflow`);
  });

  it('C53: an answer on a server without the handler names the way out (registry basis)', async () => {
    const gateDef: WorkflowDefinition = {
      id: 'gate-cap-wf',
      name: 'gate cap',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        review: {
          description: 'Review.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'] },
        },
        process: {
          description: 'Process.',
          execution: 'auto',
          depends_on: ['review'],
          handler: 'p',
        },
      },
    };
    await workflowStore.register(gateDef);
    const lacking = new ExtensionRegistry();
    const s = await handleStartRun(
      { workflow_id: gateDef.id, params: {} },
      { runStore, workflowStore, registry: lacking },
    );
    const gate = (await runStore.get(s.run_id)).pending_gate!;
    const answer = await handleSubmitHumanResponse(
      { run_id: s.run_id, gate_id: gate.gate_id, choice: 'approve' },
      { runStore, workflowStore, registry: lacking },
    );
    expect(answer.status).toBe('ok');
    expect(answer.context_hint).toBe(
      "Gate 'review' resolved with choice 'approve'. 'process' cannot run here (capability): handler 'p' is not registered here — load the missing extension, or run the step on a runner that has it.",
    );
    expect(answer.next_actions).toEqual([]);
  });

  it("C49: start_run's hint names a trust-refused step in the read-time voice", async () => {
    const trustDef: WorkflowDefinition = {
      id: 'trust-head-wf',
      name: 'trust head',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        compute: { description: 'Compute.', execution: 'auto', depends_on: [] },
        ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
      },
    };
    await workflowStore.register(trustDef);
    // The loader refuses an invalid trust value in a file; a registered copy written by an older
    // version can carry one. Planted here through the store's own write.
    const stored = await workflowStore.get(trustDef.id);
    (stored.steps['compute'] as { trust?: unknown }).trust = 'human_confimred';
    await workflowStore.register(stored);
    const r = await handleStartRun(
      { workflow_id: trustDef.id, params: {} },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(r.status).toBe('ok');
    expect(r.context_hint).toBe(
      `Run '${r.run_id}' created for workflow 'trust-head-wf'. Ready for the agent: 'ask'. 'compute' cannot run (trust): 'trust: "human_confimred"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed; did you mean 'human_confirmed'? — correct the value and 'realm workflow register <path>'.`,
    );
    expect(r.context_hint).not.toContain('parked');
  });
  // decision C57: every reply that says what comes next ends with the tools' way out when the run
  // cannot go on until its workflow is corrected — not only advance_run's nothing-ran reply.
  // F15: `compute` is refused for its input — its own way out, by whether it has `depends_on`.
  const TOOLS_WAY_OUT =
    // #729 PR-0 (T-20 (i)): a new run is a way out, so the run's way says THIS run stays open.
    "For 'compute', start a run with params that fit, or correct its input_schema and register the workflow again; this run stays open — after a fix, call advance_run on it; or end it with abandon_run.";
  const TOOLS_WAY_OUT_DEPS =
    "For 'compute', the engine gives it no input, so correct its input_schema and register the workflow again; then, after a fix, call advance_run; or end the run with abandon_run.";
  const needsN = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } };
  const C57_REFUSAL =
    "'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'.";

  it("C57: start_run's creation hint ends with the way out when the new run's only engine step is refused before its claim", async () => {
    const onlyDef: WorkflowDefinition = {
      id: 'c57-only-wf',
      name: 'c57 only',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        compute: { description: 'C.', execution: 'auto', depends_on: [], input_schema: needsN },
      },
    };
    await workflowStore.register(onlyDef);
    const r = await handleStartRun(
      { workflow_id: onlyDef.id, params: {} },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(r.status).toBe('ok');
    expect(r.next_actions).toEqual([]);
    expect(r.context_hint).toBe(
      `Run '${r.run_id}' created for workflow 'c57-only-wf'. ${C57_REFUSAL} ${TOOLS_WAY_OUT}`,
    );
  });

  it("C57: execute_step's reply after the last agent step ends with the way out; with another agent step ready it does not", async () => {
    const lastDef: WorkflowDefinition = {
      id: 'c57-last-wf',
      name: 'c57 last',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
        compute: {
          description: 'C.',
          execution: 'auto',
          depends_on: ['ask'],
          input_schema: needsN,
        },
      },
    };
    const notLastDef: WorkflowDefinition = {
      id: 'c57-not-last-wf',
      name: 'c57 not last',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
        ask2: { description: 'Ask 2.', execution: 'agent', depends_on: ['ask'] },
        compute: {
          description: 'C.',
          execution: 'auto',
          depends_on: ['ask'],
          input_schema: needsN,
        },
      },
    };
    await workflowStore.register(lastDef);
    await workflowStore.register(notLastDef);
    const stores = { runStore, workflowStore, registry: new ExtensionRegistry() };
    const a = await handleStartRun({ workflow_id: lastDef.id, params: {} }, stores);
    const e = await handleExecuteStep({ run_id: a.run_id, command: 'ask', params: {} }, stores);
    expect(e.status).toBe('ok');
    expect(e.next_actions).toEqual([]);
    expect(e.context_hint).toBe(`Step 'ask' completed. ${C57_REFUSAL} ${TOOLS_WAY_OUT_DEPS}`);
    const b = await handleStartRun({ workflow_id: notLastDef.id, params: {} }, stores);
    const f = await handleExecuteStep({ run_id: b.run_id, command: 'ask', params: {} }, stores);
    expect(f.context_hint).toBe(
      `Step 'ask' completed. Ready for the agent: 'ask2'. ${C57_REFUSAL}`,
    );
  });

  it("C58: a pre-flight warning for a step that was NOT reached stays; only the blocked step's is dropped", async () => {
    const twoDef: WorkflowDefinition = {
      id: 'c58-two-wf',
      name: 'c58 two',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        enrich: { description: 'Enrich.', execution: 'auto', depends_on: [], handler: 'h' },
        ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
        later: { description: 'Later.', execution: 'auto', depends_on: ['ask'], handler: 'h2' },
      },
    };
    await workflowStore.register(twoDef);
    const r = await handleStartRun(
      { workflow_id: twoDef.id, params: {} },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    expect(r.status).toBe('ok');
    expect(r.warnings).toEqual([
      "Step 'later' needs handler 'h2', which is not registered in this runner. If reached it will block recoverably (not fail) until a runner that provides this handler executes it — load the missing extension or run on a capable runner.",
      // #729 (the Q3 unit, C1): start_run's warnings carry core's hint (no door word in core).
      "Step 'enrich' is blocked: its handler 'h' is not registered in this runner. The run is NOT terminated — the step remains eligible, so a runner that provides this handler can execute it.",
    ]);
  });
});

describe('#872 (a) — the hand-back hint and engine_runnable.requirement over the MCP handlers', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-owed-872-'));
    runStore = new JsonFileStore(join(dir, 'runs'));
    workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  });
  /** Two `auto` roots that need the handler `h`, which these servers lack. */
  const twoRoots: WorkflowDefinition = {
    id: 'two-roots-wf',
    name: 'two roots',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      s1: { description: 'S1.', execution: 'auto', depends_on: [], handler: 'h' },
      s2: { description: 'S2.', execution: 'auto', depends_on: [], handler: 'h' },
    },
  };
  // correction 1 (C4): one missing handler, the singular way out.
  const TAIL =
    ' — load the missing extension, or run these steps on a runner that has it. get_run_state lists each one in engine_runnable.';

  it('B3 (door): start_run on a new run with two steps this server cannot run — the count, one group, the way out once; no way out of the workflow', async () => {
    await workflowStore.register(twoRoots);
    const r = await handleStartRun(
      { workflow_id: twoRoots.id, params: {} },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    const hint = String(r.context_hint);
    // (a) red when the two steps are said one sentence each, or the workflow's way out is added;
    //     (b) prints the status, the hint and the counts.
    expect({
      status: r.status,
      hint,
      here: hint.split('cannot run here').length - 1,
      wayOut: hint.includes('Correct the workflow'),
    }).toEqual({
      status: 'ok',
      hint: `Run '${r.run_id}' created for workflow 'two-roots-wf'. 2 steps cannot run here (capability): handler 'h' ('s1', 's2')${TAIL}`,
      here: 1,
      wayOut: false,
    });
  });

  it("B6 (b) (door): a caller with no registry judges by the run's markers — the past-tense summary, no way out, in start_run_batch's hint", async () => {
    const { advanceRun } = await import('@sensigo/realm');
    await workflowStore.register(twoRoots);
    const batch = () =>
      handleStartRunBatch(
        { workflow_id: twoRoots.id, items: [{ params: {}, idempotency_key: 'k-872' }] },
        { runStore, workflowStore },
      );
    const runId = (await batch()).started[0]!.run_id;
    // A runner that lacked the handler attempted the steps: the markers are on the record. Each
    // advance_run stops at the step it could not dispatch, so it takes two calls to mark both (one
    // marker per call, measured).
    await advanceRun(runStore, twoRoots, { runId, registry: new ExtensionRegistry() });
    await advanceRun(runStore, twoRoots, { runId, registry: new ExtensionRegistry() });
    const marked = Object.keys((await runStore.get(runId)).capability_blocks ?? {});
    const hint = String((await batch()).started[0]!.context_hint);
    // (a) red when the marker branch is dropped (the present tense and the way out appear) or the
    //     two steps are said one sentence each; (b) prints the markers and the hint.
    expect({ marked, tail: hint.slice(hint.indexOf('2 steps')) }).toEqual({
      marked: ['s1', 's2'],
      tail: "2 steps could not run (capability): handler 'h' ('s1', 's2'). get_run_state lists each one in engine_runnable.",
    });
  });

  it('B8: get_run_state names the handler or adapter refused in engine_runnable.requirement — the registry’s, or the marker’s — and only for a capability refusal', async () => {
    const mixed: WorkflowDefinition = {
      id: 'requirement-wf',
      name: 'requirement',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        enrich: { description: 'Enrich.', execution: 'auto', depends_on: [], handler: 'h' },
        t: { description: 'T.', execution: 'auto', depends_on: [], trust: 'nope' as never },
      },
    };
    await workflowStore.register(mixed);
    const { run } = await runStore.create({
      workflowId: mixed.id,
      workflowVersion: 1,
      params: {},
    });
    const byRegistry = await handleGetRunState(
      { run_id: run.id },
      { runStore, workflowStore, registry: new ExtensionRegistry() },
    );
    // The run's marker names another adapter than the definition's handler: the field is the
    // marker's, as the refusal's words are.
    await runStore.update({
      ...run,
      capability_blocks: {
        enrich: {
          requirement: { kind: 'adapter', name: 'from_marker' },
          code: 'ENGINE_ADAPTER_NOT_REGISTERED',
          at: '2026-10-28T00:00:00.000Z',
        },
      },
    });
    const byMarker = await handleGetRunState({ run_id: run.id }, { runStore, workflowStore });
    const entry = (r: typeof byRegistry, step: string) =>
      (r.engine_runnable ?? []).find((e) => e.step === step);
    // (a) red when the field is not set in either branch, is the definition's on a marker, or is
    //     set on a refusal that is not a capability's; (b) prints the entries' fields.
    expect({
      registry: [entry(byRegistry, 'enrich')?.basis, entry(byRegistry, 'enrich')?.requirement],
      marker: [entry(byMarker, 'enrich')?.basis, entry(byMarker, 'enrich')?.requirement],
      trust: [entry(byRegistry, 't')?.refused_by, 'requirement' in (entry(byRegistry, 't') ?? {})],
    }).toEqual({
      registry: ['registry', { kind: 'handler', name: 'h' }],
      marker: ['marker', { kind: 'adapter', name: 'from_marker' }],
      trust: ['trust', false],
    });
  });
});
