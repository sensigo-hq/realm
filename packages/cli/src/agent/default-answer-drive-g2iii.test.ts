// default-answer-drive-g2iii.test.ts — gap 2, unit (iii): `on_model_failure: default` under
// `realm agent`, and what `realm run inspect` then shows.
//
// An agent step whose model request fails for good (the same failures `fail` fails it on) completes
// with its declared default answer, `validation_exhaustion.default_output`. The record keeps the
// failed request's error entry, then the default answer: status `success`, `settled_by_default`, the
// same `failure_kind` and the step's real count of refused answers, and none of the request's facts
// (its cost, texts and tries stay once, on the error entry). The drive prints the request's `✗`
// line, then one `•` line, and goes on as after any completed step; the Result header says the
// answer is the default. #220's own default (after refused answers) now gets its `•` line too. A
// setup failure still gives the step back. The cells drive `runAgent` with Realm's Anthropic provider
// over a scripted `fetch` (fake keys only), and read the screen, the record and inspect's text.
//
// Every cell carries (a) the break that turns it red and (b) what it prints.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  buildSettlementNamespace,
  composeStepViews,
  createDefaultRegistry,
  declareReleaseLine,
  submitHumanResponse,
  type ExtensionRegistry,
  type PriceSource,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent, type AgentDeps } from './run-agent.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import type { McpClient, McpTool } from './mcp/mcp-extensions.js';
import { inspectRun } from '../commands/inspect.js';
import { installWriter, writerTestSeams } from '../output/writer.js';

type Wire = () => Response;
let script: Wire[] = [];
let wires = 0;
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  script = [];
  wires = 0;
  out = [];
  err = [];
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-fake-g2iii-0000');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      wires += 1;
      const next = script.shift();
      if (next === undefined) throw new Error('the test scripted no further answer');
      return next();
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
  writerTestSeams.reset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const JSONH = { 'content-type': 'application/json' };
const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};
const reply =
  (content: unknown[], stop = 'end_turn'): Wire =>
  () =>
    new Response(
      JSON.stringify({
        id: 'msg_fake_g2iii',
        type: 'message',
        role: 'assistant',
        model: 'claude-test-1',
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: USAGE,
      }),
      { status: 200, headers: JSONH },
    );
const text = (t: string): Wire => reply([{ type: 'text', text: t }]);
const fail =
  (status: number, type = 'api_error', message = 'overloaded (fake)'): Wire =>
  () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
      status,
      headers: JSONH,
    });
const BAD_400 = () => fail(400, 'invalid_request_error', 'bad (fake)');

const mcp: McpClient = {
  async connect() {},
  async getTools(_serverId: string, allowList: string[]): Promise<McpTool[]> {
    return allowList.map((name) => ({
      name,
      description: 'Look a thing up',
      inputSchema: { type: 'object' },
    }));
  },
  async call() {
    return { result: 'a fake tool result' };
  },
  async disconnect() {},
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['route'],
  properties: { route: { type: 'string' } },
};
const DEFAULT = { route: 'human' };
const FAST = { max_attempts: 2, backoff: 'fixed', base_delay_ms: 1 };

/** The agent step `s` under test: `on_model_failure: default` and its default answer. */
const stepS = (over: Record<string, unknown> = {}, exhaustion: Record<string, unknown> = {}) => ({
  description: 'Answer with JSON.',
  execution: 'agent',
  output_schema: SCHEMA,
  on_model_failure: 'default',
  validation_exhaustion: { default_output: DEFAULT, ...exhaustion },
  ...over,
});
const auto = (handler: string, over: Record<string, unknown> = {}) => ({
  description: 'Run the handler.',
  execution: 'auto',
  handler,
  depends_on: ['s'],
  ...over,
});
const wf = (id: string, steps: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
    ...extra,
  }) as unknown as WorkflowDefinition;
const TOOLS_EXTRA = {
  mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
};

function registry(more: Record<string, () => Promise<unknown>> = {}): ExtensionRegistry {
  const r = createDefaultRegistry();
  const handlers: Record<string, () => Promise<unknown>> = {
    noted: async () => ({ data: { noted: true } }),
    boom: async () => {
      throw new Error('the filing system is down');
    },
    ...more,
  };
  for (const [id, execute] of Object.entries(handlers)) {
    r.register('handler', id, { id, execute } as never);
  }
  return r;
}

interface Drive {
  result: unknown;
  run: RunRecord;
  store: InMemoryStore;
  workflowStore: object;
  def: WorkflowDefinition;
}

/** One `realm agent --run-id` drive of `def` on a run of its own; `extra` may read the run's store. */
async function drive(
  def: WorkflowDefinition,
  extraOf: Partial<AgentDeps> | ((store: InMemoryStore) => Partial<AgentDeps>) = {},
  on: { store?: InMemoryStore; runId?: string } = {},
): Promise<Drive> {
  const store = on.store ?? new InMemoryStore({ leases: createLeaseDouble() });
  const extra = typeof extraOf === 'function' ? extraOf(store) : extraOf;
  const runId =
    on.runId ??
    (await store.create({ workflowId: def.id, workflowVersion: 1, params: {} })).record.id;
  const workflowStore = { register: async () => {}, get: async () => def, list: async () => [def] };
  declareReleaseLine(workflowStore);
  const result = await runAgent(
    {
      store,
      workflowStore,
      provider: new AnthropicProvider('claude-test-1'),
      registry: registry(),
      mcpClientFactory: () => mcp,
      ...extra,
    } as unknown as AgentDeps,
    { existingRunId: runId, definition: def, params: {} },
  ).catch((thrown: unknown) => thrown);
  return { result, run: (await store.get(runId)).record, store, workflowStore, def };
}

const inspect = (d: Drive, options: Parameters<typeof inspectRun>[3] = {}) =>
  inspectRun(d.run.id, d.store, d.workflowStore as never, options);
const entriesOf = (run: RunRecord, step = 's') => run.evidence.filter((e) => e.step_id === step);
const W1 = (code: string, step = 's') =>
  `• Step '${step}' took its default answer (${code}): its model request failed, and the step has on_model_failure: default.`;
const W2 = (n: number, step = 's') =>
  `• Step '${step}' took its default answer after ${n} refused ${n === 1 ? 'answer' : 'answers'} (validation_exhaustion.mode: default).`;
const bullets = () => err.filter((l) => l.startsWith('• Step '));
const WORDS3_II_B3 = (steps: string) =>
  `\n✗ The run completed, but a step failed during this drive (${steps}); realm agent exits with code 1.`;
/** The lines of inspect's step block for `step`, from its numbered heading to the next one. */
function stepBlock(text: string, step: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^ {2}\\d+\\. ${step}\\b`).test(l));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\d+\. /.test(l));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))];
}
const PRICES: PriceSource = {
  price: () => ({
    priced: { total: 0.01, uncached_counterfactual: 0.01 },
    priced_by: {
      source_class: 'economics',
      source_ref: '/srv/prices.yaml',
      matched_model: 'claude-test-1',
      date_basis: 'dated',
    },
  }),
};
const FAILURE_503 =
  '503 {"type":"error","error":{"type":"api_error","message":"overloaded (fake)"}}';

// ─── Check 1: a 503 every time under retry; an all_success auto step after it ─────────────────────

describe('gap 2 (iii), check 1 — a request that failed for good takes the default; the run goes on', () => {
  const PROFILE = {
    resolved_profiles: { lead: { content: 'Route plainly.', content_hash: 'h-lead' } },
  };
  const def = () =>
    wf(
      'g2iii-c1',
      {
        s: stepS({ retry: FAST, agent_profile: 'lead' }),
        after: auto('noted'),
      },
      PROFILE,
    );

  it('the drive: ✗, then Words 1; the auto step runs; Run complete; the Result header says default; exit 0', async () => {
    script = [fail(503), fail(503)];
    const d = await drive(def());
    // (a) red when the member arm fails the step as under `fail` (no default, the step failed, exit
    //     1), or when the drive treats the settled reply as not recorded (a "not recorded" line, the
    //     drive stops, exit 1); (b) prints the result, the record and every line.
    expect({
      result: d.result,
      wires,
      phase: d.run.run_phase,
      completed: d.run.completed_steps,
      failed: d.run.failed_steps,
      driveFailures: d.run.drive_failures?.entries.length ?? 0,
      crosses: err.filter((l) => l.includes('✗')),
      bullets: bullets(),
      notRecorded: out.filter((l) => l.includes('not recorded')),
      after: out.includes('→ [auto] after'),
      complete: out.includes(`\nRun complete: ${d.run.id}`),
      result_header: out.filter((l) => l.startsWith('\nResult (')),
    }).toEqual({
      result: 'completed',
      wires: 2,
      phase: 'completed',
      completed: ['s', 'after'],
      failed: [],
      driveFailures: 0,
      crosses: [`\n✗ Step 's' LLM call failed: ${FAILURE_503}`],
      bullets: [W1('STEP_RETRY_EXHAUSTED')],
      notRecorded: [],
      after: true,
      complete: true,
      result_header: ['\nResult (s) — its default answer:'],
    });
  });

  it('the record: the error entry, then the default entry; $settlement; defaulted_steps', async () => {
    script = [fail(503), fail(503)];
    const d = await drive(def());
    const [error, answer, ...more] = entriesOf(d.run);
    // (a) red when the default entry carries the request's facts (usage, texts, tries, a
    //     structured_output stamp), lacks failure_kind or the profile, or when the error entry
    //     changes; (b) prints both entries' fields.
    expect({
      count: 2 + more.length,
      error: {
        status: error?.status,
        code: error?.error_code,
        attempt: error?.attempt,
        stop: error?.stop_reason,
        exhausted_by: error?.exhausted_by,
        tries: error?.model_attempts?.length,
        texts: error?.model_text !== undefined,
        kind: error?.diagnostics?.failure_kind,
        defaulted: error?.diagnostics?.settled_by_default,
        profile: error?.agent_profile,
      },
      answer: {
        status: answer?.status,
        input: answer?.input_summary,
        output: answer?.output_summary,
        diagnostics: answer?.diagnostics,
        profile: [answer?.agent_profile, answer?.agent_profile_hash],
        absent: [
          'error',
          'error_code',
          'attempt',
          'model_text',
          'model_attempts',
          'tool_calls',
          'trace',
          'stop_reason',
        ].filter((k) => answer !== undefined && k in answer),
      },
      settlement: buildSettlementNamespace(d.run)['s'],
      defaulted: d.run.defaulted_steps,
    }).toEqual({
      count: 2,
      error: {
        status: 'error',
        code: 'STEP_RETRY_EXHAUSTED',
        attempt: 2,
        stop: 'attempts',
        exhausted_by: 'attempts',
        tries: 2,
        texts: true,
        kind: 'transient',
        defaulted: undefined,
        profile: 'lead',
      },
      answer: {
        status: 'success',
        input: {},
        output: DEFAULT,
        diagnostics: {
          input_token_estimate: expect.any(Number),
          precondition_trace: [],
          settled_by_default: true,
          failure_kind: 'transient',
          validation_rejections: 0,
        },
        profile: ['lead', 'h-lead'],
        absent: [],
      },
      settlement: {
        failed: false,
        settled_by_default: true,
        validation_rejections: 0,
        failure_kind: 'transient',
      },
      defaulted: ['s'],
    });
  });

  it('inspect: the failure line under attempt 1/2; attempt 2/2 is no model call and has no cost sentence', async () => {
    script = [fail(503), fail(503)];
    const d = await drive(def());
    const text = await inspect(d);
    const verbose = await inspect(d, { verbose: true });
    const block = stepBlock(text, 's');
    const views = composeStepViews(d.run, { definition: d.def })['s']?.attempts ?? [];
    // (a) red when the readers' handling of the default entry is removed (attempt 2/2 gains the
    //     cost sentence, its view `cost_unrecorded`, and --verbose its "holds no model call"), or
    //     when the line under the error attempt is removed; (b) prints the step's block.
    expect(
      {
        defaulted: text.split('\n').filter((l) => l.startsWith('Defaulted')),
        failureLine: block[block.findIndex((l) => l.includes('(attempt 1/2)')) + 1],
        costSentences: block.filter((l) => l.includes('cost: not recorded')).map((l) => l.trim()),
        views: views.map((a) => [a.status, a.cost_unrecorded ?? null, a.cost !== undefined]),
        noModelCall: verbose.includes('holds no model call'),
      },
      block.join('\n'),
    ).toEqual({
      defaulted: ['Defaulted (settled by default): s'],
      failureLine: `       STEP_RETRY_EXHAUSTED (ENGINE) — stopped: attempts; kind: transient; next: report_to_user — ${FAILURE_503}`,
      // Attempt 1/2's sentence stays: it is true, the 503s billed nothing.
      costSentences: [
        'attempt 1/2: cost: not recorded — realm has no usage figures for this attempt (for example: its model request failed before an answer came, an outside agent over MCP made it, a person typed its answer at a realm workflow run prompt, or realm 0.45.0 or earlier recorded it)',
      ],
      views: [
        ['error', 'not_measured_by_realm', false],
        ['success', null, false],
      ],
      noModelCall: false,
    });
  });
});

describe('gap 2 (iii), check 1 — inspect takes the step’s trace from the error entry', () => {
  it('the Trace line counts the error entry’s trace; the default entry has none', async () => {
    script = [BAD_400()];
    const d = await drive(wf('g2iii-c1-trace', { s: stepS() }));
    // The record as a step with trace lines writes it: the trace rides the error entry (as under
    // `fail`), and the default entry carries none.
    const traced = structuredClone(d.run);
    const error = traced.evidence.find((e) => e.step_id === 's' && e.status === 'error')!;
    error.trace = [
      { seq: 1, event: 'looked_up', data: {} },
      { seq: 2, event: 'answered', data: {} },
    ] as never;
    const store = Object.create(d.store) as InMemoryStore;
    store.get = async (id: string) => ({ ...(await d.store.get(id)), record: traced });
    const block = stepBlock(await inspect({ ...d, store }), 's');
    // (a) red when the trace is read from the last entry (the default: no Trace line); (b) prints
    //     the step's block.
    expect(
      block.filter((l) => l.includes('Trace:')).map((l) => l.trim()),
      block.join('\n'),
    ).toEqual(['Trace:  2 entries (not hashed).']);
  });
});

// ─── Check 1b: the billed case ───────────────────────────────────────────────────────────────────

describe('gap 2 (iii), check 1b — a tools step: one billed tool turn, then a 503 every time', () => {
  it('the cost is counted once, on attempt 1/2; the run’s Cost line is exact', async () => {
    script = [
      reply([{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }], 'tool_use'),
      fail(503),
      fail(503),
    ];
    const def = wf('g2iii-c1b', { s: stepS({ tools: ['srv:lookup'], retry: FAST }) }, TOOLS_EXTRA);
    const d = await drive(def);
    const text = await inspect(d, { priceSource: PRICES });
    const block = stepBlock(text, 's');
    const views =
      composeStepViews(d.run, { definition: def, priceSource: PRICES })['s']?.attempts ?? [];
    // (a) red when the default entry is built with the request's usage (the figure doubles, 2 of 2
    //     requests), or when the readers' handling of the default entry is removed ("≥" and "1
    //     attempt realm has no usage figures for"); (b) prints the Cost line and the step's block.
    expect(
      {
        cross: err.filter((l) => l.includes('✗')),
        bullets: bullets(),
        cost: text.split('\n').filter((l) => l.startsWith('Cost:')),
        attempt2Cost: block.filter((l) => /attempt 2\/2: |cost: /.test(l)),
        views: views.map((a) => [a.status, a.cost?.requests ?? null, a.cost_unrecorded ?? null]),
      },
      text,
    ).toEqual({
      cross: [`\n✗ Step 's' (tools) failed: ${FAILURE_503}`],
      bullets: [W1('STEP_RETRY_EXHAUSTED')],
      cost: [`Cost: $0.01 (your economics file; at the call's date; 1 of 1 requests priced)`],
      attempt2Cost: [],
      views: [
        ['error', 1, null],
        ['success', null, null],
      ],
    });
  });
});

// ─── Check 1d: masking ───────────────────────────────────────────────────────────────────────────

describe('gap 2 (iii), check 1d — under --broadcast the line under the error attempt shows the message’s shape', () => {
  it('as the Failed: line does', async () => {
    script = [BAD_400()];
    const d = await drive(wf('g2iii-c1d', { s: stepS() }));
    installWriter('broadcast');
    const text = writerTestSeams.visible(await inspect(d));
    const block = stepBlock(text, 's');
    const line = block[block.findIndex((l) => l.includes('(attempt 1/2)')) + 1] ?? '(none)';
    // (a) red when the message is printed outside the value channel (the provider's words on a
    //     broadcast screen); (b) prints the line.
    expect(
      { shaped: /— ‹string, \d+ characters›$/.test(line), words: line.includes('bad (fake)') },
      line,
    ).toEqual({
      shaped: true,
      words: false,
    });
  });
});

// ─── Check 2: a 400 ──────────────────────────────────────────────────────────────────────────────

describe('gap 2 (iii), check 2 — a 400: MODEL_REQUEST_FAILED, permanent, at once', () => {
  it('one wire, Words 1 with the code, the default entry carries failure_kind permanent', async () => {
    script = [BAD_400()];
    const d = await drive(wf('g2iii-c2', { s: stepS() }));
    const [error, answer] = entriesOf(d.run);
    // (a) red when the default entry is written without failure_kind (Words 2 is printed in place
    //     of Words 1, and $settlement has no kind); (b) prints the wires, the lines and the kinds.
    expect({
      result: d.result,
      wires,
      bullets: bullets(),
      kinds: [error?.diagnostics?.failure_kind, answer?.diagnostics?.failure_kind],
      settlement: buildSettlementNamespace(d.run)['s']?.failure_kind,
    }).toEqual({
      result: 'completed',
      wires: 1,
      bullets: [W1('MODEL_REQUEST_FAILED')],
      kinds: ['permanent', 'permanent'],
      settlement: 'permanent',
    });
  });
});

// ─── Check 3: a 401 ──────────────────────────────────────────────────────────────────────────────

describe('gap 2 (iii), check 3 — a 401 under default: given back, the run open, no default', () => {
  it('the give-back line, a drive failure, no evidence', async () => {
    script = [fail(401, 'authentication_error', 'invalid x-api-key (fake)')];
    const d = await drive(wf('g2iii-c3', { s: stepS() }));
    // (a) red when the default is taken on a setup failure (a default entry, the run completed);
    //     (b) prints the record and the lines.
    expect({
      result: d.result,
      phase: d.run.run_phase,
      ended: d.run.terminal_state,
      evidence: d.run.evidence.length,
      driveFailures: d.run.drive_failures?.entries.length ?? 0,
      giveBack: out.filter((l) => l.startsWith("• Step 's': this drive let its claim go")),
      bullets: bullets(),
    }).toEqual({
      result: 'failed',
      phase: 'running',
      ended: false,
      evidence: 0,
      driveFailures: 1,
      giveBack: [
        "• Step 's': this drive let its claim go (its step failed), so the step can run again.",
      ],
      bullets: [],
    });
  });
});

// ─── Check 4: trigger rules ──────────────────────────────────────────────────────────────────────

describe('gap 2 (iii), check 4 — trigger rules: the defaulted step is completed, never failed', () => {
  it('a one_failed step does not run; a when on $settlement.s.failure_kind runs its step', async () => {
    script = [BAD_400()];
    const def = wf('g2iii-c4', {
      s: stepS(),
      route: auto('noted', { trigger_rule: 'one_failed' }),
      next: auto('noted', { when: "$settlement.s.failure_kind == 'permanent'" }),
    });
    const d = await drive(def);
    // (a) red when the step is put in failed_steps (route runs, next does not, exit 1); (b) prints
    //     the record.
    expect({
      result: d.result,
      completed: d.run.completed_steps,
      failed: d.run.failed_steps,
      skipped: d.run.skipped_steps,
    }).toEqual({
      result: 'completed',
      completed: ['s', 'next'],
      failed: [],
      skipped: ['route'],
    });
  });
});

// ─── Checks 5 and 9: both modes on one step; #220's default under the drive ──────────────────────

describe('gap 2 (iii), check 5 — both validation_exhaustion.mode: default and on_model_failure: default', () => {
  const def = () => wf('g2iii-c5', { s: stepS({}, { mode: 'default', threshold: 1 }) });

  it('refused answers take #220’s default: Words 2, no failure_kind', async () => {
    script = [text('{"route": 5}')];
    const d = await drive(def());
    const answer = entriesOf(d.run).at(-1);
    // (a) red when failure_kind is written on #220's default (Words 1's arm, a kind on the entry);
    //     (b) prints the lines and the entry's diagnostics.
    expect({
      result: d.result,
      bullets: bullets(),
      kind: answer?.diagnostics?.failure_kind ?? null,
      defaulted: answer?.diagnostics?.settled_by_default,
      rejections: answer?.diagnostics?.validation_rejections,
    }).toEqual({
      result: 'completed',
      bullets: [W2(1)],
      kind: null,
      defaulted: true,
      rejections: 1,
    });
  });

  it('a failed request takes this unit’s default: Words 1, with failure_kind', async () => {
    script = [BAD_400()];
    const d = await drive(def());
    // (a) red as above; (b) prints the lines and the kind.
    expect({
      bullets: bullets(),
      kind: entriesOf(d.run).at(-1)?.diagnostics?.failure_kind,
    }).toEqual({ bullets: [W1('MODEL_REQUEST_FAILED')], kind: 'permanent' });
  });
});

describe('gap 2 (iii), check 5b — the key alone (mode absent): answers refused too often still fail the step', () => {
  it('VALIDATION_EXHAUSTED, no default entry; the drive goes on and exits 1', async () => {
    script = [text('{"route": 5}')];
    const d = await drive(wf('g2iii-c5b', { s: stepS({}, { threshold: 1 }) }));
    // (a) red when the widened default is keyed on the member's bypass instead of on the member
    //     (the step defaults, exit 0); (b) prints the record and the lines.
    expect({
      result: d.result,
      failed: d.run.failed_steps,
      codes: entriesOf(d.run).map((e) => e.error_code ?? null),
      defaults: entriesOf(d.run).filter((e) => e.diagnostics?.settled_by_default === true).length,
      bullets: bullets(),
    }).toEqual({
      result: 'failed',
      failed: ['s'],
      codes: ['VALIDATION_EXHAUSTED'],
      defaults: 0,
      bullets: [],
    });
  });
});

describe('gap 2 (iii), check 9 — #220’s default under the drive now has its line', () => {
  it('Words 2 with threshold 1 ("1 refused answer"), also when an auto step is chained after it', async () => {
    script = [text('{"route": 5}')];
    const d = await drive(
      wf('g2iii-c9', {
        s: {
          description: 'Answer with JSON.',
          execution: 'agent',
          output_schema: SCHEMA,
          validation_exhaustion: { mode: 'default', threshold: 1, default_output: DEFAULT },
        },
        after: auto('noted'),
      }),
    );
    // (a) red on the old silent drive (no line), or when the line is read from the final reply's
    //     top-level flag (the chained step's reply has none: the line vanishes); (b) prints the
    //     lines and the record.
    expect({
      result: d.result,
      completed: d.run.completed_steps,
      bullets: bullets(),
      result_header: out.filter((l) => l.startsWith('\nResult (')),
    }).toEqual({
      result: 'completed',
      completed: ['s', 'after'],
      bullets: [W2(1)],
      result_header: ['\nResult (s) — its default answer:'],
    });
  });
});

// ─── Check 6: one refused answer, then a failed request ──────────────────────────────────────────

describe('gap 2 (iii), check 6 — one refused answer, then a failed request', () => {
  it('the default entry’s validation_rejections is 1', async () => {
    script = [text('{"route": 5}'), BAD_400()];
    const d = await drive(wf('g2iii-c6', { s: stepS() }));
    // (a) red when 0 is written in place of the step's count; (b) prints the lines and the count.
    expect({
      repairs: err.filter((l) => l.includes('output rejected')).length,
      bullets: bullets(),
      rejections: entriesOf(d.run).at(-1)?.diagnostics?.validation_rejections,
      settlement: buildSettlementNamespace(d.run)['s']?.validation_rejections,
    }).toEqual({
      repairs: 1,
      bullets: [W1('MODEL_REQUEST_FAILED')],
      rejections: 1,
      settlement: 1,
    });
  });
});

// ─── Check 7: human_confirmed ────────────────────────────────────────────────────────────────────

describe('gap 2 (iii), check 7 — human_confirmed: Words 1, then the gate opens on the default', () => {
  it.each(['approve', 'reject'] as const)(
    '%s: the question shows the default; the step completes with it, as #220’s does',
    async (choice) => {
      script = [BAD_400()];
      const def = wf('g2iii-c7', { s: stepS({ trust: 'human_confirmed' }) });
      const previews: unknown[] = [];
      const d = await drive(def, (store) => ({
        gateHandler: async (runId, gate) => {
          previews.push(gate.preview);
          await submitHumanResponse(store, def, { runId, gateId: gate.gate_id, choice });
        },
      }));
      const gateAt = out.findIndex((l) => l.startsWith('\n⏸  Gate: s'));
      // (a) red under the member block's old handling (a "not recorded" line, the drive stops
      //     before the question, exit 1); (b) prints the lines and the record.
      expect({
        result: d.result,
        bullets: bullets(),
        gate: gateAt >= 0,
        previews,
        completed: d.run.completed_steps,
        output: entriesOf(d.run)
          .filter((e) => e.kind !== 'gate_response')
          .at(-1)?.output_summary,
        defaulted: d.run.defaulted_steps,
      }).toEqual({
        result: 'completed',
        bullets: [W1('MODEL_REQUEST_FAILED')],
        gate: true,
        previews: [DEFAULT],
        completed: ['s'],
        output: DEFAULT,
        defaulted: ['s'],
      });
    },
  );
});

// ─── Words 3: a default answer another program gave ──────────────────────────────────────────────

describe('gap 2 (iii), Words 3 — the Result header for a default answer another program gave', () => {
  it('a first drive defaults s and stops on a handler it lacks; a second drive completes the run', async () => {
    script = [BAD_400()];
    const def = wf('g2iii-w3', { s: stepS(), later: auto('later') });
    const first = await drive(def);
    out = [];
    err = [];
    const second = await drive(
      def,
      { registry: registry({ later: async () => ({ data: { later: true } }) }) },
      { store: first.store, runId: first.run.id },
    );
    // (a) red when the header drops the default mark for another program's answer (it reads
    //     `— given by …, not by this drive:` only); (b) prints both results and the header.
    expect({
      first: [first.result, first.run.completed_steps],
      second: [second.result, second.run.completed_steps],
      result_header: out.filter((l) => l.startsWith('\nResult (')),
    }).toEqual({
      first: ['failed', ['s']],
      second: ['completed', ['s', 'later']],
      result_header: [
        '\nResult (s) — its default answer, given by another process, not by this drive:',
      ],
    });
  });
});

// ─── Check 8: a defaulted step chaining into a failing auto step ─────────────────────────────────

describe('gap 2 (iii), check 8 — the defaulted step chains into an auto step that fails', () => {
  it('#1310’s end line names only the failing step; exit 1', async () => {
    script = [BAD_400()];
    const d = await drive(
      wf('g2iii-c8', {
        s: stepS(),
        pay: auto('boom'),
        notify: auto('noted', { depends_on: ['pay'], trigger_rule: 'one_failed' }),
      }),
    );
    // (a) red when the defaulted step is counted as failed in the drive (the end line names both);
    //     (b) prints the record and the lines.
    expect({
      result: d.result,
      completed: d.run.completed_steps,
      failed: d.run.failed_steps,
      bullets: bullets(),
      last: err.at(-1),
    }).toEqual({
      result: 'failed',
      completed: ['s', 'notify'],
      failed: ['pay'],
      bullets: [W1('MODEL_REQUEST_FAILED')],
      last: WORDS3_II_B3('pay'),
    });
  });
});
