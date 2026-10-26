// #729 PR-3 (02 M-1…M-5; 04 "MCP"): the MCP door's disclosure. Every value is fake. Each assertion
// names (a) the change that turns it red and (b) what it prints on failure — booleans, counts,
// receipt fields and key lists, never a canary.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  compileDisclosure,
  type DisclosureEntry,
  type FactProducers,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRealmMcpServer, elicitDisclosedWith } from './server.js';
import type { ElicitFn } from './form-path.js';
import {
  MCP_ENVELOPE_TABLE,
  PERSON_BLOCK,
  SAFE_TOOL_CONSTANT,
  SAFE_TOOL_CONSTANT_RUNLESS,
  doorDisclosureOf,
  safeTool,
  toolContentOf,
  type McpEnvelope,
  DOOR_FACTS,
} from './render-reply.js';
import type { START_RUN_TABLE, StartRunReply } from './tools/start-run.js';
import { handleExecuteStepTool } from './tools/execute-step.js';

const CANARY_NAME = 'FAKE_DOOR_CANARY_729';
const CANARY = 'FAKE-DOOR-CANARY-VALUE-0729';

const FLOW: WorkflowDefinition = {
  id: 'door-flow',
  name: 'door flow',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'agent', depends_on: ['a'] },
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function connect(
  extra: Parameters<typeof createRealmMcpServer>[0] = {},
  more: WorkflowDefinition[] = [],
) {
  const dir = await mkdtemp(join(tmpdir(), 'realm-door-729-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(FLOW);
  for (const definition of more) await workflowStore.register(definition);
  const server = createRealmMcpServer({ runStore, workflowStore, ...extra });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  // Every byte the server sends, captured at its transport.
  const sent: string[] = [];
  const send = st.send.bind(st);
  st.send = async (message, options) => {
    sent.push(JSON.stringify(message));
    return send(message, options);
  };
  const client = new Client({ name: 'door-729', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
  };
  return { call, sent, runStore };
}

describe('#729 PR-3 — the MCP door', () => {
  it('M-1: every reply is walked last — no transport message holds an environment canary', async () => {
    vi.stubEnv(CANARY_NAME, CANARY);
    const { call, sent } = await connect();
    const started = await call('start_run', { workflow_id: FLOW.id, params: { note: CANARY } });
    const runId = started['run_id'] as string;
    await call('execute_step', { run_id: runId, command: 'a', params: { out: `x ${CANARY} y` } });
    const state = await call('get_run_state', { run_id: runId, include_steps: true });
    // Non-vacuity: the canary was in the run and the receipt counted it.
    // (a) red when a reply skips the walk (toolContentOf serializing the raw reply) or the receipt is
    //     dropped; (b) prints a boolean per message and the receipt's environment count.
    expect(
      (state['disclosure'] as { hidden: { environment: number } }).hidden.environment,
    ).toBeGreaterThan(0);
    expect(sent.map((m) => m.includes(CANARY))).toEqual(sent.map(() => false));
  });

  it('M-3: no provider → the environment set, declared part unknown (embedder_none)', async () => {
    const { call } = await connect();
    const listed = await call('list_workflows', {});
    // (a) red when the default stops naming its cause; (b) prints the receipt's two fields.
    const receipt = listed['disclosure'] as { declared: string; declared_cause?: string };
    expect([receipt.declared, receipt.declared_cause]).toEqual(['unknown', 'embedder_none']);
  });

  it('M-3: a provider that throws gives the environment set with cause load_failed, and is still masked', async () => {
    vi.stubEnv(CANARY_NAME, CANARY);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { call } = await connect({
      disclosureProvider: async () => {
        throw new Error(`provider failed holding ${CANARY}`);
      },
    });
    const started = await call('start_run', { workflow_id: FLOW.id, params: { note: CANARY } });
    const receipt = started['disclosure'] as { declared: string; declared_cause?: string };
    // (a) red when the provider's catch is removed (the call would fail) or the cause is lost; (b)
    //     prints the receipt fields and booleans.
    expect([receipt.declared, receipt.declared_cause]).toEqual(['unknown', 'load_failed']);
    expect(JSON.stringify(started).includes(CANARY)).toBe(false);
    // The provider's error reached stderr masked.
    const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect([logged.includes('disclosure provider failed'), logged.includes(CANARY)]).toEqual([
      true,
      false,
    ]);
  });

  it('M-3: a provider set with a declared value hides it in the reply', async () => {
    const { call } = await connect({
      disclosureProvider: async () =>
        compileDisclosure([{ value: 'FAKE-DECLARED-DOOR-01', source: 'declared:API' }], {
          declared: 'resolved',
          audience: 'agent',
          environment: 'swept',
        }).set,
    });
    const started = await call('start_run', {
      workflow_id: FLOW.id,
      params: { k: 'FAKE-DECLARED-DOOR-01' },
    });
    // (a) red when the provider's set is not used; (b) prints the receipt and a boolean.
    expect(started['disclosure']).toMatchObject({ declared: 'resolved' });
    expect(JSON.stringify(started).includes('FAKE-DECLARED-DOOR-01')).toBe(false);
  });

  it('M-4: the dispatcher returns the input the engine passes — `_debug` leaves output_summary', async () => {
    const { call, runStore } = await connect();
    const started = await call('start_run', { workflow_id: FLOW.id, params: {} });
    const runId = started['run_id'] as string;
    await call('execute_step', {
      run_id: runId,
      command: 'a',
      params: { answer: 'yes', _debug: { n: 1 } },
    });
    const evidence = (await runStore.get(runId)).evidence.find((e) => e.step_id === 'a')!;
    // (a) red when the dispatcher returns its closed-over params (`_debug` would be in the output);
    //     (b) prints the key list and the debug output.
    expect(Object.keys(evidence.output_summary)).toEqual(['answer']);
    expect(evidence.debug_output).toEqual({ n: 1 });
  });

  it("batch dedup: a matched run's stored params come back to its key's caller at the agent tier", async () => {
    vi.stubEnv(CANARY_NAME, CANARY);
    const { call } = await connect();
    const item = { params: { note: CANARY }, idempotency_key: 'k-1' };
    await call('start_run_batch', { workflow_id: FLOW.id, items: [item] });
    const again = await call('start_run_batch', { workflow_id: FLOW.id, items: [item] });
    const entry = (
      again['started'] as Array<{ deduped: boolean; params: Record<string, unknown> }>
    )[0]!;
    // (a) red when the batch table shows params as a fact; (b) prints booleans and the shown params.
    expect(entry.deduped).toBe(true);
    expect(entry.params).toEqual({ note: '[REDACTED]' });
  });
});

describe('#729 PR-3 — toolContentOf, safeTool, elicitDisclosed', () => {
  const set = compileDisclosure([{ value: CANARY, source: 'env:X' }], {
    declared: 'resolved',
    audience: 'agent',
    environment: 'swept',
  }).set;

  it('the person block is read first and emitted as its own block, as it is: facts, no marks', () => {
    const person = 'An operator answers with: realm run respond r1 --choice approve';
    const result = toolContentOf(
      { status: 'ok', data: { v: CANARY }, [PERSON_BLOCK]: person },
      { set, audience: 'agent', table: { status: 'fact', data: 'value' } },
    );
    // (a) red when the block is read after the walk (the walk drops it) or walked; (b) prints the
    //     block count, the block and booleans.
    expect(result.content.length).toBe(2);
    expect(result.content[1]!.text).toBe(person);
    expect(/[\uE000-\uE002]/.test(result.content[1]!.text)).toBe(false);
    expect(result.content[0]!.text.includes(CANARY)).toBe(false);
  });

  it("M-2: when a tool's error path throws too, the reply is a constant and the error is logged masked", async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv(CANARY_NAME, CANARY);
    const tool = safeTool(
      async () => {
        throw new Error('body failed');
      },
      async () => {
        throw new Error(`error path failed holding ${CANARY}`);
      },
    );
    const result = await tool();
    // (a) red when safeTool rethrows (the SDK would print the raw message) or logs unmasked; (b)
    //     prints the reply text (a constant) and booleans.
    expect([result.content[0]!.text, result.isError]).toEqual([SAFE_TOOL_CONSTANT, true]);
    const logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect([logged.length > 0, logged.includes(CANARY)]).toEqual([true, false]);
  });

  it('M-5: elicitDisclosed — the message at the declared tier, the choices never masked', async () => {
    const sentParams: Array<Parameters<ElicitFn>[0]> = [];
    const fake: ElicitFn = async (params) => {
      sentParams.push(params);
      return { action: 'decline' };
    };
    const door = doorDisclosureOf({
      disclosureProvider: async () =>
        compileDisclosure(
          [
            { value: 'FAKE-ENV-CHOICE-01', source: 'env:CHOICE' },
            { value: 'FAKE-DECLARED-Q-01', source: 'declared:Q' },
          ],
          { declared: 'resolved', audience: 'agent', environment: 'swept' },
        ).set,
    });
    const elicitDisclosed = elicitDisclosedWith(fake, door);
    await elicitDisclosed(
      {
        mode: 'form',
        message: 'Ship FAKE-DECLARED-Q-01 with FAKE-ENV-CHOICE-01?',
        requestedSchema: {
          type: 'object',
          properties: {
            choice: { type: 'string', title: 'Choice', enum: ['FAKE-ENV-CHOICE-01', 'reject'] },
          },
          required: ['choice'],
        },
      },
      { signal: new AbortController().signal, timeout: 1000 },
      {},
    );
    // (a) red when the schema is walked as a value (the choice would be masked) or the message gets
    //     every tier; (b) prints the sent message and choices (fake values).
    expect(sentParams[0]!.message).toBe('Ship [REDACTED] with FAKE-ENV-CHOICE-01?');
    expect(sentParams[0]!.requestedSchema.properties['choice']!.enum).toEqual([
      'FAKE-ENV-CHOICE-01',
      'reject',
    ]);
  });
});

describe('#729 PR-3 — an inbound answer carrying a marker (D1 D5)', () => {
  it('execute_step records the answer as sent and says so in the reply', async () => {
    const { call, runStore } = await connect();
    const started = await call('start_run', { workflow_id: FLOW.id, params: {} });
    const runId = started['run_id'] as string;
    const reply = await call('execute_step', {
      run_id: runId,
      command: 'a',
      params: { answer: 'sent back [REDACTED] here' },
    });
    const stored = (await runStore.get(runId)).evidence.find((e) => e.step_id === 'a')!;
    // (a) red when the warning is dropped, or the answer is changed before it is recorded; (b)
    //     prints booleans.
    expect({
      warned: (reply['warnings'] as string[]).some((w) => w.includes("holds '[REDACTED]'")),
      recordedAsSent: stored.output_summary['answer'] === 'sent back [REDACTED] here',
    }).toEqual({ warned: true, recordedAsSent: true });
  });
});

// ── #729 PR-3 correction 1: the door ───────────────────────────────────────────────────────────
const GATED: WorkflowDefinition = {
  id: 'gated',
  name: 'gated',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    g: {
      description: 'G.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], message: 'Approve it?' },
    },
  },
} as WorkflowDefinition;
const PRE: WorkflowDefinition = {
  id: 'pre',
  name: 'pre',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: {
      description: 'B.',
      execution: 'auto',
      depends_on: ['a'],
      preconditions: ["a.auth == 'Bearer FAKEtok9abc'"],
    },
  },
} as WorkflowDefinition;

/** An embedder's provider that reports a load failure for one project (`pre`) and resolved for the
 *  rest: what the door asks it about is what each reply reports (F11, D-11). */
const perProject = {
  disclosureProvider: async (definition: WorkflowDefinition | undefined) =>
    compileDisclosure([], {
      declared: definition?.id === 'pre' ? 'unknown' : 'resolved',
      ...(definition?.id === 'pre' ? { cause: 'load_failed' as const } : {}),
      audience: 'agent',
      environment: 'swept',
    }).set,
};
const standing = (reply: Record<string, unknown>) => {
  const d = reply['disclosure'] as { declared: string; declared_cause?: string };
  return [d.declared, d.declared_cause ?? null];
};

describe('#729 PR-3 correction 1 — the door', () => {
  it('F11: each reply reports the standing of the project it is about; a list reports the weakest', async () => {
    const { call } = await connect(perProject, [GATED, PRE]);
    const good = await call('start_run', { workflow_id: 'gated', params: {} });
    const bad = await call('start_run', { workflow_id: 'pre', params: {} });
    const badRun = bad['run_id'] as string;
    const stepped = await call('execute_step', {
      run_id: badRun,
      command: 'a',
      params: { auth: 'x' },
    });
    const state = await call('get_run_state', { run_id: badRun });
    const goodAgain = await call('get_run_state', { run_id: good['run_id'] as string });
    const listed = await call('list_workflows', {});
    // (a) red when a call site asks the provider about no workflow (`setFor(undefined)`: every reply
    //     would read resolved), or the list reports one project's standing instead of the weakest;
    //     (b) prints each reply's state and cause.
    expect({
      good: standing(good),
      bad: standing(bad),
      stepped: standing(stepped),
      state: standing(state),
      goodAgain: standing(goodAgain),
      listed: standing(listed),
    }).toEqual({
      good: ['resolved', null],
      bad: ['unknown', 'load_failed'],
      stepped: ['unknown', 'load_failed'],
      state: ['unknown', 'load_failed'],
      goodAgain: ['resolved', null],
      listed: ['unknown', 'load_failed'],
    });
  });

  it('F16: a reply that shows a question says its question was masked at the declared tier only', async () => {
    const { call } = await connect({}, [GATED]);
    const opened = await call('start_run', { workflow_id: 'gated', params: {} });
    const plain = await call('start_run', { workflow_id: FLOW.id, params: {} });
    // (a) red when the walk stops setting the flag for a shown question, or sets it with none
    //     shown; (b) prints the two flags.
    expect([
      (opened['disclosure'] as { question?: string }).question,
      (plain['disclosure'] as { question?: string }).question,
    ]).toEqual(['declared_only', undefined]);
  });

  it("F18: get_run_state's precondition shows its expression as written and hides its value", async () => {
    vi.stubEnv(CANARY_NAME, CANARY);
    const { call } = await connect({}, [PRE]);
    const run = (await call('start_run', { workflow_id: 'pre', params: {} }))['run_id'] as string;
    await call('execute_step', { run_id: run, command: 'a', params: { auth: CANARY } });
    const state = await call('get_run_state', { run_id: run });
    const entry = (state['engine_runnable'] as Array<{ precondition?: unknown }>)[0];
    // The law keeps `==` whatever the class (D-2), so the class shows on the author's literal: a
    // `fact` keeps it as written, a `bounded` copy would hide the token after `Bearer `.
    // (a) red when the row goes back to `bounded` (the expression masked) or the value is shown
    //     as a fact; (b) prints the shown precondition (fake values and a marker).
    expect(entry?.precondition).toEqual({
      expression: "a.auth == 'Bearer FAKEtok9abc'",
      value: '"[REDACTED]"',
    });
  });

  it("F7: a value only the escaped spelling of a run's param holds never reaches the wire", async () => {
    const BS = '\\';
    const VALUE = 'FAKEtb' + BS + 'n' + 'line2x9' + BS;
    const PRINTED = 'FAKEtb' + '\n' + 'line2x9' + BS;
    vi.stubEnv(CANARY_NAME, VALUE);
    const { call, sent } = await connect();
    const run = (
      await call('start_run', {
        workflow_id: FLOW.id,
        params: { out: PRINTED, also: `${PRINTED} ${VALUE}` },
      })
    )['run_id'] as string;
    const state = await call('get_run_state', { run_id: run });
    // Non-vacuity: the params reach the reply (each hidden whole).
    // (a) red when the walk's masked-string check is removed (the value is written escaped into
    //     the JSON text); (b) prints the shown params (markers) and a boolean per message.
    expect({
      params: state['params'],
      wire: sent.map((m) => m.includes('line2x9')),
    }).toEqual({
      params: { out: '[REDACTED]', also: '[REDACTED]' },
      wire: sent.map(() => false),
    });
  });

  it("SC-F4: a not-priced entry's detail (a price source's load error) is hidden in get_run_state", async () => {
    vi.stubEnv(CANARY_NAME, CANARY);
    const { call, runStore } = await connect({
      priceSourceProvider: async () => {
        throw new Error(`economics file unreadable: ${CANARY}`);
      },
    });
    const runId = (await call('start_run', { workflow_id: FLOW.id, params: {} }))[
      'run_id'
    ] as string;
    // One attempt with a request's usage, so the run's cost has something to price.
    const run = await runStore.get(runId);
    await runStore.update({
      ...run,
      completed_steps: ['a'],
      evidence: [
        {
          step_id: 'a',
          started_at: '2026-01-01T00:00:00.000Z',
          completed_at: '2026-01-01T00:00:01.000Z',
          duration_ms: 1000,
          input_summary: {},
          output_summary: {},
          status: 'success',
          evidence_hash: 'h',
          diagnostics: {
            input_token_estimate: 10,
            precondition_trace: [],
            cache: {
              state: 'engaged',
              basis: 'provider_reported',
              requests: [
                {
                  request_index: 0,
                  request_start: '2026-01-01T00:00:00.000Z',
                  prompt_tokens: 100,
                  cache_read_input_tokens: 0,
                  cache_creation_input_tokens: 0,
                  output_tokens: 5,
                  model: 'claude-x-20260101',
                  provider: 'anthropic',
                },
              ],
            },
          },
        },
      ],
    } as never);
    const state = await call('get_run_state', { run_id: runId, include_steps: true });
    const text = JSON.stringify(state);
    // Non-vacuity: the detail reached the reply (masked).
    // (a) red when the run's cost is a fact again (the load error's text shows); (b) prints two
    //     booleans.
    expect({
      detailShown: text.includes('economics file unreadable: [REDACTED]'),
      leaked: text.includes(CANARY),
    }).toEqual({ detailShown: true, leaked: false });
  });

  it('F5-b: a door registry missing a string `fact` row of the envelope does not compile', () => {
    // (a) red (a compile error in typecheck:tests) when the `@ts-expect-error` stops being needed:
    //     the envelope table loses its literal classes (no `satisfies`), or the type loosens;
    //     (b) the compiler prints the line; at run time, prints a type name.
    type EnvelopeFacts = FactProducers<typeof MCP_ENVELOPE_TABLE, McpEnvelope>;
    // @ts-expect-error — `command`, a string `fact` row of the envelope, names no producer
    const missing = { run_id: 'id' } satisfies EnvelopeFacts;
    expect(typeof missing).toBe('object');
  });
});

describe('#729 PR-3 correction 1 (F34) — when a tool cannot compose its reply', () => {
  /** An error whose text cannot be read: reading it throws. */
  const poison = {
    get message(): string {
      throw new Error('poison message');
    },
    toString(): string {
      throw new Error('poison text');
    },
  };
  /** A real store whose every method throws the poison (the class keeps its release line). */
  const poisoned = <T extends object>(real: T): T =>
    new Proxy(real, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === 'function' && prop !== 'constructor'
          ? () => {
              throw poison;
            }
          : value;
      },
    });
  const replyOf = async (name: string, args: Record<string, unknown>) => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const dir = await mkdtemp(join(tmpdir(), 'realm-door-f34-'));
    const server = createRealmMcpServer({
      runStore: poisoned(new JsonFileStore(join(dir, 'r'))),
      workflowStore: poisoned(new JsonWorkflowStore(join(dir, 'w'))),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'door-f34', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return raw.content[0]!.text;
  };
  const CREATE = { name: 'made', steps: [{ id: 'a', description: 'A.' }] };
  // One cell per tool with no run, and get_run_state: the constant never sends the caller to
  // `get_run_state` (and get_run_state never to itself), and an error whose text cannot be read
  // never escapes to the client.
  for (const [tool, args] of [
    ['list_workflows', {}],
    ['get_workflow_protocol', { workflow_id: 'w' }],
    ['create_workflow', CREATE],
    ['start_run', { workflow_id: 'w', params: {} }],
    ['start_run_batch', { workflow_id: 'w', items: [{ params: {} }] }],
    ['get_run_state', { run_id: 'r' }],
  ] as const) {
    it(`${tool}: the runless constant`, async () => {
      // (a) red when the tool passes the run's constant (`call get_run_state`), or the error path's
      //     failure escapes to the SDK (the client reads its message); (b) prints the reply text
      //     (a constant).
      expect(await replyOf(tool, args)).toBe(SAFE_TOOL_CONSTANT_RUNLESS);
    });
  }

  it('execute_step: the run constant, which points at get_run_state', async () => {
    // (a) red when the tool passes another constant; (b) prints the reply text (a constant).
    expect(await replyOf('execute_step', { run_id: 'r', command: 'a', params: {} })).toBe(
      SAFE_TOOL_CONSTANT,
    );
  });

  it('execute_step checks its stores inside safeTool: a store from no realm line is a reply, never a throw', async () => {
    const undeclared = { get: async () => undefined } as never;
    // (a) red when the store check runs before safeTool (the call rejects and the SDK prints the
    //     raw message); (b) prints whether it resolved and the reply's status and code.
    const outcome = await handleExecuteStepTool(
      { run_id: 'r', command: 'a', params: {} },
      { runStore: undeclared },
    ).then(
      (r) => {
        const reply = JSON.parse(r.content[0]!.text) as { status?: string; error_code?: string };
        return { resolved: true, status: reply.status, code: reply.error_code };
      },
      () => ({ resolved: false }),
    );
    expect(outcome).toMatchObject({ resolved: true, status: 'error' });
  });
});

// ── #729 PR-3 correction 2: the door (G1–G6) ─────────────────────────────────────────────────────

/** A provider that records the run each call names, with a set holding `declared` (if any). */
function providerSpy(declared: DisclosureEntry[] = []) {
  const asked: Array<string | undefined> = [];
  const disclosureProvider = async (
    _definition: WorkflowDefinition | undefined,
    run?: RunRecord,
  ) => {
    asked.push(run?.id);
    return compileDisclosure(declared, {
      declared: 'resolved',
      audience: 'agent',
      environment: 'swept',
    }).set;
  };
  return { asked, disclosureProvider };
}

/** A server built with NO run store (the default, under a fresh HOME), the provider spy, and a client
 *  that shows forms when `forms` (its handler declines). */
async function connectNoRunStore(
  extra: Parameters<typeof createRealmMcpServer>[0],
  forms: { capture?: (params: { message?: string }) => void } | undefined,
) {
  const home = await mkdtemp(join(tmpdir(), 'realm-door-c2-home-'));
  vi.stubEnv('HOME', home);
  const workflowStore = new JsonWorkflowStore(join(home, 'wf'));
  for (const definition of [FLOW, GATED, PRE]) await workflowStore.register(definition);
  const server = createRealmMcpServer({ workflowStore, ...extra });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'door-729-c2', version: '0' },
    forms !== undefined ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (forms !== undefined) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      forms.capture?.(req.params as { message?: string });
      return { action: 'decline' };
    });
  }
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
  };
  return { call, home };
}

describe('#729 PR-3 correction 2 — the door', () => {
  it('G1-a: with no run store handed in, every tool that reads a run asks the provider with that run', async () => {
    const spy = providerSpy();
    const { call } = await connectNoRunStore(
      { disclosureProvider: spy.disclosureProvider, gateAnswers: 'offered' },
      undefined,
    );
    /** Whether the provider was asked with `runId` during `name`'s call. */
    const asks = async (name: string, args: Record<string, unknown>, runId?: string) => {
      spy.asked.length = 0;
      const reply = await call(name, args);
      return spy.asked.includes(runId ?? (reply['run_id'] as string));
    };
    spy.asked.length = 0;
    const started = await call('start_run', { workflow_id: FLOW.id, params: {} });
    const run = started['run_id'] as string;
    const startRun = spy.asked.includes(run);
    const executeStep = await asks('execute_step', { run_id: run, command: 'a', params: {} }, run);
    const advanceRun = await asks('advance_run', { run_id: run }, run);
    const getRunState = await asks('get_run_state', { run_id: run }, run);
    const abandonRun = await asks('abandon_run', { run_id: run }, run);
    spy.asked.length = 0;
    const gated = await call('start_run', { workflow_id: GATED.id, params: {} });
    const answer = (
      gated['next_actions'] as Array<{ instruction: { call_with: Record<string, unknown> } }>
    )[0]!.instruction.call_with;
    const submitHumanResponse = await asks(
      'submit_human_response',
      { ...answer, choice: 'approve' },
      gated['run_id'] as string,
    );
    spy.asked.length = 0;
    const created = await call('create_workflow', {
      steps: [{ id: 'x', description: 'X.' }],
    });
    const createWorkflow = spy.asked.includes(created['run_id'] as string);
    // (a) red when the run store is dropped from the options every tool receives (the masking's
    //     subject reads no run: the provider is asked about none); (b) prints a boolean per tool.
    expect({
      startRun,
      executeStep,
      advanceRun,
      getRunState,
      abandonRun,
      submitHumanResponse,
      createWorkflow,
    }).toEqual({
      startRun: true,
      executeStep: true,
      advanceRun: true,
      getRunState: true,
      abandonRun: true,
      submitHumanResponse: true,
      createWorkflow: true,
    });
  });

  it('G1-a, G2: under `asked`, present_question asks the provider with its run, and so does the form it sends', async () => {
    const spy = providerSpy();
    let atForm: Array<string | undefined> | undefined;
    const { call } = await connectNoRunStore(
      { disclosureProvider: spy.disclosureProvider, gateAnswers: 'asked' },
      { capture: () => (atForm = [...spy.asked]) },
    );
    const gated = await call('start_run', { workflow_id: GATED.id, params: {} });
    const run = gated['run_id'] as string;
    const state = await call('get_run_state', { run_id: run });
    const gateId = (state['pending_gate'] as { gate_id: string }).gate_id;
    spy.asked.length = 0;
    atForm = undefined;
    await call('present_question', { run_id: run, gate_id: gateId });
    const formAsks = (atForm as Array<string | undefined> | undefined) ?? [];
    // The reply's own asks are the ones after the form came back.
    const replyAsks = spy.asked.slice(formAsks.length);
    // (a) red when the run store is dropped from the options (the reply asks about no run), or the
    //     form path's context carries the definition only (the form's set is asked about no run);
    //     (b) prints two booleans.
    expect({
      reply: replyAsks.includes(run),
      form: formAsks.includes(run),
    }).toEqual({ reply: true, form: true });
  });

  it('G6: a form sent through the server masks a declared value in the request the client receives', async () => {
    const DECLARED = 'FAKEformDeclared0729';
    const ASKING = {
      id: 'asking',
      name: 'asking',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        g: {
          description: 'G.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'], message: `Ship with ${DECLARED}?` },
        },
      },
    } as WorkflowDefinition;
    const spy = providerSpy([{ value: DECLARED, source: 'declared:F' }]);
    const messages: string[] = [];
    const home = await mkdtemp(join(tmpdir(), 'realm-door-c2-form-'));
    const workflowStore = new JsonWorkflowStore(join(home, 'wf'));
    await workflowStore.register(ASKING);
    const server = createRealmMcpServer({
      workflowStore,
      runStore: new JsonFileStore(join(home, 'runs')),
      disclosureProvider: spy.disclosureProvider,
      gateAnswers: 'asked',
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'door-729-c2-form', version: '0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      messages.push(String((req.params as { message?: string }).message));
      return { action: 'decline' };
    });
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.callTool({ name: 'start_run', arguments: { workflow_id: 'asking', params: {} } });
    // Non-vacuity: a form was sent.
    // (a) red when the form path sends through the raw elicit (the wrapper bypassed: the value
    //     reaches the client); (b) prints the count and a boolean.
    expect({
      forms: messages.length,
      shown: messages.some((m) => m.includes(DECLARED)),
    }).toEqual({ forms: 1, shown: false });
  });

  it("G3: one reply's two copies of a failed precondition show the same expression and mask the same value", async () => {
    vi.stubEnv(CANARY_NAME, CANARY);
    const { call } = await connect({}, [PRE]);
    const run = (await call('start_run', { workflow_id: 'pre', params: {} }))['run_id'] as string;
    await call('execute_step', { run_id: run, command: 'a', params: { auth: CANARY } });
    const state = await call('get_run_state', { run_id: run });
    const runnable = (state['engine_runnable'] as Array<{ precondition?: unknown }>)[0]
      ?.precondition;
    const health = (
      state['run_health'] as Array<{ evidence?: { refused?: Array<{ precondition?: unknown }> } }>
    )
      .flatMap((f) => f.evidence?.refused ?? [])
      .map((r) => r.precondition)[0];
    // (a) red when run_health's evidence is a value again (its copy of the expression is masked:
    //     `'Bearer [REDACTED]'`); (b) prints both copies (fake values and markers).
    expect({ runnable, health }).toEqual({
      runnable: { expression: "a.auth == 'Bearer FAKEtok9abc'", value: '"[REDACTED]"' },
      health: { expression: "a.auth == 'Bearer FAKEtok9abc'", value: '"[REDACTED]"' },
    });
  });

  it("G4: a start_run registry with the envelope's producers but no `rerun_of` does not compile", () => {
    // (a) red (a compile error in typecheck:tests) when start_run's `rerun_of` is no string `fact`
    //     row needing a producer (the `@ts-expect-error` is no longer needed); (b) at run time,
    //     prints a key count.
    type StartRunFacts = FactProducers<typeof START_RUN_TABLE, StartRunReply>;
    // @ts-expect-error — `rerun_of`, a string `fact` row of start_run's reply, names no producer
    const missing = { ...DOOR_FACTS.envelope } satisfies StartRunFacts;
    expect(Object.keys(DOOR_FACTS.start_run).length).toBe(Object.keys(missing).length + 1);
  });

  it("G4: an outcome's `by.name` (a name the answerer typed) is hidden when it holds a value", async () => {
    vi.stubEnv(CANARY_NAME, CANARY);
    const { call } = await connect({ gateAnswers: 'offered' }, [GATED]);
    const gated = await call('start_run', { workflow_id: GATED.id, params: {} });
    const answer = (
      gated['next_actions'] as Array<{ instruction: { call_with: Record<string, unknown> } }>
    )[0]!.instruction.call_with;
    await call('submit_human_response', {
      ...answer,
      choice: 'approve',
      responded_by: `ops ${CANARY}`,
    });
    const again = await call('submit_human_response', { ...answer, choice: 'reject' });
    const by = (again['outcome'] as { by?: { kind?: string; name?: string } } | undefined)?.by;
    // Non-vacuity: the outcome names who answered.
    // (a) red when `outcome` is a flat fact again (the name shows as typed); (b) prints the kind
    //     and the shown name (a marker).
    expect({ kind: by?.kind, name: by?.name }).toEqual({ kind: 'answer', name: 'ops [REDACTED]' });
  });

  it("G5: a fresh process's first list hides a value one of its workflows' reads just added", async () => {
    const DECLARED = 'FAKEdeclG5x9';
    // A union provider, as the CLI's is: a workflow's read adds its declared value; the set for no
    // workflow is the union so far.
    const union: DisclosureEntry[] = [];
    const set = () =>
      compileDisclosure(union, { declared: 'resolved', audience: 'agent', environment: 'swept' })
        .set;
    const disclosureProvider = async (definition: WorkflowDefinition | undefined) => {
      if (definition !== undefined && union.length === 0)
        union.push({ value: DECLARED, source: 'declared:G5' });
      return set();
    };
    const dir = await mkdtemp(join(tmpdir(), 'realm-door-c2-g5-'));
    const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register(FLOW);
    // A registered copy that is not JSON: its reason (a diagnostic copy) names its id.
    await writeFile(join(dir, 'wf', `${DECLARED}.json`), 'not json');
    const server = createRealmMcpServer({
      workflowStore,
      runStore: new JsonFileStore(join(dir, 'runs')),
      disclosureProvider,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'door-729-c2-g5', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const raw = (await client.callTool({ name: 'list_workflows', arguments: {} })) as {
      content: Array<{ text: string }>;
    };
    const listed = JSON.parse(raw.content[0]!.text) as {
      unreadable?: Array<{ reason?: string }>;
    };
    const reason = listed.unreadable?.[0]?.reason ?? '';
    // Non-vacuity: the unreadable copy is listed.
    // (a) red when the list's base set is taken before the workflows' reads (the value the read
    //     added is not in it: the reason shows it); (b) prints the shown reason (a marker).
    expect(reason).toBe("the registered copy of '[REDACTED]' is not JSON");
  });
});

describe('#729 PR-3 correction 3 (H-8) — the door', () => {
  it("abandon_run's default sentence is realm's own words: a declared member equal to its word leaves it whole over get_run_state", async () => {
    const { call } = await connect({
      disclosureProvider: async () =>
        compileDisclosure([{ value: 'abandon_run', source: 'declared:WORD' }], {
          declared: 'resolved',
          audience: 'agent',
          environment: 'swept',
        }).set,
    });
    const started = await call('start_run', { workflow_id: FLOW.id, params: {} });
    const runId = started['run_id'] as string;
    await call('abandon_run', { run_id: runId });
    const state = await call('get_run_state', { run_id: runId });
    // (a) red when the MCP default is not a fixed sentence (`Abandoned via [REDACTED]`); (b) prints
    //     the reason.
    expect(state['terminal_reason']).toBe('Abandoned via abandon_run');
  });
});

describe("#729 PR-3 correction 3 (H-11') — none declared is never withheld", () => {
  it('a server built with no provider (`embedder_none`): values at the agent tier, the question at the declared tier', async () => {
    vi.stubEnv(CANARY_NAME, CANARY);
    const ASKED: WorkflowDefinition = {
      ...GATED,
      id: 'asked',
      steps: {
        g: {
          ...GATED.steps['g']!,
          gate: { choices: ['approve', 'reject'], message: 'Approve {{ run.params.k }}?' },
        },
      },
    } as WorkflowDefinition;
    const { call } = await connect({}, [ASKED]);
    const started = await call('start_run', {
      workflow_id: 'asked',
      params: { k: CANARY, plain: 'FAKEplain0729' },
    });
    const state = await call('get_run_state', { run_id: started['run_id'] as string });
    const gate = state['pending_gate'] as { resolved_message?: string };
    const receipt = state['disclosure'] as Record<string, unknown>;
    // (a) red when values are withheld for any state but `resolved` (the plain value is shaped, the
    //     question replaced); (b) prints the params (a marker and a fake word), whether the question
    //     shows the environment's fake value (the declared tier, P-9) and the receipt's fields.
    expect({
      params: state['params'],
      questionAtDeclaredTier: gate.resolved_message === `Approve ${CANARY}?`,
      receipt: [receipt['declared_cause'], receipt['question'], receipt['values'] ?? null],
    }).toEqual({
      params: { k: '[REDACTED]', plain: 'FAKEplain0729' },
      questionAtDeclaredTier: true,
      receipt: ['embedder_none', 'declared_only', null],
    });
  });
});
