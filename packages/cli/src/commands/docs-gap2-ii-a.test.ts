// docs-gap2-ii-a.test.ts — gap 2, unit (ii-a), check 10: each sentence this unit adds to the docs and
// the CHANGELOG, pinned where the repo pins such words. Pages are compared with their whitespace
// collapsed (prettier pads table cells). The three refusal sentences (Words 1) are pinned in core's
// failure-kind-paths-g2iia.test.ts, input-map-paths.test.ts and when-paths.test.ts; the behaviour each
// sentence claims is executed in core's model-failure-path-g2iia.test.ts.
//
// Each cell carries (a) the break that turns it red and (b) what it prints.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

/** Which of `sentences` `rel` holds. */
const missingFrom = (rel: string, sentences: string[]): string[] => {
  const text = flat(rel);
  return sentences.filter((s) => !text.includes(s.replace(/\s+/g, ' ')));
};

describe('gap 2, unit (ii-a) — check 10: the words', () => {
  it("conditions.md's $settlement table (Words 2)", () => {
    // (a) red when the row is missing or worded otherwise; (b) prints the missing row.
    expect(
      missingFrom('docs/reference/workflow/conditions.md', [
        '| `failure_kind` | transient, permanent, or absent | Why the step failed, when its model request failed and it took its failure path: transient (a later try might pass) or permanent (it will fail the same way). Absent on every other step: read it with `\\| default` in a template. |',
      ]),
    ).toEqual([]);
  });

  it("run-record-and-export.md's diagnostics table (Words 3)", () => {
    // (a) red when the row is missing or worded otherwise; (b) prints the missing row.
    expect(
      missingFrom('docs/reference/run-record-and-export.md', [
        '| `failure_kind` | text | No | On the entry of an agent step that failed because its model request failed and it took its failure path: transient (a later try might pass) or permanent (it will fail the same way). Absent on every other entry. Added after version 0.50.0. |',
      ]),
    ).toEqual([]);
  });

  it("error-codes.md's SERVICE row (Words 4)", () => {
    const text = flat('docs/reference/error-codes.md');
    const service = text.slice(text.indexOf('### `SERVICE`'), text.indexOf('### `STATE`'));
    // (a) red when the row is missing, worded otherwise, or under another category; (b) prints it.
    expect(
      service.includes(
        "| `MODEL_REQUEST_FAILED` | An agent step's model request failed and the step took its failure path: the request would fail the same way again, the step's `retry` does not try it again (for example a timeout with `on_timeout: false`), or the step has no `retry`. The step fails. `details.failure_kind` says whether a later try might pass. | `report_to_user` | No |",
      ),
    ).toBe(true);
  });

  it('the CHANGELOG line (Words 5)', () => {
    const text = flat('CHANGELOG.md');
    const unreleased = text.slice(text.indexOf('## [Unreleased]'), text.indexOf('## [0.'));
    // (a) red when the line is missing, or a name it must carry is not in it; (b) prints which.
    const line =
      unreleased
        .split('- **')
        .find((l) =>
          l.startsWith(
            'A program that drives a run can settle an agent step failed because its model request failed, and a later step can route on why.**',
          ),
        ) ?? '';
    expect(
      [
        '`ExecuteChainOptions.modelFailure`',
        '`MODEL_REQUEST_FAILED`',
        '`ErrorCode`',
        '`StepDiagnostics`',
        '`failure_kind`',
        '`$settlement.<step>.failure_kind`',
        '`ClaimableErrorClass`',
        '`EVIDENCE_KEEPS_FAILURE_KIND`',
      ].filter((n) => !line.includes(n)),
    ).toEqual([]);
  });
});
