// docs-729-cw3b.test.ts — issue #729, the claim window, unit CW-3b: the words the unit adds, each held
// to the page word for word (spaces folded, as a table's padding moves), with the cell that executes
// what the sentence says named beside it (guardrail 9). The counts the page states are computed from
// the built package.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TAKE_BACK_LAWS, takeBackContract } from '@sensigo/realm-testing';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const TESTING = 'docs/reference/testing-package.md';
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

/** The laws' rows on the page, in the contract's order. */
const ROWS: Record<(typeof TAKE_BACK_LAWS)[number], string> = {
  TB_TAKES_NOT_HELD:
    '| `TB_TAKES_NOT_HELD` | A claim whose lease no program holds is taken back: the step is no longer in progress or claimed, and one entry is written, by the program that took it back, with the reason `lease_not_held`, the prior state `claim_stale`, the prior deadline, when it was taken back, and the claim as it was, without its token. |',
  TB_KEEPS_HELD:
    '| `TB_KEEPS_HELD` | A claim whose lease is held is not taken back (`lease_held`), and nothing is written. |',
  TB_KEEPS_ABSENT:
    '| `TB_KEEPS_ABSENT` | A claim whose lease file is gone is not taken back (`lease_absent`), and nothing is written. |',
  TB_KEEPS_UNKNOWN:
    '| `TB_KEEPS_UNKNOWN` | A claim whose lease cannot be checked is not taken back (`lease_unknown`, with the reason `not_checked`), and nothing is written. |',
  TB_RACE_OTHER_WRITE:
    "| `TB_RACE_OTHER_WRITE` | When another step's write lands between the take-back's read and its write, the take-back reads the run again, and the same claim, still not held, is taken back once. |",
  TB_RACE_TAKEN:
    '| `TB_RACE_TAKEN` | Two take-backs read the same claim: the first takes the step back, and the second answers `not_in_progress`. One entry is written. |',
  TB_RACE_RETAKEN:
    '| `TB_RACE_RETAKEN` | As above, but the step is claimed again before the second take-back writes: the second answers `changed` and leaves the new claim. |',
  TB_CAP:
    '| `TB_CAP` | A step taken back once is not taken back again (`at_cap`) until a person reclaims it (`reclaimStep`); after that it can be taken back again. |',
  TB_KEEPS_UNLEASED:
    '| `TB_KEEPS_UNLEASED` | A claim that names no lease is never taken back (`unleased`). |',
  TB_OWN_GATE: '| `TB_OWN_GATE` | The step of the open question is not taken back (`open_gate`). |',
  TB_OTHER_GATE:
    '| `TB_OTHER_GATE` | A question open on another step does not stop the take-back. |',
};

describe('#729 CW-3b — the take-back laws’ words', () => {
  it("testing-package.md: the Store contracts list, the contract's row and the list sentence", () => {
    // The two names are the built package's exports (this file imports them). The counts on the
    // page's opening, its types line and its contracts line are docs-616-c12's C10 (computed from the
    // built index.js and index.d.ts) and docs-715a's type-count and contract-count cells.
    claim(
      TESTING,
      '`leasedClaimContract`, `LEASED_CLAIM_LAWS`, `takeBackContract`, `TAKE_BACK_LAWS` |',
    );
    // The row's numbers: the laws the built package exports, and the cases the contract returns for an
    // adapter (both runners, the testing package's take-back-in-memory-cw3b and store-sqlite's
    // contract-take-back-cw3b, run each of them, NOT_RUN empty).
    const cases = takeBackContract({
      storeName: 'count',
      makeStore: () => Promise.reject(new Error('not run')),
    }).length;
    claim(
      TESTING,
      `| \`takeBackContract\` | \`RunStore\` with \`leases\`: the engine's take-back of a step whose lease no program holds | ${TAKE_BACK_LAWS.length} | ${cases}, with \`InMemoryStore\` and the lease double |`,
    );
    claim(TESTING, '`TAKE_BACK_LAWS`, added after version 0.50.0, lists the take-back laws.');
  });

  it("testing-package.md: the contract's section, its laws and its types", () => {
    // "taken back once, never while its lease is held, gone or cannot be checked, and never twice
    // before a person reclaims it": TB_TAKES_NOT_HELD, the three TB_KEEPS_* laws, the three races and
    // TB_CAP. #729 CW-5b: "`realm agent` takes back an agent step whose claim's lease is not held, if
    // it has a program name (once, until a person reclaims it)": core's take-back-cw3b witness (its
    // callers: `realm agent`'s watch and the published law family) and the cli's take-back-watch-cw5b
    // (W1, W5, check 7's no-driver and not-an-agent-step cells). The adapter's parts are the contract's `TakeBackTestStore`; the
    // leases come from the store's port (take-back-contract.ts's `holdOf`) and their states are set
    // through the double (`leasedClaim`).
    claim(
      TESTING,
      "The laws a store keeps for the engine's automatic take-back of a step whose claim's lease no program holds (added after version 0.50.0): the step is taken back once, never while its lease is held, gone or cannot be checked, and never twice before a person reclaims it. `realm agent` takes back an agent step whose claim's lease is not held, if it has a program name (once, until a person reclaims it). Each case builds its own store through the adapter's `makeStore()`, which gives the store the lease double as its lease port and returns that double as `leases`, beside `store`. A case takes its claims' leases from the store's port (`store.leases.hold()`) and sets each lease's state through the double.",
    );
    // Each law's line is the law the contract checks (take-back-contract.ts, run in both files).
    for (const law of TAKE_BACK_LAWS) claim(TESTING, ROWS[law]);
    // (1) red when a law is added to or dropped from the contract without its row; (2) prints the laws.
    expect(Object.keys(ROWS)).toEqual([...TAKE_BACK_LAWS]);
    // store-sqlite's contract-take-back-cw3b runs every law, NOT_RUN empty, with the double.
    claim(
      TESTING,
      "`@sensigo/realm-store-sqlite`'s store runs every law too, with the lease double.",
    );
    claim(
      TESTING,
      'Types: `TakeBackContractAdapter`, `TakeBackContractCase`, `TakeBackLaw`, `TakeBackTestStore`.',
    );
  });

  it('the CHANGELOG line', () => {
    // "exactly once, never … held, absent or cannot be checked, and never twice before a person
    // reclaims it": the take-back laws, as above. "internal to the engine": core's API report (its
    // rows are internal). #729 CW-5b: "`realm agent`'s watch uses it": core's take-back-cw3b source
    // witness (its callers) and the cli's take-back-watch-cw5b W1.
    claimChangelog(
      "- **`@sensigo/realm-testing` adds `takeBackContract` and `TAKE_BACK_LAWS`**: the laws a store keeps so that the engine takes back a step whose lease no program holds exactly once, never one whose lease is held, absent or cannot be checked, and never twice before a person reclaims it. The take-back itself is internal to the engine, and `realm agent`'s watch uses it. (#729)",
    );
  });
});
