// CP-2: get_run_state declares its reply's shape on the MCP wire (`outputSchema`) and every result
// carries the object its JSON text serializes (`structuredContent`), checked before it leaves (the
// floor). Each cell names (a) the break that turns it red and (b) what it prints when it fails.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  WorkflowError,
  compileDisclosure,
  writeTestClockFile,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from '../server.js';
import { sseJsonStringify } from '../sse-json.js';
import { toolContentOf, toolContentWithTwinOf } from '../render-reply.js';
import { makeTempHome, seedRun, type TempHome } from '../test-support/temp-home.js';
import { handleGetRunState, RUN_STATE_PLAN, RUN_STATE_SUMMARY_TABLE } from './get-run-state.js';
import { registerPresentQuestion } from './present-question.js';
import { runStateSchemaFile } from './run-state-schema.js';
import {
  runStateWireMissLine,
  runStateWireSchema,
  setRunStateWireSeamForTests,
} from './run-state-wire.js';

type Json = Record<string, unknown>;
interface Result {
  content: Array<{ type: string; text: string; annotations?: { audience?: string[] } }>;
  structuredContent?: Json;
  isError?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const BUDGET = 120_000;

// ─── Planted runs ───────────────────────────────────────────────────────────────────────────────

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:00:01.000Z';
const LATER = '2099-01-01T00:00:00.000Z';
const agentStep = (depends_on: string[], extra: Json = {}) => ({
  description: 'A step.',
  execution: 'agent',
  depends_on,
  ...extra,
});
const flow = (id: string, steps: Json): WorkflowDefinition =>
  ({ id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps }) as never;
const FLOW = flow('cp2-flow', { a: agentStep([], { prompt: 'Do A.' }), b: agentStep(['a']) });
const WAIT = flow('cp2-wait', { ask: agentStep([], { trust: 'human_confirmed' }) });
const MANY_STEPS = Array.from({ length: 400 }, (_, i) => `step_${String(i).padStart(3, '0')}`);
const MANY = flow('cp2-many', Object.fromEntries(MANY_STEPS.map((s) => [s, agentStep([])])));
const exec = (step_id: string, status: string, extra: Json = {}) => ({
  step_id,
  kind: 'execution',
  status,
  started_at: T0,
  completed_at: T1,
  duration_ms: 1,
  input_summary: {},
  output_summary: {},
  evidence_hash: `h-${step_id}`,
  ...extra,
});
const record = (id: string, workflow_id: string, extra: Json): RunRecord =>
  ({
    id,
    workflow_id,
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 2,
    params: {},
    evidence: [],
    created_at: T0,
    updated_at: T1,
    terminal_state: false,
    ...extra,
  }) as never;
const REQUEST = {
  request_index: 0,
  request_start: T0,
  model: 'claude-x-20260101',
  provider: 'anthropic',
  endpoint: 'custom',
  prompt_tokens: 5000,
  output_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const priced = (step_id: string) =>
  exec(step_id, 'success', {
    diagnostics: {
      input_token_estimate: 1,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests: [REQUEST] },
    },
  });
/** One run in each `run_phase` (core's RUN_PHASES), read with its steps. */
const PHASES: Array<[string, RunRecord]> = [
  [
    'running',
    record('cp2-running', FLOW.id, {
      completed_steps: ['a'],
      evidence: [priced('a')],
      drive_failures: {
        first_failed_at: T1,
        total: 1,
        entries: [
          {
            at: T1,
            step: 'b',
            provider: 'anthropic',
            error_class: 'api_status',
            message: 'rate limited',
            elapsed_ms: 1,
            usage: [REQUEST],
          },
        ],
      },
    }),
  ],
  [
    'gate_waiting',
    record('cp2-waiting', WAIT.id, {
      run_phase: 'gate_waiting',
      evidence: [exec('ask', 'success')],
      pending_gate: {
        gate_id: 'gate-w',
        step_name: 'ask',
        preview: {},
        choices: ['yes', 'no'],
        opened_at: T1,
        expires_at: LATER,
        on_expiry: 'settle_default',
        default_choice: 'no',
      },
    }),
  ],
  [
    'completed',
    record('cp2-completed', FLOW.id, {
      run_phase: 'completed',
      terminal_state: true,
      completed_steps: ['a', 'b'],
      evidence: [priced('a'), exec('b', 'success')],
      sealed_by: { arm: 'complete' },
    }),
  ],
  [
    'failed',
    record('cp2-failed', FLOW.id, {
      run_phase: 'failed',
      terminal_state: true,
      completed_steps: ['a'],
      failed_steps: ['b'],
      evidence: [
        exec('a', 'success'),
        exec('b', 'failed', { error: 'boom', error_code: 'ENGINE_HANDLER_FAILED' }),
      ],
      sealed_by: { arm: 'step_failure', step: 'b' },
      terminal_reason: 'step b failed',
    }),
  ],
  [
    'abandoned',
    record('cp2-abandoned', FLOW.id, {
      run_phase: 'abandoned',
      terminal_state: true,
      completed_steps: ['a'],
      evidence: [exec('a', 'success')],
      sealed_by: { arm: 'abandon_requested', door: 'abandon_run' },
      terminal_reason: 'abandoned on request',
    }),
  ],
  [
    'aborted',
    record('cp2-aborted', FLOW.id, {
      run_phase: 'aborted',
      terminal_state: true,
      completed_steps: ['a'],
      evidence: [exec('a', 'success')],
      aborted_at: { step_id: 'a', abort_message: 'stop' },
      sealed_by: { arm: 'handler_abort', step: 'a' },
      terminal_reason: 'handler aborted',
    }),
  ],
];
/** Over the ceiling, cut by the plan: a parameter the plan leaves out. */
const BIG_PARAMS = record('cp2-big-params', FLOW.id, { params: { long: 'p'.repeat(60_000) } });
/** Over the ceiling with the steps at their floor (one step, many attempts): the overflow line. */
const BIG_REASON = record('cp2-big-attempts', FLOW.id, {
  completed_steps: ['a'],
  evidence: Array.from({ length: 2_000 }, (_, i) =>
    exec('a', 'success', { evidence_hash: `h-a-${i}` }),
  ),
});
/** A step held elsewhere past its deadline: with an operator route, the reply carries the person block. */
const HELD = record('cp2-held', FLOW.id, {
  in_progress_steps: ['a'],
  claims: { a: { token: 'other-a', deadline: T1, since: T0 } },
});
/** Waiting at a gate that says what each answer means: withheld, the door shows its per-choice
 *  messages as one sentence (the schema admits it since Q1 d2c). */
const GATE_MESSAGES = record('cp2-waiting-messages', WAIT.id, {
  run_phase: 'gate_waiting',
  evidence: [exec('ask', 'success')],
  pending_gate: {
    gate_id: 'gate-m',
    step_name: 'ask',
    preview: { draft: 'Dear customer, …' },
    choices: ['send', 'reject'],
    opened_at: T1,
    resolution_messages: { send: 'The reply is on its way.', reject: 'The draft was rejected.' },
  },
});
/** A route that renders a person's ways as commands, as `realm mcp` injects one. */
const ROUTE = {
  render: (way: { verb: string; step?: string; run_id?: string }) =>
    way.verb === 'reclaim'
      ? `RECLAIM ${way.step}`
      : way.verb === 'inspect'
        ? `INSPECT ${way.run_id}`
        : null,
  source: { kind: 'default' as const, ref: 'cp2' },
};
/** Many steps: the reply pages them. */
const PAGED = record('cp2-paged', MANY.id, {
  completed_steps: MANY_STEPS,
  evidence: MANY_STEPS.map((s) => exec(s, 'success')),
});

// ─── The door ───────────────────────────────────────────────────────────────────────────────────

let root: string;
let home: TempHome;
const clients: Client[] = [];
/** A connected client that has listed the tools first (the SDK client validates only after that). */
async function connect(server: McpServer, list = true): Promise<Client> {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cp2', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  if (list) await client.listTools();
  clients.push(client);
  return client;
}
let client: Client;
let listed: Json;
const call = async (args: Json, on = client): Promise<Result> =>
  (await on.callTool({ name: 'get_run_state', arguments: args })) as Result;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'realm-cp2-'));
  await writeTestClockFile(root, new Date('2026-01-01T00:10:00.000Z'));
  home = await makeTempHome({ home: root });
  for (const d of [FLOW, WAIT, MANY]) await home.stores.workflowStore.register(d);
  for (const [, run] of PHASES) await seedRun(home.stores.runStore, run);
  for (const run of [BIG_PARAMS, BIG_REASON, PAGED, HELD, GATE_MESSAGES])
    await seedRun(home.stores.runStore, run);
  client = await connect(createRealmMcpServer({ ...home.stores }));
  const tools = (await client.listTools()).tools;
  listed = tools.find((t) => t.name === 'get_run_state')!.outputSchema as Json;
}, BUDGET);
afterEach(() => {
  setRunStateWireSeamForTests(undefined);
  vi.restoreAllMocks();
});
afterAll(async () => {
  for (const c of clients) await c.close();
  await home?.cleanup();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** The checks a validating host runs: the SDK client's validator and Ajv 2020 in strict mode. */
function verdicts(value: unknown): { sdk: string | true; strict: string | true } {
  const sdk = new AjvJsonSchemaValidator().getValidator(listed)(value);
  const strict = new Ajv2020({ strict: true }).compile(listed);
  return {
    sdk: sdk.valid ? true : (sdk.errorMessage ?? 'invalid'),
    strict: strict(value) ? true : JSON.stringify(strict.errors?.[0]),
  };
}
/** The two carriers of one result: the twin is the very object the text serializes. */
function carriers(r: Result) {
  return {
    isError: r.isError,
    texts: r.content.length,
    twinIsText:
      r.structuredContent !== undefined &&
      sseJsonStringify(r.structuredContent) === r.content[0]!.text,
  };
}

const PAGE_PARAGRAPH =
  "Over MCP the same schema travels with the tool: `tools/list` carries it as `get_run_state`'s `outputSchema` (draft 2020-12; one object whose `anyOf` holds the two replies), and every reply that is not an error result carries the same object twice, as `structuredContent` and as the JSON text it always sent. A refusal is the second of the two shapes and stays an ordinary result. Should Realm's own reply ever not fit this schema, it arrives as an error result whose text starts with one sentence saying so and then holds the complete reply as JSON, so nothing is lost. Added after version 0.50.0.";
const COMPATIBILITY_CLAUSE =
  'the MCP tools, the fields of their replies and the shape `tools/list` declares for a reply (`outputSchema`)';
const CHANGELOG_LINE =
  "- **`get_run_state` declares its reply's shape on the MCP wire.** `tools/list` carries the published schema's two shapes (`docs/reference/mcp/run-state.schema.json`, draft 2020-12) under one object root as the tool's `outputSchema`, and every ordinary reply carries the same object as `structuredContent` beside the JSON text it always sent, so a host that validates replies can. A refusal (a run not found) stays an ordinary result and fits the schema's second shape. If a reply ever does not fit the schema, it arrives as an error result whose text starts with one plain sentence and holds the complete reply as JSON.";
const PUBLISHED_SCHEMA_LINE = "- **`get_run_state`'s reply has a published schema.**";

describe('CP-2 — get_run_state on the MCP wire', () => {
  it('1. tools/list carries the published file as the outputSchema, under one object root at draft 2020-12', () => {
    // (a) red when the root is stamped draft-07 or lists one arm only; (b) prints the root's keys.
    const file = runStateSchemaFile();
    expect({
      type: listed['type'],
      $schema: listed['$schema'],
      title: listed['title'],
      description: listed['description'],
      arms: (listed['anyOf'] as unknown[]).length,
    }).toEqual({
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: file['title'],
      description: file['description'],
      arms: 2,
    });
    expect(listed['anyOf']).toStrictEqual(file['anyOf']);
  });

  it('2. of all twelve tools, only get_run_state lists an outputSchema', async () => {
    // (a) red when the schema is registered envelope-wide; (b) prints each tool's name and whether
    //     it lists one.
    // `permitted` lists submit_human_response; present_question is registered beside it here (no one
    // configuration lists both).
    const server = createRealmMcpServer({ ...home.stores, gateAnswers: 'permitted' });
    registerPresentQuestion(server, home.stores);
    const all = await connect(server);
    const tools = (await all.listTools()).tools;
    expect(
      Object.fromEntries(tools.map((t) => [t.name, t.outputSchema !== undefined])),
    ).toStrictEqual({
      abandon_run: false,
      advance_run: false,
      append_trace: false,
      create_workflow: false,
      execute_step: false,
      get_run_state: true,
      get_workflow_protocol: false,
      list_workflows: false,
      present_question: false,
      start_run: false,
      start_run_batch: false,
      submit_human_response: false,
    });
  });

  it('3. the published file is untouched: its tree stays unstamped by the wire', () => {
    // (a) red when the wire stamps the shared tree; (b) prints the file's difference.
    runStateWireSchema();
    const committed = JSON.parse(
      readFileSync(join(ROOT, 'docs/reference/mcp/run-state.schema.json'), 'utf8'),
    ) as Json;
    expect(runStateSchemaFile()).toStrictEqual(committed);
    expect(runStateWireSchema()).toBe(runStateWireSchema());
  });

  it('4. a run in each run_phase: the twin is the object the text serializes, and it validates', async () => {
    // (a) red when one phase's result leaves without its twin, or with a twin the text does not
    //     serialize; (b) prints each phase's carriers and verdicts.
    const seen: Json = {};
    for (const [phase, run] of PHASES) {
      const r = await call({ run_id: run.id, include_steps: true });
      seen[phase] = {
        phase: r.structuredContent?.['run_phase'],
        ...carriers(r),
        ...verdicts(r.structuredContent),
      };
    }
    expect(seen).toStrictEqual(
      Object.fromEntries(
        PHASES.map(([phase]) => [
          phase,
          { phase, isError: undefined, texts: 1, twinIsText: true, sdk: true, strict: true },
        ]),
      ),
    );
  });

  it('4b. the opt-in changes no content: the same reply composes to the same blocks either way', async () => {
    // (a) red when the twin's composer sends different text than every other tool's; (b) prints both.
    const stores = { runStore: home.stores.runStore, workflowStore: home.stores.workflowStore };
    const { set } = compileDisclosure([], {
      declared: 'partial',
      cause: 'load_failed',
      audience: 'agent',
      environment: 'swept',
    });
    const disclosure = { set, audience: 'agent' as const, table: RUN_STATE_SUMMARY_TABLE };
    for (const run of [...PHASES.map(([, r]) => r), BIG_PARAMS, BIG_REASON, PAGED]) {
      const raw = await handleGetRunState({ run_id: run.id, include_steps: true }, stores);
      const plain = toolContentOf({ ...raw }, disclosure, RUN_STATE_PLAN);
      const twinned = toolContentWithTwinOf({ ...raw }, disclosure, RUN_STATE_PLAN, {
        carried: (twin) => twin,
        refused: () => undefined,
      });
      expect(twinned.content, run.id).toStrictEqual(plain.content);
      expect(sseJsonStringify(twinned.structuredContent!), run.id).toBe(plain.content[0]!.text);
    }
  });

  it("5. values withheld: the twin carries the shapes the text shows, never a number it withholds, and a gate's messages as the door's sentence", async () => {
    // (a) red when the twin is taken before the door's walk, or when the schema refuses a gate's
    //     withheld messages (the floor then fires); (b) prints the shaped leaves.
    const failing = createRealmMcpServer({
      ...home.stores,
      disclosureProvider: async () => {
        throw new Error('fixture: the declared values do not load');
      },
    });
    const on = await connect(failing);
    const r = await call({ run_id: 'cp2-running', include_steps: true }, on);
    const twin = r.structuredContent!;
    const shapes = (v: unknown, at: string, out: string[]): string[] => {
      if (typeof v === 'string' && v.startsWith('‹')) out.push(`${at}=${v}`);
      else if (v !== null && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) shapes(x, `${at}/${k}`, out);
      return out;
    };
    const attempt = ((twin['steps'] as Json)['a'] as { attempts: Json[] }).attempts[0]!;
    expect({
      values: (twin['disclosure'] as Json)['values'],
      attempt: attempt['attempt'],
      ...carriers(r),
      ...verdicts(twin),
    }).toStrictEqual({
      values: 'withheld',
      attempt: '‹number›',
      isError: undefined,
      texts: 1,
      twinIsText: true,
      sdk: true,
      strict: true,
    });
    expect(shapes(twin, '', [])).toStrictEqual(shapes(JSON.parse(r.content[0]!.text), '', []));
    // A run waiting at a gate with per-choice messages: the door shows them as one sentence, the
    // twin carries that sentence, and the reply fits, so the floor does not fire.
    const gate = await call({ run_id: 'cp2-waiting-messages' }, on);
    const gateTwin = gate.structuredContent;
    expect({
      messages: (gateTwin?.['pending_gate'] as Json | undefined)?.['resolution_messages'],
      ...carriers(gate),
      ...verdicts(gateTwin),
    }).toStrictEqual({
      messages: 'withheld (declared values could not be read)',
      isError: undefined,
      texts: 1,
      twinIsText: true,
      sdk: true,
      strict: true,
    });
  });

  it('6. a reply over the ceiling: the twin is the cut object the text sends, never the uncut one', async () => {
    // (a) red when the twin is taken before the cut; (b) prints the sizes, the cut and the line.
    const cut = await call({ run_id: BIG_PARAMS.id });
    const lined = await call({ run_id: BIG_REASON.id, include_steps: true });
    expect({
      cut: {
        size: cut.content[0]!.text.length <= 40_000,
        params: cut.structuredContent?.['params'],
        ...carriers(cut),
        ...verdicts(cut.structuredContent),
      },
      lined: {
        size: lined.content[0]!.text.length > 40_000,
        first: ((lined.structuredContent?.['warnings'] as string[]) ?? [])[0]?.slice(0, 16),
        ...carriers(lined),
        ...verdicts(lined.structuredContent),
      },
    }).toStrictEqual({
      cut: {
        size: true,
        params: { omitted: true, chars: expect.any(Number) },
        isError: undefined,
        texts: 1,
        twinIsText: true,
        sdk: true,
        strict: true,
      },
      lined: {
        size: true,
        first: 'This reply was 4',
        isError: undefined,
        texts: 1,
        twinIsText: true,
        sdk: true,
        strict: true,
      },
    });
  });

  it('7. a paged reply, read again by its cursor: each page validates, and its twin is its text', async () => {
    // (a) red when a page leaves without its twin; (b) prints each page's carriers.
    const first = await call({ run_id: PAGED.id, include_steps: true });
    const cursor = first.structuredContent?.['next_cursor'] as string;
    const second = await call({ run_id: PAGED.id, include_steps: true, cursor });
    expect({
      first: { cursor: typeof cursor, ...carriers(first), ...verdicts(first.structuredContent) },
      second: {
        cursor: typeof second.structuredContent?.['next_cursor'],
        ...carriers(second),
        ...verdicts(second.structuredContent),
      },
    }).toStrictEqual({
      first: {
        cursor: 'string',
        isError: undefined,
        texts: 1,
        twinIsText: true,
        sdk: true,
        strict: true,
      },
      second: {
        cursor: 'string',
        isError: undefined,
        texts: 1,
        twinIsText: true,
        sdk: true,
        strict: true,
      },
    });
  });

  it('8. refusals stay ordinary results and carry their envelope as the second shape', async () => {
    // (a) red when a refusal goes out as an error result, or without its twin; (b) prints each.
    // A store whose read throws `err`; with `untyped`, a read that succeeds and a record that throws
    // a plain Error once the reply is composed from it (a store wraps its own throws in a code).
    const throwing = (err: unknown, untyped = false) =>
      createRealmMcpServer({
        ...home.stores,
        runStore: new Proxy(home.stores.runStore, {
          get(target, key) {
            if (key === 'get')
              return async (id: string) => {
                if (!untyped) throw err;
                const snap = await target.get(id);
                const broken = Object.defineProperty({ ...snap.record }, 'evidence', {
                  enumerable: true,
                  get() {
                    throw err;
                  },
                });
                return { ...snap, record: broken };
              };
            const value = Reflect.get(target, key) as unknown;
            return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
          },
        }),
      });
    const typed = await connect(
      throwing(
        new WorkflowError('fixture: the store is busy', {
          code: 'STATE_RUN_BUSY',
          category: 'STATE',
          agentAction: 'wait_and_proceed',
          retryable: true,
        }),
      ),
    );
    const untyped = await connect(throwing(new Error('fixture: an untyped throw'), true));
    const refusals = {
      'not found': await call({ run_id: 'no-such-run' }),
      'a refused cursor': await call({
        run_id: 'cp2-running',
        include_steps: true,
        cursor: 'nope',
      }),
      'another WorkflowError': await call({ run_id: 'cp2-running' }, typed),
      'an untyped throw': await call({ run_id: 'cp2-running' }, untyped),
    };
    const seen = Object.fromEntries(
      Object.entries(refusals).map(([label, r]) => [
        label,
        {
          status: r.structuredContent?.['status'],
          code: r.structuredContent?.['error_code'] ?? null,
          ...carriers(r),
          ...verdicts(r.structuredContent),
        },
      ]),
    );
    const refusal = (code: string | null) => ({
      status: 'error',
      code,
      isError: undefined,
      texts: 1,
      twinIsText: true,
      sdk: true,
      strict: true,
    });
    expect(seen).toStrictEqual({
      'not found': refusal('STATE_RUN_NOT_FOUND'),
      'a refused cursor': refusal('VALIDATION_CURSOR'),
      'another WorkflowError': refusal('STATE_RUN_BUSY'),
      'an untyped throw': refusal(null),
    });
  });

  it('9. end to end through the SDK client: replies pass its check, and a twin that does not fit is refused by it', async () => {
    // (a) red when an arm of the listed schema is malformed, or the client stops checking; (b)
    //     prints what the client returned or threw.
    const found = await call({ run_id: 'cp2-completed' });
    const refusal = await call({ run_id: 'no-such-run' });
    setRunStateWireSeamForTests({
      twin: (twin) => ({ ...twin, evidence_count: 'not a number' }),
      verdict: () => undefined,
    });
    const junk = await call({ run_id: 'cp2-completed' }).then(
      () => 'accepted',
      (err: unknown) => String(err),
    );
    expect({
      found: found.structuredContent?.['run_phase'],
      refusal: refusal.structuredContent?.['status'],
      junk: junk.includes('-32602') && junk.includes('evidence_count'),
    }).toStrictEqual({ found: 'completed', refusal: 'error', junk: true });
  });

  it('10. the floor: a reply of its own that does not fit leaves as an error result with one plain sentence, then the complete reply', async () => {
    // (a) red when the floor is removed (the SDK client refuses the junk with -32602); (b) prints the
    //     result's first line, its keys and the log line.
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    setRunStateWireSeamForTests({
      twin: (twin) => ({ ...twin, evidence_count: 'x-planted-value' }),
    });
    const r = await call({ run_id: 'cp2-completed' });
    const text = r.content[0]!.text;
    const line = runStateWireMissLine({
      path: '/evidence_count',
      keyword: 'type',
      message: 'must be number',
    });
    const parses = (() => {
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    })();
    const log = logged.filter((l) => l.includes('did not fit'));
    expect({
      isError: r.isError,
      twin: 'structuredContent' in r,
      first: text.slice(0, text.indexOf('\n')),
      rest: (JSON.parse(text.slice(text.indexOf('\n') + 1)) as Json)['run_phase'],
      parses,
      log: log.length,
      logNames: log.every((l) => l.includes('/evidence_count') && l.includes('type')),
      logValue: log.some((l) => l.includes('x-planted-value')),
    }).toStrictEqual({
      isError: true,
      twin: false,
      first: line,
      rest: 'completed',
      parses: false,
      log: 1,
      logNames: true,
      logValue: false,
    });
    expect(line).toBe(
      "Realm's reply did not fit its published schema at /evidence_count (type: must be number); the complete reply follows as JSON.",
    );
  });

  it('12. the person block stays its own block, second, for the user, and outside the twin', async () => {
    // (a) red when the person block moves into the twin or the SDK adds a block; (b) prints the
    //     blocks.
    const routed = await connect(createRealmMcpServer({ ...home.stores, operatorRoute: ROUTE }));
    const r = await call({ run_id: HELD.id }, routed);
    const person = r.content[1];
    expect({
      blocks: r.content.map((c) => c.annotations?.audience ?? 'agent'),
      reclaim: person?.text.includes('RECLAIM a'),
      inTwin: JSON.stringify(r.structuredContent).includes('RECLAIM'),
      twinIsText: sseJsonStringify(r.structuredContent) === r.content[0]!.text,
      ...verdicts(r.structuredContent),
    }).toStrictEqual({
      blocks: ['agent', ['user']],
      reclaim: true,
      inTwin: false,
      twinIsText: true,
      sdk: true,
      strict: true,
    });
  });

  it('13. the other eleven tools: no result of theirs carries structuredContent', async () => {
    // (a) red when the twin becomes every tool's default; (b) prints each tool's result keys.
    const server = createRealmMcpServer({ ...home.stores, gateAnswers: 'permitted' });
    registerPresentQuestion(server, home.stores);
    const all = await connect(server);
    const calls: Array<[string, Json]> = [
      ['list_workflows', {}],
      ['get_workflow_protocol', { workflow_id: FLOW.id }],
      ['start_run', { workflow_id: FLOW.id }],
      ['start_run_batch', { workflow_id: FLOW.id, items: [{ params: {} }] }],
      ['execute_step', { run_id: 'no-such-run', command: 'a' }],
      ['advance_run', { run_id: 'no-such-run' }],
      ['submit_human_response', { run_id: 'no-such-run', gate_id: 'g', choice: 'yes' }],
      ['abandon_run', { run_id: 'no-such-run' }],
      ['create_workflow', { steps: [{ id: 'cp2_step', description: 'A step.' }] }],
      ['append_trace', { run_id: 'no-such-run', step_id: 'a', entries: [] }],
      ['present_question', { run_id: 'no-such-run', gate_id: 'g' }],
    ];
    const seen: Json = {};
    for (const [name, args] of calls) {
      const r = (await all.callTool({ name, arguments: args })) as Result;
      seen[name] = {
        twin: 'structuredContent' in r,
        ours: !r.content[0]!.text.includes('Input validation error'),
      };
    }
    expect(seen).toStrictEqual(
      Object.fromEntries(calls.map(([name]) => [name, { twin: false, ours: true }])),
    );
  });

  it('14. the words: the page paragraph, the compatibility clause, the CHANGELOG line and the floor sentence', () => {
    // (a) red when a word of any of them changes or the paragraph leaves its place; (b) prints the
    //     counts.
    const page = readFileSync(join(ROOT, 'docs/reference/mcp/run-state-and-health.md'), 'utf8');
    const from = page.indexOf('\n## The schema\n');
    const section = page.slice(from, page.indexOf('\n## See also\n', from));
    const paragraphs = section.split('\n\n').map((p) => p.trim());
    const compatibility = readFileSync(join(ROOT, 'docs/reference/compatibility.md'), 'utf8');
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const unreleased = changelog.slice(
      0,
      changelog.indexOf('\n## [', changelog.indexOf('## [Unreleased]') + 1),
    );
    const count = (text: string, words: string) => text.split(words).length - 1;
    expect({
      page: count(page, `\n${PAGE_PARAGRAPH}\n`),
      // right after the section's first paragraph, the published-schema one
      second:
        paragraphs.indexOf(PAGE_PARAGRAPH) ===
        paragraphs.findIndex((p) => p.startsWith("`get_run_state`'s reply is described by")) + 1,
      compatibility: count(compatibility, COMPATIBILITY_CLAUSE),
      changelog: count(unreleased, `\n${CHANGELOG_LINE}\n`),
      afterSchemaLine:
        unreleased.indexOf(CHANGELOG_LINE) > unreleased.indexOf(PUBLISHED_SCHEMA_LINE) &&
        unreleased.indexOf(PUBLISHED_SCHEMA_LINE) > 0,
      floor: runStateWireMissLine({ path: '/a', keyword: 'type', message: 'must be number' }),
    }).toStrictEqual({
      page: 1,
      second: true,
      compatibility: 1,
      changelog: 1,
      afterSchemaLine: true,
      floor:
        "Realm's reply did not fit its published schema at /a (type: must be number); the complete reply follows as JSON.",
    });
  });
});
