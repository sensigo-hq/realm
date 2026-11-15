// outbound-send-d1b.test.ts — issue #597 D1b: the shared helper `sendOnce` makes ONE attempt to send a
// reminder or an escalation through a run store's outbound ledger (lease, post, mark) and says what
// happened. The mark table is a SET that is the design, one cell per row: Slack's `ok` is marked
// `sent`; `channel_not_found` and `is_archived` are marked `failed`; every other outcome is left
// unmarked (the auth class, `not_in_channel`, a timeout, a network error, a rate limit, a 5xx, any
// other code, a post that throws). The ledger is a real one (`new InMemoryStore({ clock }).outbound`)
// over a run whose question is open; the post is a fake that answers each Slack verdict.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import type { OutboundLedger, OutboundResult, PendingGate, RunRecord } from '@sensigo/realm';
import { InMemoryStore, settableClock, type SettableClock } from '@sensigo/realm-testing';
import { OUTBOUND_LEASE_SECONDS, sendOnce, type OutboundSendOutcome } from './outbound-send.js';
import type { SlackVerdict } from './slack-gate-notifier.js';

const T = Date.parse('2033-01-01T00:00:00.000Z');
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const GATE_ID = 'g-d1b';
const GATE: PendingGate = {
  gate_id: GATE_ID,
  step_name: 'q',
  preview: {},
  choices: ['approve', 'reject'],
  opened_at: iso(T),
  reminder_seconds: 600,
  reminder_max: 3,
} as PendingGate;
const FIRST = { type: 'reminder', gateId: GATE_ID, occurrence: 1 } as const;

interface Rig {
  readonly clock: SettableClock;
  readonly ledger: OutboundLedger;
  readonly runId: string;
}

/** A run waiting at `q` (its question opened at T), on a store whose clock reads T + 10 min. */
async function rig(): Promise<Rig> {
  const clock = settableClock(new Date(T));
  const store = new InMemoryStore({ clock });
  const { record } = await store.create({ workflowId: 'd1b', workflowVersion: 1, params: {} });
  await store.update({
    ...record,
    run_phase: 'gate_waiting',
    in_progress_steps: ['q'],
    pending_gate: GATE,
  } as RunRecord);
  await clock.set(new Date(T + 10 * MIN));
  return { clock, ledger: store.outbound!, runId: record.id };
}

/** The ledger with some of its calls replaced (the rest forwarded). */
function wrap(ledger: OutboundLedger, over: Partial<OutboundLedger>): OutboundLedger {
  return {
    lease: (id, req) => ledger.lease(id, req),
    mark: (id, req) => ledger.mark(id, req),
    read: (id) => ledger.read(id),
    statAllForRun: (id) => ledger.statAllForRun(id),
    deleteAllForRun: (id) => ledger.deleteAllForRun(id),
    ...over,
  };
}

/** A fake post that answers `verdict` and counts its calls. */
function answering(verdict: SlackVerdict): {
  post: (text: string) => Promise<SlackVerdict>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    post: async (text) => {
      calls.push(text);
      return verdict;
    },
  };
}

/** The outcome without what varies by run (an error object), and the row the ledger kept. */
async function attemptWith(
  verdict: SlackVerdict | 'throws',
): Promise<{ outcome: Record<string, unknown>; row: Record<string, unknown> | undefined }> {
  const r = await rig();
  const outcome = await sendOnce({
    ledger: r.ledger,
    runId: r.runId,
    what: FIRST,
    text: 'a reminder',
    post:
      verdict === 'throws'
        ? async () => {
            throw new Error('socket hang up');
          }
        : async () => verdict,
  });
  const [row] = await r.ledger.read(r.runId);
  const { error: _error, ...shown } = outcome as OutboundSendOutcome & { error?: unknown };
  return {
    outcome: shown,
    row:
      row !== undefined
        ? {
            status: row.status,
            ...(row.last_outcome !== undefined ? { last_outcome: row.last_outcome } : {}),
          }
        : undefined,
  };
}

const LEASED_DEADLINE = iso(T + 10 * MIN + OUTBOUND_LEASE_SECONDS * 1000);
const refused = (reason: string): SlackVerdict => ({ ok: false, cause: 'refused', reason });

describe('#597 D1b — sendOnce: one lease, one post, one mark', () => {
  it('the mark table: one row per outcome (ok → sent; the channel class → failed; every other outcome unmarked, with its class)', async () => {
    // (a) red when any row differs: an auth-class refusal or `not_in_channel` marked `failed`, a
    //     channel-class refusal left unmarked, a transient outcome marked, a class misread, or the
    //     unmarked lease deadline is not the lease's; (b) prints every row's outcome and kept row.
    const table: Array<[string, SlackVerdict | 'throws']> = [
      ['ok', { ok: true, ts: '1.1' }],
      ['channel_not_found', refused('channel_not_found')],
      ['is_archived', refused('is_archived')],
      ['invalid_auth', refused('invalid_auth')],
      ['token_revoked', refused('token_revoked')],
      ['account_inactive', refused('account_inactive')],
      ['not_authed', refused('not_authed')],
      ['missing_scope', refused('missing_scope')],
      ['token_expired', refused('token_expired')],
      ['not_in_channel', refused('not_in_channel')],
      ['timeout', { ok: false, cause: 'timeout' }],
      ['network error', { ok: false, cause: 'error', error: new TypeError('fetch failed') }],
      ['rate limit', refused('ratelimited')],
      ['5xx', refused('HTTP 503')],
      ['another code', refused('msg_too_long')],
      ['the post throws', 'throws'],
    ];
    const got: Record<string, unknown> = {};
    for (const [name, verdict] of table) got[name] = await attemptWith(verdict);
    const unmarked = (code: string, cls: string) => ({
      outcome: { kind: 'unmarked', code, class: cls, leaseDeadline: LEASED_DEADLINE },
      row: { status: 'pending' },
    });
    expect(got).toEqual({
      ok: {
        outcome: { kind: 'sent', mark: 'applied' },
        row: { status: 'sent', last_outcome: 'ok' },
      },
      channel_not_found: {
        outcome: { kind: 'failed', code: 'channel_not_found', mark: 'applied' },
        row: { status: 'failed', last_outcome: 'refused:channel_not_found' },
      },
      is_archived: {
        outcome: { kind: 'failed', code: 'is_archived', mark: 'applied' },
        row: { status: 'failed', last_outcome: 'refused:is_archived' },
      },
      invalid_auth: unmarked('invalid_auth', 'auth'),
      token_revoked: unmarked('token_revoked', 'auth'),
      account_inactive: unmarked('account_inactive', 'auth'),
      not_authed: unmarked('not_authed', 'auth'),
      missing_scope: unmarked('missing_scope', 'auth'),
      token_expired: unmarked('token_expired', 'auth'),
      not_in_channel: unmarked('not_in_channel', 'access'),
      timeout: unmarked('timeout', 'transient'),
      'network error': unmarked('error', 'transient'),
      'rate limit': unmarked('ratelimited', 'transient'),
      '5xx': unmarked('HTTP 503', 'transient'),
      'another code': unmarked('msg_too_long', 'transient'),
      'the post throws': unmarked('error', 'transient'),
    });
  });

  it('a post that throws: the outcome carries what it threw', async () => {
    // (a) red when the thrown error is dropped (the notifier could not say why); (b) prints it.
    const r = await rig();
    const thrown = new Error('socket hang up');
    const outcome = await sendOnce({
      ledger: r.ledger,
      runId: r.runId,
      what: FIRST,
      text: 'a reminder',
      post: async () => {
        throw thrown;
      },
    });
    expect(outcome.kind === 'unmarked' ? outcome.error : outcome).toBe(thrown);
  });

  it('the lease comes first: a fresh token per attempt, 120 s; a refused lease posts nothing (each refusal; `lease_held` and `already_leased` carry the deadline)', async () => {
    // (a) red when a refused lease still posts, the deadline is not carried for a held lease, or the
    //     lease is not 120 s; (b) prints each refusal's outcome and posts.
    const r = await rig();
    const fake = answering({ ok: true });
    const once = (what: typeof FIRST | { type: 'reminder'; gateId: string; occurrence: number }) =>
      sendOnce({ ledger: r.ledger, runId: r.runId, what, text: 'x', post: fake.post });
    // Another sender holds occurrence 1, live.
    const held = await r.ledger.lease(r.runId, {
      what: FIRST,
      leaseToken: 'the-holder',
      leaseSeconds: 120,
    });
    const leaseHeld = await once(FIRST);
    const gateNotOpen = await once({ type: 'reminder', gateId: 'another-gate', occurrence: 1 });
    const notEligible = await once({ type: 'reminder', gateId: GATE_ID, occurrence: 4 });
    // Occurrence 2 sent, then occurrence 2 again (done) and occurrence 1 (a later one was sent).
    const sent2 = await once({ type: 'reminder', gateId: GATE_ID, occurrence: 2 });
    const outboundDone = await once({ type: 'reminder', gateId: GATE_ID, occurrence: 2 });
    await r.clock.set(new Date(T + 13 * MIN)); // the holder's lease of occurrence 1 has passed
    const superseded = await once(FIRST);
    const rows = await r.ledger.read(r.runId);
    expect({
      leaseHeld,
      gateNotOpen,
      notEligible,
      sent2,
      outboundDone: outboundDone.kind === 'skipped' ? outboundDone.reason : outboundDone,
      superseded,
      posts: fake.calls.length,
      second: rows.find((row) => row.occurrence === 2)?.lease_deadline,
    }).toEqual({
      leaseHeld: {
        kind: 'skipped',
        reason: 'lease_held',
        leaseDeadline: held.applied ? held.entry.lease_deadline : 'fixture',
      },
      gateNotOpen: { kind: 'skipped', reason: 'gate_not_open' },
      notEligible: { kind: 'skipped', reason: 'not_eligible' },
      sent2: { kind: 'sent', mark: 'applied' },
      outboundDone: 'outbound_done',
      superseded: { kind: 'skipped', reason: 'superseded' },
      posts: 1,
      second: LEASED_DEADLINE,
    });
  });

  it('each attempt leases with a fresh token of 1–200 characters, for 120 s, and marks with the same token', async () => {
    // (a) red when a token is reused across attempts (a second attempt would read its own lease as
    //     `already_leased`), is empty or too long, the lease is not 120 s, or the mark carries
    //     another token; (b) prints the requests.
    const r = await rig();
    const seen: Array<{ call: string; token: string; seconds?: number }> = [];
    const ledger = wrap(r.ledger, {
      lease: (id, req) => {
        seen.push({ call: 'lease', token: req.leaseToken, seconds: req.leaseSeconds });
        return r.ledger.lease(id, req);
      },
      mark: (id, req) => {
        seen.push({ call: 'mark', token: req.leaseToken });
        return r.ledger.mark(id, req);
      },
    });
    for (const occurrence of [1, 2]) {
      await sendOnce({
        ledger,
        runId: r.runId,
        what: { type: 'reminder', gateId: GATE_ID, occurrence },
        text: 'x',
        post: async () => ({ ok: true }),
      });
    }
    const [l1, m1, l2, m2] = seen;
    expect({
      calls: seen.map((s) => s.call),
      seconds: [l1?.seconds, l2?.seconds],
      lengthsOk: seen.every((s) => s.token.length >= 1 && s.token.length <= 200),
      sameTokenToMark: [l1?.token === m1?.token, l2?.token === m2?.token],
      fresh: l1?.token !== l2?.token,
    }).toEqual({
      calls: ['lease', 'mark', 'lease', 'mark'],
      seconds: [120, 120],
      lengthsOk: true,
      sameTokenToMark: [true, true],
      fresh: true,
    });
  });

  it('a lease that throws: `lease_threw`, nothing posted', async () => {
    // (a) red when a throwing lease posts or throws out of the helper; (b) prints the outcome.
    const r = await rig();
    const fake = answering({ ok: true });
    const outcome = await sendOnce({
      ledger: wrap(r.ledger, {
        lease: async () => {
          throw new Error('database is locked');
        },
      }),
      runId: r.runId,
      what: FIRST,
      text: 'x',
      post: fake.post,
    });
    expect({ kind: outcome.kind, posts: fake.calls.length }).toEqual({
      kind: 'lease_threw',
      posts: 0,
    });
  });

  it('a mark that throws, after a post Slack took and after a channel-class refusal: `mark_threw` with the mark it meant; the row stays pending', async () => {
    // (a) red when the throw escapes, the post is said to have failed, or the code is lost; (b)
    //     prints both outcomes and the rows.
    const results: Record<string, unknown> = {};
    for (const [name, verdict] of [
      ['ok', { ok: true }],
      ['channel_not_found', refused('channel_not_found')],
    ] as const) {
      const r = await rig();
      const outcome = await sendOnce({
        ledger: wrap(r.ledger, {
          mark: async () => {
            throw new Error('disk I/O error');
          },
        }),
        runId: r.runId,
        what: FIRST,
        text: 'x',
        post: async () => verdict as SlackVerdict,
      });
      const { error, ...rest } = outcome as OutboundSendOutcome & { error?: unknown };
      results[name] = {
        ...rest,
        error: error instanceof Error ? error.message : error,
        row: (await r.ledger.read(r.runId))[0]?.status,
      };
    }
    expect(results).toEqual({
      ok: { kind: 'mark_threw', result: 'sent', error: 'disk I/O error', row: 'pending' },
      channel_not_found: {
        kind: 'mark_threw',
        result: 'failed',
        code: 'channel_not_found',
        error: 'disk I/O error',
        row: 'pending',
      },
    });
  });

  it("the mark's answers: another sender's mark came first ⇒ `outbound_done`; another took the lease over ⇒ `lease_lost`", async () => {
    // (a) red when either answer reads as this sender's own (`applied`), or the two are swapped;
    //     (b) prints both outcomes.
    const answers: Record<string, unknown> = {};
    for (const other of ['marks', 'leases'] as const) {
      const r = await rig();
      const outcome = await sendOnce({
        ledger: r.ledger,
        runId: r.runId,
        what: FIRST,
        text: 'x',
        post: async () => {
          // The post outlives its lease; another sender takes the occurrence over meanwhile.
          await r.clock.set(new Date(T + 13 * MIN));
          const taken: OutboundResult = await r.ledger.lease(r.runId, {
            what: FIRST,
            leaseToken: 'another-sender',
            leaseSeconds: 120,
          });
          if (!taken.applied) throw new Error(`fixture: ${taken.reason}`);
          if (other === 'marks') {
            await r.ledger.mark(r.runId, {
              what: FIRST,
              leaseToken: 'another-sender',
              result: 'sent',
              outcome: 'ok',
            });
          }
          return { ok: true };
        },
      });
      answers[other] = outcome;
    }
    expect(answers).toEqual({
      marks: { kind: 'sent', mark: 'outbound_done' },
      leases: { kind: 'sent', mark: 'lease_lost' },
    });
  });
});
