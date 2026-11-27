// docs-gap2-ii-b2.test.ts — gap 2, unit (ii-b2), check 9: the sentences that say what
// `on_model_failure: fail` does, each pinned word for word where a person reads it.
//
// Each claim names the cells that execute what it says: `agent/fail-key-drive-g2iib2.test.ts`
// (the drive), core's `engine/model-failure-key-g2iib2.test.ts` (the admission) and
// `workflow/on-model-failure-key-g2iib2.test.ts` (the loader). (a) red when the page no longer holds
// the sentence word for word; (b) prints the sentence.
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

describe('gap 2 (ii-b2), check 9 — the words', () => {
  it('step-fields.md: the field, on agent steps only, with its value', () => {
    // Executed by the loader's cells (check 8: the agent step loads; auto, guard, finalizer refused).
    claim(
      'docs/reference/workflow/step-fields.md',
      'This page lists every field a step can have. There are 38,',
    );
    // Correction 1: the example file carries the key (docs-899's transcript cell loads it).
    claim(
      'docs/reference/workflow/step-fields.md',
      'This file uses the 37 fields that a step itself can carry;',
    );
    claim(
      'docs/reference/workflow/step-fields.md',
      '    llm_timeout_seconds: 60\n    on_model_failure: fail\n',
    );
    claim('docs/reference/workflow/step-fields.md', '| `on_model_failure` | no | yes | no | no |');
    claim(
      'docs/reference/workflow/step-fields.md',
      // Gap 2, unit (iii), Words 11: both values.
      '| `on_model_failure` | `fail` or `default` | None | What happens to the step when its model request fails, under `realm agent`: see [Agent-step controls](agent-step-controls.md#on_model_failure). |',
    );
  });

  it('agent-step-controls.md: the setting and its section', () => {
    claim(
      CONTROLS,
      '| [`on_model_failure`](#on_model_failure) | What happens to the step when its model request fails. | `realm agent` drives the step |',
    );
    // Executed by check 2 (the step fails, and its one_failed step runs; gap 2 (ii-b3): in the same
    // drive) and check 1 (without the key: the drive stops, gives the step back, the run open).
    claim(
      CONTROLS,
      "`on_model_failure: fail` fails the step when its model request fails, so the workflow's failure route can run: a step with `trigger_rule: one_failed`, or a finalizer. Without the key, the drive stops, gives the step back and leaves the run open, as before. With it, a step with `trigger_rule: one_failed` runs in the same drive: `realm agent` goes on after the failed step.",
    );
    // Executed by check 2's rows (each code, and failure_kind read by the route), check 6 (a module
    // that handles its own retries: MODEL_REQUEST_FAILED) and check 4 (texts, tries, usage; no drive
    // failure).
    claim(
      CONTROLS,
      "With `fail`, the step fails when its request fails for good. When Realm's own `retry` used up its tries or its time, the code is `STEP_RETRY_EXHAUSTED`. When a later try would fail the same way (an answer Realm cannot use, such as one cut off at `max_tokens` or not JSON after its one re-ask, included), `retry` does not try it again, or the step has no `retry`, the code is `MODEL_REQUEST_FAILED`. A provider module that handles its own retries reports `MODEL_REQUEST_FAILED` too. A later step reads `$settlement.<step>.failure_kind`: `transient` when a later try might pass, `permanent` when it would fail the same way. The step's error entry keeps the failure's message, the texts of its requests, its tries and, for the requests that were billed, their cost; no drive failure is recorded for it.",
    );
    // Executed by check 3 (a 401, a tool the server does not offer, a throw Realm cannot place).
    claim(
      CONTROLS,
      'A failure that needs a fix first (a refused key, a model that does not exist, used-up credit or quota), a failure before the model was called, and one Realm cannot place still stop the drive and leave the run open.',
    );
    // Executed by check 2 (the result is `failed`, which `realm agent` exits 1 for; gap 2 (ii-b3):
    // the drive goes on first).
    claim(
      CONTROLS,
      'After the step fails, `realm agent` goes on with whatever became ready, and exits with code 1 at the end.',
    );
    // Executed by check 8 (refused on auto, guard, finalizer; another value refused). Gap 2, unit
    // (iii), Words 10: `default` is the second value (on-model-failure-default-g2iii.test.ts).
    claim(
      CONTROLS,
      'The key takes `fail` or `default`. The key is refused on `auto`, `guard` and `finalizer` steps. A run an assistant drives over MCP makes no model call through Realm, so the key does nothing there.',
    );
  });

  it('retry-and-timeouts.md: after the last try', () => {
    // Executed by check 2's retry row (STEP_RETRY_EXHAUSTED, the tries on the error entry).
    claim(
      'docs/reference/workflow/retry-and-timeouts.md',
      // Gap 2, unit (iii), Words 15: both values.
      'After the last try, the drive stops and the run stays open, as after any failed model call, unless the step declares [`on_model_failure`](agent-step-controls.md#on_model_failure): `fail` fails the step (`STEP_RETRY_EXHAUSTED`), `default` completes it with its default answer, and either way the tries stay on its error entry.',
    );
  });

  it('run-record-and-export.md and the library reference: a request with no answer', () => {
    // Executed by check 4 (the unanswered last request: request_id and reply null).
    claim(
      'docs/reference/run-record-and-export.md',
      '| The text of each model request made for this entry.',
    );
    claim(
      'docs/reference/run-record-and-export.md',
      // Gap 2 (iii), wording correction 1, items 3 and 4: both values.
      'On the error entry of a step whose model request failed and that settled through `on_model_failure` (`fail` or `default`), the last request may have had no answer: its `request_id` and `reply` are `null`.',
    );
    claim(
      'docs/reference/library/read-a-runs-record.md',
      // Gap 2 (iii), wording correction 1, items 3 and 4: both values.
      'On the error entry of a step whose model request failed and that settled through `on_model_failure` (`fail` or `default`), the last request may have had no answer: its `request_id` and `reply` are `null`.',
    );
  });

  it('realm-agent.md: the seventh row, the rows named, and what the first six cases become', () => {
    // Executed by check 2 (one ✗ line from the catch, then the bullet line on stderr; the retry row's
    // STEP_RETRY_EXHAUSTED; a run the settle ended is `failed`). Gap 2 (ii-b3): the run afterwards
    // cell — the drive goes on — is executed by goes-on-drive-g2iib3.test.ts, check 3.
    claim(
      AGENT,
      "| An agent step with `on_model_failure: fail` whose model request failed | `✗ Step 'classify' LLM call failed: Connection error.` (`✗ Step 'classify' (tools) failed: …` on a step with tools), followed by `• Step 'classify' failed (MODEL_REQUEST_FAILED): its model request failed, and the step has on_model_failure: fail.` (`STEP_RETRY_EXHAUSTED` when the step's `retry` used up its tries) | The drive goes on. Ended, in `failed`, when no other step finishes after it; otherwise as the last step to finish leaves it (`completed`, with the failed step listed). |",
    );
    // Correction 1's ride-along: the lease row's run afterwards (nothing was claimed).
    claim(
      AGENT,
      'this drive could not take a lease in /home/dana/.realm/claim-leases (this program cannot write there); nothing was claimed and the model was not called.` | Open, in `running`. |',
    );
    // Executed by check 2 (the bullet line on stderr) and check 5b (Words 6b's line on stderr).
    claim(
      AGENT,
      "(`✗ Step …`, `⚠ Step … is blocked`, and the `• Step '<step>' failed (<CODE>): …` and `• Step '<step>': the engine did not record its failure …` lines)",
    );
    claim(
      AGENT,
      "adds `(run by the engine after '<step>' finished)`, as in the row for an `auto` step the engine ran after it.",
    );
    claim(
      AGENT,
      'When nothing else can run and an `auto` step is refused before it is claimed, and the check is `input_schema`,',
    );
    // Executed by check 2 (the 503, timeout and 400 rows fail the step, the cap and the tries under
    // retry) and check 3 (a 401 stays).
    claim(
      AGENT,
      // Gap 2, unit (iii), Words 14: the sentence for `default` (the eighth row) between the two.
      "With `on_model_failure: fail`, a model request that failed for good fails the step instead (the seventh row), and `realm run inspect` lists it under `Failed:`: a lost connection, a timeout, a `5xx` or a `400` answer, or an answer Realm cannot use, once the step's `retry`, if it has one, has stopped. With `on_model_failure: default`, it completes the step with its default answer instead (the eighth row). A refused key and a model that does not exist stay as above.",
    );
  });

  it("run-state-and-health.md: cost_unrecorded's first example", () => {
    // Executed by check 4's unbilled cell (a request that failed before an answer: no usage) and the
    // inspect cost cells (inspect-cost-view, cost-view-disclosure-parity).
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      'for example because its model request failed before an answer came, an outside agent over MCP made it,',
    );
    claim(
      'docs/reference/cli/realm-run-reading.md',
      'realm has no usage figures for this attempt (for example: its model request failed before an answer came, an outside agent over MCP made it,',
    );
  });

  it('CHANGELOG: the member is passed, and refused where the step did not opt in; the new key', () => {
    // Executed by check 7 (the three refusals and the legal pairs) and check 2 (the drive passes it).
    claim(
      'CHANGELOG.md',
      // Gap 2, unit (iii), Words 15: made true in place.
      "`realm agent` and `realm listen` pass it for a step that declares `on_model_failure: fail` or `default`, and `executeChain` refuses it for a step that declares neither, or `default` without `validation_exhaustion.default_output`, or with a `stop_reason` the step's `retry` contradicts (`attempts` or `total_timeout` without one, `no_retry_policy` with one).",
    );
    // Executed by checks 2–4 and 8.
    claim(
      'CHANGELOG.md',
      "- **An agent step can fail when its model request fails, so the workflow's failure route runs.** `on_model_failure: fail` on an agent step that `realm agent` or `realm listen` drives fails the step when its model request fails for good (`STEP_RETRY_EXHAUSTED` or `MODEL_REQUEST_FAILED`, with `$settlement.<step>.failure_kind`). The step's error entry keeps the failure's message, the requests' texts, the tries and their cost. A failure that needs a fix first, or one Realm cannot place, leaves the run open as before. Without the key nothing changes. `StepDefinition` gains `on_model_failure`.",
    );
  });
});
