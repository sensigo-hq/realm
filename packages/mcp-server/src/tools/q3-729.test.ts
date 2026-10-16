// q3-729.test.ts — issue #729, the Q3 unit (the owner's "q3 - yes", 2026-10-16): over a real MCP
// client, the agent's `execute_step` naming an engine step the engine could run is refused BEFORE
// anything is claimed or written, and told `advance_run`; `advance_run` then runs it with the
// engine's input. The agent's own step, a guard, and a step refused before its claim keep today's
// replies. Part C: the dispatch-time capability block's hint names no door word in core, and the
// MCP reply ends with the door's capability sentence.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: codes,
// step names, field names and booleans — never a token or a value a caller supplied.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  executeStep,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';

type Reply = Record<string, unknown>;
const AGENT_PARAMS = { p: 'AGENT-PARAMS' };

const def = (id: string, steps: WorkflowDefinition['steps']): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  }) as WorkflowDefinition;

/** W3: the agent step `first`, then U, M, B and Q (owed once `first` is answered) and a guard after U. */
const W3 = def('q3-mcp-w3', {
  first: { description: 'First.', execution: 'agent', depends_on: [] },
  u: { description: 'U.', execution: 'auto', depends_on: ['first'], handler: 'h' },
  m: {
    description: 'M.',
    execution: 'auto',
    depends_on: ['first'],
    handler: 'hm',
    input_map: { x: 'run.params.x' },
  },
  b: { description: 'B.', execution: 'auto', depends_on: ['first'] },
  g: { description: 'G.', execution: 'guard', depends_on: ['u'], abort_unless: ["u.ran == 'h'"] },
  q: {
    description: 'Q.',
    execution: 'auto',
    depends_on: ['first'],
    trust: 'human_confirmed',
    gate: { choices: ['yes', 'no'] },
  },
} as WorkflowDefinition['steps']);

/** K: after `first`, only `k` is owed, and this server lacks its handler. */
const WK = def('q3-mcp-wk', {
  first: { description: 'First.', execution: 'agent', depends_on: [] },
  k: { description: 'K.', execution: 'auto', depends_on: ['first'], handler: 'missing' },
} as WorkflowDefinition['steps']);

/** W2's `publish`: refused before its claim for its input (its schema wants `n`). */
const W2 = def('q3-mcp-w2', {
  publish: {
    description: 'Publish.',
    execution: 'auto',
    depends_on: [],
    input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
  },
} as WorkflowDefinition['steps']);

/** Walk 2's workflow A: the agent step `first`, then `nope`, whose handler this server lacks. */
const WA = def('q3-mcp-wa', {
  first: { description: 'First.', execution: 'agent', depends_on: [] },
  nope: { description: 'Nope.', execution: 'auto', depends_on: ['first'], handler: 'nope' },
} as WorkflowDefinition['steps']);

function registry(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  r.register('handler', 'h', { id: 'h', execute: async () => ({ data: { ran: 'h' } }) });
  r.register('handler', 'hm', { id: 'hm', execute: async () => ({ data: { ran: 'hm' } }) });
  return r;
}

async function connect() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-q3-mcp-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  for (const d of [W3, WK, W2, WA]) await workflowStore.register(d);
  const server = createRealmMcpServer({ runStore, workflowStore, registry: registry() });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'q3-729', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  return { call, runStore };
}

/** A run of `d` with `first` answered through the library (no chain): its engine steps wait, eligible. */
async function answeredRun(
  c: Awaited<ReturnType<typeof connect>>,
  d: WorkflowDefinition,
): Promise<string> {
  const { run } = await c.runStore.create({
    workflowId: d.id,
    workflowVersion: 1,
    params: { x: 'from-params' },
  });
  await executeStep(c.runStore, d, {
    runId: run.id,
    command: 'first',
    input: {},
    dispatcher: async () => ({ answered: true }),
  });
  return run.id;
}

const tools = (r: Reply) =>
  ((r['next_actions'] as Array<{ instruction: { tool: string } | null }>) ?? []).map(
    (n) => n.instruction?.tool,
  );
const LIBRARY_KEYS = [
  'ways',
  'unavailable',
  'refusal',
  'reply_kind',
  'names_next',
  'intrinsic_action',
];
const OWED_TAIL =
  " Owed to the engine: 'u', 'm', 'b', 'q' — call advance_run; it runs them until a step opens a question, fails or ends the run.";
const engines = (step: string) =>
  `Step '${step}' cannot be called now: it is an automatic step: the engine runs it when it is owed.`;

describe('#729 Q3 — the agent’s execute_step naming an engine step', () => {
  it.each(['u', 'm', 'b', 'q'])(
    'cell 9: %s by name → blocked, the engine’s sentence and the door’s tail, advance_run alone, resolve_precondition; nothing claimed or written',
    async (step) => {
      const c = await connect();
      const runId = await answeredRun(c, W3);
      const before = await c.runStore.get(runId);
      const r = await c.call('execute_step', {
        run_id: runId,
        command: step,
        params: AGENT_PARAMS,
      });
      const after = await c.runStore.get(runId);
      // (a) red when the party conjunct is dropped (the step runs on the agent's params) or the
      //     reply's words or routing change; (b) prints the reply's fields and the record's facts.
      expect({
        status: r['status'],
        error_code: r['error_code'],
        hint: r['context_hint'],
        next: tools(r),
        action: r['agent_action'],
        suggestion: (r['blocked_reason'] as { suggestion?: string }).suggestion,
        library: LIBRARY_KEYS.filter((k) => k in r),
        written: [
          after.version === before.version,
          after.evidence.length,
          Object.keys(after.claims ?? {}),
        ],
      }).toEqual({
        status: 'blocked',
        error_code: undefined,
        hint: `${engines(step)}${OWED_TAIL}`,
        next: ['advance_run'],
        action: 'resolve_precondition',
        suggestion: 'Call advance_run, as next_actions says.',
        library: [],
        written: [true, before.evidence.length, []],
      });
    },
  );

  it.each(['u', 'm', 'b', 'q'])(
    'cell 10: after %s is refused, advance_run runs it with the engine’s input — never the agent’s params',
    async (step) => {
      const c = await connect();
      const runId = await answeredRun(c, W3);
      await c.call('execute_step', { run_id: runId, command: step, params: AGENT_PARAMS });
      const advanced = await c.call('advance_run', { run_id: runId });
      let answer: Reply | undefined;
      if (step === 'q') {
        // The gate opened on advance_run's reply; its answer carries that reply's claim token back.
        const params = (advanced['next_actions'] as Array<{ instruction: { params: Reply } }>)[0]!
          .instruction.params;
        answer = await c.call('submit_human_response', {
          run_id: runId,
          gate_id: params['gate_id'],
          choice: 'yes',
          claim_token: params['claim_token'],
        });
      }
      const after = await c.runStore.get(runId);
      const entry = after.evidence.find((e) => e.step_id === step && e.kind !== 'gate_response');
      // (a) red when advance_run does not run the step, or the step ran on the agent's params, or the
      //     mapped step's input is not its map's; (b) prints the step's state and whether the agent's
      //     params reached the record — never a value.
      expect({
        ran: after.completed_steps.includes(step),
        gate: step === 'q' ? [advanced['status'], answer?.['status']] : undefined,
        agentParams: JSON.stringify(after.evidence).includes('AGENT-PARAMS'),
        mapped: step === 'm' ? entry?.resolved_params : undefined,
        bare: step === 'b' ? entry?.output_source : undefined,
      }).toEqual({
        ran: true,
        gate: step === 'q' ? ['confirm_required', 'ok'] : undefined,
        agentParams: false,
        mapped: step === 'm' ? { x: 'from-params' } : undefined,
        bare: step === 'b' ? 'dependency' : undefined,
      });
    },
  );

  it('cell 11: the agent step by name → admitted, as today', async () => {
    const c = await connect();
    const { run } = await c.runStore.create({ workflowId: W3.id, workflowVersion: 1, params: {} });
    const r = await c.call('execute_step', { run_id: run.id, command: 'first', params: {} });
    // (a) red when the arm refuses the agent's own step; (b) prints the status and what completed.
    // Admitted, its chain then runs the engine's owed steps and opens Q's gate (confirm_required).
    expect([r['status'], (await c.runStore.get(run.id)).completed_steps.includes('first')]).toEqual(
      ['confirm_required', true],
    );
  });

  it('cell 12: a guard by name → today’s reply: blocked, the guard’s sentence and the door’s tail, advance_run, nothing written', async () => {
    const c = await connect();
    const runId = await answeredRun(c, W3);
    const before = await c.runStore.get(runId);
    const r = await c.call('execute_step', { run_id: runId, command: 'g', params: {} });
    // (a) red when the guard's reply moves; (b) prints its fields.
    expect({
      status: r['status'],
      error_code: r['error_code'],
      hint: r['context_hint'],
      next: tools(r),
      action: r['agent_action'],
      also: (r['also'] as Array<{ verb: string }>).map((a) => a.verb),
      suggestion: (r['blocked_reason'] as { suggestion?: string }).suggestion,
      version: (await c.runStore.get(runId)).version === before.version,
    }).toEqual({
      status: 'blocked',
      error_code: undefined,
      hint: `Step 'g' cannot be called now: it is a guard step: the engine runs it when the run reaches it.${OWED_TAIL}`,
      next: ['advance_run'],
      action: 'resolve_precondition',
      also: ['inspect', 'abandon'],
      suggestion: 'Call advance_run, as next_actions says.',
      version: true,
    });
  });

  it('cell 13: a step refused before its claim (its input_schema) → today’s refusal, never the engine’s', async () => {
    const c = await connect();
    const { run } = await c.runStore.create({ workflowId: W2.id, workflowVersion: 1, params: {} });
    const r = await c.call('execute_step', { run_id: run.id, command: 'publish', params: {} });
    // (a) red when the pre-claim refusal is replaced by the engine-decided one (conjunct (iii));
    //     (b) prints the status, code, action and the hint's opening.
    expect({
      status: r['status'],
      error_code: r['error_code'],
      action: r['agent_action'],
      engines: String(r['context_hint']).includes('it is an automatic step'),
    }).toEqual({
      status: 'error',
      error_code: 'VALIDATION_INPUT_SCHEMA',
      // the caller's own input, refused by its schema: provide_input, as before the unit (tools.md:306)
      action: 'provide_input',
      engines: false,
    });
  });

  it('cell 14: K (this server lacks its handler) by name → blocked, nothing to call, report_to_user, the capability words; no claim, no capability block written', async () => {
    const c = await connect();
    const runId = await answeredRun(c, WK);
    const before = await c.runStore.get(runId);
    const r = await c.call('execute_step', { run_id: runId, command: 'k', params: AGENT_PARAMS });
    const after = await c.runStore.get(runId);
    const state = await c.call('get_run_state', { run_id: runId });
    // (a) red when the call claims the step and writes the capability block (as before the unit),
    //     names next_actions, or routes otherwise; (b) prints the reply's fields and the record's.
    expect({
      status: r['status'],
      next: tools(r),
      action: r['agent_action'],
      hint: r['context_hint'],
      written: [
        after.version === before.version,
        Object.keys(after.claims ?? {}),
        Object.keys(after.capability_blocks ?? {}),
      ],
      health: state['run_health'] ?? [],
    }).toEqual({
      status: 'blocked',
      next: [],
      action: 'report_to_user',
      hint: `${engines('k')} 'k' cannot run here (capability): handler 'missing' is not registered here — load the missing extension, or run the step on a runner that has it.`,
      written: [true, [], []],
      health: [],
    });
  });
});

describe('#729 Q3, Part C — the dispatch-time capability block names no door word in core', () => {
  it('cell 15: the chain reaches a step this server lacks the code for → error; the hint without "follow next_actions", ending with the capability sentence advance_run prints', async () => {
    const c = await connect();
    const { run } = await c.runStore.create({ workflowId: WA.id, workflowVersion: 1, params: {} });
    const r = await c.call('execute_step', { run_id: run.id, command: 'first', params: {} });
    const advanced = await c.call('advance_run', { run_id: run.id });
    const CAPABILITY =
      "'nope' cannot run here (capability): handler 'nope' is not registered here — load the missing extension, or run the step on a runner that has it.";
    // (a) red when core's hint keeps the door word or the MCP reply drops the door's sentence, or the
    //     two replies word the block differently; (b) prints both hints.
    expect({
      status: [r['status'], r['stopped_step']],
      hint: r['context_hint'],
      advance: advanced['context_hint'],
    }).toEqual({
      status: ['error', 'nope'],
      hint: `Step 'nope' is blocked: its handler 'nope' is not registered in this runner. The run is NOT terminated — the step remains eligible, so a runner that provides this handler can execute it. ${CAPABILITY}`,
      advance: `Run '${run.id}': nothing ran. ${CAPABILITY}`,
    });
  });
});
