// gate-timing.ts — issue #291 (Deliverable 7): shared, pure, read-time gate due/overdue
// derivation — the ONE authoritative computation `list`/`get_run_state`/`inspect` all derive
// from (mirrors classifyRunHealth's own single-shared-predicate precedent, issue #221), so none
// of them can silently drift about what "expired" or "next due" means. Reads ONLY the frozen
// PendingGate fields — never the workflow definition (F2's doctrine, generalized to every
// read-time consumer).
import type { PendingGate } from '../types/run-record.js';
import type { Snapshot } from './snapshot.js';
import { isPastDeadline, overdueOf, parseStamp } from './instants.js';

/**
 * Read-time due/overdue state for a live gate. `overdue_ms` is present iff `expired`.
 * `next_reminder_due_at` is present iff the gate carries a frozen `reminder_seconds` — the
 * next-undelivered occurrence's scheduled instant (`opened_at + n·reminder_seconds`), computed
 * PURELY from the schedule (no surface here has any record of which reminders were actually
 * delivered — Slack posting is a side effect these read-only surfaces never observe — so this is
 * honestly a SCHEDULE projection, not a delivery-confirmed fact; deliberately no "overdue"
 * boolean on the reminder side for that reason — see the report's design-questions section).
 */
export interface GateDueState {
  expired: boolean;
  overdue_ms?: number;
  next_reminder_due_at?: string;
}

export function computeGateDueState(gate: PendingGate, now: Date): GateDueState {
  const nowMs = now.getTime();
  // #729 PR-0 (A2): the one due test and the one parser of a stored deadline.
  const overdue = gate.expires_at !== undefined ? overdueOf(gate.expires_at, now) : undefined;
  const expired = gate.expires_at !== undefined && isPastDeadline(gate.expires_at, now);

  let nextReminderDueAt: string | undefined;
  // #715 (b) (D-25): `opened_at` through the one stamp parser — an unparseable stamp yields NO
  // occurrence (it used to throw RangeError from `new Date(NaN).toISOString()`).
  const openedAtMs = parseStamp(gate.opened_at);
  if (gate.reminder_seconds !== undefined && openedAtMs !== undefined) {
    const reminderMs = gate.reminder_seconds * 1000;
    const elapsedMs = Math.max(0, nowMs - openedAtMs);
    const n = Math.floor(elapsedMs / reminderMs) + 1; // next-undelivered occurrence number
    nextReminderDueAt = new Date(openedAtMs + n * reminderMs).toISOString();
  }

  return {
    expired,
    ...(expired && overdue !== undefined && 'ms' in overdue ? { overdue_ms: overdue.ms } : {}),
    ...(nextReminderDueAt !== undefined ? { next_reminder_due_at: nextReminderDueAt } : {}),
  };
}

/** #715 (b) (02 §D.3): one scheduled reminder of an open question — the k-th, at its instant. */
export interface ReminderOccurrence {
  /** 1-based: the first reminder is `opened_at + reminder_seconds`. */
  k: number;
  /** `opened_at + k·reminder_seconds`, ISO 8601. */
  at: string;
}

/**
 * #715 (b) (02 §D.3, D6-21, Amendment 9): an open question's authored reminder schedule — what is
 * SCHEDULED, never what was sent (no send is recorded on the run; a reminder is sent only while a
 * process attends the question).
 */
export interface ReminderSchedule {
  /** The frozen `reminder_max` (the mint default, 3, when a grandfathered gate carries none). */
  max: number;
  /** Every scheduled occurrence: k = 1…`max`, each before the question's `expires_at`. */
  occurrences: ReminderOccurrence[];
  /** The first occurrence the snapshot's reading has not passed (`isPastDeadline`: one exactly at it has passed). */
  next?: ReminderOccurrence;
}

/**
 * #715 (b) (02 §D.3, D6-21): the ONE function every view and sender reads an open question's
 * reminder schedule from — pure, of a snapshot: occurrence k at `opened_at + k·reminder_seconds`,
 * k ≤ the frozen `reminder_max`, each before the frozen `expires_at` (the notifier's last message at
 * or after it is the expiry's, not a reminder). `undefined` when the run has no open question or
 * the question has no AUTHORED reminder; no occurrence when `opened_at` cannot be read. `next` is the
 * first occurrence not past at the snapshot's `at` (`isPastDeadline`, the engine's one due test,
 * `at ≥ deadline`: an occurrence exactly at `at` has passed).
 */
export function reminderScheduleOf(snapshot: Snapshot): ReminderSchedule | undefined {
  const gate = snapshot.record.pending_gate;
  if (gate === undefined || gate.reminder_seconds === undefined) return undefined;
  const max = gate.reminder_max ?? 3;
  const openedAtMs = parseStamp(gate.opened_at);
  if (openedAtMs === undefined) return { max, occurrences: [] };
  const expiresAtMs = gate.expires_at !== undefined ? parseStamp(gate.expires_at) : undefined;
  const occurrences: ReminderOccurrence[] = [];
  for (let k = 1; k <= max; k++) {
    const atMs = openedAtMs + k * gate.reminder_seconds * 1000;
    if (expiresAtMs !== undefined && atMs >= expiresAtMs) break;
    occurrences.push({ k, at: new Date(atMs).toISOString() });
  }
  const next = occurrences.find((o) => !isPastDeadline(o.at, snapshot.at));
  return { max, occurrences, ...(next !== undefined ? { next } : {}) };
}

/** #715 (b) (02 §D.3, D6-21, R14): what a reminder view says it does not know. */
export const REMINDER_BASIS_CLAUSE =
  'no send is recorded; reminders are sent only while a process attends this question';

/**
 * #715 (b) (02 §D.3, Amendment 9): a reminder schedule in words, for `inspect` and `list` — the
 * next scheduled occurrence and how many are scheduled (each before the question's deadline), or
 * that none is left; always with the basis clause. "Scheduled", never "due", "overdue" or "sent".
 */
export function reminderScheduleWords(schedule: ReminderSchedule): string {
  return schedule.next !== undefined
    ? `next reminder: ${schedule.next.k} of ${schedule.occurrences.length} scheduled (${REMINDER_BASIS_CLAUSE})`
    : `no further reminder is scheduled (${REMINDER_BASIS_CLAUSE})`;
}
