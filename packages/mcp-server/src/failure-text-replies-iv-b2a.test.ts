// failure-text-replies-iv-b2a.test.ts — gap 2, unit (iv-b2a): the failure-text setting in the replies
// to the assistant's own calls.
//
// When a step an assistant's own call runs fails, the reply carries the words the failing code put in
// the failure: a handler's message in `errors[0]`, its details in `error_details`, a handler's abort
// message in `context_hint`. Those words can hold the data the step was working on (a card number, an
// order). Under `--failure-text hidden` the server shows their length in their place, keeping the code,
// the action and what to do next. Core marks which text is a failure's words; `renderReply` shapes it
// where it stands. A refusal of the call is Realm's own sentence and stays. Most cells run the real
// server in process (`createRealmMcpServer` over `InMemoryTransport`) on runs failed by their real
// writers; the model-failure arm, which no tool passes, through `executeChain` and `renderReply`.
// Every assertion carries (a) the change that turns it red and (b) what it prints.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  WorkflowError,
  advanceRun,
  executeChain,
  type ExecuteChainOptions,
  type RunStore,
  type ServiceAdapter,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { createRealmMcpServer } from './server.js';
import { renderReply } from './render-reply.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const RUN_STATE = 'docs/reference/mcp/run-state-and-health.md';
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const def = (id: string, steps: Record<string, unknown>): WorkflowDefinition =>
  ({ id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps }) as never;

const homes: TempHome[] = [];
afterEach(async () => {
  for (const h of homes.splice(0).reverse()) await h.cleanup();
});

/** A fake string no masking pattern catches. */
const CARD = 'card 4111-1111-1111-1111 declined';
const ABORT = 'nothing to do for card 4111-1111-1111-1111';
const shape = (n: number): string => `‹string, ${n} character${n === 1 ? '' : 's'}›`;

/** Handlers: `decline` (a WorkflowError with its own details), `flaky` (retryable), `quit` (aborts),
 *  `ok`; and an adapter whose WorkflowError carries a status, an amount and a response body. */
function registry(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  r.register('handler', 'decline', {
    id: 'decline',
    execute: async () => {
      throw new WorkflowError(CARD, {
        code: 'SERVICE_HTTP_4XX',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: false,
        details: { status: 402, reason: CARD },
      });
    },
  } as never);
  r.register('handler', 'flaky', {
    id: 'flaky',
    execute: async () => {
      throw new WorkflowError(CARD, {
        code: 'SERVICE_HTTP_5XX',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: true,
      });
    },
  } as never);
  r.register('handler', 'quit', {
    id: 'quit',
    execute: async () => ({ abort: { message: ABORT } }),
  } as never);
  r.register('handler', 'ok', { id: 'ok', execute: async () => ({ data: { ok: true } }) } as never);
  const adapterErr = new WorkflowError(CARD, {
    code: 'SERVICE_HTTP_4XX',
    category: 'SERVICE',
    agentAction: 'report_to_user',
    retryable: false,
    details: { status: 422, amount: 1234, body: { text: CARD } },
  });
  const adapter: ServiceAdapter = {
    id: 'pay',
    fetch: async () => {
      throw adapterErr;
    },
    create: async () => {
      throw adapterErr;
    },
    update: async () => {
      throw adapterErr;
    },
  };
  r.register('adapter', 'pay', adapter);
  return r;
}

const GATE = {
  description: 'Confirm.',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on: [],
  gate: { choices: ['approve', 'reject'] },
};

const D = {
  chain: def('b2a-chain', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    s: { description: 'S.', execution: 'auto', depends_on: ['a'], handler: 'decline' },
  }),
  auto: def('b2a-auto', {
    s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'decline' },
  }),
  ok: def('b2a-ok', { s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'ok' } }),
  retried: def('b2a-retried', {
    s: {
      description: 'S.',
      execution: 'auto',
      depends_on: [],
      handler: 'flaky',
      retry: { max_attempts: 2, backoff_ms: 1 },
    },
  }),
  adapter: {
    ...def('b2a-adapter', {
      s: { description: 'S.', execution: 'auto', depends_on: [], uses_service: 'svc' },
    }),
    services: { svc: { adapter: 'pay', trust: 'engine_delivered' } },
  } as WorkflowDefinition,
  abort: def('b2a-abort', {
    s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'quit' },
  }),
  chainAbort: def('b2a-chain-abort', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    s: { description: 'S.', execution: 'auto', depends_on: ['a'], handler: 'quit' },
  }),
  gated: def('b2a-gated', {
    confirm: GATE,
    s: { description: 'S.', execution: 'auto', depends_on: ['confirm'], handler: 'decline' },
  }),
  schema: def('b2a-schema', {
    ask: {
      description: 'Ask.',
      execution: 'agent',
      depends_on: [],
      input_schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
    },
  }),
  exhausted: def('b2a-exhausted', {
    ask: {
      description: 'Ask.',
      execution: 'agent',
      depends_on: [],
      input_schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
      validation_exhaustion: { threshold: 1 },
    },
  }),
};
const ALL = Object.values(D);

type Reply = Record<string, unknown> & {
  run_id?: string;
  errors?: string[];
  error_details?: Record<string, unknown>;
  context_hint?: string;
  disclosure?: Record<string, unknown>;
  next_actions?: Array<{
    instruction: { tool: string; call_with: Record<string, unknown> } | null;
  }>;
};

/** A temp home's stores with an in-memory run store, and a server over them per setting. */
async function world() {
  const h = await makeTempHome();
  homes.push(h);
  const runStore = new InMemoryStore({ clock: settableClock(new Date('2026-11-22T00:00:00Z')) });
  const reg = registry();
  for (const d of ALL) await h.stores.workflowStore.register(d);
  const fresh = async (d: WorkflowDefinition, key?: string): Promise<string> =>
    (
      await runStore.create({
        workflowId: d.id,
        workflowVersion: 1,
        params: {},
        ...(key !== undefined ? { idempotencyKey: key } : {}),
      })
    ).record.id;
  const connect = async (
    failureText?: 'shown' | 'hidden',
    extra: { gateAnswers?: 'permitted' } = {},
  ) => {
    const server = createRealmMcpServer({
      ...h.stores,
      runStore: runStore as RunStore,
      registry: reg,
      ...(failureText !== undefined ? { failureText } : {}),
      ...extra,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'failure-text-iv-b2a', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return async (name: string, args: Record<string, unknown>) => {
      const raw = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text?: string }>;
      };
      const text = raw.content[0]?.text ?? '{}';
      return { text, reply: JSON.parse(text) as Reply };
    };
  };
  return { h, runStore, reg, fresh, connect };
}
type World = Awaited<ReturnType<typeof world>>;
type Call = Awaited<ReturnType<World['connect']>>;

/** The same reply, its run id put in place of the other's, so two runs' replies compare. */
const asRun = (text: string, from: string, to: string): string => text.split(from).join(to);

/** One failure, through each setting on a fresh run each: the replies' texts and parsed replies. */
async function both(
  w: World,
  drive: (call: Call, runId: string) => Promise<{ text: string; reply: Reply }>,
  d: WorkflowDefinition,
  extra: { gateAnswers?: 'permitted' } = {},
) {
  const hiddenId = await w.fresh(d);
  const shownId = await w.fresh(d);
  const unsetId = await w.fresh(d);
  const hidden = await drive(await w.connect('hidden', extra), hiddenId);
  const shown = await drive(await w.connect('shown', extra), shownId);
  const unset = await drive(await w.connect(undefined, extra), unsetId);
  return { hidden, shown, unset, hiddenId, shownId, unsetId };
}

const receiptOf = (r: Reply) => r.disclosure as Record<string, unknown>;

describe('gap 2 (iv-b2a), check 1 — a failed step, per tool', () => {
  const TOOLS: Array<[string, WorkflowDefinition, (call: Call, id: string) => ReturnType<Call>]> = [
    [
      'execute_step (its chain runs the failing step)',
      D.chain,
      (call, id) => call('execute_step', { run_id: id, command: 'a', params: {} }),
    ],
    ['advance_run', D.auto, (call, id) => call('advance_run', { run_id: id })],
  ];
  it.each(TOOLS)(
    '%s: errors[0] shaped, error_details with status kept and reason shaped; code, action and next steps as under shown',
    async (_tool, d, drive) => {
      const w = await world();
      const r = await both(w, drive, d);
      const message = r.shown.reply.errors?.[0] ?? '';
      // (a) red when core writes no mark (nothing is shaped), or a kept field changes; (b) prints the
      //     fields compared and whether the fake string is in the hidden reply.
      expect({
        words: r.hidden.text.includes('4111-1111-1111-1111'),
        errors0: r.hidden.reply.errors?.[0],
        details: r.hidden.reply.error_details,
        code: r.hidden.reply['error_code'],
        action: r.hidden.reply['agent_action'],
        next: asRun(JSON.stringify(r.hidden.reply.next_actions), r.hiddenId, r.shownId),
        receipt: [receiptOf(r.hidden.reply)['failure_text'], receiptOf(r.hidden.reply)['shaped']],
      }).toEqual({
        words: false,
        errors0: shape(message.length),
        details: { status: 402, reason: shape(CARD.length) },
        code: r.shown.reply['error_code'],
        action: r.shown.reply['agent_action'],
        next: JSON.stringify(r.shown.reply.next_actions),
        receipt: ['withheld', ['errors', 'error_details']],
      });
    },
  );

  it('start_run (its first step fails as it starts): the same', async () => {
    const w = await world();
    const run = async (failureText?: 'shown' | 'hidden') =>
      (await w.connect(failureText))('start_run', { workflow_id: D.auto.id });
    const hidden = await run('hidden');
    const shown = await run('shown');
    // (a) red when start_run's ran reply is not shaped; (b) prints the fields.
    expect({
      words: hidden.text.includes('4111-1111-1111-1111'),
      errors0: hidden.reply.errors?.[0],
      details: hidden.reply.error_details,
      code: hidden.reply['error_code'],
      receipt: receiptOf(hidden.reply)['shaped'],
    }).toEqual({
      words: false,
      errors0: shape(shown.reply.errors?.[0]?.length ?? 0),
      details: { status: 402, reason: shape(CARD.length) },
      code: shown.reply['error_code'],
      receipt: ['errors', 'error_details'],
    });
  });

  it('submit_human_response (permitted, the opening reply’s claim_token): the answer carries the run on to a step that fails', async () => {
    const w = await world();
    const answer = async (failureText: 'shown' | 'hidden') => {
      const call = await w.connect(failureText, { gateAnswers: 'permitted' });
      const opened = await call('start_run', { workflow_id: D.gated.id });
      const action = opened.reply.next_actions?.[0]?.instruction;
      if (action?.tool !== 'submit_human_response')
        throw new Error('fixture: no answer instruction');
      return call('submit_human_response', { ...action.call_with, choice: 'approve' });
    };
    const hidden = await answer('hidden');
    const shown = await answer('shown');
    // Run first (verify-first): the carried-on reply's errors[0] is the failing step's message, as
    // execute_step's is, so both fields are shaped. (a) red when the carried-on reply is not shaped;
    // (b) prints the fields.
    expect({
      words: hidden.text.includes('4111-1111-1111-1111'),
      shownWords: shown.text.includes('4111-1111-1111-1111'),
      errors0: hidden.reply.errors?.[0],
      details: hidden.reply.error_details,
      receipt: receiptOf(hidden.reply)['shaped'],
    }).toEqual({
      words: false,
      shownWords: true,
      errors0: shape(shown.reply.errors?.[0]?.length ?? 0),
      details: { status: 402, reason: shape(CARD.length) },
      receipt: ['errors', 'error_details'],
    });
  });
});

type ModelFailure = NonNullable<ExecuteChainOptions['modelFailure']>;

describe('gap 2 (iv-b2a), check 1 — a step settled by modelFailure (through executeChain and renderReply; no tool passes it)', () => {
  // Gap 2, unit (ii-b2): the member needs the key, and `attempts` a declared `retry`.
  const MODEL = def('b2a-model', {
    classify: {
      description: 'Classify.',
      execution: 'agent',
      depends_on: [],
      on_model_failure: 'fail',
      retry: { max_attempts: 3 },
    },
  });
  const failure = (over: Partial<ModelFailure>): ModelFailure => ({
    kind: 'transient',
    stop_reason: 'attempts',
    message: `Anthropic 503: ${CARD}`,
    attempt: 3,
    error_class: 'api_status',
    status: 503,
    ...over,
  });
  it.each([
    ['STEP_RETRY_EXHAUSTED', failure({ stop_reason: 'attempts', attempts_sdk: 1 })],
    [
      'MODEL_REQUEST_FAILED',
      failure({ stop_reason: 'non_retryable', attempt: 1, kind: 'permanent', status: 400 }),
    ],
  ] as const)(
    '%s: errors[0] shaped, failure_kind and error_class kept, lastError shaped',
    async (code, mf) => {
      const store = new InMemoryStore();
      const { record } = await store.create({
        workflowId: MODEL.id,
        workflowVersion: 1,
        params: {},
      });
      const reply = await executeChain(store, MODEL, {
        runId: record.id,
        command: 'classify',
        input: {},
        dispatcher: async (_s, i) => ({ ...i }),
        modelFailure: mf,
      });
      const hidden = renderReply(reply, { failureText: 'hidden' }).envelope;
      const shown = renderReply(reply, {}).envelope;
      const { lastError: hiddenLast, ...hiddenRest } = (hidden.error_details ?? {}) as Record<
        string,
        unknown
      >;
      const { lastError: _shownLast, ...shownRest } = (shown.error_details ?? {}) as Record<
        string,
        unknown
      >;
      void _shownLast;
      // (a) red when the model-failure arm writes no mark, or its details are judged as the failing
      //     code's (failure_kind and error_class lost); (b) prints the code, the message and details.
      expect({
        code: hidden.error_code,
        errors0: hidden.errors[0],
        lastError: hiddenLast,
        rest: hiddenRest,
        kept: [hiddenRest['failure_kind'], hiddenRest['error_class']],
      }).toEqual({
        code,
        errors0: shape(mf.message.length),
        lastError: code === 'STEP_RETRY_EXHAUSTED' ? shape(mf.message.length) : undefined,
        rest: shownRest,
        kept: [mf.kind, mf.error_class],
      });
    },
  );
});

describe('gap 2 (iv-b2a), check 2 — the retry wrapper’s details', () => {
  it('stepName, attempts and exhausted_by kept as under shown; lastError shaped', async () => {
    const w = await world();
    const r = await both(w, (call, id) => call('advance_run', { run_id: id }), D.retried);
    const shownDetails = r.shown.reply.error_details ?? {};
    // (a) red when error_details is left whole, or every string in it is shaped (stepName and
    //     exhausted_by lost); (b) prints both details.
    expect(r.hidden.reply.error_details).toEqual({
      ...shownDetails,
      lastError: shape(String(shownDetails['lastError']).length),
    });
    expect({ code: r.shown.reply['error_code'], attempts: shownDetails['attempts'] }).toEqual({
      code: 'STEP_RETRY_EXHAUSTED',
      attempts: 2,
    });
  });
});

describe('gap 2 (iv-b2a), check 3 — an adapter’s own details', () => {
  it('status kept; amount and body shown as their shapes', async () => {
    const w = await world();
    const r = await both(w, (call, id) => call('advance_run', { run_id: id }), D.adapter);
    // (a) red when nested values are kept (the body's words), or every number is kept (the amount);
    //     (b) prints both details.
    expect({ hidden: r.hidden.reply.error_details, shown: r.shown.reply.error_details }).toEqual({
      hidden: { status: 422, amount: '‹number›', body: '‹object, 1 key›' },
      shown: { status: 422, amount: 1234, body: { text: CARD } },
    });
  });
});

describe('gap 2 (iv-b2a), check 4 — a handler’s abort, shaped where it stands', () => {
  it('advance_run: the span alone', async () => {
    const w = await world();
    const r = await both(w, (call, id) => call('advance_run', { run_id: id }), D.abort);
    const span = `Handler step 's' aborted the run: ${ABORT}`;
    const shownHint = r.shown.reply.context_hint ?? '';
    // (a) red when the hint is shaped whole, or left as written; (b) prints both hints.
    expect({
      has: shownHint.includes(span),
      hint: asRun(r.hidden.reply.context_hint ?? '', r.hiddenId, r.shownId),
      receipt: receiptOf(r.hidden.reply)['shaped'],
    }).toEqual({
      has: true,
      hint: shownHint.replace(span, `Handler step 's' aborted the run: ${shape(ABORT.length)}`),
      receipt: ['context_hint'],
    });
  });

  it('execute_step’s chain: core’s opening `Step ’a’ completed.` kept before the shaped span', async () => {
    const w = await world();
    const r = await both(
      w,
      (call, id) => call('execute_step', { run_id: id, command: 'a', params: {} }),
      D.chainAbort,
    );
    const span = `Handler step 's' aborted the run: ${ABORT}`;
    const shownHint = r.shown.reply.context_hint ?? '';
    const hiddenHint = asRun(r.hidden.reply.context_hint ?? '', r.hiddenId, r.shownId);
    // (a) red when the hint is rebuilt from the mark (the opening lost) or shaped whole; (b) prints both.
    expect({
      opens: hiddenHint.startsWith("Step 'a' completed."),
      hint: hiddenHint,
      words: r.hidden.text.includes('4111-1111-1111-1111'),
    }).toEqual({
      opens: true,
      hint: shownHint.replace(span, `Handler step 's' aborted the run: ${shape(ABORT.length)}`),
      words: false,
    });
  });
});

describe('gap 2 (iv-b2a), check 5 — start_run_batch’s matched runs', () => {
  it('an ended run: started[].terminal_reason as get_run_state shows it, with the receipt and its path; a completed one unchanged, no receipt', async () => {
    const w = await world();
    const ended = await w.fresh(D.auto, 'k-ended');
    await advanceRun(w.runStore, D.auto, { runId: ended, registry: w.reg });
    const done = await w.fresh(D.ok, 'k-done');
    await advanceRun(w.runStore, D.ok, { runId: done, registry: w.reg });
    const call = await w.connect('hidden');
    const batch = (d: WorkflowDefinition, key: string) =>
      call('start_run_batch', {
        workflow_id: d.id,
        items: [{ params: {}, idempotency_key: key }],
        on_terminal_match: 'reuse',
      });
    const endedBatch = await batch(D.auto, 'k-ended');
    const doneBatch = await batch(D.ok, 'k-done');
    const state = await call('get_run_state', { run_id: ended });
    const startedOf = (r: Reply) => (r['started'] as Array<Record<string, unknown>>)[0]!;
    // (a) red when the stored reason is shown, or the composer sets no receipt symbol; (b) prints
    //     the reasons and the receipts.
    expect({
      reason: startedOf(endedBatch.reply)['terminal_reason'],
      receipt: [receiptOf(endedBatch.reply)['failure_text'], receiptOf(endedBatch.reply)['shaped']],
      words: endedBatch.text.includes('4111-1111-1111-1111'),
      doneReason: startedOf(doneBatch.reply)['terminal_reason'],
      doneReceipt: receiptOf(doneBatch.reply)['failure_text'],
    }).toEqual({
      reason: state.reply['terminal_reason'],
      receipt: ['withheld', ['started[0].terminal_reason']],
      words: false,
      doneReason: 'Workflow completed.',
      doneReceipt: undefined,
    });
  });
});

describe('gap 2 (iv-b2a), check 6 — a refusal of the call stays', () => {
  const REFUSALS: Array<
    [
      string,
      WorkflowDefinition,
      (call: Call, id: string) => ReturnType<Call>,
      Record<string, unknown>,
    ]
  > = [
    [
      'a schema refusal of the assistant’s answer',
      D.schema,
      (call, id) => call('execute_step', { run_id: id, command: 'ask', params: { n: 'x' } }),
      { error_code: 'VALIDATION_INPUT_SCHEMA' },
    ],
    [
      'VALIDATION_EXHAUSTED (#220, on the failed-step builder)',
      D.exhausted,
      async (call, id) => {
        // The answer that reaches the threshold is the one #220 refuses with VALIDATION_EXHAUSTED.
        for (let i = 0; i < 3; i += 1) {
          const r = await call('execute_step', { run_id: id, command: 'ask', params: { n: 'x' } });
          if (r.reply['error_code'] === 'VALIDATION_EXHAUSTED') return r;
        }
        throw new Error('fixture: no VALIDATION_EXHAUSTED reply');
      },
      { error_code: 'VALIDATION_EXHAUSTED' },
    ],
    [
      'a state refusal (a step whose dependency has not run)',
      D.chain,
      (call, id) => call('execute_step', { run_id: id, command: 's', params: {} }),
      { status: 'blocked' },
    ],
  ];
  it.each(REFUSALS)(
    '%s: byte for byte as under shown, no receipt word',
    async (_name, d, drive, which) => {
      const w = await world();
      const r = await both(w, drive, d);
      // (a) red when the mark is written on Step 5's builder whatever the arm (VALIDATION_EXHAUSTED
      //     shaped), or on a refusal; (b) prints whether the two replies match, the receipt's word,
      //     the reply's code and status, and its first 300 characters.
      expect({
        same: asRun(r.hidden.text, r.hiddenId, r.shownId) === r.shown.text,
        word: receiptOf(r.hidden.reply)['failure_text'],
        code: r.hidden.reply['error_code'],
        status: r.hidden.reply['status'],
        head: r.hidden.text.slice(0, 300),
      }).toMatchObject({
        same: true,
        word: undefined,
        ...('error_code' in which ? { code: which['error_code'] } : { status: which['status'] }),
      });
    },
  );
});

describe('gap 2 (iv-b2a), check 7 — under shown, the reply is today’s', () => {
  const TODAY: Array<[string, WorkflowDefinition, (call: Call, id: string) => ReturnType<Call>]> = [
    [
      'execute_step’s failed chain',
      D.chain,
      (call, id) => call('execute_step', { run_id: id, command: 'a', params: {} }),
    ],
    ['advance_run’s failed step', D.auto, (call, id) => call('advance_run', { run_id: id })],
    ['a retried step', D.retried, (call, id) => call('advance_run', { run_id: id })],
    ['an adapter’s failure', D.adapter, (call, id) => call('advance_run', { run_id: id })],
    ['a handler’s abort', D.abort, (call, id) => call('advance_run', { run_id: id })],
  ];
  it.each(TODAY)(
    '%s: shown equals no setting, and the words are in it',
    async (_name, d, drive) => {
      claim(
        RUN_STATE,
        "The setting also covers the replies of the assistant's own calls (`execute_step`, `advance_run`, `start_run`, `submit_human_response`, `start_run_batch` and `present_question`):",
      );
      const w = await world();
      const r = await both(w, drive, d);
      // (a) red when `shown` is treated as `hidden`; (b) prints whether the two match and the words.
      expect({
        same: asRun(r.shown.text, r.shownId, r.unsetId) === r.unset.text,
        words: r.shown.text.includes('4111-1111-1111-1111'),
        word: receiptOf(r.shown.reply)['failure_text'],
      }).toEqual({ same: true, words: true, word: undefined });
    },
  );
});

describe('gap 2 (iv-b2a), check 8 — the words', () => {
  it('the run-state page’s paragraph and the CHANGELOG sentence say what the replies show', () => {
    // Executed by checks 1–6 (each clause by its cell: errors[0], error_details' top-level keys and
    // numbers, the abort span, started[].terminal_reason, refusals kept, VALIDATION_EXHAUSTED kept)
    // and (iv-b2b)'s load-error clause by its cells (failure-text-load-iv-b2b.test.ts, here and in the
    // CLI); text a workflow copies is shown as its field always is (no field changed here).
    claim(
      RUN_STATE,
      "The setting also covers the replies of the assistant's own calls (`execute_step`, `advance_run`, `start_run`, `submit_human_response`, `start_run_batch` and `present_question`): when a step fails, except because its answers were refused too many times (`VALIDATION_EXHAUSTED`, Realm's own sentence, which stays), `errors[0]` shows as `‹string, N characters›`, and `error_details` keeps its top-level keys, a retried step's `stepName`, `attempts` and `exhausted_by`, and any number in `status` or `retry_after`, and shows every other value as its shape; a handler's abort shows `Handler step '<step>' aborted the run: ‹string, N characters›` in `context_hint`; `start_run_batch`'s `started[].terminal_reason` shows as `terminal_reason` does here. A refusal of the call itself is Realm's own sentence and stays. When a workflow's code throws while it is loaded, the loader's message, which quotes what the code threw, shows as its shape in `errors[0]` and in `not_priced[].detail`; `error_code`, `agent_action` and `context_hint` stay, and so does a sentence Realm wrote about the project, such as a handler with no `execute`, a `use:` that is missing or names no export, or a module file that is not there. An invalid `realm.yaml`, or a secret it names that is not set, shows as its shape whatever the setting: Realm then cannot read the declared secrets, so the reply shows its values as their type and size (`declared_cause: load_failed`). A program's own `registryProvider` is judged the same way: a `WorkflowError` it throws stays as written, and anything else it throws shows as its shape. Text a workflow copies into a question, a prompt or an output is shown as that field always is.",
    );
    claim(
      'CHANGELOG.md',
      "The replies of the assistant's own calls do the same: a failed step's `errors[0]` and its `error_details` (keys kept, a retried step's `stepName`, `attempts` and `exhausted_by` kept, and a number in `status` or `retry_after` kept), a handler's abort in `context_hint`, and `start_run_batch`'s `started[].terminal_reason`; a refusal of the call itself stays.",
    );
  });
});
