// docs-gap2-iv-a3.test.ts — gap 2, unit (iv-a3), check 7: the new sentences that say validate notes
// an `input_map` that hands a step a failure message, each pinned word for word where a person reads
// it. The other new sentences are pinned where their old ones were: docs-gap2-iv-a1.test.ts
// (agent-step-controls.md, loader-diagnostics.md's notes row and paragraph, CHANGELOG.md) and
// mcp-server's docs-gap2-iv-a2i.test.ts (run-state-and-health.md).
//
// Each claim names the cells that execute what it says: core's workflow/input-map-note-g2iva3.test.ts
// (the loader's notes) and commands/validate-notes-g2iva3.test.ts (validate). (a) red when the page no
// longer holds the sentence word for word; (b) prints the sentence.
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

describe('gap 2 (iv-a3), check 7 — the words', () => {
  it('loader-diagnostics.md: what REALM_NO_NUDGE leaves out (the ride-along)', () => {
    // Executed by validate-notes-g2iva3.test.ts's REALM_NO_NUDGE cell (the loader's notes still
    // print); the strict-output summary and the profile-drift note are silenced by validate.ts's two
    // checks, pinned in validate-structured-output-nudge.test.ts and in
    // validate-cacheability.test.ts's G-5 (8).
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      'A line that starts with `ℹ` is neither a warning nor an error. It is a note, such as how many steps could use strict output. Set `REALM_NO_NUDGE=1` to leave out the strict-output summary and the profile-drift note; it does not silence the other notes.',
    );
  });

  it('the library reference: LoaderNote and the loader’s notes (generated from the TSDoc)', () => {
    // Executed by input-map-note-g2iva3.test.ts (an input_map leaf's note, placement 'input_map')
    // and settlement-message-paths-g2iva1.test.ts (the prompt and instructions notes).
    claim(
      'docs/reference/library/define-and-load-a-workflow.md',
      "A placeholder or an `input_map` leaf that puts a step's failure message (`$settlement.<step>.message`, or a path that holds it) into a `prompt`, a gated step's `instructions` or a step's `input_map`. Information for the author, never a warning: it moves no exit code and never counts toward `--strict` (`validate --json`'s `notes`).",
    );
    claim(
      'docs/reference/library/define-and-load-a-workflow.md',
      "`notes` (gap 2, unit (iv-a1)) the placeholders and `input_map` leaves that put a step's failure message into a prompt, a gated step's instructions or an `input_map`, which `validate` prints.",
    );
  });
});
