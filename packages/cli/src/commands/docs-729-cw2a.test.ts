// docs-729-cw2a.test.ts — issue #729, the claim window, unit CW-2a: the words the unit adds, each held
// to the page word for word (spaces folded, as a table's padding moves), with the cell that executes
// what the sentence says named beside it (guardrail 9). The counts the pages state are computed from
// the built packages.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEASED_CLAIM_LAWS, leasedClaimContract } from '@sensigo/realm-testing';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CORE = 'docs/reference/core-library.md';
const TESTING = 'docs/reference/testing-package.md';
const ERRORS = 'docs/reference/error-codes.md';
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

describe('#729 CW-2a — the leased claim’s words', () => {
  it("core-library.md's claimStep row", () => {
    // A store that keeps leases writes the lease, and throws on a lease given twice: the leased-claim
    // contract's LC_CLAIM_NAMES_HOLD, LC_ONE_CLAIM_PER_HOLD and LC_REFUSED_CLAIM_USES_HOLD (the
    // testing package's leased-claim-in-memory-cw2a and store-sqlite's contract-leased-claim-cw2a);
    // "never given one": core's drive-claim-cw2a check 5 (unleased_store before any hold, read or
    // write, for a store without leases).
    claim(
      CORE,
      '| `claimStep(runId, stepName, definition, claimant?, hold?)` | Yes | As one atomic act: read the record afresh, check that the step is not started or settled and can still run, add it to `in_progress_steps`, add 1 to the version, write, and return `{ record, at }`. Throw `STATE_STEP_ALREADY_CLAIMED` or `STATE_STEP_NOT_ELIGIBLE` otherwise. With `hold`, a lease the caller holds, a store that keeps leases also writes `lease: { id }` in the claim, and throws if that lease was already given to a `claimStep` call. A store without leases is never given one. |',
    );
  });

  it('core-library.md: the functions that check their parts, and claimStepForDrive’s paragraph', () => {
    // The two entries check their parts before anything is read or written: core's
    // required-parts.test.ts (their REQUIRED, TYPED, TWO and UNKNOWN_AT rows, `hold`, `hold.id`,
    // `hold.close` and `registry` among them) and admission.test.ts (each admits first).
    claim(
      CORE,
      'Each of these functions, and `executeEngineStep`, `advanceRun`, `drainFinalizers`, `abandonRun`, `reclaimStep`, `getWorkflowForRun`, `claimStepForDrive` and `releaseDriveClaim`, checks the parts it takes before anything is read or written:',
    );
    claim(
      CORE,
      "`dispatcher` a function when the step needs one; `hold` an object with an `id` string and a `close` function; `claimStepForDrive`'s `registry`); and each optional one it was given",
    );
    claim(CORE, '`trace` and `evidence` arrays;');
    // Each answer is core's drive-claim-cw2a: claimed (check 1), held_by with who, since when and the
    // lease's fact (checks 2 and 3), not_eligible (6a), refused with its code (6b, 6c),
    // lease_unavailable with no claim (4), unleased_store with nothing held, read or written (5); every
    // answer but claimed lets go of the lease (2, 3, 6a–6c: `removed`). The give-back: released (8),
    // not_ours with nothing written (9); it does not let go of the lease (8: still `live`).
    // `not_released` with the store's reason: check 8c (the run abandoned while the drive gives its
    // step back: `run_terminal`).
    claim(
      CORE,
      "`claimStepForDrive` takes a step's claim for a program that will run it, under a lease the program holds, before the step's work starts. It answers what happened:",
    );
    for (const item of [
      '- `claimed`, with the lease and when the claim was made;',
      "- `held_by`: another program took the step; who and since when, and its lease's fact, when the run still shows its claim;",
      '- `not_eligible`;',
      '- `refused`, with the code;',
      '- `lease_unavailable`: the store could not make a lease, with why; no claim was taken;',
      '- `unleased_store`: the store keeps no leases; nothing was held or written.',
    ])
      claim(CORE, item);
    claim(
      CORE,
      "Every answer but `claimed` lets go of the lease. `releaseDriveClaim` gives such a claim back without settling the step, when the step's claim still names the program's lease. It answers `released`, `not_ours`, or `not_released` with the reason the store gave. `not_ours` means the step is not in progress, or its claim names no lease or another; nothing was written. It does not let go of the lease: the caller does, with the record it returns. Added after version 0.49.0.",
    );
  });

  it('error-codes.md: the two entries raise VALIDATION_OPTION_INVALID', () => {
    // Executed: core's required-parts.test.ts (the two entries' rows: VALIDATION_OPTION_INVALID before
    // any store call).
    claim(
      ERRORS,
      '`drainFinalizers`, `abandonRun`, `claimStepForDrive`, `releaseDriveClaim`, `reclaimStep` or `getWorkflowForRun`)',
    );
  });

  it("testing-package.md: the contract's row, its section and its laws", () => {
    // The row's numbers: the laws the built package exports, and the cases the contract returns for an
    // adapter (both test files run each of them, NOT_RUN empty).
    const cases = leasedClaimContract({
      storeName: 'count',
      makeStore: () => Promise.reject(new Error('not run')),
    }).length;
    claim(
      TESTING,
      `| \`leasedClaimContract\` | \`RunStore\` with \`leases\`: a claim taken under a lease | ${LEASED_CLAIM_LAWS.length} | ${cases}, with \`InMemoryStore\` and the lease double |`,
    );
    // The adapter's part is the contract's `LeasedClaimTestStore`; the holds come from the store's
    // port (leased-claim-contract.ts's `holdOf`, the witness's listed caller of `hold(`); each law's
    // line is the law the contract checks (leased-claim-contract.ts, run in both files).
    claim(
      TESTING,
      "The laws of a store with claim leases about a claim taken under a lease its caller holds (added after version 0.49.0). Each case builds its own store through the adapter's `makeStore()`, which gives the store a lease port, and takes its leases from that port (`store.leases.hold()`), as a drive does.",
    );
    for (const row of [
      "| `LC_CLAIM_NAMES_HOLD` | `claimStep` given a lease writes `lease: { id }` in the claim it takes, with the lease's id. |",
      '| `LC_NO_HOLD_NO_LEASE` | `claimStep` given no lease writes a claim that names none. |',
      '| `LC_ONE_CLAIM_PER_HOLD` | After a call with a lease wrote a claim, a second call with it, for another step of the run or for a step of another run, throws `ENGINE_INTERNAL`, and neither run changes. |',
      '| `LC_REFUSED_CLAIM_USES_HOLD` | A call refused because its step is already claimed still uses its lease: a later call with it throws `ENGINE_INTERNAL` and writes nothing. |',
      '| `LC_GATE_KEEPS_NO_LEASE` | A gate opened on a claim taken under a lease keeps the claim without its `lease`: its token and the rest of the claim stay, and the step stays in progress. |',
    ])
      claim(TESTING, row);
    // (1) red when a law is added to or dropped from the contract without its row; (2) prints the laws.
    expect([...LEASED_CLAIM_LAWS]).toEqual([
      'LC_CLAIM_NAMES_HOLD',
      'LC_NO_HOLD_NO_LEASE',
      'LC_ONE_CLAIM_PER_HOLD',
      'LC_REFUSED_CLAIM_USES_HOLD',
      'LC_GATE_KEEPS_NO_LEASE',
    ]);
    // The SQLite store runs every law: store-sqlite's contract-leased-claim-cw2a (NOT_RUN empty).
    claim(
      TESTING,
      "`@sensigo/realm-store-sqlite`'s store runs every law too, with its own leases.",
    );
    claim(
      TESTING,
      'Types: `LeasedClaimContractAdapter`, `LeasedClaimContractCase`, `LeasedClaimLaw`, `LeasedClaimTestStore`.',
    );
  });

  it('the CHANGELOG entry', () => {
    // The optional last argument and the lease in the claim, one call per lease: the leased-claim
    // contract (both stores); a store without leases is never given one: core's drive-claim-cw2a
    // check 5; the two functions: core's drive-claim-cw2a (checks 1–9); "no Realm command calls them
    // yet": claim-lease-witness-cw1's closed list of their production calls, empty (correction 1); the
    // gate: the contract's LC_GATE_KEEPS_NO_LEASE; the testing package's exports: its index and this
    // file's imports.
    claimChangelog(
      "- **A drive can take a step's claim under a lease it holds, and give it back.** `RunStore.claimStep` takes an optional last argument, a lease the caller holds. A store with `leases` writes it in the claim as `lease: { id }`, and accepts each lease for one `claimStep` call only. A store without `leases` is never given one, so a store you wrote needs no change. Two new engine functions take and give back such a claim: `claimStepForDrive` and `releaseDriveClaim`. No Realm command calls them yet. A claim a gate keeps while it waits for a person names no lease. `@sensigo/realm-testing` adds `leasedClaimContract` and `LEASED_CLAIM_LAWS`.",
    );
  });
});
