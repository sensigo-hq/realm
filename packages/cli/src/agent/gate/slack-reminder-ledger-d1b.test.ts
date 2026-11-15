// slack-reminder-ledger-d1b.test.ts — issue #597 D1b: `realm agent`'s Slack reminders and escalation
// go through the run store's outbound ledger. Each decision leases its occurrence, posts, then marks
// it, so a second agent or a restart does not repeat it, and a lost post is retried once at the
// lease's deadline. A lease that throws at a reminder's own instant posts unrecorded (one console line
// per process); at a catch-up or a retry it posts nothing. A restarted agent that took over the
// question's post sends ONE catch-up reminder (never the final, never for a first-time post, never
// without an authored schedule).
//
// The ledger is a real one (`InMemoryStore({ clock }).outbound`) over a run whose question is open; the
// store's clock is the notifier's wake clock, so the ledger reads the instant a waiter fires at.
// Slack is a stubbed `fetch`. The instants are in 2033.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  writtenSnapshot,
  type OutboundLedger,
  type OutboundResult,
  type PendingGate,
  type RunRecord,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  resetLeaseThrowWarningForTests,
  startGateReminderTimers,
  type ReminderLedger,
} from './slack-gate-notifier.js';
import { slackResponse } from '../test-support/slack-response.js';
import { wakeClock, type WakeClock } from '../test-support/wake-clock.js';

const OPENED = '2033-01-01T00:00:00.000Z';
const OPENED_MS = Date.parse(OPENED);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const plus = (ms: number): Date => new Date(OPENED_MS + ms);
const FAR = 999_999_999;
const GATE_ID = 'g-d1b';

const open = (age: string): string =>
  `⏰ gate \`review_step\` has been open for ${age} (since 2033-01-01T00:00:00Z). Please respond.`;

/** Lets the posts and marks the waiters started settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

let texts: string[];
let calls: string[];
let warns: string[];
/** What Slack answers to the next post (default: ok). */
let answer: () => Promise<Response>;

beforeEach(() => {
  texts = [];
  calls = [];
  warns = [];
  answer = () => Promise.resolve(slackResponse({ json: { ok: true } }));
  resetLeaseThrowWarningForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warns.push(a.join(' '));
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      texts.push((JSON.parse(init.body as string) as { text: string }).text);
      calls.push('post');
      return answer();
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Rig {
  readonly clock: WakeClock;
  readonly store: InMemoryStore;
  readonly runId: string;
  readonly record: RunRecord;
  readonly ledger: OutboundLedger;
}

/** A run waiting at `review_step`, its question opened at OPENED with `fields`, on a wake clock. */
async function rig(fields: Record<string, unknown>): Promise<Rig> {
  const clock = wakeClock(plus(0));
  const store = new InMemoryStore({ clock });
  const { record } = await store.create({ workflowId: 'd1b', workflowVersion: 1, params: {} });
  const gate = {
    gate_id: GATE_ID,
    step_name: 'review_step',
    preview: { headline: 'Deploy' },
    choices: ['approve', 'reject'],
    opened_at: OPENED,
    ...fields,
  } as unknown as PendingGate;
  const waiting = {
    ...record,
    run_phase: 'gate_waiting',
    in_progress_steps: ['review_step'],
    pending_gate: gate,
  } as RunRecord;
  await store.update(waiting);
  return { clock, store, runId: record.id, record: waiting, ledger: store.outbound! };
}

/** The ledger with some of its calls replaced (the rest forwarded). */
function wrap(ledger: OutboundLedger, over: Partial<OutboundLedger> = {}): OutboundLedger {
  return {
    lease: (id, req) => ledger.lease(id, req),
    mark: (id, req) => ledger.mark(id, req),
    read: (id) => ledger.read(id),
    statAllForRun: (id) => ledger.statAllForRun(id),
    deleteAllForRun: (id) => ledger.deleteAllForRun(id),
    ...over,
  };
}

/** The ledger, recording each lease and mark in `calls`, in order with the posts. */
const recording = (ledger: OutboundLedger): OutboundLedger =>
  wrap(ledger, {
    lease: (id, req) => {
      const w = req.what;
      calls.push(`lease ${w.type}${w.type === 'reminder' ? ` ${w.occurrence}` : ''}`);
      return ledger.lease(id, req);
    },
    mark: (id, req) => {
      calls.push(`mark ${req.result} ${req.outcome}`);
      return ledger.mark(id, req);
    },
  });

interface StartOptions {
  readonly reminderIntervalMs?: number;
  readonly escalationMs?: number;
  /** The ledger the notifier uses; `'none'` starts it with no ledger, as today. */
  readonly ledger?: OutboundLedger | 'none';
  readonly takenOver?: boolean;
  /** The reading the notifier attaches at (OPENED when absent); the clock is moved there first. */
  readonly at?: Date;
}

/** Starts the notifier for the rig's question; returns its cleanup. */
async function start(r: Rig, o: StartOptions = {}): Promise<() => void> {
  const at = o.at ?? plus(0);
  if (at.getTime() !== r.clock.now().getTime()) await r.clock.set(at);
  const ledger: ReminderLedger | undefined =
    o.ledger === 'none'
      ? undefined
      : {
          outbound: o.ledger ?? r.ledger,
          gateId: GATE_ID,
          ...(o.takenOver === true ? { takenOver: true } : {}),
        };
  return startGateReminderTimers(
    'xoxb-test',
    'C123',
    '1234567890.000',
    writtenSnapshot(r.record, at),
    o.reminderIntervalMs ?? FAR,
    o.escalationMs ?? FAR,
    r.clock,
    r.runId,
    undefined,
    true,
    ledger,
  );
}

/** The rows' statuses, by occurrence (`e` for the escalation). */
async function statuses(r: Rig): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const row of await r.ledger.read(r.runId)) {
    out[row.type === 'escalation' ? 'e' : String(row.occurrence)] = row.status;
  }
  return out;
}

/** A lease answer: held by another sender until `deadline`. */
const heldUntil = (deadline: Date): OutboundResult => ({
  applied: false,
  reason: 'lease_held',
  entry: {
    entry_key: `gate:${GATE_ID}:reminder:1`,
    type: 'reminder',
    occurrence: 1,
    of_max: 3,
    status: 'pending',
    lease_deadline: deadline.toISOString(),
    attempts: 1,
    created_at: plus(0).toISOString(),
  },
});

const SERIES = { reminder_seconds: 600, reminder_max: 3 };
const LEASE_THREW = (cause: string): string =>
  `  ⚠  Could not lease a reminder in the store's outbound ledger (${cause}): a reminder due now is posted without being recorded; a catch-up or a retry is not posted.`;

describe('#597 D1b — the reminders lease, post, then mark', () => {
  it('lease before post: the notifier leases the occurrence, posts, then marks it `sent`', async () => {
    // (a) red when the post comes before the lease, or the mark is skipped; (b) prints the calls in
    //     order and the rows.
    const r = await rig(SERIES);
    const clear = await start(r, { ledger: recording(r.ledger) });
    await r.clock.set(plus(10 * MIN));
    await settle();
    clear();
    expect({ calls, texts, rows: await statuses(r) }).toEqual({
      calls: ['lease reminder 1', 'post', 'mark sent ok'],
      texts: [open('10m')],
      rows: { '1': 'sent' },
    });
  });

  it('a mark that throws: the post stands, one line says it could not be recorded, NO retry, the agent carries on', async () => {
    // (a) red when the occurrence is retried (a certain duplicate), the false "Reminder post failed"
    //     line prints, or the next occurrence does not post; (b) prints the posts and the lines.
    const r = await rig(SERIES);
    const clear = await start(r, {
      ledger: wrap(r.ledger, {
        mark: async () => {
          throw new Error('disk I/O error');
        },
      }),
    });
    await r.clock.set(plus(10 * MIN));
    await settle();
    await r.clock.set(plus(15 * MIN)); // past any retry of occurrence 1 (its lease: 12 min)
    await settle();
    const afterFirst = [...texts];
    await r.clock.set(plus(20 * MIN));
    await settle();
    clear();
    expect({ afterFirst, texts, warns }).toEqual({
      afterFirst: [open('10m')],
      texts: [open('10m'), open('20m')],
      warns: [
        '  ⚠  Reminder posted, could not be recorded: disk I/O error',
        '  ⚠  Reminder posted, could not be recorded: disk I/O error',
      ],
    });
  });

  it('a lease that throws at the scheduled instant: one unrecorded post per occurrence, one console line per process', async () => {
    // (a) red when a throwing lease silences the reminder, or the line prints at each occurrence;
    //     (b) prints the posts and the lines.
    const r = await rig(SERIES);
    const clear = await start(r, {
      ledger: wrap(r.ledger, {
        lease: async () => {
          throw new Error('database is locked');
        },
      }),
    });
    await r.clock.set(plus(10 * MIN));
    await settle();
    await r.clock.set(plus(20 * MIN));
    await settle();
    clear();
    expect({ texts, warns, rows: await statuses(r) }).toEqual({
      texts: [open('10m'), open('20m')],
      warns: [LEASE_THREW('database is locked')],
      rows: {},
    });
  });

  it('a lease that throws at the catch-up or at a retry posts NOTHING', async () => {
    // (a) red when a catch-up or a retry posts unrecorded (a fenced store would re-post at every
    //     restart); (b) prints the posts, the lease calls and the lines.
    const r1 = await rig(SERIES);
    const throwing = wrap(r1.ledger, {
      lease: async () => {
        throw new Error('the store is fenced');
      },
    });
    const clear1 = await start(r1, { ledger: throwing, takenOver: true, at: plus(25 * MIN) });
    await settle();
    clear1();
    const catchUp = [...texts];
    resetLeaseThrowWarningForTests();
    // A retry: the first lease is held by another sender until 11 min, the retry's lease throws.
    const r2 = await rig(SERIES);
    let leases = 0;
    const clear2 = await start(r2, {
      ledger: wrap(r2.ledger, {
        lease: async () => {
          leases += 1;
          if (leases === 1) return heldUntil(plus(11 * MIN));
          throw new Error('the store is fenced');
        },
      }),
    });
    await r2.clock.set(plus(10 * MIN));
    await settle();
    await r2.clock.set(plus(11 * MIN));
    await settle();
    clear2();
    expect({ catchUp, retry: texts.slice(catchUp.length), leases, warns }).toEqual({
      catchUp: [],
      retry: [],
      leases: 2,
      warns: [LEASE_THREW('the store is fenced'), LEASE_THREW('the store is fenced')],
    });
  });

  it('a question that closes while a retry waits: the retry is cancelled with the other waiters, nothing posts', async () => {
    // (a) red when the retry's waiter is not in the cleanup (it fires on a closed question); (b)
    //     prints the posts, the lease calls and the waiters left.
    const r = await rig(SERIES);
    let leases = 0;
    const clear = await start(r, {
      ledger: wrap(r.ledger, {
        lease: async (id, req) => {
          leases += 1;
          return leases === 1 ? heldUntil(plus(11 * MIN)) : r.ledger.lease(id, req);
        },
      }),
    });
    await r.clock.set(plus(10 * MIN));
    await settle();
    const waitingWithRetry = r.clock.waiting();
    clear(); // the question closed
    await r.clock.set(plus(12 * MIN));
    await settle();
    expect({ texts, leases, waitingWithRetry, waitingAfter: r.clock.waiting() }).toEqual({
      texts: [],
      leases: 1,
      // k = 2, k = 3, the escalation and the retry
      waitingWithRetry: 4,
      waitingAfter: 0,
    });
  });

  it('no ledger = today: with none, and with a lease that throws, the posts are byte-identical to today', async () => {
    // (a) red when the unfenced path's post differs from today's (another text, another body);
    //     (b) prints the bodies of each path.
    const bodies = (): string[] =>
      (vi.mocked(fetch).mock.calls as Array<[string, RequestInit]>).map(
        ([url, init]) => `${url} ${init.body as string}`,
      );
    const today = await rig(SERIES);
    const clear1 = await start(today, { ledger: 'none' });
    await today.clock.set(plus(20 * MIN));
    await settle();
    clear1();
    const none = bodies();
    vi.mocked(fetch).mockClear();
    const thrown = await rig(SERIES);
    // The same run id, so the respond way in the text is the same.
    const clear2 = await start(
      { ...thrown, runId: today.runId },
      {
        ledger: wrap(thrown.ledger, {
          lease: async () => {
            throw new Error('database is locked');
          },
        }),
      },
    );
    await thrown.clock.set(plus(20 * MIN));
    await settle();
    clear2();
    const throwing = bodies();
    expect(
      { none: none.length, same: throwing.join('\n') === none.join('\n') },
      throwing.join('\n'),
    ).toEqual({
      none: 2,
      same: true,
    });
  });

  it('contention: two notifiers sharing one ledger, one occurrence: exactly one post', async () => {
    // (a) red when both post (no lease, or a lease that does not hold the other off), or the loser's
    //     retry posts again; (b) prints the posts and the rows.
    const r = await rig(SERIES);
    const clearA = await start(r);
    const clearB = await start(r);
    await r.clock.set(plus(10 * MIN));
    await settle();
    await r.clock.set(plus(13 * MIN)); // past the loser's retry at the lease's deadline (12 min)
    await settle();
    clearA();
    clearB();
    const [row] = await r.ledger.read(r.runId);
    expect({ texts, status: row?.status, attempts: row?.attempts }).toEqual({
      texts: [open('10m')],
      status: 'sent',
      attempts: 1,
    });
  });

  it('restart: an agent restarted after the reminder was marked does not send it again; the default population’s reminder and escalation likewise once', async () => {
    // (a) red when a restart repeats a marked reminder or escalation (no lease, or the catch-up
    //     ignores the ledger); (b) prints the posts of each half.
    const series = await rig(SERIES);
    const first = await start(series);
    await series.clock.set(plus(10 * MIN));
    await settle();
    first(); // the agent stops
    const restarted = await start(series, { takenOver: true, at: plus(10 * MIN + 30 * SEC) });
    await settle();
    await series.clock.set(plus(20 * MIN));
    await settle();
    restarted();
    const seriesPosts = [...texts];
    texts.length = 0;
    const fallback = await rig({});
    const one = await start(fallback, { reminderIntervalMs: 10 * MIN, escalationMs: 30 * MIN });
    await fallback.clock.set(plus(30 * MIN));
    await settle();
    one();
    const two = await start(fallback, {
      reminderIntervalMs: 10 * MIN,
      escalationMs: 30 * MIN,
      takenOver: true,
      at: plus(31 * MIN),
    });
    await fallback.clock.set(plus(2 * HOUR));
    await settle();
    two();
    expect({ series: seriesPosts, fallback: texts.length, rows: await statuses(fallback) }).toEqual(
      {
        series: [open('10m'), open('20m')],
        fallback: 2,
        rows: { '1': 'sent', e: 'sent' },
      },
    );
  });

  it('`lease_held`: the held loser retries once at the lease’s deadline and posts when the holder never marked', async () => {
    // (a) red when the loser is silent forever, retries before the deadline, or retries again
    //     after posting; (b) prints the posts at each instant and the row.
    const r = await rig(SERIES);
    await r.clock.set(plus(9 * MIN + 30 * SEC));
    const held = await r.ledger.lease(r.runId, {
      what: { type: 'reminder', gateId: GATE_ID, occurrence: 1 },
      leaseToken: 'a-stopped-agent',
      leaseSeconds: 120,
    });
    if (!held.applied) throw new Error(`fixture: ${held.reason}`);
    const clear = await start(r, { at: plus(9 * MIN + 30 * SEC) });
    await r.clock.set(plus(10 * MIN)); // occurrence 1: held until 11 min 30 s
    await settle();
    const atTen = texts.length;
    await r.clock.set(plus(11 * MIN + 30 * SEC - 1));
    await settle();
    const beforeDeadline = texts.length;
    // The retry, 90 s after the occurrence's instant (past #964's 60-s grace): composed at its own
    // reading.
    await r.clock.set(plus(11 * MIN + 30 * SEC));
    await settle();
    await r.clock.set(plus(15 * MIN));
    await settle();
    clear();
    const [row] = await r.ledger.read(r.runId);
    expect({ atTen, beforeDeadline, texts, status: row?.status, attempts: row?.attempts }).toEqual({
      atTen: 0,
      beforeDeadline: 0,
      texts: [open('11m')],
      status: 'sent',
      attempts: 2,
    });
  });

  it('the mark table at the notifier: `ok` marked sent; `channel_not_found` marked failed, not retried; `invalid_auth` and a network error unmarked and retried once', async () => {
    // (a) red when a permanent refusal is retried, an auth-class refusal is marked `failed`, or an
    //     unmarked outcome is retried more than once or never; (b) prints each case's posts and row.
    const cases: Record<string, () => Promise<Response>> = {
      ok: () => Promise.resolve(slackResponse({ json: { ok: true } })),
      channel_not_found: () =>
        Promise.resolve(slackResponse({ json: { ok: false, error: 'channel_not_found' } })),
      invalid_auth: () =>
        Promise.resolve(slackResponse({ json: { ok: false, error: 'invalid_auth' } })),
      network: () => Promise.reject(new TypeError('fetch failed')),
    };
    const got: Record<string, unknown> = {};
    for (const [name, respond] of Object.entries(cases)) {
      answer = respond;
      texts.length = 0;
      const r = await rig({ reminder_seconds: 600, reminder_max: 1 });
      const clear = await start(r);
      await r.clock.set(plus(10 * MIN));
      await settle();
      await r.clock.set(plus(12 * MIN)); // the retry, at the lease's deadline
      await settle();
      await r.clock.set(plus(20 * MIN)); // a second retry would have fired by now
      await settle();
      clear();
      got[name] = { posts: texts.length, row: (await statuses(r))['1'] };
    }
    expect(got).toEqual({
      ok: { posts: 1, row: 'sent' },
      channel_not_found: { posts: 1, row: 'failed' },
      invalid_auth: { posts: 2, row: 'pending' },
      network: { posts: 2, row: 'pending' },
    });
  });

  it('duplicate words: a mark answering `outbound_done` says "duplicate certain", `lease_lost` "duplicate possible"; the agent carries on', async () => {
    // (a) red when the agent fails or is silent on either answer, or the two lines are swapped;
    //     (b) prints the lines and the posts.
    const lines: Record<string, unknown> = {};
    for (const reason of ['outbound_done', 'lease_lost'] as const) {
      warns.length = 0;
      texts.length = 0;
      const r = await rig(SERIES);
      const clear = await start(r, {
        ledger: wrap(r.ledger, {
          mark: async (id, req) =>
            req.what.type === 'reminder' && req.what.occurrence === 1
              ? { applied: false, reason }
              : r.ledger.mark(id, req),
        }),
      });
      await r.clock.set(plus(10 * MIN));
      await settle();
      await r.clock.set(plus(20 * MIN));
      await settle();
      clear();
      lines[reason] = { warns: [...warns], posts: texts.length };
    }
    expect(lines).toEqual({
      outbound_done: {
        warns: ['  ⚠  Reminder posted, but another agent had sent it: duplicate certain.'],
        posts: 2,
      },
      lease_lost: {
        warns: [
          '  ⚠  Reminder posted, but another agent took its lease over meanwhile: duplicate possible.',
        ],
        posts: 2,
      },
    });
  });

  it('`repeats` while the lease yields: cells 7a and 7b of #964 post ONE line, against a ledger whose lease yields to the event loop', async () => {
    // (a) red when the last line posted is set after the lease (both decisions compare against no
    //     line and the same line posts twice); (b) prints the posts of each case.
    const yielding = (r: Rig): OutboundLedger =>
      wrap(r.ledger, {
        lease: async (id, req) => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return r.ledger.lease(id, req);
        },
      });
    const run = async (
      fields: Record<string, unknown>,
      reminderIntervalMs: number,
      escalationMs: number,
      wakeAt: Date,
    ): Promise<string[]> => {
      texts.length = 0;
      const r = await rig(fields);
      const clear = await start(r, { reminderIntervalMs, escalationMs, ledger: yielding(r) });
      await r.clock.wake(wakeAt);
      await settle();
      clear();
      return [...texts];
    };
    const series20 = { reminder_seconds: 600, reminder_max: 20 };
    expect({
      '7a series': await run(series20, FAR, 45 * MIN, plus(65 * MIN)),
      '7a fallback': await run({}, 45 * MIN, 30 * MIN, plus(3 * HOUR)),
      '7b series': await run(series20, FAR, 63 * MIN, plus(65 * MIN)),
      '7b fallback': await run({}, 10 * MIN, 30 * MIN, plus(8 * HOUR)),
    }).toEqual({
      '7a series': [open('1h 5m')],
      '7a fallback': [open('3h 0m')],
      '7b series': [open('1h 5m')],
      '7b fallback': [open('8h 0m')],
    });
  });
});

describe('#597 D1b — the catch-up at attach', () => {
  it('a takeover after the interval: ONE reminder for the latest passed occurrence, with the true age; the older ones are skipped', async () => {
    // (a) red when no catch-up is sent, two are (a burst), the age is the scheduled one, or an older
    //     occurrence is leased; (b) prints the posts and the rows.
    const r = await rig(SERIES);
    const clear = await start(r, { takenOver: true, at: plus(25 * MIN) });
    await settle();
    clear();
    expect({ texts, rows: await statuses(r) }).toEqual({
      texts: [open('25m')],
      rows: { '2': 'sent' },
    });
  });

  it('a first-time post by a late agent: no catch-up', async () => {
    // (a) red when a first-time post is followed seconds later by a reminder; (b) prints the posts.
    const r = await rig(SERIES);
    const clear = await start(r, { at: plus(25 * MIN) });
    await settle();
    clear();
    expect(texts).toEqual([]);
  });

  it('a takeover after `expires_at` of an `on_expiry` gate: no final, no catch-up', async () => {
    // (a) red when the final (or a closed occurrence) is caught up; (b) prints the posts.
    const r = await rig({
      ...SERIES,
      expires_at: plus(30 * MIN).toISOString(),
      on_expiry: 'abort',
    });
    const clear = await start(r, { takenOver: true, at: plus(35 * MIN) });
    await settle();
    clear();
    expect({ texts, rows: await statuses(r) }).toEqual({ texts: [], rows: {} });
  });

  it('a takeover of a gate with no authored schedule: no catch-up (its one reminder stays attach-relative)', async () => {
    // (a) red when the default population gets a catch-up at attach; (b) prints the posts.
    const r = await rig({});
    const clear = await start(r, {
      reminderIntervalMs: 10 * MIN,
      takenOver: true,
      at: plus(25 * MIN),
    });
    await settle();
    const atAttach = [...texts];
    await r.clock.set(plus(35 * MIN));
    await settle();
    clear();
    expect({ atAttach, texts }).toEqual({ atAttach: [], texts: [open('35m')] });
  });
});
