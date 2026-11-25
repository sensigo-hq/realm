// delivery-pass-c3db.test.ts — callback C3d-B (R1.3): what the pass now says, and its sweep's repeat.
// The pass over the in-memory store and its settable clock, with real loopback receivers (C3a's and
// C3d-A's seams):
//   - the "no signing key" line is said once per (workflow, host, key state), and again after the
//     pair's key was found and then lost; another pair's memory is untouched;
//   - the `unexpected error` line is said once per (run, error class);
//   - the overdue sweep asks again while a round expires a full 1,000, within the pass's budget, and
//     names the first 10 of the whole pass, then one count line;
// and the BUILT `realm run inspect` on a real SQLite home for a due row after a 503 and for a row
// the sweep expired before any try.
//
// No cell depends on the order of random ids: where rows tie, the lines are compared as sorted sets.
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abandonRun, executeStep, type RunStore } from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { createCallbackKeySealer } from '@sensigo/realm-store-sqlite';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { makePollRunner } from '../../commands/listen-reminders.js';
import { makeTempHome } from '../../test-support/temp-home.js';
import {
  capturingLogger,
  emptySet,
  ENV,
  sharedSecretTrigger,
  workflow,
} from '../../test-support/listen-read-r11.js';
import { deriveReadKey, type ReadEntry } from '../run-read-address.js';
import { parseCallbackEntry, type CallbackLists } from './allow-list.js';
import { makeCallbackPass, type CallbackPassDeps } from './delivery-pass.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..', '..');
const CLI = join(HERE, '..', '..', '..', 'dist', 'index.js');
const W = 'refunds';
const C0 = '2026-11-20T12:00:00.000Z';
const KEY = '1a'.repeat(32);
const MASTER = '5c'.repeat(32);
const DAY = 86_400_000;
const live = (): boolean => true;

afterEach(() => {
  vi.restoreAllMocks();
});

const allow = (text: string) => {
  const r = parseCallbackEntry(text);
  if (!r.ok) throw new Error(`fixture: ${text} refused ${r.word}`);
  return r.entry;
};

/** A loopback receiver answering `status` to every POST; closed after the cell. */
async function receiver(status = 200): Promise<{ host: string; url: string; posts: () => number }> {
  let posts = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      posts += 1;
      res.writeHead(status);
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
  return { host, url: `http://${host}/cb`, posts: () => posts };
}
const listsOf = (...hosts: string[]): CallbackLists => ({
  public: [],
  private: hosts.map((h) => allow(`http://${h}`)),
});

const definition = workflow(
  W,
  sharedSecretTrigger('/refunds', { approved: 'context.resources.review.approved' }),
);

/** A run with a callback to `url` (`host`): finished with a result (its body can be built), or
 *  abandoned when `complete` is false; its id. */
async function runOn(store: RunStore, url: string, host: string, complete = true): Promise<string> {
  const { record } = await store.create({
    workflowId: W,
    workflowVersion: 1,
    params: {},
    callback: { url, host, webhook_id: randomUUID() },
  });
  if (complete) {
    await executeStep(store, definition, {
      runId: record.id,
      command: 'review',
      input: { approved: true },
      dispatcher: async (_c, input) => input,
    });
  } else await abandonRun(store, record.id);
  return record.id;
}

/** The in-memory store on a settable clock, `refunds` mounted, a logger and a pass maker. */
async function world() {
  const clock = settableClock(C0);
  const store = new InMemoryStore({ clock });
  const callbacks = store.callbacks!;
  const mounted: ReadEntry = {
    path: '/refunds',
    definition,
    readKey: await deriveReadKey(ENV['READ_SECRET']!, W),
  };
  const logger = capturingLogger();
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
  const said = (): string[] => logger.lines.map((l) => `${l.level} ${l.msg}`);
  return { clock, store, callbacks, mounted, logger, pass, said };
}

const noKey = (host: string) =>
  `warn callbacks: ${W} → ${host}: no signing key this process can read (none), so its callbacks wait`;

describe(
  'callback C3d-B — the pass says a lost key again, and an error once',
  { timeout: 60_000 },
  () => {
    it('one pair: its no-key line once over three passes; the key made and the row tried: no line; the key deleted: the line once again', async () => {
      const w = await world();
      const r = await receiver(503);
      await runOn(w.store, r.url, r.host);
      const pass = w.pass(listsOf(r.host));
      const count = (): number => w.said().filter((l) => l === noKey(r.host)).length;
      const seen: number[] = [];
      for (let i = 0; i < 3; i++) {
        await pass(live);
        seen.push(count());
      }
      await w.callbacks.keys.make(W, r.host, KEY);
      await pass(live);
      seen.push(count());
      await w.callbacks.keys.delete(W, r.host);
      for (let i = 0; i < 2; i++) {
        // Past the retry wait (about 1 s for the first try), so the row is due again.
        await w.clock.advance(5_000);
        await pass(live);
        seen.push(count());
      }
      // (1) red when the memory is never dropped (the line is not said again after the loss), or
      //     dropped every pass (said each time); (2) prints the count after each pass and the POSTs.
      expect({ seen, posts: r.posts() }).toEqual({ seen: [1, 1, 1, 1, 2, 2], posts: 1 });
    });

    it('two pairs: A readable and tried every pass, B with no key across three passes: B’s line ONCE', async () => {
      const w = await world();
      const a = await receiver(503);
      const b = await receiver(200);
      await w.callbacks.keys.make(W, a.host, KEY);
      await runOn(w.store, a.url, a.host);
      await runOn(w.store, b.url, b.host);
      const pass = w.pass(listsOf(a.host, b.host));
      for (let i = 0; i < 3; i++) {
        await pass(live);
        await w.clock.advance(60_000);
      }
      // (1) red when a readable key drops every pair's memory (B said each pass), or A's try does not
      //     happen each pass; (2) prints B's lines and A's POSTs.
      expect({ b: w.said().filter((l) => l === noKey(b.host)), aPosts: a.posts() }).toEqual({
        b: [noKey(b.host)],
        aPosts: 3,
      });
    });

    it('an unexpected error: once for a run and its error class over three passes; another class says its own; another run with the first class says its own', async () => {
      const w = await world();
      const r = await receiver(200);
      await w.callbacks.keys.make(W, r.host, KEY);
      const first = await runOn(w.store, r.url, r.host);
      const second = await runOn(w.store, r.url, r.host);
      let firstThrows: () => Error = () => new TypeError('the store went away');
      const pass = w.pass(listsOf(r.host), {
        getRun: async (id) => {
          throw id === first ? firstThrows() : new TypeError('the store went away');
        },
      });
      const line = (cls: string, id: string) =>
        `error callbacks: ${W} → ${r.host}: unexpected error (${cls}) for run ${id}`;
      for (let i = 0; i < 3; i++) {
        await pass(live);
        // Past the claim's 60 s lease, so both rows are due again.
        await w.clock.advance(61_000);
      }
      const threePasses = w
        .said()
        .filter((l) => l.startsWith('error '))
        .sort();
      firstThrows = () => new RangeError('another failure');
      await pass(live);
      const errors = w
        .said()
        .filter((l) => l.startsWith('error '))
        .sort();
      // (1) red when the line is said once per row per pass (three times), a second class is folded
      //     into the first, or one run's memory silences another's; (2) prints the error lines.
      expect({ threePasses, errors }).toEqual({
        threePasses: [line('TypeError', first), line('TypeError', second)].sort(),
        errors: [
          line('TypeError', first),
          line('TypeError', second),
          line('RangeError', first),
        ].sort(),
      });
    });
  },
);

const neverSent = (host: string) =>
  `warn callbacks: ${W} → ${host}: never sent: its time limit passed before a try could be made`;

describe(
  'callback C3d-B — the sweep asks again while a round expires a full 1,000',
  { timeout: 120_000 },
  () => {
    /** A world with `n` rows of a mounted workflow with a key, 4 days after their runs ended. */
    async function overdue(n: number) {
      const w = await world();
      const r = await receiver(200);
      await w.callbacks.keys.make(W, r.host, KEY);
      for (let i = 0; i < n; i++) await runOn(w.store, r.url, r.host, false);
      await w.clock.advance(4 * DAY);
      return { w, r, lists: listsOf(r.host) };
    }
    const pendingCount = async (store: RunStore): Promise<number> =>
      store.callbacks!.countWaiting();

    it('1,005 overdue rows: all expired by the sweep, 10 lines and ONE count line for the other 995; no line from the claim path and no try', async () => {
      const { w, r, lists } = await overdue(1005);
      const answer = await w.pass(lists)(live);
      // (1) red when the sweep asks once (5 rows reach the claim path and say `stopped at attempt 1`
      //     each), says the count per round, or names more than 10; (2) prints the lines, the answer,
      //     the rows left waiting and the POSTs.
      expect({
        said: w.said(),
        answer,
        waiting: await pendingCount(w.store),
        posts: r.posts(),
      }).toEqual({
        said: [
          ...Array.from({ length: 10 }, () => neverSent(r.host)),
          'warn callbacks: and 995 more callbacks ended the same way',
        ],
        answer: false,
        waiting: 0,
        posts: 0,
      });
    });

    it('a pass that is not live after the first round asks no more: 1,000 expired, the rest left, 10 lines and the count for the 990', async () => {
      const { w, r, lists } = await overdue(1005);
      let asked = 0;
      const answer = await w.pass(lists)(() => (asked += 1) < 1);
      // (1) red when the sweep asks again although the pass is no longer live; (2) prints the lines,
      //     the answer and the rows left.
      expect({
        said: w.said(),
        answer,
        waiting: await pendingCount(w.store),
        posts: r.posts(),
      }).toEqual({
        said: [
          ...Array.from({ length: 10 }, () => neverSent(r.host)),
          'warn callbacks: and 990 more callbacks ended the same way',
        ],
        answer: false,
        waiting: 5,
        posts: 0,
      });
    });

    it('round 2 rejects: the 10 lines and the count for round 1 are said, then the runner says the pass failed', async () => {
      const { w, r, lists } = await overdue(1005);
      let rounds = 0;
      const callbacks = new Proxy(w.callbacks, {
        get(t, prop) {
          if (prop === 'expireOverdue') {
            return (limit: number) => {
              rounds += 1;
              return rounds === 1
                ? t.expireOverdue(limit)
                : Promise.reject(new Error('the disk is gone'));
            };
          }
          const v = Reflect.get(t, prop, t) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
      });
      const runner = makePollRunner(w.pass(lists, { callbacks }), 'callbacks', w.logger);
      await runner.wake();
      await runner.stop();
      // (1) red when the lines or the count wait for the last round (none said: round 2 threw), or a
      //     throw is swallowed; (2) prints the lines and the rounds asked.
      expect({
        said: w.said().map((l) => l.replace(/\{.*$/, '').trimEnd()),
        rounds,
        posts: r.posts(),
      }).toEqual({
        said: [
          ...Array.from({ length: 10 }, () => neverSent(r.host)),
          'warn callbacks: and 990 more callbacks ended the same way',
          'error listen: callbacks: pass failed',
        ],
        rounds: 2,
        posts: 0,
      });
    });

    it('over the time budget after round 1: no round 2, and the pass answers true as when over budget', async () => {
      const { w, r, lists } = await overdue(1005);
      let t = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => t);
      let rounds = 0;
      const callbacks = new Proxy(w.callbacks, {
        get(target, prop) {
          if (prop === 'expireOverdue') {
            return async (limit: number) => {
              rounds += 1;
              const expired = await target.expireOverdue(limit);
              t = 45_000;
              return expired;
            };
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const answer = await w.pass(lists, { callbacks })(live);
      // (1) red when the repeat does not check the budget (a second round), or a pass cut by it answers
      //     false; (2) prints the answer, the rounds and the rows left.
      expect({ answer, rounds, waiting: await pendingCount(w.store), posts: r.posts() }).toEqual({
        answer: true,
        rounds: 1,
        waiting: 5,
        posts: 0,
      });
    });
  },
);

/** A `Callback:` line's shape: its instants and numbers stand for any (as docs-callback-c3c1 reads). */
const shape = (line: string): string =>
  line
    .replace(/\d+[smhd]( \d+[smhd])* ago \(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\)/g, '<ago>')
    .replace(/\d+/g, '<n>');
const blockLine = (page: string, starts: string): string | undefined =>
  readFileSync(join(ROOT, page), 'utf8')
    .split('\n')
    .find((l) => l.startsWith(starts));

describe(
  'callback C3d-B — the built `realm run inspect` on a real SQLite home',
  { timeout: 120_000 },
  () => {
    it('a row due after a 503 says its attempt, its last answer and what it waits for; a row the sweep expired before any try says expired before its first try; the pages show the due line in that shape', async () => {
      const clock = settableClock(C0);
      const h = await makeTempHome({
        clock,
        sealer: createCallbackKeySealer(Buffer.from(MASTER, 'hex')),
      });
      onTestFinished(() => h.cleanup());
      const store = h.home.runStore;
      await h.home.workflowStore.register(definition);
      const r = await receiver(503);
      await store.callbacks!.keys.make(W, r.host, KEY);
      const mounted: ReadEntry = {
        path: '/refunds',
        definition,
        readKey: await deriveReadKey(ENV['READ_SECRET']!, W),
      };
      const logger = capturingLogger();
      const pass = makeCallbackPass({
        callbacks: store.callbacks!,
        getRun: async (id) => (await store.get(id)).record,
        entryOf: (id) => (id === W ? mounted : undefined),
        disclosureProvider: async () => emptySet(),
        lists: listsOf(r.host),
        ownPort: 1,
        logger,
        random: () => 0.5,
      });
      const tried = await runOn(store, r.url, r.host);
      await pass(live);
      // Past the first retry wait (about 1 s): the row is due again, after one try.
      await clock.advance(5_000);
      const inspect = (id: string): string[] => {
        const out = spawnSync(process.execPath, [CLI, 'run', 'inspect', id], {
          cwd: h.root,
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: h.root,
            NO_COLOR: '1',
            REALM_NO_NUDGE: '1',
          },
          encoding: 'utf8',
          timeout: 60_000,
        });
        return (out.stdout + out.stderr).split('\n').filter((l) => l.startsWith('Callback:'));
      };
      await h.home.close();
      const due = inspect(tried);
      const h2 = await makeTempHome({
        clock,
        sealer: createCallbackKeySealer(Buffer.from(MASTER, 'hex')),
      });
      onTestFinished(() => h2.cleanup());
      const store2 = h2.home.runStore;
      await h2.home.workflowStore.register(definition);
      const never = await runOn(store2, r.url, r.host, false);
      await clock.advance(4 * DAY);
      await makeCallbackPass({
        callbacks: store2.callbacks!,
        getRun: async (id) => (await store2.get(id)).record,
        entryOf: () => undefined,
        disclosureProvider: async () => emptySet(),
        lists: listsOf(r.host),
        ownPort: 1,
        logger,
      })(live);
      await h2.home.close();
      const expired = (() => {
        const out = spawnSync(process.execPath, [CLI, 'run', 'inspect', never], {
          cwd: h2.root,
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: h2.root,
            NO_COLOR: '1',
            REALM_NO_NUDGE: '1',
          },
          encoding: 'utf8',
          timeout: 60_000,
        });
        return (out.stdout + out.stderr).split('\n').filter((l) => l.startsWith('Callback:'));
      })();
      const guide = blockLine('docs/guides/webhooks.md', 'Callback: due since ');
      const reading = blockLine('docs/reference/cli/realm-run-reading.md', 'Callback: due since ');
      // (1) red when `inspect` keeps the old due words, leaves out the attempt or the last answer
      //     after a try, says "sends it" or "tries again", keeps "expired at attempt 0", or the pages'
      //     due line is not the built program's shape; (2) prints the lines and the pages' lines.
      expect({
        due: due.map(shape),
        expired,
        guide: guide === undefined ? '(no due line)' : shape(guide),
        reading: reading === undefined ? '(no due line)' : shape(reading),
        posts: r.posts(),
      }).toEqual({
        due: [
          'Callback: due since <ago>, attempt <n>, last answer <n>; it waits for the next pass of a realm listen that can send it',
        ],
        expired: ['Callback: expired before its first try, not delivered within its time limit'],
        guide:
          'Callback: due since <ago>, attempt <n>, last answer <n>; it waits for the next pass of a realm listen that can send it',
        reading:
          'Callback: due since <ago>, attempt <n>, last answer <n>; it waits for the next pass of a realm listen that can send it',
        posts: 1,
      });
    });
  },
);
