// docs-729-cw2b.test.ts — issue #729, the claim window, unit CW-2b: the words the unit adds, each held
// to the page word for word (spaces folded, as a table's padding moves), with the cell that executes
// what the sentence says named beside it (guardrail 9).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CORE = 'docs/reference/core-library.md';
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
  const section = text.slice(start, text.indexOf('\n## [0.49.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

describe('#729 CW-2b — the held claim’s words', () => {
  it("core-library.md's `heldClaim` row in the options of executeChain and executeStep", () => {
    // `executeChain` only: core's required-parts.test.ts ("executeStep: heldClaim is not an option of
    // executeStep"); for an agent step: core's held-claim-cw2b checks 11a and 11b (an auto step is
    // judged and run as today); saved under that claim, no new claim taken: check 1; another
    // program's claim as the call starts, refused as without it: check 3c (and check 2, without it);
    // no longer naming the lease at the save, not saved, `STATE_CLAIM_LOST`: checks 3a and 3b; any
    // other state answered as without it: core's suite, unchanged, runs every reply without
    // `heldClaim`, and checks 7 and 8 hold the replies inside a held call; the steps run after it
    // take their own claims: check 9.
    claim(
      CORE,
      "| `heldClaim` | No | `executeChain` only, for an agent step. `{ hold }`: the lease under which `claimStepForDrive` took the step's claim. The step is saved under that claim, and no new claim is taken. When another program's claim is on the step as the call starts, the call is refused as it would be without `heldClaim` (`held_elsewhere`, unless the run's state gives an earlier reason). When, at the save, the claim no longer names that lease, the answer is not saved and the call is refused `STATE_CLAIM_LOST`. Any other state is answered as without it. The steps run after it take their own claims. Added after version 0.49.0. |",
    );
  });

  it('core-library.md: heldClaim among the optional parts a function checks', () => {
    // Executed: core's required-parts.test.ts (the CW-2b cells: a `heldClaim` that is not an object,
    // and a `hold` with no object, `id` string or `close` function, refused before any read).
    claim(
      CORE,
      '`outputSource` one of its values; `heldClaim` an object whose `hold` has an `id` string and a `close` function).',
    );
  });

  it('the CHANGELOG entry', () => {
    // The option names the lease `claimStepForDrive` took the claim under: core's held-claim-cw2b
    // (every check takes the claim with it); saved under it, no second claim: check 1; refused when
    // the claim no longer names the lease at the save: checks 3a and 3b; the chained steps' own
    // claims: check 9; the `held_claim` member: core's ways.test.ts (the CW-2b held member, with
    // R26); "No Realm command passes it yet": claim-lease-witness-cw1's closed list of production
    // `heldClaim` properties, empty.
    claimChangelog(
      "- **`executeChain` can save an agent step under a claim the caller already holds.** Its new option `heldClaim: { hold }` names the lease under which `claimStepForDrive` took the step's claim. The step is saved under that claim, and no second claim is taken. If the step's claim no longer names the lease when the answer is saved, the answer is not saved and the call is refused. The steps the chain runs after it take their own claims. `WaysContext`, the context `composeWaysOn` and `admitWay` take, gains the matching optional member `held_claim: { step, lease_id }`. No Realm command passes it yet.",
    );
  });
});
