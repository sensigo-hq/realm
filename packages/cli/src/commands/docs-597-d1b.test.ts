// docs-597-d1b.test.ts — issue #597 D1b (guardrails 7(f) and 9): every sentence D1b writes is quoted
// here word for word and asserted to be on its page, read from the repository, with the cell that
// executes what it says named beside it. The sentences that said nothing writes the ledger yet are
// asserted gone. Each assertion names (a) the change that turns it red and (b) what it prints when it
// fails.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogAbove } from '../test-support/changelog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/**
 * The CHANGELOG's sections above `[0.49.0]`: D1b's lines shipped in 0.50.0, so they are read in every
 * section above the release before, `[Unreleased]` included once the next cycle opens it (the
 * release pass's helper; reading `[Unreleased]` alone went red when #616 R3 opened it).
 */
function unreleased(): string {
  return changelogAbove(read('CHANGELOG.md'), '0.49.0');
}
function claimChangelog(sentence: string): void {
  expect(flat(unreleased()), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

const SLACK = 'docs/guides/slack-gates.md';
const READING = 'docs/reference/cli/realm-run-reading.md';
const CORE = 'docs/reference/core-library.md';

describe('#597 D1b — the docs say what the reminders record, and only what is true', () => {
  it('slack-gates.md, the Reminders section: the ledger, the retry, a store that cannot record, the catch-up', () => {
    // slack-reminder-ledger-d1b "lease before post", slack-reminder-writes-nothing-715b (nothing
    // written to the run).
    claim(
      SLACK,
      "`realm agent` records its reminders and the escalation in the store's outbound ledger, beside the run; nothing is written to the run. Before it posts one, it leases it there; once Slack took it, it marks it sent.",
    );
    // slack-reminder-ledger-d1b "contention" and "restart".
    claim(
      SLACK,
      'So when two `realm agent`s attend one question, each reminder is posted once, and an agent started again does not post a reminder that was already sent.',
    );
    // outbound-send-d1b "the mark table"; slack-reminder-ledger-d1b "the mark table at the notifier"
    // (the retry at the 120-s lease's deadline, `channel_not_found` not retried).
    claim(
      SLACK,
      'A post Slack did not take is tried once more about two minutes later, unless Slack refused it because the channel is gone or archived.',
    );
    // slack-reminder-ledger-d1b "a lease that throws at the scheduled instant" and "… at the catch-up
    // or at a retry posts NOTHING".
    claim(
      SLACK,
      'When the store cannot record a reminder that is due, `realm agent` posts it anyway and says so once; a catch-up or a retry is not posted then.',
    );
    // slack-reminder-catch-up-d1b "a takeover" and "a first-time post"; slack-reminder-ledger-d1b
    // "a takeover after the interval" (the latest passed occurrence, the true age) and "restart" (a
    // sent one is not posted again).
    claim(
      SLACK,
      "A `realm agent` started again while a question is open, which uses the stopped agent's question post, posts at once the latest reminder that came due, if it was not sent yet, with the time the question has really been open; the ones before it are not posted.",
    );
    // slack-reminder-ledger-d1b "a takeover of a gate with no authored schedule" and "a takeover
    // after `expires_at` of an `on_expiry` gate"; #597 D3a: slack-reminder-due-d3a "one post at most"
    // (the escalation) and "a catch-up never posts a final" (an `on_expiry` gate and a finding-only one).
    claim(
      SLACK,
      'It does so for every gate, the reminder of a gate with no `reminder_seconds` and the escalation too, never for the reminder that says the time ran out.',
    );
    // outbound-lines-d1b (every case).
    claim(
      SLACK,
      '`realm run inspect` and `realm run list` show what was recorded (see [Reading runs](../reference/cli/realm-run-reading.md)). Added after version 0.49.0.',
    );
  });

  it('realm-run-reading.md: the `list` row and the `inspect` lines, their grammar and their absences', () => {
    // outbound-lines-d1b "`list`: a `gate_waiting` row carries …" and "sent, skipped and not confirmed
    // together".
    claim(
      READING,
      "On a run in `gate_waiting`, the line then says what `realm agent` recorded of the question's Slack reminders and escalation, in the words of `realm run inspect` below: `reminders: …` and, when there is one, `escalation: …` (added after version 0.49.0).",
    );
    // outbound-lines-d1b "where it prints".
    claim(
      READING,
      "After the question's block, or after `Updated:` when no question is open, two lines say what `realm agent` recorded of the question's Slack reminders and escalation in the store's outbound ledger (added after version 0.49.0):",
    );
    // outbound-lines-d1b "sent, skipped and not confirmed together, with the escalation" (these two
    // lines, exactly).
    claim(
      READING,
      '```text\nReminders: 1 sent (of at most 3), last 30m ago (2030-01-01T00:10:00Z); 1 skipped; 1 not confirmed\nEscalation: sent 28m ago (2030-01-01T00:12:00Z)\n```',
    );
    // outbound-lines-d1b "counts" (sent, `of at most` from the row, `last`); outbound-send-d1b "the
    // lease comes first" (the ledger's `of_max`: core's `leaseOutbound`, D1a's laws).
    claim(
      READING,
      "`N sent` counts the reminders Slack took, of at most the gate's `reminder_max` (3 when the gate sets `reminder_seconds` and no `reminder_max`; 1 when it sets no `reminder_seconds`), and `last` says when the latest was recorded as sent.",
    );
    // outbound-lines-d1b "counts" (`2 skipped` for an occurrence 3 alone); slack-reminder-ledger-d1b
    // "a takeover after the interval" (occurrence 1 skipped).
    claim(
      READING,
      '`K skipped` counts the earlier reminders that were never posted, for example ones that came due while the computer slept or while no `realm agent` attended the question.',
    );
    // An inference from the ledger's rules (a 0.49 send left no row; the count is the highest leased
    // occurrence minus the rows): outbound-lines-d1b "counts" executes the count.
    claim(
      READING,
      'On a question that was open at the upgrade from version 0.49.0, `skipped` may count reminders that a 0.49 `realm agent` sent, since they left no record.',
    );
    // outbound-lines-d1b "not confirmed" (a passed lease; a live one prints nothing).
    claim(
      READING,
      '`U not confirmed` counts the reminders a `realm agent` or `realm listen --send-reminders` started to send and never recorded as sent or failed, for example because it stopped, or because Slack took neither the post nor its retries.',
    );
    // Correction 1: outbound-lines-d1b "not confirmed" (a live reminder lease: `0 sent`, nothing
    // counted) and "the escalation" (a live escalation lease: no line).
    claim(
      READING,
      'A reminder or the escalation that is being sent right now, its lease still running, is not counted yet: it shows as sent once Slack took it, and as not confirmed if its lease ends first.',
    );
    // Correction 1: outbound-lines-d1b's four "the lines are about one question" cells (the open
    // question's rows; a finished run's newest row's question, the first question's when the second
    // got none).
    claim(
      READING,
      'The lines are about the question that is open; when none is, about the latest question that has a reminder or an escalation recorded.',
    );
    // outbound-lines-d1b "counts" (failed); outbound-send-d1b "the mark table" (the two codes).
    claim(
      READING,
      '`F failed (not retried)` counts the reminders Slack refused because the channel is gone or archived. A count of zero is left out, except `N sent`.',
    );
    // outbound-lines-d1b "the escalation" and "absence".
    claim(
      READING,
      'The escalation reads `sent <when>`, `not confirmed` or `failed (not retried)`. An open question with no reminder recorded reads `Reminders: none recorded`.',
    );
    // outbound-lines-d1b "absence" and "a read that throws".
    claim(
      READING,
      'A run with neither an open question nor a recorded reminder or escalation prints neither line, and so does a store that keeps no outbound ledger, or one whose ledger cannot be read.',
    );
  });

  it('the `list` samples end with the ledger part, as the command prints it (correction 1)', () => {
    // outbound-lines-d1b "the docs' `list` samples" (an open gate with no schedule).
    claim(
      'docs/guides/human-gates.md',
      '64993bb2-6f65-47d9-801c-d008e9291a00  announce v1  gate_waiting  2026-10-01T20:13:36.512Z  2 step(s)  gate: review opened 0s ago (2026-10-01T20:13:36Z)  reminders: none recorded',
    );
    claim(
      READING,
      'fd894510-2017-4018-8087-1b1f357b6dfd  triage v1  gate_waiting  2026-10-01T22:52:36.904Z  2 step(s)  gate: draft opened 0s ago (2026-10-01T22:52:36Z)  reminders: none recorded',
    );
    // age-words-715b A8/A9 (an expired gate: `… EXPIRED 30s ago (…)  reminders: none recorded`).
    claim(
      'docs/reference/workflow/gates.md',
      '3fdf338c-…  ex-default v1  gate_waiting  …  gate: approve opened 1m ago (2026-10-09T09:13:00Z)  EXPIRED 0s ago (2026-10-09T09:14:00Z)  reminders: none recorded',
    );
  });

  it('core-library.md, environment-and-files.md, upgrade.md: what writes the ledger', () => {
    // slack-reminder-ledger-d1b "lease before post"; outbound-lines-d1b.
    claim(
      CORE,
      "The store of `@sensigo/realm-store-sqlite` keeps one, in its file's `outbound` table. `realm agent` leases reminders in it. Added after version 0.49.0.",
    );
    // The same cells (the home's SQLite store keeps the ledger: D1c-2's cells).
    claim(
      'docs/reference/environment-and-files.md',
      '`outbound`, a per-run table where `realm agent` records the Slack reminders and escalation it sends;',
    );
    claim(
      'docs/guides/upgrade.md',
      'which adds `outbound`, a per-run table where `realm agent` records the Slack reminders and escalation it sends.',
    );
  });

  it('the CHANGELOG: the Upgrading item, the Added line, and the three sentences rewritten', () => {
    // R13 (a question open at the upgrade): inferred from the ledger's rules, as the item says.
    claimChangelog(
      '**7. Answer or let open Slack questions expire before you upgrade.** A question open at the upgrade may get a repeated reminder or escalation when its agent restarts (the 0.49 reminders and escalations left no record).',
    );
    // slack-reminder-ledger-d1b (the lease, the mark, contention, restart, the retry, the catch-up);
    // outbound-lines-d1b (the lines); slack-reminder-writes-nothing-715b; inspect- and
    // list-gate-expiry-render (the clause's text).
    claimChangelog(
      "- **`realm agent` records its Slack reminders and escalation** (issue #597): before it posts one it leases it in the store's outbound ledger, and it marks it sent once Slack took it (failed when the channel is gone or archived), so two agents on one question, or a restarted one, post each reminder once; any other post Slack did not take is tried once more when its lease ends. A `realm agent` started again that uses a stopped agent's question post sends one catch-up reminder, for the latest one that came due if it was not sent yet, for any gate (never the reminder that says the time ran out). `realm run inspect` prints `Reminders:` and `Escalation:` lines after the open question, and `realm run list` `reminders:` and `escalation:` on a `gate_waiting` row, counted from the ledger: sent, skipped, not confirmed, failed. Nothing is written to the run. The text of `REMINDER_BASIS_CLAUSE` (core) is now `reminders are sent only while a realm agent attends this question, or realm listen --send-reminders is running`: the line beside it says what was recorded.",
    );
    claimChangelog("`realm agent`'s Slack reminders use it (below).");
    claimChangelog(
      'one new per-run table, `outbound`, where `realm agent` records the Slack reminders and escalation it sends.',
    );
    claimChangelog(
      "`realm run purge` counts its rows in the bytes a dry run shows, and `realm agent`'s Slack reminders use it (below).",
    );
  });

  it('no page, changelog line or source comment still says the ledger is unused', () => {
    // (a) red when one of the sentences D1a, D1c-1 and D1c-2 wrote ("nothing writes yet", "Nothing in
    //     Realm uses the ledger yet", "No Realm command uses it yet") is left; (b) prints where.
    const files = [
      'CHANGELOG.md',
      CORE,
      'docs/reference/environment-and-files.md',
      'docs/guides/upgrade.md',
      'packages/core/src/store/store-interface.ts',
      'packages/store-sqlite/src/run-store.ts',
    ];
    const left = files.flatMap((f) =>
      [
        'a per-run table nothing writes yet',
        'that nothing writes yet',
        'Nothing in Realm uses the ledger yet',
        'Nothing in Realm uses it yet',
        'No Realm command uses it yet (D1b)',
      ]
        .filter((s) => flat(read(f)).includes(s))
        .map((s) => `${f}: ${s}`),
    );
    // The D1c-2 changelog line's own sentence, which sat beside `realm run purge` counting the rows.
    const loose = flat(unreleased()).includes(
      'counts its rows in the bytes a dry run shows. No Realm command uses it yet.',
    );
    expect({ left, loose }).toEqual({ left: [], loose: false });
  });

  it('`REMINDER_BASIS_CLAUSE` carries its new text, and the old clause is gone from core', () => {
    // (a) red when the constant keeps "no send is recorded" or changes by a word; (b) prints the
    //     declaration.
    const src = read('packages/core/src/engine/gate-timing.ts');
    const declared = /export const REMINDER_BASIS_CLAUSE =\s*'([^']*)'/.exec(src)?.[1];
    expect(declared).toBe(
      'reminders are sent only while a realm agent attends this question, or realm listen --send-reminders is running',
    );
  });
});
