// gate-timing.ts — issue #291 (Deliverable 7): shared, pure, read-time gate due/overdue
// derivation — the ONE authoritative computation `list`/`get_run_state`/`inspect` all derive
// from (mirrors classifyRunHealth's own single-shared-predicate precedent, issue #221), so none
// of them can silently drift about what "expired" or "next due" means. Reads ONLY the frozen
// PendingGate fields — never the workflow definition (F2's doctrine, generalized to every
// read-time consumer).
import type { PendingGate } from '../types/run-record.js';

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
  const expiresAtMs =
    gate.expires_at !== undefined ? new Date(gate.expires_at).getTime() : undefined;
  const expired = expiresAtMs !== undefined && nowMs >= expiresAtMs;

  let nextReminderDueAt: string | undefined;
  if (gate.reminder_seconds !== undefined) {
    const openedAtMs = new Date(gate.opened_at).getTime();
    const reminderMs = gate.reminder_seconds * 1000;
    const elapsedMs = Math.max(0, nowMs - openedAtMs);
    const n = Math.floor(elapsedMs / reminderMs) + 1; // next-undelivered occurrence number
    nextReminderDueAt = new Date(openedAtMs + n * reminderMs).toISOString();
  }

  return {
    expired,
    ...(expired ? { overdue_ms: nowMs - expiresAtMs! } : {}),
    ...(nextReminderDueAt !== undefined ? { next_reminder_due_at: nextReminderDueAt } : {}),
  };
}
