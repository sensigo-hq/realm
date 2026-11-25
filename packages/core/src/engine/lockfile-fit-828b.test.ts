// lockfile-fit-828b.test.ts — #828 unit 1 PR B, check 10: `judgeProgramFit` compares the project's
// lockfile too (prompt feat-828-u1-fingerprint-before-load.md rev 3.1, behaviour item 5), one cell per
// row of the comparison table, plus a member missing on this program's side only. The carry-on
// check's own `differs` row is pinned elsewhere; this is the fit alone.
//
// Every assertion carries (1) the change that turns it red and (2) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import { judgeProgramFit } from './pending.js';
import type {
  ExtensionIdentityEntry,
  ExtensionIdentityLockfile,
} from '../types/extension-identity.js';
import type { RunRecord } from '../types/run-record.js';

/** An identity entry with the same code as every other here, and the given lockfile (or none). */
const entry = (lockfile?: ExtensionIdentityLockfile): ExtensionIdentityEntry => ({
  captured_at: 't',
  modules: [{ declared: 'x', resolved: '/x', entry_hash: 'h', format: 'esm' }],
  tree: {
    roots: ['/'],
    rules: 'r1',
    file_count: 1,
    total_bytes: 1,
    tree_hash: 'T',
    truncated: false,
  },
  coverage: 'dir_tree_v1',
  ...(lockfile !== undefined ? { lockfile } : {}),
});
/** A run whose last execution entry is `last`. */
const runWith = (last: ExtensionIdentityEntry): RunRecord =>
  ({ extension_identity: [entry(), last] }) as unknown as RunRecord;

const A: ExtensionIdentityLockfile = { files: ['package-lock.json'], sha256: 'a'.repeat(64) };
const B: ExtensionIdentityLockfile = { files: ['package-lock.json'], sha256: 'b'.repeat(64) };
const NONE: ExtensionIdentityLockfile = { absent: 'none_found' };
const UNREADABLE_F: ExtensionIdentityLockfile = {
  files: ['package-lock.json'],
  absent: 'unreadable',
};
const UNREADABLE_G: ExtensionIdentityLockfile = { files: ['yarn.lock'], absent: 'unreadable' };

describe('#828 PR B, check 10 — judgeProgramFit compares the lockfile, row by row', () => {
  const rows: Array<
    [string, ExtensionIdentityLockfile | undefined, ExtensionIdentityLockfile | undefined, string]
  > = [
    ['no member on either side (written before this unit): left out', undefined, undefined, 'same'],
    ['a member on the run only (this program has none): left out', A, undefined, 'same'],
    ["a member on this program only (the run's entry is older): left out", undefined, A, 'same'],
    ['sha256 A and A: same', A, A, 'same'],
    ['sha256 A and B: differs', A, B, 'differs'],
    ['none_found and none_found: same', NONE, NONE, 'same'],
    ['unreadable, the same files: same', UNREADABLE_F, UNREADABLE_F, 'same'],
    ['unreadable, other files: differs', UNREADABLE_F, UNREADABLE_G, 'differs'],
    ['sha256 and none_found: differs', A, NONE, 'differs'],
    ['none_found and unreadable: differs', NONE, UNREADABLE_F, 'differs'],
    ['unreadable and sha256: differs', UNREADABLE_F, A, 'differs'],
  ];
  for (const [label, recorded, current, fit] of rows) {
    it(label, () => {
      // (1) red when the lockfile is left out of the comparison (every `differs` row reads `same`), a
      //     missing member on either side is read as different, or two `none_found` read as
      //     different; (2) prints the fit.
      expect(judgeProgramFit(runWith(entry(recorded)), entry(current))).toBe(fit);
    });
  }
});
