// delivery-pass-c3d.test.ts — callback C3d-A (R1.3): the sweep at the start of each delivery pass. A
// callback that is due 3 days or more after its run ended is ended `failed` with `expired` before any
// try, whoever could have sent it: a workflow this `realm listen` does not mount, a key it cannot
// read, or one it could send. One line per ended row (`never sent` for a row never tried, `stopped
// at attempt <n>` for one tried), at most 10, then one count line. The in-memory store on a settable
// clock with real loopback receivers; the last cell is a real SQLite home and the BUILT
// `realm run inspect`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abandonRun } from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { createCallbackKeySealer } from '@sensigo/realm-store-sqlite';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { makePollRunner } from '../../commands/listen-reminders.js';
import { makeTempHome } from '../../test-support/temp-home.js';
import {
  capturingLogger,
  emptySet,
  ENV,
  read,
  serve,
  sharedSecretTrigger,
  workflow,
} from '../../test-support/listen-read-r11.js';
import { deriveReadKey, type ReadEntry } from '../run-read-address.js';
import { parseCallbackEntry, type CallbackLists } from './allow-list.js';
import { makeCallbackPass, type CallbackPassDeps } from './delivery-pass.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', '..', 'dist', 'index.js');
const W = 'refunds';
const C0 = '2026-11-20T12:00:00.000Z';
const KEY = '1a'.repeat(32);
const MASTER = '5c'.repeat(32);
const DAY = 86_400_000;
const MIN = 60_000;
const live = (): boolean => true;
const NOKEY = { url: 'https://nokey.example/cb', host: 'nokey.example:443' };
const OTHER = { url: 'https://other.example/cb', host: 'other.example:443' };

afterEach(() => {
  vi.restoreAllMocks();
});

const allow = (text: string) => {
  const r = parseCallbackEntry(text);
  if (!r.ok) throw new Error(`fixture: ${text} refused ${r.word}`);
  return r.entry;
};

/** A loopback receiver answering `status(n)` (from 0) for its nth POST; closed after the cell. */
async function receiver(
  status: (n: number) => { status: number; retryAfter?: number } = () => ({
    status: 200,
  }),
): Promise<{ host: string; url: string; lists: CallbackLists; posts: string[] }> {
  const posts: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const a = status(posts.length);
      posts.push(String(req.headers['realm-run-id']));
      res.writeHead(
        a.status,
        a.retryAfter !== undefined ? { 'retry-after': String(a.retryAfter) } : {},
      );
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  onTestFinished(
    () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    host,
    url: `http://${host}/cb`,
    lists: { public: [], private: [allow(`http://${host}`)] },
    posts,
  };
}

/** The in-memory store on a settable clock, `refunds` mounted, a logger and a pass maker. */
async function world() {
  const clock = settableClock(C0);
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
  /** A run with a callback to `url` (`host`), ended now unless `end` is false; its id. */
  const run = async (url: string, host: string, workflowId = W, end = true): Promise<string> => {
    const { record } = await store.create({
      workflowId,
      workflowVersion: 1,
      params: {},
      callback: { url, host, webhook_id: randomUUID() },
    });
    if (end) await abandonRun(store, record.id);
    return record.id;
  };
  const pass = (lists: CallbackLists, over: Partial<CallbackPassDeps> = {}) =>
    makeCallbackPass({
      callbacks,
      getRun: async (id) => {
        try {
          return (await store.get(id)).record;
        } catch {
          return undefined;
        }
      },
      entryOf: (id) => (id === W ? mounted : undefined),
      disclosureProvider: async () => emptySet(),
      lists,
      ownPort: 1,
      logger,
      random: () => 0.5,
      ...over,
    });
  /** A row as `status last_status attempts`. */
  const row = async (id: string): Promise<string> => {
    const v = await callbacks.read(id);
    return `${v?.status} ${v?.last_status ?? '-'} ${v?.attempts}`;
  };
  const said = () => logger.lines.map((l) => `${l.level} ${l.msg}`);
  return { clock, store, callbacks, run, pass, row, said, logger };
}

const neverSent = (host: string, workflowId = W) =>
  `warn callbacks: ${workflowId} → ${host}: never sent: its time limit passed before a try could be made`;
const stoppedAt = (host: string, n: number) =>
  `warn callbacks: ${W} → ${host}: stopped at attempt ${n}: not delivered within its time limit`;

describe(
  'callback C3d-A — the sweep ends what is overdue, before any try',
  { timeout: 60_000 },
  () => {
    it('4 days after the run ended: an unmounted workflow’s row, a row whose key cannot be read and a row this process could send are all ended expired, nothing sent, one never-sent line each', async () => {
      const w = await world();
      const r = await receiver();
      await w.callbacks.keys.make(W, r.host, KEY);
      const sendable = await w.run(r.url, r.host);
      const unmounted = await w.run(OTHER.url, OTHER.host, 'other');
      const noKey = await w.run(NOKEY.url, NOKEY.host);
      await w.clock.advance(4 * DAY);
      await w.pass(r.lists)(live);
      // (1) red when the sweep runs only for unmounted rows, or inside the per-row work after the key
      //     check (the sendable row is then claimed: attempt 1, the old words; the no-key row waits),
      //     or a never-tried row's line says "attempt 0"; (2) prints each row, the POSTs and the lines.
      expect({
        rows: {
          sendable: await w.row(sendable),
          unmounted: await w.row(unmounted),
          noKey: await w.row(noKey),
        },
        posts: r.posts.length,
        said: w.said().sort(),
      }).toEqual({
        rows: {
          sendable: 'failed expired 0',
          unmounted: 'failed expired 0',
          noKey: 'failed expired 0',
        },
        posts: 0,
        said: [neverSent(r.host), neverSent(NOKEY.host), neverSent(OTHER.host, 'other')].sort(),
      });
    });

    it('the same rows 2 days after the run ended: nothing ends; the sendable one is sent, the others wait as before', async () => {
      const w = await world();
      const r = await receiver();
      await w.callbacks.keys.make(W, r.host, KEY);
      const sendable = await w.run(r.url, r.host);
      const unmounted = await w.run(OTHER.url, OTHER.host, 'other');
      const noKey = await w.run(NOKEY.url, NOKEY.host);
      await w.clock.advance(2 * DAY);
      await w.pass(r.lists)(live);
      // (1) red when the sweep ends a row before its 3 days; (2) prints each row, the POSTs and the lines.
      expect({
        rows: {
          sendable: await w.row(sendable),
          unmounted: await w.row(unmounted),
          noKey: await w.row(noKey),
        },
        posts: r.posts,
        said: w.said().sort(),
      }).toEqual({
        rows: {
          sendable: 'delivered 200 1',
          unmounted: 'pending - 0',
          noKey: 'pending - 0',
        },
        posts: [sendable],
        said: [
          `info callbacks: ${W} → ${r.host}: delivered (attempt 1)`,
          `warn callbacks: ${W} → ${NOKEY.host}: no signing key this process can read (none), so its callbacks wait`,
          `warn callbacks: other is not mounted by this realm listen, so its callbacks wait`,
        ].sort(),
      });
    });

    it('a row tried once whose retry wait is over ends "stopped at attempt 1"; a row waiting for its retry past the 3 days is left until that wait ends, its attempts kept', async () => {
      const w = await world();
      // The first POST answers 503; the second 503 with "come back in an hour".
      const r = await receiver((n) =>
        n === 0 ? { status: 503 } : { status: 503, retryAfter: 3600 },
      );
      await w.callbacks.keys.make(W, r.host, KEY);
      const early = await w.run(r.url, r.host);
      await w.pass(r.lists)(live);
      await w.clock.advance(DAY);
      // Its run ends a day after early's, so its 3 days end a day later too.
      const late = await w.run(r.url, r.host);
      const lateEnd = Date.parse(C0) + DAY + 3 * DAY;
      await w.clock.advance(3 * DAY - 10 * MIN);
      const lines = (): string[] => w.said().filter((l) => /stopped at|never sent/.test(l));
      // 10 min before late's 3 days: early's retry wait (minutes) is long over and its 3 days are past,
      // so the sweep ends it; late is not overdue yet, so it is tried and told to wait an hour.
      await w.pass(r.lists)(live);
      const first = {
        early: await w.row(early),
        late: await w.row(late),
        lines: lines(),
        posts: r.posts,
      };
      const lateNext = Date.parse((await w.callbacks.read(late))!.next_attempt_at);
      await w.clock.set(new Date(lateNext - 1));
      await w.pass(r.lists)(live);
      const before = { late: await w.row(late), lines: lines().length, posts: r.posts.length };
      await w.clock.set(new Date(lateNext));
      await w.pass(r.lists)(live);
      // (1) red when the sweep ends a row whose retry wait is not over (late ended at its 3 days,
      //     before its next try), the line counts the claim's own +1 ("attempt 2"), or a retried row's
      //     attempts are not kept; (2) prints the rows, the lines and the POSTs at each pass.
      expect({
        first,
        nextPastTheEnd: lateNext > lateEnd,
        before,
        after: { late: await w.row(late), lines: lines(), posts: r.posts.length },
      }).toEqual({
        first: {
          early: 'failed expired 1',
          late: 'pending 503 1',
          lines: [stoppedAt(r.host, 1)],
          posts: [early, late],
        },
        nextPastTheEnd: true,
        before: { late: 'pending 503 1', lines: 1, posts: 2 },
        after: {
          late: 'failed expired 1',
          lines: [stoppedAt(r.host, 1), stoppedAt(r.host, 1)],
          posts: 2,
        },
      });
    });

    it('25 rows ended in one sweep: 10 lines and "and 15 more callbacks"; 11: 10 lines and "and 1 more callback"', async () => {
      const sweep = async (n: number): Promise<string[]> => {
        const w = await world();
        for (let i = 0; i < n; i++) await w.run(OTHER.url, OTHER.host, 'other');
        await w.clock.advance(4 * DAY);
        await w.pass({ public: [], private: [] })(live);
        return w.said();
      };
      const many = await sweep(25);
      const eleven = await sweep(11);
      // (1) red when every ended row gets a line, the count line is missing or counts the named rows
      //     too, or says "callbacks" for one; (2) prints the lines.
      expect({ many, eleven }).toEqual({
        many: [
          ...Array.from({ length: 10 }, () => neverSent(OTHER.host, 'other')),
          'warn callbacks: and 15 more callbacks ended the same way',
        ],
        eleven: [
          ...Array.from({ length: 10 }, () => neverSent(OTHER.host, 'other')),
          'warn callbacks: and 1 more callback ended the same way',
        ],
      });
    });

    it('the sweep comes before the listing: a row it ended is not listed', async () => {
      const w = await world();
      const r = await receiver();
      await w.callbacks.keys.make(W, r.host, KEY);
      const old = await w.run(r.url, r.host);
      await w.clock.advance(4 * DAY);
      const fresh = await w.run(r.url, r.host);
      const ended = vi.spyOn(w.callbacks, 'endOverdue');
      const due = vi.spyOn(w.callbacks, 'due');
      await w.pass(r.lists)(live);
      const listed = await Promise.all(
        due.mock.results.map((x) => x.value as Promise<{ run_id: string }[]>),
      );
      // (1) red when the listing comes first (the overdue row is listed, claimed and ended by the claim
      //     path) or the sweep is not called; (2) prints the call order, the listings and the POSTs.
      expect({
        sweepFirst: ended.mock.invocationCallOrder[0]! < due.mock.invocationCallOrder[0]!,
        listed: listed.map((items) => items.map((i) => i.run_id)),
        posts: r.posts,
        old: await w.row(old),
      }).toEqual({
        sweepFirst: true,
        listed: [[fresh], []],
        posts: [fresh],
        old: 'failed expired 0',
      });
    });

    it('a sweep that throws: the runner says "pass failed", and nothing is sent in that pass', async () => {
      const w = await world();
      const r = await receiver();
      await w.callbacks.keys.make(W, r.host, KEY);
      const id = await w.run(r.url, r.host);
      vi.spyOn(w.callbacks, 'endOverdue').mockRejectedValue(new Error('disk gone'));
      const runner = makePollRunner(w.pass(r.lists), 'callbacks', w.logger);
      await runner.wake();
      await runner.stop();
      // (1) red when the sweep's error is caught inside the pass (the row is then sent), or the
      //     runner's line changes; (2) prints the lines, the POSTs and the row.
      expect({ lines: w.logger.lines, posts: r.posts.length, row: await w.row(id) }).toEqual({
        lines: [
          {
            level: 'error',
            msg: 'listen: callbacks: pass failed',
            data: { error: 'Error: disk gone' },
          },
        ],
        posts: 0,
        row: 'pending - 0',
      });
    });
  },
);

describe('callback C3d-A — on a real SQLite home', { timeout: 120_000 }, () => {
  it('a finished run whose key was deleted, 4 days on: the pass ends it; inspect prints "Callback: expired", the read address says failed and expired, countWaiting no longer counts it; a row whose finished_at is 4 days back ends too; a run made 4 days ago that ended 2 days ago, and one still running, are left', async () => {
    const clock = settableClock(C0);
    const h = await makeTempHome({
      clock,
      sealer: createCallbackKeySealer(Buffer.from(MASTER, 'hex')),
    });
    onTestFinished(() => h.cleanup());
    const store = h.home.runStore;
    const callbacks = store.callbacks!;
    const definition = workflow(
      W,
      sharedSecretTrigger('/refunds', { approved: 'context.resources.review.approved' }),
    );
    await h.home.workflowStore.register(definition);
    const host = 'hooks.example.com:443';
    const create = async (end = true): Promise<string> => {
      const { record } = await store.create({
        workflowId: W,
        workflowVersion: 1,
        params: {},
        callback: { url: 'https://hooks.example.com/cb', host, webhook_id: randomUUID() },
      });
      if (end) await abandonRun(store, record.id);
      return record.id;
    };
    await callbacks.keys.make(W, host, KEY);
    const common = await create();
    // Made now beside it: a run that ends only 2 days later, and one that never ends.
    const lateEnd = await create(false);
    const running = await create(false);
    await callbacks.keys.delete(W, host);
    await clock.advance(2 * DAY);
    await abandonRun(store, lateEnd);
    await clock.advance(2 * DAY);
    // The second row's run ends now; its finished_at is set by hand to 4 days back.
    const handSet = await create();
    const c = await openForeignConnection(join(h.root, '.realm'));
    try {
      c.prepare('UPDATE callbacks SET finished_at = ? WHERE run_id = ?').run(C0, handSet);
    } finally {
      c.close();
    }
    const waitingBefore = await callbacks.countWaiting();
    const logger = capturingLogger();
    await makeCallbackPass({
      callbacks,
      getRun: async (id) => (await store.get(id)).record,
      entryOf: () => undefined,
      disclosureProvider: async () => emptySet(),
      lists: { public: [], private: [] },
      ownPort: 1,
      logger,
    })(live);
    const waitingAfter = await callbacks.countWaiting();
    const s = await serve([definition], {
      store,
      over: { callbackLists: { public: [], private: [] } },
    });
    const readOf = async (id: string) =>
      JSON.parse((await read(s.port, '/refunds', id, `Bearer ${s.code('/refunds', id)}`)).body)[
        'callback'
      ];
    const readAddress = { common: await readOf(common), handSet: await readOf(handSet) };
    const left = {
      lateEnd: (await callbacks.read(lateEnd))?.status,
      running: (await callbacks.read(running))?.status,
    };
    await h.home.close();
    const inspect = spawnSync(process.execPath, [CLI, 'run', 'inspect', common], {
      cwd: h.root,
      env: { PATH: process.env['PATH'] ?? '', HOME: h.root, NO_COLOR: '1', REALM_NO_NUDGE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    // (1) red when the anchor is read from `created_at` (the run that ended 2 days ago is ended) or
    //     only from the run (the hand-set row is left), the `terminal_state` join is dropped (the
    //     running run's row is ended), or the pass does not sweep; (2) prints the counts, the lines,
    //     the rows left, the read address's callbacks and the inspect line.
    expect({
      waiting: [waitingBefore, waitingAfter],
      lines: logger.lines.map((l) => l.msg).sort(),
      left,
      readAddress,
      inspect: {
        code: inspect.status,
        expired: (inspect.stdout + inspect.stderr)
          .split('\n')
          .filter((l) => l.startsWith('Callback:'))
          .map((l) => l.startsWith('Callback: expired')),
      },
    }).toEqual({
      waiting: [3, 1],
      lines: [
        // The run that ended 2 days ago is listed, and this pass mounts no workflow.
        `callbacks: ${W} is not mounted by this realm listen, so its callbacks wait`,
        `callbacks: ${W} → ${host}: never sent: its time limit passed before a try could be made`,
        `callbacks: ${W} → ${host}: never sent: its time limit passed before a try could be made`,
      ],
      left: { lateEnd: 'pending', running: 'pending' },
      readAddress: {
        common: { state: 'failed', attempts: 0, last_status: 'expired' },
        handSet: { state: 'failed', attempts: 0, last_status: 'expired' },
      },
      inspect: { code: 0, expired: [true] },
    });
  });
});
