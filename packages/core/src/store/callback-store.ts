// callback-store.ts — R1.3 the callback, callback A1a and callback A1b (prompt
// `feat-callback-a1-delivery-port.md` and its split amendment; design `DESIGN-CALLBACK-rev4.md` over
// rev 3 §2.5): the callback store. One row per run, BESIDE the run record and never in it: where to
// tell the caller the run finished, and the state of telling. Callback A1a is the door side (the row,
// registration, `read`, `countPending`, the purge pair); callback A1b the sender side (`due`, `claim`,
// `freezeBody`, `mark`); callback A2 adds the signing keys (`keys`, in `callback-keys.ts`). The SQLite
// table (B), the door (C2) and the sender (C3) come later.
//
// Core declares the port, its request check and its pure state machine; a store does the I/O around
// it, as `outbound-ledger.ts`: it checks the request (`checkCallbackRequest`), takes its ONE raw reading
// when the method takes one, reads the row and the run, calls the pure function and writes what it
// returns, with nothing that yields between the read and the write.
import type { PerRunArtifactStore } from './per-run-artifact-store.js';
import type { CallbackKeyStore } from './callback-keys.js';
import { isPastDeadline, parseStamp } from '../engine/instants.js';

/**
 * Where a run's caller asked to be told the run finished (`CreateRunOptions.callback`).
 * `url` is the address as given (1–2,048 characters), `host` the label the caller computed from it
 * (1–255) and `webhook_id` a uuid the caller made, the same on every try.
 * @beta
 */
export interface CallbackRegistration {
  readonly url: string;
  readonly host: string;
  readonly webhook_id: string;
}

/**
 * The states a callback row can be in, one list for every use of the word.
 * @beta
 */
export const CALLBACK_STATUSES = ['pending', 'delivered', 'failed'] as const;

/**
 * The words a try's last answer can be when it got no HTTP status.
 * @beta
 */
export const CALLBACK_LAST_STATUS_WORDS = [
  'timeout',
  'connection',
  'redirect',
  'refused_address',
  'not_allowed',
  'expired',
] as const;

/**
 * The state of a callback row: `pending` while it may be tried, then `delivered` or `failed`.
 * @beta
 */
export type CallbackStatus = (typeof CALLBACK_STATUSES)[number];

/**
 * The last answer a try got: an HTTP status (100–599), or a word for a try that got none.
 * @beta
 */
export type CallbackLastStatus = number | (typeof CALLBACK_LAST_STATUS_WORDS)[number];

/**
 * One callback row as a store keeps it, for store implementers only.
 * It carries the address, the frozen body and the claim token, so it is never rendered: the port's
 * `read` returns a {@link CallbackView}, and the address comes only from `due` and `claim`. An unset
 * field is omitted, never `null`.
 * @beta
 */
export interface CallbackRow {
  readonly run_id: string;
  /** The run's workflow, copied at registration. */
  readonly workflow_id: string;
  readonly host: string;
  readonly webhook_id: string;
  readonly status: CallbackStatus;
  /** How many tries began. */
  readonly attempts: number;
  /** The registration's reading: the run's own `created_at` (ISO 8601). */
  readonly created_at: string;
  /** When the row may next be tried (ISO 8601). */
  readonly next_attempt_at: string;
  /** When the first try began, never changed after: where the 1-hour end counts from. */
  readonly first_attempt_at?: string;
  /** The run's `updated_at`, read when the first try began: where the 3-day end counts from. */
  readonly finished_at?: string;
  /** When the latest try began. */
  readonly last_attempt_at?: string;
  readonly last_status?: CallbackLastStatus;
  /** The address; present only while the row is `pending`. */
  readonly url?: string;
  /** The body the tries send; present only while the row is `pending`, once it is set. */
  readonly body?: string;
  /** The token of the latest try (1–200 characters); never returned by the port. */
  readonly claim_token?: string;
}

/**
 * A callback row as the port's `read` returns it: no address, body, token or webhook id.
 * @beta
 */
export type CallbackView = Omit<
  CallbackRow,
  'run_id' | 'webhook_id' | 'url' | 'body' | 'claim_token'
>;

/**
 * A row ready to send, as `due` returns it: for the sender only, never rendered.
 * @beta
 */
export type CallbackItem = Pick<
  CallbackRow,
  'run_id' | 'workflow_id' | 'host' | 'webhook_id' | 'attempts' | 'next_attempt_at' | 'body'
> & { readonly url: string };

/**
 * A claimed row: the item with the instants a sender judges its ends from.
 * @beta
 */
export type CallbackClaimedItem = CallbackItem &
  Pick<CallbackRow, 'last_status'> & {
    readonly finished_at: string;
    readonly first_attempt_at: string;
  };

/**
 * A claim of one row: the `next_attempt_at` the claimant read, and its own token (1–200 characters).
 * @beta
 */
export interface CallbackClaimRequest {
  readonly expectedNextAttemptAt: string;
  readonly token: string;
}

/**
 * What a claim answers: the claimed item and the claim's one reading, or why it did not apply.
 * @beta
 */
export type CallbackClaimResult =
  | { readonly applied: true; readonly item: CallbackClaimedItem; readonly at: string }
  | {
      readonly applied: false;
      readonly reason: 'no_row' | 'not_pending' | 'stale' | 'run_not_finished';
    };

/**
 * What freezing the body answers.
 * @beta
 */
export type CallbackFreezeResult =
  | { readonly applied: true }
  | {
      readonly applied: false;
      readonly reason: 'no_row' | 'not_pending' | 'lost_claim' | 'body_set';
    };

/**
 * A try's outcome: delivered (a 2xx status), another try after a wait in seconds, or failed.
 * @beta
 */
export type CallbackMarkRequest =
  | { readonly kind: 'delivered'; readonly lastStatus: number }
  | {
      readonly kind: 'retry';
      readonly afterSeconds: number;
      readonly lastStatus: CallbackLastStatus;
    }
  | { readonly kind: 'failed'; readonly lastStatus: CallbackLastStatus };

/**
 * What a mark answers.
 * @beta
 */
export type CallbackMarkResult =
  | { readonly applied: true }
  | { readonly applied: false; readonly reason: 'no_row' | 'not_pending' | 'lost_claim' };

/**
 * A row `expireOverdue` expired, as it expired it: `attempts` is how many tries began (0: never sent).
 * @beta
 */
export interface CallbackExpiredItem {
  readonly run_id: string;
  readonly workflow_id: string;
  readonly host: string;
  readonly attempts: number;
}

/**
 * A store's callback store (`RunStore.callbacks`): one row per run, written by `create`.
 * `due`, `claim`, `expireOverdue` and a `retry` mark each take ONE raw reading of the store's clock,
 * refused or applied; `read`, `countPending`, `countWaiting`, `freezeBody`, the other marks and the
 * purge pair take none; a malformed request throws before any reading. A run without a row is no
 * error.
 * @beta
 */
export interface CallbackStore extends PerRunArtifactStore {
  read(runId: string): Promise<CallbackView | undefined>;
  countPending(): Promise<number>;
  /** How many rows wait to be sent: `pending`, and their run finished (a run that is gone is not). */
  countWaiting(): Promise<number>;
  /** At most `limit` (1–1,000) rows to send now, one per host per round. */
  due(limit: number): Promise<CallbackItem[]>;
  /**
   * Expires, `failed` with `expired`, at most `limit` (1–1,000) rows that are due and whose run
   * finished 3 days or more before the reading, oldest first; what it expired, in that order.
   */
  expireOverdue(limit: number): Promise<CallbackExpiredItem[]>;
  claim(runId: string, request: CallbackClaimRequest): Promise<CallbackClaimResult>;
  freezeBody(runId: string, token: string, body: string): Promise<CallbackFreezeResult>;
  mark(runId: string, token: string, result: CallbackMarkRequest): Promise<CallbackMarkResult>;
  /** The signing keys, per workflow and host, kept apart from the rows (callback A2). */
  readonly keys: CallbackKeyStore;
}

/** How long a claim holds a row before it is due again, in seconds. */
export const CALLBACK_CLAIM_SECONDS = 60;
/** The longest wait a `retry` may ask for, in seconds. */
export const CALLBACK_RETRY_MAX_SECONDS = 86_400;
/**
 * Callback B2: how long a callback may wait to be delivered after its run finished, in seconds
 * (3 days). A purge keeps a run whose callback is still pending for this long, plus the grace below.
 */
export const CALLBACK_DELIVERY_WINDOW_SECONDS = 259_200;
/** Callback B2: what a purge adds to the delivery window before it takes such a run, in seconds. */
export const CALLBACK_PURGE_GRACE_SECONDS = 3_600;

const WORDS = new Set<string>(CALLBACK_LAST_STATUS_WORDS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function malformed(what: string): never {
  throw new Error(`A malformed callback request: ${what}.`);
}

const text = (v: unknown, max: number): boolean =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;
const status = (v: unknown, low: number, high: number): boolean =>
  Number.isInteger(v) && (v as number) >= low && (v as number) <= high;

/** A request to check, by the method that takes it. */
export type CallbackCheck =
  | { readonly kind: 'register'; readonly callback: CallbackRegistration }
  | { readonly kind: 'due'; readonly limit: number }
  | { readonly kind: 'claim'; readonly token: string }
  | { readonly kind: 'freeze'; readonly token: string; readonly body: string }
  | { readonly kind: 'mark'; readonly token: string; readonly result: CallbackMarkRequest };

/**
 * Checks a request, and throws on a malformed one: a store calls it BEFORE it takes its reading, so a
 * malformed request takes none. A programming error, never a refusal.
 */
export function checkCallbackRequest(check: CallbackCheck): void {
  if (check.kind === 'register') {
    const c = check.callback as Partial<CallbackRegistration> | undefined;
    if (!text(c?.url, 2048)) malformed('`callback.url` must be 1 to 2,048 characters');
    if (!text(c?.host, 255)) malformed('`callback.host` must be 1 to 255 characters');
    if (typeof c?.webhook_id !== 'string' || !UUID.test(c.webhook_id))
      malformed('`callback.webhook_id` must be a uuid');
    return;
  }
  if (check.kind === 'due') {
    if (!status(check.limit, 1, 1000)) malformed('`limit` must be a whole number from 1 to 1,000');
    return;
  }
  if (!text(check.token, 200)) malformed('the claim token must be 1 to 200 characters');
  if (check.kind === 'freeze' && !text(check.body, Number.POSITIVE_INFINITY))
    malformed('the body must be a non-empty string');
  if (check.kind !== 'mark') return;
  const r = check.result;
  if (r.kind === 'delivered') {
    if (!status(r.lastStatus, 200, 299)) malformed('a delivered mark carries a status 200 to 299');
    return;
  }
  if (r.kind !== 'retry' && r.kind !== 'failed') malformed('a mark is delivered, retry or failed');
  if (!(status(r.lastStatus, 100, 599) || WORDS.has(r.lastStatus as string)))
    malformed('`lastStatus` must be a status 100 to 599 or one of the closed words');
  if (
    r.kind === 'retry' &&
    !(
      typeof r.afterSeconds === 'number' &&
      Number.isFinite(r.afterSeconds) &&
      r.afterSeconds > 0 &&
      r.afterSeconds <= CALLBACK_RETRY_MAX_SECONDS
    )
  )
    malformed('`afterSeconds` must be a positive number up to 86,400');
}

/** The row `create` writes for a run registered with `callback`, at the create's own reading. */
export function callbackRowOf(
  runId: string,
  workflowId: string,
  callback: CallbackRegistration,
  at: Date,
): CallbackRow {
  const stamp = at.toISOString();
  return {
    run_id: runId,
    workflow_id: workflowId,
    host: callback.host,
    webhook_id: callback.webhook_id,
    status: 'pending',
    attempts: 0,
    created_at: stamp,
    next_attempt_at: stamp,
    url: callback.url,
  };
}

/** A row as `read` returns it. */
export function callbackViewOf(row: CallbackRow): CallbackView {
  const {
    run_id: _run,
    webhook_id: _id,
    url: _url,
    body: _body,
    claim_token: _token,
    ...view
  } = row;
  return view;
}

function itemOf(row: CallbackRow): CallbackItem {
  return {
    run_id: row.run_id,
    workflow_id: row.workflow_id,
    host: row.host,
    url: row.url ?? '',
    webhook_id: row.webhook_id,
    attempts: row.attempts,
    next_attempt_at: row.next_attempt_at,
    ...(row.body !== undefined ? { body: row.body } : {}),
  };
}

/** Code-unit order (SQLite's BINARY). */
const binary = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * What is due at `at`, pure: `pending` rows whose `next_attempt_at` is at or before `at` and whose run
 * is finished (`finished(runId)`: a missing run reads as not finished). Rounds go one row per host;
 * within a host by (`next_attempt_at`, `run_id`); within a round by (that row's `next_attempt_at`,
 * `host`); until `limit` rows or none is left.
 */
export function dueCallbacks(
  rows: readonly CallbackRow[],
  finished: (runId: string) => boolean,
  at: Date,
  limit: number,
): CallbackItem[] {
  const byHost = new Map<string, CallbackRow[]>();
  for (const row of rows) {
    if (row.status !== 'pending' || !isPastDeadline(row.next_attempt_at, at)) continue;
    if (!finished(row.run_id)) continue;
    const list = byHost.get(row.host) ?? [];
    list.push(row);
    byHost.set(row.host, list);
  }
  for (const list of byHost.values())
    list.sort((a, b) => binary(a.next_attempt_at, b.next_attempt_at) || binary(a.run_id, b.run_id));
  const out: CallbackItem[] = [];
  for (let round = 0; out.length < limit; round++) {
    const take = [...byHost.values()]
      .filter((list) => list.length > round)
      .map((list) => list[round]!)
      .sort((a, b) => binary(a.next_attempt_at, b.next_attempt_at) || binary(a.host, b.host));
    if (take.length === 0) break;
    for (const row of take.slice(0, limit - out.length)) out.push(itemOf(row));
  }
  return out;
}

/**
 * The claim, pure: `run` is the row's run as the store read it (`undefined` when it does not exist).
 * First match wins: `no_row` · `not_pending` · `stale` (another `next_attempt_at`) ·
 * `run_not_finished` · otherwise it applies: the token stored, `attempts` + 1, the reading as
 * `last_attempt_at` (and `first_attempt_at` when unset), `next_attempt_at` 60 s later, and the run's
 * `updated_at` as `finished_at` when unset.
 */
export function claimCallback(
  row: CallbackRow | undefined,
  run: { readonly finished: boolean; readonly updatedAt: string } | undefined,
  request: CallbackClaimRequest,
  at: Date,
): { result: CallbackClaimResult; write?: CallbackRow } {
  if (row === undefined) return { result: { applied: false, reason: 'no_row' } };
  if (row.status !== 'pending') return { result: { applied: false, reason: 'not_pending' } };
  if (row.next_attempt_at !== request.expectedNextAttemptAt)
    return { result: { applied: false, reason: 'stale' } };
  if (run === undefined || !run.finished)
    return { result: { applied: false, reason: 'run_not_finished' } };
  const stamp = at.toISOString();
  const write: CallbackRow = {
    ...row,
    claim_token: request.token,
    attempts: row.attempts + 1,
    last_attempt_at: stamp,
    next_attempt_at: new Date(at.getTime() + CALLBACK_CLAIM_SECONDS * 1000).toISOString(),
    first_attempt_at: row.first_attempt_at ?? stamp,
    finished_at: row.finished_at ?? run.updatedAt,
  };
  const item: CallbackClaimedItem = {
    ...itemOf(write),
    finished_at: write.finished_at!,
    first_attempt_at: write.first_attempt_at!,
    ...(write.last_status !== undefined ? { last_status: write.last_status } : {}),
  };
  return { result: { applied: true, item, at: stamp }, write };
}

/** The body, frozen once, pure. First match wins: `no_row` · `not_pending` · `lost_claim` · `body_set`. */
export function freezeCallbackBody(
  row: CallbackRow | undefined,
  token: string,
  body: string,
): { result: CallbackFreezeResult; write?: CallbackRow } {
  if (row === undefined) return { result: { applied: false, reason: 'no_row' } };
  if (row.status !== 'pending') return { result: { applied: false, reason: 'not_pending' } };
  if (row.claim_token !== token) return { result: { applied: false, reason: 'lost_claim' } };
  if (row.body !== undefined) return { result: { applied: false, reason: 'body_set' } };
  return { result: { applied: true }, write: { ...row, body } };
}

/**
 * A mark, pure: `at` is the store's reading, taken for `retry` only. First match wins: `no_row` ·
 * `not_pending` (a finished row never moves back) · `lost_claim` · otherwise it applies: `retry`
 * moves `next_attempt_at` and keeps the address and body; `delivered` and `failed` set the status and
 * clear the address and body in the same write.
 */
export function markCallback(
  row: CallbackRow | undefined,
  token: string,
  result: CallbackMarkRequest,
  at: Date | undefined,
): { result: CallbackMarkResult; write?: CallbackRow } {
  if (row === undefined) return { result: { applied: false, reason: 'no_row' } };
  if (row.status !== 'pending') return { result: { applied: false, reason: 'not_pending' } };
  if (row.claim_token !== token) return { result: { applied: false, reason: 'lost_claim' } };
  if (result.kind === 'retry') {
    const next = new Date(at!.getTime() + result.afterSeconds * 1000).toISOString();
    return {
      result: { applied: true },
      write: { ...row, next_attempt_at: next, last_status: result.lastStatus },
    };
  }
  return { result: { applied: true }, write: endedRow(row, result.kind, result.lastStatus) };
}

/** A row ended: the status and last answer set, the address and body cleared, the rest kept. */
function endedRow(
  row: CallbackRow,
  status: 'delivered' | 'failed',
  lastStatus: CallbackLastStatus,
): CallbackRow {
  const { url: _url, body: _body, ...kept } = row;
  return { ...kept, status, last_status: lastStatus };
}

/** How many rows wait to be sent, pure: `pending`, and `finished(runId)` (a missing run: not). */
export function countWaitingCallbacks(
  rows: readonly CallbackRow[],
  finished: (runId: string) => boolean,
): number {
  return rows.filter((row) => row.status === 'pending' && finished(row.run_id)).length;
}

/**
 * What `expireOverdue` expires at `at`, pure: `pending` rows whose `next_attempt_at` is at or before `at`,
 * whose run is finished (`runOf`: `undefined` when it does not exist), and whose anchor (the row's
 * `finished_at`, else the run's `updatedAt`, as the purge's hold reads it) is 3 days or more before
 * `at`; oldest anchor first, ties by `run_id`, at most `limit`. Each is written as a `failed` mark
 * writes it, with `expired`.
 */
export function expireOverdueCallbacks(
  rows: readonly CallbackRow[],
  runOf: (runId: string) => { readonly finished: boolean; readonly updatedAt: string } | undefined,
  at: Date,
  limit: number,
): { expired: CallbackExpiredItem[]; writes: CallbackRow[] } {
  const overdue: Array<{ row: CallbackRow; anchor: string }> = [];
  for (const row of rows) {
    if (row.status !== 'pending' || !isPastDeadline(row.next_attempt_at, at)) continue;
    const run = runOf(row.run_id);
    if (run === undefined || !run.finished) continue;
    const anchor = row.finished_at ?? run.updatedAt;
    const ms = parseStamp(anchor);
    if (ms === undefined || at.getTime() < ms + CALLBACK_DELIVERY_WINDOW_SECONDS * 1000) continue;
    overdue.push({ row, anchor });
  }
  overdue.sort((a, b) => binary(a.anchor, b.anchor) || binary(a.row.run_id, b.row.run_id));
  const taken = overdue.slice(0, limit).map(({ row }) => row);
  return {
    expired: taken.map(({ run_id, workflow_id, host, attempts }) => ({
      run_id,
      workflow_id,
      host,
      attempts,
    })),
    writes: taken.map((row) => endedRow(row, 'failed', 'expired')),
  };
}
