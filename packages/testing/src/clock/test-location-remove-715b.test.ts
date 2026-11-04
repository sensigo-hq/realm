// test-location-remove-715b.test.ts — issue #715 (b) 05 §B item 1 (#913's R2-1): what a test
// location's `remove()` does when the folders it made were changed under it. Its chain loop removes
// each folder the location made, deepest first, with a non-recursive `rmdir`: ENOENT or ENOTDIR → go
// on up; not empty, or any other error → stop, quietly. Real folders under the system temp folder.
//
// Each cell carries (a) the change that turns it red and (b) what it prints on failure (which paths
// exist after, relative to the cell's base, and whether `remove()` threw).
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestLocation } from './test-location.js';

const START = new Date('2032-02-02T02:02:02.000Z');

/**
 * Whether a folder of mode `0o555` denies an `rmdir` of its child on this machine — decided once, at
 * collection, by trying it (MA 3, Amendment 13 (3)). It does not as root (modes are not checked) or on
 * win32 (no POSIX modes): there cell (iii) is skipped, the reason in its title.
 */
const MODE_DENIES_RMDIR = ((): boolean => {
  if (process.platform === 'win32') return false;
  const probe = mkdtempSync(join(tmpdir(), 'realm-715b-mode-probe-'));
  try {
    mkdirSync(join(probe, 'p', 'c'), { recursive: true });
    chmodSync(join(probe, 'p'), 0o555);
    try {
      rmdirSync(join(probe, 'p', 'c'));
      return false;
    } catch {
      return true;
    } finally {
      chmodSync(join(probe, 'p'), 0o755);
    }
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
let base: string;
const restore: string[] = [];

afterEach(async () => {
  for (const dir of restore.splice(0)) await chmod(dir, 0o755).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

/** A location at `<base>/a/b/c`: the location makes `a`, `b` and `c` (and `runs/` in `c`). */
async function made(): Promise<{ remove: () => Promise<void> }> {
  base = await mkdtemp(join(tmpdir(), 'realm-715b-remove-'));
  return createTestLocation({ start: START, root: join(base, 'a', 'b', 'c') });
}

/** Whether `remove()` threw, and which of the given paths (relative to the base) exist after. */
async function removed(loc: { remove: () => Promise<void> }, paths: string[]) {
  let threw: string | undefined;
  try {
    await loc.remove();
  } catch (err) {
    threw = (err as NodeJS.ErrnoException).code ?? 'an error';
  }
  return { threw, exist: paths.filter((p) => existsSync(join(base, p))) };
}

describe('#715 (b) 05 §B (R2-1) — remove() when the folders it made were changed under it', () => {
  it('(i) a made folder already removed (ENOENT): remove() goes on up, removes the rest, and does not throw', async () => {
    // (a) red when ENOENT stops the loop (`a`, `a/b` left) or throws; (b) prints the paths and the throw.
    const loc = await made();
    await rm(join(base, 'a', 'b', 'c'), { recursive: true });
    expect(await removed(loc, ['a', 'a/b', 'a/b/c'])).toEqual({ threw: undefined, exist: [] });
  });

  it('(ii) a made folder that holds a file of someone else’s (not empty): remove() stops there quietly, and the file survives', async () => {
    // (a) red when a not-empty folder throws, or the loop removes past it; (b) prints the paths.
    const loc = await made();
    await writeFile(join(base, 'a', 'b', 'theirs.txt'), 'not the location’s');
    expect(await removed(loc, ['a', 'a/b', 'a/b/theirs.txt', 'a/b/c'])).toEqual({
      threw: undefined,
      exist: ['a', 'a/b', 'a/b/theirs.txt'],
    });
  });

  it.skipIf(!MODE_DENIES_RMDIR)(
    '(iii) a made parent that cannot be written (EACCES on its child’s rmdir): remove() stops quietly; the root’s clock file is gone (skipped where a 0o555 folder does not deny an rmdir: root, win32)',
    async () => {
      // `0o555`, not `000`: under `000` the clock file inside cannot be reached at all, and `rm` of
      // it throws before the loop (what R2-3's comment now says).
      // (a) red when any other error throws out of the loop; (b) prints the paths and the throw.
      const loc = await made();
      await chmod(join(base, 'a', 'b'), 0o555);
      restore.push(join(base, 'a', 'b'));
      expect(await removed(loc, ['a', 'a/b', 'a/b/c', 'a/b/c/.realm-test-clock'])).toEqual({
        threw: undefined,
        exist: ['a', 'a/b', 'a/b/c'],
      });
    },
  );

  it('(iv) a symlink stands where a made folder was (ENOTDIR): remove() does not throw, and the link’s target survives', async () => {
    // The root `c` moved into a folder of someone else's, and a link to it left in its place:
    // `remove()` clears the clock file through the link, `rmdir` of the link is ENOTDIR (go on up),
    // and `b` then holds the link, so the loop stops there. Going on or stopping after ENOTDIR end the
    // same: the parent then holds the link, so the next `rmdir` is ENOTEMPTY either way — the
    // "ENOTDIR stops" change cannot be seen by any test (MA 3, Amendment 13 (2)); the ENOENT half of
    // that change is seen by (i). (a) red when ENOTDIR throws; (b) prints the paths.
    const loc = await made();
    await mkdir(join(base, 'theirs'));
    await rename(join(base, 'a', 'b', 'c'), join(base, 'theirs', 'c'));
    await symlink(join(base, 'theirs', 'c'), join(base, 'a', 'b', 'c'));
    expect(
      await removed(loc, ['a', 'a/b', 'theirs', 'theirs/c', 'theirs/c/.realm-test-clock']),
    ).toEqual({
      threw: undefined,
      exist: ['a', 'a/b', 'theirs', 'theirs/c'],
    });
  });
});
