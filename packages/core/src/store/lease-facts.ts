// lease-facts.ts — issue #729, the claim window, unit CW-1b part 1 (design record C5 §4.2, with the
// prompt's departures for the owner's compatibility policy e531209a): what a store with a lease port
// found about the leases of a run's in-progress claims, observed after the read or write that returned
// the run, and the ONE reader of it.
//
// A fact is never invented. `LeaseFacts` is made only here: by `leaseFactsOf`, which asks the store's
// lease port, and as the empty `NO_LEASE_FACTS`. This module is the one place in Realm that calls a
// lease port's `probe` (the source witness `lease-facts-witness-cw1b.test.ts` holds it). The reader
// reads only facts a copy of this release made: each carries its maker's release mark (brand.ts), so
// copies of one release read each other's facts, as copies of one version work together, and a store
// that builds its own object, a copy of a snapshot (`structuredClone`, a spread, JSON) or another
// release's facts read `unknown('not_checked')`: never `not_held`. Core stays I/O-free (R19): the
// port does the I/O.
//
// Nothing writes a claim's lease yet (CW-2 will), so today every claim reads `unleased` and every
// store returns no facts: nothing anyone sees changes.
import type { ClaimRecord, RunRecord } from '../types/run-record.js';
import type { Snapshot } from '../engine/snapshot.js';
import { brandClass, REALM_BRAND } from '../brand.js';
import {
  LEASE_PROBE_REASONS,
  type LeaseFact,
  type LeasePort,
  type LeaseProbeReason,
} from './lease-port.js';

/**
 * The facts about the leases of a run's in-progress claims, by lease id. Frozen, with no prototype,
 * and read only with `Object.hasOwn` (through {@link leaseFactOf}), so an inherited name such as
 * `constructor` is never a fact. Made only by {@link leaseFactsOf} and {@link NO_LEASE_FACTS}.
 *
 * The brand is a key no object has (`never`), so a plain object is not a `LeaseFacts` without a cast;
 * it is a string key, not a `unique symbol`, so the type is the same in the built package as in its
 * source (a store type-checked against one and used against the other). What makes the rule hold at
 * run time is the reader: it reads only objects that carry the release mark of a copy of this release
 * ({@link LeaseFactsClass}).
 */
export type LeaseFacts = { readonly [leaseId: string]: LeaseFact } & {
  readonly '#LeaseFacts': never;
};

/** What {@link leaseFactOf} answers for a claim that names no lease. */
export type Unleased = { readonly absent: 'unleased' };

const BASIS = 'kernel_lock';
const UNLEASED: Unleased = Object.freeze({ absent: 'unleased' });

/**
 * The key a facts object carries its maker's release mark under: one key for every copy of
 * `@sensigo/realm`, as every realm class's own key is (brand.ts).
 */
const LEASE_FACTS_KEY: symbol = Symbol.for('@sensigo/realm/LeaseFacts');

/**
 * What a lease-facts object answers to: `facts instanceof LeaseFactsClass` is true for facts any copy
 * of this release of `@sensigo/realm` made (the release mark's generation rule, brand.ts: copies of
 * one release share a generation), and false for another release's facts, a copy (`structuredClone`,
 * a spread, JSON) or an object a store built. It is never constructed: a facts object has no
 * prototype and carries the mark itself, under the class's key. A test contract names another
 * release's facts with `describeUnrecognised(facts, LeaseFactsClass)`.
 */
export const LeaseFactsClass: abstract new () => object = class LeaseFacts {};
brandClass(LeaseFactsClass, LEASE_FACTS_KEY, REALM_BRAND);

/** Whether `facts` was made by a copy of this release: it carries the mark ({@link LeaseFactsClass}). */
function madeByThisRelease(facts: object): boolean {
  try {
    return facts instanceof LeaseFactsClass;
  } catch {
    // A value that throws when checked (a revoked proxy) is no facts this release made.
    return false;
  }
}

function made(entries: ReadonlyArray<readonly [string, LeaseFact]>): LeaseFacts {
  const facts: Record<string, LeaseFact> = Object.create(null) as Record<string, LeaseFact>;
  // Each id is defined as an own property (never assigned), so no id, `__proto__` included, can
  // reach a setter: the object has no prototype, and a define never calls one.
  for (const [id, fact] of entries) {
    Object.defineProperty(facts, id, { value: fact, enumerable: true });
  }
  // The maker's release mark, under a symbol: no lease id (a string) can be it, it is not
  // enumerable, and a copy of the object (a spread, `structuredClone`, JSON) leaves it behind.
  Object.defineProperty(facts, LEASE_FACTS_KEY, {
    value: REALM_BRAND,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(facts) as LeaseFacts;
}

/** The facts about no lease: what a store with no lease port, or a run with no leased claim, has. */
export const NO_LEASE_FACTS: LeaseFacts = made([]);

function unknown(reason: LeaseProbeReason): LeaseFact {
  return Object.freeze({ state: 'unknown', basis: BASIS, reason });
}

/** The lease id a stored claim names, or `undefined` when it names none or its lease is malformed. */
function leaseIdOf(claim: ClaimRecord | undefined): string | undefined {
  const lease: unknown = claim?.lease;
  if (typeof lease !== 'object' || lease === null) return undefined;
  const { id } = lease as { id?: unknown };
  return typeof id === 'string' ? id : undefined;
}

/** A frozen copy of `answer` when it is a {@link LeaseFact}, else `undefined`. */
function factFrom(answer: unknown): LeaseFact | undefined {
  if (typeof answer !== 'object' || answer === null) return undefined;
  const { state, basis, reason } = answer as { state?: unknown; basis?: unknown; reason?: unknown };
  if (basis !== BASIS) return undefined;
  if (state === 'held' || state === 'not_held' || state === 'absent') {
    return reason === undefined ? Object.freeze({ state, basis: BASIS }) : undefined;
  }
  if (state === 'unknown' && (LEASE_PROBE_REASONS as readonly unknown[]).includes(reason)) {
    return unknown(reason as LeaseProbeReason);
  }
  return undefined;
}

/** One probe: a rejection, a throw, or an answer that is not a fact gives `unknown('io_error')`. */
async function probeOnce(port: LeasePort, id: string): Promise<LeaseFact> {
  try {
    return factFrom(await port.probe(id)) ?? unknown('io_error');
  } catch {
    return unknown('io_error');
  }
}

/**
 * What the lease port `port` finds about the leases of `record`'s in-progress claims: one probe per
 * distinct lease id, and nothing else. A store calls it after the read or write that returned the
 * run, outside its write transaction and its lock.
 *
 * - No port (absent or `null`) ⇒ {@link NO_LEASE_FACTS}, and no claim is read.
 * - A run whose stored `claims` is `null`, or anything but an object, has no claims; any error while
 *   the lease ids are collected (a record that throws when read) gives {@link NO_LEASE_FACTS}, so its
 *   claims read `not_checked`, never `not_held`.
 * - A claim whose stored `lease` is `null`, not an object, or has no string `id` is skipped: no probe,
 *   no entry ({@link leaseFactOf} answers `not_a_lease` for it from the claim itself).
 * - A probe that rejects or throws, or answers something that is not a `LeaseFact`, gives
 *   `unknown('io_error')` for that id. The returned promise never rejects.
 * - No in-progress claim names a lease ⇒ {@link NO_LEASE_FACTS}, with no probe.
 */
export async function leaseFactsOf(
  port: LeasePort | null | undefined,
  record: RunRecord,
): Promise<LeaseFacts> {
  if (port === undefined || port === null) return NO_LEASE_FACTS;
  let ids: string[];
  try {
    ids = leasedIdsOf(record);
  } catch {
    return NO_LEASE_FACTS;
  }
  if (ids.length === 0) return NO_LEASE_FACTS;
  const facts = await Promise.all(ids.map((id) => probeOnce(port, id)));
  return made(ids.map((id, i) => [id, facts[i]!] as const));
}

/** The distinct lease ids `record`'s in-progress claims name, in the order the steps list them. */
function leasedIdsOf(record: RunRecord): string[] {
  const claims: unknown = record.claims;
  // A stored `claims` that is `null`, or anything but an object (an imported record): no claims.
  if (typeof claims !== 'object' || claims === null) return [];
  const steps: readonly unknown[] = Array.isArray(record.in_progress_steps)
    ? record.in_progress_steps
    : [];
  const ids: string[] = [];
  for (const step of steps) {
    if (typeof step !== 'string' || !Object.hasOwn(claims, step)) continue;
    const id = leaseIdOf((claims as Record<string, ClaimRecord | undefined>)[step]);
    if (id !== undefined && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The ONE reader of a claim's lease fact, on the snapshot the claim was read from:
 *
 * - a claim that names no lease (no claim, or no `lease`) ⇒ `{ absent: 'unleased' }`;
 * - a claim whose stored `lease` is malformed (`null`, not an object, no string `id`) ⇒
 *   `unknown('not_a_lease')`;
 * - a lease the snapshot carries a fact for ⇒ that fact;
 * - a lease it carries none for (a store without leases holding a record saved by one with leases, a
 *   snapshot built without facts, a copy of one, or facts another release made) ⇒
 *   `unknown('not_checked')`.
 *
 * `not_held` comes only from a probe.
 */
export function leaseFactOf(
  snapshot: Pick<Snapshot, 'lease_facts'>,
  claim: ClaimRecord | undefined,
): LeaseFact | Unleased {
  if (claim === undefined || claim === null || claim.lease === undefined) return UNLEASED;
  const id = leaseIdOf(claim);
  if (id === undefined) return unknown('not_a_lease');
  const facts = snapshot.lease_facts;
  if (facts !== undefined && madeByThisRelease(facts) && Object.hasOwn(facts, id))
    return facts[id]!;
  return unknown('not_checked');
}

/** Whether a reader's answer is a fact (not `{ absent: 'unleased' }`). */
export function isLeaseFact(value: LeaseFact | Unleased): value is LeaseFact {
  return !('absent' in value);
}
