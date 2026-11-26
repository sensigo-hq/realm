// docs-g3u1a.test.ts — gap 3, unit 1a, check 13: every new sentence that says what `remember:` does,
// pinned word for word where a person reads it, each beside the cells that execute it:
// core's engine/remember-stamp-g3u1a.test.ts (the stamp, checks 1 and 3–9), core's
// workflow/remember-load-g3u1a.test.ts and this package's commands/remember-g3u1a.test.ts (the
// refusals, check 10; the doors and the masked export, checks 2 and 12), mcp-server's
// remember-doors-g3u1a.test.ts (the MCP door and its warning) and testing's
// store/remembered-law-g3u1a.test.ts (the law, check 11). (a) red when the page no longer holds the
// sentence word for word; (b) prints the sentence.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_STORE_FIDELITY_LAWS } from '@sensigo/realm-testing';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const FIELDS = 'docs/reference/workflow/step-fields.md';

describe('gap 3 (1a), check 13 — the words', () => {
  it('step-fields.md: the field, its kinds and its condition', () => {
    // Executed by the registry's cells (remember × guard and × finalizer refused) and check 10's
    // bare-step and kind cells.
    claim(FIELDS, '| `remember` | yes | yes | no | no |');
    claim(FIELDS, 'Five fields have a further condition:');
    claim(
      FIELDS,
      '- `remember` on an `auto` step needs `handler` or `uses_service` on the same step.',
    );
  });

  it('step-fields.md: the remember entry, sentence by sentence (Words 10)', () => {
    for (const sentence of [
      'A step can keep something for later runs of its workflow, under a named key: for example the offer it made, by customer email.',
      'remember:\n  as: offers # required\n  key: { customer_email: context.resources.normalize_email.email } # required\n  value: { rung: context.resources.record_offer.rung } # optional\n  keep_days: 90 # required',
      "| `remember.as` | name | Required | The memory's name. |",
      '| `remember.key` | map of names to paths | Required | One or more named parts, each a path in this run. A part is kept as text, a number as its digits; with a part over 1 KB the step remembers nothing. |',
      "| `remember.value` | map, in `input_map`'s form | None | What to keep, in `input_map`'s form. Without it, the step's output is kept. |",
      '| `remember.keep_days` | whole number | Required | How many days to keep each entry, from 1 to 3650. |',
      "`remember` goes on an agent step, or an auto step with `handler` or `uses_service`; the step's own output is `context.resources.<this step>`.",
      'A gated step remembers when its question is answered, with the choice.',
      'A step that failed, took its default answer or whose question expired remembers nothing.',
      "When a key part is missing, empty, null, masked, over 1 KB, or not text or a number, or what it would keep is over 32 KB, the step remembers nothing: its entry says why, and an assistant's `execute_step` reply and `realm run advance` warn.",
      "A path that reads a step's failure message is refused, because a memory outlives the run.",
      "The step's entry records what it remembered (`remembered`), with `expires_at`: when it was written plus `keep_days`.",
      'Nothing reads it back yet.',
      'A name (`as`, and each part of `key`) is letters, digits and underscores, starts with a letter, and is at most 64 characters.',
    ])
      claim(FIELDS, sentence);
  });

  it('step-fields.md: the file that uses every field carries a remember block', () => {
    // Executed by hand at the build: the file validated (its transcript unchanged) and registered.
    claim(
      FIELDS,
      'This file uses the 37 fields that a step itself can carry; `use_template` is shown in [Top-level fields](top-level-fields.md#templates).',
    );
    claim(
      FIELDS,
      '    remember:\n      as: published\n      key: { note: run.params.path }\n      value: { summary: context.resources.summarise.summary }\n      keep_days: 30',
    );
  });

  it("run-record-and-export.md: the evidence entry's remembered row (Words 11)", () => {
    claim(
      'docs/reference/run-record-and-export.md',
      '| `remembered` | object | No | What the step remembered for later runs (`as`, `key`, `value`, `choice`, `expires_at`), or why it remembered nothing (`as`, `not_remembered`, `key_name`). Added after version 0.50.0. |',
    );
  });

  it('testing-package.md: the law row, and the contract exports the law', () => {
    claim(
      'docs/reference/testing-package.md',
      '| `EVIDENCE_KEEPS_REMEMBERED` | An evidence entry written with `remembered` (what a step remembered for later runs, or why it remembered nothing) comes back with it, equal, and one written without it comes back without one. Added after version 0.50.0. |',
    );
    // (a) red when the row names a law the contract does not export; (b) prints the list.
    expect(RUN_STORE_FIDELITY_LAWS).toContain('EVIDENCE_KEEPS_REMEMBERED');
  });

  it('CHANGELOG.md: the entry, sentence by sentence (Words 12, and the library sentence)', () => {
    for (const sentence of [
      '- **A step can remember something for later runs.** `remember:` on an agent step, or an auto step with a handler or a service, keeps a value under a named key for `keep_days` days (required, 1 to 3650).',
      "The step's entry records it as `remembered` (`EvidenceSnapshot.remembered`); when a key part is missing, empty, or not text or a number, the step remembers nothing, and its entry says why.",
      'The store kit gains the law `EVIDENCE_KEEPS_REMEMBERED`.',
      'Library: `StepDefinition.remember` takes a `RememberConfig`, and `EvidenceSnapshot.remembered` is a `RememberedStamp`: a `RememberedItem`, or a `NotRemembered` whose reason is a `NotRememberedReason` (the words: `NOT_REMEMBERED_REASONS`).',
    ])
      claim('CHANGELOG.md', sentence);
  });
});
