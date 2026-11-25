// docs-gap2-iii.test.ts — gap 2, unit (iii), check 12: the sentences that say what
// `on_model_failure: default` does, each pinned word for word where a person reads it.
//
// Sentences this unit changed that an earlier unit's file already pins are pinned there, on their new
// text (docs-gap2-ii-a, docs-gap2-ii-b2, docs-gap2-ii-b3, docs-gap2-i-b). Each claim names the cells
// that execute what it says: `agent/default-answer-drive-g2iii.test.ts` (the drive and inspect),
// core's `workflow/on-model-failure-default-g2iii.test.ts` (the loader) and
// `engine/model-failure-default-g2iii.test.ts` (core's admission and readers).
// (a) red when the page no longer holds the sentence word for word; (b) prints the sentence.
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

const CONTROLS = 'docs/reference/workflow/agent-step-controls.md';
const AGENT = 'docs/reference/cli/realm-agent.md';
const W1 =
  "• Step '<step>' took its default answer (<CODE>): its model request failed, and the step has on_model_failure: default.";
const W2 =
  "• Step '<step>' took its default answer after <N> refused answers (validation_exhaustion.mode: default).";

describe('gap 2 (iii), check 12 — the words', () => {
  it('agent-step-controls.md: the new paragraph, the default_output row and the dead-config bullet', () => {
    // Executed by the drive's checks 1 (error entry then default entry, Words 1, exit 0), 1b (the
    // billed cost on the error entry), 2 (a 400 takes it) and 3 (a 401 does not); 5b
    // (`mode` absent: refused answers still fail the step); 4 (`failure_kind` routes); 9 (#220's
    // default has no `failure_kind`); the loader's cells (output_schema, the fit).
    claim(
      CONTROLS,
      "`on_model_failure: default` completes the step with its default answer, `validation_exhaustion.default_output`, when its model request fails for good: the same failures `fail` fails it on. The step needs `output_schema`, and the default must fit it. `validation_exhaustion.mode` can stay `fail`, so that answers refused too often still fail the step. The step's record keeps an error entry for the failed request (its message, code, texts, tries and, for the requests that were billed, their cost), then the default answer, marked `settled_by_default`. A later step reads `$settlement.<step>.failure_kind`, which a default taken after refused answers never has. `realm agent` prints `• Step '<step>' took its default answer (<CODE>): …` and goes on as after any completed step, with exit code 0 when nothing failed.",
    );
    // Executed by the drive's check 1 (the default entry's output) and check 9 (`mode: default`).
    claim(
      CONTROLS,
      '| `default_output` | a value that fits `output_schema` | None | The answer recorded for the step in `default` mode, and with `on_model_failure: default` when its model request fails. |',
    );
    // Executed by the loader's DEAD cell (no warning under the key; Words 5 with neither trigger).
    claim(
      CONTROLS,
      '- `default_output` without `mode: default` or `on_model_failure: default` is accepted with a warning that it is ignored.',
    );
  });

  it('conditions.md and loader-diagnostics.md', () => {
    // Executed by the drive's checks 1 and 9 ($settlement.s.settled_by_default for both kinds).
    claim(
      'docs/reference/workflow/conditions.md',
      '| `settled_by_default` | true or false | The step was completed with its declared default answer: after too many refused answers, or, with `on_model_failure: default`, after its model request failed. |',
    );
    // Executed by the loader's DEAD cell.
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `DEAD_VALIDATION_EXHAUSTION_CONFIG` | Warning | `default_output` is set without `mode: default` or `on_model_failure: default`.',
    );
  });

  it('realm-agent.md: the eighth row, What it prints and the streams', () => {
    // Executed by the drive's checks 1 (the ✗ line, then Words 1 with STEP_RETRY_EXHAUSTED, the
    // run goes on) and 2 (MODEL_REQUEST_FAILED).
    claim(
      AGENT,
      "| An agent step with `on_model_failure: default` whose model request failed | `✗ Step 'classify' LLM call failed: Connection error.` (`✗ Step 'classify' (tools) failed: …` on a step with tools), followed by `• Step 'classify' took its default answer (MODEL_REQUEST_FAILED): its model request failed, and the step has on_model_failure: default.` (`STEP_RETRY_EXHAUSTED` when the step's `retry` used up its tries) | The drive goes on, as after any completed step. |",
    );
    // Executed by the drive's checks 1 and 2 (Words 1) and 9 (Words 2, "1 refused answer").
    claim(
      AGENT,
      `| \`${W1}\` | A step took its default answer, and the drive goes on | The error code on the step's error entry: see [\`on_model_failure\`](../workflow/agent-step-controls.md#on_model_failure). The step is completed. Added after version 0.50.0. |`,
    );
    claim(
      AGENT,
      `| \`${W2}\` | A step took its default answer, and the drive goes on | How many of its answers were refused (\`after 1 refused answer\` for one). The step is completed. Added after version 0.50.0, which printed no line for it. |`,
    );
    // Executed by the drive's checks 1 and 9 (this drive's default) and the Words 3 cell (another
    // program's default).
    claim(
      AGENT,
      'For a default answer: `Result (<step>) — its default answer:` and, when another program gave it, `Result (<step>) — its default answer, given by <program>, not by this drive:` (added after version 0.50.0).',
    );
    // Executed by the drive's cells (both lines are read from stderr).
    claim(
      AGENT,
      "So do the two `• Step '<step>' took its default answer …` lines (added after version 0.50.0).",
    );
  });

  it('run-state-and-health.md: the attempts with neither cost field', () => {
    // Executed by the drive's check 1 (the default attempt's view has neither) and core's check 1c.
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "so does an agent step with no agent profile when the run's workflow cannot be read, because Realm then cannot tell it from a step that runs code; so does the default answer of a step with `on_model_failure: default`, whose request's cost is on the attempt before it.",
    );
  });

  it('CHANGELOG.md: the modelFailure line and the Added line', () => {
    // Executed by core's check 11 (the default completes the step after the error entry).
    claim(
      'CHANGELOG.md',
      'Core settles the step failed with one error entry, or, for a step with `on_model_failure: default`, completes it with its default answer after that entry and mints the code:',
    );
    // Executed by the drive's checks 1–9 and the loader's cells.
    claim(
      'CHANGELOG.md',
      "- **`on_model_failure: default`.** An agent step whose model request fails for good under `realm agent` or `realm listen` completes with its default answer, `validation_exhaustion.default_output`, which must fit the step's `output_schema`. The record keeps the failed request as an error entry, then the default answer marked `settled_by_default`, and `$settlement.<step>.failure_kind` says why. `realm agent` now prints a line whenever a step takes its default answer, including after refused answers (`validation_exhaustion.mode: default`), which it did not show before.",
    );
  });
});
