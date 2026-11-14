// lease-facts-in-memory-cw1b.test.ts — issue #729, the claim window, unit CW-1b part 1: the published
// lease-facts contract (`leaseFactsContract`) run against `InMemoryStore` given the lease double as its
// lease port (`new InMemoryStore({ leases })`), every law. The held lease is one the double is told is
// `live`; the store's port is the double behind a wrapper that lists every id it is asked about.
//
// The second describe holds the store's own cells: built without a port it keeps none, and takes the
// path it took before CW-1b. Correction 1 adds: a run seeded with `claims: null` stays readable, and
// the contract's failure for facts this copy does not read carries the cross-copy note (another
// release's copy of core's lease-facts module is loaded from four of its built files, the version
// line changed, as the multi-copy layout makes another release).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LeaseFacts, LeasePort, RunRecord } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';
import { createLeaseDouble } from './lease-double.js';
import {
  LEASE_FACTS_LAWS,
  leaseFactsContract,
  type LeaseFactsContractAdapter,
  type LeaseFactsLaw,
} from './lease-facts-contract.js';

/** The laws this file does not run, each with its reason. None: the double answers every one. */
const NOT_RUN: Partial<Record<LeaseFactsLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly LeaseFactsLaw[] = LEASE_FACTS_LAWS.filter((law) => !(law in NOT_RUN));

const ADAPTER: LeaseFactsContractAdapter = {
  storeName: 'InMemoryStore with the lease double',
  makeStore: async () => {
    const double = createLeaseDouble();
    const probed: string[] = [];
    const leases: LeasePort = {
      hold: () => double.hold(),
      probe: (id) => {
        probed.push(id);
        return double.probe(id);
      },
    };
    return {
      store: new InMemoryStore({ leases }),
      heldLease: async () => {
        double.set('lease-facts-held', 'live');
        return 'lease-facts-held';
      },
      probed: () => probed,
      dispose: async () => {},
    };
  },
};

describe('#729 CW-1b — InMemoryStore with the lease double runs the lease-facts contract', () => {
  it('runs every law: NOT_RUN is empty', () => {
    // (1) red when a law is put in NOT_RUN (it then never runs here); (2) prints the laws named there.
    expect(NOT_RUN).toEqual({});
  });

  const cases = leaseFactsContract(ADAPTER);
  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the
      //     law. The case itself throws, naming the law and what the store returned, when it fails.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});

describe('#729 CW-1b — InMemoryStore without a lease port', () => {
  it('keeps no claim leases: it has no own leases property, and a leased claim it holds reads no facts', async () => {
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: 'w', workflowVersion: 1, params: {} });
    const written = await store.update({
      ...record,
      in_progress_steps: ['a'],
      claims: { a: { deadline: null, lease: { id: 'lease-1' } } },
    });
    const read = await store.get(record.id);
    // (1) red when a store built without a port gets one, has an own `leases` property (a class field
    //     emitted for it: correction 1), or its results carry lease_facts; (2) prints the property,
    //     whether it is own, and the keys of what update and get returned.
    expect({
      leases: store.leases,
      own: Object.hasOwn(store, 'leases'),
      written: Object.keys(written),
      read: Object.keys(read),
    }).toEqual({
      leases: undefined,
      own: false,
      written: ['record', 'at'],
      read: ['record', 'at'],
    });
  });
});

/** Core's built folder: the files a copy of its lease-facts module is made from. */
const CORE_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'core', 'dist');

/** A copy of core's built lease-facts module, loaded on its own, with `version` as its release. */
async function leaseFactsOfRelease(
  version: string,
  root: string,
): Promise<{ leaseFactsOf: (port: LeasePort, record: RunRecord) => Promise<LeaseFacts> }> {
  for (const file of ['store/lease-facts.js', 'store/lease-port.js', 'brand.js', 'version.js']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    // Without its source-map line: the maps are not copied, so the loader would look for them.
    const built = readFileSync(join(CORE_DIST, file), 'utf8');
    writeFileSync(join(root, file), built.replace(/^\/\/# sourceMappingURL=.*$/m, ''));
  }
  const versionJs = join(root, 'version.js');
  const text = readFileSync(versionJs, 'utf8');
  const line = /^export const VERSION = '[^']+';$/m;
  if (!line.test(text)) throw new Error(`${versionJs} has no VERSION line`);
  writeFileSync(versionJs, text.replace(line, `export const VERSION = '${version}';`));
  return (await import(pathToFileURL(join(root, 'store', 'lease-facts.js')).href)) as {
    leaseFactsOf: (port: LeasePort, record: RunRecord) => Promise<LeaseFacts>;
  };
}

describe('#729 CW-1b correction 1 — InMemoryStore with a port: a malformed run, and facts from another release', () => {
  it('a run seeded with claims: null is read by get and by a scan page, and so is every other run', async () => {
    const store = new InMemoryStore({ leases: createLeaseDouble() });
    const { record: other } = await store.create({
      workflowId: 'w',
      workflowVersion: 1,
      params: {},
    });
    const odd = {
      ...other,
      id: 'run-null-claims',
      in_progress_steps: ['a'],
      claims: null,
    } as unknown as RunRecord;
    store.seed(odd);
    const read = await store.get(odd.id).then(
      (snapshot) => ({ claims: snapshot.record.claims, facts: snapshot.lease_facts }),
      (err: unknown) => `rejected: ${String(err)}`,
    );
    const pages = store.scan({}, { pageSize: 10 });
    const page = await pages.next().then(
      (p) =>
        p.done
          ? 'no page'
          : p.value.items.map((i) => (i.kind === 'run' ? i.run.record.id : i.kind)),
      (err: unknown) => `rejected: ${String(err)}`,
    );
    await pages.return(undefined);
    const otherRead = await store.get(other.id).then(
      (snapshot) => snapshot.record.id,
      (err: unknown) => `rejected: ${String(err)}`,
    );
    // (1) red when the store's facts step throws on a stored `claims: null` (get and every scan page
    //     holding the run then reject); (2) prints what each read gave.
    expect({ read, page: Array.isArray(page) ? [...page].sort() : page, otherRead }).toEqual({
      read: { claims: null, facts: undefined },
      page: [odd.id, other.id].sort(),
      otherRead: other.id,
    });
  });

  it("the contract's failure for lease_facts another release made says so, with the cross-copy note", async () => {
    const root = mkdtempSync(join(tmpdir(), 'realm-cw1b-other-release-'));
    try {
      const version = /^export const VERSION = '([^']+)';$/m.exec(
        readFileSync(join(CORE_DIST, 'version.js'), 'utf8'),
      )![1]!;
      const otherRelease = `${version}-other`;
      const other = await leaseFactsOfRelease(otherRelease, root);
      const double = createLeaseDouble();
      const real = new InMemoryStore({ leases: double });
      // The store answers `get` with the facts another release's copy of core made: what a store
      // whose own copy of @sensigo/realm is another release returns.
      const store = Object.create(real) as InMemoryStore;
      store.get = async (runId) => {
        const snapshot = await real.get(runId);
        return {
          record: snapshot.record,
          at: snapshot.at,
          lease_facts: await other.leaseFactsOf(double, snapshot.record),
        };
      };
      const [lfGet] = leaseFactsContract({
        storeName: 'a store whose facts come from another release',
        makeStore: async () => ({
          store,
          heldLease: async () => {
            double.set('lease-facts-held', 'live');
            return 'lease-facts-held';
          },
          probed: () => [],
          dispose: async () => {},
        }),
      }).filter((c) => c.law === 'LF_GET');
      const failure = await lfGet!.run().then(
        () => 'passed',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      // (1) red when the failure does not say the store's facts are ones this copy does not read, or
      //     drops the cross-copy note naming the other release; (2) prints the failure.
      expect({
        saysSo: failure.includes(
          'it carries lease_facts this copy of @sensigo/realm does not read',
        ),
        note: failure.includes(`got a LeaseFacts from realm ${otherRelease}`),
        notThisCopy: failure.includes(`not this copy's (${version})`),
      }).toEqual({ saysSo: true, note: true, notThisCopy: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
