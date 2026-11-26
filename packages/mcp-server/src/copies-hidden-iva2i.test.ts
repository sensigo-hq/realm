// copies-hidden-iva2i.test.ts — gap 2, unit (iv-a2-i): under `--failure-text hidden`, a copy a
// workflow makes of a failure's message through `$settlement.<step>.message` reaches an assistant as
// its length, `‹string, N characters›`: in a step's prompt (`next_actions[].prompt`, and
// `start_run_batch`'s `started[].next_actions[].prompt`), in a gated step's instructions
// (`gate.agent_hint`), and in the value a condition read (a skipped step's `skip_details`, a guard's
// `abort_context.conditions`, a precondition's refusal wherever it appears). Each shaped path is
// listed in the reply's receipt. Under `shown`, every reply is as today, and the stored question keeps
// its words under both (unit (iv-a2-ii)'s).
//
// The real server runs in process (`createRealmMcpServer` over `InMemoryTransport`) on runs failed
// by their real writers: a handler that throws, and a model request failed through core's
// `executeChain` (no tool passes that member). Every assertion carries (a) the change that turns it
// red and (b) what it prints. Fake texts only.
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  advanceRun,
  buildDisclosureSet,
  executeChain,
  type DisclosureSet,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const homes: TempHome[] = [];
afterEach(async () => {
  for (const h of homes.splice(0).reverse()) await h.cleanup();
});

/** A handler's fake text, longer than 20 characters, with a space before its 20th. */
const RAW = 'upstream said order 77 for card 5500 was declined today';
/** The message the record keeps for a handler that threw it. */
const MSG = `Handler 'boom' threw: ${RAW}`;
/** A model request's fake message. */
const MODEL_MSG = `Anthropic 503: ${RAW}`;
/** A handler's text over 500 characters: the record keeps `‹N characters, not kept›`. */
const LONG_RAW = 'word '.repeat(130).trim();
const LONG_MSG = `Handler 'long' threw: ${LONG_RAW}`;
const NOT_KEPT = `‹${LONG_MSG.length} characters, not kept›`;
const shape = (n: number): string => `‹string, ${n} character${n === 1 ? '' : 's'}›`;
const FIELD = 'context.resources.$settlement';

const def = (id: string, steps: Record<string, unknown>): WorkflowDefinition =>
  ({ id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps }) as never;
const onFailure = (dep: string, over: Record<string, unknown>) => ({
  description: 'Run on the failure.',
  depends_on: [dep],
  trigger_rule: 'one_failed',
  ...over,
});
const auto = (over: Record<string, unknown>) => ({ execution: 'auto', handler: 'ok', ...over });
const BOOM = { description: 'Fail.', execution: 'auto', handler: 'boom', depends_on: [] };
const CLASSIFY = {
  description: 'Classify.',
  execution: 'agent',
  depends_on: [],
  on_model_failure: 'fail',
  retry: { max_attempts: 3 },
};
const PROMPT = [
  `plain: {{ ${FIELD}.boom.message }}`,
  `cut: {{ ${FIELD}.boom.message | truncate: 20 }}`,
  `dump: {{ ${FIELD}.boom }}`,
].join('\n');

const D = {
  prompt: def('iva2i-prompt', {
    boom: BOOM,
    explain: onFailure('boom', { execution: 'agent', prompt: PROMPT }),
  }),
  long: def('iva2i-long', {
    long: { ...BOOM, handler: 'long' },
    explain: onFailure('long', {
      execution: 'agent',
      prompt: `plain: {{ ${FIELD}.long.message }}`,
    }),
  }),
  gated: def('iva2i-gated', {
    boom: BOOM,
    review: onFailure(
      'boom',
      auto({
        trust: 'human_confirmed',
        instructions: `Why: {{ ${FIELD}.boom.message }}`,
        gate: { choices: ['ok'], message: `Q: {{ ${FIELD}.boom.message }}` },
      }),
    ),
  }),
  model: def('iva2i-model', {
    classify: CLASSIFY,
    whenMsg: onFailure('classify', auto({ when: ["$settlement.classify.message == 'nope'"] })),
    whenKind: onFailure(
      'classify',
      auto({ when: ["$settlement.classify.failure_kind == 'nope'"] }),
    ),
    preMsg: onFailure(
      'classify',
      auto({ preconditions: [`$settlement.classify.message != "${MODEL_MSG}"`] }),
    ),
    preKind: onFailure(
      'classify',
      auto({ preconditions: ['$settlement.classify.failure_kind != "transient"'] }),
    ),
  }),
  guardMsg: def('iva2i-guard-msg', {
    classify: CLASSIFY,
    g: onFailure('classify', {
      execution: 'guard',
      abort_unless: ["$settlement.classify.message == 'nope'"],
    }),
  }),
  guardKind: def('iva2i-guard-kind', {
    classify: CLASSIFY,
    g: onFailure('classify', {
      execution: 'guard',
      abort_unless: ["$settlement.classify.failure_kind == 'nope'"],
    }),
  }),
  agentPre: def('iva2i-agent-pre', {
    classify: CLASSIFY,
    explain: onFailure('classify', {
      execution: 'agent',
      preconditions: [`$settlement.classify.message != "${MODEL_MSG}"`],
    }),
  }),
  alone: def('iva2i-alone', {
    classify: CLASSIFY,
    preMsg: onFailure(
      'classify',
      auto({ preconditions: [`$settlement.classify.message != "${MODEL_MSG}"`] }),
    ),
  }),
  batchHint: def('iva2i-batch-hint', {
    boom: BOOM,
    report: onFailure('boom', auto({ preconditions: ['$settlement.boom.message == "timeout"'] })),
  }),
  batchKind: def('iva2i-batch-kind', {
    classify: CLASSIFY,
    report: onFailure(
      'classify',
      auto({ preconditions: ['$settlement.classify.failure_kind == "x"'] }),
    ),
  }),
  marker: def('iva2i-marker', {
    long: { ...BOOM, handler: 'long' },
    preLong: onFailure('long', auto({ preconditions: ['$settlement.long.message == "x"'] })),
  }),
};

/** Handlers: `boom` throws {@link RAW}, `long` throws {@link LONG_RAW}, `ok` returns. */
function registry(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  r.register('handler', 'boom', {
    id: 'boom',
    execute: async () => {
      throw new Error(RAW);
    },
  } as never);
  r.register('handler', 'long', {
    id: 'long',
    execute: async () => {
      throw new Error(LONG_RAW);
    },
  } as never);
  r.register('handler', 'ok', { id: 'ok', execute: async () => ({ data: { ok: true } }) } as never);
  return r;
}

type Reply = Record<string, unknown> & {
  next_actions?: Array<{ prompt?: string }>;
  disclosure?: { shaped?: string[]; failure_text?: string };
};

/** A temp home's stores, an in-memory run store, the runs, and a server over them per setting. */
async function world() {
  const h = await makeTempHome();
  homes.push(h);
  const runStore = new InMemoryStore();
  const reg = registry();
  for (const d of Object.values(D)) await h.stores.workflowStore.register(d);
  /** A run of `d` driven by its real writers: its first step failed, then (unless `settle` is false)
   *  the steps that run on it. */
  const failed = async (d: WorkflowDefinition, key?: string, settle = true): Promise<string> => {
    const runId = (
      await runStore.create({
        workflowId: d.id,
        workflowVersion: 1,
        params: {},
        ...(key !== undefined ? { idempotencyKey: key } : {}),
      })
    ).record.id;
    if ('classify' in d.steps) {
      await executeChain(runStore, d, {
        runId,
        command: 'classify',
        input: {},
        dispatcher: async (_s, i) => ({ ...i }),
        modelFailure: {
          kind: 'transient',
          stop_reason: 'attempts',
          message: MODEL_MSG,
          attempt: 3,
          error_class: 'api_status',
          status: 503,
          attempts_sdk: 1,
        },
      });
    } else {
      // The first call fails the handler's step and stops; the second runs what its failure allowed.
      await advanceRun(runStore, d, { runId, registry: reg });
    }
    if (settle) await advanceRun(runStore, d, { runId, registry: reg });
    return runId;
  };
  const connect = async (
    failureText: 'shown' | 'hidden',
    provider?: () => Promise<DisclosureSet>,
  ) => {
    const server = createRealmMcpServer({
      ...h.stores,
      runStore: runStore as RunStore,
      registry: reg,
      failureText,
      ...(provider !== undefined ? { disclosureProvider: provider } : {}),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'copies-hidden-iva2i', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return async (name: string, args: Record<string, unknown>): Promise<Reply> => {
      const raw = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text?: string }>;
      };
      return JSON.parse(raw.content[0]?.text ?? '{}') as Reply;
    };
  };
  return { runStore, failed, connect };
}

/** The receipt's shaped paths and its failure-text word. */
const receiptOf = (reply: Reply) => ({
  shaped: reply.disclosure?.shaped ?? [],
  failure_text: reply.disclosure?.failure_text,
});
/** The first entry's prompt. */
const promptOf = (reply: Reply): string | undefined => reply.next_actions?.[0]?.prompt;

describe('gap 2 (iv-a2-i), check 1 — a prompt that reads the message', () => {
  const hiddenPrompt = [
    `plain: ${shape(MSG.length)}`,
    `cut: ${shape(MSG.length)}`,
    'dump: {',
    '  "settled_by_default": false,',
    '  "validation_rejections": 0,',
    '  "failed": true,',
    `  "message": "${shape(MSG.length)}"`,
    '}',
  ].join('\n');

  it('under hidden: plain, | truncate: 20 and the dump show the shape, N the record length; the receipt lists the prompt', async () => {
    const w = await world();
    const runId = await w.failed(D.prompt);
    const call = await w.connect('hidden');
    const state = await call('get_run_state', { run_id: runId });
    const advanced = await call('advance_run', { run_id: runId });
    // (a) red when stepBrief does not read the mark (the words show), when the shape is applied after
    //     the filters (the cut words, or a shape of the cut text's length, show), when only the exact
    //     path is matched (the dump shows the words), or when the run_step entry's mark is missing
    //     (the path absent from the receipt); (b) prints both prompts and receipts.
    expect({
      state: promptOf(state),
      stateReceipt: receiptOf(state),
      engine: promptOf(advanced),
      engineReceipt: receiptOf(advanced),
    }).toEqual({
      state: hiddenPrompt,
      stateReceipt: {
        shaped: expect.arrayContaining(['next_actions[0].prompt']),
        failure_text: 'withheld',
      },
      engine: hiddenPrompt,
      engineReceipt: {
        shaped: expect.arrayContaining(['next_actions[0].prompt']),
        failure_text: 'withheld',
      },
    });
  });

  it('under shown: the words, as today, and no failure-text receipt', async () => {
    const w = await world();
    const runId = await w.failed(D.prompt);
    const state = await (await w.connect('shown'))('get_run_state', { run_id: runId });
    // (a) red when a `shown` server shapes a copy, or its receipt changes; (b) prints the prompt.
    expect({ prompt: promptOf(state), receipt: receiptOf(state) }).toEqual({
      prompt: [
        `plain: ${MSG}`,
        "cut: Handler 'boom'…",
        'dump: {',
        '  "settled_by_default": false,',
        '  "validation_rejections": 0,',
        '  "failed": true,',
        `  "message": "${MSG}"`,
        '}',
      ].join('\n'),
      receipt: { shaped: [], failure_text: undefined },
    });
  });
});

describe('gap 2 (iv-a2-i), check 2 — a handler text over 500 characters', () => {
  it('the prompt shows the not-kept marker under both settings', async () => {
    const w = await world();
    const runId = await w.failed(D.long);
    const hidden = await (await w.connect('hidden'))('get_run_state', { run_id: runId });
    const shown = await (await w.connect('shown'))('get_run_state', { run_id: runId });
    // (a) red when the marker is shaped (N becomes the marker's length); (b) prints both prompts.
    expect({ hidden: promptOf(hidden), shown: promptOf(shown) }).toEqual({
      hidden: `plain: ${NOT_KEPT}`,
      shown: `plain: ${NOT_KEPT}`,
    });
  });
});

describe("gap 2 (iv-a2-i), checks 3 and 5 — a gated step's instructions, and its stored question", () => {
  it('under hidden: gate.agent_hint shows the shape and is listed; the stored question and gate.display keep the words', async () => {
    const w = await world();
    // The gate opens on the door's own call, so its opening reply carries the hint.
    const runId = await w.failed(D.gated, undefined, false);
    const call = await w.connect('hidden');
    const opening = await call('advance_run', { run_id: runId });
    const state = await call('get_run_state', { run_id: runId });
    const gate = opening['gate'] as { agent_hint?: string; display?: string };
    const pending = state['pending_gate'] as { resolved_message?: string };
    // (a) red when gateInstructionsAt's render does not read the mark (the words show in the hint),
    //     when the opening gate's mark is missing (the path absent from the receipt), or when the
    //     question's mint reads the mark (the stored question loses its words); (b) prints the hint,
    //     the question and the receipt.
    expect({
      hint: gate.agent_hint,
      receipt: receiptOf(opening).shaped,
      display: gate.display,
      stored: pending.resolved_message,
    }).toEqual({
      hint: `From the workflow's author: Why: ${shape(MSG.length)}`,
      receipt: ['gate.agent_hint'],
      display: `Q: ${MSG}`,
      stored: `Q: ${MSG}`,
    });
  });
});

describe('gap 2 (iv-a2-i), check 4 — the value a condition read', () => {
  it('a false when: the message leaf shaped and listed; the failure_kind leaf as today', async () => {
    const w = await world();
    const runId = await w.failed(D.model);
    const state = await (await w.connect('hidden'))('get_run_state', { run_id: runId });
    const skip = state['skip_details'] as Record<
      string,
      { leaves: Array<{ resolved_value?: unknown }> }
    >;
    // (a) red when the condition values are not shaped, or when any `$settlement.` path is (the
    //     failure_kind leaf shows a shape); (b) prints both values and the receipt.
    expect({
      message: skip['whenMsg']?.leaves[0]?.resolved_value,
      kind: skip['whenKind']?.leaves[0]?.resolved_value,
      receipt: receiptOf(state).shaped,
    }).toEqual({
      message: shape(MODEL_MSG.length),
      kind: 'transient',
      receipt: expect.arrayContaining(['skip_details.whenMsg.leaves[0].resolved_value']),
    });
    expect(receiptOf(state).shaped).not.toContain('skip_details.whenKind.leaves[0].resolved_value');
  });

  it.each([
    ['the message', D.guardMsg, shape(MODEL_MSG.length), true],
    ['failure_kind', D.guardKind, 'transient', false],
  ] as const)(
    "a guard's abort_unless on %s: abort_context.conditions[0].resolved_value",
    async (_n, d, value, listed) => {
      const w = await world();
      const runId = await w.failed(d);
      const state = await (await w.connect('hidden'))('get_run_state', { run_id: runId });
      const abort = state['abort_context'] as { conditions: Array<{ resolved_value: unknown }> };
      // (a) red when a guard's condition value is not shaped (the message), or is on any
      //     `$settlement.` path (failure_kind); (b) prints the value and whether it is listed.
      expect({
        phase: state['run_phase'],
        value: abort.conditions[0]?.resolved_value,
        listed: receiptOf(state).shaped.includes('abort_context.conditions[0].resolved_value'),
      }).toEqual({ phase: 'aborted', value, listed });
    },
  );

  const refusal = (step: string, expression: string, value: string): string =>
    `Precondition failed for step '${step}'. Precondition failed: '${expression}'. Resolved value: ${value}.`;
  const MSG_EXPR = `$settlement.classify.message != "${MODEL_MSG}"`;
  const KIND_EXPR = '$settlement.classify.failure_kind != "transient"';

  it('a refused precondition on the message: the sentence rebuilt with the shape (the expression kept), N the value length; failure_kind as today', async () => {
    const w = await world();
    const runId = await w.failed(D.model);
    const call = await w.connect('hidden');
    const state = await call('get_run_state', { run_id: runId });
    const refused = await call('execute_step', { run_id: runId, command: 'preMsg', params: {} });
    const runnable = state['engine_runnable'] as Array<{
      step: string;
      refusal?: string;
      precondition?: { expression: string; value: string };
    }>;
    const byStep = Object.fromEntries(runnable.map((e) => [e.step, e]));
    // (a) red when the precondition's value is not shaped, when the sentence is parsed instead of
    //     rebuilt (the expression's quoted text changes too), when N is taken from the quoted JSON
    //     (off by the two quotes), or when any `$settlement.` path is shaped (failure_kind); (b)
    //     prints both entries, the reply's suggestion and the receipts.
    expect({
      msg: byStep['preMsg'],
      kind: byStep['preKind'],
      suggestion: (refused['blocked_reason'] as { suggestion?: string }).suggestion,
      stateReceipt: receiptOf(state).shaped,
      replyReceipt: receiptOf(refused).shaped,
    }).toEqual({
      msg: {
        step: 'preMsg',
        runnable_here: false,
        refused_by: 'precondition',
        refusal: refusal('preMsg', MSG_EXPR, shape(MODEL_MSG.length)),
        precondition: { expression: MSG_EXPR, value: shape(MODEL_MSG.length) },
      },
      kind: {
        step: 'preKind',
        runnable_here: false,
        refused_by: 'precondition',
        refusal: refusal('preKind', KIND_EXPR, '"transient"'),
        precondition: { expression: KIND_EXPR, value: '"transient"' },
      },
      suggestion: `Precondition failed: '${MSG_EXPR}'. Resolved value: ${shape(MODEL_MSG.length)}.`,
      stateReceipt: expect.arrayContaining([
        'engine_runnable[0].refusal',
        'engine_runnable[0].precondition.value',
      ]),
      replyReceipt: expect.arrayContaining(['blocked_reason.suggestion']),
    });
    expect(receiptOf(state).shaped).not.toContain('engine_runnable[1].refusal');
  });

  it("the refused step is the only one left: run_health's cannot_go_on and the reply's context_hint carry the shape, each listed", async () => {
    const w = await world();
    const runId = await w.failed(D.alone);
    const call = await w.connect('hidden');
    const state = await call('get_run_state', { run_id: runId });
    const advanced = await call('advance_run', { run_id: runId });
    const health = state['run_health'] as Array<{
      kind: string;
      evidence: { refused: Array<{ refusal: string; precondition: { value: string } }> };
    }>;
    const at = health.findIndex((f) => f.kind === 'cannot_go_on');
    const refused = health[at]?.evidence.refused[0];
    const shaped = refusal('preMsg', MSG_EXPR, shape(MODEL_MSG.length));
    // (a) red when cannot_go_on's refused facts are not swapped, or the reply's hint is composed
    //     from the record's sentence; (b) prints the finding's facts, the hint and the receipts.
    expect({
      refusal: refused?.refusal,
      value: refused?.precondition.value,
      stateReceipt: receiptOf(state).shaped,
      hintHolds: String(advanced['context_hint']).includes(shaped),
      hintWords: String(advanced['context_hint']).includes(`Resolved value: "${MODEL_MSG}"`),
      replyReceipt: receiptOf(advanced).shaped,
    }).toEqual({
      refusal: shaped,
      value: shape(MODEL_MSG.length),
      stateReceipt: expect.arrayContaining([
        `run_health[${at}].evidence.refused[0].refusal`,
        `run_health[${at}].evidence.refused[0].precondition.value`,
      ]),
      hintHolds: true,
      hintWords: false,
      replyReceipt: expect.arrayContaining(['context_hint']),
    });
  });

  it("an agent step's precondition on the message: agent_refused[0] carries the shape and is listed", async () => {
    const w = await world();
    const runId = await w.failed(D.agentPre);
    const state = await (await w.connect('hidden'))('get_run_state', { run_id: runId });
    const entry = (
      state['agent_refused'] as Array<{ refusal?: string; precondition?: { value: string } }>
    )[0];
    // (a) red when agent_refused's entries are not swapped (the words show); (b) prints the entry's
    //     sentence and value and the receipt.
    expect({
      refusal: entry?.refusal,
      value: entry?.precondition?.value,
      receipt: receiptOf(state).shaped,
    }).toEqual({
      refusal: refusal('explain', MSG_EXPR, shape(MODEL_MSG.length)),
      value: shape(MODEL_MSG.length),
      receipt: expect.arrayContaining([
        'agent_refused[0].refusal',
        'agent_refused[0].precondition.value',
      ]),
    });
  });

  it('a precondition that read a not-kept message: its sentence as today', async () => {
    const w = await world();
    const runId = await w.failed(D.marker);
    const state = await (await w.connect('hidden'))('get_run_state', { run_id: runId });
    const entry = (state['engine_runnable'] as Array<{ refusal?: string }>)[0];
    const expression = '$settlement.long.message == "x"';
    // (a) red when the marker is shaped (a false N); (b) prints the sentence.
    expect(entry?.refusal).toBe(refusal('preLong', expression, `"${NOT_KEPT}"`));
  });
});

describe('gap 2 (iv-a2-i), check 7 — one provider object behind a hidden and a shown server', () => {
  it("the hidden server's call first, then the shown server's: only the hidden one's prompt is shaped", async () => {
    const w = await world();
    const runId = await w.failed(D.prompt);
    const SET = buildDisclosureSet({
      env: {},
      declared: {},
      declaredState: 'resolved',
      audience: 'agent',
    }).set;
    const provider = async (): Promise<DisclosureSet> => SET;
    const hidden = await (await w.connect('hidden', provider))('get_run_state', { run_id: runId });
    const shown = await (await w.connect('shown', provider))('get_run_state', { run_id: runId });
    // (a) red when the mark is put on the provider's object (the shown server's prompt is shaped
    //     too); (b) prints both prompts' first lines.
    expect({
      hidden: promptOf(hidden)?.split('\n')[0],
      shown: promptOf(shown)?.split('\n')[0],
    }).toEqual({ hidden: `plain: ${shape(MSG.length)}`, shown: `plain: ${MSG}` });
  });
});

describe('gap 2 (iv-a2-i), check 8 — start_run_batch', () => {
  it("an item matching a failed run by its key: started[0].next_actions[0].prompt shaped and listed in the batch's receipt", async () => {
    const w = await world();
    await w.failed(D.prompt, 'k-iva2i');
    const batch = await (
      await w.connect('hidden')
    )('start_run_batch', {
      workflow_id: D.prompt.id,
      items: [{ params: {}, idempotency_key: 'k-iva2i' }],
    });
    const started = batch['started'] as Array<{ deduped?: boolean } & Reply>;
    // (a) red when the batch's ways are composed with a set the door did not mark (the words show),
    //     or its entries' marks are not collected (the path absent); (b) prints the prompt's first
    //     line and the receipt.
    expect({
      deduped: started[0]?.deduped,
      first: promptOf(started[0]!)?.split('\n')[0],
      receipt: receiptOf(batch),
    }).toEqual({
      deduped: true,
      first: `plain: ${shape(MSG.length)}`,
      receipt: { shaped: ['started[0].next_actions[0].prompt'], failure_text: 'withheld' },
    });
  });
});

describe("gap 2 (iv-a2-i), correction 1 — start_run_batch's hand-back hint for a run its key matched", () => {
  /** The batch's one entry for an item matching `runId` by its key, with the run's id kept apart. */
  const matched = async (d: WorkflowDefinition, failureText: 'shown' | 'hidden') => {
    const w = await world();
    const runId = await w.failed(d, 'k-c1', false);
    const batch = await (
      await w.connect(failureText)
    )('start_run_batch', {
      workflow_id: d.id,
      items: [{ params: {}, idempotency_key: 'k-c1' }],
    });
    const entry = (batch['started'] as Array<{ context_hint: string }>)[0]!;
    return { hint: entry.context_hint.split(runId).join('<run>'), receipt: receiptOf(batch) };
  };
  const hint = (step: string, expression: string, value: string): string =>
    `Matched existing run '<run>' (idempotent) in phase 'running'; no new run created. '${step}' cannot run (precondition): Precondition failed for step '${step}'. Precondition failed: '${expression}'. Resolved value: ${value}. Correct the workflow and register it again, then call advance_run; or end the run with abandon_run.`;
  const MSG_TIMEOUT = '$settlement.boom.message == "timeout"';

  it("under hidden: the refused step's precondition in the hint as core's shaped twin, the expression kept; the path listed", async () => {
    // (a) red when renderWaysOf composes from the unswapped facts (the words show, the path is
    //     absent), or when the batch does not add the path (the hint shaped, the path absent); (b)
    //     prints the hint and the receipt.
    expect(await matched(D.batchHint, 'hidden')).toEqual({
      hint: hint('report', MSG_TIMEOUT, shape(MSG.length)),
      receipt: { shaped: ['started[0].context_hint'], failure_text: 'withheld' },
    });
  });

  it('under shown: the hint as today, the words', async () => {
    // (a) red when a `shown` server's hint or receipt changes; (b) prints them.
    expect(await matched(D.batchHint, 'shown')).toEqual({
      hint: hint('report', MSG_TIMEOUT, `"${MSG}"`),
      receipt: { shaped: [], failure_text: undefined },
    });
  });

  it('a precondition on failure_kind: as today, no shape and no path', async () => {
    // (a) red when the swap is applied on any `$settlement.` path (the sibling shows a shape); (b)
    //     prints the hint and the receipt.
    expect(await matched(D.batchKind, 'hidden')).toEqual({
      hint: hint('report', '$settlement.classify.failure_kind == "x"', '"transient"'),
      receipt: { shaped: [], failure_text: undefined },
    });
  });
});
