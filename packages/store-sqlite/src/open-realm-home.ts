// open-realm-home.ts — issue #616 PR-1a unit 11 (design d4-frozen-r3 §2 "One connection per process
// per home", §7; SEAMS S5 and S8): `openRealmHome`, the one place a caller opens a Realm home. The
// package's entry exports it with its option and result types; everything else here is internal.
//
// One connection per home per process: the open homes are cached by the home's real path (for a home
// that does not exist yet, the real path of its nearest existing folder plus the rest), and a pending
// open is shared, so concurrent first callers share one open and later callers share the file. A
// failed open is not cached. The home's clock is the caller's `clock`, or by default the home's own
// test clock file (`<home>/.realm-test-clock`, read by core's root reader; the one call site the
// test-clock lint and scan admit) or the system clock. A caller that brings another clock than the
// one the home is open with is refused (MA 3's ruling, SEAMS "unit 11"): sharing would silently keep
// stamping from the first clock. The home's path comes from core's resolver alone; this package never
// asks the system for the user's home.
//
// Every refusal is a rejected promise, never a synchronous throw: the resolver's, the clock file's,
// this module's own, and the open's (the loader, the filesystem gate, the old-store guard, the file's
// checks), which pass through unchanged.
//
// The handle carries the home's run store (unit 12a), its duplicate-webhook memory (B8), its workflow
// registry (B3), its failed-attempt store and replay store (B7), and `close()`.
// A caller that shares an open home checks, once the open has resolved, that the cache still holds it:
// a `close()` while the caller waited (MA 2, #998) removed it and closed the connection, so the caller
// looks the home up once more and opens it afresh instead of receiving a closed handle.
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  realmHomePath,
  resolveRootClock,
  type Clock,
  type DedupStore,
  type WorkflowRegistrar,
} from '@sensigo/realm';
import { RealmDb } from './connection.js';
import { SqliteDedupStore } from './dedup-store.js';
import { SqliteFailedAttemptStore } from './failed-attempt-store.js';
import type { OpenSeams } from './open-file.js';
import { SqliteReplayStore } from './replay-store.js';
import { SqliteRunStore } from './run-store.js';
import { SqliteWorkflowStore } from './workflow-store.js';

/** What `openRealmHome` takes. */
export interface OpenRealmHomeOptions {
  /** The Realm home, an absolute path; `~/.realm` (core's resolver) when left out. */
  readonly home?: string;
  /**
   * The home's clock. By default the home's own test clock file when it has one, otherwise the system
   * clock. A home already open in this process is shared only with a caller that passes no clock or
   * the very clock it was opened with.
   */
  readonly clock?: Clock;
}

/**
 * An open Realm home: its run store, its duplicate-webhook memory, its workflow registry, its
 * failed-attempt store, its replay store and `close()`, all on the home's one connection. Later units
 * add its other stores.
 */
export interface RealmHome {
  /** The home's run store: creates, reads and lists its runs. */
  readonly runStore: SqliteRunStore;
  /**
   * The duplicate-webhook memory of one workflow (`realm listen`'s): one instance per workflow id, on
   * the home's one connection. After `close()`, its calls reject.
   */
  dedupStoreFor(workflowId: string): DedupStore;
  /**
   * The workflow registry (PR-1b B3): each distinct definition text once, a pointer per workflow to
   * its current text, and every move of that pointer. After `close()`, its calls reject.
   */
  readonly workflowStore: WorkflowRegistrar;
  /** The home's failed agent attempts, kept per run (PR-1b B7). */
  readonly failedAttemptStore: SqliteFailedAttemptStore;
  /** The home's saved replays, by id (PR-1b B7). */
  readonly replayStore: SqliteReplayStore;
  /**
   * Closes the home's connection; a later `openRealmHome` opens the home afresh. Every caller in this
   * process that opened the home shares this handle, so a `close()` by any of them ends it for all.
   * A second `close()` does nothing.
   */
  close(): void;
}

/** A home open in this process, or being opened. */
interface OpenHome {
  readonly opening: Promise<RealmHome>;
  /** The clock its first caller passed; `undefined` when the home runs on its default clock. */
  readonly clock: Clock | undefined;
}

/** The homes open in this process, by real path. */
const homes = new Map<string, OpenHome>();

/**
 * The real path of `home`: the system's answer for the home, or, for a home that does not exist yet,
 * for its nearest existing folder above, with the rest of the path joined to it. Only the cache uses
 * it; the open judges the path itself.
 */
function realKey(home: string): string {
  const rest: string[] = [];
  let at = resolve(home);
  for (;;) {
    try {
      return join(realpathSync.native(at), ...rest);
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(home);
      rest.unshift(basename(at));
      at = up;
    }
  }
}

/**
 * Opens the Realm home (see the module comment) and resolves to its handle, shared with every other
 * caller in this process that opens the same home.
 */
export function openRealmHome(options: OpenRealmHomeOptions = {}): Promise<RealmHome> {
  return openHome(options, {});
}

/**
 * `openRealmHome` with the open's seams (package-internal: the package's entry does not export it).
 * A home opened through seams is cached like any other.
 */
export function openHome(options: OpenRealmHomeOptions, seams: OpenSeams): Promise<RealmHome> {
  return lookUp(options, seams, true);
}

/**
 * The cache's lookup, then the open. A caller that shares an open home gets its handle only while the
 * cache still holds that open once it has resolved (`close()` removes its own entry); otherwise, when
 * `again` is true, it looks the home up once more.
 */
async function lookUp(
  options: OpenRealmHomeOptions,
  seams: OpenSeams,
  again: boolean,
): Promise<RealmHome> {
  const home = realmHomePath(options.home);
  const key = realKey(home);
  const shared = homes.get(key);
  if (shared !== undefined) {
    if (options.clock !== undefined && options.clock !== shared.clock) {
      throw new Error(
        `The Realm home ${home} is already open in this process with another clock; close it first.`,
      );
    }
    const handle = await shared.opening;
    // Closed while this caller waited: the cache no longer holds the open.
    if (again && homes.get(key)?.opening !== shared.opening) return lookUp(options, seams, false);
    return handle;
  }
  /** Lets go of this open in the cache, only while the cache still holds it (not a newer open). */
  const forget = (): void => {
    if (homes.get(key)?.opening === opening) homes.delete(key);
  };
  const opening = (async (): Promise<RealmHome> => {
    const clock = options.clock ?? resolveRootClock(home);
    const db = await RealmDb.open(home, { clock }, seams);
    let closed = false;
    const dedupStores = new Map<string, DedupStore>();
    return {
      runStore: new SqliteRunStore(db),
      dedupStoreFor(workflowId: string): DedupStore {
        let store = dedupStores.get(workflowId);
        if (store === undefined) {
          store = new SqliteDedupStore(db, workflowId);
          dedupStores.set(workflowId, store);
        }
        return store;
      },
      workflowStore: new SqliteWorkflowStore(db),
      failedAttemptStore: new SqliteFailedAttemptStore(db),
      replayStore: new SqliteReplayStore(db),
      close(): void {
        if (closed) return;
        closed = true;
        forget();
        db.close();
      },
    };
  })();
  homes.set(key, { opening, clock: options.clock });
  // A failed open is not cached: the next call opens again.
  opening.catch(forget);
  return opening;
}
