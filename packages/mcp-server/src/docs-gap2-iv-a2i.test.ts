// docs-gap2-iv-a2i.test.ts — gap 2, unit (iv-a2-i), check 10: the sentences that say what
// `--failure-text hidden` shows of a copy a workflow makes of a failure's message, each pinned word
// for word where a person reads it.
//
// Each claim names the cells that execute what it says: copies-hidden-iva2i.test.ts (the prompts,
// the gated step's instructions, the condition values, the receipt, the stored question) and the
// CLI's agent/copies-hidden-agent-iva2i.test.ts (realm agent unchanged). (a) red when the page no
// longer holds the sentence word for word; (b) prints the sentence.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const RUN_STATE = 'docs/reference/mcp/run-state-and-health.md';

function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

describe('gap 2 (iv-a2-i), check 10 — the words', () => {
  it('run-state-and-health.md: what hidden shows of a copy (Words 1)', () => {
    // Executed by checks 1 (the prompt: plain, | truncate, the dump), 3 (gate.agent_hint), 4 (the
    // when, the guard and the precondition values), 2 (the not-kept marker under both settings) and
    // 5 (the stored question's words). The four copies Realm cannot see are not built (Not built).
    claim(
      RUN_STATE,
      "Under `hidden`, a copy a workflow makes of a failure's message through `$settlement.<step>.message` is shown as its length too, before any filter: in a step's prompt (`next_actions[].prompt`), in a gated step's instructions (`gate.agent_hint`), and in the value a condition read (`skip_details`, a guard's `abort_context.conditions`, a precondition's refusal). A message already over 500 characters reads `‹N characters, not kept›` either way. An approval question that reads the message still shows its words to an assistant under `hidden`. A copy Realm cannot see is never shaped: a step that copies the message into its own output, a gate's preview of that output, an agent's own answer, and a run's parameters. Added after version 0.50.0.",
    );
  });

  it('run-state-and-health.md: the three rows of the hidden table (Words 2)', () => {
    // Executed by checks 1 and 3 (the prompt and the hint, the rest of their text kept), 4 (the
    // condition values, the condition and its result kept) and 4's precondition cells (the
    // sentence rebuilt with the shape, the expression kept, in every place it appears).
    claim(
      RUN_STATE,
      '| `next_actions[].prompt`, `gate.agent_hint` | A failure message the workflow put into them, as `‹string, N characters›`, before any filter | The rest of the text |',
    );
    claim(
      RUN_STATE,
      '| `skip_details.<step>.leaves[].resolved_value`, `abort_context.conditions[].resolved_value` | `‹string, N characters›` when the condition read a failure message | The condition and its result |',
    );
    claim(
      RUN_STATE,
      "| A precondition's refusal (`engine_runnable[].refusal` and `agent_refused[].refusal` with their `precondition.value`, `run_health`'s `cannot_go_on` `evidence.refused[]`; in a reply, `blocked_reason.suggestion` and `context_hint`) | Realm's sentence, with the value as its shape when the precondition read a failure message | The expression |",
    );
  });

  it("run-state-and-health.md: the replies paragraph's last sentence (Words 3)", () => {
    // Executed by checks 1 (an engine reply's prompt), 3 (the opening reply's hint) and 4 (a refused
    // call's suggestion, the hint), and by (iv-b2a)'s cells for a step's output.
    claim(
      RUN_STATE,
      "Text a workflow copies into a question or into a step's output is shown as that field always is; a copy through `$settlement.<step>.message` into a prompt, a gated step's `instructions` or a condition's value is shown as above.",
    );
  });

  it("CHANGELOG.md: the (iv-a1) line's new sentence (Words 4)", () => {
    // Executed by checks 1, 3 and 4.
    claim(
      'CHANGELOG.md',
      "Under `--failure-text hidden`, an assistant sees such a copy in a prompt, a gated step's instructions or a condition's value as its length only.",
    );
  });
});
