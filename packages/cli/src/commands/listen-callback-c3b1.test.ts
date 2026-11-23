// listen-callback-c3b1.test.ts — R1.3 callback C3b1: what a caller sees of a callback before any is
// sent. (A) The backlog cap: while 1,000 callbacks are waiting, a request that names a callback
// address is refused `503 callback_backlog` before a run is made; the cap is judged after the address
// and the key, and never for a request without the header. (B) The read address: for a run that is no
// longer running, its `200` says how the run's callback stands (`state`, `attempts`, `last_status`,
// `next_try`), never its address, host or webhook id; a wait's `200` and `readReplyBody` do not gain
// it. Every cell runs a real listen server on loopback over the in-memory store
// (`test-support/listen-read-r11.ts`), with the rows put in their states through the callback store's
// own calls (create, claim, freezeBody, mark), and reads the status, the headers and the body as a
// caller sees them, and the lines the server logged.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  abandonRun,
  executeStep,
  type CallbackRegistration,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { parseCallbackEntry, type CallbackLists } from '../lib/callback/allow-list.js';
import { CALLBACK_BACKLOG_CAP } from '../lib/callback/door.js';
import {
  answerRead,
  PhaseCache,
  readEntriesOf,
  readPrefix,
  readReplyBody,
  type ReadContext,
} from '../lib/run-read-address.js';
import { runCount } from '../test-support/temp-home.js';
import {
  capturingLogger,
  emptySet,
  ENV,
  http,
  read,
  serve,
  sharedSecretTrigger,
  workflow,
  type Line,
  type Seen,
} from '../test-support/listen-read-r11.js';
import type { ListenDeps, SpawnResult } from './listen.js';

const W = 'refunds';
const PATH = '/refunds';
const MAP = { approved: 'context.resources.review.approved' };
const OPTED = workflow(W, sharedSecretTrigger(PATH, MAP));
const GUARDED = workflow(W, sharedSecretTrigger(PATH, MAP), {
  steps: {
    review: { description: 'Review.', execution: 'agent', depends_on: [] },
    stop: {
      description: 'Stop.',
      execution: 'guard',
      depends_on: ['review'],
      abort_unless: ['review.ok == true'],
      abort_message: 'Not approved.',
    },
  },
});
const GATED = workflow(W, sharedSecretTrigger(PATH, MAP), {
  steps: {
    review: {
      description: 'Review.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], message: 'Refund?' },
    },
  },
});
const HOOK = 'hooks.example.com';
const LABEL = 'hooks.example.com:443';
const URL_ = `https://${HOOK}/cb/x`;
const KEY = 'ab'.repeat(32);

const entry = (text: string) => {
  const parsed = parseCallbackEntry(text);
  if (!parsed.ok) throw new Error(`a test entry is refused: ${text}`);
  return parsed.entry;
};
const lists = (pub: string[]): CallbackLists => ({ public: pub.map(entry), private: [] });
const ALLOWED = lists([HOOK, 'nokey.example.com']);
const json = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;
const bearer = (code: string): string => `Bearer ${code}`;

/** A POST of `event`, with `url` in the callback header when given. */
function post(
  port: number,
  event: unknown,
  url?: string,
  more: Record<string, string> = {},
): Promise<Seen> {
  return http(
    port,
    'POST',
    PATH,
    {
      'content-type': 'application/json',
      'x-token': ENV['READ_SECRET']!,
      ...(url !== undefined ? { 'realm-callback-url': url } : {}),
      ...more,
    },
    JSON.stringify(event),
  );
}
/** The lines whose message begins `prefix`, as level, message and data. */
const linesOf = (lines: Line[], prefix: string) =>
  lines
    .filter((l) => l.msg.startsWith(prefix))
    .map((l) => ({ level: l.level, msg: l.msg, data: l.data }));

/** A server over `store` with the allowed lists, unless the cell gives others. */
function serveDoor(store: RunStore, over: Partial<ListenDeps> = {}, definitions = [OPTED]) {
  return serve(definitions, { store, over: { callbackLists: ALLOWED, ...over } });
}
/** An in-memory store with a readable key for (refunds, hooks.example.com:443). */
async function keyedStore(): Promise<InMemoryStore> {
  const store = new InMemoryStore();
  await store.callbacks!.keys.make(W, LABEL, KEY);
  return store;
}
/** A callback registration for `host`, with a fresh webhook id. */
const reg = (url = URL_, host = LABEL): CallbackRegistration => ({
  url,
  host,
  webhook_id: randomUUID(),
});
/** A run of refunds with a callback row (pending, never tried) when `callback` is given; its id. */
async function runWith(
  store: RunStore,
  callback: CallbackRegistration | undefined,
  definition: WorkflowDefinition = OPTED,
): Promise<string> {
  const { record } = await store.create({
    workflowId: definition.id,
    workflowVersion: definition.version,
    params: {},
    ...(callback !== undefined ? { callback } : {}),
  });
  return record.id;
}
/** `n` runs, each with a pending callback row. */
async function pendingRuns(store: RunStore, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) ids.push(await runWith(store, reg()));
  return ids;
}
/** C3d: `n` ended runs, each with a pending callback row: callbacks that wait to be sent. */
async function waitingRuns(store: RunStore, n: number): Promise<string[]> {
  const ids = await pendingRuns(store, n);
  for (const id of ids) await abandonRun(store, id);
  return ids;
}
/** Completes refunds' one step with `approved` (the run's result). */
const complete = (store: RunStore, runId: string, approved = true) =>
  executeStep(store, OPTED, {
    runId,
    command: 'review',
    input: { approved },
    dispatcher: async (_c, input) => input,
  });
/** Claims a finished run's row at its stored `next_attempt_at`: the token. */
async function claim(store: RunStore, runId: string, token = `tok-${runId}`): Promise<string> {
  const view = await store.callbacks!.read(runId);
  const c = await store.callbacks!.claim(runId, {
    expectedNextAttemptAt: view!.next_attempt_at,
    token,
  });
  if (!c.applied) throw new Error(`claim refused: ${c.reason}`);
  return token;
}
/** Ends a finished run's row delivered (200), after its body is frozen. */
async function deliver(store: RunStore, runId: string): Promise<void> {
  const token = await claim(store, runId);
  await store.callbacks!.freezeBody(runId, token, '{"run":"x"}');
  const m = await store.callbacks!.mark(runId, token, { kind: 'delivered', lastStatus: 200 });
  if (!m.applied) throw new Error(`mark refused: ${m.reason}`);
}
/** Ends a finished run's row failed with `lastStatus`. */
async function fail(store: RunStore, runId: string, lastStatus: 410 | 'expired'): Promise<void> {
  const m = await store.callbacks!.mark(runId, await claim(store, runId), {
    kind: 'failed',
    lastStatus,
  });
  if (!m.applied) throw new Error(`mark refused: ${m.reason}`);
}

describe('C3b1 — the cap, both sides of the line', { timeout: 120_000 }, () => {
  it('999 waiting: 202 registered; 1,000: 503 callback_backlog, connection kept, nothing made, one warn', async () => {
    const store = await keyedStore();
    await waitingRuns(store, CALLBACK_BACKLOG_CAP - 1);
    const s = await serveDoor(store);
    const below = await post(s.port, { id: 'evt-999' }, URL_);
    // C3d: the run evt-999 made ends, so its callback is the 1,000th waiting to be sent.
    await abandonRun(store, String(json(below.body)['run_id']));
    const runs = await runCount(store);
    const pending = await store.callbacks!.countPending();
    const at = await post(s.port, { id: 'evt-1000' }, URL_);
    // (1) red when the cap is `>` (1,000 passes), the cap is another number, the 503 closes the
    //     connection or makes a run or a row, or the warn line is missing or names more; (2) prints
    //     both replies, the counts and the lines.
    expect({
      cap: CALLBACK_BACKLOG_CAP,
      below: [below.status, json(below.body)['callback']],
      at: [at.status, at.body, at.headers['connection'], at.headers['retry-after']],
      made: [(await runCount(store)) - runs, pending, await store.callbacks!.countPending()],
      lines: linesOf(s.logger.lines, 'webhook: callback backlog'),
    }).toEqual({
      cap: 1000,
      below: [202, 'registered'],
      at: [503, '{"error":"callback_backlog"}', 'keep-alive', undefined],
      made: [0, 1000, 1000],
      lines: [
        {
          level: 'warn',
          msg: 'webhook: callback backlog full',
          data: { path: PATH, workflow: W, host: LABEL, waiting: 1000 },
        },
      ],
    });
  });

  it('only waiting rows count: 1,000 rows of which 450 are delivered and 50 failed is 202', async () => {
    const store = await keyedStore();
    const ids = await waitingRuns(store, CALLBACK_BACKLOG_CAP);
    for (const id of ids.slice(0, 450)) await deliver(store, id);
    for (const id of ids.slice(450, 500)) await fail(store, id, 410);
    const s = await serveDoor(store);
    const before = await store.callbacks!.countPending();
    const r = await post(s.port, { id: 'evt-half' }, URL_);
    // (1) red when the count takes every row (1,000: refused) or the delivered and failed ones;
    //     (2) prints the reply and the count before it.
    expect({
      before,
      reply: [r.status, json(r.body)['callback']],
      after: await store.callbacks!.countPending(),
    }).toEqual({ before: 500, reply: [202, 'registered'], after: 501 });
  });

  it('C3d: only ended runs count: 1,000 rows of running runs is 202, and so is 999 ended beside them', async () => {
    const store = await keyedStore();
    await pendingRuns(store, CALLBACK_BACKLOG_CAP);
    const s = await serveDoor(store);
    const running = await post(s.port, { id: 'evt-running' }, URL_);
    await waitingRuns(store, CALLBACK_BACKLOG_CAP - 1);
    const beside = await post(s.port, { id: 'evt-beside' }, URL_);
    // (1) red when the door counts every pending row (`countPending`: 1,000 running runs' rows are
    //     refused), or counts the running runs beside the ended ones; (2) prints both replies and the
    //     two counts.
    expect({
      running: [running.status, json(running.body)['callback']],
      beside: [beside.status, json(beside.body)['callback']],
      counts: {
        pending: await store.callbacks!.countPending(),
        waiting: await store.callbacks!.countWaiting(),
      },
    }).toEqual({
      running: [202, 'registered'],
      beside: [202, 'registered'],
      counts: { pending: 2001, waiting: 999 },
    });
  });
});

describe('C3b1 — what the cap does not touch', { timeout: 120_000 }, () => {
  it('at 1,000: no header is 202 with no count; a refused address, a host with no key and no lists keep their 400; a repeat step 8 answers is 200', async () => {
    const store = await keyedStore();
    await waitingRuns(store, CALLBACK_BACKLOG_CAP - 1);
    const s = await serveDoor(store);
    const first = await post(s.port, { id: 'evt-dup' }, URL_);
    // C3d: evt-dup's run is still running, so one more ended run brings the waiting rows to 1,000.
    await waitingRuns(store, 1);
    const count = vi.spyOn(store.callbacks!, 'countWaiting');
    const none = await post(s.port, { id: 'evt-none' });
    const countedForNone = count.mock.calls.length;
    const refused = await post(s.port, { id: 'evt-bad' }, 'https://other.example.com/x');
    const noKey = await post(s.port, { id: 'evt-nokey' }, 'https://nokey.example.com/x');
    const repeat = json((await post(s.port, { id: 'evt-dup' }, URL_)).body);
    const off = await serveDoor(store, { callbackLists: lists([]) });
    const notEnabled = await post(off.port, { id: 'evt-off' }, URL_);
    // (1) red when the count comes before the address or the key (each 400 is then 503), when every
    //     request is counted (the request without the header is refused or counted), or when a
    //     repeat step 8 answers is counted; (2) prints each reply and the count.
    expect({
      pending: await store.callbacks!.countPending(),
      first: first.status,
      none: [none.status, countedForNone],
      refused: [refused.status, refused.body],
      noKey: [noKey.status, noKey.body],
      notEnabled: [notEnabled.status, notEnabled.body],
      repeat: [
        repeat['status'],
        repeat['run_id'] === json(first.body)['run_id'],
        repeat['callback'],
      ],
    }).toEqual({
      pending: 1001,
      first: 202,
      none: [202, 0],
      refused: [400, '{"error":"callback_refused","reason":"not_allowed"}'],
      noKey: [400, '{"error":"callback_refused","reason":"no_key"}'],
      notEnabled: [400, '{"error":"callback_not_enabled"}'],
      repeat: ['deduplicated', true, 'ignored_duplicate'],
    });
  });

  it('a count that throws: 500 store_error, one error line, nothing made', async () => {
    const store = await keyedStore();
    vi.spyOn(store.callbacks!, 'countWaiting').mockRejectedValue(new Error('disk gone'));
    const s = await serveDoor(store);
    const r = await post(s.port, { id: 'evt-broken' }, URL_);
    // (1) red when the throw escapes the door (another reply or line) or a run is made; (2) prints the
    //     reply, the run count and the lines.
    expect({
      reply: [r.status, r.body, r.headers['connection']],
      runs: await runCount(store),
      lines: linesOf(s.logger.lines, 'webhook: callback backlog'),
    }).toEqual({
      reply: [500, '{"error":"store_error","status":"failed"}', 'keep-alive'],
      runs: 0,
      lines: [
        {
          level: 'error',
          msg: 'webhook: callback backlog could not be counted',
          data: { path: PATH, workflow: W, host: LABEL, error: 'Error: disk gone' },
        },
      ],
    });
  });
});

describe('C3b1 — the read address says how the callback stands', { timeout: 120_000 }, () => {
  it('every state: pending never tried, retried, delivered, expired, a failed, aborted or abandoned run, no row, a gate-waiting and a running run', async () => {
    const store = new InMemoryStore();
    const neverTried = await runWith(store, reg());
    await complete(store, neverTried);
    const retried = await runWith(store, reg());
    await complete(store, retried);
    const token = await claim(store, retried);
    await store.callbacks!.mark(retried, token, {
      kind: 'retry',
      afterSeconds: 300,
      lastStatus: 503,
    });
    const delivered = await runWith(store, reg());
    await complete(store, delivered);
    await deliver(store, delivered);
    const expired = await runWith(store, reg());
    await complete(store, expired);
    await fail(store, expired, 'expired');
    const failed = await runWith(store, reg());
    await executeStep(store, OPTED, {
      runId: failed,
      command: 'review',
      input: {},
      dispatcher: async () => {
        throw new Error('the model went away');
      },
    }).catch(() => undefined);
    const aborted = await runWith(store, reg(), GUARDED);
    await executeStep(store, GUARDED, {
      runId: aborted,
      command: 'review',
      input: { ok: false },
      dispatcher: async (_c, input) => input,
    });
    await executeStep(store, GUARDED, {
      runId: aborted,
      command: 'stop',
      input: {},
      dispatcher: async () => ({}),
    }).catch(() => undefined);
    const abandoned = await runWith(store, reg());
    await abandonRun(store, abandoned);
    const noRow = await runWith(store, undefined);
    await complete(store, noRow);
    const waiting = await runWith(store, reg(), GATED);
    await executeStep(store, GATED, {
      runId: waiting,
      command: 'review',
      input: {},
      dispatcher: async () => ({ summary: 'Refund 20 EUR?' }),
    });
    const running = await runWith(store, reg());
    const view = async (id: string) => (await store.callbacks!.read(id))!;
    const s = await serve([OPTED], { store });
    const get = vi.spyOn(store, 'get');
    const field = async (id: string) => {
      const r = await read(s.port, PATH, id, bearer(s.code(PATH, id)));
      const body = json(r.body);
      return { status: r.status, phase: body['run_phase'], callback: body['callback'] };
    };
    const seen = {
      neverTried: await field(neverTried),
      retried: await field(retried),
      delivered: await field(delivered),
      expired: await field(expired),
      failed: await field(failed),
      aborted: await field(aborted),
      abandoned: await field(abandoned),
      noRow: await field(noRow),
      gateWaiting: await field(waiting),
    };
    const readsBefore = get.mock.calls.length;
    const runningFirst = await field(running);
    const runningSecond = await field(running);
    // (1) red when a running or gate-waiting run gets the field (a running run on its store read or
    //     its cache hit), a delivered or
    //     failed row keeps `next_try`, a pending row has none, `last_status` shows before a try, a
    //     member is renamed, or the view is spread (its host, workflow_id and created_at show);
    //     (2) prints each read's status, phase and field, and how many store reads the two running
    //     reads made.
    expect({
      ...seen,
      runningFirst,
      runningSecond,
      runningStoreReads: get.mock.calls.length - readsBefore,
    }).toEqual({
      neverTried: {
        status: 200,
        phase: 'completed',
        callback: {
          state: 'pending',
          attempts: 0,
          next_try: (await view(neverTried)).next_attempt_at,
        },
      },
      retried: {
        status: 200,
        phase: 'completed',
        callback: {
          state: 'pending',
          attempts: 1,
          last_status: 503,
          next_try: (await view(retried)).next_attempt_at,
        },
      },
      delivered: {
        status: 200,
        phase: 'completed',
        callback: { state: 'delivered', attempts: 1, last_status: 200 },
      },
      expired: {
        status: 200,
        phase: 'completed',
        callback: { state: 'failed', attempts: 1, last_status: 'expired' },
      },
      failed: {
        status: 200,
        phase: 'failed',
        callback: { state: 'pending', attempts: 0, next_try: (await view(failed)).next_attempt_at },
      },
      aborted: {
        status: 200,
        phase: 'aborted',
        callback: {
          state: 'pending',
          attempts: 0,
          next_try: (await view(aborted)).next_attempt_at,
        },
      },
      abandoned: {
        status: 200,
        phase: 'abandoned',
        callback: {
          state: 'pending',
          attempts: 0,
          next_try: (await view(abandoned)).next_attempt_at,
        },
      },
      noRow: { status: 200, phase: 'completed', callback: undefined },
      gateWaiting: { status: 200, phase: 'gate_waiting', callback: undefined },
      runningFirst: { status: 200, phase: 'running', callback: undefined },
      runningSecond: { status: 200, phase: 'running', callback: undefined },
      runningStoreReads: 1,
    });
  });
});

/** A server that answers reads with `answerRead` over `ctx` alone (no listen handler). */
async function readServer(ctx: ReadContext): Promise<number> {
  const server: Server = createServer((req, res) => {
    const runId = (req.url ?? '').split('/').pop() ?? '';
    void answerRead(req, res, { prefix: readPrefix(PATH), runId }, ctx);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

describe('C3b1 — nothing leaks, nothing else changes', { timeout: 120_000 }, () => {
  it('the address, host and webhook id are in no reply and no line the read path logs; the rest of the body is readReplyBody’s', async () => {
    const store = new InMemoryStore();
    const canaryUrl = 'https://canaryhost-c3b1.example.com/CANARYc3b1path?q=CANARYc3b1q';
    const canaryReg = reg(canaryUrl, 'canaryhost-c3b1.example.com:443');
    const withRow = await runWith(store, canaryReg);
    await complete(store, withRow);
    const noRow = await runWith(store, undefined);
    await complete(store, noRow);
    const s = await serve([OPTED], { store });
    const routeEntry = s.routes.get(PATH)!;
    // The server's disclosure set: serve's default provider gives the empty set.
    const ctx = { disclosureProvider: async () => emptySet() };
    const rowRead = await read(s.port, PATH, withRow, bearer(s.code(PATH, withRow)));
    const noRowRead = await read(s.port, PATH, noRow, bearer(s.code(PATH, noRow)));
    vi.spyOn(store.callbacks!, 'read').mockRejectedValueOnce(new Error('row unreadable'));
    const failedRead = await read(s.port, PATH, withRow, bearer(s.code(PATH, withRow)));
    const canaries = ['canaryhost-c3b1', 'CANARYc3b1path', 'CANARYc3b1q', canaryReg.webhook_id];
    const all = rowRead.body + noRowRead.body + failedRead.body + JSON.stringify(s.logger.lines);
    const { callback: _field, ...rest } = json(rowRead.body);
    // (1) red when a reply or a logged line holds the address, the host or the webhook id, or the
    //     field changes any other member of the body (the run with no row is then not
    //     byte-identical to `readReplyBody`'s body); (2) prints what leaked and the bodies.
    expect({
      instrument: canaries.slice(0, 3).every((c) => canaryUrl.includes(c)),
      leaked: canaries.filter((c) => all.includes(c)),
      noRow:
        noRowRead.body ===
        JSON.stringify(await readReplyBody(routeEntry, (await store.get(noRow)).record, ctx)),
      rest:
        JSON.stringify(rest) ===
        JSON.stringify(await readReplyBody(routeEntry, (await store.get(withRow)).record, ctx)),
      linesLogged: s.logger.lines.filter((l) => l.msg.startsWith('webhook: callback view')).length,
    }).toEqual({ instrument: true, leaked: [], noRow: true, rest: true, linesLogged: 1 });
  });

  it('readReplyBody, called with the context answerRead reads the field from, has no callback; a wait’s 200 has none', async () => {
    const store = new InMemoryStore();
    const runId = await runWith(store, reg());
    await complete(store, runId);
    const s = await serve([OPTED], { store });
    const logger = capturingLogger();
    const ctx: ReadContext = {
      entries: readEntriesOf(s.routes.values()),
      get: (id) => store.get(id),
      disclosureProvider: async () => emptySet(),
      logger,
      cache: new PhaseCache(),
      callbacks: store.callbacks!,
    };
    const port = await readServer(ctx);
    const viaAnswer = json((await read(port, PATH, runId, bearer(s.code(PATH, runId)))).body);
    const direct = await readReplyBody(s.routes.get(PATH)!, (await store.get(runId)).record, ctx);
    // The wait: an agent that completes the run 50 ms after it is spawned, then exits.
    // Q1 (#592) unit c: `exited` gives how the process ended (a code: never marked).
    const waitStore = await keyedStore();
    const agent = vi.fn(async (id: string): Promise<SpawnResult> => {
      const exited = new Promise<void>((resolve) => setTimeout(resolve, 50))
        .then(() => complete(waitStore, id))
        .then(
          () => ({ code: 0, signal: null }),
          () => ({ code: 0, signal: null }),
        );
      return { pid: 4242, exited };
    });
    const w = await serveDoor(waitStore, { spawnAgent: agent });
    const waited = await post(w.port, { id: 'evt-wait' }, URL_, { prefer: 'wait=20' });
    const waitedBody = json(waited.body);
    const waitedId = String(waitedBody['run_id']);
    const got = json((await read(w.port, PATH, waitedId, bearer(w.code(PATH, waitedId)))).body);
    // (1) red when readReplyBody reads `ctx.callbacks` (the direct call gains the field), or a wait's
    //     200 gains it; (2) prints whether each body has the field.
    expect({
      viaAnswer: 'callback' in viaAnswer,
      direct: 'callback' in direct,
      waited: [waited.status, waitedBody['run_phase'], 'callback' in waitedBody],
      got: 'callback' in got,
    }).toEqual({ viaAnswer: true, direct: false, waited: [200, 'completed', false], got: true });
  });
});

describe('C3b1 — a broken callback view never breaks a read', { timeout: 120_000 }, () => {
  it('a read that throws: 200 with the result and no field, one error line; no callbacks member, or a store with none: no field', async () => {
    const store = new InMemoryStore();
    const runId = await runWith(store, reg());
    await complete(store, runId);
    const s = await serve([OPTED], { store });
    vi.spyOn(store.callbacks!, 'read').mockRejectedValue(new Error('row unreadable'));
    const broken = await read(s.port, PATH, runId, bearer(s.code(PATH, runId)));
    const quiet = capturingLogger();
    const ctx: ReadContext = {
      entries: readEntriesOf(s.routes.values()),
      get: (id) => store.get(id),
      disclosureProvider: async () => emptySet(),
      logger: quiet,
      cache: new PhaseCache(),
    };
    const port = await readServer(ctx);
    const noMember = json((await read(port, PATH, runId, bearer(s.code(PATH, runId)))).body);
    const nullStore = new InMemoryStore({ callbacks: null });
    const nullRun = await runWith(nullStore, undefined);
    await complete(nullStore, nullRun);
    const n = await serve([OPTED], { store: nullStore });
    const nullBody = json((await read(n.port, PATH, nullRun, bearer(n.code(PATH, nullRun)))).body);
    // (1) red when a read that throws is answered 503 (or loses the result), logs nothing or more,
    //     or a context without the member, or a store with no callback store, gets a field or logs;
    //     (2) prints each reply and the lines.
    expect({
      broken: [broken.status, json(broken.body)['result'], 'callback' in json(broken.body)],
      lines: linesOf(s.logger.lines, 'webhook: callback view'),
      noMember: ['callback' in noMember, quiet.lines],
      nullStore: [
        nullBody['run_phase'],
        'callback' in nullBody,
        n.logger.lines.filter((l) => l.level === 'error'),
      ],
    }).toEqual({
      broken: [200, { approved: true }, false],
      lines: [
        {
          level: 'error',
          msg: 'webhook: callback view could not be read',
          data: { path: `${PATH}/runs/${runId}`, run_id: runId, error: 'Error: row unreadable' },
        },
      ],
      noMember: [false, []],
      nullStore: ['completed', false, []],
    });
  });
});
