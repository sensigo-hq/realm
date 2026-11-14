// lease-facts-cw1b.test.ts — issue #729, the claim window, unit CW-1b part 1: core's lease facts —
// `leaseFactsOf` (who is probed, how often, and what a failed probe gives), the one reader
// `leaseFactOf`, `classifyClaim`'s lease branch (design record C5 §4.4's table), the consumers that
// carry a fact (`classifyInProgressClaims`, `describeClaimHolder`, `held_elsewhere`'s three producers
// in ways.ts), that an unleased claim's results are exactly today's, and that a store written before
// CW-1b (no `leases`, a plain `{ record, at }` from `get`) still works.
//
// Each cell names the change that turns it red and what it prints when it fails.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { leaseFactOf, leaseFactsOf, NO_LEASE_FACTS, type LeaseFacts } from './lease-facts.js';
import type { LeaseFact, LeasePort } from './lease-port.js';
import type { RunStore } from './store-interface.js';
import { writtenSnapshot, type Snapshot } from '../engine/snapshot.js';
import { classifyClaim, classifyInProgressClaims } from '../engine/claim-liveness.js';
import { describeClaimHolder } from '../engine/holder.js';
import {
  admitWay,
  composeWaysAt,
  composeWaysOn,
  type Unavailable,
  type WaysContext,
} from '../engine/ways.js';
import { admitEntry } from '../admission.js';
import { declareReleaseLine } from '../release-line.js';
import type { ClaimRecord, RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { VERSION } from '../version.js';

const BASIS = 'kernel_lock' as const;
const HELD: LeaseFact = { state: 'held', basis: BASIS };
const NOT_HELD: LeaseFact = { state: 'not_held', basis: BASIS };
const ABSENT: LeaseFact = { state: 'absent', basis: BASIS };
const unknown = (
  reason: 'not_checked' | 'cannot_open' | 'not_a_lease' | 'permission' | 'io_error',
) => ({ state: 'unknown', basis: BASIS, reason }) as const;
const UNLEASED = { absent: 'unleased' } as const;

const AT = new Date('2026-11-14T12:00:00.000Z');
const PAST = '2026-11-14T11:00:00.000Z';
const FUTURE = '2026-11-14T13:00:00.000Z';

/** A port that answers each id from `answer`, and lists every id it was asked about, in order. */
function portOf(answer: (id: string) => Promise<LeaseFact> | LeaseFact): {
  port: LeasePort;
  probed: string[];
} {
  const probed: string[] = [];
  return {
    probed,
    port: {
      hold: async () => ({ unavailable: 'io_error' }),
      probe: async (id: string) => {
        probed.push(id);
        return answer(id);
      },
    },
  };
}

/** A run whose claims are `claims`, with `inProgress` in progress. */
function runWith(claims: Record<string, unknown>, inProgress: readonly string[]): RunRecord {
  return {
    id: 'r',
    workflow_id: 'w',
    version: 3,
    params: {},
    completed_steps: [],
    in_progress_steps: [...inProgress],
    failed_steps: [],
    skipped_steps: [],
    evidence: [],
    terminal_state: false,
    claims,
  } as unknown as RunRecord;
}

const claimOn = (id: string, extra: Partial<ClaimRecord> = {}): ClaimRecord => ({
  deadline: null,
  lease: { id },
  ...extra,
});

/** The snapshot of `record` with the facts `port` finds (as a store with a lease port returns it). */
async function snapshotWith(record: RunRecord, port: LeasePort): Promise<Snapshot> {
  return writtenSnapshot(record, AT, await leaseFactsOf(port, record));
}

describe('#729 CW-1b — leaseFactsOf: one probe per lease id, of in-progress claims only', () => {
  it('two in-progress claims on one lease give one probe, and each lease id has its fact', async () => {
    const { port, probed } = portOf((id) => (id === 'lease-1' ? HELD : NOT_HELD));
    const record = runWith(
      { a: claimOn('lease-1'), b: claimOn('lease-1'), c: claimOn('lease-2') },
      ['a', 'b', 'c'],
    );
    const facts = await leaseFactsOf(port, record);
    // (a) red when each claim is probed instead of each lease id (lease-1 then appears twice), or a
    //     fact is filed under the wrong id; (b) prints the ids probed and the facts.
    expect({ probed, facts: { ...facts } }).toEqual({
      probed: ['lease-1', 'lease-2'],
      facts: { 'lease-1': HELD, 'lease-2': NOT_HELD },
    });
  });

  it('a claim whose step is not in progress is never probed', async () => {
    const { port, probed } = portOf(() => HELD);
    // `b`'s claim is left on the record (a missed delete self-heals, claim-liveness.ts's omitClaim):
    // its step is not in progress, so its lease is not a live claim's.
    const record = runWith({ a: claimOn('lease-1'), b: claimOn('lease-2') }, ['a']);
    const facts = await leaseFactsOf(port, record);
    // (a) red when the claims are read without the in-progress list (lease-2 is then probed);
    //     (b) prints the ids probed and the ids the facts hold.
    expect({ probed, ids: Object.keys(facts) }).toEqual({ probed: ['lease-1'], ids: ['lease-1'] });
  });

  it('no port (absent or null): NO_LEASE_FACTS, and no claim is read', async () => {
    const reads: string[] = [];
    const record = new Proxy(runWith({ a: claimOn('lease-1') }, ['a']), {
      get(target, key, receiver) {
        reads.push(String(key));
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const got = [await leaseFactsOf(undefined, record), await leaseFactsOf(null, record)];
    // (a) red when a store without a port reads the record's claims, or gets facts; (b) prints the
    //     fields read.
    expect({ none: got.every((f) => f === NO_LEASE_FACTS), reads }).toEqual({
      none: true,
      reads: [],
    });
  });

  it('a probe that rejects, throws, or answers no fact gives unknown(io_error) for that id', async () => {
    const answers: Record<string, () => Promise<LeaseFact> | LeaseFact> = {
      rejects: () => Promise.reject(new Error('the disk is gone')),
      throws: () => {
        throw new Error('a synchronous throw');
      },
      'no-basis': () => ({ state: 'held' }) as unknown as LeaseFact,
      'bad-reason': () =>
        ({ state: 'unknown', basis: BASIS, reason: 'tired' }) as unknown as LeaseFact,
      'held-with-reason': () => ({ ...HELD, reason: 'io_error' }) as unknown as LeaseFact,
      'not-an-object': () => 'held' as unknown as LeaseFact,
      fine: () => ABSENT,
    };
    const port: LeasePort = {
      hold: async () => ({ unavailable: 'io_error' }),
      // A port whose `probe` itself may throw before it returns a promise.
      probe: ((id: string) => {
        const answer = answers[id]!();
        return answer instanceof Promise ? answer : Promise.resolve(answer);
      }) as LeasePort['probe'],
    };
    const ids = Object.keys(answers);
    const record = runWith(Object.fromEntries(ids.map((id) => [id, claimOn(id)])), ids);
    const outcome = await leaseFactsOf(port, record).then(
      (facts) => ({ ...facts }),
      (err: unknown) => `rejected: ${String(err)}`,
    );
    // (a) red when a rejection or a throw is passed on (the call rejects), or an answer that is not a
    //     fact is kept as one; (b) prints each id's fact, or the rejection.
    expect(outcome).toEqual({
      rejects: unknown('io_error'),
      throws: unknown('io_error'),
      'no-basis': unknown('io_error'),
      'bad-reason': unknown('io_error'),
      'held-with-reason': unknown('io_error'),
      'not-an-object': unknown('io_error'),
      fine: ABSENT,
    });
  });

  it('a malformed stored lease is skipped (no probe, no entry), and the reader answers not_a_lease', async () => {
    const { port, probed } = portOf(() => HELD);
    const claims = {
      'lease-null': { deadline: null, lease: null },
      'lease-number': { deadline: null, lease: 5 },
      'id-number': { deadline: null, lease: { id: 7 } },
      'no-id': { deadline: null, lease: {} },
    };
    const record = runWith(claims, Object.keys(claims));
    const facts = await leaseFactsOf(port, record);
    const snapshot = writtenSnapshot(record, AT, facts);
    const read = Object.fromEntries(
      Object.entries(claims).map(([step, claim]) => [
        step,
        leaseFactOf(snapshot, claim as unknown as ClaimRecord),
      ]),
    );
    // (a) red when a malformed lease is probed (its text or its object reaches the port) or read as
    //     unleased or absent; (b) prints the ids probed, whether facts were made, and each answer.
    expect({ probed, none: facts === NO_LEASE_FACTS, read }).toEqual({
      probed: [],
      none: true,
      read: {
        'lease-null': unknown('not_a_lease'),
        'lease-number': unknown('not_a_lease'),
        'id-number': unknown('not_a_lease'),
        'no-id': unknown('not_a_lease'),
      },
    });
  });

  it('no in-progress claim names a lease: NO_LEASE_FACTS, with no probe', async () => {
    const { port, probed } = portOf(() => HELD);
    const record = runWith({ a: { deadline: FUTURE, token: 't' }, b: { deadline: null } }, [
      'a',
      'b',
    ]);
    const facts = await leaseFactsOf(port, record);
    // (a) red when a run with no leased claim is probed, or gets facts of its own; (b) prints both.
    expect({ probed, none: facts === NO_LEASE_FACTS }).toEqual({ probed: [], none: true });
  });

  it('the facts are frozen and have no prototype: an inherited name is never a fact, and __proto__ is an id like any other', async () => {
    const { port } = portOf((id) => (id === '__proto__' ? NOT_HELD : HELD));
    const record = runWith(
      { a: claimOn('__proto__'), b: claimOn('constructor'), c: claimOn('toString') },
      ['a', 'b'],
    );
    const snapshot = await snapshotWith(record, port);
    const facts = snapshot.lease_facts!;
    // (a) red when the facts are a plain object read with `in` (an inherited `toString` is then read
    //     as a fact, and an assigned `__proto__` is lost to the prototype's setter), or are not frozen;
    //     (b) prints each.
    expect({
      prototype: Object.getPrototypeOf(facts),
      frozen: Object.isFrozen(facts),
      proto: leaseFactOf(snapshot, record.claims!['a']),
      ctor: leaseFactOf(snapshot, record.claims!['b']),
      inherited: leaseFactOf(snapshot, record.claims!['c']),
    }).toEqual({
      prototype: null,
      frozen: true,
      proto: NOT_HELD,
      ctor: HELD,
      inherited: unknown('not_checked'),
    });
  });
});

describe('#729 CW-1b — the one reader, leaseFactOf', () => {
  it('its four answers: unleased, the attached fact, not_checked, not_a_lease', async () => {
    const { port } = portOf(() => NOT_HELD);
    const record = runWith(
      {
        plain: { deadline: FUTURE },
        leased: claimOn('lease-1'),
        unprobed: claimOn('lease-2'),
        malformed: { deadline: null, lease: null },
      },
      ['plain', 'leased', 'malformed'],
    );
    const snapshot = await snapshotWith(record, port);
    const claims = record.claims!;
    // (a) red when a claim that names a lease but has no fact reads absent or not_held (only a probe
    //     says not_held), a claim with no lease reads anything but unleased, or the attached fact is
    //     not the one returned; (b) prints each answer.
    expect({
      noClaim: leaseFactOf(snapshot, undefined),
      plain: leaseFactOf(snapshot, claims['plain']),
      leased: leaseFactOf(snapshot, claims['leased']),
      unprobed: leaseFactOf(snapshot, claims['unprobed']),
      noFacts: leaseFactOf(writtenSnapshot(record, AT), claims['leased']),
      malformed: leaseFactOf(snapshot, claims['malformed']),
    }).toEqual({
      noClaim: UNLEASED,
      plain: UNLEASED,
      leased: NOT_HELD,
      unprobed: unknown('not_checked'),
      noFacts: unknown('not_checked'),
      malformed: unknown('not_a_lease'),
    });
  });

  it('a facts object core did not make is never read: a store’s own object, or a copy, reads not_checked', async () => {
    const { port } = portOf(() => NOT_HELD);
    const record = runWith({ a: claimOn('lease-1') }, ['a']);
    const made = await snapshotWith(record, port);
    // A store's own object, frozen with no prototype like the real one: only a cast makes it a
    // `LeaseFacts` (the brand), and the reader still reads it as not checked.
    const forged = Object.freeze(
      Object.assign(Object.create(null) as object, { 'lease-1': NOT_HELD }),
    ) as unknown as LeaseFacts;
    const claim = record.claims!['a'];
    // (a) red when the reader reads any object with the id as a key (a store could then make
    //     not_held without a probe); (b) prints each answer.
    expect({
      made: leaseFactOf(made, claim),
      forged: leaseFactOf({ lease_facts: forged }, claim),
      copied: leaseFactOf(structuredClone(made), claim),
    }).toEqual({
      made: NOT_HELD,
      forged: unknown('not_checked'),
      copied: unknown('not_checked'),
    });
  });
});

describe('#729 CW-1b — classifyClaim’s lease branch (design record C5 §4.4)', () => {
  const table: Array<[string, LeaseFact, string]> = [
    ['held', HELD, 'healthy'],
    ['not_held', NOT_HELD, 'claim_stale'],
    ['absent', ABSENT, 'claim_unknown_age'],
    ...(['not_checked', 'cannot_open', 'not_a_lease', 'permission', 'io_error'] as const).map(
      (reason): [string, LeaseFact, string] => [
        `unknown(${reason})`,
        unknown(reason),
        'claim_unknown_age',
      ],
    ),
  ];
  it.each(table)(
    'a claim whose lease is %s is %s, whatever its deadline',
    (_label, fact, state) => {
      const states = [null, PAST, FUTURE].map((deadline) =>
        classifyClaim(claimOn('lease-1', { deadline }), AT, fact),
      );
      // (a) red when the lease branch comes after the null-deadline return (a `null` deadline then
      //     reads claim_unknown_age for held and not_held), or the deadline decides for a leased claim;
      //     (b) prints the state for a null, a past and a future deadline.
      expect(states).toEqual([state, state, state]);
    },
  );

  it('{ absent: unleased } leaves today’s answer', () => {
    const states = [undefined, null, PAST, FUTURE].map((deadline) =>
      classifyClaim(deadline === undefined ? undefined : { deadline }, AT, UNLEASED),
    );
    // (a) red when an unleased claim is judged by a lease; (b) prints the four states.
    expect(states).toEqual(['claim_unknown_age', 'claim_unknown_age', 'claim_stale', 'healthy']);
  });

  it('no argument: an unleased claim keeps today’s answer, a leased one reads claim_unknown_age', () => {
    // (a) red when a call without a fact judges a leased claim by its deadline (a future one would
    //     read healthy) or changes an unleased claim's answer; (b) prints both.
    expect({
      unleased: [PAST, FUTURE].map((deadline) => classifyClaim({ deadline }, AT)),
      leased: [null, PAST, FUTURE].map((deadline) => classifyClaim(claimOn('l', { deadline }), AT)),
    }).toEqual({
      unleased: ['claim_stale', 'healthy'],
      leased: ['claim_unknown_age', 'claim_unknown_age', 'claim_unknown_age'],
    });
  });
});

describe('#729 CW-1b — the consumers carry a leased claim’s fact', () => {
  it('classifyInProgressClaims: a leased claim’s info carries its fact, and its state is the table’s', async () => {
    const { port } = portOf(() => HELD);
    const record = runWith({ probed: claimOn('lease-1'), missing: claimOn('lease-2') }, ['probed']);
    const snapshot = await snapshotWith(record, port);
    // `missing` is in progress on a snapshot built without its fact (as a store without leases
    // returns it): not_checked.
    const both = writtenSnapshot(
      { ...record, in_progress_steps: ['probed', 'missing'] },
      AT,
      snapshot.lease_facts,
    );
    // (a) red when the info drops the fact, or its state is judged without it (held with a null
    //     deadline would read claim_unknown_age); (b) prints each info.
    expect(classifyInProgressClaims(both)).toEqual([
      { step: 'probed', state: 'healthy', deadline: null, lease: HELD },
      {
        step: 'missing',
        state: 'claim_unknown_age',
        deadline: null,
        lease: unknown('not_checked'),
      },
    ]);
  });

  it('describeClaimHolder: a fact is returned beside today’s answer as lease', () => {
    const claim = { since: PAST, holder: { by: 'drive', by_source: 'derived', channel: 'agent' } };
    const today = describeClaimHolder(claim as ClaimRecord, true);
    // (a) red when the fact is dropped or replaces the answer; (b) prints the answer.
    expect(describeClaimHolder(claim as ClaimRecord, true, NOT_HELD)).toEqual({
      ...today,
      lease: NOT_HELD,
    });
  });

  // The three producers of `held_elsewhere` in ways.ts, each through heldFacts. The fourth
  // (execution-loop.ts's claim refusal) runs only when the step can be run by name, so its step is not
  // in progress and carries no fact: it has no cell (CW-AU1BR-06).
  const AGENT_ONLY: WorkflowDefinition = {
    id: 'w',
    name: 'w',
    version: 1,
    steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
  } as WorkflowDefinition;
  const ctx: WaysContext = {
    definition: { ok: AGENT_ONLY },
    enactor: { kind: 'observer' },
    store: { persistsClaims: true },
  };
  const heldOf = (entries: readonly Unavailable[], verb: string): Unavailable | undefined =>
    entries.find((u) => u.code === 'held_elsewhere' && u.verb === verb);

  it('held_elsewhere, the run_step entry of the ways: lease for a leased claim', async () => {
    const { port } = portOf(() => HELD);
    const snapshot = await snapshotWith(runWith({ a: claimOn('lease-1') }, ['a']), port);
    const entry = heldOf(composeWaysOn(snapshot, ctx).unavailable, 'run_step');
    // (a) red when this producer builds its facts without heldFacts (no lease); (b) prints the facts.
    expect(entry?.facts).toEqual({ step: 'a', deadline: { absent: 'unknown_age' }, lease: HELD });
  });

  it('held_elsewhere, the advance entry of the ways: lease for a leased claim', async () => {
    const { port } = portOf(() => HELD);
    const snapshot = await snapshotWith(runWith({ a: claimOn('lease-1') }, ['a']), port);
    const entry = heldOf(composeWaysOn(snapshot, ctx).unavailable, 'advance');
    // (a) red when this producer builds its facts without heldFacts (no lease); (b) prints the facts.
    expect(entry?.facts).toEqual({ step: 'a', deadline: { absent: 'unknown_age' }, lease: HELD });
  });

  it('held_elsewhere, the step judged by name: lease for a leased claim', async () => {
    const { port } = portOf(() => HELD);
    const snapshot = await snapshotWith(runWith({ a: claimOn('lease-1') }, ['a']), port);
    const admission = admitWay('run_step', snapshot, ctx, { run_id: 'r', command: 'a' });
    // (a) red when this producer builds its facts without heldFacts (no lease); (b) prints the
    //     admission.
    expect('code' in admission ? [admission.code, admission.facts] : admission).toEqual([
      'held_elsewhere',
      { step: 'a', deadline: { absent: 'unknown_age' }, lease: HELD },
    ]);
  });
});

describe('#729 CW-1b — an unleased claim’s results are exactly today’s', () => {
  it('classifyInProgressClaims, describeClaimHolder and the three held_elsewhere producers add no key for an unleased claim', () => {
    const record = runWith({ a: { deadline: FUTURE, token: 't', since: PAST } }, ['a']);
    const snapshot = writtenSnapshot(record, AT);
    const composed = composeWaysAt(record, AT, {
      definition: {
        id: 'w',
        name: 'w',
        version: 1,
        steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
      } as WorkflowDefinition,
      persistsClaims: true,
    });
    const byName = admitWay('run_step', snapshot, composedCtx(), { run_id: 'r', command: 'a' });
    const keys = (value: object | undefined) => Object.keys(value ?? {});
    // (a) red when a `lease` key is added unconditionally (the unleased answer `{ absent: 'unleased' }`
    //     then rides along); (b) prints the keys of each result.
    expect({
      info: classifyInProgressClaims(snapshot).map(keys),
      holder: keys(describeClaimHolder(record.claims!['a'], true, UNLEASED)),
      ways: composed.unavailable
        .filter((u) => u.code === 'held_elsewhere')
        .map((u) => keys(u.facts)),
      byName: 'facts' in byName ? keys(byName.facts) : 'admitted',
    }).toEqual({
      info: [['step', 'state', 'deadline']],
      holder: ['by', 'absent_cause', 'since'],
      ways: [
        ['step', 'deadline'],
        ['step', 'deadline'],
      ],
      byName: ['step', 'deadline'],
    });
  });
});

/** The ways context of an observer of the one-step agent workflow. */
function composedCtx(): WaysContext {
  return {
    definition: {
      ok: {
        id: 'w',
        name: 'w',
        version: 1,
        steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
      } as WorkflowDefinition,
    },
    enactor: { kind: 'observer' },
    store: { persistsClaims: true },
  };
}

describe('#729 CW-1b — a store written before CW-1b works unchanged', () => {
  it('a store with no leases, whose get returns a plain { record, at }, is admitted; an unleased claim reads unleased, a leased one not_checked', async () => {
    const record = runWith({ plain: { deadline: FUTURE }, leased: claimOn('lease-1') }, [
      'plain',
      'leased',
    ]);
    const nope = () => {
      throw new Error('not used here');
    };
    // A store as one written outside Realm before CW-1b is: no `leases`, and a `get` that returns a
    // plain object with the two fields (made without `writtenSnapshot`).
    const store = {
      persistsClaims: true,
      create: nope,
      update: nope,
      scan: nope,
      resolveKey: nope,
      tombstonesSince: nope,
      claimStep: nope,
      settleStep: nope,
      clock: { now: () => AT, at: () => AT },
      get: async () => Object.assign({}, { record }, { at: AT }),
    } as unknown as RunStore;
    declareReleaseLine(store);
    let admitted = 'admitted';
    try {
      admitEntry('executeStep', { store, storeKind: 'run store' });
    } catch (err) {
      admitted = (err as { code?: string }).code ?? String(err);
    }
    const read = await store.get('r');
    // (a) red when a field becomes required: admission refuses a store without `leases`, or the
    //     reader needs `lease_facts` (it then throws on this plain object); (b) prints the admission,
    //     each answer and each info.
    expect({
      admitted,
      plain: leaseFactOf(read, record.claims!['plain']),
      leased: leaseFactOf(read, record.claims!['leased']),
      info: classifyInProgressClaims(read),
    }).toEqual({
      admitted: 'admitted',
      plain: UNLEASED,
      leased: unknown('not_checked'),
      info: [
        { step: 'plain', state: 'healthy', deadline: FUTURE },
        {
          step: 'leased',
          state: 'claim_unknown_age',
          deadline: null,
          lease: unknown('not_checked'),
        },
      ],
    });
  });
});

/** Core's built folder: the files a copy of the lease-facts module is made from. */
const CORE_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');

type LeaseFactsModule = {
  leaseFactsOf: typeof leaseFactsOf;
  leaseFactOf: typeof leaseFactOf;
};

/**
 * Another loaded copy of core's lease-facts module, as a nested copy of `@sensigo/realm` is: its four
 * built files (the module, the lease port, the release mark and the version) in a folder of their
 * own, with `version` written into its version line (`VERSION` itself: a copy of this release).
 */
async function copyOfLeaseFacts(version: string, root: string): Promise<LeaseFactsModule> {
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
  return (await import(
    pathToFileURL(join(root, 'store', 'lease-facts.js')).href
  )) as LeaseFactsModule;
}

describe('#729 CW-1b correction 1 — copies of one release read each other’s lease facts', () => {
  it('a fact one copy of this release made is read by another; one another release made reads not_checked', async () => {
    const roots = [
      mkdtempSync(join(tmpdir(), 'realm-cw1b-same-')),
      mkdtempSync(join(tmpdir(), 'realm-cw1b-other-')),
    ];
    try {
      const same = await copyOfLeaseFacts(VERSION, roots[0]!);
      const other = await copyOfLeaseFacts(`${VERSION}-other`, roots[1]!);
      const { port } = portOf(() => NOT_HELD);
      const record = runWith({ a: claimOn('lease-1') }, ['a']);
      const claim = record.claims!['a'];
      const here = await snapshotWith(record, port);
      const fromSame = writtenSnapshot(record, AT, await same.leaseFactsOf(port, record));
      const fromOther = writtenSnapshot(record, AT, await other.leaseFactsOf(port, record));
      // (1) red when the reader trusts only the facts its own loaded copy made (a copy of the same
      //     release then reads not_checked), or trusts another release's facts (they then read
      //     not_held without this release's probe rules); (2) prints each answer.
      expect({
        sameReadHere: leaseFactOf(fromSame, claim),
        hereReadBySame: same.leaseFactOf(here, claim),
        otherReadHere: leaseFactOf(fromOther, claim),
        hereReadByOther: other.leaseFactOf(here, claim),
      }).toEqual({
        sameReadHere: NOT_HELD,
        hereReadBySame: NOT_HELD,
        otherReadHere: unknown('not_checked'),
        hereReadByOther: unknown('not_checked'),
      });
    } finally {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('#729 CW-1b correction 1 — a run whose claims are not an object', () => {
  it('claims null, a number or a string, or a record that throws when read: NO_LEASE_FACTS, no probe, never a rejection', async () => {
    const { port, probed } = portOf(() => HELD);
    const throwing = new Proxy(runWith({}, ['a']), {
      get(target, key, receiver) {
        if (key === 'claims') throw new Error('a record that throws when read');
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const records = [null, 5, 'text'].map((claims) => {
      const record = runWith({}, ['a']) as unknown as Record<string, unknown>;
      record['claims'] = claims;
      return record as unknown as RunRecord;
    });
    const outcomes = await Promise.all(
      [...records, throwing].map((record) =>
        leaseFactsOf(port, record).then(
          (facts) => (facts === NO_LEASE_FACTS ? 'none' : 'facts'),
          (err: unknown) => `rejected: ${String(err)}`,
        ),
      ),
    );
    // (1) red when a stored `claims` that is not an object, or a record that throws when read, makes
    //     the call reject (a store's get and scan then throw) or probe; (2) prints each outcome.
    expect({ outcomes, probed }).toEqual({
      outcomes: ['none', 'none', 'none', 'none'],
      probed: [],
    });
  });
});
