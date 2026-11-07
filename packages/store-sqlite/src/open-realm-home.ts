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
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { realmHomePath, resolveRootClock, type Clock } from '@sensigo/realm';
import { RealmDb } from './connection.js';
import type { OpenSeams } from './open-file.js';

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

/** An open Realm home. Later units add its stores. */
export interface RealmHome {
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
export async function openHome(
  options: OpenRealmHomeOptions,
  seams: OpenSeams,
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
    return shared.opening;
  }
  /** Lets go of this open in the cache, only while the cache still holds it (not a newer open). */
  const forget = (): void => {
    if (homes.get(key)?.opening === opening) homes.delete(key);
  };
  const opening = (async (): Promise<RealmHome> => {
    const clock = options.clock ?? resolveRootClock(home);
    const db = await RealmDb.open(home, { clock }, seams);
    let closed = false;
    return {
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
