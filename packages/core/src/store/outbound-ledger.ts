// outbound-ledger.ts — issue #597, D1a (design record `DESIGN-D1-rev5.md` §2): the outbound ledger,
// what a sender records about a reminder or the escalation of a run's open question, so two senders
// never both hold it and a restarted one finds what was done. The ledger lives BESIDE the run record,
// never in it: a lease or a mark writes nothing to the run.
//
// Core declares the port and its one pure state machine (`leaseOutbound`, `markOutbound`); a store
// does the I/O around it: it checks the request (`checkOutboundRequest`), takes its ONE raw reading,
// reads the run's open question and the run's ledger rows, calls the pure function, writes the row it
// returns and answers its result — with nothing that yields between the read and the write.
import type { PendingGate } from '../types/run-record.js';
import type { PerRunArtifactStore } from './per-run-artifact-store.js';
import { isPastDeadline } from '../engine/instants.js';
import { reminderEligibility } from '../engine/gate-timing.js';
import { keyOf } from './outbound-entry-key.js';

/** The longest lease a sender may take, in seconds: a longer `leaseSeconds` is cut to this. */
export const OUTBOUND_LEASE_MAX = 300;

/**
 * One row of a run's ledger, AS A STORE KEEPS IT — for store implementers only: it carries the lease
 * token, the holder's proof, so it is never rendered and never returned by the port (every entry the
 * port returns is an {@link OutboundEntryView}). An unset field is omitted, never `null`.
 */
export interface OutboundEntry {
  /** `gate:<gate_id>:reminder:<k>` or `gate:<gate_id>:escalation`; derived by core, never passed. */
  readonly entry_key: string;
  readonly type: 'reminder' | 'escalation';
  /** A reminder's occurrence, from 1; an escalation has none. */
  readonly occurrence?: number;
  /**
   * How many reminders the question can get, copied at the first lease: its `reminder_max` when it
   * has an authored `reminder_seconds` (3 when it carries none), 1 when it has no authored schedule.
   * A reminder's only; an escalation has none.
   */
  readonly of_max?: number;
  readonly status: 'pending' | 'sent' | 'failed';
  readonly lease_token: string;
  /** When the latest lease passes (ISO 8601): it is live while this is later than the reading. */
  readonly lease_deadline: string;
  /** How many leases were applied to the row: 1 when it is created, one more at each takeover. */
  readonly attempts: number;
  /** The reading of the mark (ISO 8601). */
  readonly last_at?: string;
  /** The mark's outcome: `ok` with `sent`, `refused:<code>` with `failed`. */
  readonly last_outcome?: string;
  /** The reading of a `sent` mark (ISO 8601). */
  readonly sent_at?: string;
  /** The reading of the lease that created the row (ISO 8601). */
  readonly created_at: string;
}

/** A ledger row as the port returns it: the row without its lease token. */
export type OutboundEntryView = Omit<OutboundEntry, 'lease_token'>;

/**
 * A lease of one reminder or of the escalation of a run's open question. `leaseToken` is the caller's
 * own (1–200 characters); `leaseSeconds` a positive finite number, cut to {@link OUTBOUND_LEASE_MAX};
 * `occurrence` a positive whole number.
 */
export interface OutboundLeaseRequest {
  readonly what:
    | { readonly type: 'reminder'; readonly gateId: string; readonly occurrence: number }
    | { readonly type: 'escalation'; readonly gateId: string };
  readonly leaseToken: string;
  readonly leaseSeconds: number;
}

/**
 * The mark of a leased reminder or escalation: `sent` with the outcome `ok`, or `failed` with
 * `refused:<code>`, the code 1–64 characters of `a`–`z`, `0`–`9` and `_`.
 */
export interface OutboundMarkRequest {
  readonly what: OutboundLeaseRequest['what'];
  readonly leaseToken: string;
  readonly result: 'sent' | 'failed';
  readonly outcome: 'ok' | `refused:${string}`;
}

/**
 * What a lease or a mark answers. A refusal's `reason` is one of eight words; `already_leased`,
 * `lease_held`, `outbound_done` and `already_marked` carry the row, and so does `lease_lost` when a
 * row exists.
 */
export type OutboundResult =
  | { readonly applied: true; readonly entry: OutboundEntryView }
  | {
      readonly applied: false;
      readonly reason:
        | 'gate_not_open'
        | 'not_eligible'
        | 'outbound_done'
        | 'superseded'
        | 'already_leased'
        | 'lease_held'
        | 'lease_lost'
        | 'already_marked';
      readonly entry?: OutboundEntryView;
    };

/**
 * A store's outbound ledger (`RunStore.outbound`). `lease` and `mark` each take exactly ONE raw reading
 * of the store's clock, refused or applied, and a malformed request throws before it; `read`,
 * `statAllForRun` and `deleteAllForRun` take none. A run that does not exist is no error: `lease`
 * answers `gate_not_open`, `read` answers no rows, and the purge pair reports zero.
 */
export interface OutboundLedger extends PerRunArtifactStore {
  lease(runId: string, request: OutboundLeaseRequest): Promise<OutboundResult>;
  mark(runId: string, request: OutboundMarkRequest): Promise<OutboundResult>;
  /** The run's rows, by `created_at` then `entry_key`. */
  read(runId: string): Promise<OutboundEntryView[]>;
}

const OUTCOME_CODE = /^[a-z0-9_]{1,64}$/;

function malformed(what: string): never {
  throw new Error(`A malformed outbound request: ${what}.`);
}

/**
 * Checks a lease or mark request, and throws on a malformed one: a store calls it BEFORE it takes its
 * reading, so a malformed request takes none. A programming error, never a refusal.
 */
export function checkOutboundRequest(kind: 'lease', request: OutboundLeaseRequest): void;
export function checkOutboundRequest(kind: 'mark', request: OutboundMarkRequest): void;
export function checkOutboundRequest(
  kind: 'lease' | 'mark',
  request: OutboundLeaseRequest | OutboundMarkRequest,
): void {
  const { what, leaseToken } = request;
  if (what.type !== 'reminder' && what.type !== 'escalation')
    malformed('`what.type` is neither `reminder` nor `escalation`');
  if (what.type === 'reminder' && !(Number.isInteger(what.occurrence) && what.occurrence >= 1))
    malformed('a reminder occurrence must be a whole number from 1');
  if (typeof leaseToken !== 'string' || leaseToken.length < 1 || leaseToken.length > 200)
    malformed('the lease token must be 1 to 200 characters');
  if (kind === 'lease') {
    const { leaseSeconds } = request as OutboundLeaseRequest;
    if (typeof leaseSeconds !== 'number' || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0)
      malformed('`leaseSeconds` must be a positive finite number');
    return;
  }
  const { result, outcome } = request as OutboundMarkRequest;
  const fits =
    (result === 'sent' && outcome === 'ok') ||
    (result === 'failed' &&
      typeof outcome === 'string' &&
      outcome.startsWith('refused:') &&
      OUTCOME_CODE.test(outcome.slice('refused:'.length)));
  if (!fits)
    malformed('a mark is `sent` with `ok`, or `failed` with `refused:<code>` (a–z, 0–9, _; 1–64)');
}

function viewOf(row: OutboundEntry): OutboundEntryView {
  const { lease_token: _token, ...view } = row;
  return view;
}

/** Whether the row's lease is live at `at`: its deadline is later (exactly at it, it has passed). */
function isLive(row: OutboundEntry, at: Date): boolean {
  return !isPastDeadline(row.lease_deadline, at);
}

/**
 * The lease's state machine, pure: `gate` is the run's open question (`undefined` for none, for a run
 * that does not exist, or for a sealed run: a store reads it as core's `openQuestionOf` does), `rows` the run's ledger rows, `at` the store's one reading. First match
 * wins: `gate_not_open` · `not_eligible` (core's `reminderEligibility`) · `outbound_done` (the row is
 * `sent` or `failed`) · `superseded` (a reminder, and a reminder of the same question with a larger
 * occurrence is `sent` or holds a live lease; never an escalation) · `already_leased` / `lease_held`
 * (the row's lease is live: the same token / another) · otherwise the lease applies: the row is created,
 * or its expired lease taken over. `write` is the row to store, present only when it applied.
 */
export function leaseOutbound(
  gate: PendingGate | undefined,
  rows: readonly OutboundEntry[],
  request: OutboundLeaseRequest,
  at: Date,
): { result: OutboundResult; write?: OutboundEntry } {
  checkOutboundRequest('lease', request);
  const { what } = request;
  if (gate === undefined || gate.gate_id !== what.gateId)
    return { result: { applied: false, reason: 'gate_not_open' } };
  if (!reminderEligibility(gate, what, at))
    return { result: { applied: false, reason: 'not_eligible' } };
  const key = keyOf(what);
  const row = rows.find((r) => r.entry_key === key);
  if (row !== undefined && row.status !== 'pending')
    return { result: { applied: false, reason: 'outbound_done', entry: viewOf(row) } };
  if (what.type === 'reminder') {
    const later = rows.some(
      (r) =>
        r.type === 'reminder' &&
        r.occurrence !== undefined &&
        r.occurrence > what.occurrence &&
        r.entry_key === keyOf({ ...what, occurrence: r.occurrence }) &&
        (r.status === 'sent' || (r.status === 'pending' && isLive(r, at))),
    );
    if (later) return { result: { applied: false, reason: 'superseded' } };
  }
  if (row !== undefined && isLive(row, at)) {
    const reason = row.lease_token === request.leaseToken ? 'already_leased' : 'lease_held';
    return { result: { applied: false, reason, entry: viewOf(row) } };
  }
  const seconds = Math.min(request.leaseSeconds, OUTBOUND_LEASE_MAX);
  const lease = {
    lease_token: request.leaseToken,
    lease_deadline: new Date(at.getTime() + seconds * 1000).toISOString(),
  };
  const write: OutboundEntry =
    row !== undefined
      ? { ...row, ...lease, attempts: row.attempts + 1 }
      : {
          entry_key: key,
          type: what.type,
          ...(what.type === 'reminder'
            ? {
                occurrence: what.occurrence,
                of_max: gate.reminder_seconds !== undefined ? (gate.reminder_max ?? 3) : 1,
              }
            : {}),
          status: 'pending',
          ...lease,
          attempts: 1,
          created_at: at.toISOString(),
        };
  return { result: { applied: true, entry: viewOf(write) }, write };
}

/**
 * The mark's state machine, pure: `rows` the run's ledger rows, `at` the store's one reading. First
 * match wins: no row ⇒ `lease_lost` (nothing is created) · the row is not `pending`: the same token and
 * the same result ⇒ `already_marked`, otherwise `outbound_done` · another token ⇒ `lease_lost` ·
 * otherwise the mark applies, whatever the lease's deadline: a late mark by the lease's own holder is
 * accepted when nobody took the lease over. The lease's columns stay as they were.
 */
export function markOutbound(
  rows: readonly OutboundEntry[],
  request: OutboundMarkRequest,
  at: Date,
): { result: OutboundResult; write?: OutboundEntry } {
  checkOutboundRequest('mark', request);
  const key = keyOf(request.what);
  const row = rows.find((r) => r.entry_key === key);
  if (row === undefined) return { result: { applied: false, reason: 'lease_lost' } };
  if (row.status !== 'pending') {
    const own = row.lease_token === request.leaseToken && row.status === request.result;
    return {
      result: {
        applied: false,
        reason: own ? 'already_marked' : 'outbound_done',
        entry: viewOf(row),
      },
    };
  }
  if (row.lease_token !== request.leaseToken)
    return { result: { applied: false, reason: 'lease_lost', entry: viewOf(row) } };
  const stamp = at.toISOString();
  const write: OutboundEntry = {
    ...row,
    status: request.result,
    ...(request.result === 'sent' ? { sent_at: stamp } : {}),
    last_at: stamp,
    last_outcome: request.outcome,
  };
  return { result: { applied: true, entry: viewOf(write) }, write };
}
