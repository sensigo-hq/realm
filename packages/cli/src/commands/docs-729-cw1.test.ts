// docs-729-cw1.test.ts — issue #729, the claim window, unit CW-1: the words the unit adds, each held to
// the page word for word (spaces folded, as a table's padding moves), with the cell that executes what
// the sentence says named beside it. The counts the pages state are computed from the built packages.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RunStore } from '@sensigo/realm';
import { InMemoryStore, LEASE_PORT_LAWS, leasePortContract } from '@sensigo/realm-testing';

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

describe('#729 CW-1 — the claim lease’s words', () => {
  it("core-library.md's `leases` row", () => {
    // What each part executes: the lease port's answers — store-sqlite's contract-leases-cw1 (every
    // law, real locks) and claim-lease-cw1 (a probe that does not throw on an unsearchable folder);
    // the refusal, and a store without it or with `null` admitted — core's admission.test.ts; "nothing in Realm takes a lease
    // yet" — claim-lease-witness-cw1 (no `hold(` call in production source). The count sentence is
    // docs-715b's c4 cell (computed from the built interface). "may still change until the claim
    // window's last unit ships" says what may change, not what the code does: no cell executes it
    // (the owner's compatibility policy, e531209a).
    claim(
      CORE,
      "| `leases` | No | Without it, or `null`, the store keeps no claim leases. Otherwise its lease port, an object with `hold()` and `probe(id)`. A claim lease is a lock the operating system keeps while the program holding it runs, and lets go of when that program ends. `probe` says whether a lease is held: `held`, `not_held`, `absent`, or `unknown` with a reason; it never throws. Realm refuses a `leases` that is neither `null` nor a lease port with `VALIDATION_OPTION_INVALID`, naming `store.leases`. Nothing in Realm takes a lease yet. The lease port may still change until the claim window's last unit ships. Added after version 0.49.0. |",
    );
  });

  it("testing-package.md's lease contract: its table row, the law list, the export row, the section, and InMemoryStore's leases", () => {
    // The row's numbers: the laws the built package exports, and the cases the contract returns for
    // an adapter (store-sqlite's contract-leases-cw1 runs each of them, NOT_RUN empty).
    const cases = leasePortContract({
      storeName: 'count',
      holderKind: 'simulated',
      makeHome: () => Promise.reject(new Error('not run')),
    }).length;
    claim(
      TESTING,
      `| \`leasePortContract\` | \`RunStore.leases\`, with holders in other processes | ${LEASE_PORT_LAWS.length} | ${cases}, with \`@sensigo/realm-store-sqlite\`'s store |`,
    );
    // The two counts (40 values, 39 types) are docs-616-c12's C10 and docs-715a's type-count cell.
    claim(
      TESTING,
      '`storeClockContract`, `STORE_CLOCK_LAWS`, `leasePortContract`, `LEASE_PORT_LAWS`, `createLeaseDouble`, `leaseFactsContract`, `LEASE_FACTS_LAWS` |',
    );
    // The section: each law's line is the law the contract checks (lease-port-contract.ts, run in
    // contract-leases-cw1); the evidence line is the contract's own print; the refusal of an
    // in-process holder is the contract's guard, for a `process` adapter only (the double's
    // `simulated` holders, this process's own, run in lease-port-double.test.ts).
    claim(
      TESTING,
      "The laws of a store's claim leases, `RunStore.leases` (added after version 0.49.0). A claim lease is a lock the operating system keeps while the program holding it runs. Each case builds its own homes. For a store with real locks (holder kind `process`), the adapter starts each holder in another process: a case refuses a holder whose process is the test's own, and prints one line, `[lease-law] <law> platform= node= sqlite= holder= prober= -> <what it saw>`.",
    );
    for (const row of [
      '| `L1_HELD_ACROSS_PROCESSES` | A lease another program holds reads `held`, in a plain home and in one whose path holds `#`, `%`, `?` and a space. |',
      '| `L2_NOT_HELD_AFTER_DEATH` | A held lease reads `not_held` within ten checks 100 ms apart after its program is killed. |',
      "| `L3_DEAD_LEASE_NEVER_HELD_AGAIN` | A dead program's lease id is never handed out again, and the dead lease reads `not_held`. |",
      '| `L4_MISSING_ID_ABSENT_NOTHING_CREATED` | An id no program held reads `absent`, and asking creates no file, in both homes. |',
      "| `L4B_NOT_A_LEASE_UNKNOWN` | A file at a lease's name that is not a lease, empty or a database with `application_id` 0, reads `unknown` with the reason `not_a_lease`. |",
      '| `L4C_UNWRITABLE_NEVER_NOT_HELD` | A held lease the test cannot write reads `unknown` with the reason `permission` (`held` for a test running as root), never `not_held`. |',
      '| `L4D_MODES_AND_CONTENTS` | A lease file is 0600, the lease folder 0700, and while a lease is held its folder holds only its file. |',
      '| `L5_CLOSE_BY_RECORD` | A lease closed with a record that names it on no step reads `absent`; one closed with a record that names it, or with no record, reads `not_held`, to another program and to its holder. |',
      '| `LGC_UNREFERENCED_HOLD_STAYS_HELD` | A hold its program no longer refers to stays `held` after garbage collection. |',
      "| `LSELF_OWN_ID_OPENS_NOTHING` | With its file deleted, the holder's own check of its lease reads `held`, another program's reads `absent`, and the file is not made again. |",
    ])
      claim(TESTING, row);
    // The double's states and the laws it runs: the testing package's lease-port-double.test.ts.
    claim(
      TESTING,
      '`createLeaseDouble()` returns a lease port in memory whose leases a test sets to `live`, `closed_kept`, `removed`, `dead` or `{ forced: fact }`, for the laws that do not need a real lock. A `live` lease reads `held`, a `closed_kept` or `dead` one `not_held`, a `removed` one `absent`, as does an id it never made, and a `{ forced: fact }` one that fact. It runs `L1_HELD_ACROSS_PROCESSES`, `L2_NOT_HELD_AFTER_DEATH`, `L3_DEAD_LEASE_NEVER_HELD_AGAIN` and `L5_CLOSE_BY_RECORD`; the other six laws need a real lock or a file.',
    );
    claim(
      TESTING,
      'Types: `LeaseDouble`, `LeaseDoubleState`, `LeaseHolder`, `LeaseHomeFiles`, `LeasePortContractAdapter`, `LeasePortContractCase`, `LeasePortLaw`, `LeaseTestHome`.',
    );
    // InMemoryStore's sentence, and the property it states. #729 CW-1b rewrote it: a store given a
    // lease port carries lease_facts (the testing package's lease-facts-in-memory-cw1b runs it).
    claim(
      TESTING,
      "It keeps every field of a run's record. It keeps no claim leases unless it is given a lease port, `new InMemoryStore({ leases })` (the lease double, for example); then a run it returns carries `lease_facts` for each in-progress claim that names a lease.",
    );
    // (1) red when InMemoryStore built without a port keeps leases (it leaves `leases` unset,
    //     Amendment 1); (2) prints what it holds.
    const store: RunStore = new InMemoryStore();
    expect(store.leases).toBeUndefined();
  });

  it('the CHANGELOG entry', () => {
    // The refusal, and a store without `leases` admitted ("a store you wrote needs no change"):
    // admission.test.ts; the store's folder: contract-leases-cw1's L4D (the folder is
    // `claim-leases/` through the module's constant); "nothing in Realm takes one yet":
    // claim-lease-witness-cw1; the testing package's exports: docs-616-c12's C10 and the index; the
    // last sentence says what may change, not what the code does: no cell executes it.
    claimChangelog(
      "- **A run store can keep claim leases.** `RunStore` has a new optional property, `leases`: a store without it, or with `null`, keeps none, as before, so a store you wrote needs no change. Realm refuses a `leases` that is neither `null` nor a lease port with `VALIDATION_OPTION_INVALID`, naming `store.leases`. `@sensigo/realm-store-sqlite`'s store keeps claim leases in `claim-leases/` in the Realm home, as locks the operating system lets go of when the program holding one ends; nothing in Realm takes one yet. `@sensigo/realm-testing` adds `leasePortContract`, `LEASE_PORT_LAWS` and `createLeaseDouble`. The lease port may still change until the claim window's last unit ships.",
    );
  });
});
