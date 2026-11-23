// fail-key-drive-g2iib2.test.ts — gap 2, unit (ii-b2): `on_model_failure: fail` under `realm agent`.
//
// An agent step whose model request fails used to stop the drive and leave the run open, the step
// given back. With `on_model_failure: fail` on the step, a request that failed for good fails the
// step instead (core's `modelFailure` member), so the workflow's failure route can run: here a
// `one_failed` step that reads `$settlement.s.failure_kind`. Without the key nothing changes. The
// cells drive `runAgent` with Realm's real Anthropic provider and SDK over a scripted `fetch` (fake
// keys only), or with a provider module of the test's own, and read what a person sees (stdout and
// stderr, the result) and what the run's record keeps.
//
// Every cell carries (a) the break that turns it red and (b) what it prints.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  type ExtensionRegistry,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent, type AgentDeps } from './run-agent.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import {
  LlmProvider,
  ToolCapableLlmProvider,
  type CallStepWithMetaResult,
  type ProviderCapabilities,
} from './providers/llm-provider.js';
import type { McpClient, McpTool, StepWithToolsResult } from './mcp/mcp-extensions.js';

type Wire = (init: RequestInit | undefined) => Response | Promise<Response>;
let script: Wire[] = [];
let wires = 0;
/** Run before each wire try's answer, with the try's number (from 1). */
let onWire: ((n: number) => Promise<void>) | undefined;
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  script = [];
  wires = 0;
  onWire = undefined;
  out = [];
  err = [];
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-fake-g2iib2-0000');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      wires += 1;
      await onWire?.(wires);
      const next = script.shift();
      if (next === undefined) throw new Error('the test scripted no further answer');
      return next(init);
    }),
  );
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) =>
    out.push(a.map(String).join(' ')),
  );
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) =>
    err.push(a.map(String).join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) =>
    err.push(a.map(String).join(' ')),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const JSONH = { 'content-type': 'application/json' };
const reply =
  (content: unknown[], stop = 'end_turn'): Wire =>
  () =>
    new Response(
      JSON.stringify({
        id: 'msg_fake_g2iib2',
        type: 'message',
        role: 'assistant',
        model: 'claude-test-1',
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: JSONH },
    );
const text = (t: string) => ({ type: 'text', text: t });
const fail =
  (status: number, type = 'api_error', message = 'overloaded (fake)'): Wire =>
  () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
      status,
      headers: JSONH,
    });
/** A wire try that answers only when it is aborted, as a request in flight when a timer fires. */
const hang = (): Wire => (init) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted (fake)'), { name: 'AbortError' })),
    );
  });

const FAST = { max_attempts: 2, backoff: 'fixed', base_delay_ms: 1 };
const KEY = { on_model_failure: 'fail' };

/** A workflow whose agent step `s` is the one under test, and, with `route`, a `one_failed` step
 *  that runs only when `s` failed with a transient kind. */
const workflow = (
  id: string,
  step: Record<string, unknown>,
  opts: { route?: boolean; extra?: Record<string, unknown> } = {},
) =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      s: { description: 'Answer with JSON.', execution: 'agent', ...step },
      ...(opts.route === true
        ? {
            after: {
              description: 'Note the failure.',
              execution: 'auto',
              depends_on: ['s'],
              trigger_rule: 'one_failed',
              when: "$settlement.s.failure_kind == 'transient'",
              handler: 'noted',
            },
          }
        : {}),
    },
    ...opts.extra,
  }) as unknown as WorkflowDefinition;

const TOOLS_EXTRA = {
  mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
};
const mcpClientOf = (offered: (allowList: string[]) => string[]): McpClient => ({
  async connect() {},
  async getTools(_serverId: string, allowList: string[]): Promise<McpTool[]> {
    return offered(allowList).map((name) => ({
      name,
      description: 'Look a thing up',
      inputSchema: { type: 'object' },
    }));
  },
  async call() {
    return { result: 'a fake tool result' };
  },
  async disconnect() {},
});

function registryWithNoted(): ExtensionRegistry {
  const registry = createDefaultRegistry();
  registry.register('handler', 'noted', {
    id: 'noted',
    execute: async () => ({ data: { noted: true } }),
  } as never);
  return registry;
}

let runIdOf = '';
let storeOf: InMemoryStore | undefined;

/** One `realm agent` drive of `def` on a run of its own (or `runId`'s), as `realm agent --run-id`. */
async function drive(
  def: WorkflowDefinition,
  provider: LlmProvider,
  extra: Partial<AgentDeps> & { store?: InMemoryStore; runId?: string } = {},
): Promise<{ result: unknown; run: RunRecord; store: InMemoryStore }> {
  const store = extra.store ?? new InMemoryStore({ leases: createLeaseDouble() });
  const runId =
    extra.runId ??
    (await store.create({ workflowId: def.id, workflowVersion: 1, params: {} })).record.id;
  runIdOf = runId;
  storeOf = store;
  const { store: _s, runId: _r, ...deps } = extra;
  const result = await runAgent(
    {
      store,
      workflowStore: { register: async () => {}, get: async () => def, list: async () => [def] },
      provider,
      registry: registryWithNoted(),
      mcpClientFactory: () => mcpClientOf((allowList) => allowList),
      ...deps,
    } as unknown as AgentDeps,
    { existingRunId: runId, definition: def, params: {} },
  ).catch((thrown: unknown) => thrown);
  return { result, run: (await store.get(runId)).record, store };
}
const lastFailure = (run: RunRecord) =>
  run.drive_failures?.entries[run.drive_failures.entries.length - 1];
const errorEntryOf = (run: RunRecord, step = 's') =>
  run.evidence.filter((e) => e.step_id === step && e.status === 'error').at(-1);
const anthropic = () => new AnthropicProvider('claude-test-1');
const bullet = (code: string) =>
  `• Step 's' failed (${code}): its model request failed, and the step has on_model_failure: fail.`;

// ─── Check 1: without the key, every failure is today's ─────────────────────────────────────────

describe('gap 2 (ii-b2), check 1 — without the key, a failed model request is given back as before', () => {
  const ROWS: Array<[string, Record<string, unknown>, Wire[], Record<string, unknown>]> = [
    ['a retry that used up its tries (two 503s)', { retry: FAST }, [fail(503), fail(503)], {}],
    ['a permanent 400 without retry', {}, [fail(400, 'invalid_request_error', 'bad (fake)')], {}],
    [
      'a tools step whose request failed (a 400)',
      { tools: ['srv:lookup'] },
      [fail(400, 'invalid_request_error', 'bad (fake)')],
      TOOLS_EXTRA,
    ],
  ];
  it.each(ROWS)(
    '%s: the drive stops, the step is given back, the run stays open',
    async (_n, step, wire, extra) => {
      script = [...wire];
      const def = workflow(`g2iib2-nokey-${Object.keys(step).join('-') || 'plain'}`, step, {
        extra,
      });
      const { result, run } = await drive(def, anthropic());
      const entry = lastFailure(run);
      // (a) red when the member is taken without the key (the step fails, no drive failure, the
      //     bullet line); (b) prints the result, the record and every line.
      expect({
        result,
        failed: run.failed_steps,
        open: run.terminal_state,
        entry: entry === undefined ? null : { step: entry.step, error_class: entry.error_class },
        giveBack: out.filter((l) => l.startsWith("• Step 's': this drive let its claim go")),
        bullet: err.filter((l) => l.includes('on_model_failure')),
        cross: err.filter((l) => l.includes('✗')).length,
      }).toEqual({
        result: 'failed',
        failed: [],
        open: false,
        entry: { step: 's', error_class: 'api_status' },
        giveBack: [
          "• Step 's': this drive let its claim go (its step failed), so the step can run again.",
        ],
        bullet: [],
        cross: 1,
      });
    },
  );
});

// ─── Check 2: with the key, the rule's `fail` rows on both catches ──────────────────────────────

describe('gap 2 (ii-b2), check 2 — with the key, a request that failed for good fails the step', () => {
  const ROWS: Array<{
    name: string;
    step: Record<string, unknown>;
    wire: Wire[];
    code: string;
    kind: 'transient' | 'permanent';
    extra?: Record<string, unknown>;
  }> = [
    {
      name: 'retry used up its tries (two 503s)',
      step: { retry: FAST },
      wire: [fail(503), fail(503)],
      code: 'STEP_RETRY_EXHAUSTED',
      kind: 'transient',
    },
    {
      name: 'the cap under retry (a 1 s total, the second send hangs)',
      step: {
        retry: { max_attempts: 2, total_timeout_seconds: 1, backoff: 'fixed', base_delay_ms: 300 },
      },
      wire: [fail(503), hang()],
      code: 'STEP_RETRY_EXHAUSTED',
      kind: 'transient',
    },
    {
      name: 'a permanent 400',
      step: {},
      wire: [fail(400, 'invalid_request_error', 'bad (fake)')],
      code: 'MODEL_REQUEST_FAILED',
      kind: 'permanent',
    },
    {
      name: 'a timeout under on_timeout: false',
      step: { llm_timeout_seconds: 1, retry: { ...FAST, on_timeout: false } },
      wire: [hang()],
      code: 'MODEL_REQUEST_FAILED',
      kind: 'transient',
    },
    {
      name: "a 503 without retry (the client's own three tries)",
      step: {},
      wire: [fail(503), fail(503), fail(503)],
      code: 'MODEL_REQUEST_FAILED',
      kind: 'transient',
    },
    {
      name: 'a tools step: a permanent 400',
      step: { tools: ['srv:lookup'] },
      wire: [fail(400, 'invalid_request_error', 'bad (fake)')],
      code: 'MODEL_REQUEST_FAILED',
      kind: 'permanent',
      extra: TOOLS_EXTRA,
    },
  ];
  it.each(ROWS)(
    '$name: $code, no drive failure, one ✗ line then the bullet; a later drive runs the route only when transient',
    async (row) => {
      script = [...row.wire];
      const def = workflow(
        `g2iib2-fail-${row.code}-${row.kind}`,
        { ...KEY, ...row.step },
        {
          route: true,
          ...(row.extra !== undefined ? { extra: row.extra } : {}),
        },
      );
      const first = await drive(def, anthropic());
      const entry = errorEntryOf(first.run);
      const errLines = [...err];
      // (a) red when the catch still records a drive failure (two homes), the error branch's ✗
      //     line is printed a second time, or the bullet line is missing; (b) prints the record,
      //     the entry's code and kind, and the stderr lines.
      expect({
        result: first.result,
        failed: first.run.failed_steps,
        driveFailures: first.run.drive_failures?.entries.length ?? 0,
        code: entry?.error_code,
        kind: entry?.diagnostics?.failure_kind,
        crosses: errLines.filter((l) => l.includes('✗')).length,
        bullet: errLines.filter((l) => l.startsWith('• Step ')),
        giveBack: out.filter((l) => l.includes('let its claim go')),
      }).toEqual({
        result: 'failed',
        failed: ['s'],
        driveFailures: 0,
        code: row.code,
        kind: row.kind,
        crosses: 1,
        bullet: [bullet(row.code)],
        giveBack: [],
      });
      // A later drive of the same run: the route runs only on a transient failure.
      out = [];
      err = [];
      const second = await drive(def, anthropic(), { store: first.store, runId: first.run.id });
      // (a) red when failure_kind is not what the route reads; (b) prints where `after` went.
      expect({
        completed: second.run.completed_steps.includes('after'),
        skipped: second.run.skipped_steps.includes('after'),
      }).toEqual({ completed: row.kind === 'transient', skipped: row.kind === 'permanent' });
    },
    15_000,
  );

  it('the retry row keeps its tries on the error entry (model_attempts)', async () => {
    script = [fail(503), fail(503)];
    const { run } = await drive(workflow('g2iib2-tries', { ...KEY, retry: FAST }), anthropic());
    // (a) red when the step meta's tries are dropped; (b) prints the tries' statuses.
    expect(
      errorEntryOf(run)?.model_attempts?.map((t) => [t.status, t.exhausted_by ?? null]),
    ).toEqual([
      [503, null],
      [503, 'attempts'],
    ]);
  });

  it('a run the settle ended (no failure route): no Ended: line repeats the failure', async () => {
    script = [fail(400, 'invalid_request_error', 'bad (fake)')];
    const { run } = await drive(workflow('g2iib2-ended', KEY), anthropic());
    // (a) red when the bullet line does not count as the step's ✗ line for the ending note (an
    //     `Ended:` line follows); (b) prints the run's phase and the stderr lines.
    expect({
      phase: run.run_phase,
      ended: err.filter((l) => l.includes('Ended:')),
      bullet: err.filter((l) => l.startsWith('• Step ')),
    }).toEqual({ phase: 'failed', ended: [], bullet: [bullet('MODEL_REQUEST_FAILED')] });
  });
});

// ─── Check 3: with the key, the rule's `give_back` rows ─────────────────────────────────────────

/** Realm's own provider (no module id) whose call throws a TypeError after its answer. */
class AfterAnswerTypeError extends LlmProvider {
  override capabilities(): ProviderCapabilities {
    return { jsonMode: false };
  }
  async callStep(): Promise<Record<string, unknown>> {
    throw new Error('not used');
  }
  override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
    throw new TypeError("Cannot read properties of undefined (reading 'x')");
  }
}

describe('gap 2 (ii-b2), check 3 — with the key, a failure that needs a fix first is given back as before', () => {
  const ROWS: Array<[string, () => LlmProvider, Record<string, unknown>, Partial<AgentDeps>]> = [
    ['a 401 (a refused key)', anthropic, {}, {}],
    [
      'a tool the server does not offer (the provider is never called)',
      anthropic,
      { tools: ['srv:lookup'] },
      { mcpClientFactory: () => mcpClientOf(() => []) } as Partial<AgentDeps>,
    ],
    ['a throw Realm cannot place', () => new AfterAnswerTypeError(), {}, {}],
  ];
  it.each(ROWS)(
    '%s: the drive stops and gives the step back, the run open',
    async (_n, provider, step, deps) => {
      script = [fail(401, 'authentication_error', 'invalid x-api-key (fake)')];
      const def = workflow(
        `g2iib2-giveback-${Object.keys(step).join('-') || 'plain'}`,
        { ...KEY, ...step },
        {
          ...(step['tools'] !== undefined ? { extra: TOOLS_EXTRA } : {}),
        },
      );
      const { result, run } = await drive(def, provider(), deps as Parameters<typeof drive>[2]);
      // (a) red when `give_back` is sent to the member (the step fails); (b) prints the record and
      //     the lines.
      expect({
        result,
        failed: run.failed_steps,
        open: run.terminal_state,
        entry: lastFailure(run)?.step ?? null,
        giveBack: out.filter((l) => l.includes('let its claim go')).length,
        bullet: err.filter((l) => l.includes('on_model_failure')),
      }).toEqual({
        result: 'failed',
        failed: [],
        open: false,
        entry: 's',
        giveBack: 1,
        bullet: [],
      });
    },
  );
});

// ─── Check 4: texts, tries and usage on the member's entry ──────────────────────────────────────

describe("gap 2 (ii-b2), check 4 — the member's entry keeps the failure's texts, tries and usage", () => {
  const OUT = {
    type: 'object',
    properties: { answer: { type: 'string', enum: ['ok'] } },
    required: ['answer'],
  };
  it('a repair pass, then a call answered once and then refused twice (503) under retry: usage once, earlier calls first, the unanswered request last', async () => {
    script = [reply([text('{"answer":"wrong"}')]), reply([text('not json')]), fail(503), fail(503)];
    const def = workflow('g2iib2-texts', { ...KEY, retry: FAST, output_schema: OUT });
    const { run } = await drive(def, anthropic(), { schemaRetries: 1 });
    const entry = errorEntryOf(run);
    const requests = entry?.diagnostics?.cache?.requests ?? [];
    const texts = entry?.model_text?.recorded === true ? entry.model_text.requests : [];
    const everyId = [
      ...run.evidence.flatMap((e) => e.diagnostics?.cache?.requests ?? []),
      ...(run.drive_failures?.entries ?? []).flatMap((e) => e.usage ?? []),
    ].map((u) => u.request_id);
    // (a) red when the member's path mints the failing call's ids again, drops the texts, drops
    //     the tries, or the step's earlier calls are not in front; (b) prints the entry's usage
    //     ids, its texts' ids and replies, its tries and every id on the record.
    expect({
      code: entry?.error_code,
      usage: requests.length,
      textIds: texts.map((t) => t.request_id),
      lastReply: texts.length > 0 ? texts[texts.length - 1]!.reply : 'absent',
      tries: entry?.model_attempts?.length ?? 0,
      idsOnce: new Set(everyId).size === everyId.length,
    }).toEqual({
      code: 'STEP_RETRY_EXHAUSTED',
      usage: 2,
      textIds: [requests[0]?.request_id, requests[1]?.request_id, null],
      lastReply: null,
      tries: 2,
      idsOnce: true,
    });
  });

  it('no retry and an unbilled 503: model_text holds the one request, unanswered', async () => {
    script = [fail(503), fail(503), fail(503)];
    const { run } = await drive(workflow('g2iib2-unbilled', KEY), anthropic());
    const entry = errorEntryOf(run);
    // (a) red when the step meta goes only with usage (texts alone dropped); (b) prints the texts.
    expect({
      usage: entry?.diagnostics?.cache?.requests?.length ?? 0,
      texts:
        entry?.model_text?.recorded === true
          ? entry.model_text.requests.map((t) => ({ id: t.request_id, reply: t.reply }))
          : (entry?.model_text ?? 'absent'),
    }).toEqual({ usage: 0, texts: [{ id: null, reply: null }] });
  });
});

// ─── Check 5: any other reply on the member's path (the one home) ───────────────────────────────

describe("gap 2 (ii-b2), check 5 — a reply that records no failure keeps the drive's entry", () => {
  it('(a) another program removed the claim during the request: STATE_CLAIM_LOST, the entry written, the outcome line, the drive stops', async () => {
    script = [fail(400, 'invalid_request_error', 'bad (fake)'), reply([text('{"answer":"ok"}')])];
    onWire = async (n) => {
      if (n !== 1) return;
      const { record } = await storeOf!.get(runIdOf);
      const { s: _own, ...others } = record.claims ?? {};
      await storeOf!.update({
        ...record,
        in_progress_steps: record.in_progress_steps.filter((x) => x !== 's'),
        claims: others,
      } as RunRecord);
    };
    const { result, run } = await drive(workflow('g2iib2-lost', KEY), anthropic());
    // (a) red when nothing is written on this reply, or the drive goes on and asks the model again;
    //     (b) prints the result, the entry, the line and the wire count.
    expect({
      result,
      wires,
      failed: run.failed_steps,
      entry: lastFailure(run)?.last_observed_status ?? 'none',
      line: out.filter((l) => l.startsWith("• Step 's'")),
    }).toEqual({
      result: 'failed',
      wires: 1,
      failed: [],
      entry: 400,
      line: [
        "• Step 's': another process removed the claim this program held on it; this program's outcome for it was not recorded.",
      ],
    });
  });

  it('(b) another program holds the step when the run is loaded (a blocked reply): the entry written, the held-elsewhere line, the drive stops', async () => {
    script = [fail(400, 'invalid_request_error', 'bad (fake)'), reply([text('{"answer":"ok"}')])];
    onWire = async (n) => {
      if (n !== 1) return;
      // The claim now names another drive's lease, as after a take-back by another program.
      const { record } = await storeOf!.get(runIdOf);
      const claim = record.claims?.['s'];
      await storeOf!.update({
        ...record,
        claims: { ...record.claims, s: { ...claim!, lease: { id: 'another-drive-lease' } } },
      } as RunRecord);
    };
    const { result, run } = await drive(workflow('g2iib2-held', KEY), anthropic());
    // (a) red when nothing is written, or the drive goes on; (b) prints the result, the entry,
    //     the line and the wire count.
    expect({
      result,
      wires,
      failed: run.failed_steps,
      entry: lastFailure(run)?.last_observed_status ?? 'none',
      line: out.filter((l) => l.startsWith("• Step 's' was")).length,
      notRecorded: out.some((l) => l.endsWith("this program's outcome for it was not recorded.")),
    }).toEqual({ result: 'failed', wires: 1, failed: [], entry: 400, line: 1, notRecorded: true });
  });
});

// ─── Check 5b: the store fails ──────────────────────────────────────────────────────────────────

describe('gap 2 (ii-b2), check 5b — the store fails on the member’s path', () => {
  it("(i) the settle's write throws: one drive failure with the model failure's class and message, Words 6b's line, then the give-back", async () => {
    script = [fail(400, 'invalid_request_error', 'bad (fake)')];
    const store = new InMemoryStore({ leases: createLeaseDouble() });
    const settle = store.settleStep.bind(store);
    let armed = false;
    // The member's settle fails once; the give-back after it is the store's own.
    vi.spyOn(store, 'settleStep').mockImplementation(async (...a) => {
      if (armed) {
        armed = false;
        throw new Error('the disk is full (fake)');
      }
      return settle(...a);
    });
    onWire = async () => {
      armed = true;
    };
    const { result, run } = await drive(workflow('g2iib2-store', KEY), anthropic(), { store });
    const entry = lastFailure(run);
    const words = err.findIndex((l) =>
      l.startsWith("• Step 's': the engine did not record its failure"),
    );
    // (a) red when nothing is written, or today's `✗ Step 's' failed: …` line is printed (a second
    //     ✗ line, blaming the step); (b) prints the entry, the lines and their order.
    expect({
      result,
      entries: run.drive_failures?.entries.length ?? 0,
      entry:
        entry === undefined
          ? null
          : { class: entry.error_class, status: entry.last_observed_status },
      words: words >= 0,
      stepFailedLine: err.some(
        (l) => l.startsWith("\n✗ Step 's' failed:") || l.startsWith("✗ Step 's' failed:"),
      ),
      giveBack: out.filter((l) => l.includes('let its claim go')),
    }).toEqual({
      result: 'failed',
      entries: 1,
      entry: { class: 'api_status', status: 400 },
      words: true,
      stepFailedLine: false,
      giveBack: [
        "• Step 's': this drive let its claim go (the engine refused the step's result), so the step can run again.",
      ],
    });
  });

  it('(ii) the run cannot be read when executeChain starts: the last-resort entry carries the failing call’s texts', async () => {
    script = [fail(400, 'invalid_request_error', 'bad (fake)')];
    const store = new InMemoryStore({ leases: createLeaseDouble() });
    const get = store.get.bind(store);
    let armed = 0;
    vi.spyOn(store, 'get').mockImplementation(async (...a) => {
      if (armed === 1) {
        armed = 2;
        throw new Error('the store cannot be read (fake)');
      }
      return get(...a);
    });
    onWire = async () => {
      armed = 1;
    };
    const { run } = await drive(workflow('g2iib2-unread', KEY), anthropic(), { store });
    const entry = lastFailure(run);
    // (a) red when the drive does not put the failing call's texts in its per-step totals before
    //     the call (the last-resort entry keeps none); (b) prints the entry's texts.
    expect({
      entries: run.drive_failures?.entries.length ?? 0,
      texts:
        entry?.model_text?.recorded === true
          ? entry.model_text.requests.map((t) => ({ id: t.request_id, reply: t.reply }))
          : (entry?.model_text ?? 'absent'),
    }).toEqual({ entries: 1, texts: [{ id: null, reply: null }] });
  });
});

// ─── Check 6: provider modules ──────────────────────────────────────────────────────────────────

/** A provider module (`--provider-module`) whose call throws a 503 with its status. */
class Module503 extends LlmProvider {
  constructor(private readonly caps: Partial<ProviderCapabilities> = {}) {
    super();
  }
  override capabilities(): ProviderCapabilities {
    return { jsonMode: false, ...this.caps };
  }
  async callStep(): Promise<Record<string, unknown>> {
    throw new Error('not used');
  }
  override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
    throw Object.assign(new Error('overloaded (fake module)'), { status: 503 });
  }
}
class ToolsModule400 extends ToolCapableLlmProvider {
  override capabilities(): ProviderCapabilities {
    return { jsonMode: false };
  }
  async callStep(): Promise<Record<string, unknown>> {
    throw new Error('not used');
  }
  async callStepWithTools(): Promise<StepWithToolsResult> {
    throw Object.assign(new Error('bad request (fake module)'), { status: 400 });
  }
}
const MODULE = { providerId: 'module:my-provider.mjs' as const };

describe('gap 2 (ii-b2), check 6 — a provider module passes the rule’s pair', () => {
  it.each([
    ['a module without retry: a 503', new Module503(), {}, 'transient', 'no_retry_policy'],
    [
      'a module that handles its own retries, with retry: a 503',
      new Module503({ handlesRetries: true }),
      { retry: FAST },
      'transient',
      'non_retryable',
    ],
    [
      'a module with tools: a 400',
      new ToolsModule400(),
      { tools: ['srv:lookup'] },
      'permanent',
      'non_retryable',
    ],
  ] as const)('%s → %s × %s', async (_n, mod, step, kind, stop) => {
    const def = workflow(
      `g2iib2-module-${kind}-${stop}`,
      { ...KEY, ...step },
      {
        ...('tools' in step ? { extra: TOOLS_EXTRA } : {}),
      },
    );
    const { run } = await drive(def, mod, MODULE);
    const entry = errorEntryOf(run);
    // (a) red when the module's kind is dropped (the drive judges it as Realm's own provider);
    //     (b) prints the entry's code, kind and stop reason.
    expect({
      failed: run.failed_steps,
      kind: entry?.diagnostics?.failure_kind,
      stop: entry?.stop_reason,
      code: entry?.error_code,
    }).toEqual({ failed: ['s'], kind, stop, code: 'MODEL_REQUEST_FAILED' });
  });
});
