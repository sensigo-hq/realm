// callback-store.ts — R1.3 the callback, callback A1a (prompt `feat-callback-a1-delivery-port.md` and
// its split amendment; design `DESIGN-CALLBACK-rev4.md` over rev 3 §2.5): the callback store's door
// side. One row per run, BESIDE the run record and never in it: where to tell the caller the run
// finished, and the state of telling. The sender's methods (callback A1b), the signing keys (A2), the
// SQLite table (B), the door (C2) and the sender (C3) come later.
//
// Core declares the port, its request check and its pure parts; a store does the I/O around them, as
// `outbound-ledger.ts`: it checks the request (`checkCallbackRequest`) before any reading, and writes
// a new run's row (`callbackRowOf`) in the same step as the run.
import type { PerRunArtifactStore } from './per-run-artifact-store.js';

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
 * The last answer a try got: an HTTP status (100–599), or a word for a try that got none.
 * @beta
 */
export type CallbackLastStatus =
  number | 'timeout' | 'connection' | 'redirect' | 'refused_address' | 'not_allowed' | 'expired';

/**
 * One callback row as a store keeps it, for store implementers only.
 * It carries the address, the frozen body and the token, so it is never rendered: the port's `read`
 * returns a {@link CallbackView}, and no method of this port returns the address. An unset field is
 * omitted, never `null`.
 * @beta
 */
export interface CallbackRow {
  readonly run_id: string;
  /** The run's workflow, copied at registration. */
  readonly workflow_id: string;
  readonly host: string;
  readonly webhook_id: string;
  readonly status: 'pending' | 'delivered' | 'failed';
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
 * A store's callback store (`RunStore.callbacks`): one row per run, written by `create`.
 * `read`, `countPending` and the purge pair take no reading of the store's clock; the row is written
 * at the create's own reading. A run without a row is no error.
 * @beta
 */
export interface CallbackStore extends PerRunArtifactStore {
  read(runId: string): Promise<CallbackView | undefined>;
  countPending(): Promise<number>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function malformed(what: string): never {
  throw new Error(`A malformed callback request: ${what}.`);
}

const text = (v: unknown, max: number): boolean =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;

/** A request to check, by the method that takes it. */
export type CallbackCheck = { readonly kind: 'register'; readonly callback: CallbackRegistration };

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
  }
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
