// delivery-pass.ts — callback C3a (R1.3; the callback design rev 4 §1.8, §2): the ONE pass that sends
// what is due. For each due row it can serve, it claims the row, ends it when its time limit has passed,
// builds the body once and freezes it, signs it with the pair's keys read fresh, posts it to the
// address the door stored (exactly as stored), and records the answer. Every collaborator is passed
// in; the pass is the shape `makePollRunner` takes. Not wired into `realm listen` here (C3b).
//
// Nothing it logs, throws or marks carries a key, an address (beyond its host label), a body or a
// result: host labels, workflow ids, run ids, attempt numbers, statuses and the closed words only.
import { randomBytes } from 'node:crypto';
import {
  CALLBACK_DELIVERY_WINDOW_SECONDS,
  isPastDeadline,
  parseStamp,
  type CallbackClaimedItem,
  type CallbackItem,
  type CallbackKeyPair,
  type CallbackLastStatus,
  type CallbackMarkRequest,
  type CallbackStore,
  type RunRecord,
} from '@sensigo/realm';
import type { Logger } from '../../commands/listen.js';
import { VERSION } from '../../version.js';
import {
  readFields,
  readReplyBody,
  type ReadContext,
  type ReadEntry,
} from '../run-read-address.js';
import type { CallbackLists } from './allow-list.js';
import { postOnce, type PostOnceOptions, type PostOutcome } from './post-once.js';
import { callbackRetryWaitSeconds } from './retry-wait.js';
import { callbackSignatureHeader, webhookTimestamp } from './signature.js';

/** A pass's budget, on the monotonic clock: no row starts after it (the next pass comes 1 s later). */
export const CALLBACK_PASS_BUDGET_MS = 45_000;
/** How many due rows one listing asks for: the port's maximum, the pending cap. */
export const CALLBACK_DUE_LISTING = 1_000;
/** A callback whose last answer was a 4xx (but 408, 425, 429) ends this long after its first try: 1 h. */
export const CALLBACK_CLIENT_ERROR_END_SECONDS = 3_600;
/** The 4xx answers that are tried again until the 3 days are up: timeout, too early, too many. */
const RETRIED_4XX: ReadonlySet<number> = new Set([408, 425, 429]);

export interface CallbackPassDeps {
  /** The store's callback store (`runStore.callbacks`). */
  readonly callbacks: CallbackStore;
  /** The run, or `undefined` when the store holds none. */
  readonly getRun: (runId: string) => Promise<RunRecord | undefined>;
  /** The route entry of a workflow this process mounts, or `undefined`. */
  readonly entryOf: (workflowId: string) => ReadEntry | undefined;
  readonly disclosureProvider: ReadContext['disclosureProvider'];
  readonly lists: CallbackLists;
  /** The port `realm listen` listens on: this machine on it is never a destination. */
  readonly ownPort: number;
  readonly logger: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** For the cells only (`postOnce`'s resolver and trusted certificates). */
  readonly seams?: PostOnceOptions['seams'];
  /** One try's deadline in milliseconds (`postOnce`'s 10,000 by default). */
  readonly deadlineMs?: number;
  /** The jitter's random source, from 0 to 1 (`Math.random` by default). */
  readonly random?: () => number;
  /** The `webhook-timestamp` clock ({@link webhookTimestamp} by default). */
  readonly timestamp?: () => number;
}

/** The keys a pair signs with, or the master key's fingerprint (`undefined`: no key) it cannot read. */
type SigningKeys =
  | { readonly current: string; readonly previous?: string }
  | { readonly missing: string | undefined };

/** The pair's readable keys: the current, and the previous while the store hands it back readable. */
function signingKeys(pair: CallbackKeyPair): SigningKeys {
  const current = pair.current;
  if (current === undefined) return { missing: undefined };
  if (current.state !== 'readable') return { missing: current.master_fp };
  const previous = pair.previous;
  return previous?.state === 'readable'
    ? { current: current.key, previous: previous.key }
    : { current: current.key };
}

/** Whether `seconds` after `stamp` has passed at `reading` (an unreadable stamp never has). */
function passed(stamp: string, seconds: number, reading: Date): boolean {
  const ms = parseStamp(stamp);
  return ms !== undefined && isPastDeadline(new Date(ms + seconds * 1000).toISOString(), reading);
}

/**
 * Whether a claimed row's time limit has passed at the claim's reading `at`: 3 days after its run
 * finished; or 1 hour after its first try when its last answer was a 4xx other than 408, 425, 429.
 */
function expiredAt(item: CallbackClaimedItem, at: string): boolean {
  const reading = new Date(at);
  if (passed(item.finished_at, CALLBACK_DELIVERY_WINDOW_SECONDS, reading)) return true;
  const last = item.last_status;
  return (
    typeof last === 'number' &&
    last >= 400 &&
    last <= 499 &&
    !RETRIED_4XX.has(last) &&
    passed(item.first_attempt_at, CALLBACK_CLIENT_ERROR_END_SECONDS, reading)
  );
}

/** What a try's outcome does to its row. `dead`: the host is not tried again in this pass. */
type Verdict =
  | { readonly kind: 'delivered'; readonly status: number }
  | { readonly kind: 'failed'; readonly last: 410 | 'not_allowed' }
  | {
      readonly kind: 'retry';
      readonly last: CallbackLastStatus;
      readonly retryAfter?: number;
      readonly dead: boolean;
    };

function verdictOf(outcome: PostOutcome): Verdict {
  if (outcome.kind === 'failed') {
    if (outcome.word === 'not_allowed') return { kind: 'failed', last: 'not_allowed' };
    const dead = outcome.word === 'timeout' || outcome.word === 'connection';
    return { kind: 'retry', last: outcome.word, dead };
  }
  const status = outcome.status;
  // A status the store cannot record (outside 100 to 599) counts as a broken connection.
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    return { kind: 'retry', last: 'connection', dead: true };
  }
  if (status >= 200 && status <= 299) return { kind: 'delivered', status };
  if (status === 410) return { kind: 'failed', last: 410 };
  return {
    kind: 'retry',
    last: status,
    dead: false,
    ...(outcome.retryAfterSeconds !== undefined ? { retryAfter: outcome.retryAfterSeconds } : {}),
  };
}

/** The class name of a thrown value, for the one line an unexpected error gets. */
const classOf = (err: unknown): string =>
  err instanceof Error ? err.constructor.name : typeof err;

/**
 * The callback sender's pass, with its memory for this process (the lines said once). Answers
 * whether it stopped with work left because its budget ended.
 */
export function makeCallbackPass(
  deps: CallbackPassDeps,
): (live: () => boolean) => Promise<boolean> {
  const { callbacks, logger } = deps;
  const random = deps.random ?? Math.random;
  const timestamp = deps.timestamp ?? webhookTimestamp;
  /** Lines said once per key in this process: an unmounted workflow, a pair without a key. */
  const said = new Set<string>();
  /** Per run, the lines said once for it; dropped when its row ends. */
  const saidFor = new Map<string, Set<string>>();
  const once = (key: string, line: string): void => {
    if (said.has(key)) return;
    said.add(key);
    logger.warn(line);
  };
  const oncePerRun = (runId: string, key: string, line: string): void => {
    let keys = saidFor.get(runId);
    if (keys === undefined) saidFor.set(runId, (keys = new Set()));
    if (keys.has(key)) return;
    keys.add(key);
    logger.warn(line);
  };

  /** Ends the row with `result`; the line is said only when the mark applied. */
  const end = async (
    item: CallbackClaimedItem,
    token: string,
    result: CallbackMarkRequest,
    line: string,
    level: 'info' | 'warn',
  ): Promise<void> => {
    const marked = await callbacks.mark(item.run_id, token, result);
    if (!marked.applied) return;
    saidFor.delete(item.run_id);
    logger[level](line);
  };

  /** The body: the frozen bytes, or the envelope built and frozen now; `undefined` drops the try. */
  const bodyOf = async (
    item: CallbackClaimedItem,
    token: string,
    entry: ReadEntry,
    prefix: string,
  ): Promise<string | undefined> => {
    if (item.body !== undefined) return item.body;
    const run = await deps.getRun(item.run_id);
    if (run === undefined) {
      oncePerRun(
        item.run_id,
        'no run',
        `${prefix} run ${item.run_id} was not found; it will try again`,
      );
      return undefined;
    }
    let data: Record<string, unknown>;
    try {
      data = await readReplyBody(entry, run, { disclosureProvider: deps.disclosureProvider });
    } catch {
      oncePerRun(
        item.run_id,
        'no body',
        `${prefix} could not build the body for run ${item.run_id}; it will try again`,
      );
      return undefined;
    }
    // The read address only: the read code is never part of a callback.
    const { status_path } = readFields(entry, item.run_id);
    const text = JSON.stringify({
      type: 'run.finished',
      timestamp: item.finished_at,
      data: { ...data, ...(status_path !== undefined ? { status_path } : {}) },
    });
    const frozen = await callbacks.freezeBody(item.run_id, token, text);
    return frozen.applied ? text : undefined;
  };

  /** One due row: skipped, or claimed and tried once. `dead`: the hosts ended for this pass. */
  const tryRow = async (row: CallbackItem, dead: Set<string>): Promise<void> => {
    const workflow = row.workflow_id;
    const prefix = `callbacks: ${workflow} → ${row.host}:`;
    const entry = deps.entryOf(workflow);
    if (entry === undefined) {
      once(
        `unmounted\0${workflow}`,
        `callbacks: ${workflow} is not mounted by this realm listen, so its callbacks wait`,
      );
      return;
    }
    if (dead.has(row.host)) return;
    // Fresh for every try, never cached: a rotation, an expiry or another process's write counts.
    const keys = signingKeys(await callbacks.keys.read(workflow, row.host));
    if ('missing' in keys) {
      const why =
        keys.missing === undefined ? 'none' : `sealed with encryption key ${keys.missing}`;
      once(
        `no key\0${workflow}\0${row.host}\0${keys.missing ?? 'none'}`,
        `${prefix} no signing key this process can read (${why}), so its callbacks wait`,
      );
      return;
    }
    const token = randomBytes(16).toString('hex');
    const claim = await callbacks.claim(row.run_id, {
      expectedNextAttemptAt: row.next_attempt_at,
      token,
    });
    if (!claim.applied) return;
    const { item, at } = claim;
    const attempt = item.attempts;
    if (expiredAt(item, at)) {
      await end(
        item,
        token,
        { kind: 'failed', lastStatus: 'expired' },
        `${prefix} stopped at attempt ${attempt}: not delivered within its time limit`,
        'warn',
      );
      return;
    }
    const body = await bodyOf(item, token, entry, prefix);
    if (body === undefined) return;
    const sentAt = timestamp();
    const outcome = await postOnce({
      url: item.url,
      body,
      headers: {
        'webhook-id': item.webhook_id,
        'webhook-timestamp': String(sentAt),
        'webhook-signature': callbackSignatureHeader(keys, item.webhook_id, sentAt, body),
        'content-type': 'application/json',
        'user-agent': `realm/${VERSION}`,
        'realm-run-id': item.run_id,
      },
      lists: deps.lists,
      ownPort: deps.ownPort,
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
      ...(deps.seams !== undefined ? { seams: deps.seams } : {}),
    });
    const verdict = verdictOf(outcome);
    if (verdict.kind === 'delivered') {
      await end(
        item,
        token,
        { kind: 'delivered', lastStatus: verdict.status },
        `${prefix} delivered (attempt ${attempt})`,
        'info',
      );
      return;
    }
    if (verdict.kind === 'failed') {
      const line =
        verdict.last === 410
          ? `${prefix} the receiver answered 410, so it will not be tried again`
          : `${prefix} not sent: its address is no longer allowed by this realm listen`;
      await end(item, token, { kind: 'failed', lastStatus: verdict.last }, line, 'warn');
      return;
    }
    if (verdict.dead) dead.add(item.host);
    const marked = await callbacks.mark(item.run_id, token, {
      kind: 'retry',
      afterSeconds: callbackRetryWaitSeconds(attempt, random, verdict.retryAfter),
      lastStatus: verdict.last,
    });
    if (marked.applied) {
      oncePerRun(
        item.run_id,
        `retry\0${String(verdict.last)}`,
        `${prefix} attempt ${attempt} failed (last answer ${verdict.last}); it will try again`,
      );
    }
  };

  return async (live) => {
    const started = performance.now();
    const spent = (): boolean => performance.now() - started >= CALLBACK_PASS_BUDGET_MS;
    /** The rows handled or skipped in this pass: a row due again within it waits for the next. */
    const seen = new Set<string>();
    const dead = new Set<string>();
    for (;;) {
      const rows = (await callbacks.due(CALLBACK_DUE_LISTING)).filter((r) => !seen.has(r.run_id));
      if (rows.length === 0) return false;
      for (const row of rows) {
        if (!live()) return false;
        if (spent()) return true;
        seen.add(row.run_id);
        try {
          await tryRow(row, dead);
        } catch (err) {
          logger.error(
            `callbacks: ${row.workflow_id} → ${row.host}: unexpected error (${classOf(err)}) for run ${row.run_id}`,
          );
        }
      }
    }
  };
}
