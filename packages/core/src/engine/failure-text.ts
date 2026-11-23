// failure-text.ts — gap 2, unit (iv-b1): a run's failure words as a view shows them under the
// failure-text setting `hidden` — their length, in the walk's own shape, `‹string, N characters›`.
// Which text is a failure's words is judged by the run's seal arm (the recorded one, or the legacy
// classifier's for a run sealed before arms were recorded), never by reading the reason. Read only:
// the record is never changed; a caller shows what these return in place of the record's text.
import { SEAL_ARMS, type RunRecord, type SealArm } from '../types/run-record.js';
import { classifyLegacySeal } from './eligibility.js';
import {
  failureMessagesFromEvidence,
  handlerAbortReason,
  renderFailCause,
  stepFailedReason,
} from './settlement.js';
import { FIXED_TERMINAL_REASONS } from '../utils/disclosure-tables.js';
import { shapeOf } from '../utils/disclosure-walk.js';
import { WorkflowError } from '../types/workflow-error.js';

/** A failure's words as such a view shows them: their length, `‹string, N characters›`. */
export function failureTextShape(text: string): string {
  return shapeOf(text) as string;
}

/** The arm that sealed `run`: the recorded one when this Realm knows it, else the legacy
 *  classifier's; `undefined` when it cannot be placed. */
function sealArmOf(run: RunRecord): SealArm | undefined {
  const arm = run.sealed_by?.arm;
  if (arm !== undefined && (SEAL_ARMS as readonly string[]).includes(arm)) return arm;
  return classifyLegacySeal(run);
}

/** `reason` with the text after `prefix` shaped; the whole reason shaped when it does not start with
 *  `prefix` (the sentence cannot be placed). */
function shapedAfter(reason: string, prefix: string): string {
  return reason.startsWith(prefix)
    ? `${prefix}${failureTextShape(reason.slice(prefix.length))}`
    : failureTextShape(reason);
}

/** The several-failures sentence, through core's own renderer, with each step's message shaped. It
 *  may name more steps than the stored sentence, whose messages took more room. */
function severalFailed(run: RunRecord): string {
  const shaped = new Map<string, string>();
  for (const [step, message] of failureMessagesFromEvidence(run.evidence)) {
    shaped.set(step, failureTextShape(message));
  }
  return renderFailCause(run.failed_steps, shaped);
}

/**
 * `run`'s `terminal_reason` with a failure's words shaped, or `undefined` when the reason holds none
 * and is shown as it is. By the seal arm:
 * - one failed step (`step_failure`): `Step '<step>' failed: ‹string, N characters›`, N the length
 *   of the stored reason's text after Realm's words;
 * - a handler's abort: `Handler '<step>' aborted the run: ‹string, N characters›`;
 * - several failed steps (a step failure, a guard's resolution error with more than one failed
 *   step, a finalizer's failure after a failed seal): the several-failures sentence with each
 *   step's message shaped;
 * - an arm that cannot be placed, or a reason that does not start with its arm's words: the whole
 *   reason shaped.
 * Kept as they are: Realm's fixed reasons, a completed run, an abandon (a person's reason), a gate's
 * expiry, a guard's abort (the author's message), a guard's resolution error with one failed step
 * (Realm's words for the guard), `spawn_failed` and `extensions_load_failed`.
 */
export function terminalReasonHidingFailureText(run: RunRecord): string | undefined {
  const reason = run.terminal_reason;
  if (typeof reason !== 'string' || FIXED_TERMINAL_REASONS.includes(reason)) return undefined;
  const failed = [...new Set(run.failed_steps)];
  switch (sealArmOf(run)) {
    case 'step_failure':
      if (failed.length > 1) return severalFailed(run);
      return failed.length === 1
        ? shapedAfter(reason, stepFailedReason(failed[0]!, ''))
        : failureTextShape(reason);
    case 'guard_resolution_error':
      return failed.length > 1 ? severalFailed(run) : undefined;
    case 'handler_abort': {
      const step = run.sealed_by?.step ?? run.aborted_at?.step_id;
      return step !== undefined
        ? shapedAfter(reason, handlerAbortReason(step, ''))
        : failureTextShape(reason);
    }
    case undefined:
      return failureTextShape(reason);
    default:
      return undefined;
  }
}

/**
 * `run`'s `aborted_at.abort_message` shaped when it is a failure's words — a handler's abort, or an
 * abort whose arm cannot be placed — else `undefined`, and it is shown as it is: a guard's abort
 * message is the workflow author's own, and a gate's expiry writes Realm's fixed sentence.
 */
export function abortMessageHidingFailureText(run: RunRecord): string | undefined {
  const message = run.aborted_at?.abort_message;
  if (typeof message !== 'string') return undefined;
  const arm = sealArmOf(run);
  return arm === 'handler_abort' || arm === undefined ? failureTextShape(message) : undefined;
}

// ── The replies to an assistant's own call (gap 2, unit (iv-b2a)) ──────────────────────────────

/**
 * Which text in an engine reply is a failure's words, as core wrote it, at the places that know: a
 * failed step's reply (its `errors[0]` and its `error_details`) and a handler's abort (the span of
 * `context_hint` core wrote). A refusal of the call is never marked. The door shapes a field only
 * while it still holds the marked text (`errors[0]` equal to `message`, `error_details` the marked
 * object, `context_hint` holding `abort.text`); finding it is applying the mark, never judging text.
 */
export interface FailureTextMark {
  /** `errors[0]` as core wrote it: the failing code's message (a retried step's: Realm's wrapper). */
  readonly message?: string;
  /**
   * The `error_details` object core put on the reply, and which of its values are a failure's words:
   * `last_error` where core minted the details itself (the retry wrap; a model failure's), so only
   * their `lastError` is; `failing_code` where they are the failing code's own (a handler's, an
   * adapter's, and Realm's own on that path, which Step 5 cannot tell apart): every value but a
   * number in `status` or `retry_after`.
   */
  readonly details?: {
    readonly object: Readonly<Record<string, unknown>>;
    readonly words: 'last_error' | 'failing_code';
  };
  /** A handler's abort: the sentence core wrote into `context_hint`, and its shaped twin. */
  readonly abort?: { readonly text: string; readonly shaped: string };
}

/** The marks, keyed as `noteErrorSnapshot` keys its snapshot: on a failed reply's `error` object, on
 *  an abort reply's `basis` (it has no `error`); both survive the spreads on the way to the door. */
const MARKS = new WeakMap<object, FailureTextMark>();

/** Internal to core: marks the reply that `key` (its `error` object, or its `basis`) belongs to. */
export function noteFailureText(key: object, mark: FailureTextMark): void {
  MARKS.set(key, mark);
}

/**
 * The failure-text mark of an engine reply, read through its `error` object, else its `basis`;
 * `undefined` when core marked none (every refusal, every reply with no failed step).
 */
export function failureTextMarkOf(reply: {
  readonly error?: unknown;
  readonly basis?: unknown;
}): FailureTextMark | undefined {
  const { error, basis } = reply;
  if (typeof error === 'object' && error !== null) {
    const marked = MARKS.get(error);
    if (marked !== undefined) return marked;
  }
  return typeof basis === 'object' && basis !== null ? MARKS.get(basis) : undefined;
}

// Gap 2, unit (iv-b2b): the project's code failing to load. Which thrown error carries a failure's
// words is marked by the code that knows (the CLI loader, at its four throws that quote what the
// project's code threw), never judged from its text.

/** The errors (and the price sources a failed load returned) whose text is a failure's words. */
const FAILURE_WORDS = new WeakSet<object>();
/** The providers Realm builds itself (the CLI's), whose unmarked throws are Realm's own sentences. */
const REALM_PROVIDERS = new WeakSet<object>();

/** Internal: marks `thrown` (an error, or a price source a failed load returned) as a failure's
 *  words, on the same object; returns it. */
export function noteFailureWords<T extends object>(thrown: T): T {
  FAILURE_WORDS.add(thrown);
  return thrown;
}

/** Whether `thrown` was marked as a failure's words ({@link noteFailureWords}). */
export function carriesFailureWords(thrown: unknown): boolean {
  return typeof thrown === 'object' && thrown !== null && FAILURE_WORDS.has(thrown);
}

/** Internal: notes `provider` as one Realm builds itself; returns it. */
export function noteRealmProvider<T extends object>(provider: T): T {
  REALM_PROVIDERS.add(provider);
  return provider;
}

/**
 * The one rule for a throw from a provider that loads the project's code: a marked throw is a
 * failure's words; a `WorkflowError` never is (Realm's or an embedder's typed refusal); any other
 * throw is one only when `provider` is not Realm's own (an embedder's: fail closed).
 */
export function isFailureWordsThrow(thrown: unknown, provider: object): boolean {
  if (thrown instanceof WorkflowError) return false;
  return carriesFailureWords(thrown) || !REALM_PROVIDERS.has(provider);
}
