// reminder-due.ts — issue #597 D3a (design `DESIGN-D3-rev3.md` §1): ONE place for "which reminder of
// an open question is due". A pure function of the frozen question, the operator's settings, the
// question post's anchor, the question's outbound-ledger rows and one reading: the whole ordered grid
// of the question's reminder items, each with its instant and its state. The Slack notifier's waiters
// arm its `future` items; a takeover's catch-up (and D3b's sender) reads its `due` one. No I/O, no
// clock read.
import type { PendingGate } from '../types/run-record.js';
import { isPastDeadline, parseStamp } from './instants.js';
import { authoredOccurrences, isFinalReminder, reminderEligibility } from './gate-timing.js';
import { keyOf, type OutboundEntryView } from '../store/outbound-ledger.js';

/** #597 D3a: the operator's reminder settings for a question with no authored schedule, and the nudge. */
export interface ReminderSettings {
  /** The one-shot reminder of a question with no authored `reminder_seconds`, after the anchor. */
  readonly reminderIntervalMs: number;
  /** The nudge (the escalation), after the anchor: every question has one. */
  readonly escalationThresholdMs: number;
}

/** #597 D3a: one reminder item of an open question, as {@link dueReminderWork} grids them. */
export interface ReminderItem {
  /** What the outbound ledger keys it by. */
  readonly what:
    { readonly type: 'reminder'; readonly occurrence: number } | { readonly type: 'escalation' };
  /**
   * An authored occurrence; the authored final; the one reminder of a question with no authored
   * schedule (`one_shot`); or the nudge.
   */
  readonly kind: 'occurrence' | 'final' | 'one_shot' | 'nudge';
  /** Composed as the final one (the expiry's wording): the authored final, or a one-shot at or after `expires_at`. */
  readonly isFinal: boolean;
  /** Its instant, in epoch milliseconds. */
  readonly atMs: number;
  /**
   * `future`: its instant is after the reading. `due`: the latest item whose instant has passed, open
   * to be sent. `passed`: an earlier passed item (skipped, never posted), or a latest one that is not
   * open, or already sent. `consumed`: a passed item the other leg's sent line already said (the
   * same-line rule).
   */
  readonly state: 'future' | 'due' | 'passed' | 'consumed';
}

/**
 * #597 D3a: a reminder and the nudge read alike when composed within this much of each other on a
 * question that names no owner (the same-line rule across processes).
 */
export const SAME_LINE_WINDOW_MS = 60_000;

/** A Slack message timestamp: whole seconds, then optional fractional digits. */
const SLACK_TS = /^\d+(?:\.\d+)?$/;

/**
 * #597 D3a: the instant a question's one-shot reminder and its nudge count from: the question post's
 * own Slack time `ts` (in seconds), clamped up to `opened_at` (a question is not posted before its gate
 * opens) and down to the reading (a clock stepped back cannot put it later). The reading when `ts`
 * cannot be read (`tsUnreadable`, which the caller says once) or when `opened_at` cannot be read.
 */
export function reminderAnchorOf(
  gate: PendingGate,
  ts: string,
  at: Date,
): { anchorMs: number; tsUnreadable: boolean } {
  const atMs = at.getTime();
  const tsMs = SLACK_TS.test(ts) ? Number(ts) * 1000 : NaN;
  if (!Number.isFinite(tsMs) || tsMs <= 0) return { anchorMs: atMs, tsUnreadable: true };
  const openedAtMs = parseStamp(gate.opened_at);
  if (openedAtMs === undefined) return { anchorMs: atMs, tsUnreadable: false };
  return { anchorMs: Math.min(Math.max(tsMs, openedAtMs), atMs), tsUnreadable: false };
}

/**
 * #597 D3a: the WHOLE ordered grid of an open question's reminder items at the reading `at` — its
 * authored occurrences k = 1… and their final (#964's rules, anchored at `opened_at`), or, with no
 * authored schedule, the one-shot at `anchorMs + reminderIntervalMs` (final when `expires_at` is at or
 * before it); and the nudge at `anchorMs + escalationThresholdMs`, for every question. Ordered by
 * instant; on equal instants the nudge is the later.
 *
 * At most ONE item is `due`: the latest one whose instant has passed (an instant equal to the reading
 * has passed), when it is open to be sent at `at` — not closed by the expiry (`reminderEligibility`; a
 * one-shot that is not final is closed as the nudge is), not `sent` by `rows`, not `consumed`. When the
 * latest passed one is not, nothing is due: an earlier one is never walked back to. A backlog is one
 * post.
 *
 * `rows` are the run's outbound-ledger rows (the takeover's catch-up reads them; a waiter passes none).
 * On a question that names no owner, a passed item that is not final is `consumed` when a `sent` row of
 * the OTHER leg — a reminder that is not final for the nudge, the nudge for a reminder — was sent at or
 * after its instant minus {@link SAME_LINE_WINDOW_MS}: the two read the same. A `future` item is never
 * consumed.
 */
export function dueReminderWork(
  gate: PendingGate,
  settings: ReminderSettings,
  anchorMs: number,
  rows: readonly OutboundEntryView[],
  at: Date,
): ReminderItem[] {
  const atMs = at.getTime();
  type Draft = Omit<ReminderItem, 'state'>;
  const drafts: Draft[] = [];
  if (gate.reminder_seconds !== undefined) {
    const occurrences = authoredOccurrences(gate);
    for (const o of occurrences) {
      drafts.push({
        what: { type: 'reminder', occurrence: o.k },
        kind: 'occurrence',
        isFinal: false,
        atMs: parseStamp(o.at)!,
      });
    }
    const finalK = occurrences.length + 1;
    const openedAtMs = parseStamp(gate.opened_at);
    const final = { type: 'reminder', occurrence: finalK } as const;
    if (
      openedAtMs !== undefined &&
      isFinalReminder(gate, finalK) &&
      reminderEligibility(gate, final, at)
    ) {
      drafts.push({
        what: final,
        kind: 'final',
        isFinal: true,
        atMs: openedAtMs + finalK * gate.reminder_seconds * 1000,
      });
    }
  } else {
    const oneShotMs = anchorMs + settings.reminderIntervalMs;
    const expiresAtMs = gate.expires_at !== undefined ? parseStamp(gate.expires_at) : undefined;
    drafts.push({
      what: { type: 'reminder', occurrence: 1 },
      kind: 'one_shot',
      isFinal: expiresAtMs !== undefined && expiresAtMs <= oneShotMs,
      atMs: oneShotMs,
    });
  }
  drafts.push({
    what: { type: 'escalation' },
    kind: 'nudge',
    isFinal: false,
    atMs: anchorMs + settings.escalationThresholdMs,
  });
  drafts.sort((a, b) => a.atMs - b.atMs || Number(a.kind === 'nudge') - Number(b.kind === 'nudge'));

  const closed =
    gate.on_expiry !== undefined &&
    gate.expires_at !== undefined &&
    isPastDeadline(gate.expires_at, at);
  const open = (d: Draft): boolean =>
    d.kind === 'one_shot' ? d.isFinal || !closed : reminderEligibility(gate, d.what, at);
  const mine = rows.filter((r) => r.entry_key.startsWith(`gate:${gate.gate_id}:`));
  const rowOf = (what: Draft['what']): OutboundEntryView | undefined => {
    const key = keyOf(
      what.type === 'reminder'
        ? { type: 'reminder', gateId: gate.gate_id, occurrence: what.occurrence }
        : { type: 'escalation', gateId: gate.gate_id },
    );
    return mine.find((r) => r.entry_key === key);
  };
  const reminderFinal = (occurrence: number): boolean =>
    gate.reminder_seconds !== undefined
      ? isFinalReminder(gate, occurrence)
      : drafts.some((d) => d.kind === 'one_shot' && d.isFinal);
  const consumed = (d: Draft): boolean =>
    gate.owner === undefined &&
    !d.isFinal &&
    mine.some((r) => {
      const sentMs =
        r.status === 'sent' && r.sent_at !== undefined ? parseStamp(r.sent_at) : undefined;
      if (sentMs === undefined || sentMs < d.atMs - SAME_LINE_WINDOW_MS) return false;
      return d.kind === 'nudge'
        ? r.type === 'reminder' && !reminderFinal(r.occurrence ?? 1)
        : r.type === 'escalation';
    });

  const latest = drafts.reduce<number>((found, d, i) => (d.atMs <= atMs ? i : found), -1);
  return drafts.map((d, i): ReminderItem => {
    if (d.atMs > atMs) return { ...d, state: 'future' };
    if (consumed(d)) return { ...d, state: 'consumed' };
    if (i === latest && open(d) && rowOf(d.what)?.status !== 'sent') return { ...d, state: 'due' };
    return { ...d, state: 'passed' };
  });
}
