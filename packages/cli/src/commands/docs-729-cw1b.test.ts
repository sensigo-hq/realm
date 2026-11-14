// docs-729-cw1b.test.ts — issue #729, the claim window, unit CW-1b part 1: the words the unit adds,
// each held to the page word for word (spaces folded, as a table's padding moves), with the cell that
// executes what the sentence says named beside it (guardrail 9). The counts the pages state are
// computed from the built packages.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEASE_FACTS_LAWS, leaseFactsContract } from '@sensigo/realm-testing';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CORE = 'docs/reference/core-library.md';
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
  const section = text.slice(start, text.indexOf('\n## [0.49.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

describe('#729 CW-1b — the lease facts’ words', () => {
  it('core-library.md, "The run store interface": what a store with a lease port returns', () => {
    // What it executes: a store with a lease port returns the facts, observed after the read or write —
    // the lease-facts contract on the SQLite store (store-sqlite's contract-lease-facts-cw1b, a holder
    // in another process) and on InMemoryStore with the double (the testing package's
    // lease-facts-in-memory-cw1b), one law per returning method; a store without one returns none, and
    // a claim that names no lease reads unleased, one that names a lease not checked — core's
    // lease-facts-cw1b ("a store written before CW-1b works unchanged"; "its four answers").
    claim(
      CORE,
      "Every function that reads or writes a run returns the reading of the store's clock it used, with the record (added after version 0.48.0). A store with a lease port also returns `lease_facts`: what it found about each in-progress claim's lease after its read or write. A store without one returns none; Realm then reads a claim that names no lease as unleased, and one that names a lease as not checked, never as not held (added after version 0.49.0).",
    );
  });

  it("core-library.md's table of functions a store uses: writtenSnapshot's row and leaseFactsOf's", () => {
    // writtenSnapshot with facts: the stores build each result with it (the contract's laws read the
    // facts back); with no facts it is `{ record, at }` exactly (lease-facts-in-memory-cw1b, "keeps no
    // claim leases"). leaseFactsOf asks once per lease, in-progress claims only: core's lease-facts-cw1b
    // ("two in-progress claims on one lease give one probe"; "a claim whose step is not in progress is
    // never probed"); after the read or write: the stores call it once their call's write is done.
    claim(
      CORE,
      '| `writtenSnapshot` | Every call | Builds the `{ record, at }` a call returns, with the `lease_facts` from `leaseFactsOf` when the store has a lease port. |',
    );
    claim(
      CORE,
      "| `leaseFactsOf` | Every call that returns a run, in a store with a lease port | Asks the lease port about each in-progress claim's lease, once per lease, after the read or write. |",
    );
  });

  it("testing-package.md: InMemoryStore's leases, the contract's row, its section and its laws", () => {
    // InMemoryStore given a port: lease-facts-in-memory-cw1b (every law: a run with a leased
    // in-progress claim carries its facts; a run with none carries no `lease_facts`, the law
    // LF_UNLEASED_PROBES_NOTHING); without one: the same file's "keeps no claim leases" cell, and
    // docs-729-cw1's `leases` check.
    claim(
      TESTING,
      'It keeps no claim leases unless it is given a lease port, `new InMemoryStore({ leases })` (the lease double, for example); then a run it returns carries `lease_facts` for each in-progress claim that names a lease.',
    );
    // The row's numbers: the laws the built package exports, and the cases the contract returns for an
    // adapter (both test files run each of them, NOT_RUN empty).
    const cases = leaseFactsContract({
      storeName: 'count',
      makeStore: () => Promise.reject(new Error('not run')),
    }).length;
    claim(
      TESTING,
      `| \`leaseFactsContract\` | \`RunStore\` with \`leases\`: the lease facts on the runs it returns | ${LEASE_FACTS_LAWS.length} | ${cases}, with \`InMemoryStore\` and the lease double |`,
    );
    // The section: the adapter's three parts are the contract's `LeaseFactsTestStore`; each law's line
    // is the law the contract checks (lease-facts-contract.ts, run in both files above).
    claim(
      TESTING,
      "The laws of a store with claim leases about the runs it returns: a run with an in-progress claim that names a lease carries `lease_facts`, what the store's lease port found about that lease (added after version 0.49.0). Each case builds its own store through the adapter's `makeStore()`, which gives the store a lease port, a lease another program holds (`heldLease()`; for a store with real locks, a program in another process), and every id its port was asked about (`probed()`). Nothing in Realm writes a claim's lease yet, so a case writes two leased claims through the store's own `update`: one on the held lease, one on a lease no program held. Each case reads the facts with `leaseFactOf`.",
    );
    for (const row of [
      '| `LF_GET` | `get` returns `held` for the claim on the held lease and `absent` for the other. |',
      '| `LF_SCAN_PAGE` | A record page of `scan` does the same. |',
      '| `LF_CREATE_KEYED_EXISTING` | A keyed `create` that returns the run already holding the key does the same. |',
      '| `LF_UPDATE` | `update` does the same. |',
      '| `LF_CLAIM_STEP` | `claimStep` of another step does the same. |',
      '| `LF_SETTLE_APPLIED` | An applied `settleStep` of another step does the same. |',
      '| `LF_SETTLE_REFUSED` | A `settleStep` refused by its predicate, a replayed settle, does the same. |',
      '| `LF_UNLEASED_PROBES_NOTHING` | A run with no leased claim, the new run a `create` makes, is returned with no `lease_facts`, and the lease port is asked nothing. |',
    ])
      claim(TESTING, row);
    // (1) red when a law is added to or dropped from the contract without its row; (2) prints the laws.
    expect([...LEASE_FACTS_LAWS]).toEqual([
      'LF_GET',
      'LF_SCAN_PAGE',
      'LF_CREATE_KEYED_EXISTING',
      'LF_UPDATE',
      'LF_CLAIM_STEP',
      'LF_SETTLE_APPLIED',
      'LF_SETTLE_REFUSED',
      'LF_UNLEASED_PROBES_NOTHING',
    ]);
    // The SQLite store runs every law: store-sqlite's contract-lease-facts-cw1b (NOT_RUN empty).
    claim(
      TESTING,
      "`@sensigo/realm-store-sqlite`'s store runs every law too, with its holder in another process.",
    );
    claim(
      TESTING,
      'Types: `LeaseFactsContractAdapter`, `LeaseFactsContractCase`, `LeaseFactsLaw`, `LeaseFactsTestStore`.',
    );
  });

  it('the CHANGELOG entry', () => {
    // The SQLite store and InMemoryStore with a port attach the facts: the lease-facts contract in
    // both files; a store without leases needs no change: core's lease-facts-cw1b ("a store written
    // before CW-1b works unchanged"); the three functions take or return a fact for a leased claim
    // and are unchanged for any other: core's lease-facts-cw1b (the classifyClaim table, the
    // consumers, "an unleased claim's results are exactly today's"); "nothing in Realm takes a lease
    // yet": claim-lease-witness-cw1 (no `hold(` call in production source).
    claimChangelog(
      "- **A run a store returns can carry the facts about its claims' leases** (`lease_facts`, optional): `@sensigo/realm-store-sqlite` attaches them, and `InMemoryStore` does when given a lease port; a store without leases needs no change. `classifyClaim`, `describeClaimHolder` and `classifyInProgressClaims` take or return a lease fact for a claim that names a lease, and are unchanged for any other. Nothing in Realm takes a lease yet.",
    );
  });
});
