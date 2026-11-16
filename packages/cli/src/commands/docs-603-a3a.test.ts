// docs-603-a3a.test.ts — #603 A3a: the words the unit adds, each held to its page word for word
// (spaces folded, as a table's padding moves), with the cell that executes what the sentence says
// named beside it (guardrail 9). The Slack cells are agent/gate/slack-answerers-603.test.ts
// ("check N"); validate's are commands/validate-slack-answerers-603.test.ts; core's are
// engine/answerer-603.test.ts; the store kit's is realm-testing's ANSWERER_REFUSAL_WRITES_NOTHING.
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
/** The section that holds this unit's entries: `[Unreleased]` until a release renames it. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.indexOf('## [Unreleased]');
  const section = text.slice(start, text.indexOf('\n## [0.49.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

const GATES = 'docs/reference/workflow/gates.md';
const SLACK = 'docs/guides/slack-gates.md';

describe('#603 A3a — who may answer in Slack: the words', () => {
  it("gates.md: `owner`'s rule and the `answerers` key", () => {
    // In Slack only the named accounts: checks 1–4; the mention form: check 2; no one named: the
    // `answerers` section (checks 6, 7); MCP, a form, the terminal not compared: check 8.
    claim(
      GATES,
      'In Slack, when a question names who may answer, only those accounts can: its `owner` and its `answerers`, compared with the member ID Slack reports for the reply (for a question that names no one, see `answerers`).',
    );
    // A non-id owner matches no reply, so with no member-ID `answerers` only outside Slack: check 5
    // (U9 refused privately, `realm run respond` answers it); other routes not compared: check 8.
    claim(
      GATES,
      'An `owner` that is not a member ID, such as `@ana`, matches no reply, so unless an `answerers` entry is a member ID the question can then be answered only outside Slack. Answers through MCP, a form or the terminal are not compared with `owner`.',
    );
    // The stored question's `answerers`, frozen from the gate: core's "the question freezes them".
    claim(GATES, '"answerers": ["U024BE7LH"],');
    // Also may answer: check 3; the project's list: check 6; otherwise anyone: check 7; a name that
    // is not a member ID matches no reply: check 5; a malformed list refused: core check 13.
    claim(
      GATES,
      "A list of Slack member IDs (`U…` or `W…`, or the mention `<@U…>`) who may also answer the question in Slack. When a question names no `owner` and no `answerers`, the project's `notifiers.slack_gate.config.answerers` answer it when set, and otherwise anyone in the thread can. A name that is not a member ID matches no reply. Added after version 0.49.0.",
    );
    claim(GATES, 'This page lists the three `trust` values and the ten `gate` keys,');
  });

  it('gates-and-trust.md and what-is-realm.md: the rule, and what is not checked', () => {
    // Only the named count: check 1; the project's list: check 6; anyone: check 7; the account
    // recorded as Slack reports it: check 1; other routes not compared: check 8.
    claim(
      'docs/concepts/gates-and-trust.md',
      "**In Slack, Realm checks who answers.** When a question names who may answer, only those accounts count; with none named, the project's `answerers` can, or else anyone in the thread. Realm records how the answer arrived, and the account as Slack reports it. It does not verify that a person made the choice, or which person. Other routes are not compared with `owner`.",
    );
    claim(
      'docs/start/what-is-realm.md',
      "- **It checks who answers a gate only in Slack.** A gate is answered by one call, from the command line, from Slack, or through the same MCP connection the agent uses. In Slack, when a question names who may answer, only those accounts count, as Slack reports them; the other routes are not compared with the gate's `owner`. Realm does not verify that a person gave the answer.",
    );
  });

  it('slack-gates.md: the post, the mention, the rules and the record', () => {
    // The closed post: check 5.
    claim(
      SLACK,
      'the post says `Reply in this thread with` and the choices first, unless no one the question names is a Slack member ID: then it says `Replies in this thread are not counted`.',
    );
    // A bare ID mentioned: check 14; another owner matches no reply: check 5.
    claim(
      SLACK,
      'A bare member ID such as `U024BE7LH` is shown as a mention too. Any other `owner`, such as `@ana`, is shown as written and matches no reply.',
    );
    // The private note for a choice from anyone else: checks 1, 3, 4, 5; their reply changes
    // nothing: check 1 (the record unchanged); a clarification only for someone who may answer:
    // check 9.
    claim(
      SLACK,
      '- **The reply must come from an account the question names**, when it names any (see [`owner` and `answerers`](../reference/workflow/gates.md#owner)). Anyone else who replies with a choice gets a private note, and their reply changes nothing.',
    );
    claim(
      SLACK,
      'For a reply that matches no choice, from someone who may answer, Realm answers in the thread with',
    );
    // The account recorded: check 1; no one named: checks 6 and 7.
    claim(
      SLACK,
      "The run record keeps the choice and the account that replied, as Slack reports it. When a question names no one, the project's `answerers` ([`notifiers.slack_gate.config.answerers`](../reference/deployment-manifest.md)) can answer it, or without them anyone who can post in the channel, so post such gates to a channel whose members you trust to decide.",
    );
    // A reply from someone the question does not name counts for nothing: checks 1, 3, 4, 9.
    claim(
      SLACK,
      'Check that the reply is in the thread, that it is exactly one of the choices, that it comes from an account the question names (when it names any), and that',
    );
    // Copy member ID: Slack's own help (slack.com/help/articles/360003827751); a member ID is the
    // form a reply matches: checks 1 and 14.
    claim(
      SLACK,
      "To find a person's member ID, open their full profile in Slack, choose **More**, then **Copy member ID**.",
    );
  });

  it('compatibility.md, the CHANGELOG and the upgrade guide: the breaking change and its help', () => {
    // A non-id owner closed in Slack, for a question open at the upgrade too (a stored question has
    // the same shape): check 5.
    claim(
      'docs/reference/compatibility.md',
      "(so far 0.42.0's `trust` check, and the Slack answerer rule: a gate whose `owner` is not a Slack member ID can no longer be answered in its Slack thread, in a registered workflow as in a question open when you upgrade)",
    );
    // By member ID: checks 1–4; a handle closed: check 5; validate names it and --strict fails:
    // validate-slack-answerers-603 check 12.
    claimChangelog(
      "**9. In Slack, a question that names who may answer can be answered only by them.** When a gate has an `owner` or the new `answerers`, a reply in the thread counts only when it comes from one of them, by Slack member ID. A question whose `owner` is a handle such as `@ana`, a user group or `@here`, and that lists no `answerers`, can no longer be answered in Slack. Before you upgrade, answer or finish open Slack questions that have such an owner; after it, answer them with `realm run respond`. Write the person's member ID (`U…`), list member IDs in `answerers`, or remove `owner` so that the project's `answerers`, or without them anyone in the thread, can answer. When the project's realm.yaml has a Slack notifier that reads replies, `realm workflow validate` names each such gate, and `validate --strict` and `register --strict` now fail on one.",
    );
    // The account and how it was let through: check 1; the refusal, nothing written, the private
    // note: check 1; `answerers`: check 3; the project's list: check 6; the law: realm-testing.
    claimChangelog(
      "- **Who may answer in Slack is checked, and recorded.** Every answer now records how it was let through (`admitted_by`), and a Slack answer also the account Slack reports for the reply. When a question names who may answer, a reply from anyone else is refused with `STATE_ANSWERER_MISMATCH`: nothing is written, and the sender gets a private note saying who can answer. A gate's new `answerers` names more member IDs; the project's `notifiers.slack_gate.config.answerers` answers questions that name no one. `@sensigo/realm-testing`'s settlement laws gain one: a refused answer leaves the record unchanged. (#603)",
    );
    // The closed post: check 5; respond answers it: check 5; validate names the gates, --strict
    // fails: check 12.
    claim(
      'docs/guides/upgrade.md',
      'When Realm listens in the thread, its post says `Replies in this thread are not counted`. A question already open when you upgrade follows the same rule.',
    );
    claim(
      'docs/guides/upgrade.md',
      "2. **Find the gates.** When the project's `realm.yaml` has a Slack notifier that reads replies (`bot_token` and `channel_id`, with `app_token` or `signing_secret`), `realm workflow validate` on each file, or `realm workflow validate --registered <id>` on each stored workflow, names each such gate. `validate --strict` and `register --strict` fail on one.",
    );
  });

  it("testing-package.md: the store kit's new law", () => {
    // Refused with the names and the sender, the record as it was, the owner's answer then applies:
    // realm-testing's ANSWERER_REFUSAL_WRITES_NOTHING, its first case; the expiry first: its second.
    claim(
      'docs/reference/testing-package.md',
      "`ANSWERER_REFUSAL_WRITES_NOTHING` was added after version 0.49.0. An answer whose `sender` the question does not let answer (its `owner`, or the project's list for a question that names no one) must be refused `answerer_mismatch`, with the names that may answer and the sender, and must leave the record as it was, version included; the named sender's answer then applies, and its entry records `admitted_by: 'owner'`. A late answer from such a sender carries out the question's expiry instead: a store must judge the expiry first.",
    );
  });

  it('the reference rows: the code, the warning, the manifest key and the record', () => {
    // Nothing written, the facts: core's "a library call with channel evidence and no route".
    claim(
      'docs/reference/error-codes.md',
      'Nothing was written, and the question is still open. Its facts name the accounts that may answer and the sender.',
    );
    // Under a notifier that reads replies only: validate-slack-answerers-603 check 12.
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      'With a Slack notifier in `realm.yaml` that reads replies, a gate names someone who is not a Slack member ID, so no reply from them counts in its Slack thread. Added after version 0.49.0.',
    );
    // The entry refused, named as written: validate-slack-answerers-603 check 13.
    claim(
      'docs/reference/deployment-manifest.md',
      "| Has an `answerers` entry that is not a member ID | `notifiers.slack_gate: 'answerers' entry '@ana' is not a Slack member ID (U… or W…, or its mention), so it would match no reply.` |",
    );
    // A registered gate with a non-id owner closed in Slack: check 5 (a stored question has the
    // same shape).
    claim(
      'docs/guides/upgrade.md',
      'The second is the version after 0.49.0: in Slack, a registered gate whose `owner` is not a Slack member ID can no longer be answered in its thread',
    );
    // A question that names no one: check 6; an entry that is not a member ID refused: check 13.
    claim(
      'docs/reference/deployment-manifest.md',
      'who may answer a question that names no one: no `owner` and no `answerers` of its own. An entry that is not a member ID is refused when `realm.yaml` is loaded.',
    );
    // How it was let through: checks 1 (owner), 3 (answerers), 6 (project), 7 (no one named),
    // 8 (another route); absent on an expiry's entry: check 10.
    claim(
      'docs/reference/run-record-and-export.md',
      "On a gate answer: how its sender was let through, judged in the answer's write — `owner`, `answerers` or `project_answerers` (the account Slack reported is on that list), `no_named_answerer` (the question named no one, so anyone counted) or `owner_not_checked_on_route` (the question names someone and the answer came through another route, which is not compared).",
    );
    // The account from Slack: check 1 (and check 15 for `team`).
    claim(
      'docs/reference/run-record-and-export.md',
      '`channel_evidence` (`{ team, user, ts, thread_ts }`: the account that replied, as Slack reports it; never verified by Realm; added after version 0.49.0)',
    );
  });
});
