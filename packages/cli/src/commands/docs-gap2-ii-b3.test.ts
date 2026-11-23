// docs-gap2-ii-b3.test.ts — gap 2, unit (ii-b3), check 9: the sentences that say `realm agent`
// goes on after a failed step, each pinned word for word where a person reads it.
//
// Each claim names the cells of `agent/goes-on-drive-g2iib3.test.ts` that execute what it says.
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

const AGENT = 'docs/reference/cli/realm-agent.md';
const CONTROLS = 'docs/reference/workflow/agent-step-controls.md';
const WORDS3 =
  '✗ The run completed, but a step failed during this drive (<step>[, <step>…]); realm agent exits with code 1.';
const GOES_ON =
  'The drive goes on. Ended, in `failed`, when nothing runs after the failure; otherwise as its last step leaves it (`completed`, with the failed step listed).';

describe('gap 2 (ii-b3), check 9 — the words', () => {
  it('realm-agent.md: When it stops', () => {
    // Executed by checks 1–4 and 6 (the drive goes on, exit 1 at the end, also when the run
    // completed) and check 7 (a step left open stops it, exit 1).
    claim(
      AGENT,
      'When a step fails, `realm agent` prints why and goes on with whatever became ready: a step that runs on the failure, and other branches. It exits with code 1 at the end whenever a step failed during the drive, even when the run then completed. It stops with exit code 1 when a step cannot be completed and is left open.',
    );
    // Executed by check 3 (the member's row: the route runs, the run completed), check 4 (nothing
    // runs after: ended in `failed`), checks 1 and 6 (an auto step the drive called) and check 2 (an
    // auto step the engine ran after the agent step).
    claim(
      AGENT,
      `| An agent step with \`on_model_failure: fail\` whose model request failed | \`✗ Step 'classify' LLM call failed: Connection error.\` (\`✗ Step 'classify' (tools) failed: …\` on a step with tools), followed by \`• Step 'classify' failed (MODEL_REQUEST_FAILED): its model request failed, and the step has on_model_failure: fail.\` (\`STEP_RETRY_EXHAUSTED\` when the step's \`retry\` used up its tries) | ${GOES_ON} |`,
    );
    claim(
      AGENT,
      `| An \`auto\` step the drive called failed | \`✗ Step 'file' failed: Handler 'file_ticket' threw: the filing system is down\` | ${GOES_ON} |`,
    );
    claim(
      AGENT,
      `| An \`auto\` step the engine ran after it failed | \`✗ Step 'file' (run by the engine after 'classify' finished) failed: Handler 'file_ticket' threw: the filing system is down\` | ${GOES_ON} |`,
    );
    // Executed by check 2 (the line names the step the engine ran, and the drive goes on).
    claim(
      AGENT,
      "When the step that failed or stopped is one the engine ran after the step the drive called, the line names it and adds `(run by the engine after '<step>' finished)`",
    );
  });

  it('realm-agent.md: What it prints, the streams and the exit codes', () => {
    // Executed by checks 1, 2, 3 and 6 (the closing line, last on stderr, the steps in order).
    claim(
      AGENT,
      `| \`${WORDS3}\` | The run completes after a step failed during the drive | The steps that failed, in order; the exit code is 1. Added after version 0.50.0. |`,
    );
    claim(
      AGENT,
      "| `✗ Step '<step>' … failed: …` or `• Step '<step>' failed (<CODE>): …` | A step failed, and the run is still open | The failure's reason, as in [When it stops](#when-it-stops). The drive goes on with whatever became ready: a step that runs on the failure, and other branches. Added after version 0.50.0, which stopped there. |",
    );
    // Executed by check 5 (a failure that ended the run) and check 7 (a step left open).
    claim(
      AGENT,
      "| `✗ Step '<step>' …`, `✗ The drive stops: …` or `✗ The drive stops — …`, `⚠ Step '<step>' is blocked …` | The run cannot go on | The reason: a step that failed and ended the run, a step left open, a step refused before its claim with nothing else to run, or a handler or adapter this program has not registered. See [When it stops](#when-it-stops). |",
    );
    // Executed by checks 1 and 3 (the closing line is the last line on stderr).
    claim(AGENT, 'The lines that say why the drive stopped or that a step failed (`✗ Step …`,');
    claim(
      AGENT,
      `The line \`${WORDS3}\`, the last line when the run completed after a step failed during the drive, goes to stderr too (added after version 0.50.0).`,
    );
    // Executed by checks 8 and 7b (exit 0: no step failed during this drive) and checks 1–6 (exit 1).
    claim(AGENT, '| 0 | The run completed, and no step failed during the drive. |');
    claim(
      AGENT,
      '| 1 | The run ended in any other way, a step could not be completed, a step failed during the drive, or the command was refused. |',
    );
  });

  it("order-and-routing.md: run three's sentence, now true of one drive", () => {
    // Executed by the cell "order-and-routing.md's run three" (the page's own workflow, one drive:
    // pay fails, open_ticket and flag_large run, the run completes) and by check 2.
    claim(
      'docs/concepts/order-and-routing.md',
      'In this run, the steps that became allowed after the failure did not start by themselves. They ran when the driver called them. `realm agent` does that for you.',
    );
  });

  it('agent-step-controls.md: on_model_failure', () => {
    // Executed by check 3 (the route runs in the same drive; exit 1 at the end).
    claim(
      CONTROLS,
      'A step with `trigger_rule: one_failed` runs in the same drive: `realm agent` goes on after the failed step.',
    );
    claim(
      CONTROLS,
      'After the step fails, `realm agent` goes on with whatever became ready, and exits with code 1 at the end.',
    );
  });

  it('CHANGELOG.md: the Changed line', () => {
    // Executed by checks 1–4 and 6 (goes on, exit 1), and 7 (a step left open stops the drive).
    claim(
      'CHANGELOG.md',
      '- **`realm agent` and `realm listen` go on after a failed step.** The drive runs whatever became ready — a `one_failed` or `all_done` step, other branches — in the same drive, where before a second `realm agent --run-id` had to run it, and a run `realm listen` drove never got one. Its exit code is still 1 whenever a step failed during the drive, even when the run then completed; a line at the end says so. A step left open (a setup failure, a give-back, answers refused before the limit) still stops the drive as before.',
    );
  });
});
