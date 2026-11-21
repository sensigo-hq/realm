// delivery-pass-c3a.test.ts — callback C3a (R1.3): the signed delivery pass on the in-memory store and
// its settable clock (the contract suite's own seam), against real loopback receivers (http, and https
// with the committed TEST-ONLY certificates). No cell uses real DNS or the network: a name resolves
// through the injected resolver. The cells that need a second store handle or the built command are
// in `delivery-pass-sqlite-c3a.test.ts`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { createHmac, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { abandonRun, executeStep } from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { CENSUS } from '../../test-support/clock-census.js';
import {
  capturingLogger,
  emptySet,
  ENV,
  sharedSecretTrigger,
  workflow,
  type Line,
} from '../../test-support/listen-read-r11.js';
import { deriveReadKey, type ReadEntry } from '../run-read-address.js';
import { parseCallbackEntry, type CallbackLists } from './allow-list.js';
import { makeCallbackPass, type CallbackPassDeps } from './delivery-pass.js';
import type { Resolve } from './post-once.js';
import { webhookTimestamp } from './signature.js';
import { EXAMPLE_TEST } from './test-support/test-only-certs.js';

const W = 'refunds';
const C0 = '2026-11-20T12:00:00.000Z';
const KEY_A = '1a'.repeat(32);
const KEY_B = '2b'.repeat(32);
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
const live = (): boolean => true;

/** Every line every cell's logger captured: the last cell reads them all. */
const everyLine: Line[] = [];

afterEach(() => {
  vi.restoreAllMocks();
});

const entry = (text: string) => {
  const r = parseCallbackEntry(text);
  if (!r.ok) throw new Error(`fixture: ${text} refused ${r.word}`);
  return r.entry;
};
const lists = (pub: string[], priv: string[] = []): CallbackLists => ({
  public: pub.map(entry),
  private: priv.map(entry),
});

interface Post {
  readonly headers: http.IncomingHttpHeaders;
  readonly path: string;
  readonly body: string;
}
type Answer = { status: number; headers?: Record<string, string> };

/** A receiver on 127.0.0.1 answering `answer(post, n)` for its nth POST (from 0); closed after the cell. */
async function receiver(
  answer: (post: Post, n: number) => Answer | Promise<Answer>,
  tls?: { cert: string; key: string },
): Promise<{ port: number; posts: Post[] }> {
  const posts: Post[] = [];
  const handler: http.RequestListener = (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const post = {
        headers: req.headers,
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      };
      const n = posts.length;
      posts.push(post);
      void Promise.resolve(answer(post, n)).then((a) => {
        res.writeHead(a.status, a.headers ?? {});
        res.end();
      });
    });
  };
  const server = tls === undefined ? http.createServer(handler) : https.createServer(tls, handler);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  onTestFinished(
    () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  return { port: (server.address() as AddressInfo).port, posts };
}

/** The signature `key` makes for `post`, computed apart with node:crypto. */
const signedBy = (key: string, post: Post): string =>
  `v1,${createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(`${post.headers['webhook-id']}.${post.headers['webhook-timestamp']}.${post.body}`)
    .digest('base64')}`;
const tokens = (post: Post): string[] => String(post.headers['webhook-signature']).split(' ');

/** A store on a settable clock, the workflow `refunds` mounted with its read address, and a logger. */
async function world(start = C0) {
  const clock = settableClock(start);
  const store = new InMemoryStore({ clock });
  const callbacks = store.callbacks!;
  const definition = workflow(
    W,
    sharedSecretTrigger('/refunds', { approved: 'context.resources.review.approved' }),
  );
  const mounted: ReadEntry = {
    path: '/refunds',
    definition,
    readKey: await deriveReadKey(ENV['READ_SECRET']!, W),
  };
  const logger = capturingLogger();
  onTestFinished(() => void everyLine.push(...logger.lines));
  /** A run with a callback to `url` (host label `host`), finished as `finish` says. */
  const run = async (
    url: string,
    host: string,
    finish: 'complete' | 'abandon' | 'fail' | 'none' = 'complete',
    options: { workflowId?: string; output?: Record<string, unknown> } = {},
  ): Promise<string> => {
    const { record } = await store.create({
      workflowId: options.workflowId ?? W,
      workflowVersion: 1,
      params: {},
      callback: { url, host, webhook_id: randomUUID() },
    });
    if (finish === 'none') return record.id;
    if (finish === 'abandon') await abandonRun(store, record.id);
    else {
      await executeStep(store, definition, {
        runId: record.id,
        command: 'review',
        input: options.output ?? { approved: true },
        dispatcher:
          finish === 'complete'
            ? async (_c, input) => input
            : async () => {
                throw new Error('the model went away');
              },
      });
    }
    return record.id;
  };
  const getRun = async (id: string) => {
    try {
      return (await store.get(id)).record;
    } catch {
      return undefined;
    }
  };
  const pass = (over: Partial<CallbackPassDeps> & Pick<CallbackPassDeps, 'lists'>) =>
    makeCallbackPass({
      callbacks,
      getRun,
      entryOf: (id) => (id === W ? mounted : undefined),
      disclosureProvider: async () => emptySet(),
      ownPort: 1,
      logger,
      random: () => 0.5,
      ...over,
    });
  const view = (id: string) => callbacks.read(id);
  const said = () => logger.lines.map((l) => `${l.level} ${l.msg}`);
  return { clock, store, callbacks, definition, mounted, logger, run, getRun, pass, view, said };
}

/** A loopback receiver's host label, its address and the private list that allows it over http. */
const at = (port: number, path = '/cb') => {
  const host = `127.0.0.1:${port}`;
  return { host, url: `http://${host}${path}`, lists: lists([], [`http://${host}`]) };
};

describe('callback C3a — the signed delivery pass', { timeout: 60_000 }, () => {
  it('a rotation: inside the overlap a try carries two tokens, current first; past the previous key’s end, one — the same pass function, no restart', async () => {
    const w = await world();
    const r = await receiver(() => ({ status: 200 }));
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    await w.callbacks.keys.rotate(W, a.host, { candidate: KEY_B, keepSeconds: 3600 });
    const pass = w.pass({ lists: a.lists });
    await w.run(a.url, a.host);
    await pass(live);
    await w.clock.advance(HOUR + 1);
    await w.run(a.url, a.host);
    await pass(live);
    // (1) red when the previous key is left out during the overlap, put first, or still sent after it
    //     ended (a key cache that lives as long as the pass function); (2) prints both headers' tokens
    //     against the ones computed apart.
    expect({
      inside: tokens(r.posts[0]!),
      after: tokens(r.posts[1]!),
    }).toEqual({
      inside: [signedBy(KEY_B, r.posts[0]!), signedBy(KEY_A, r.posts[0]!)],
      after: [signedBy(KEY_B, r.posts[1]!)],
    });
  });

  it('the keys are read fresh for every try: a rotation made during the first POST is seen by the second row of the same pair in the same pass', async () => {
    const w = await world();
    let host = '';
    const r = await receiver(async (_post, n) => {
      if (n === 0) await w.callbacks.keys.rotate(W, host, { candidate: KEY_B, keepSeconds: 3600 });
      return { status: 204 };
    });
    const a = at(r.port);
    host = a.host;
    await w.callbacks.keys.make(W, a.host, KEY_A);
    await w.run(a.url, a.host);
    await w.run(a.url, a.host);
    const cut = await w.pass({ lists: a.lists })(live);
    // (1) red when the keys are read once per pass (the second POST still carries one token);
    //     (2) prints the tokens of both POSTs and the pass's answer.
    expect({
      cut,
      first: tokens(r.posts[0]!),
      second: tokens(r.posts[1]!),
    }).toEqual({
      cut: false,
      first: [signedBy(KEY_A, r.posts[0]!)],
      second: [signedBy(KEY_B, r.posts[1]!), signedBy(KEY_A, r.posts[1]!)],
    });
  });

  it('a retry sends the same body bytes and webhook-id, with a new timestamp and signature; 503 then 200 is two tries, delivered', async () => {
    const w = await world();
    const r = await receiver((_post, n) => ({ status: n === 0 ? 503 : 200 }));
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    const id = await w.run(a.url, a.host);
    let seconds = 1_763_726_400;
    const pass = w.pass({ lists: a.lists, timestamp: () => seconds++ });
    await pass(live);
    await w.clock.advance(1_000);
    await pass(live);
    const [p0, p1] = r.posts;
    const v = await w.view(id);
    // (1) red when a try gets a new webhook-id, the body is rebuilt per try, the timestamp is not
    //     read per try, or the retry's wait is not the schedule's 1 s; (2) prints both POSTs' parts,
    //     the row and the lines.
    expect({
      posts: r.posts.length,
      sameBody: p0!.body === p1!.body,
      sameId: p0!.headers['webhook-id'] === p1!.headers['webhook-id'],
      timestamps: [p0!.headers['webhook-timestamp'], p1!.headers['webhook-timestamp']],
      signatures: [
        tokens(p0!)[0] === signedBy(KEY_A, p0!),
        tokens(p1!)[0] === signedBy(KEY_A, p1!),
      ],
      differ: tokens(p0!)[0] !== tokens(p1!)[0],
      row: { status: v?.status, attempts: v?.attempts, last_status: v?.last_status },
      said: w.said(),
    }).toEqual({
      posts: 2,
      sameBody: true,
      sameId: true,
      timestamps: ['1763726400', '1763726401'],
      signatures: [true, true],
      differ: true,
      row: { status: 'delivered', attempts: 2, last_status: 200 },
      said: [
        `warn callbacks: ${W} → ${a.host}: attempt 1 failed (last answer 503); it will try again`,
        `info callbacks: ${W} → ${a.host}: delivered (attempt 2)`,
      ],
    });
  });

  it('410 ends the row at once: one POST, failed with 410', async () => {
    const w = await world();
    const r = await receiver(() => ({ status: 410 }));
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    const id = await w.run(a.url, a.host);
    const pass = w.pass({ lists: a.lists });
    await pass(live);
    await w.clock.advance(HOUR);
    await pass(live);
    const v = await w.view(id);
    // (1) red when 410 is retried; (2) prints the POSTs, the row and the lines.
    expect({
      posts: r.posts.length,
      row: { status: v?.status, last_status: v?.last_status },
      said: w.said(),
    }).toEqual({
      posts: 1,
      row: { status: 'failed', last_status: 410 },
      said: [
        `warn callbacks: ${W} → ${a.host}: the receiver answered 410, so it will not be tried again`,
      ],
    });
  });

  it('the time limits: a 4xx but 408, 425, 429 ends at an hour after the first try and not 1 ms before; every answer ends at 3 days after the finish and not 1 ms before; an ending claim sends nothing', async () => {
    const STATUSES = [400, 404, 408, 425, 429, 499];
    /** One world: each status twice, `early` (claimed at the instant − 1 ms) and `onTime` (at it). */
    const bench = async (firstTryAt: number, instant: number) => {
      const w = await world(C0);
      const answers = new Map<string, Answer>();
      const r = await receiver((post) => answers.get(String(post.headers['realm-run-id']))!);
      const a = at(r.port);
      await w.callbacks.keys.make(W, a.host, KEY_A);
      const rows: { status: number; when: 'early' | 'onTime'; id: string }[] = [];
      for (const status of STATUSES) {
        for (const when of ['early', 'onTime'] as const) {
          rows.push({ status, when, id: await w.run(a.url, a.host, 'none') });
        }
      }
      // Created at C0, finished a day later: the run's creation and its finish are a day apart.
      const finished = Date.parse(C0) + DAY;
      await w.clock.set(new Date(finished));
      for (const row of rows) await abandonRun(w.store, row.id);
      await w.clock.set(new Date(finished + firstTryAt));
      // The first try: `onTime` rows are told to wait exactly until the instant (Retry-After), so
      // `early` rows alone are due at the instant − 1 ms, and `onTime` rows alone at the instant.
      for (const row of rows) {
        answers.set(row.id, {
          status: row.status,
          headers:
            row.when === 'onTime' ? { 'retry-after': String((instant - firstTryAt) / 1000) } : {},
        });
      }
      const pass = w.pass({ lists: a.lists });
      await pass(live);
      for (const row of rows) answers.set(row.id, { status: row.status });
      await w.clock.set(new Date(finished + instant - 1));
      await pass(live);
      await w.clock.set(new Date(finished + instant));
      await pass(live);
      const out: Record<string, unknown> = {};
      for (const row of rows) {
        const v = await w.view(row.id);
        const sent = r.posts.filter((p) => p.headers['realm-run-id'] === row.id).length;
        out[`${row.status} ${row.when}`] = `${v?.status} ${v?.last_status} ${sent} POST`;
      }
      return out;
    };
    // The hour: first try 30 min after the finish, the instant an hour after that first try.
    const hour = await bench(30 * MIN, 30 * MIN + HOUR);
    // The 3 days: first try 30 min before the instant, so the hour rule cannot fire by then.
    const days = await bench(3 * DAY - 30 * MIN, 3 * DAY);
    const ended = 'failed expired 1 POST';
    const sent = (s: number) => `pending ${s} 2 POST`;
    // (1) red when 429 (or 408, 425) is ended like 404, the hour counts from the finish (the early
    //     400 row is ended), the 3 days count from the run's creation (an early row is ended), a
    //     boundary is "after" instead of "at or after" (an onTime row is sent), or an ending claim
    //     sends; (2) prints each row's state and POST count.
    expect({ hour, days }).toEqual({
      hour: {
        '400 early': sent(400),
        '400 onTime': ended,
        '404 early': sent(404),
        '404 onTime': ended,
        '408 early': sent(408),
        '408 onTime': sent(408),
        '425 early': sent(425),
        '425 onTime': sent(425),
        '429 early': sent(429),
        '429 onTime': sent(429),
        '499 early': sent(499),
        '499 onTime': ended,
      },
      days: Object.fromEntries(
        STATUSES.flatMap((s) => [
          [`${s} early`, sent(s)],
          [`${s} onTime`, ended],
        ]),
      ),
    });
  });

  it.each(['timeout', 'connection'] as const)(
    'a dead host (%s) is tried once in a pass; the healthy host’s rows all go; the pass answers false',
    async (word) => {
      const w = await world();
      const ok = await receiver(() => ({ status: 200 }));
      const held: net.Socket[] = [];
      let accepted = 0;
      const dead = net.createServer((socket) => {
        accepted += 1;
        held.push(socket);
        socket.on('error', () => undefined);
      });
      await new Promise<void>((done) => dead.listen(0, '127.0.0.1', () => done()));
      const deadPort = (dead.address() as AddressInfo).port;
      if (word === 'connection') await new Promise<void>((done) => dead.close(() => done()));
      onTestFinished(() => {
        for (const s of held) s.destroy();
        if (word === 'timeout') dead.close();
      });
      const good = at(ok.port);
      const bad = at(deadPort);
      for (const h of [good.host, bad.host]) await w.callbacks.keys.make(W, h, KEY_A);
      const ids = {
        bad: [await w.run(bad.url, bad.host), await w.run(bad.url, bad.host)],
        good: [await w.run(good.url, good.host), await w.run(good.url, good.host)],
      };
      const cut = await w.pass({
        lists: lists([], [`http://${good.host}`, `http://${bad.host}`]),
        deadlineMs: 300,
      })(live);
      const state = async (id: string) => {
        const v = await w.view(id);
        return `${v?.status} ${v?.attempts} ${v?.last_status ?? '-'}`;
      };
      // (1) red when a dead host is not skipped for the rest of the pass, or only after a timeout
      //     (its second row is tried too); (2) prints the rows, the pass's answer and the connects.
      expect({
        cut,
        good: await Promise.all(ids.good.map(state)),
        bad: (await Promise.all(ids.bad.map(state))).sort(),
        accepted: word === 'timeout' ? accepted : 'closed port',
      }).toEqual({
        cut: false,
        good: ['delivered 1 200', 'delivered 1 200'],
        bad: ['pending 0 -', `pending 1 ${word}`],
        accepted: word === 'timeout' ? 1 : 'closed port',
      });
    },
  );

  it('the budget: once 45 s are spent the pass stops before the next row and answers true, with rows left', async () => {
    const w = await world();
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    const r = await receiver(() => {
      t = 45_000;
      return { status: 200 };
    });
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    const ids = [await w.run(a.url, a.host), await w.run(a.url, a.host)];
    const cut = await w.pass({ lists: a.lists })(live);
    const states = await Promise.all(ids.map(async (id) => (await w.view(id))?.status));
    // (1) red when the budget is not checked before each row, or a cut pass answers false; (2) prints
    //     the answer, the POSTs and the rows.
    expect({ cut, posts: r.posts.length, states: states.sort() }).toEqual({
      cut: true,
      posts: 1,
      states: ['delivered', 'pending'],
    });
  });

  it('shutdown: once live() is false the pass starts no row and answers false', async () => {
    const w = await world();
    const r = await receiver(() => ({ status: 200 }));
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    const id = await w.run(a.url, a.host);
    const cut = await w.pass({ lists: a.lists })(() => false);
    // (1) red when live() is not checked before a row; (2) prints the answer, POSTs and row.
    expect({ cut, posts: r.posts.length, attempts: (await w.view(id))?.attempts }).toEqual({
      cut: false,
      posts: 0,
      attempts: 0,
    });
  });

  it('a row of a workflow this process does not mount is neither claimed nor written, with one line however many passes', async () => {
    const w = await world();
    const r = await receiver(() => ({ status: 200 }));
    const a = at(r.port);
    await w.callbacks.keys.make('other', a.host, KEY_A);
    const id = await w.run(a.url, a.host, 'abandon', { workflowId: 'other' });
    const pass = w.pass({ lists: a.lists });
    for (let i = 0; i < 3; i += 1) await pass(live);
    const v = await w.view(id);
    // (1) red when an unmounted row is claimed (attempts 1) or the line is said per pass; (2) prints
    //     the row, the POSTs and the lines.
    expect({
      attempts: v?.attempts,
      status: v?.status,
      posts: r.posts.length,
      said: w.said(),
    }).toEqual({
      attempts: 0,
      status: 'pending',
      posts: 0,
      said: ['warn callbacks: other is not mounted by this realm listen, so its callbacks wait'],
    });
  });

  it('a row whose host is no longer on the lists ends not_allowed, with no POST', async () => {
    const w = await world();
    const r = await receiver(() => ({ status: 200 }));
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    const id = await w.run(a.url, a.host);
    await w.pass({ lists: lists([], ['http://127.0.0.1:1']) })(live);
    const v = await w.view(id);
    // (1) red when a row the lists no longer allow is sent or retried; (2) prints all three.
    expect({
      posts: r.posts.length,
      row: `${v?.status} ${v?.last_status}`,
      said: w.said(),
    }).toEqual({
      posts: 0,
      row: 'failed not_allowed',
      said: [
        `warn callbacks: ${W} → ${a.host}: not sent: its address is no longer allowed by this realm listen`,
      ],
    });
  });

  it('the address is sent as stored: a backslash path reaches the listed host, with the path the parser reads; nothing reaches evil.com', async () => {
    const w = await world();
    const r = await receiver(() => ({ status: 200 }), EXAMPLE_TEST);
    const host = `example.test:${r.port}`;
    const url = `https://example.test:${r.port}\\.evil.com/x?a=1`;
    const asked: string[] = [];
    const resolve: Resolve = async (name) => {
      asked.push(name);
      return [{ address: '127.0.0.1', family: 4 }];
    };
    await w.callbacks.keys.make(W, host, KEY_A);
    const id = await w.run(url, host);
    await w.pass({ lists: lists([], [host]), seams: { resolve, tls: { ca: EXAMPLE_TEST.cert } } })(
      live,
    );
    // (1) red when this unit re-builds the address from its parts (the Host or the path changes, or
    //     another name is resolved); (2) prints what the receiver saw and what was resolved.
    expect({
      posts: r.posts.map((p) => ({ host: p.headers.host, path: p.path })),
      asked,
      status: (await w.view(id))?.status,
    }).toEqual({
      posts: [{ host, path: '/.evil.com/x?a=1' }],
      asked: ['example.test'],
      status: 'delivered',
    });
  });

  it('a failed and an abandoned run send their phase only, with the read address; never the read code', async () => {
    const w = await world();
    const r = await receiver(() => ({ status: 200 }));
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    const failed = await w.run(a.url, a.host, 'fail');
    const abandoned = await w.run(a.url, a.host, 'abandon');
    await w.pass({ lists: a.lists })(live);
    const bodies = Object.fromEntries(
      r.posts.map((p) => {
        const b = JSON.parse(p.body) as { data: { run_id: string } };
        return [b.data.run_id, b];
      }),
    );
    const env = (id: string, phase: string) => ({
      type: 'run.finished',
      timestamp: expect.any(String),
      data: { run_id: id, run_phase: phase, status_path: `/refunds/runs/${id}` },
    });
    // (1) red when a field is added to a non-completed phase (the read code among them) or the
    //     read address is left out; (2) prints both envelopes.
    expect(bodies).toEqual({
      [failed]: env(failed, 'failed'),
      [abandoned]: env(abandoned, 'abandoned'),
    });
  });

  it('a frozen body is sent again as frozen: the run is not read again, whatever its record says now', async () => {
    const w = await world();
    const r = await receiver((_post, n) => ({ status: n === 0 ? 503 : 200 }));
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    const id = await w.run(a.url, a.host, 'fail');
    let reads = 0;
    const pass = w.pass({
      lists: a.lists,
      getRun: async (runId) => {
        reads += 1;
        return w.getRun(runId);
      },
    });
    await pass(live);
    await w.clock.advance(1_000);
    await pass(live);
    // (1) red when the body is built again per try; (2) prints the reads, the POSTs and the bodies.
    expect({
      reads,
      posts: r.posts.length,
      same: r.posts[0]?.body === r.posts[1]?.body,
      row: (await w.view(id))?.status,
    }).toEqual({ reads: 1, posts: 2, same: true, row: 'delivered' });
  });

  it('a body that cannot be built leaves the claim, says one line, writes no mark; a run not found the same', async () => {
    const w = await world();
    const r = await receiver(() => ({ status: 200 }));
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    const noBody = await w.run(a.url, a.host);
    const noRun = await w.run(a.url, a.host, 'abandon');
    const pass = w.pass({
      lists: a.lists,
      disclosureProvider: async () => {
        throw new Error('no disclosure set');
      },
      getRun: async (id) => (id === noRun ? undefined : w.getRun(id)),
    });
    await pass(live);
    await w.clock.advance(61_000);
    await pass(live);
    const row = async (id: string) => {
      const v = await w.view(id);
      return `${v?.status} ${v?.attempts} ${v?.last_status ?? '-'}`;
    };
    // (1) red when a failed build marks the row, sends, or says its line per try; (2) prints all.
    expect({
      posts: r.posts.length,
      noBody: await row(noBody),
      noRun: await row(noRun),
      said: w.said().sort(),
    }).toEqual({
      posts: 0,
      noBody: 'pending 2 -',
      noRun: 'pending 2 -',
      said: [
        `warn callbacks: ${W} → ${a.host}: could not build the body for run ${noBody}; it will try again`,
        `warn callbacks: ${W} → ${a.host}: run ${noRun} was not found; it will try again`,
      ].sort(),
    });
  });

  it('every row of the table: 302 is redirect and a refused address refused_address, each one retry and one line; 699 is connection; a mark that does not apply says nothing', async () => {
    const w = await world();
    const moved = await receiver(() => ({ status: 302, headers: { location: 'http://x/' } }));
    const odd = await receiver(() => ({ status: 699 }));
    const m = at(moved.port);
    const o = at(odd.port);
    const refused = {
      host: `refused.example:${moved.port}`,
      url: `http://refused.example:${moved.port}/cb`,
    };
    for (const h of [m.host, o.host, refused.host]) await w.callbacks.keys.make(W, h, KEY_A);
    const ids = {
      moved: await w.run(m.url, m.host),
      odd: await w.run(o.url, o.host),
      refused: await w.run(refused.url, refused.host),
    };
    const pass = w.pass({
      lists: lists([`http://${refused.host}`], [`http://${m.host}`, `http://${o.host}`]),
      seams: { resolve: async () => [{ address: '127.0.0.1', family: 4 }] },
    });
    await pass(live);
    await w.clock.advance(1_000);
    await pass(live);
    const row = async (id: string) => {
      const v = await w.view(id);
      return `${v?.status} ${v?.attempts} ${v?.last_status}`;
    };
    // (1) red when a redirect or a refused address ends the row or is said per try, or a status
    //     above 599 is handed to the store (it throws: the row stays at its claim, with an error
    //     line); (2) prints each row and the lines.
    expect({
      moved: await row(ids.moved),
      refused: await row(ids.refused),
      odd: await row(ids.odd),
      said: w.said().sort(),
    }).toEqual({
      moved: 'pending 2 redirect',
      refused: 'pending 2 refused_address',
      odd: 'pending 2 connection',
      said: [
        `warn callbacks: ${W} → ${m.host}: attempt 1 failed (last answer redirect); it will try again`,
        `warn callbacks: ${W} → ${o.host}: attempt 1 failed (last answer connection); it will try again`,
        `warn callbacks: ${W} → ${refused.host}: attempt 1 failed (last answer refused_address); it will try again`,
      ].sort(),
    });
  });

  it('a mark that does not apply (another claimant took the row during the try) changes nothing and says nothing', async () => {
    const w = await world();
    let id = '';
    const r = await receiver(async () => {
      await w.clock.advance(61_000);
      const v = await w.callbacks.read(id);
      await w.callbacks.claim(id, { expectedNextAttemptAt: v!.next_attempt_at, token: 'other' });
      return { status: 200 };
    });
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    id = await w.run(a.url, a.host);
    await w.pass({ lists: a.lists })(live);
    const v = await w.view(id);
    // (1) red when a lost mark logs a line or is taken for a delivery; (2) prints the row and lines.
    expect({ posts: r.posts.length, row: `${v?.status} ${v?.attempts}`, said: w.said() }).toEqual({
      posts: 1,
      row: 'pending 2',
      said: [],
    });
  });

  it('the clock: the header carries the injected timestamp; the default is whole seconds on the system clock; the one system-clock read of the callback code is the timestamp function', async () => {
    const w = await world();
    const r = await receiver(() => ({ status: 200 }));
    const a = at(r.port);
    await w.callbacks.keys.make(W, a.host, KEY_A);
    await w.run(a.url, a.host);
    await w.pass({ lists: a.lists, timestamp: () => 1_763_726_499 })(live);
    const before = Math.floor(Date.now() / 1000);
    const read = webhookTimestamp();
    const after = Math.floor(Date.now() / 1000);
    const callbackReads = Object.entries(CENSUS)
      .filter(([k]) => k.startsWith('cli/src/lib/callback/'))
      .map(([k, [n, cls]]) => `${k} ${n} ${cls}`);
    // (1) red when the timestamp is read elsewhere than the one function, the header is not that
    //     function's integer, or another clock read joins the callback code; (2) prints all.
    expect({
      header: r.posts[0]?.headers['webhook-timestamp'],
      inRange: Number.isInteger(read) && read >= before && read <= after,
      callbackReads,
    }).toEqual({
      header: '1763726499',
      inRange: true,
      callbackReads: [
        'cli/src/lib/callback/delivery-pass.ts#makeCallbackPass#performance.now() 1 duration',
        'cli/src/lib/callback/delivery-pass.ts#spent#performance.now() 1 duration',
        'cli/src/lib/callback/signature.ts#webhookTimestamp#Date.now() 1 outside',
      ],
    });
  });

  it('no leak: an address path and query, the key, a result value, a workflow secret and a thrown message appear in no line and no mark', async () => {
    const w = await world();
    const KEY = 'c3'.repeat(32);
    const r = await receiver((post) => ({
      status: post.path.includes('retry') ? 503 : post.path.includes('gone') ? 410 : 200,
    }));
    const path = '/cb/CANARYpathC3a?q=CANARYqueryC3a';
    const a = at(r.port, path);
    await w.callbacks.keys.make(W, a.host, KEY);
    const ids = [
      await w.run(a.url, a.host, 'complete', { output: { approved: 'CANARYresultC3a' } }),
      await w.run(`${a.url}&retry`, a.host),
      await w.run(`${a.url}&gone`, a.host),
      await w.run(a.url, a.host, 'abandon'),
      await w.run(`http://127.0.0.1:1${path}`, '127.0.0.1:1'),
    ];
    const pass = w.pass({
      lists: a.lists,
      getRun: async (id) => {
        if (id === ids[3]) throw new Error(`a store fault CANARYthrownC3a ${KEY}`);
        return w.getRun(id);
      },
    });
    await pass(live);
    const views = await Promise.all(ids.map((id) => w.view(id)));
    const canaries = [
      'CANARYpathC3a',
      'CANARYqueryC3a',
      'CANARYresultC3a',
      'CANARYthrownC3a',
      KEY,
      ENV['READ_SECRET']!,
    ];
    const text = JSON.stringify({ lines: w.logger.lines, views });
    // (1) red when a line logs the address on a failure, a thrown error's message, or a mark carries
    //     anything but a status or a word; (2) prints what leaked and the lines (the instrument: the
    //     result canary reached the receiver's body, so it was in play).
    expect({
      leaked: canaries.filter((c) => text.includes(c)),
      inPlay: r.posts.some((p) => p.body.includes('CANARYresultC3a')),
      said: w.said().sort(),
    }).toEqual({
      leaked: [],
      inPlay: true,
      said: [
        `error callbacks: ${W} → ${a.host}: unexpected error (Error) for run ${ids[3]}`,
        `info callbacks: ${W} → ${a.host}: delivered (attempt 1)`,
        `warn callbacks: ${W} → ${a.host}: attempt 1 failed (last answer 503); it will try again`,
        `warn callbacks: ${W} → ${a.host}: the receiver answered 410, so it will not be tried again`,
        `warn callbacks: ${W} → 127.0.0.1:1: no signing key this process can read (none), so its callbacks wait`,
      ].sort(),
    });
  });

  it('every line any cell above captured is one of the pass’s shapes, and carries no data', () => {
    const SHAPES = [
      /^callbacks: \S+ → \S+: delivered \(attempt \d+\)$/,
      /^callbacks: \S+ → \S+: the receiver answered 410, so it will not be tried again$/,
      /^callbacks: \S+ → \S+: not sent: its address is no longer allowed by this realm listen$/,
      /^callbacks: \S+ → \S+: attempt \d+ failed \(last answer (\d{3}|timeout|connection|redirect|refused_address)\); it will try again$/,
      /^callbacks: \S+ → \S+: stopped at attempt \d+: not delivered within its time limit$/,
      /^callbacks: \S+ is not mounted by this realm listen, so its callbacks wait$/,
      /^callbacks: \S+ → \S+: no signing key this process can read \((none|sealed with encryption key [0-9a-f]{8})\), so its callbacks wait$/,
      /^callbacks: \S+ → \S+: run [0-9a-f-]{36} was not found; it will try again$/,
      /^callbacks: \S+ → \S+: could not build the body for run [0-9a-f-]{36}; it will try again$/,
      /^callbacks: \S+ → \S+: unexpected error \(\w+\) for run [0-9a-f-]{36}$/,
    ];
    // (1) red when a line of another shape, or one with a data object, is logged; (2) prints them
    //     (the instrument: how many lines were read).
    expect({
      odd: everyLine.filter((l) => l.data !== undefined || !SHAPES.some((s) => s.test(l.msg))),
      read: everyLine.length > 20,
    }).toEqual({ odd: [], read: true });
  });
});
