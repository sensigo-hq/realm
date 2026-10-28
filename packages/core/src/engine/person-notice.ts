// person-notice.ts — #729 PR-4 (D2 §5/§6, PD-5, PD-7): what the asked person is told, as data. A
// notice is composed from the engine's facts — the gate, the view the question composer returned, the
// respond way PR-0's ways compose, the outcome core reads off a settled record — and an adapter (the
// Slack notifier today; P3's port later) renders it. Pure: no I/O, and no clock read here — a duration
// is reckoned against the `now` the caller passes.
//
// G9 by construction: the only way a notice can carry is the person's own — `RespondWay` without the
// opening call's proof. No operator way (`drain`, `resume`, `register`) has a place in these types.
import type { PendingGate } from '../types/run-record.js';
import type { Outcome } from '../types/response-envelope.js';
import type { ErrorCode } from '../types/workflow-error.js';
import type { RespondWay, UnavailableCode } from './ways.js';
import type { QuestionView } from './question-view.js';
import { overdueOf, readInstant } from './instants.js';
import { formatDuration } from '../utils/duration.js';

/** The person's route: the respond way, without the claim proof only the opening call holds. */
type Route = Omit<RespondWay, 'proof'>;

/** A notice to the asked person: seven kinds, each one fact about their question (PD-5). */
export type PersonNotice =
  | {
      kind: 'question_opened';
      run_id: string;
      gate_id: string;
      step: string;
      view: QuestionView;
      respond: Route;
      expires_at?: string;
      owner?: string;
    }
  | {
      kind: 'reminder';
      run_id: string;
      gate_id: string;
      step: string;
      view: QuestionView;
      respond: Route;
      scheduled_at: string;
      count: number;
      /** How long the question has been open, in `formatDuration`'s form; absent when unknown. */
      elapsed?: string;
      owner?: string;
      escalation: boolean;
    }
  | {
      kind: 'expiry_reminder';
      run_id: string;
      gate_id: string;
      step: string;
      view: QuestionView;
      respond: Route;
      on_expiry: 'settle_default' | 'abort' | 'none';
      /** How long past its deadline the question is, in `formatDuration`'s form; absent when unknown. */
      overdue?: string;
    }
  | {
      kind: 'answer_recorded';
      run_id: string;
      gate_id: string;
      step: string;
      choice: string;
      run_goes_on: boolean;
      /** The author's message for the choice — only when the run goes on. */
      resolution_message?: string;
    }
  | {
      kind: 'answer_late';
      run_id: string;
      gate_id: string;
      step: string;
      choice: string;
      outcome: Outcome;
      /** Whether the run goes on after what the question met (from the reply). */
      run_goes_on: boolean;
    }
  | {
      kind: 'answer_refused';
      run_id: string;
      gate_id: string;
      step: string;
      choice: string;
      code: UnavailableCode | ErrorCode;
    }
  | {
      kind: 'question_closed';
      run_id: string;
      gate_id: string;
      step: string;
      how: 'expired' | 'abandoned' | 'superseded';
      choice?: string;
    };

/** The engine's facts a notice is composed from, per kind. */
export type PersonNoticeEvent =
  | {
      kind: 'question_opened';
      run_id: string;
      gate: PendingGate;
      view: QuestionView;
      respond: RespondWay;
    }
  | {
      kind: 'reminder';
      run_id: string;
      gate: PendingGate;
      view: QuestionView;
      respond: RespondWay;
      scheduled_at: string;
      count: number;
      escalation: boolean;
      now: Date;
    }
  | {
      kind: 'expiry_reminder';
      run_id: string;
      gate: PendingGate;
      view: QuestionView;
      respond: RespondWay;
      now: Date;
    }
  | {
      kind: 'answer_recorded';
      run_id: string;
      gate: PendingGate;
      choice: string;
      /** Whether the answer ended the run (the reply's `ended_by`). */
      ended: boolean;
    }
  | {
      kind: 'answer_late';
      run_id: string;
      gate: PendingGate;
      choice: string;
      outcome: Outcome;
      /** Whether the run has ended (the reply's or the record's own). */
      ended: boolean;
    }
  | {
      kind: 'answer_refused';
      run_id: string;
      gate: PendingGate;
      choice: string;
      code: UnavailableCode | ErrorCode;
    }
  | {
      kind: 'question_closed';
      run_id: string;
      gate: PendingGate;
      /** `outcomeOf` on the record at the poll's end; `undefined` when the run ended with the
       *  question unsettled. */
      outcome: Outcome | undefined;
    };

/**
 * How long ago a stored past event was, or how far past a stored deadline is, at `now` (PD-7): a
 * `'deadline'` through {@link overdueOf}, a `'past_event'` through {@link readInstant}, formatted by
 * {@link formatDuration} ("1h 5m", "12m", "42s"). `undefined` — never "NaNm", never "0s" — when the
 * stamp cannot be read, the deadline is not yet past, or the past event is stamped ahead of `now`.
 * Never throws: a throw from a host's timer would end the process that attends the question.
 */
export function durationWords(
  stamp: string,
  cls: 'deadline' | 'past_event',
  now: Date,
): string | undefined {
  try {
    if (cls === 'deadline') {
      const over = overdueOf(stamp, now);
      return over === undefined || 'absent' in over || !Number.isFinite(over.ms)
        ? undefined
        : formatDuration(over.ms);
    }
    const read = readInstant(stamp, 'past_event', now);
    if ('absent' in read || read.ahead_ms !== undefined) return undefined;
    const ago = now.getTime() - read.ms;
    return Number.isFinite(ago) && ago >= 0 ? formatDuration(ago) : undefined;
  } catch {
    return undefined;
  }
}

function routeOf(respond: RespondWay): Route {
  const { proof: _proof, ...route } = respond;
  return route;
}

/** One notice from the engine's facts (no I/O, no clock read). */
export function composePersonNotice(event: PersonNoticeEvent): PersonNotice {
  const ids = { run_id: event.run_id, gate_id: event.gate.gate_id, step: event.gate.step_name };
  const { gate } = event;
  switch (event.kind) {
    case 'question_opened':
      return {
        kind: 'question_opened',
        ...ids,
        view: event.view,
        respond: routeOf(event.respond),
        ...(gate.expires_at !== undefined ? { expires_at: gate.expires_at } : {}),
        ...(gate.owner !== undefined ? { owner: gate.owner } : {}),
      };
    case 'reminder': {
      const elapsed = durationWords(gate.opened_at, 'past_event', event.now);
      return {
        kind: 'reminder',
        ...ids,
        view: event.view,
        respond: routeOf(event.respond),
        scheduled_at: event.scheduled_at,
        count: event.count,
        ...(elapsed !== undefined ? { elapsed } : {}),
        ...(gate.owner !== undefined ? { owner: gate.owner } : {}),
        escalation: event.escalation,
      };
    }
    case 'expiry_reminder': {
      const overdue =
        gate.expires_at !== undefined
          ? durationWords(gate.expires_at, 'deadline', event.now)
          : undefined;
      return {
        kind: 'expiry_reminder',
        ...ids,
        view: event.view,
        respond: routeOf(event.respond),
        on_expiry: gate.on_expiry ?? 'none',
        ...(overdue !== undefined ? { overdue } : {}),
      };
    }
    case 'answer_recorded': {
      const message = event.ended ? undefined : gate.resolution_messages?.[event.choice];
      return {
        kind: 'answer_recorded',
        ...ids,
        choice: event.choice,
        run_goes_on: !event.ended,
        ...(message !== undefined ? { resolution_message: message } : {}),
      };
    }
    case 'answer_late':
      return {
        kind: 'answer_late',
        ...ids,
        choice: event.choice,
        outcome: event.outcome,
        run_goes_on: !event.ended,
      };
    case 'answer_refused':
      return { kind: 'answer_refused', ...ids, choice: event.choice, code: event.code };
    case 'question_closed': {
      const by = event.outcome?.by.kind;
      if (by === 'timeout') return { kind: 'question_closed', ...ids, how: 'expired' };
      if (by === 'answer') {
        const choice = event.outcome?.choice;
        return {
          kind: 'question_closed',
          ...ids,
          how: 'superseded',
          ...(choice !== undefined ? { choice } : {}),
        };
      }
      return { kind: 'question_closed', ...ids, how: 'abandoned' };
    }
  }
}
