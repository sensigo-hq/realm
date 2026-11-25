// settlement-message-g2iva1.test.ts — gap 2, unit (iv-a1): `$settlement.<step>.message`, a failed
// step's own message, for the people who answer a question and for the next step.
//
// The field is the step's last evidence entry with a string `error`, bounded as `failures[].message`
// is, on a step that failed or took its default answer after its model request failed (unit
// (iii)); absent on every other step. An approval question that reads it, and so the Slack post,
// hides every secret Realm knows of in it, before any filter runs, also through a path that holds
// it; a prompt or an `input_map` takes it as written. The cells drive `runAgent` with Realm's
// Anthropic provider over a scripted `fetch` (fake keys), or core's `advanceRun` with the
// terminal's disclosure set, and read the record, the question and the body a fake Slack server
// receives. Fake secrets only.
//
// Every cell carries (a) the break that turns it red and (b) what it prints.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  advanceRun,
  applyResume,
  buildDisclosureSet,
  buildSettlementNamespace,
  createDefaultRegistry,
  submitHumanResponse,
  WorkflowError,
  type EvidenceSnapshot,
  type ExtensionRegistry,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent, type AgentDeps } from './run-agent.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { postGateViaApi } from './gate/slack-gate-notifier.js';
import { slackResponse } from './test-support/slack-response.js';

type Wire = () => Response;
let script: Wire[] = [];
let out: string[] = [];
let err: string[] = [];
let slackBodies: string[] = [];

const ENV_NAME = 'IVA1_FAKE_ENV_SECRET';
const ENV_VALUE = 'QXZENV-IVA1-0001-FAKE';
const PAT_VALUE = 'QXZPAT0001fake';

beforeEach(() => {
  script = [];
  out = [];
  err = [];
  slackBodies = [];
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-fake-g2iva1-0000');
  vi.stubEnv('REALM_NOT_SECRET', '');
  vi.stubEnv(ENV_NAME, ENV_VALUE);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes('slack')) {
        slackBodies.push(String(init?.body));
        return slackResponse({ json: { ok: true, ts: '1.0' } });
      }
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const JSONH = { 'content-type': 'application/json' };
const reply =
  (t: string): Wire =>
  () =>
    new Response(
      JSON.stringify({
        id: 'msg_fake_g2iva1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test-1',
        content: [{ type: 'text', text: t }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: JSONH },
    );
const fail =
  (status: number, type = 'api_error', message = 'overloaded (fake)'): Wire =>
  () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
      status,
      headers: JSONH,
    });
const FAST = { max_attempts: 2, backoff: 'fixed', base_delay_ms: 1 };
const MSG_503 = '503 {"type":"error","error":{"type":"api_error","message":"overloaded (fake)"}}';
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['route'],
  properties: { route: { type: 'string' } },
};
const DEFAULT = { route: 'human' };

const wf = (id: string, steps: Record<string, unknown>) =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  }) as unknown as WorkflowDefinition;
const onFailure = (dep: string, over: Record<string, unknown> = {}) => ({
  description: 'Run on the failure.',
  execution: 'auto',
  depends_on: [dep],
  trigger_rule: 'one_failed',
  ...over,
});
const readsMessage = (dep: string) => ({
  input_map: { why: `context.resources.$settlement.${dep}.message` },
});

/** The handler params each `capture` call received, in order. */
let captured: Array<Record<string, unknown>> = [];
function registry(
  more: Record<string, (params: unknown) => Promise<unknown>> = {},
): ExtensionRegistry {
  captured = [];
  const r = createDefaultRegistry();
  const handlers: Record<string, (params: unknown) => Promise<unknown>> = {
    noted: async () => ({ data: { noted: true } }),
    capture: async (p: unknown) => {
      captured.push((p as { params?: Record<string, unknown> }).params ?? {});
      return { data: { captured: true } };
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
}

/** One `realm agent --run-id` drive; `extraOf` may read the run's store (a gate handler). */
async function drive(
  def: WorkflowDefinition,
  extraOf: Partial<AgentDeps> | ((store: InMemoryStore) => Partial<AgentDeps>) = {},
  on: { store?: InMemoryStore; runId?: string; registry?: ExtensionRegistry } = {},
): Promise<Drive> {
  const store = on.store ?? new InMemoryStore({ leases: createLeaseDouble() });
  const extra = typeof extraOf === 'function' ? extraOf(store) : extraOf;
  const runId =
    on.runId ??
    (await store.create({ workflowId: def.id, workflowVersion: 1, params: {} })).record.id;
  const result = await runAgent(
    {
      store,
      workflowStore: { register: async () => {}, get: async () => def, list: async () => [def] },
      provider: new AnthropicProvider('claude-test-1'),
      registry: on.registry ?? registry(),
      ...extra,
    } as unknown as AgentDeps,
    { existingRunId: runId, definition: def, params: {} },
  ).catch((thrown: unknown) => thrown);
  return { result, run: (await store.get(runId)).record, store };
}

/** Every string inside `value`, depth first. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}
const entryOf = (run: RunRecord, step: string): EvidenceSnapshot | undefined =>
  run.evidence.filter((e) => e.step_id === step && e.kind !== 'gate_response').at(-1);

// ─── Check 1: three readers of a model failure's message ─────────────────────────────────────────

describe('gap 2 (iv-a1), check 1 — an agent step fails under on_model_failure: fail; three steps read its message', () => {
  it('the question shows it, the prompt sends it, the handler gets it', async () => {
    script = [fail(503), fail(503), reply('{"ok":true}')];
    const def = wf('g2iva1-c1', {
      s: {
        description: 'Answer with JSON.',
        execution: 'agent',
        on_model_failure: 'fail',
        retry: FAST,
      },
      q: onFailure('s', {
        handler: 'noted',
        trust: 'human_confirmed',
        gate: { choices: ['ok'], message: 'Why: {{ context.resources.$settlement.s.message }}' },
      }),
      p: {
        description: 'Explain.',
        execution: 'agent',
        depends_on: ['s'],
        trigger_rule: 'one_failed',
        prompt: 'Explain: {{ context.resources.$settlement.s.message }}',
      },
      h: onFailure('s', { handler: 'capture', ...readsMessage('s') }),
    });
    const questions: Array<string | undefined> = [];
    const d = await drive(def, (store) => ({
      gateHandler: async (runId, gate) => {
        questions.push((await store.get(runId)).record.pending_gate?.resolved_message);
        await submitHumanResponse(store, def, { runId, gateId: gate.gate_id, choice: 'ok' });
      },
    }));
    const sent = stringsIn(entryOf(d.run, 'p')?.model_text);
    // (a) red when the field is not built (the question is not resolved, the prompt and the handler
    //     get nothing); (b) prints the three reads.
    expect({
      field: buildSettlementNamespace(d.run)['s']?.message,
      question: questions,
      prompt: sent.some((t) => t.includes(`Explain: ${MSG_503}`)),
      handler: captured.map((p) => p['why']),
      resolved: entryOf(d.run, 'h')?.resolved_params,
    }).toEqual({
      field: MSG_503,
      question: [`Why: ${MSG_503}`],
      prompt: true,
      handler: [MSG_503],
      resolved: { why: MSG_503 },
    });
  });
});

// ─── Check 2: secrets in a handler's text ────────────────────────────────────────────────────────

describe('gap 2 (iv-a1), check 2 — a handler’s text with fake secrets: hidden in the question and the Slack post, unmasked for the next step', () => {
  const RAW = `token=${PAT_VALUE} and ${ENV_VALUE} again`;
  const MESSAGE = `Handler 'boom' threw: ${RAW}`;
  const HIDDEN = "Handler 'boom' threw: token=[REDACTED] and [REDACTED] again";
  // `truncate: N` keeps the text before the last space at or before N, then `…`: it never keeps
  // part of a word, so a cut on the raw text keeps a space-free secret whole or not at all. What
  // tells the two orders apart is where the cut lands. N is the space after the environment
  // secret's marker in the hidden text, so a cut on the hidden text keeps that marker; on the raw
  // text N falls 7 characters into the environment secret, and the cut backs up to "and".
  const N = HIDDEN.indexOf(' again') + 1;
  const GATE_MESSAGE = [
    'plain: {{ context.resources.$settlement.boom.message }}',
    `cut: {{ context.resources.$settlement.boom.message | truncate: ${N} }}`,
    'lower: {{ context.resources.$settlement.boom.message | lower }}',
    'dump: {{ context.resources.$settlement.boom }}',
  ].join('\n');

  it('the fixture: N falls inside the environment secret in the raw text', () => {
    const at = MESSAGE.indexOf(ENV_VALUE);
    // (a) red when the texts change so N no longer lands inside the secret; (b) prints the indexes.
    expect({ inside: N > at && N < at + ENV_VALUE.length, N, at }).toEqual({
      inside: true,
      N,
      at,
    });
  });

  it('plain, | truncate: N (N inside the environment secret), | lower and the whole-entry dump each hide both; the handler gets the text', async () => {
    const def = wf('g2iva1-c2', {
      boom: { description: 'Fail.', execution: 'auto', handler: 'boom' },
      next: onFailure('boom', { handler: 'capture', ...readsMessage('boom') }),
      review: onFailure('boom', {
        handler: 'noted',
        trust: 'human_confirmed',
        gate: { choices: ['ok'], message: GATE_MESSAGE },
      }),
    });
    const store = new InMemoryStore({ leases: createLeaseDouble() });
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const set = buildDisclosureSet({
      env: process.env,
      declared: {},
      declaredState: 'resolved',
      audience: 'private',
    }).set;
    const reg = registry({
      boom: async () => {
        throw new Error(RAW);
      },
    });
    // The first call fails `boom` and stops there; the second runs the steps its failure allowed.
    await advanceRun(store, def, { runId: record.id, registry: reg, disclosure: set });
    await advanceRun(store, def, { runId: record.id, registry: reg, disclosure: set });
    const run = (await store.get(record.id)).record;
    const question = run.pending_gate?.resolved_message ?? '(no question)';
    await postGateViaApi('xoxb-fake', 'C1', run.pending_gate!, record.id, true);
    const posted = slackBodies.join('\n');
    const shows = (text: string) => ({
      env: text.toLowerCase().includes(ENV_VALUE.toLowerCase()),
      envPrefix: text.toLowerCase().includes(ENV_VALUE.slice(0, 6).toLowerCase()),
      pattern: text.toLowerCase().includes(PAT_VALUE.toLowerCase()),
    });
    const line = (name: string): string | undefined =>
      question.split('\n').find((l) => l.startsWith(`${name}: `));
    // (a) red when the field is masked at the declared tier only (both secrets show), when the
    //     stronger hiding runs after the filters (the cut lands on the raw text and loses the
    //     marker, and the lowered environment secret shows), or when it matches the exact path
    //     only (the dump shows them); (b) prints what shows where, and the question.
    expect(
      {
        field: buildSettlementNamespace(run)['boom']?.message,
        question: shows(question),
        plain: line('plain'),
        cut: line('cut'),
        lower: line('lower'),
        dump: question.includes('"message": "' + HIDDEN + '"'),
        slack: shows(posted),
        handler: captured.map((p) => p['why']),
      },
      question,
    ).toEqual({
      field: MESSAGE,
      question: { env: false, envPrefix: false, pattern: false },
      plain: `plain: ${HIDDEN}`,
      cut: "cut: Handler 'boom' threw: token=[REDACTED] and [REDACTED]…",
      lower: `lower: ${HIDDEN.toLowerCase()}`,
      dump: true,
      slack: { env: false, envPrefix: false, pattern: false },
      handler: [MESSAGE],
    });
  });
});

// ─── Check 3: a step defaulted by unit (iii) ─────────────────────────────────────────────────────

describe('gap 2 (iv-a1), check 3 — a step that took its default answer after its model request failed', () => {
  const MSG_400 =
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"bad (fake)"}}';
  const stepS = (over: Record<string, unknown> = {}) => ({
    description: 'Answer with JSON.',
    execution: 'agent',
    output_schema: SCHEMA,
    on_model_failure: 'default',
    validation_exhaustion: { default_output: DEFAULT },
    ...over,
  });
  it.each([
    ['without a gate', {}],
    ['with a human_confirmed gate answered on the default', { trust: 'human_confirmed' }],
  ])(
    '%s: the field is the error entry’s message, although the step completed',
    async (_n, over) => {
      script = [fail(400, 'invalid_request_error', 'bad (fake)')];
      const def = wf('g2iva1-c3', {
        s: stepS(over),
        r: {
          description: 'Read it.',
          execution: 'auto',
          depends_on: ['s'],
          handler: 'capture',
          ...readsMessage('s'),
        },
      });
      const d = await drive(def, (store) => ({
        gateHandler: async (runId, gate) => {
          await submitHumanResponse(store, def, { runId, gateId: gate.gate_id, choice: 'approve' });
        },
      }));
      // (a) red when the value is read from the step's last entry (the default has no error:
      //     absent), or from its newest entry of any kind (the gate answer: absent); (b) prints the
      //     record and what the reader got.
      expect({
        completed: d.run.completed_steps,
        last: d.run.evidence.filter((e) => e.step_id === 's').at(-1)?.kind ?? 'execution',
        field: buildSettlementNamespace(d.run)['s']?.message,
        handler: captured.map((p) => p['why']),
      }).toEqual({
        completed: ['s', 'r'],
        last: 'trust' in over ? 'gate_response' : 'execution',
        field: MSG_400,
        handler: [MSG_400],
      });
    },
  );
});

// ─── Check 4: a step that completed after a failed attempt ───────────────────────────────────────

describe('gap 2 (iv-a1), check 4 — a step that failed once and then succeeded under retry', () => {
  it('the field is absent; the earlier attempt’s error never shows', async () => {
    let calls = 0;
    const def = wf('g2iva1-c4', {
      flaky: {
        description: 'Fail once.',
        execution: 'auto',
        handler: 'flaky',
        retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 1 },
      },
      r: {
        description: 'Read it.',
        execution: 'auto',
        depends_on: ['flaky'],
        handler: 'capture',
        ...readsMessage('flaky'),
      },
    });
    const d = await drive(
      def,
      {},
      {
        registry: registry({
          flaky: async () => {
            calls += 1;
            if (calls === 1) {
              throw new WorkflowError('first try fails (fake)', {
                code: 'SERVICE_RATE_LIMITED',
                category: 'SERVICE',
                agentAction: 'wait_and_proceed',
                retryable: true,
              });
            }
            return { data: { ok: true } };
          },
        }),
      },
    );
    // (a) red when the membership condition is removed (the earlier attempt's error shows); (b)
    //     prints the entries' statuses, the field and what the reader got.
    expect({
      statuses: d.run.evidence.filter((e) => e.step_id === 'flaky').map((e) => e.status),
      field: buildSettlementNamespace(d.run)['flaky']?.message ?? null,
      handler: captured.map((p) => p['why'] ?? null),
    }).toEqual({ statuses: ['error', 'success'], field: null, handler: [null] });
  });
});

// ─── Check 5: #220 ───────────────────────────────────────────────────────────────────────────────

describe('gap 2 (iv-a1), check 5 — #220: refused answers after a resume, and refused too often under mode: fail', () => {
  it('failed on a model request, resumed, then defaulted after refused answers: absent', async () => {
    const def = wf('g2iva1-c5a', {
      a: {
        description: 'Answer with JSON.',
        execution: 'agent',
        output_schema: SCHEMA,
        on_model_failure: 'fail',
        validation_exhaustion: { mode: 'default', threshold: 1, default_output: DEFAULT },
      },
    });
    script = [fail(400, 'invalid_request_error', 'bad (fake)')];
    const first = await drive(def);
    await first.store.update(applyResume(first.run, 'a', def).run);
    script = [reply('{"route": 5}')];
    const second = await drive(def, {}, { store: first.store, runId: first.run.id });
    // (a) red when the pick is keyed on settled_by_default alone (the resumed step shows its old
    //     error); (b) prints the entries and the field.
    expect({
      entries: second.run.evidence.map((e) => [e.status, e.error_code ?? null]),
      completed: second.run.completed_steps,
      field: buildSettlementNamespace(second.run)['a']?.message ?? null,
    }).toEqual({
      entries: [
        ['error', 'MODEL_REQUEST_FAILED'],
        ['success', null],
      ],
      completed: ['a'],
      field: null,
    });
  });

  it('refused too often under mode: fail (VALIDATION_EXHAUSTED): Realm’s own sentence', async () => {
    script = [reply('{"route": 5}')];
    const def = wf('g2iva1-c5b', {
      a: {
        description: 'Answer with JSON.',
        execution: 'agent',
        output_schema: SCHEMA,
        validation_exhaustion: { threshold: 1 },
      },
      r: onFailure('a', { handler: 'capture', ...readsMessage('a') }),
    });
    const d = await drive(def);
    // (a) red when the field is not built for a failed step; (b) prints the field.
    expect({
      failed: d.run.failed_steps,
      handler: captured.map((p) => p['why']),
    }).toEqual({
      failed: ['a'],
      handler: ["Step 'a' exhausted its validation-rejection budget (1/1)"],
    });
  });
});

// ─── Check 6: the bound ──────────────────────────────────────────────────────────────────────────

describe('gap 2 (iv-a1), check 6 — the bound', () => {
  it('an auto step whose handler’s text is over 500 characters: ‹N characters, not kept›', async () => {
    const LONG = 'x'.repeat(600);
    const def = wf('g2iva1-c6', {
      boom: { description: 'Fail.', execution: 'auto', handler: 'boom' },
      r: onFailure('boom', { handler: 'capture', ...readsMessage('boom') }),
    });
    const d = await drive(
      def,
      {},
      {
        registry: registry({
          boom: async () => {
            throw new Error(LONG);
          },
        }),
      },
    );
    const stored = entryOf(d.run, 'boom')?.error ?? '';
    // (a) red when the handler's text is taken uncut; (b) prints the lengths and the field's start.
    expect({
      storedLength: stored.length,
      handler: captured.map((p) => p['why']),
    }).toEqual({
      storedLength: `Handler 'boom' threw: ${LONG}`.length,
      handler: [`‹${stored.length} characters, not kept›`],
    });
  });

  it('a model request’s message is the first 500 characters realm agent kept', async () => {
    const LONG = 'y'.repeat(700);
    script = [fail(400, 'invalid_request_error', LONG)];
    const def = wf('g2iva1-c6b', {
      s: { description: 'Answer with JSON.', execution: 'agent', on_model_failure: 'fail' },
      r: onFailure('s', { handler: 'capture', ...readsMessage('s') }),
    });
    const d = await drive(def);
    const stored = entryOf(d.run, 's')?.error ?? '';
    // (a) red when the drive's cut is lost or the field marks a 500-character text; (b) prints the
    //     lengths.
    expect({
      storedLength: stored.length,
      same: captured[0]?.['why'] === stored,
    }).toEqual({ storedLength: 500, same: true });
  });
});
