// question-hidden-iva2ii.test.ts — gap 2, unit (iv-a2-ii): under `--failure-text hidden`, an approval
// question that read a failure's message (`$settlement.<step>.message`) reaches an assistant with the
// message as its length, `‹string, N characters›`, wherever the assistant reads the question: the
// opening reply's `gate.display`, the already-open reply's `gate.display`, and `get_run_state`'s
// `pending_gate.resolved_message`. The text is the question's twin, rendered in the same mint with each
// message shaped and stored beside the question (`resolved_message_shaped`); it is never on the wire.
// Each such path is listed in the receipt. On a store that does not declare `'pending_gate'`, a gate
// with no twin on a run with a failure message is shown whole as its shape. Under `shown`, every reply
// is as today, and the stored question keeps its words for people.
//
// The real server runs in process (`createRealmMcpServer` over `InMemoryTransport`) on runs failed by
// a real handler. Every assertion carries (a) the change that turns it red and (b) what it prints.
// Fake texts and fake secrets only.
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  advanceRun,
  buildDisclosureSet,
  type DisclosureSet,
  type LoadBearingRunRecordField,
  type PendingGate,
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
/** A handler's text over 500 characters: the record keeps `‹N characters, not kept›`. */
const LONG_RAW = 'word '.repeat(130).trim();
const NOT_KEPT = `‹${`Handler 'long' threw: ${LONG_RAW}`.length} characters, not kept›`;
/** A handler's text under 500 characters that, with the question's fixed text, passes the budget. */
const WIDE_RAW = 'wide '.repeat(88).trim();
const WIDE_MSG = `Handler 'wide' threw: ${WIDE_RAW}`;
/** A fake secret the host's set declares. */
const FAKE = 'CANARY-declared-iva2ii-0042-FAKE';
const shape = (n: number): string => `‹string, ${n} character${n === 1 ? '' : 's'}›`;
const F = 'context.resources.$settlement';
const QUESTION = [
  `plain: {{ ${F}.boom.message }}`,
  `cut: {{ ${F}.boom.message | truncate: 20 }}`,
  `dump: {{ ${F}.boom }}`,
].join('\n');

const def = (id: string, steps: Record<string, unknown>): WorkflowDefinition =>
  ({ id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps }) as never;
const BOOM = { description: 'Fail.', execution: 'auto', handler: 'boom', depends_on: [] };
/** A gated step that runs on `dep`'s failure (or, with `rule: 'all_success'`, on its success). */
const gated = (dep: string, message: string, rule = 'one_failed') => ({
  description: 'Review.',
  execution: 'auto',
  handler: 'ok',
  depends_on: [dep],
  trigger_rule: rule,
  trust: 'human_confirmed',
  gate: { choices: ['ok'], message },
});

const D = {
  ask: def('iva2ii-ask', { boom: BOOM, review: gated('boom', QUESTION) }),
  secret: def('iva2ii-secret', {
    boom: BOOM,
    review: gated(
      'boom',
      `token: {{ run.params.token }}\nshout: {{ run.params.token | upper }}\nwhy: {{ ${F}.boom.message }}`,
    ),
  }),
  noMessage: def('iva2ii-no-message', {
    boom: BOOM,
    review: gated('boom', 'Ship {{ run.params.name }}?'),
  }),
  defaulted: def('iva2ii-defaulted', {
    first: { description: 'Pass.', execution: 'auto', handler: 'ok', depends_on: [] },
    review: gated('first', `why: {{ ${F}.first.message | default: "none" }}`, 'all_success'),
  }),
  long: def('iva2ii-long', {
    long: { ...BOOM, handler: 'long' },
    review: gated('long', `why: {{ ${F}.long.message }}`),
  }),
  wide: def('iva2ii-wide', {
    wide: { ...BOOM, handler: 'wide' },
    review: gated(
      'wide',
      `${'Read the reason below before you choose. '.repeat(4)}why: {{ ${F}.wide.message }}`,
    ),
  }),
};

/** Handlers: `boom`, `long` and `wide` throw their texts, `ok` returns. */
function registry(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  const throwing = (id: string, text: string) =>
    r.register('handler', id, {
      id,
      execute: async () => {
        throw new Error(text);
      },
    } as never);
  throwing('boom', RAW);
  throwing('long', LONG_RAW);
  throwing('wide', WIDE_RAW);
  r.register('handler', 'ok', { id: 'ok', execute: async () => ({ data: { ok: true } }) } as never);
  return r;
}

type Reply = Record<string, unknown> & {
  gate?: { display?: string };
  pending_gate?: Record<string, unknown> & { resolved_message?: string };
  disclosure?: { shaped?: string[]; failure_text?: string };
};

/** The way the person block names for a question cut when it opened. */
const ROUTE = {
  render: (way: { verb: string }) => (way.verb === 'inspect' ? 'INSPECT' : null),
  source: { kind: 'default' as const, ref: 'question-hidden-iva2ii' },
};

/** A temp home's stores, a run store (an in-memory one unless given), and a server per setting. */
async function world(runStore: RunStore = new InMemoryStore()) {
  const h = await makeTempHome();
  homes.push(h);
  const reg = registry();
  for (const d of Object.values(D)) await h.stores.workflowStore.register(d);
  /** A run of `d` whose first step ran (and failed, for a throwing handler). With `byLibrary`, a
   *  library program (no set) then opens its gate; otherwise the door's own call does. */
  const run = async (
    d: WorkflowDefinition,
    params: Record<string, unknown> = {},
    byLibrary = false,
  ): Promise<string> => {
    const runId = (await runStore.create({ workflowId: d.id, workflowVersion: 1, params })).record
      .id;
    await advanceRun(runStore, d, { runId, registry: reg });
    if (byLibrary) await advanceRun(runStore, d, { runId, registry: reg });
    return runId;
  };
  const connect = async (
    failureText: 'shown' | 'hidden',
    provider?: () => Promise<DisclosureSet>,
  ) => {
    const server = createRealmMcpServer({
      ...h.stores,
      runStore,
      registry: reg,
      failureText,
      operatorRoute: ROUTE,
      ...(provider !== undefined ? { disclosureProvider: provider } : {}),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'question-hidden-iva2ii', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Reply & { person?: string }> => {
      const raw = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text?: string; annotations?: { audience?: string[] } }>;
      };
      const person = raw.content.find((c) => c.annotations?.audience?.includes('user'))?.text;
      return {
        ...(JSON.parse(raw.content[0]?.text ?? '{}') as Reply),
        ...(person !== undefined ? { person } : {}),
      };
    };
  };
  const stored = async (runId: string) => (await runStore.get(runId)).record.pending_gate;
  return { runStore, run, connect, stored };
}

/** The receipt's shaped paths and its failure-text word. */
const receiptOf = (reply: Reply) => ({
  shaped: reply.disclosure?.shaped ?? [],
  failure_text: reply.disclosure?.failure_text,
});

/** Opens the gate on the door's call and reads it: the opening reply and get_run_state. */
async function opened(
  w: Awaited<ReturnType<typeof world>>,
  d: WorkflowDefinition,
  failureText: 'shown' | 'hidden',
  options: { params?: Record<string, unknown>; provider?: () => Promise<DisclosureSet> } = {},
) {
  const runId = await w.run(d, options.params);
  const call = await w.connect(failureText, options.provider);
  const opening = await call('advance_run', { run_id: runId });
  const state = await call('get_run_state', { run_id: runId });
  return { runId, opening, state, stored: await w.stored(runId) };
}

const SHAPED_QUESTION = [
  `plain: ${shape(MSG.length)}`,
  `cut: ${shape(MSG.length)}`,
  'dump: {',
  '  "settled_by_default": false,',
  '  "validation_rejections": 0,',
  '  "failed": true,',
  `  "message": "${shape(MSG.length)}"`,
  '}',
].join('\n');
const WORDS_QUESTION = [
  `plain: ${MSG}`,
  "cut: Handler 'boom'…",
  'dump: {',
  '  "settled_by_default": false,',
  '  "validation_rejections": 0,',
  '  "failed": true,',
  `  "message": "${MSG}"`,
  '}',
].join('\n');

/** An in-memory store whose second opening settle of a gate finds the first one open: the
 *  already-open reply (D-1's `already_open` arm), which renders the stored gate. */
class SecondCaller extends InMemoryStore {
  override async settleStep(
    ...args: Parameters<InMemoryStore['settleStep']>
  ): ReturnType<InMemoryStore['settleStep']> {
    const first = await super.settleStep(...args);
    const delta = args[1];
    if (delta.kind !== 'open_gate') return first;
    return super.settleStep(
      args[0],
      { ...delta, pendingGate: { ...delta.pendingGate, gate_id: 'second-caller-gate' } },
      args[2],
    );
  }
}

describe('gap 2 (iv-a2-ii), check 1 — a question that reads the message', () => {
  it('under hidden: the opening gate.display and pending_gate.resolved_message show the shape, N the record length; each path listed; the record keeps both texts', async () => {
    const w = await world();
    const { opening, state, stored } = await opened(w, D.ask, 'hidden');
    // (a) red when the twin is not served (the words show), when the twin is made by editing the
    //     people's text (the cut words, or a filter's output, show), when a place is not swapped,
    //     or when a path is missing from the receipt; (b) prints both texts, both receipts and the
    //     stored texts.
    expect({
      opening: opening.gate?.display,
      openingReceipt: receiptOf(opening),
      state: state.pending_gate?.resolved_message,
      stateReceipt: receiptOf(state),
      stored: { people: stored?.resolved_message, twin: stored?.resolved_message_shaped },
    }).toEqual({
      opening: SHAPED_QUESTION,
      openingReceipt: { shaped: ['gate.display'], failure_text: 'withheld' },
      state: SHAPED_QUESTION,
      stateReceipt: {
        shaped: expect.arrayContaining(['pending_gate.resolved_message']),
        failure_text: 'withheld',
      },
      stored: { people: WORDS_QUESTION, twin: SHAPED_QUESTION },
    });
  });

  it('under hidden: the already-open reply shows the stored twin in gate.display, listed', async () => {
    const w = await world(new SecondCaller());
    const { opening } = await opened(w, D.ask, 'hidden');
    // (a) red when the already-open composer is not swapped (the words show) or its mark is
    //     missing (the path absent); (b) prints the reply's hint, display and receipt.
    expect({
      hint: opening['context_hint'],
      display: opening.gate?.display,
      receipt: receiptOf(opening),
    }).toEqual({
      hint: expect.stringContaining('Run is already paused at gate'),
      display: SHAPED_QUESTION,
      receipt: { shaped: ['gate.display'], failure_text: 'withheld' },
    });
  });

  it('under shown: the words in all three places, as today; no receipt path; the twin never on the wire', async () => {
    const w = await world();
    const { opening, state } = await opened(w, D.ask, 'shown');
    const again = await opened(await world(new SecondCaller()), D.ask, 'shown');
    // (a) red when a shown server serves the twin, lists a path, or get_run_state's pending_gate
    //     carries `resolved_message_shaped`; (b) prints the three texts, the receipts and the keys.
    expect({
      opening: opening.gate?.display,
      alreadyOpen: again.opening.gate?.display,
      state: state.pending_gate?.resolved_message,
      receipts: [receiptOf(opening), receiptOf(again.opening), receiptOf(state)],
      keys: Object.keys(state.pending_gate ?? {}),
    }).toEqual({
      opening: WORDS_QUESTION,
      alreadyOpen: WORDS_QUESTION,
      state: WORDS_QUESTION,
      receipts: [
        { shaped: [], failure_text: undefined },
        { shaped: [], failure_text: undefined },
        { shaped: [], failure_text: undefined },
      ],
      keys: ['gate_id', 'step_name', 'preview', 'choices', 'resolved_message', 'opened_at'],
    });
  });

  it('under hidden: get_run_state never carries the twin key either', async () => {
    const w = await world();
    const { state } = await opened(w, D.ask, 'hidden');
    // (a) red when the twin rides the wire under hidden; (b) prints the keys.
    expect(Object.keys(state.pending_gate ?? {})).toEqual([
      'gate_id',
      'step_name',
      'preview',
      'choices',
      'resolved_message',
      'opened_at',
    ]);
  });
});

describe("gap 2 (iv-a2-ii), check 1b — the twin's render is the people's render, the shaping aside", () => {
  it("under hidden, a question that reads the message and a secret the host's set knows: the twin hides the secret as the people's text does", async () => {
    const w = await world();
    const SET = buildDisclosureSet({
      env: {},
      declared: { TOKEN: FAKE },
      declaredState: 'resolved',
      audience: 'agent',
    }).set;
    const { state, stored } = await opened(w, D.secret, 'hidden', {
      params: { token: FAKE },
      provider: async () => SET,
    });
    const twin = state.pending_gate?.resolved_message ?? '';
    const holdsSecret = (text: string): boolean =>
      text.includes(FAKE) || text.includes(FAKE.toUpperCase());
    // The secret twice: whole (`token`), where the mint's mask over the whole text also hides it,
    // and through a filter (`shout`, `| upper`), where only the render's mask before the filter can:
    // the line the twin's own literal must give the host's set for.
    // (a) red when the twin's render is not given the host's set (the filtered secret shows in the
    //     twin), or differs from the people's in anything but the shaping; (b) prints both texts.
    expect({
      twinHoldsSecret: holdsSecret(twin),
      peopleHoldSecret: holdsSecret(stored?.resolved_message ?? ''),
      swappedBack: twin.split(shape(MSG.length)).join(MSG),
      people: stored?.resolved_message,
    }).toEqual({
      twinHoldsSecret: false,
      peopleHoldSecret: false,
      swappedBack: stored?.resolved_message,
      people: expect.stringContaining(`why: ${MSG}`),
    });
  });
});

describe('gap 2 (iv-a2-ii), check 3 — a question that reads no message', () => {
  it('on a run whose step failed: no twin; the question as stored under both settings, no path', async () => {
    const w = await world();
    const hidden = await opened(w, D.noMessage, 'hidden', { params: { name: 'v2' } });
    const shown = await opened(w, D.noMessage, 'shown', { params: { name: 'v2' } });
    // (a) red when a twin is stored for a question that substituted no message, or when the
    //     fallback is keyed on the record alone (this declaring store's gate is shaped); (b) prints
    //     the texts, the paths and the stored keys.
    expect({
      twin: 'resolved_message_shaped' in (hidden.stored ?? {}),
      hidden: [hidden.opening.gate?.display, hidden.state.pending_gate?.resolved_message],
      hiddenPaths: [...receiptOf(hidden.opening).shaped, ...receiptOf(hidden.state).shaped],
      shown: [shown.opening.gate?.display, shown.state.pending_gate?.resolved_message],
    }).toEqual({
      twin: false,
      hidden: ['Ship v2?', 'Ship v2?'],
      hiddenPaths: ['failures[0].message'],
      shown: ['Ship v2?', 'Ship v2?'],
    });
  });

  it('`| default: "none"` on a step that did not fail: no twin; the question as today', async () => {
    const w = await world();
    // The first step passes, so the run's own drive opens the gate (no failure stops it).
    const { state, stored } = await opened(w, D.defaulted, 'hidden');
    // (a) red when the twin is stored whenever the template mentions `$settlement`; (b) prints the
    //     stored question, whether a twin is stored, the text served and the paths.
    expect({
      people: stored?.resolved_message,
      twin: 'resolved_message_shaped' in (stored ?? {}),
      served: state.pending_gate?.resolved_message,
      paths: receiptOf(state).shaped,
    }).toEqual({ people: 'why: none', twin: false, served: 'why: none', paths: [] });
  });
});

describe('gap 2 (iv-a2-ii), check 4 — a message over 500 characters', () => {
  it('both texts read the not-kept marker; no twin; under hidden the question as stored', async () => {
    const w = await world();
    const { opening, state, stored } = await opened(w, D.long, 'hidden');
    // (a) red when the not-kept marker is shaped (a twin is stored, N the marker's length); (b)
    //     prints the texts and whether a twin is stored.
    expect({
      twin: 'resolved_message_shaped' in (stored ?? {}),
      texts: [
        stored?.resolved_message,
        opening.gate?.display,
        state.pending_gate?.resolved_message,
      ],
    }).toEqual({
      twin: false,
      texts: [`why: ${NOT_KEPT}`, `why: ${NOT_KEPT}`, `why: ${NOT_KEPT}`],
    });
  });
});

describe('gap 2 (iv-a2-ii), check 5 — a long question cut when it opened', () => {
  it("a long message: the people's text cut, the twin whole; under hidden no cut line beside the question, under shown the line", async () => {
    const SET = buildDisclosureSet({
      env: {},
      declared: {},
      declaredState: 'resolved',
      audience: 'agent',
    }).set;
    const provider = async (): Promise<DisclosureSet> => SET;
    const hidden = await opened(await world(), D.wide, 'hidden', { provider });
    const shown = await opened(await world(), D.wide, 'shown', { provider });
    const cutSentence = /\[Cut when this question opened: [^\]]*\]$/;
    // (a) red when the cut line is read from the people's question (the line shown beside the
    //     uncut twin), or the twin is cut as the people's text was; (b) prints whether each text
    //     ends with the cut sentence, the twin's tail and both person blocks.
    expect({
      peopleCut: cutSentence.test(hidden.stored?.resolved_message ?? ''),
      twinCut: cutSentence.test(hidden.stored?.resolved_message_shaped ?? ''),
      hiddenDisplay: hidden.opening.gate?.display === hidden.stored?.resolved_message_shaped,
      hiddenDisplayEnd: hidden.opening.gate?.display?.endsWith(`why: ${shape(WIDE_MSG.length)}`),
      hiddenPerson: hidden.opening.person,
      shownPerson: shown.opening.person,
    }).toEqual({
      peopleCut: true,
      twinCut: false,
      hiddenDisplay: true,
      hiddenDisplayEnd: true,
      hiddenPerson: undefined,
      shownPerson: expect.stringContaining('This question was cut when it opened.'),
    });
  });
});

/** A store that declares every field but `'pending_gate'` and rebuilds a stored gate from the keys
 *  it knows (it drops the twin), or, with `keepsAll`, declares nothing and keeps every key. */
function stubStore(keepsAll: boolean): RunStore {
  const KNOWN = ['gate_id', 'step_name', 'preview', 'choices', 'opened_at', 'resolved_message'];
  class Stub extends InMemoryStore {
    override async get(
      ...args: Parameters<InMemoryStore['get']>
    ): ReturnType<InMemoryStore['get']> {
      const snap = await super.get(...args);
      if (keepsAll || snap.record.pending_gate === undefined) return snap;
      const gate = Object.fromEntries(
        Object.entries(snap.record.pending_gate).filter(([k]) => KNOWN.includes(k)),
      ) as unknown as PendingGate;
      return { ...snap, record: { ...snap.record, pending_gate: gate } } as Awaited<
        ReturnType<InMemoryStore['get']>
      >;
    }
  }
  const store = new Stub();
  const fields = keepsAll
    ? undefined
    : (new Set(
        [...(store.persistedRunRecordFields ?? [])].filter((f) => f !== 'pending_gate'),
      ) as ReadonlySet<LoadBearingRunRecordField>);
  Object.defineProperty(store, 'persistedRunRecordFields', { value: fields });
  return store as RunStore;
}

describe("gap 2 (iv-a2-ii), check 7 — a store that does not declare 'pending_gate'", () => {
  it('a store that drops the twin, on a run with a failure message: the whole question as its shape, listed', async () => {
    const w = await world(stubStore(false));
    const { state, stored } = await opened(w, D.ask, 'hidden');
    // (a) red when the fallback is missing (the words show) or its path is not listed; (b) prints
    //     the text, the receipt and whether the store kept the twin.
    expect({
      kept: 'resolved_message_shaped' in (stored ?? {}),
      state: state.pending_gate?.resolved_message,
      receipt: receiptOf(state),
    }).toEqual({
      kept: false,
      state: shape(WORDS_QUESTION.length),
      receipt: {
        shaped: expect.arrayContaining(['pending_gate.resolved_message']),
        failure_text: 'withheld',
      },
    });
  });

  it('the same store, on a run with no failure message: the question as stored', async () => {
    const w = await world(stubStore(false));
    const { state } = await opened(w, D.defaulted, 'hidden');
    // (a) red when the fallback is keyed on the store alone (a run with no failure message is
    //     shaped); (b) prints the text and the paths.
    expect({
      state: state.pending_gate?.resolved_message,
      paths: receiptOf(state).shaped,
    }).toEqual({ state: 'why: none', paths: [] });
  });

  it('the same store, on a run whose only message is over 500 characters (not kept): the question as stored', async () => {
    const w = await world(stubStore(false));
    const { state } = await opened(w, D.long, 'hidden');
    // (a) red when the fallback counts the not-kept marker as a failure message (the question is
    //     shaped whole though no words were kept); (b) prints the text and the paths.
    expect({
      state: state.pending_gate?.resolved_message,
      paths: receiptOf(state).shaped.filter((p) => p.startsWith('pending_gate')),
    }).toEqual({ state: `why: ${NOT_KEPT}`, paths: [] });
  });

  it('a store that declares nothing and keeps every key: the twin served, as on a declaring store', async () => {
    const w = await world(stubStore(true));
    const { state } = await opened(w, D.ask, 'hidden');
    // (a) red when a twin on a non-declaring store is ignored (the whole question shaped); (b)
    //     prints the text.
    expect(state.pending_gate?.resolved_message).toBe(SHAPED_QUESTION);
  });
});

describe('gap 2 (iv-a2-ii), check 8 — a gate opened by a library program with no set', () => {
  it('the twin is made with the set that holds nothing, uncut; under hidden it is served', async () => {
    const w = await world();
    const runId = await w.run(D.ask, {}, true);
    const stored = await w.stored(runId);
    const state = await (await w.connect('hidden'))('get_run_state', { run_id: runId });
    // (a) red when no twin is made without a set (the words show under hidden); (b) prints the
    //     stored texts and the served one.
    expect({
      people: stored?.resolved_message,
      twin: stored?.resolved_message_shaped,
      served: state.pending_gate?.resolved_message,
    }).toEqual({ people: WORDS_QUESTION, twin: SHAPED_QUESTION, served: SHAPED_QUESTION });
  });
});
