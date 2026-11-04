// test-clock-notice.ts — issue #715 (b) 02 §C.3 (D6-1, D6-53): a process that opens a store at a TEST
// LOCATION says so, ONCE, on its first read: `this store runs on a test clock, now <instant>`, the
// instant that read's reading. Core writes to no channel: the host hands the sink (the CLI and the
// MCP server pass their stderr line). A store whose clock is not a test location's — the system
// clock, a settable test clock built in-process, a host-built clock — is returned unchanged and says
// nothing.
import type { RunStore } from './store-interface.js';
import { isTestLocationClock } from './test-clock-file.js';

/** Whether this process (this loaded copy of core) has said the notice. */
let said = false;

/** The notice's words, for the reading `at` (ISO 8601, UTC). */
export function testClockNoticeLine(at: Date): string {
  return `this store runs on a test clock, now ${at.toISOString()}`;
}

/**
 * Returns `store` as it is, or — when its clock is a test location's — the same store whose first
 * `get`, `list` or `listWithDiagnostics` in this process hands `sink` the notice line with that
 * read's reading (a snapshot's `at`, a listing's `read_at`). Every other member passes through to the store, bound to it.
 */
export function withTestClockNotice<S extends RunStore>(store: S, sink: (line: string) => void): S {
  if (!isTestLocationClock(store.clock)) return store;
  const once = (at: Date): void => {
    if (said) return;
    said = true;
    try {
      sink(testClockNoticeLine(at));
    } catch {
      // A sink that throws never fails the read it reports.
    }
  };
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'get') {
        return async (runId: string) => {
          const snap = await target.get(runId);
          once(snap.at);
          return snap;
        };
      }
      if (prop === 'list') {
        return async (...args: Parameters<RunStore['list']>) => {
          const listing = await target.list(...args);
          once(listing.read_at);
          return listing;
        };
      }
      // A store's diagnostic listing (the file store's `listWithDiagnostics`, `realm run list`'s
      // read) is a read too: its one reading is its `read_at`.
      if (prop === 'listWithDiagnostics') {
        const read = Reflect.get(target, prop, target) as unknown;
        if (typeof read !== 'function') return read;
        return async (...args: unknown[]) => {
          const listing = (await (read as (...a: unknown[]) => Promise<{ read_at: Date }>).apply(
            target,
            args,
          )) as { read_at: Date };
          once(listing.read_at);
          return listing;
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
