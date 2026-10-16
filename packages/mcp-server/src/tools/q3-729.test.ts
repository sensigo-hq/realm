// q3-729.test.ts — issue #729, the Q3 unit (the owner's "q3 - yes", 2026-10-16): over a real MCP
// client, the agent's `execute_step` naming an engine step the engine could run is refused BEFORE
// anything is claimed or written, and told `advance_run`; `advance_run` then runs it with the
// engine's input. The agent's own step, a guard, and a step refused before its claim keep today's
// replies. Part C: the dispatch-time capability block's hint names no door word in core, and the
// MCP reply ends with the door's capability sentence.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: codes,
// step names, field names and booleans — never a token or a value a caller supplied.
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

/**
 * #729 Q3 correction 1 — an engine step whose `input_schema` wants `text`, which neither the run's
 * params (`{ x }`) nor an empty input holds. `pub` with a handler and no `depends_on` (its engine
 * input is the run's params); `bare` with no handler; `dep` with a handler and `depends_on` (its
 * engine input is `{}`); `mapped` building `text` from a param the run lacks. The `-beside`
 * variants add a ready agent step `second`.
 */
const NEEDS_TEXT = {
  type: 'object',
  required: ['text'],
  properties: { text: { type: 'string' } },
};
const f1 = (id: string, step: Record<string, unknown>, beside: boolean): WorkflowDefinition =>
  def(id, {
    first: { description: 'First.', execution: 'agent', depends_on: [] },
    ...(beside
      ? { second: { description: 'Second.', execution: 'agent', depends_on: ['first'] } }
      : {}),
    pub: { description: 'Pub.', execution: 'auto', input_schema: NEEDS_TEXT, ...step },
  } as WorkflowDefinition['steps']);
const F1_HANDLER = f1('q3c-handler', { depends_on: [], handler: 'h' }, false);
const F1_HANDLER_BESIDE = f1('q3c-handler-beside', { depends_on: ['first'], handler: 'h' }, true);
const F1_BARE = f1('q3c-bare', { depends_on: [] }, false);
const F1_DEP = f1('q3c-dep', { depends_on: ['first'], handler: 'h' }, false);
const F1_MAPPED_BESIDE = f1(
  'q3c-mapped-beside',
  { depends_on: ['first'], handler: 'h', input_map: { text: 'run.params.missing' } },
  true,
);
/** An AGENT step whose own `input_schema` wants `text`, on a run whose params lack it. */
const F1_AGENT = def('q3c-agent', {
  first: { description: 'First.', execution: 'agent', depends_on: [], input_schema: NEEDS_TEXT },
} as WorkflowDefinition['steps']);
const F1_WORKFLOWS = [F1_HANDLER, F1_HANDLER_BESIDE, F1_BARE, F1_DEP, F1_MAPPED_BESIDE, F1_AGENT];
const FITS = { text: 'AGENT-FITS' };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

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
  for (const d of [W3, WK, W2, WA, ...F1_WORKFLOWS]) await workflowStore.register(d);
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
  return { call, runStore, runsDir: join(dir, 'runs') };
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

  // pre-Q3c1 title: 'cell 13: a step refused before its claim (its input_schema) → today’s refusal,
  // never the engine’s'
  it('cell 13: a step refused before its claim (its input_schema) → that refusal, on the engine’s input, never the engine-decided one; routed as a refusal, with its own way out', async () => {
    const c = await connect();
    const { run } = await c.runStore.create({ workflowId: W2.id, workflowVersion: 1, params: {} });
    const r = await c.call('execute_step', { run_id: run.id, command: 'publish', params: {} });
    // (a) red when the pre-claim refusal is replaced by the engine-decided one (conjunct (iii)), or
    //     routed `provide_input` (the caller's input judged — before Q3 correction 1); (b) prints
    //     the status, code, action and the hint.
    expect({
      status: r['status'],
      error_code: r['error_code'],
      action: r['agent_action'],
      hint: r['context_hint'],
    }).toEqual({
      status: 'error',
      error_code: 'VALIDATION_INPUT_SCHEMA',
      action: 'report_to_user',
      hint: "Error during 'publish'. Run phase: 'running'. For 'publish', start a run with params that fit, or correct its input_schema and register the workflow again; this run stays open — after a fix, call advance_run on it; or end it with abandon_run.",
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

describe('#729 Q3 correction 1 — at the agent’s door an engine step’s input is the engine’s', () => {
  /** The record's facts the call must leave as they were, and whether the agent's params got in. */
  async function call(d: WorkflowDefinition, step: string, params: Record<string, unknown>) {
    const c = await connect();
    const runId = await answeredRun(c, d);
    const before = await c.runStore.get(runId);
    const r = await c.call('execute_step', { run_id: runId, command: step, params });
    const after = await c.runStore.get(runId);
    return {
      r,
      record: {
        version: after.version === before.version,
        claims: Object.keys(after.claims ?? {}),
        evidence: after.evidence.length === before.evidence.length,
        completed: after.completed_steps.includes(step),
        params: JSON.stringify(after).includes('AGENT-FITS'),
      },
    };
  }
  const UNTOUCHED = { version: true, claims: [], evidence: true, completed: false, params: false };
  const rules = (r: Reply) =>
    (
      (
        r['error_details'] as {
          errors?: Array<{ keyword: string; params?: { missingProperty?: string } }>;
        }
      )?.errors ?? []
    ).map((e) => `${e.keyword}:${e.params?.missingProperty ?? ''}`);
  const wayOut = (step: string) =>
    `For '${step}', start a run with params that fit, or correct its input_schema and register the workflow again; this run stays open — after a fix, call advance_run on it; or end it with abandon_run.`;

  it('F1-a: a handler step (no map, no depends_on) named with params that FIT is refused on the engine’s input — the run’s params — nothing claimed, written or recorded of the agent’s', async () => {
    claim(
      'CHANGELOG.md',
      "A step refused before its claim (its `trust`, a precondition, its `input_schema`) still returns that refusal first, judged on the input the engine builds — never the assistant's `params` — and routed like every refusal before the claim;",
    );
    const { r, record } = await call(F1_HANDLER, 'pub', FITS);
    // (a) red when the caller's params are judged (the step runs on them — before the correction);
    //     (b) prints the reply's code, action, the rules broken, the hint and the record's facts.
    expect({
      status: r['status'],
      code: r['error_code'],
      action: r['agent_action'],
      rules: rules(r),
      hint: r['context_hint'],
      record,
    }).toEqual({
      status: 'error',
      code: 'VALIDATION_INPUT_SCHEMA',
      action: 'report_to_user',
      rules: ['required:text'],
      hint: `Error during 'pub'. Run phase: 'running'. ${wayOut('pub')}`,
      record: UNTOUCHED,
    });
  });

  it('F1-b: a bare step, and a handler step WITH depends_on (its engine input is empty), named with params that fit → the same refusal', async () => {
    const bare = await call(F1_BARE, 'pub', FITS);
    const dep = await call(F1_DEP, 'pub', FITS);
    // (a) red when either is judged on the caller's params; (b) prints code, action, rules, record.
    expect({
      bare: [bare.r['error_code'], bare.r['agent_action'], rules(bare.r), bare.record],
      dep: [dep.r['error_code'], dep.r['agent_action'], rules(dep.r), dep.record],
      depWay: String(dep.r['context_hint']).endsWith(
        "For 'pub', the engine gives it no input, so correct its input_schema and register the workflow again; then, after a fix, call advance_run; or end the run with abandon_run.",
      ),
    }).toEqual({
      bare: ['VALIDATION_INPUT_SCHEMA', 'report_to_user', ['required:text'], UNTOUCHED],
      dep: ['VALIDATION_INPUT_SCHEMA', 'report_to_user', ['required:text'], UNTOUCHED],
      depWay: true,
    });
  });

  it('F1-c: params that do NOT fit → the same refusal (the engine input’s rules), never provide_input', async () => {
    const { r, record } = await call(F1_HANDLER, 'pub', { nope: 1 });
    // (a) red when the caller's params are judged (`provide_input` — before the correction); (b)
    //     prints code, action, rules and the record's facts.
    expect([r['error_code'], r['agent_action'], rules(r), record]).toEqual([
      'VALIDATION_INPUT_SCHEMA',
      'report_to_user',
      ['required:text'],
      { ...UNTOUCHED, params: false },
    ]);
  });

  it('F1-d: a mapped step named with params that fit, beside a ready agent step → resolve_precondition, the agent step to call', async () => {
    const { r, record } = await call(F1_MAPPED_BESIDE, 'pub', FITS);
    // (a) red when the refusal is not routed as a refusal (`reply_kind` dropped); (b) prints the
    //     action, the calls offered and the record's facts.
    expect([r['agent_action'], tools(r), record]).toEqual([
      'resolve_precondition',
      ['execute_step'],
      UNTOUCHED,
    ]);
  });

  it('F1-e: the library’s executeStep (no party) with an input that fits admits the step and runs it on that input — T-17’s lever, unchanged', async () => {
    const c = await connect();
    const runId = await answeredRun(c, F1_HANDLER);
    const r = await executeStep(c.runStore, F1_HANDLER, {
      runId,
      command: 'pub',
      input: FITS,
      dispatcher: async (_s, input) => ({ got: input }),
      registry: registry(),
    });
    const after = await c.runStore.get(runId);
    // (a) red when the substitution applies to every caller (the party conjunct dropped) — the
    //     library's lever would be refused; (b) prints the status and whether the step completed on
    //     the given input.
    expect({
      status: r.status,
      completed: after.completed_steps.includes('pub'),
      onTheInput: JSON.stringify(after.evidence.find((e) => e.step_id === 'pub')?.input_summary),
    }).toEqual({ status: 'ok', completed: true, onTheInput: JSON.stringify(FITS) });
  });

  it('F1-f: an unmapped step refused beside a ready agent step → resolve_precondition, execute_step for that step; with nothing else callable → report_to_user and the step’s own way out', async () => {
    const beside = await call(F1_HANDLER_BESIDE, 'pub', FITS);
    const alone = await call(F1_HANDLER, 'pub', FITS);
    // (a) red when an unmapped step's refusal is not routed as a refusal (C1b reverted) — beside a
    //     ready step it says report_to_user — or loses its way out alone; (b) prints both replies.
    expect({
      beside: [beside.r['agent_action'], tools(beside.r), beside.r['context_hint']],
      alone: [
        alone.r['agent_action'],
        tools(alone.r),
        String(alone.r['context_hint']).endsWith(wayOut('pub')),
      ],
    }).toEqual({
      beside: [
        'resolve_precondition',
        ['execute_step'],
        "Error during 'pub'. Run phase: 'running'.",
      ],
      alone: ['report_to_user', [], true],
    });
  });

  it('F1-g: an AGENT step’s answer is its own input — one that fits its schema is admitted although the run’s params do not fit', async () => {
    const c = await connect();
    const { run } = await c.runStore.create({
      workflowId: F1_AGENT.id,
      workflowVersion: 1,
      params: { x: 'from-params' },
    });
    const r = await c.call('execute_step', { run_id: run.id, command: 'first', params: FITS });
    // (a) red when the `execution === 'auto'` conjunct is dropped (the agent's own answer judged on
    //     the run's params); (b) prints the status and whether the step completed.
    expect([r['status'], (await c.runStore.get(run.id)).completed_steps]).toEqual([
      'ok',
      ['first'],
    ]);
  });
});

describe('#729 Q3 correction 1, C2 — no agent-step telemetry for an engine step', () => {
  it('an auto step’s by-name refusal writes no stderr line and no sidecar line; an agent step’s refused answer writes both', async () => {
    claim(
      'docs/reference/cli/realm-run-reading.md',
      "Lists the answers to agent steps that Realm refused because they did not fit the step's schema.",
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const c = await connect();
      const runId = await answeredRun(c, F1_HANDLER);
      const nAuto = spy.mock.calls.length;
      await c.call('execute_step', { run_id: runId, command: 'pub', params: FITS });
      const autoLines = spy.mock.calls.slice(nAuto).map((a) => String(a[0]));
      const agentRun = (
        await c.runStore.create({ workflowId: F1_AGENT.id, workflowVersion: 1, params: {} })
      ).run.id;
      const nAgent = spy.mock.calls.length;
      const agentReply = await c.call('execute_step', {
        run_id: agentRun,
        command: 'first',
        params: { nope: 1 },
      });
      const agentLines = spy.mock.calls.slice(nAgent).map((a) => String(a[0]));
      const sidecar = (id: string) => {
        const path = join(c.runsDir, `${id}.attempts.jsonl`);
        return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').length : 0;
      };
      // (a) red when the `execution === 'agent'` gate is removed (the auto step's refusal writes the
      //     agent's submitted keys beside the engine input's errors); (b) prints booleans and counts.
      expect({
        auto: [autoLines.some((l) => l.includes('agent_step_attempt_failed')), sidecar(runId)],
        agent: [agentLines.some((l) => l.includes('agent_step_attempt_failed')), sidecar(agentRun)],
      }).toEqual({ auto: [false, 0], agent: [true, 1] });
      // tools.md:298 — only an agent step's answer reaches that row now (an `auto` step's is :299):
      // `provide_input`, the rules broken, and the countdown. (a) red when the agent step's refusal
      // loses the countdown or its routing; (b) prints the action and the `error_details` keys.
      claim(
        'docs/reference/mcp/tools.md',
        '| An agent step\'s answer does not fit its schema | `error` | `error_code: "VALIDATION_INPUT_SCHEMA"`, `agent_action: "provide_input"`, and in `error_details` the rules broken, and `rejections` and `threshold`. |',
      );
      expect([
        agentReply['agent_action'],
        Object.keys((agentReply['error_details'] as Record<string, unknown>) ?? {}),
      ]).toEqual(['provide_input', ['errors', 'rejections', 'threshold']]);
    } finally {
      spy.mockRestore();
    }
  });
});
