// docs-gap2-iv-a1.test.ts — gap 2, unit (iv-a1), check 9: the sentences that say what
// `$settlement.<step>.message` holds, who sees it and how it is hidden, each pinned word for word
// where a person reads it.
//
// Each claim names the cells that execute what it says: `agent/settlement-message-g2iva1.test.ts`
// (the field, the question and the Slack post, the next step), core's
// `workflow/settlement-message-paths-g2iva1.test.ts` (the loader and the notes) and
// `commands/validate-notes-g2iva1.test.ts` (validate). (a) red when the page no longer holds the
// sentence word for word; (b) prints the sentence.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const EXCEPT =
  ", except a failure's message the question reads through `$settlement.<step>.message`, in which every secret Realm knows of was hidden when the question opened; when a `realm` command other than `realm mcp` and `realm serve` opened the question, your home folder and user name were not among them (added after version 0.50.0)";

describe('gap 2 (iv-a1), check 9 — the words', () => {
  it('conditions.md: the message row and "its five"', () => {
    // Executed by the drive cells' checks 1–6 (what the field holds, when, and its bound) and the
    // loader's cells (absent unless the reader runs only after the failure; `| default`).
    claim(
      'docs/reference/workflow/conditions.md',
      "| `message` | text, or absent | The failure's own message, when the step failed, or when it took its default answer after its model request failed (`on_model_failure: default`): a provider's text for a model request, a handler's or an adapter's for an `auto` step, or Realm's own sentence when Realm failed the step (for example, when its answers were refused too often). It is the text as the record keeps it: for a handler, `Handler '<name>' threw: <its text>`; for a model request, the provider's status and text, such as `503 The server is overloaded`. A model request's message is the first 500 characters `realm agent` kept; a handler's or an adapter's text over 500 characters reads `‹N characters, not kept›`. Absent on every other step: read it with `\\| default` in a template. It is the failure's own text, so it can carry anything the failed request echoed back. Under `realm mcp` or `realm serve` with `--failure-text hidden`, an assistant sees a copy of it in a prompt, an approval question, a gated step's instructions or a condition's value as its length only (see [What the assistant sees](../mcp/run-state-and-health.md#failure-text)). |",
    );
    // Executed by the loader's typo cells (a field outside the five is refused).
    claim('docs/reference/workflow/conditions.md', 'a `$settlement` field other than its five');
  });

  it('gates.md and agent-step-controls.md', () => {
    // Executed by the drive's check 2 (the question and the Slack post hide both secrets, through a
    // filter and the whole-entry dump) and check 1 (the question shows the message).
    claim(
      'docs/reference/workflow/gates.md',
      'It can show why an earlier step failed: `{{ context.resources.$settlement.classify.message | default: "no message" }}` puts that step\'s failure message (see [`$settlement`](conditions.md#settlement)) into the question, and so into the Slack post. That value, also in a shorter path that holds it such as `context.resources.$settlement.classify`, is hidden before any filter runs: every secret Realm knows of, not only declared ones (when a `realm` command other than `realm mcp` and `realm serve` opens the question, your home folder and user name are not among them). Added after version 0.50.0.',
    );
    // Executed by the drive's check 1 (the prompt, the question and the input_map) and validate's
    // note cells.
    claim(
      'docs/reference/workflow/agent-step-controls.md',
      'A later step reads why the request failed as `$settlement.<step>.message` (in a template or an `input_map`, `context.resources.$settlement.<step>.message`): in its prompt, its approval question or its `input_map`. `realm workflow validate` prints a note when it reaches a prompt. An approval question hides every secret Realm knows of in it; a prompt `realm agent` sends is masked as every prompt it sends is; an `input_map` hands the text on as the record keeps it.',
    );
  });

  it('run-state-and-health.md and loader-diagnostics.md', () => {
    // Unit (iv-a2-i) replaced this unit's sentence (what it did not shape) with what `hidden` now
    // shapes: executed by mcp-server's copies-hidden-iva2i.test.ts. Unit (iv-a2-ii) made the question
    // its length too: executed by mcp-server's question-hidden-iva2ii.test.ts (check 1) and the CLI's
    // agent/question-hidden-agent-iva2ii.test.ts (people's words).
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "An approval question that reads the message shows it to an assistant as its length too (`gate.display`, `pending_gate.resolved_message`), and so to a person who reads the question in the assistant's chat. The question Realm stores keeps its words: a form the assistant's app shows, the Slack post, `realm agent` and `realm run inspect` show them.",
    );
    // Executed by validate's note cells (file mode, --json `notes`, --strict passes).
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      "**Notes.** `realm workflow validate` prints a note, marked `ℹ`, when a `prompt` or a gated step's `instructions` puts a step's failure message (`$settlement.<step>.message`) into the text: that text is the failure's own. A note is not a warning and never counts toward `--strict`; `--json` lists the notes under `notes`. Added after version 0.50.0.",
    );
    // Wording correction 1, item 2: the `--json` example and its field table. Executed by validate's
    // `--json` cells (the notes, each with its four fields); `notes` follows `not_checked` and is
    // empty when the file could not be loaded, as validate's emit writes it.
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '  "extension_keys": [],\n  "not_checked": [],\n  "notes": []\n}',
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `notes` | The notes: `step`, `placement` (`prompt` or `instructions`), `reads` (the path) and `message`; empty when the file could not be loaded. Added after version 0.50.0. |',
    );
  });

  it('the four pages that say a question hides only declared secrets', () => {
    // Executed by the drive's check 2 (every known secret hidden in the field's value in the
    // question; other values keep today's masking).
    claim(
      'docs/guides/operate-runs.md',
      `A gate's question hides only the declared secrets, wherever it is shown${EXCEPT}.`,
    );
    claim(
      'docs/reference/cli/realm-run-reading.md',
      `\`; question: declared tier only\`: a question hides only the declared secrets${EXCEPT}.`,
    );
    claim(
      'docs/reference/cli/realm-run-reading.md',
      `the third line says \`question: declared tier only\`: a question hides only the declared secrets${EXCEPT}.`,
    );
    claim(
      'docs/reference/mcp/tools.md',
      `\`question: declared_only\` (the question hides only the declared secrets${EXCEPT})`,
    );
  });

  it('Words 10b (MA 4): run-record-and-export.md and connect-an-mcp-client.md', () => {
    // Executed by the drive's check 2, as the four pages above. connect-an-mcp-client.md's sentence is
    // pinned in mcp-server's docs-disclosure-729.test.ts.
    claim(
      'docs/reference/run-record-and-export.md',
      "(it hides only the declared secrets, except a failure's message the question reads through `$settlement.<step>.message`, in which every secret Realm knows of was hidden when the question opened; when a `realm` command other than `realm mcp` and `realm serve` opened the question, your home folder and user name were not among them; added after version 0.50.0)",
    );
  });

  it('CHANGELOG.md: the Added line', () => {
    // Executed by the drive cells, the loader cells and validate's note cells.
    claim(
      'CHANGELOG.md',
      "- **A later step can read why a step failed.** `$settlement.<step>.message` holds the failure's own message (a provider's, a handler's, an adapter's or Realm's own), for a step that failed or took its default answer after its model request failed. An approval question, and so the Slack post, can show it, with every secret Realm knows of hidden (your home folder and user name aside when a `realm` command other than `realm mcp` and `realm serve` opens the question); a prompt or an `input_map` can take it. `realm workflow validate` prints a note when it reaches a prompt, listed under `notes` in `--json`; `loadWorkflowFromFileWithDiagnostics` and `loadWorkflowFromStringWithDiagnostics` return those notes beside `notChecked`. Each note is a `LoaderNote`.",
    );
  });
});
