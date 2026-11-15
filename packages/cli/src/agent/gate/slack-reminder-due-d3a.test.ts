// slack-reminder-due-d3a.test.ts — issue #597 D3a: `realm agent`'s Slack reminder of a question with no
// authored schedule and every question's nudge (the escalation) count from when the question was
// POSTED (its Slack time, clamped between `opened_at` and the reading), not from when the agent
// attached; the instants are core's one grid (`dueReminderWork`); an agent that took over a stopped
// agent's post sends at most ONE catch-up item, the reminder or the nudge, for any gate; and a reminder
// composed for a host that does not read replies in the thread says so and gives the command.
//
// The store is an `InMemoryStore` on a wake clock whose ledger is real; the question opens at OPENED
// (2033); Slack is a stubbed `fetch`. The authored cycles' cells are #964's and D1b's own files (the
// net): this file covers what D3a adds.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  writtenSnapshot,
  type OutboundLedger,
  type PendingGate,
  type RunRecord,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  composeReminderPost,
  resetLeaseThrowWarningForTests,
  startGateReminderTimers,
  type ReminderLedger,
} from './slack-gate-notifier.js';
import { slackResponse } from '../test-support/slack-response.js';
import { wakeClock, type WakeClock } from '../test-support/wake-clock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const OPENED = '2033-01-01T00:00:00.000Z';
const OPENED_MS = Date.parse(OPENED);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const plus = (ms: number): Date => new Date(OPENED_MS + ms);
const FAR = 999_999_999;
const GATE_ID = 'g-d3a';
/** A Slack message timestamp for an instant (seconds, six fractional digits). */
const tsOf = (d: Date): string => (d.getTime() / 1000).toFixed(6);
/** Slack's own form of a time in 2009, before the question opened (the D1b and #964 fixtures'). */
const OLD_TS = '1234567890.000';

const open = (age: string): string =>
  `⏰ gate \`review_step\` has been open for ${age} (since 2033-01-01T00:00:00Z). Please respond.`;
const owned = (age: string): string => `@ana — ${open(age)}`;

/** Lets the posts and marks the waiters started settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

let texts: string[];
let warns: string[];
let logs: string[];

beforeEach(() => {
  texts = [];
  warns = [];
  logs = [];
  resetLeaseThrowWarningForTests();
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
    warns.push(a.join(' '));
  });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      texts.push((JSON.parse(init.body as string) as { text: string }).text);
      return Promise.resolve(slackResponse({ json: { ok: true } }));
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
  const { record } = await store.create({ workflowId: 'd3a', workflowVersion: 1, params: {} });
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

interface StartOptions {
  readonly reminderIntervalMs?: number;
  readonly escalationMs?: number;
  /** The ledger; `'none'` starts the notifier with none. */
  readonly ledger?: OutboundLedger | 'none';
  readonly takenOver?: boolean;
  /** The reading the notifier attaches at (OPENED when absent); the clock is moved there first. */
  readonly at?: Date;
  /** The question post's Slack time (OPENED's when absent). */
  readonly ts?: string;
  readonly listens?: boolean;
}

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
    o.ts ?? tsOf(plus(0)),
    writtenSnapshot(r.record, at),
    o.reminderIntervalMs ?? FAR,
    o.escalationMs ?? FAR,
    r.clock,
    r.runId,
    undefined,
    o.listens ?? true,
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

/** A row another agent leased and marked sent, at `at` (the store's clock is moved there). */
async function sentBefore(
  r: Rig,
  what: { type: 'reminder'; occurrence: number } | { type: 'escalation' },
  at: Date,
): Promise<void> {
  await r.clock.set(at);
  const request = { what: { ...what, gateId: GATE_ID }, leaseToken: 'other-agent' } as const;
  await r.ledger.lease(r.runId, { ...request, leaseSeconds: 60 });
  await r.ledger.mark(r.runId, { ...request, result: 'sent', outcome: 'ok' });
}

describe('#597 D3a — the anchor: the question post’s time, clamped', () => {
  it('attached at the posting: the reminder is due interval after the post, with today’s text', async () => {
    // The post 2 s after the gate opened; the agent's reading 1 s later. (a) red when the reminder
    //     counts from the attach reading (nothing at +10 m 2 s) or from `opened_at`; (b) prints the
    //     posts at each instant.
    const r = await rig({});
    const clear = await start(r, {
      ts: tsOf(plus(2 * SEC)),
      at: plus(3 * SEC),
      reminderIntervalMs: 10 * MIN,
    });
    await r.clock.set(new Date(OPENED_MS + 10 * MIN + 2 * SEC - 1));
    await settle();
    const before = [...texts];
    await r.clock.set(plus(10 * MIN + 2 * SEC));
    await settle();
    clear();
    expect({ before, at: texts }).toEqual({ before: [], at: [open('10m')] });
  });

  it('a `ts` before `opened_at` clamps up to it; a `ts` after the reading clamps down to the reading', async () => {
    // (a) red when the lower clamp is removed (a 2009 `ts` puts the reminder in the past: nothing is
    //     armed) or the upper one (a `ts` an hour ahead puts it at +70 m); (b) prints the posts.
    const early = await rig({});
    const one = await start(early, { ts: OLD_TS, at: plus(5 * MIN), reminderIntervalMs: 10 * MIN });
    await early.clock.set(plus(10 * MIN));
    await settle();
    one();
    const clampedUp = [...texts];
    texts.length = 0;
    const late = await rig({});
    const two = await start(late, {
      ts: tsOf(plus(HOUR)),
      at: plus(5 * MIN),
      reminderIntervalMs: 10 * MIN,
    });
    await late.clock.set(plus(15 * MIN));
    await settle();
    two();
    expect({ clampedUp, clampedDown: texts }).toEqual({
      clampedUp: [open('10m')],
      clampedDown: [open('15m')],
    });
  });

  it('a `ts` that cannot be read: the reminder counts from the attach reading, and ONE console line says so, once per process', async () => {
    // (a) red when the fallback is removed (no reminder is armed) or its line is missing, reworded or
    //     printed twice; (b) prints the posts and the lines.
    const r = await rig({});
    const one = await start(r, { ts: 'not-a-ts', at: plus(5 * MIN), reminderIntervalMs: 10 * MIN });
    await r.clock.set(plus(15 * MIN));
    await settle();
    one();
    const again = await rig({});
    const two = await start(again, { ts: '-1', at: plus(5 * MIN), reminderIntervalMs: 10 * MIN });
    two();
    expect({ texts, warns }).toEqual({
      texts: [open('15m')],
      warns: [
        "  ⚠  The question post's time (not-a-ts) could not be read: its reminder and escalation count from this agent's start.",
      ],
    });
  });

  it('a takeover past the interval: ONE catch-up with the true age', async () => {
    // (a) red when a takeover sends no catch-up, or the reminder's scheduled age; (b) prints the posts
    //     and the rows.
    const r = await rig({});
    const clear = await start(r, {
      takenOver: true,
      at: plus(25 * MIN),
      reminderIntervalMs: 10 * MIN,
    });
    await settle();
    clear();
    expect({ texts, rows: await statuses(r) }).toEqual({
      texts: [open('25m')],
      rows: { '1': 'sent' },
    });
  });
});

describe('#597 D3a — one post at most at a takeover', () => {
  for (const owner of [undefined, '@ana'] as const) {
    it(`both the reminder and the nudge passed: only the nudge, ${owner === undefined ? 'with no owner' : 'with the owner first'}`, async () => {
      // (a) red when both are posted (a burst), or the reminder instead of the nudge; (b) prints the
      //     posts and the rows.
      const r = await rig(owner !== undefined ? { owner } : {});
      const clear = await start(r, {
        takenOver: true,
        at: plus(40 * MIN),
        reminderIntervalMs: 10 * MIN,
        escalationMs: 30 * MIN,
      });
      await settle();
      clear();
      expect({ texts, rows: await statuses(r) }).toEqual({
        texts: [owner === undefined ? open('40m') : owned('40m')],
        rows: { e: 'sent' },
      });
    });
  }

  it('the nudge in the future: only the reminder at the takeover; the nudge later at its own instant', async () => {
    // (a) red when the nudge is posted at the takeover too, or not at its instant; (b) prints the posts.
    const r = await rig({});
    const clear = await start(r, {
      takenOver: true,
      at: plus(25 * MIN),
      reminderIntervalMs: 10 * MIN,
      escalationMs: 30 * MIN,
    });
    await settle();
    const atAttach = [...texts];
    await r.clock.set(plus(30 * MIN));
    await settle();
    clear();
    expect({ atAttach, texts }).toEqual({
      atAttach: [open('25m')],
      texts: [open('25m'), open('30m')],
    });
  });

  it('a first-time post by a late agent: no catch-up, and the passed items are not armed', async () => {
    // (a) red when a first-time post is followed by a catch-up, or a passed item fires late; (b)
    //     prints the posts.
    const r = await rig({});
    const clear = await start(r, {
      at: plus(40 * MIN),
      reminderIntervalMs: 10 * MIN,
      escalationMs: 30 * MIN,
    });
    await settle();
    await r.clock.set(plus(2 * HOUR));
    await settle();
    clear();
    expect(texts).toEqual([]);
  });

  it('no ledger, and a ledger read that throws: no catch-up, no new line, and the item still to come posts at its time', async () => {
    // (a) red when a store with no ledger, or a read that throws, sends a catch-up or prints a line;
    //     (b) prints the posts and the lines.
    const got: Record<string, unknown> = {};
    for (const how of ['none', 'throws'] as const) {
      texts.length = 0;
      warns.length = 0;
      const r = await rig({});
      const ledger =
        how === 'none'
          ? ('none' as const)
          : {
              ...r.ledger,
              lease: r.ledger.lease.bind(r.ledger),
              mark: r.ledger.mark.bind(r.ledger),
              read: (): Promise<never> => Promise.reject(new Error('store busy')),
              statAllForRun: r.ledger.statAllForRun.bind(r.ledger),
              deleteAllForRun: r.ledger.deleteAllForRun.bind(r.ledger),
            };
      const clear = await start(r, {
        ledger,
        takenOver: true,
        at: plus(25 * MIN),
        reminderIntervalMs: 10 * MIN,
        escalationMs: 30 * MIN,
      });
      await settle();
      const atAttach = [...texts];
      await r.clock.set(plus(30 * MIN));
      await settle();
      clear();
      got[how] = { atAttach, later: [...texts], warns: [...warns] };
    }
    expect(got).toEqual({
      none: { atAttach: [], later: [open('30m')], warns: [] },
      throws: { atAttach: [], later: [open('30m')], warns: [] },
    });
  });
});

describe('#597 D3a — the nudge on every gate', () => {
  it('an authored gate’s nudge is at the post’s time + the threshold, not the attach reading’s', async () => {
    // Posted 90 s after the gate opened; the agent attached at +2 m. (a) red when the nudge counts from
    //     the attach reading (nothing at +31 m 30 s); (b) prints the posts.
    const r = await rig({ reminder_seconds: 600, reminder_max: 3, owner: '@ana' });
    const clear = await start(r, {
      ts: tsOf(plus(90 * SEC)),
      at: plus(2 * MIN),
      escalationMs: 30 * MIN,
    });
    await r.clock.set(new Date(OPENED_MS + 31 * MIN + 30 * SEC - 1));
    await settle();
    const before = texts.filter((t) => t.startsWith('@ana'));
    await r.clock.set(plus(31 * MIN + 30 * SEC));
    await settle();
    clear();
    expect({ before, nudge: texts.filter((t) => t.startsWith('@ana')) }).toEqual({
      before: [],
      nudge: [owned('31m')],
    });
  });

  it('the nudge of an `on_expiry` gate is not posted at or after `expires_at`: not by its waiter, not by a catch-up', async () => {
    // (a) red when the nudge's closure by the expiry is lost (a nudge after the question closed);
    //     (b) prints the posts.
    const gate = { expires_at: plus(20 * MIN).toISOString(), on_expiry: 'abort' };
    const waiter: Record<string, string[]> = {};
    // With no ledger the waiter's own closure is the only guard (the ledger's lease refuses it too).
    for (const ledger of [undefined, 'none'] as const) {
      texts.length = 0;
      const live = await rig(gate);
      const one = await start(live, {
        escalationMs: 30 * MIN,
        ...(ledger !== undefined ? { ledger } : {}),
      });
      await live.clock.set(plus(31 * MIN));
      await settle();
      one();
      waiter[ledger ?? 'ledger'] = [...texts];
    }
    texts.length = 0;
    const later = await rig(gate);
    const two = await start(later, { takenOver: true, at: plus(35 * MIN), escalationMs: 30 * MIN });
    await settle();
    two();
    expect({ waiter, catchUp: texts }).toEqual({ waiter: { ledger: [], none: [] }, catchUp: [] });
  });
});

describe('#597 D3a — the final', () => {
  it('the one reminder is final when the question’s `expires_at` is at or before its instant', async () => {
    // (a) red when final-ness is judged another way (a plain reminder at the deadline, or a final
    //     before it); (b) prints the posts.
    const atDeadline = await rig({
      expires_at: plus(10 * MIN).toISOString(),
      timeout_seconds: 600,
    });
    const one = await start(atDeadline, { reminderIntervalMs: 10 * MIN });
    await atDeadline.clock.set(plus(10 * MIN));
    await settle();
    one();
    const final = [...texts];
    texts.length = 0;
    const before = await rig({ expires_at: plus(11 * MIN).toISOString(), timeout_seconds: 660 });
    const two = await start(before, { reminderIntervalMs: 10 * MIN });
    await before.clock.set(plus(10 * MIN));
    await settle();
    two();
    expect({ final, plain: texts }).toEqual({
      final: [
        '⏰ gate `review_step` expired 0s ago (2033-01-01T00:10:00Z) — nothing will be done automatically; it is still waiting for a response.',
      ],
      plain: [open('10m')],
    });
  });

  it('a catch-up never posts a final, of an `on_expiry` gate or a finding-only one; the live agent’s own waiter still does', async () => {
    // (a) red when a takeover catches up a final; (b) prints the posts of each case.
    const got: Record<string, unknown> = {};
    for (const onExpiry of [undefined, 'abort'] as const) {
      const fields = {
        expires_at: plus(10 * MIN).toISOString(),
        timeout_seconds: 600,
        ...(onExpiry !== undefined ? { on_expiry: onExpiry } : {}),
      };
      texts.length = 0;
      const taken = await rig(fields);
      const one = await start(taken, {
        takenOver: true,
        at: plus(15 * MIN),
        reminderIntervalMs: 10 * MIN,
      });
      await settle();
      one();
      const catchUp = [...texts];
      texts.length = 0;
      const live = await rig(fields);
      const two = await start(live, { reminderIntervalMs: 10 * MIN });
      await live.clock.set(plus(10 * MIN));
      await settle();
      two();
      got[onExpiry ?? 'finding-only'] = { catchUp, live: [...texts] };
    }
    expect(got).toEqual({
      'finding-only': {
        catchUp: [],
        live: [
          '⏰ gate `review_step` expired 0s ago (2033-01-01T00:10:00Z) — nothing will be done automatically; it is still waiting for a response.',
        ],
      },
      abort: {
        catchUp: [],
        live: [
          '⏰ gate `review_step` expired 0s ago (2033-01-01T00:10:00Z) — the run will be stopped.',
        ],
      },
    });
  });

  it('the latest passed item already sent: the takeover posts nothing, and walks back to no earlier one', async () => {
    // Occurrence 2 was sent by the stopped agent; occurrence 1 never was. (a) red when the catch-up
    //     falls back to an earlier occurrence (occurrence 1 posted); (b) prints the posts and rows.
    const r = await rig({ reminder_seconds: 600, reminder_max: 3 });
    await sentBefore(r, { type: 'reminder', occurrence: 2 }, plus(20 * MIN));
    const clear = await start(r, { takenOver: true, at: plus(25 * MIN) });
    await settle();
    clear();
    expect({ texts, rows: await statuses(r) }).toEqual({ texts: [], rows: { '2': 'sent' } });
  });
});

describe('#597 D3a — the same-line rule', () => {
  it('one process: a reminder at 30:00 and the nudge at 30:30 with no owner post one line; with an owner, both', async () => {
    // (a) red when the in-process `last` is dropped (two identical lines) or applied with an owner;
    //     (b) prints the posts of each case.
    const got: Record<string, string[]> = {};
    for (const owner of [undefined, '@ana'] as const) {
      texts.length = 0;
      const r = await rig(owner !== undefined ? { owner } : {});
      const clear = await start(r, {
        reminderIntervalMs: 30 * MIN,
        escalationMs: 30 * MIN + 30 * SEC,
      });
      await r.clock.set(plus(30 * MIN));
      await settle();
      await r.clock.set(plus(30 * MIN + 30 * SEC));
      await settle();
      clear();
      got[owner ?? 'none'] = [...texts];
    }
    expect(got).toEqual({ none: [open('30m')], '@ana': [open('30m'), owned('30m')] });
  });

  it('one process: the default authored config (occurrence 3 and the nudge coincide) posts one line', async () => {
    // (a) red when the nudge repeats occurrence 3's line; (b) prints the posts.
    const r = await rig({ reminder_seconds: 600, reminder_max: 3 });
    const clear = await start(r, { escalationMs: 30 * MIN });
    await r.clock.set(plus(30 * MIN));
    await settle();
    clear();
    expect(texts).toEqual([open('10m'), open('20m'), open('30m')]);
  });

  it('one process: a final followed by the nudge (finding-only gate) posts both', async () => {
    // (a) red when the nudge is taken for the final's line; (b) prints the posts.
    const r = await rig({
      reminder_seconds: 600,
      reminder_max: 3,
      expires_at: plus(30 * MIN).toISOString(),
      timeout_seconds: 1800,
    });
    const clear = await start(r, { escalationMs: 30 * MIN + 30 * SEC });
    await r.clock.set(plus(30 * MIN + 30 * SEC));
    await settle();
    clear();
    expect(texts).toEqual([
      open('10m'),
      open('20m'),
      '⏰ gate `review_step` expired 0s ago (2033-01-01T00:30:00Z) — nothing will be done automatically; it is still waiting for a response.',
      open('30m'),
    ]);
  });

  it('a takeover: a reminder sent within the minute before the nudge’s instant consumes the nudge; a nudge sent so consumes the reminder; with an owner, neither', async () => {
    // (a) red when the rows are not read (the consumed item posted), read with an owner, or a line sent
    //     more than a minute before consumes; (b) prints the posts of each case.
    const got: Record<string, string[]> = {};
    for (const owner of [undefined, '@ana'] as const) {
      // The reminder (29:30) was sent by the stopped agent; the nudge (30:00) is the latest passed.
      texts.length = 0;
      const a = await rig(owner !== undefined ? { owner } : {});
      await sentBefore(a, { type: 'reminder', occurrence: 1 }, plus(29 * MIN + 30 * SEC));
      const one = await start(a, {
        takenOver: true,
        at: plus(35 * MIN),
        reminderIntervalMs: 29 * MIN + 30 * SEC,
        escalationMs: 30 * MIN,
      });
      await settle();
      one();
      got[`nudge after a sent reminder, ${owner ?? 'no owner'}`] = [...texts];
      // The nudge (10:00) was sent; the reminder (10:30) is the latest passed.
      texts.length = 0;
      const b = await rig(owner !== undefined ? { owner } : {});
      await sentBefore(b, { type: 'escalation' }, plus(10 * MIN));
      const two = await start(b, {
        takenOver: true,
        at: plus(15 * MIN),
        reminderIntervalMs: 10 * MIN + 30 * SEC,
        escalationMs: 10 * MIN,
      });
      await settle();
      two();
      got[`reminder after a sent nudge, ${owner ?? 'no owner'}`] = [...texts];
      // A reminder sent at 25:00, more than a minute before the nudge's instant (30:00): not the same line.
      texts.length = 0;
      const c = await rig(owner !== undefined ? { owner } : {});
      await sentBefore(c, { type: 'reminder', occurrence: 1 }, plus(25 * MIN));
      const three = await start(c, {
        takenOver: true,
        at: plus(35 * MIN),
        reminderIntervalMs: 25 * MIN,
        escalationMs: 30 * MIN,
      });
      await settle();
      three();
      got[`nudge after a reminder sent 5 minutes before, ${owner ?? 'no owner'}`] = [...texts];
    }
    expect(got).toEqual({
      'nudge after a sent reminder, no owner': [],
      'reminder after a sent nudge, no owner': [],
      'nudge after a sent reminder, @ana': [owned('35m')],
      'reminder after a sent nudge, @ana': [open('15m')],
      'nudge after a reminder sent 5 minutes before, no owner': [open('35m')],
      'nudge after a reminder sent 5 minutes before, @ana': [owned('35m')],
    });
  });
});

describe('#597 D3a — one compose function; the not-listening words', () => {
  const command = (runId: string): string =>
    `realm run respond ${runId} --gate ${GATE_ID} --choice &lt;one of: approve, reject&gt;`;
  const notListening = (who: string, age: string, runId: string): string =>
    `${who}⏰ gate \`review_step\` has been open for ${age} (since 2033-01-01T00:00:00Z). Realm is not reading replies in this thread right now — to respond, open a terminal and run:\n\`\`\`${command(runId)}\`\`\``;

  it('the agent’s post and a direct call of the compose function give the same text; the sentence and command iff the host does not listen', async () => {
    // (a) red when the waiter composes another way than the shared function, the command is shown to
    //     a listening host, or "Please respond." stays beside the sentence; (b) prints the texts.
    const got: Record<string, unknown> = {};
    for (const listens of [true, false]) {
      texts.length = 0;
      const r = await rig({ owner: '@ana' });
      const clear = await start(r, {
        listens,
        reminderIntervalMs: 10 * MIN,
        escalationMs: 30 * MIN,
      });
      await r.clock.set(plus(30 * MIN));
      await settle();
      clear();
      const gate = r.record.pending_gate!;
      const direct = [
        composeReminderPost({
          gate,
          runId: r.runId,
          display: undefined,
          item: {
            what: { type: 'reminder', occurrence: 1 },
            kind: 'one_shot',
            isFinal: false,
            atMs: OPENED_MS + 10 * MIN,
          },
          now: plus(10 * MIN),
          listens,
        }),
        composeReminderPost({
          gate,
          runId: r.runId,
          display: undefined,
          item: {
            what: { type: 'escalation' },
            kind: 'nudge',
            isFinal: false,
            atMs: OPENED_MS + 30 * MIN,
          },
          now: plus(30 * MIN),
          listens,
        }),
      ];
      got[listens ? 'listens' : 'does not listen'] = {
        same: JSON.stringify(texts) === JSON.stringify(direct),
        texts: [...texts],
        expected: listens
          ? [open('10m'), owned('30m')]
          : [notListening('', '10m', r.runId), notListening('@ana — ', '30m', r.runId)],
      };
    }
    for (const v of Object.values(got)) {
      const { texts: posted, expected } = v as { texts: string[]; expected: string[] };
      expect(posted).toEqual(expected);
    }
    expect({
      listens: (got['listens'] as { same: boolean }).same,
      notListening: (got['does not listen'] as { same: boolean }).same,
    }).toEqual({ listens: true, notListening: true });
  });

  it('a final never carries the command (an `on_expiry` one or a finding-only one), and the compose function prints nothing', () => {
    // (a) red when a final shows the respond command, or the operator's console line is printed by
    //     the compose function (a second caller would print it); (b) prints the texts and lines.
    const base = {
      gate_id: GATE_ID,
      step_name: 'review_step',
      preview: { headline: 'Deploy' },
      choices: ['approve', 'reject'],
      opened_at: OPENED,
      expires_at: plus(10 * MIN).toISOString(),
      timeout_seconds: 600,
    } as unknown as PendingGate;
    const final = (gate: PendingGate): string =>
      composeReminderPost({
        gate,
        runId: 'r1',
        display: undefined,
        item: {
          what: { type: 'reminder', occurrence: 1 },
          kind: 'one_shot',
          isFinal: true,
          atMs: OPENED_MS + 10 * MIN,
        },
        now: plus(10 * MIN),
        listens: false,
      });
    expect({
      findingOnly: final(base),
      onExpiry: final({ ...base, on_expiry: 'abort' } as PendingGate),
      lines: logs,
    }).toEqual({
      findingOnly:
        '⏰ gate `review_step` expired 0s ago (2033-01-01T00:10:00Z) — nothing will be done automatically; it is still waiting for a response.',
      onExpiry:
        '⏰ gate `review_step` expired 0s ago (2033-01-01T00:10:00Z) — the run will be stopped.',
      lines: [],
    });
  });
});

describe('#597 D3a — time', () => {
  it('an `opened_at` that cannot be read: no throw; the reminder and the nudge count from the attach reading (an old `ts` notwithstanding) and read "is still open"', async () => {
    // (a) red when the anchor takes the 2009 `ts` (both items passed, nothing armed) or the notifier
    //     throws; (b) prints the posts.
    const r = await rig({ opened_at: 'not a time', owner: '@ana' });
    const clear = await start(r, {
      ts: OLD_TS,
      at: plus(5 * MIN),
      reminderIntervalMs: 10 * MIN,
      escalationMs: 30 * MIN,
    });
    await r.clock.set(plus(35 * MIN));
    await settle();
    clear();
    expect({ texts, warns }).toEqual({
      texts: [
        '⏰ gate `review_step` is still open. Please respond.',
        '@ana — ⏰ gate `review_step` is still open. Please respond.',
      ],
      warns: [],
    });
  });

  it('an `opened_at` after the reading (a clock stepped back): the anchor is the reading', async () => {
    // (a) red when the upper clamp is removed (the reminder waits from `opened_at` or the `ts`, an
    //     hour later); (b) prints the posts.
    const r = await rig({ opened_at: plus(HOUR).toISOString() });
    const clear = await start(r, {
      ts: tsOf(plus(2 * HOUR)),
      at: plus(5 * MIN),
      reminderIntervalMs: 10 * MIN,
    });
    await r.clock.set(plus(15 * MIN));
    await settle();
    clear();
    expect(texts).toEqual(['⏰ gate `review_step` is still open. Please respond.']);
  });
});

describe('#597 D3a — the words', () => {
  const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
  const flat = (text: string): string => text.replace(/\s+/g, ' ');
  /** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
  const claim = (page: string, sentence: string): void =>
    expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
  const unreleased = (): string => {
    const text = read('CHANGELOG.md');
    return text.slice(text.indexOf('## [Unreleased]'), text.indexOf('\n## [0.49.0]'));
  };

  it('slack-gates.md and deployment-manifest.md: counted from the post; the not-listening reminder', () => {
    // This file's "the anchor" cells (from the post, clamped; a takeover keeps the original post's
    // time: "a takeover past the interval") and "the nudge on every gate"; the not-listening form:
    // "one compose function"; the scoped "no message names a command": docs-729-pr4's cell (a
    // listening host's lines) and this file's (the command only when it does not listen).
    claim(
      'docs/guides/slack-gates.md',
      "If nobody answers, Realm posts a reminder in the thread and an escalation, counted from when the question was posted: after 10 and 30 minutes by default. A `realm agent` started again that uses the stopped agent's question post keeps counting from the original post.",
    );
    claim(
      'docs/reference/deployment-manifest.md',
      '| `reminder_interval_ms` | Integer | 1 or more. How long after the question is posted a reminder is posted. The default is 600000. |',
    );
    claim(
      'docs/reference/deployment-manifest.md',
      '| `escalation_threshold_ms` | Integer | 1 or more. How long after the question is posted an escalation is posted. The default is 1800000. |',
    );
  });

  it('the CHANGELOG: the Upgrading item and the Changed line', () => {
    // "count from when the question was posted": "the anchor"; "keep their times": #964's and D1b's
    // authored cells (unchanged); "one catch-up reminder or escalation … also for a question with no
    // `reminder_seconds`": "one post at most" and slack-reminder-ledger-d1b's rewritten cell; "the
    // first start after the upgrade can repeat one": inferred from the 0.49 store, which kept no row
    // (D1 R13); "say so and give the command": "one compose function"; "never the reminder that says
    // the time ran out": "a catch-up never posts a final".
    const text = flat(unreleased());
    for (const sentence of [
      "**9. Slack's reminder and escalation count from when the question was posted, and a reminder from an agent that does not read replies gives the command.** A `realm agent` that restarts no longer restarts their clock. The reminders of a gate's own `reminder_seconds` keep their times, counted from when the gate opened. A `realm agent` started again that uses the stopped agent's question post may send one catch-up reminder or escalation at once, also for a question with no `reminder_seconds`; the 0.49 reminders left no record, so the first start after the upgrade can repeat one. When the agent does not read replies in the thread (no `app_token` or `signing_secret`), its reminder and escalation say so and give the `realm run respond` command where they said \"Please respond.\".",
      "- **Slack reminders count from the question's post** (issue #597): the reminder of a gate with no `reminder_seconds` and every escalation are counted from when the question was posted in Slack, not from when `realm agent` attached, so a restarted agent keeps their times; a restarted agent that uses the stopped agent's question post sends at most one catch-up, the latest reminder or escalation that came due, for any gate (never the reminder that says the time ran out). A reminder or escalation from an agent that does not read replies in the thread says `Realm is not reading replies in this thread right now` and gives the terminal command. The reminders of a gate's own `reminder_seconds` keep their times.",
    ]) {
      expect(text, `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
    }
  });
});
