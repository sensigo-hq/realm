// outbound-words.ts — issue #597, D1b: what `realm run inspect` and `realm run list` say about a run's
// outbound ledger (`store.outbound`, D1a): the reminders and the escalation a `realm agent` leased and
// sent for the run's open question, counted from the ledger's rows alone (a view, never the lease
// token), by status and type, at the run read's own reading.
//
// Reminders: `N sent (of at most M), last <when>; K skipped; U not confirmed; F failed (not retried)`.
// N counts the sent reminder rows; M is the first reminder row's `of_max`; `last` is the latest
// `sent_at` through the one formatter, only when N ≥ 1; K is the highest leased occurrence minus the
// reminder rows (the occurrences a later one consumed); U counts the pending rows whose lease has
// passed at the reading (a live lease is a send under way, and prints nothing); F counts the failed
// rows. A part that is zero is left out, except `N sent`. With no reminder row, a run whose question
// is open reads `none recorded`. The escalation: `sent <when>`, `not confirmed`, or `failed (not
// retried)`, on its own.
import {
  formatInstantWords,
  isPastDeadline,
  type OutboundEntryView,
  type RunStore,
} from '@sensigo/realm';

/**
 * The run's ledger rows, or `undefined` when the store keeps no ledger or its read throws (the
 * command then prints no ledger line and nothing else changes).
 */
export async function readOutboundRows(
  store: RunStore,
  runId: string,
): Promise<readonly OutboundEntryView[] | undefined> {
  const outbound = store.outbound;
  if (outbound === undefined || outbound === null) return undefined;
  try {
    return await outbound.read(runId);
  } catch {
    return undefined;
  }
}

/** The two parts' words, without their labels; a part with nothing to say is absent. */
export interface OutboundWords {
  readonly reminders?: string;
  readonly escalation?: string;
}

/** Whether a pending row's lease has passed at `at` (so its send is not confirmed). */
const unconfirmed = (row: OutboundEntryView, at: Date): boolean =>
  row.status === 'pending' && isPastDeadline(row.lease_deadline, at);

/** The latest of the rows' `sent_at`, by its text (the store's one shape sorts as time). */
function latestSent(rows: readonly OutboundEntryView[]): string | undefined {
  let latest: string | undefined;
  for (const row of rows)
    if (row.sent_at !== undefined && (latest === undefined || row.sent_at > latest))
      latest = row.sent_at;
  return latest;
}

/** The ledger's words for a run's rows at the read's reading `at`; `gateOpen`: its question is open. */
export function outboundWords(
  rows: readonly OutboundEntryView[],
  at: Date,
  gateOpen: boolean,
): OutboundWords {
  const reminders = rows.filter((r) => r.type === 'reminder');
  const escalation = rows.find((r) => r.type === 'escalation');
  let reminderWords: string | undefined;
  if (reminders.length > 0) {
    const sent = reminders.filter((r) => r.status === 'sent');
    const ofMax = reminders[0]!.of_max;
    const last = sent.length > 0 ? latestSent(sent) : undefined;
    const lastWords = last !== undefined ? formatInstantWords(last, 'past_event', at) : undefined;
    const highest = Math.max(...reminders.map((r) => r.occurrence ?? 0));
    const parts = [
      `${sent.length} sent${ofMax !== undefined ? ` (of at most ${ofMax})` : ''}${lastWords !== undefined ? `, last ${lastWords}` : ''}`,
    ];
    const skipped = highest - reminders.length;
    if (skipped > 0) parts.push(`${skipped} skipped`);
    const notConfirmed = reminders.filter((r) => unconfirmed(r, at)).length;
    if (notConfirmed > 0) parts.push(`${notConfirmed} not confirmed`);
    const failed = reminders.filter((r) => r.status === 'failed').length;
    if (failed > 0) parts.push(`${failed} failed (not retried)`);
    reminderWords = parts.join('; ');
  } else if (gateOpen) {
    reminderWords = 'none recorded';
  }
  let escalationWords: string | undefined;
  if (escalation !== undefined) {
    if (escalation.status === 'sent') {
      const when =
        escalation.sent_at !== undefined
          ? formatInstantWords(escalation.sent_at, 'past_event', at)
          : undefined;
      escalationWords = when !== undefined ? `sent ${when}` : 'sent';
    } else if (escalation.status === 'failed') {
      escalationWords = 'failed (not retried)';
    } else if (unconfirmed(escalation, at)) {
      escalationWords = 'not confirmed';
    }
  }
  return {
    ...(reminderWords !== undefined ? { reminders: reminderWords } : {}),
    ...(escalationWords !== undefined ? { escalation: escalationWords } : {}),
  };
}
