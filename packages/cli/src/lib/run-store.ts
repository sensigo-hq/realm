// run-store.ts — issue #715 (b) 02 §C.3 (D6-53): the run store a `realm` command opens — the file
// store under ~/.realm/runs — which, at a TEST LOCATION, says so once per process on stderr at its
// first read (`this store runs on a test clock, now <instant>`). Anywhere else it is the plain store.
import { JsonFileStore, withTestClockNotice } from '@sensigo/realm';

/** The store a command reads and writes runs in. */
export function openRunStore(): JsonFileStore {
  return withTestClockNotice(new JsonFileStore(), (line) => {
    process.stderr.write(`${line}\n`);
  });
}
