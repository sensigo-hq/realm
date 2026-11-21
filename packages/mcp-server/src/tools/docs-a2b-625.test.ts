// docs-a2b-625.test.ts — #625 PR-2b unit A2b (prompt feat-625-a2b-form-carry-on.md): the words the unit
// adds or changes for a reader, each held to its page word for word (spaces folded), with the cell that
// executes what the sentence says named beside it (guardrail 9). FC = mcp-server
// form-carry-on-a2b-625.test.ts; EX = cli commands/form-carry-on-a2b-625.test.ts (example 08).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8: (a) red when the page
// no longer holds the sentence word for word (once); (b) prints the page and the sentence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
function claim(page: string, sentence: string, times = 1): void {
  expect(
    flat(read(page)).split(flat(sentence)).length - 1,
    `${page} no longer says (${times}×): ${sentence}`,
  ).toBe(times);
}
const GATES = 'docs/reference/mcp/gate-answers.md';
/** The proof words of `realm run inspect` (cli holder-render.ts `PROOF_WORDS.absent`). */
const PROOF_WORDS =
  "a token is passed only from the conversation that opened the question — by Realm's MCP answer tool, or by the form sent by the call that opened it — or by a program that calls the library with it";

describe('#625 PR-2b A2b — gate-answers.md', () => {
  it('the form of the call that opened the question carries the run on; any other form does not', () => {
    // FC check 1 (start_run's form: the steps run in that call), check 3 (no step after the form
    // wait's time), check 2 (present_question's form: recorded, advance_run named); EX (example 08).
    claim(
      GATES,
      "When the person answers a form sent by the call that opened the question, the run carries on in that call, up to the next pause, and no step starts after the form wait's time is spent. Any other form, sent by `present_question`, by a later call or from another session, records the answer and leaves the steps to `advance_run`.",
    );
  });

  it('a question the run reaches after a form’s answer gets its form from the next call', () => {
    // FC check 5 (no second form inside the call: an awaiting entry); form-627's first-send cells
    // (the next call that reaches it sends it).
    claim(
      GATES,
      "A question the run reaches after a form's answer, in the same call, gets its form from the next call that reaches it, or from `present_question`.",
    );
  });

  it('the proof words, as realm run inspect prints them', () => {
    // inspect-holder-625, holder-625-journeys, answer-record-627 (the line as printed).
    claim(GATES, PROOF_WORDS);
  });
});

describe('#625 PR-2b A2b — the guide, the start page and the run-reading page', () => {
  it('connect-an-mcp-client.md says what gate-answers.md says', () => {
    // FC check 1 and EX (the opening call's form runs the steps), check 3 (the wait's time), check 2
    // (another form: advance_run).
    claim(
      'docs/guides/connect-an-mcp-client.md',
      "So does a form's answer when the form was sent by the call that opened the question, and no step starts after the form wait's time is spent. After any other answer — a form sent by `present_question`, by a later call or from another session among them — the `auto` steps that follow do not start by themselves.",
    );
  });

  it('how-a-run-moves.md: a form’s answer does the same; the token stays inside the server', () => {
    // EX (example 08: the call that reached the gate ran post_approval); FC check 1 (the token in no
    // elicitation request, log line or reply).
    claim(
      'docs/start/how-a-run-moves.md',
      "A form's answer does the same when the form was sent by the call that opened the question; the token stays inside the server.",
    );
  });

  it('realm-run-reading.md: the proof words, in the example and the table', () => {
    // inspect-holder-625 and holder-625-journeys (the line `realm run inspect` prints).
    claim('docs/reference/cli/realm-run-reading.md', PROOF_WORDS, 2);
  });
});
