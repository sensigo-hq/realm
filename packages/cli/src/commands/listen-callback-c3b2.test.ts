// listen-callback-c3b2.test.ts — R1.3 callback C3b2 (the runner): `realm listen` runs C3a's delivery
// pass. A real listen server on loopback over the in-memory store (`test-support/listen-read-r11.ts`),
// a fake agent start whose exit the cell decides, and real loopback receivers. The pass is woken when
// an agent this process started exits, and every 30 seconds; never at the bind; and only with an
// allow-list flag and a store that keeps callbacks. The shutdown cell is in
// `listen-reminders-d3b.test.ts` (its Slack double and rig are local to it).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { executeStep, type RunStore } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { parseCallbackEntry, type CallbackLists } from '../lib/callback/allow-list.js';
import { InMemoryDedupStore } from '../lib/dedup-store.js';
import {
  capturingLogger,
  emptySet,
  ENV,
  http,
  serve,
  sharedSecretTrigger,
  workflow,
  type Line,
} from '../test-support/listen-read-r11.js';
import {
  buildRouteTable,
  CALLBACK_POLL_MS,
  makeListenHandler,
  type ListenDeps,
  type SpawnResult,
} from './listen.js';

const W = 'refunds';
const PATH = '/refunds';
const OPTED = workflow(
  W,
  sharedSecretTrigger(PATH, { approved: 'context.resources.review.approved' }),
);
const KEY = '3c'.repeat(32);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Waits, on the real clock, until `cond` holds; the message names what never happened. */
const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const by = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > by) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
/** A real-time pause: a window in which something must NOT happen. */
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const entry = (text: string) => {
  const r = parseCallbackEntry(text);
  if (!r.ok) throw new Error(`fixture: ${text} refused ${r.word}`);
  return r.entry;
};

interface Post {
  readonly headers: IncomingHttpHeaders;
  readonly path: string;
  readonly body: string;
}

/** A receiver on 127.0.0.1 that answers 200 to every POST; its label, address and private list. */
async function receiver() {
  const posts: Post[] = [];
  const handler: RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      posts.push({
        headers: req.headers,
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200);
      res.end();
    });
  };
  const server = createServer(handler);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  onTestFinished(
    () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  const port = (server.address() as AddressInfo).port;
  const host = `127.0.0.1:${port}`;
  const lists: CallbackLists = { public: [], private: [entry(`http://${host}`)] };
  return { posts, host, url: `http://${host}/cb`, lists };
}

/** The signature `key` makes for `post`, computed apart with node:crypto. */
const signedBy = (key: string, post: Post): string =>
  `v1,${createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(`${post.headers['webhook-id']}.${post.headers['webhook-timestamp']}.${post.body}`)
    .digest('base64')}`;

/** A fake agent start: every start succeeds, and its process exits when the cell says. */
function agents() {
  const exits = new Map<string, () => void>();
  const spawnAgent = vi.fn(async (runId: string): Promise<SpawnResult> => ({
    pid: 4242,
    exited: new Promise<void>((r) => exits.set(runId, r)),
  }));
  const exit = (runId: string): void => {
    const done = exits.get(runId);
    if (done === undefined) throw new Error(`fixture: no agent started for ${runId}`);
    done();
  };
  return { spawnAgent, exit, started: () => spawnAgent.mock.calls.length };
}

/** A POST of `id`, naming `url` as the callback address when given; its status and run id. */
async function start(port: number, id: string, url?: string) {
  const r = await http(
    port,
    'POST',
    PATH,
    {
      'content-type': 'application/json',
      'x-token': ENV['READ_SECRET']!,
      ...(url !== undefined ? { 'realm-callback-url': url } : {}),
    },
    JSON.stringify({ id }),
  );
  const body = JSON.parse(r.body) as { run_id: string; callback?: string };
  return { status: r.status, runId: body.run_id, callback: body.callback };
}

/** Completes the run's one step, as its agent would. */
const complete = (store: RunStore, runId: string) =>
  executeStep(store, OPTED, {
    runId,
    command: 'review',
    input: { approved: true },
    dispatcher: async (_c, input) => input,
  });

/** A completed run of `refunds` with a callback row to `url`, made without the door (another process). */
async function finishedElsewhere(store: RunStore, url: string, host: string): Promise<string> {
  const { record } = await store.create({
    workflowId: W,
    workflowVersion: 1,
    params: {},
    callback: { url, host, webhook_id: randomUUID() },
  });
  await complete(store, record.id);
  return record.id;
}

/** The lines the pass said (the `listen: callbacks:` prefix), as `level message`. */
const passLines = (lines: Line[]): string[] =>
  lines.filter((l) => l.msg.startsWith('listen: callbacks:')).map((l) => `${l.level} ${l.msg}`);

describe('callback C3b2 — `realm listen` runs the delivery pass', { timeout: 60_000 }, () => {
  it('the wake: an agent this process started exits, and its run’s callback goes out at once (the period is 30 s), signed, ending delivered', async () => {
    const store = new InMemoryStore();
    const rcv = await receiver();
    await store.callbacks!.keys.make(W, rcv.host, KEY);
    const a = agents();
    const s = await serve([OPTED], {
      store,
      over: { callbackLists: rcv.lists, spawnAgent: a.spawnAgent },
    });
    const r = await start(s.port, 'evt-wake', rcv.url);
    await complete(store, r.runId);
    const exited = Date.now();
    a.exit(r.runId);
    await until(() => rcv.posts.length >= 1, 'the callback POST after the agent exited', 2_000);
    const took = Date.now() - exited;
    await until(
      async () => (await store.callbacks!.read(r.runId))?.status === 'delivered',
      'the row to end delivered',
    );
    await pause(200);
    // (1) red when nothing wakes the sender on an agent's exit (the POST waits for the 30-second tick,
    //     and the wait above times out at 2 s), when the address or the key is not the stored one, the
    //     workflow is looked up by its path (`/refunds`, not the id: no POST), the body is built with
    //     another disclosure set than the server's own (no call of it: nothing else here reads the
    //     run), or the line lacks the `listen: ` prefix; (2) prints the reply, the POST, the row, the
    //     disclosure calls and the lines.
    expect({
      reply: { status: r.status, callback: r.callback },
      disclosureCalls: s.provider.mock.calls.length,
      posts: rcv.posts.length,
      path: rcv.posts[0]!.path,
      signed: rcv.posts[0]!.headers['webhook-signature'] === signedBy(KEY, rcv.posts[0]!),
      type: (JSON.parse(rcv.posts[0]!.body) as { type: string }).type,
      within2s: took < 2_000,
      row: (await store.callbacks!.read(r.runId))?.status,
      lines: passLines(s.logger.lines),
    }).toEqual({
      reply: { status: 202, callback: 'registered' },
      disclosureCalls: 1,
      posts: 1,
      path: '/cb',
      signed: true,
      type: 'run.finished',
      within2s: true,
      row: 'delivered',
      lines: [`info listen: callbacks: ${W} → ${rcv.host}: delivered (attempt 1)`],
    });
  });

  it('the period: a run another process finished goes out at the 30-second tick, not at 29,999 ms', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const store = new InMemoryStore();
    const rcv = await receiver();
    await store.callbacks!.keys.make(W, rcv.host, KEY);
    const runId = await finishedElsewhere(store, rcv.url, rcv.host);
    const s = await serve([OPTED], { store, over: { callbackLists: rcv.lists } });
    vi.advanceTimersByTime(CALLBACK_POLL_MS - 1);
    await pause(500);
    const before = rcv.posts.length;
    vi.advanceTimersByTime(1);
    await until(() => rcv.posts.length >= 1, 'the POST at the tick');
    await until(
      async () => (await store.callbacks!.read(runId))?.status === 'delivered',
      'the row to end delivered',
    );
    // (1) red when the period is longer than 30 s (nothing at the tick: the wait times out), shorter
    //     or the bind wakes the sender (a POST before the tick); (2) prints both counts and the lines.
    expect({
      period: CALLBACK_POLL_MS,
      before,
      after: rcv.posts.length,
      lines: passLines(s.logger.lines),
    }).toEqual({
      period: 30_000,
      before: 0,
      after: 1,
      lines: [`info listen: callbacks: ${W} → ${rcv.host}: delivered (attempt 1)`],
    });
  });

  it('no wake at the bind: a row due when the server starts is not sent, and no line is said, until an agent exits', async () => {
    const store = new InMemoryStore();
    const rcv = await receiver();
    await store.callbacks!.keys.make(W, rcv.host, KEY);
    const due = await finishedElsewhere(store, rcv.url, rcv.host);
    const a = agents();
    const s = await serve([OPTED], {
      store,
      over: { callbackLists: rcv.lists, spawnAgent: a.spawnAgent },
    });
    const atStart = passLines(s.logger.lines).length;
    await pause(600);
    const window = { posts: rcv.posts.length, lines: passLines(s.logger.lines).length };
    // The positive control: the same row goes out once an agent exits (so the row was due all along).
    const r = await start(s.port, 'evt-later');
    a.exit(r.runId);
    await until(() => rcv.posts.length >= 1, 'the due row to go out after the agent exited');
    await until(
      async () => (await store.callbacks!.read(due))?.status === 'delivered',
      'the row to end delivered',
    );
    // (1) red when the sender is woken at the bind (a POST within about 15 ms of the start, and its
    //     line before the action prints the start lines); (2) prints the counts in the window.
    expect({ atStart, window, after: rcv.posts.length }).toEqual({
      atStart: 0,
      window: { posts: 0, lines: 0 },
      after: 1,
    });
  });

  it('off means off: no allow-list flag, or a store without callbacks, gives no timer, no pass and no key read; the lines are the base’s', async () => {
    const rcv = await receiver();
    // (a) No flag. A finished run with a due callback row is in the store, so a sender built anyway
    //     would read its key and send it.
    const store = new InMemoryStore();
    await store.callbacks!.keys.make(W, rcv.host, KEY);
    await finishedElsewhere(store, rcv.url, rcv.host);
    const keyReads = vi.spyOn(store.callbacks!.keys, 'read');
    const listings = vi.spyOn(store.callbacks!, 'due');
    const timers = vi.spyOn(globalThis, 'setInterval');
    const a = agents();
    const s = await serve([OPTED], { store, over: { spawnAgent: a.spawnAgent } });
    const r = await start(s.port, 'evt-off');
    a.exit(r.runId);
    await pause(500);
    const noFlag = {
      timer: timers.mock.calls.some(([, ms]) => ms === CALLBACK_POLL_MS),
      keyReads: keyReads.mock.calls.length,
      listings: listings.mock.calls.length,
      posts: rcv.posts.length,
      lines: s.logger.lines.map((l) => `${l.level} ${l.msg}`),
    };
    // (b) A flag, and a store that keeps no callbacks.
    const none = new InMemoryStore({ callbacks: null });
    const b = agents();
    const t = await serve([OPTED], {
      store: none,
      over: { callbackLists: rcv.lists, spawnAgent: b.spawnAgent },
    });
    const r2 = await start(t.port, 'evt-null');
    b.exit(r2.runId);
    await pause(300);
    // (c) A flag, and a store that has no `callbacks` member at all (a store from before the callback).
    const plain = new InMemoryStore();
    const bare = new Proxy(plain, {
      get(target, prop, receiver) {
        if (prop === 'callbacks') return undefined;
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const c = agents();
    const u = await serve([OPTED], {
      store: bare,
      over: { callbackLists: rcv.lists, spawnAgent: c.spawnAgent },
    });
    const r3 = await start(u.port, 'evt-undefined');
    c.exit(r3.runId);
    await pause(300);
    // (1) red when the sender is built without the flag condition, or over a store whose
    //     `callbacks` is null or absent (each condition its own server, each server's timer counted);
    //     the line list is the same one the base prints (this cell passes unchanged on the base, the
    //     red-first log shows); (2) prints the counts and the lines.
    const callbackTimers = (): number =>
      timers.mock.calls.filter(([, ms]) => ms === CALLBACK_POLL_MS).length;
    expect({
      noFlag,
      nullStore: { timers: callbackTimers(), lines: passLines(t.logger.lines) },
      noMember: { lines: passLines(u.logger.lines) },
    }).toEqual({
      noFlag: {
        timer: false,
        keyReads: 0,
        listings: 0,
        posts: 0,
        lines: ['info listen: mounted', 'info webhook: dispatched'],
      },
      nullStore: { timers: 0, lines: [] },
      noMember: { lines: [] },
    });
  });

  it('its own port: with `--port 0` a callback to the server’s own address is never sent to it; the row records `refused_address`', async () => {
    const store = new InMemoryStore();
    const lists: CallbackLists = { public: [], private: [] };
    const a = agents();
    const s = await serve([OPTED], {
      store,
      over: { callbackLists: lists, spawnAgent: a.spawnAgent },
    });
    // The port is known only after the bind: the entry joins the very lists the sender holds.
    const self = `127.0.0.1:${s.port}`;
    (lists.private as ReturnType<typeof entry>[]).push(entry(`http://${self}`));
    await store.callbacks!.keys.make(W, self, KEY);
    const r = await start(s.port, 'evt-self', `http://${self}/cb`);
    await complete(store, r.runId);
    a.exit(r.runId);
    await until(
      async () => ((await store.callbacks!.read(r.runId))?.attempts ?? 0) >= 1,
      'the first try to be recorded',
    );
    const view = await store.callbacks!.read(r.runId);
    // (1) red when the own port is taken from the options (0): the try reaches this server's own
    //     handler (a refused `/cb` line) and records its 403; (2) prints the reply, the row and every
    //     line the handler said about `/cb`.
    expect({
      reply: { status: r.status, callback: r.callback },
      row: { status: view?.status, attempts: view?.attempts, last: view?.last_status },
      toItself: s.logger.lines.filter(
        (l) => (l.data as { path?: string } | undefined)?.path === '/cb',
      ),
    }).toEqual({
      reply: { status: 202, callback: 'registered' },
      row: { status: 'pending', attempts: 1, last: 'refused_address' },
      toItself: [],
    });
  });

  it('the store’s errors: a run that cannot be read gives the pass’s unexpected-error line; only the store’s not-found says the run was not found', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const inner = new InMemoryStore();
    const rcv = await receiver();
    await inner.callbacks!.keys.make(W, rcv.host, KEY);
    const broken = await finishedElsewhere(inner, rcv.url, rcv.host);
    const gone = await finishedElsewhere(inner, rcv.url, rcv.host);
    // The run `broken` cannot be read (a disk error); the run `gone` is read through the store's own
    // not-found (a read of an id it does not hold).
    const store = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === 'get') {
          return (id: string) =>
            id === broken
              ? Promise.reject(new Error('disk'))
              : target.get(id === gone ? `${id}-gone` : id);
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const s = await serve([OPTED], { store, over: { callbackLists: rcv.lists } });
    // A second server whose listing fails: the runner's own line, under the pass's label.
    const failing = new InMemoryStore();
    vi.spyOn(failing.callbacks!, 'due').mockRejectedValue(new Error('locked'));
    const t = await serve([OPTED], { store: failing, over: { callbackLists: rcv.lists } });
    vi.advanceTimersByTime(CALLBACK_POLL_MS);
    await until(() => passLines(s.logger.lines).length >= 2, 'a line for each row');
    await until(() => passLines(t.logger.lines).length >= 1, 'the failed listing’s line');
    // (1) red when `getRun` swallows every error as "not found" (the unexpected-error line is
    //     missing, and `broken` is said not found), or lets the not-found throw (the other way round),
    //     or the runner is labelled otherwise than `callbacks`; (2) prints the lines.
    expect({
      lines: passLines(s.logger.lines).sort(),
      posts: rcv.posts.length,
      failedListing: t.logger.lines
        .filter((l) => l.msg.startsWith('listen: callbacks:'))
        .map((l) => ({ level: l.level, msg: l.msg, data: l.data })),
    }).toEqual({
      lines: [
        `error listen: callbacks: ${W} → ${rcv.host}: unexpected error (Error) for run ${broken}`,
        `warn listen: callbacks: ${W} → ${rcv.host}: run ${gone} was not found; it will try again`,
      ],
      posts: 0,
      failedListing: [
        { level: 'error', msg: 'listen: callbacks: pass failed', data: { error: 'Error: locked' } },
      ],
    });
  });

  it('the hook’s edges: never called for a start that gives no exit or that failed; called once, after the exit, for one that exits', async () => {
    const logger = capturingLogger();
    const routes = buildRouteTable([{ definition: OPTED, workflowDir: '/tmp/c3b2-wf' }], {
      env: ENV,
      logger,
    });
    const deps = (spawnAgent: ListenDeps['spawnAgent']): ListenDeps => ({
      workflowStore: { register: async () => {}, get: async () => OPTED },
      runStore: new InMemoryStore(),
      dedupStoreFor: () => new InMemoryDedupStore(),
      spawnAgent,
      logger,
      disclosureProvider: async () => emptySet(),
    });
    /** A server over the bare handler with `spawnAgent`; how often its hook was called. */
    const handlerWith = async (spawnAgent: ListenDeps['spawnAgent']) => {
      const hook = vi.fn();
      const server = createServer((req, res) => {
        void makeListenHandler(routes, deps(spawnAgent), { onAgentExit: hook })(req, res);
      });
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
      onTestFinished(
        () =>
          new Promise<void>((ok) => {
            server.closeAllConnections();
            server.close(() => ok());
          }),
      );
      return { port: (server.address() as AddressInfo).port, hook };
    };
    const noExit = await handlerWith(async () => ({ pid: 4242 }));
    const s1 = await start(noExit.port, 'evt-no-exit');
    const failed = await handlerWith(async () => ({ error: new Error('no such folder') }));
    const s2 = await start(failed.port, 'evt-failed');
    const a = agents();
    const exits = await handlerWith(a.spawnAgent);
    const s3 = await start(exits.port, 'evt-exits');
    await pause(100);
    const beforeExit = exits.hook.mock.calls.length;
    a.exit(s3.runId);
    await until(() => exits.hook.mock.calls.length >= 1, 'the hook after the exit');
    await pause(100);
    // (1) red when the hook is called at the start (before the exit) or for a start without an
    //     `exited`, or for a failed start; (2) prints the replies and the counts.
    expect({
      replies: [s1.status, s2.status, s3.status],
      noExit: noExit.hook.mock.calls.length,
      failed: failed.hook.mock.calls.length,
      exits: { beforeExit, after: exits.hook.mock.calls.length },
    }).toEqual({
      replies: [202, 500, 202],
      noExit: 0,
      failed: 0,
      exits: { beforeExit: 0, after: 1 },
    });
  });

  it('two agents exiting during one pass cause exactly one more pass, and starts alone cause none', async () => {
    const store = new InMemoryStore();
    const callbacks = store.callbacks!;
    const listed = callbacks.due.bind(callbacks);
    let empty = 0;
    let hold: Promise<void> | undefined;
    let release: () => void = () => {};
    vi.spyOn(callbacks, 'due').mockImplementation(async (limit) => {
      if (hold !== undefined) await hold;
      const rows = await listed(limit);
      if (rows.length === 0) empty += 1;
      return rows;
    });
    const a = agents();
    const s = await serve([OPTED], {
      store,
      over: {
        callbackLists: { public: [], private: [entry('http://127.0.0.1:1')] },
        spawnAgent: a.spawnAgent,
      },
    });
    const first = await start(s.port, 'evt-0');
    const second = await start(s.port, 'evt-1');
    const third = await start(s.port, 'evt-2');
    await pause(300);
    const afterStarts = empty;
    hold = new Promise<void>((r) => (release = r));
    const counted = callbacks.due as unknown as { mock: { calls: unknown[] } };
    a.exit(first.runId);
    await until(() => counted.mock.calls.length >= 1, 'the pass to begin its listing');
    const listings = counted.mock.calls.length;
    a.exit(second.runId);
    a.exit(third.runId);
    await pause(50);
    hold = undefined;
    release();
    await until(() => empty >= 2, 'the pass and the one after it');
    await pause(400);
    // (1) red when the hook is called at a start (passes before any exit), when each exit during a
    //     pass runs a pass of its own (three passes, not two), or when an exit during a pass is lost
    //     (one); (2) prints the counts.
    expect({ afterStarts, listingsWhenHeld: listings, passes: empty }).toEqual({
      afterStarts: 0,
      listingsWhenHeld: 1,
      passes: 2,
    });
  });
});
