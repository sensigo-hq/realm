// docs-729-cw4a.test.ts — issue #729, the claim window, unit CW-4a: the words the unit adds to the pages
// and the CHANGELOG, each held to its page word for word (spaces folded) with the cells that execute what
// it says named beside it (guardrail 9). The three sentences of realm-run-acting.md and
// realm-run-reading.md the unit rewrites are pinned in docs-922-p2.test.ts, with their cells.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (1) red when the page no longer holds the sentence word for word; (2) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** The section that holds this unit's entry: `[Unreleased]` until a release renames it. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.50.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

describe('#729 CW-4a — the lease-check words on the pages', () => {
  it('realm-run-acting.md: the conditions `realm run reclaim --step … --force` can name', () => {
    // The lease-check condition, its absent form word for word and the five unknown reasons: cli
    // lease-words-cw4a ("realm run reclaim --step x --force: the refusal without the stamp, and the
    // success with it, carry the condition", an absent lease on a real SQLite home) and mcp
    // lease-words-cw4a check 1 (each of the six results, through the operator entry's condition).
    claim(
      ACTING,
      "- `This home has no lease file the claim names, so whether its program still holds it is not known; if the claim's program still holds it, the step runs twice.`, for a claim whose lease is absent or could not be checked (one sentence per way the check can fail: `Whether its program still holds the claim's lease was not checked on this read`, `… could not be checked: its lease file could not be opened`, `… could not be checked: the file the claim names is not a lease file`, `… could not be checked: this program cannot open its lease file for writing, which checking needs`, or `… could not be checked: accessing its lease file failed`, each ending `; if the claim's program still holds it, the step runs twice.`)",
    );
    // The held lease's condition, printed before "Reclaimed step …": cli held-lease-cw3a ("lease_held:
    // refused without the stamp (fence_required), freed with it, the record naming lease_held").
    claim(
      ACTING,
      "- `Its program held the claim's lease when it was checked; if that program is still running, the step runs twice.`",
    );
  });

  it('the CHANGELOG line', () => {
    // "what the check found (…), instead of saying the claim has no deadline": mcp lease-words-cw4a
    // check 1 (the MCP replies, execute_step's refusal: the library's context_hint) and check 3; cli
    // lease-words-cw4a (realm run advance, the dry run, inspect, reclaim --step … --force). drain,
    // respond, realm agent and realm workflow run print the same held line as advance (heldLine,
    // ways-renderer.ts; docs-922-p2's DRAIN and RESPOND cells, held-line-922-p22). "no Realm command
    // does yet": the claim lease's source witness (claim-lease-witness-cw1: no command calls
    // claimStepForDrive).
    claimChangelog(
      "- **A held step whose claim's lease could not be checked says why.** Where Realm cannot tell whether a step's program still holds its claim's lease, the words that say whether to wait for the step and how to free it now say what the check found (no lease file, a file that is not a lease, a file it cannot open or read, or no check made on that read), instead of saying the claim has no deadline. That covers the MCP replies and `execute_step`'s refusal (and the library's `context_hint`), `realm run advance`, `realm run drain`, `realm run respond`, `realm agent`, `realm workflow run`, `realm run inspect`, and `realm run reclaim` (the lines under each step, and `--step … --force`). Only a program calling `claimStepForDrive` (`@beta`) makes such a claim; no Realm command does yet. (#729)",
    );
  });
});
