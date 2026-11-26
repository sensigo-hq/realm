// docs-gap2-iv-a2ii.test.ts — gap 2, unit (iv-a2-ii), check 10: the sentences that say what
// `--failure-text hidden` shows of an approval question that read a failure's message, each pinned word
// for word where a person reads it (the start line and `--help` are pinned by the failure-text-iv-b1
// cells; the store kit's case counts by the testing page's own count cells).
//
// Each claim names the cells that execute what it says: question-hidden-iva2ii.test.ts (the three
// places, the store fallback, the receipt), the CLI's agent/question-hidden-agent-iva2ii.test.ts
// (people's words; a gate realm agent opened) and the store kit's gate-keys-iva2ii cells. (a) red when
// the page no longer holds the sentence word for word; (b) prints the sentence.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** `text` with comment marks and runs of white space as one space. */
const flat = (text: string): string => text.replace(/^\s*(\*|\/\/)\s?/gm, '').replace(/\s+/g, ' ');

function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

describe('gap 2 (iv-a2-ii), check 10 — the words', () => {
  it('run-state-and-health.md: the question sentence (Words 1) and the table row (Words 2)', () => {
    // Executed by check 1 (the opening and already-open gate.display, pending_gate.resolved_message,
    // the shape before any filter, the rest of the question kept) and checks 2 and 6 (people's words).
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "An approval question that reads the message shows it to an assistant as its length too (`gate.display`, `pending_gate.resolved_message`), and so to a person who reads the question in the assistant's chat. The question Realm stores keeps its words: a form the assistant's app shows, the Slack post, `realm agent` and `realm run inspect` show them.",
    );
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      '| `gate.display`, `pending_gate.resolved_message` | The question, with each failure message it read as `‹string, N characters›` | The rest of the question |',
    );
  });

  it("conditions.md: the message row's pointer (Words 5)", () => {
    // Executed by (iv-a2-i)'s copies cells (a prompt, a gated step's instructions, a condition's
    // value) and check 1 here (an approval question).
    claim(
      'docs/reference/workflow/conditions.md',
      "It is the failure's own text, so it can carry anything the failed request echoed back. Under `realm mcp` or `realm serve` with `--failure-text hidden`, an assistant sees a copy of it in a prompt, an approval question, a gated step's instructions or a condition's value as its length only (see [What the assistant sees](../mcp/run-state-and-health.md#failure-text)). |",
    );
  });

  it('the source comments the library reference is generated from (Words 6)', () => {
    // Executed by check 1 (the key present only when the question read a message, checks 3 and 4)
    // and check 7 (the whole question as its length on a store that does not declare the field).
    claim(
      'packages/core/src/types/run-record.ts',
      "The gate's question with each failure message it read as its length (`‹string, N characters›`), for an assistant under `--failure-text hidden`. Present only when the question read one. Added after version 0.50.0.",
    );
    const member =
      "`'pending_gate'`: the stored gate, every key kept. A store that does not declare it makes `--failure-text hidden` show a gate's whole question as its length on a run with a failure message, unless the gate's `resolved_message_shaped` survived. Added after version 0.50.0.";
    claim('packages/core/src/store/store-interface.ts', member);
    claim('docs/reference/library/implement-a-store.md', member);
  });

  it('core-library.md: the nine fields and the pending_gate row (Words 7)', () => {
    // Executed by check 9 (the three stores declare it) and check 7 (what not declaring it does).
    claim(
      'docs/reference/core-library.md',
      'A store that keeps the whole record, as the file store does, lists all 9 fields.',
    );
    claim(
      'docs/reference/core-library.md',
      "| `pending_gate` | Under `--failure-text hidden`, a gate's whole question reaches an assistant as its length on a run with a failure message. |",
    );
  });

  it('run-record-and-export.md and CHANGELOG.md (Words 8)', () => {
    // Executed by check 1 (the stored twin) and checks 3, 4 and 9.
    claim(
      'docs/reference/run-record-and-export.md',
      '| `resolved_message_shaped` | No | The same question with each failure message it read as its length. It is kept whenever the question read a failure message the record holds, whatever the setting, and an assistant is served it, in place of `resolved_message`, only under `--failure-text hidden`. Added after version 0.50.0. |',
    );
    claim(
      'CHANGELOG.md',
      "Under `--failure-text hidden`, an approval question that read the message reaches an assistant with it as its length (`PendingGate` gains `resolved_message_shaped`; stores declare `LoadBearingRunRecordField` `'pending_gate'`).",
    );
  });
});
