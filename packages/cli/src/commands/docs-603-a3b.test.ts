// docs-603-a3b.test.ts — #603 A3b: the words the unit adds, each held to its page word for word
// (spaces folded, as a table's padding moves), with the cell that executes what the sentence says
// named beside it (guardrail 9). The Slack and command cells are agent/gate/who-answered-603b.test.ts
// ("check N"); the MCP tool's are mcp-server's tools/who-answered-603b.test.ts; core's are
// engine/who-answered-603b.test.ts.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (1) red when the page no longer holds the sentence word for word; (2) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}

const STATE = 'docs/reference/mcp/run-state-and-health.md';
const TOOLS = 'docs/reference/mcp/tools.md';
const READING = 'docs/reference/cli/realm-run-reading.md';
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const SLACK = 'docs/guides/slack-gates.md';
const PLACEHOLDER = '"responded_by": "<the person\'s name, as they gave it; leave out if none>"';
const PASS = "Pass the person's own name as responded_by when they gave one; never a guess.";

describe('#603 A3b — the screens name the Slack account that answered: the words', () => {
  it('run-state-and-health.md: the `answers` row’s two new members, and the instruction’s slot', () => {
    // `account` and its absences: core's "check 1 (core)", "check 4 (core)", the real expiry's
    // `settled_by_expiry` (core step-view.test.ts "C2", mcp-server holder-625 "C2"); the CLI's
    // "check 6" (`account_not_recorded`).
    claim(
      STATE,
      '`account` is the account the answer\'s channel reported for it, `{ "user": …, "team": … }` (`team` when the channel gave one): for a Slack answer, the member ID that replied, as Slack reports it; Realm does not verify it. When there is none, `account_absent` says why: `account_not_recorded` (the answer carries no account), `account_unreadable` (one that cannot be shown) or `settled_by_expiry`.',
    );
    // `admitted_by` and its absences: core's "check 1 (core)" (`no_named_answerer`), "check 7"
    // (`admission_unreadable`, `admission_not_recorded`), the real expiry's "C2" cells; the five values are A3a's
    // (slack-answerers-603.test.ts checks 1–7).
    claim(
      STATE,
      "`admitted_by` is how the answer's sender was let through: `owner` (the account Slack reported is the question's `owner`; Realm does not verify who chose), `answerers` (it is on the question's `answerers` list), `project_answerers` (it is on the project's list), `no_named_answerer` (the question named no one, so anyone counted) or `owner_not_checked_on_route` (the question names someone, and the answer came with no account to compare). When there is none, `admitted_by_absent` says why: `admission_not_recorded` (the answer's entry carries none), `admission_unreadable` (a value that is not one of these five) or `settled_by_expiry`.",
    );
    // The slot and the sentence: the MCP tool's "check 9"; the example is compared with a real
    // reply by docs-pages-625-run-state.test.ts.
    claim(STATE, PLACEHOLDER);
    claim(STATE, PASS);
  });

  it('tools.md: `outcome.by`’s account, the sentence’s "by" part, the slot and `responded_by`', () => {
    // The MCP tool's "check 2 (MCP)" (the account), "check 4 (MCP)" (`account_unreadable`).
    claim(
      TOOLS,
      '`account` is the account the winning answer\'s channel reported — for a Slack answer, the member ID that replied, as Slack reports it; Realm does not verify it; one that cannot be shown gives `"account_absent": "account_unreadable"` instead (both added after version 0.49.0). `basis` describes `name` only; the account carries its own label.',
    );
    // "check 2 (MCP)", "one rule: a stated name first, then the account", "check 5 (MCP)".
    claim(
      TOOLS,
      'After the name, these sentences name the account the answer\'s channel reported, when the record holds one: `, by "<name>" (as stated), U0ALICE (as Slack reports it)`, or `(as its channel reports it)` for another route (added after version 0.49.0).',
    );
    claim(
      TOOLS,
      'its choice, the name as stated and then the account its channel reported, `U0ALICE (as Slack reports it)` (each left out when the record has none; the account was added after version 0.49.0), how it arrived',
    );
    // "check 9": the slot offered, a value wrapped whole in `<` `>` records no name.
    claim(
      TOOLS,
      '`responded_by` is optional: leave it out when the person gave no name, and a value wrapped whole in `<` `>` records no name.',
    );
    claim(TOOLS, PLACEHOLDER);
    claim(TOOLS, PASS);
    claim(
      TOOLS,
      'The answer instruction\'s `call_with` offers it as `"<the person\'s name, as they gave it; leave out if none>"`; a value wrapped whole in `<` `>`, such as that placeholder copied, records no name (added after version 0.49.0).',
    );
  });

  it('realm-run-reading.md and realm-run-acting.md: the answer line and the "by" part', () => {
    // The CLI's "checks 1 and 3" (inspect), "check 5" (another route), "check 4" (unshowable), the
    // respond clause cell ("both"), "check 6" (`(not stated)` as before).
    claim(
      READING,
      'Without one it reads the account the answer\'s channel reported, when the record holds one: `answered by U0ALICE (as Slack reports it)` for a Slack answer, `(as its channel reports it)` for another route; Realm does not check it either. With both, the name comes first: `answered by "Ana" (as stated), U0ALICE (as Slack reports it)`. With neither it reads `(not stated)` (the account was added after version 0.49.0). A recorded account that cannot be printed reads as a name that cannot be printed does, with no label.',
    );
    // The CLI's "check 2" (respond's sentence), "check 5" (another route), the MCP tool's "one
    // rule" cell (the name first).
    claim(
      ACTING,
      'The `by` part names the stated name, then the account the answer\'s channel reported: `, by "<name>" (as stated), U0ALICE (as Slack reports it)`, or `(as its channel reports it)` for another route (the account was added after version 0.49.0). It is left out when the recorded answer names nobody and holds no account.',
    );
    // The CLI's "check 2" (the beaten sentence names the account) and the MCP tool's "without an
    // account the sentence is today's" (no `by` part with neither).
    claim(ACTING, 'The `by` part is left out when that answer names nobody and holds no account.');
    // The CLI's "checks 1 and 3" (`realm run inspect`'s answer line) and "check 6" (`(not stated)`).
    claim(
      ACTING,
      '(`answered by "<name>"`, the name `--by` gave; `answered by U0ALICE (as Slack reports it)`, the account Slack reported for a Slack answer; or `answered by (not stated)`)',
    );
  });

  it('slack-gates.md: the receipt, its ended form, the closing line, a reply not recorded, what is recorded', () => {
    // The CLI's "checks 1 and 3" (the receipt, the closing line) and "check 3" (the two other forms).
    claim(SLACK, '✅ Gate resolved: `send`, by U0ALICE (as Slack reports it)\nRecorded: send.');
    claim(
      SLACK,
      "`U0ALICE` is the member ID of the account that replied, as Slack reports it; Realm does not verify it. The question post's closing line names it the same way. When the answer ends the run, the reply says ``✅ Gate resolved: `send`, by U0ALICE (as Slack reports it). The run has ended.`` instead,",
    );
    // The sentence for a reply not recorded: the CLI's "check 2" (the same sentence-maker).
    claim(
      SLACK,
      'When another answer was recorded first, it names that answer: its choice, the name as stated and the account Slack reported (each left out when the record has none), where it came from and when,',
    );
    // The CLI's "checks 1 and 3".
    claim(
      SLACK,
      "so post such gates to a channel whose members you trust to decide. `realm run inspect` and the thread's receipt name that account, as Slack reports it.",
    );
  });

  it('the CHANGELOG’s Changed entry', () => {
    // The CLI's "checks 1 and 3", "check 2"; the MCP tool's "check 9".
    const text = read('CHANGELOG.md');
    const section = text.slice(text.indexOf('## [Unreleased]'), text.indexOf('\n## [0.49.0]'));
    const entry =
      "- **The screens name the Slack account that answered, as Slack reports it.** `realm run inspect`'s answer line, which said '(not stated)', and the outcome sentences and the thread's receipt, which named no one, now name the account Slack reported for the reply. The MCP answer instruction offers `responded_by` for the person's own name; a value wrapped whole in `<` `>`, as the placeholder is, records no name. (#603)";
    expect(flat(section), `the CHANGELOG no longer says: ${entry}`).toContain(flat(entry));
  });
});
