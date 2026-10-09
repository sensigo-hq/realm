// stop-kind.ts — issue #625 PR-2a, the last prompt's F7 (review G7-07, A3-7): the ONE rule for "another
// program got there first". It was stated four times (core's advance loop, `realm run advance`,
// `realm agent`, `realm workflow run`) and the copies disagreed; it lives here, once, and every loop
// reads it. Moved unchanged from `realm run advance`'s rule (rounds 25–26, decisions C194 and C199),
// joined with the advance loop's own record check for a `blocked` reply with no code.
import type { ResponseEnvelope } from '../types/response-envelope.js';
import type { RunRecord } from '../types/run-record.js';

/**
 * Every kind of stop a loop can meet on a step it picked or ran. The first six are race kinds —
 * another program got there first, and the loop goes on with what is left: `taken` (another
 * program holds the step, or ran it before this call claimed it), `ran_elsewhere` (another program
 * settled the step this call ran), `run_ended`, `claim_removed` (the claim this call held was
 * removed and nobody settled the step: it is owed again), `question_opened`, `not_eligible` (the
 * claim's own re-check refused it, and the record shows nothing more). The last three stop the
 * loop: `capability` (this program lacks the step's handler or adapter), `failed` (the record lists
 * the step the reply is about as failed), `refused` (any other refusal).
 */
export const STOP_KINDS = [
  'taken',
  'ran_elsewhere',
  'run_ended',
  'claim_removed',
  'question_opened',
  'not_eligible',
  'capability',
  'failed',
  'refused',
] as const;

/** One of {@link STOP_KINDS}. */
export type StopKind = (typeof STOP_KINDS)[number];

/** The three kinds that stop a loop: what is left does not run. */
export type HaltStopKind = Extract<StopKind, 'capability' | 'failed' | 'refused'>;

/** The six race kinds: another program got there first, and the loop goes on with what is left. */
export type RaceStopKind = Exclude<StopKind, HaltStopKind>;

/**
 * A race: its kind, and whether this call's handler ran and its outcome was not recorded
 * (`ran_here` — true only when the step's own settle was refused: `taken`, `ran_elsewhere`,
 * `run_ended` or `claim_removed` from `STATE_STEP_ALREADY_SETTLED`, `STATE_CLAIM_LOST` or
 * `STATE_RUN_TERMINAL`).
 */
export interface RaceStop {
  kind: RaceStopKind;
  ran_here: boolean;
}

/** A stop that ends the loop. */
export interface HaltStop {
  kind: HaltStopKind;
}

/** What {@link classifyStop} returns. */
export type StopClassification = RaceStop | HaltStop;

/** The four kinds of a race in which this call's handler ran (`ran_here: true`). */
export type NotRecordedKind = Extract<
  RaceStopKind,
  'taken' | 'ran_elsewhere' | 'run_ended' | 'claim_removed'
>;

/** Whether `stop` is a race: the loop goes on with what is left. */
export function isRaceStop(stop: StopClassification | undefined): stop is RaceStop {
  return stop !== undefined && 'ran_here' in stop;
}

/** The parts of a reply the classifier reads. */
export type StopReply = Pick<
  ResponseEnvelope,
  'status' | 'error_code' | 'stopped_step' | 'error_details'
>;

/** The parts of the re-read record the classifier reads. */
export type StopRecord = Pick<
  RunRecord,
  'terminal_state' | 'pending_gate' | 'in_progress_steps' | 'completed_steps' | 'failed_steps'
>;

/**
 * The step a refusal is about: the reply's `stopped_step` (the step whose own reply it is), else the
 * step its `error_details` name (a guard of the chain whose settle was refused names no
 * `stopped_step`). `undefined` when it names none.
 */
export function stopAbout(reply: StopReply): string | undefined {
  if (reply.stopped_step !== undefined) return reply.stopped_step;
  const step = reply.error_details?.['step'];
  return typeof step === 'string' ? step : undefined;
}

/** The codes of a settle refused because another program acted after this call's claim. */
const SETTLE_RACE_CODES: ReadonlySet<string> = new Set([
  'STATE_STEP_ALREADY_SETTLED',
  'STATE_CLAIM_LOST',
  'STATE_RUN_TERMINAL',
]);

/** The codes of a step this program lacks the code for. */
const CAPABILITY_CODES: ReadonlySet<string> = new Set([
  'ENGINE_HANDLER_NOT_REGISTERED',
  'ENGINE_ADAPTER_NOT_REGISTERED',
]);

/**
 * What kind of stop a loop met on a step it picked or ran (`step`), from the reply and the record
 * RE-READ after it — asked only by a loop (core's advance loop, `realm run advance`, `realm agent`,
 * `realm workflow run`), never of a direct `execute_step` call's own reply, which is the reply.
 * First matching row wins:
 *
 * 1. `blocked`, `STATE_STEP_ALREADY_CLAIMED` → `taken`.
 * 2. `blocked` with no code, about `step` (not eligible on the engine's own read, or a failed
 *    precondition): the step in flight, completed or failed → `taken`; else the run ended →
 *    `run_ended`; else a question is open → `question_opened`; else none (a precondition block —
 *    hosts render it as before).
 * 3. `error`, `STATE_STEP_ALREADY_SETTLED`, `STATE_CLAIM_LOST` or `STATE_RUN_TERMINAL`, about
 *    `step` (`ran_here`): the run not ended and the step in progress → `taken`; else the step
 *    settled → `ran_elsewhere`; else the run ended → `run_ended`; else → `claim_removed`.
 * 4. `error`, `STATE_STEP_NOT_ELIGIBLE`, about `step` (the claim's re-check): the run ended →
 *    `run_ended`; else a question is open → `question_opened`; else → `not_eligible`.
 * 5. `error`, `ENGINE_HANDLER_NOT_REGISTERED` or `ENGINE_ADAPTER_NOT_REGISTERED` → `capability`.
 * 6. Any other `error`: the record lists the step it is about ({@link stopAbout}) as failed →
 *    `failed`; else → `refused`.
 *
 * `undefined` for any other reply (`ok`, `confirm_required`, a `blocked` reply rows 1–2 do not take).
 */
export function classifyStop(
  reply: StopReply,
  step: string | undefined,
  record: StopRecord,
): StopClassification | undefined {
  const about = stopAbout(reply);
  const ended = record.terminal_state === true;
  const question = !ended && record.pending_gate !== undefined;
  const settled = (s: string) =>
    record.completed_steps.includes(s) || record.failed_steps.includes(s);
  if (reply.status === 'blocked') {
    if (reply.error_code === 'STATE_STEP_ALREADY_CLAIMED')
      return { kind: 'taken', ran_here: false };
    if (reply.error_code !== undefined || step === undefined || about !== step) return undefined;
    if (record.in_progress_steps.includes(step) || settled(step)) {
      return { kind: 'taken', ran_here: false };
    }
    if (ended) return { kind: 'run_ended', ran_here: false };
    if (question) return { kind: 'question_opened', ran_here: false };
    return undefined;
  }
  if (reply.status !== 'error') return undefined;
  const code = reply.error_code;
  if (
    code !== undefined &&
    SETTLE_RACE_CODES.has(code) &&
    step !== undefined &&
    reply.stopped_step === step
  ) {
    if (!ended && record.in_progress_steps.includes(step)) return { kind: 'taken', ran_here: true };
    if (settled(step)) return { kind: 'ran_elsewhere', ran_here: true };
    if (ended) return { kind: 'run_ended', ran_here: true };
    return { kind: 'claim_removed', ran_here: true };
  }
  if (code === 'STATE_STEP_NOT_ELIGIBLE' && step !== undefined && reply.stopped_step === step) {
    if (ended) return { kind: 'run_ended', ran_here: false };
    if (question) return { kind: 'question_opened', ran_here: false };
    return { kind: 'not_eligible', ran_here: false };
  }
  if (code !== undefined && CAPABILITY_CODES.has(code)) return { kind: 'capability' };
  if (about !== undefined && record.failed_steps.includes(about)) return { kind: 'failed' };
  return { kind: 'refused' };
}
