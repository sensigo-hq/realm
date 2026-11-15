// outbound-send.ts — issue #597, D1b (design record `DESIGN-D1-rev5.md` §2 D1b): ONE attempt to send a
// reminder or the escalation of a run's open question through the run store's outbound ledger
// (`store.outbound`, D1a): lease the occurrence, post it, then mark it, and say what happened. It
// schedules nothing and keeps no "last line posted": the Slack notifier owns those, and the later
// server sender (D3) calls this same function with its own post. The post is a parameter, so this file
// never imports the notifier's `postSlackReply` (the verdict's type alone is imported).
//
// The mark table is a closed set: Slack's `ok` is marked `sent`; the channel-class permanent refusals
// `channel_not_found` and `is_archived` are marked `failed` (a retry cannot help); EVERY other
// outcome is left unmarked, to be retried once by the caller: a timeout, a network or server error, a
// rate limit, and every other Slack code, the auth class and `not_in_channel` included (an operator can
// fix those; `postSlackReply` already warns with the code).
import { randomUUID } from 'node:crypto';
import type { OutboundLeaseRequest, OutboundLedger, OutboundResult } from '@sensigo/realm';
import type { SlackVerdict } from './slack-gate-notifier.js';

/** How long a sender holds an occurrence: a Slack post is bounded at 90 s (three 30-s calls). */
export const OUTBOUND_LEASE_SECONDS = 120;

/** The refusals the mark records as `failed`: the channel is gone, so no retry can succeed. */
const FAILED_CODES: ReadonlySet<string> = new Set(['channel_not_found', 'is_archived']);

/** Slack's auth-class refusals: never marked `failed` (a token can be fixed); retried once. */
const AUTH_CODES: ReadonlySet<string> = new Set([
  'invalid_auth',
  'token_revoked',
  'account_inactive',
  'not_authed',
  'missing_scope',
  'token_expired',
]);

/** What the mark answered: `outbound_done` means another sender's mark came first. */
export type OutboundMarkAnswer = 'applied' | 'outbound_done' | 'lease_lost';

/** Why a lease was refused. */
export type OutboundLeaseRefusal = Extract<OutboundResult, { applied: false }>['reason'];

/** What one attempt did. */
export type OutboundSendOutcome =
  /** Posted and marked `sent` (or the mark found another sender's: see `mark`). */
  | { readonly kind: 'sent'; readonly mark: OutboundMarkAnswer }
  /** Refused by Slack for good (`channel_not_found`, `is_archived`) and marked `failed`. */
  | { readonly kind: 'failed'; readonly code: string; readonly mark: OutboundMarkAnswer }
  /** Not posted: the lease was refused; `lease_held`/`already_leased` carry the lease's deadline. */
  | {
      readonly kind: 'skipped';
      readonly reason: OutboundLeaseRefusal;
      readonly leaseDeadline?: string;
    }
  /** Posted but not taken, and left unmarked: Slack's code or the failure's kind, and its class. */
  | {
      readonly kind: 'unmarked';
      readonly code: string;
      readonly class: 'auth' | 'access' | 'transient';
      readonly leaseDeadline: string;
      /** A post that threw (not a verdict): what it threw. */
      readonly error?: unknown;
    }
  /** The lease call threw: nothing was posted. */
  | { readonly kind: 'lease_threw'; readonly error: unknown }
  /** The post was made, then its mark threw: the row stays pending. */
  | {
      readonly kind: 'mark_threw';
      readonly result: 'sent' | 'failed';
      readonly code?: string;
      readonly error: unknown;
    };

export interface OutboundSendInput {
  readonly ledger: OutboundLedger;
  readonly runId: string;
  readonly what: OutboundLeaseRequest['what'];
  /** The composed text, posted as it is. */
  readonly text: string;
  /** The caller's post; a throw is an unmarked, transient outcome. */
  readonly post: (text: string) => Promise<SlackVerdict>;
}

function markAnswer(marked: OutboundResult): OutboundMarkAnswer {
  // `already_marked` cannot answer a fresh token's one mark; read as this sender's own.
  if (marked.applied || marked.reason === 'already_marked') return 'applied';
  return marked.reason === 'outbound_done' ? 'outbound_done' : 'lease_lost';
}

/** One attempt: lease (a fresh token, {@link OUTBOUND_LEASE_SECONDS}), post, mark. Never throws. */
export async function sendOnce(input: OutboundSendInput): Promise<OutboundSendOutcome> {
  const { ledger, runId, what, text } = input;
  const leaseToken = randomUUID();
  let leased: OutboundResult;
  try {
    leased = await ledger.lease(runId, { what, leaseToken, leaseSeconds: OUTBOUND_LEASE_SECONDS });
  } catch (error) {
    return { kind: 'lease_threw', error };
  }
  if (!leased.applied) {
    const held = leased.reason === 'lease_held' || leased.reason === 'already_leased';
    return {
      kind: 'skipped',
      reason: leased.reason,
      ...(held && leased.entry !== undefined ? { leaseDeadline: leased.entry.lease_deadline } : {}),
    };
  }
  let verdict: SlackVerdict;
  let thrown: { error: unknown } | undefined;
  try {
    verdict = await input.post(text);
  } catch (error) {
    verdict = { ok: false, cause: 'error', error };
    thrown = { error };
  }
  const code = verdict.ok
    ? undefined
    : verdict.cause === 'refused'
      ? verdict.reason
      : verdict.cause;
  if (code === undefined || FAILED_CODES.has(code)) {
    const result = code === undefined ? 'sent' : 'failed';
    let marked: OutboundResult;
    try {
      marked = await ledger.mark(runId, {
        what,
        leaseToken,
        result,
        outcome: code === undefined ? 'ok' : `refused:${code}`,
      });
    } catch (error) {
      return { kind: 'mark_threw', result, ...(code !== undefined ? { code } : {}), error };
    }
    return code === undefined
      ? { kind: 'sent', mark: markAnswer(marked) }
      : { kind: 'failed', code, mark: markAnswer(marked) };
  }
  return {
    kind: 'unmarked',
    code,
    class: AUTH_CODES.has(code) ? 'auth' : code === 'not_in_channel' ? 'access' : 'transient',
    leaseDeadline: leased.entry.lease_deadline,
    ...(thrown !== undefined ? { error: thrown.error } : {}),
  };
}
