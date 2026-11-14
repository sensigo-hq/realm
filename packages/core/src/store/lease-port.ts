// lease-port.ts — issue #729, the claim window, unit CW-1 (design record C5 §4.1): the claim lease's
// port. A claim lease is a lock the operating system keeps while the program holding it runs, and
// lets go of the moment that program ends, however it ends; any other program can ask, without
// waiting on the holder, whether it is held. Core declares the port, its answers and its closed
// reason lists; a store does the I/O behind it (R19: core stays I/O-free). Nothing in Realm takes a
// lease yet: later units of the claim window do (CW-2 writes a claim's lease, CW-5 holds one per drive).
import type { RunRecord } from '../types/run-record.js';

/** Why a store could not make a lease: a closed list, from the error the operating system or SQLite gave. */
export const LEASE_UNAVAILABLE_REASONS = [
  'permission',
  'no_space',
  'too_many_files',
  'io_error',
] as const;

export type LeaseUnavailableReason = (typeof LEASE_UNAVAILABLE_REASONS)[number];

/**
 * Why a probe could not say whether a lease is held: a closed list. `not_checked` is for a caller that
 * did not probe at all (from CW-1b); the store's probe answers the other four.
 */
export const LEASE_PROBE_REASONS = [
  'not_checked',
  'cannot_open',
  'not_a_lease',
  'permission',
  'io_error',
] as const;

export type LeaseProbeReason = (typeof LEASE_PROBE_REASONS)[number];

/** What a probe found. `unknown` always carries its reason; the other three never do. */
export type LeaseFact =
  | { readonly state: 'held' | 'not_held' | 'absent'; readonly basis: 'kernel_lock' }
  | { readonly state: 'unknown'; readonly basis: 'kernel_lock'; readonly reason: LeaseProbeReason };

/** A lease's state as a probe reports it. */
export type LeaseState = LeaseFact['state'];

/** A lease this program holds. */
export interface LeaseHold {
  /** The lease's id: what a claim records, and what `probe` takes. */
  readonly id: string;
  /**
   * Lets go of the lease. It never throws: each part that fails is skipped. It always ends the hold
   * (the lock is let go of). With `newestRecord`, the newest record the store returned to this
   * program: when no step's claim in it names this lease, the lease's file is deleted, and a probe
   * then reads `absent`; when a claim names it, the file stays, and reads `not_held`. With no record
   * (the caller's own release failed and returned none), the file stays. A second call does nothing.
   */
  close(newestRecord?: RunRecord): void;
}

/** What `hold()` answers: the lease, or why there is none. */
export type LeaseHoldResult =
  { readonly held: LeaseHold } | { readonly unavailable: LeaseUnavailableReason };

/**
 * A store's claim leases. Both functions answer and never reject; the port stamps no time.
 */
export interface LeasePort {
  /** Makes a lease that this program holds until it calls `close()` or ends. */
  hold(): Promise<LeaseHoldResult>;
  /**
   * Whether the lease `id` is held, and how that is known (`basis: 'kernel_lock'`). `held` and
   * `not_held` are facts; `absent` means no lease file with this id is there, which never proves
   * its holder ended: a file can be deleted while its holder runs; `unknown` gives its reason.
   * Only a write lock taken on a verified, writable lease file proves `not_held`.
   */
  probe(id: string): Promise<LeaseFact>;
}
