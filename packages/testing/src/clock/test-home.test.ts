// test-home.test.ts — issue #616 PR-2c, unit c10a-0: `createTestHome`, the test home for the SQLite
// store. The real cases: a test that makes a home in a fresh folder, in a folder it names that does
// not exist yet, or in a folder that already holds its own files; a test that points it at the
// working directory, at an empty path, at a folder already holding a clock file, or gives an invalid
// start; and `remove()` after each, which must delete only what the call made. That a SQLite home
// opened on it reads the file's time, refuses nothing, and keeps its store after `remove()` is the
// store package's cell (`open-realm-home-test-home-c10a.test.ts`: this package cannot depend on the
// store's). The cells follow `test-location.test.ts`'s C14, (0)–(4) and R1-d, written for this
// function. Each assertion names (a) the change that turns it red and (b) what it prints: names
// relative to the scratch folder and instants, never a path under a real home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { TEST_CLOCK_FILE_NAME } from '@sensigo/realm';
import { createTestHome, type TestHome } from './test-home.js';

const T = Date.parse('2034-07-08T09:10:11.012Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** Every name under `dir`, relative to it, sorted; `(gone)` when `dir` does not exist. */
function namesUnder(dir: string): string[] {
  if (!existsSync(dir)) return ['(gone)'];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      out.push(relative(dir, path));
      if (statSync(path).isDirectory()) walk(path);
    }
  };
  walk(dir);
  return out.sort();
}

describe('#616 PR-2c c10a-0 — createTestHome: the three roots, and what remove() deletes in each', () => {
  const homes: TestHome[] = [];
  let scratch = '';
  beforeEach(async () => {
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'realm-c10a0-')));
  });
  afterEach(async () => {
    for (const h of homes.splice(0)) await h.remove();
    await rm(scratch, { recursive: true, force: true });
  });

  it('a fresh root holds the clock file and nothing else; its clock is the file; remove() deletes the folder', async () => {
    const h = await createTestHome({ start: new Date(T) });
    homes.push(h);
    const before = h.clock.now().toISOString();
    await h.clock.advance(3_600_000);
    const raw = JSON.parse(readFileSync(join(h.root, TEST_CLOCK_FILE_NAME), 'utf8')) as {
      instant: string;
    };
    // (a) red when the call makes `runs/` (or anything else) in the root, when the clock is not
    //     the file (now() is not the start; the advance does not write it); (b) prints the root's
    //     names, whether it is absolute and the instants.
    expect({
      names: namesUnder(h.root),
      absolute: isAbsolute(h.root),
      before,
      file: raw.instant,
    }).toEqual({
      names: ['.realm-test-clock'],
      absolute: true,
      before: iso(T),
      file: iso(T + 3_600_000),
    });
    await h.remove();
    // (a) red when remove() leaves the fresh folder; (b) prints what is left of it.
    expect(namesUnder(h.root), 'after remove()').toEqual(['(gone)']);
  });

  it('a given root that did not exist is made with the clock file only, and remove() deletes it and the folders made above it', async () => {
    const h = await createTestHome({ start: new Date(T), root: join(scratch, 'new', 'deep') });
    homes.push(h);
    // (a) red when the call makes `runs/`, or does not make the root; (b) prints the scratch names.
    expect(namesUnder(scratch), 'made').toEqual(['new', 'new/deep', 'new/deep/.realm-test-clock']);
    await h.remove();
    // (a) red when remove() leaves a folder it made; (b) prints the scratch names.
    expect(namesUnder(scratch), 'after remove()').toEqual([]);
  });

  it('a given root holding other files keeps them; only the clock file goes', async () => {
    const root = join(scratch, 'project');
    await mkdir(join(root, 'workflows'), { recursive: true });
    await writeFile(join(root, 'keep.txt'), 'mine');
    await writeFile(join(root, 'workflows', 'w.yaml'), 'id: w');
    const h = await createTestHome({ start: new Date(T), root });
    homes.push(h);
    await h.remove();
    // (a) red when remove() deletes the root (a recursive `rm`); (b) prints the names left.
    expect(namesUnder(root), 'after remove()').toEqual([
      'keep.txt',
      'workflows',
      'workflows/w.yaml',
    ]);
  });

  it('an omitted root with files written in it: the fresh folder goes whole', async () => {
    const h = await createTestHome({ start: new Date(T) });
    homes.push(h);
    await writeFile(join(h.root, 'extra.txt'), 'x');
    await mkdir(join(h.root, 'sub'));
    await writeFile(join(h.root, 'sub', 'more.txt'), 'y');
    await h.remove();
    // (a) red when the fresh folder stops being removed whole; (b) prints what is left in it.
    expect(namesUnder(h.root), 'after remove()').toEqual(['(gone)']);
  });
});

describe('#616 PR-2c c10a-0 — createTestHome refuses what createTestLocation refuses', () => {
  const home = process.cwd();
  let scratch = '';
  beforeEach(async () => {
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'realm-c10a0-refuse-')));
  });
  afterEach(async () => {
    process.chdir(home);
    await rm(scratch, { recursive: true, force: true });
  });

  it('an empty root, the working directory or a folder above it, a root holding a clock file, and an invalid start (before any folder is made)', async () => {
    const cwd = join(scratch, 'a', 'b');
    await mkdir(cwd, { recursive: true });
    process.chdir(cwd);
    const refused = async (root: string | undefined, start: Date | string): Promise<string> => {
      try {
        await createTestHome({ start, ...(root === undefined ? {} : { root }) });
        return 'made';
      } catch (err) {
        return `${(err as Error).name}: ${(err as Error).message.replace(scratch, '<dir>')}`;
      }
    };
    const taken = join(scratch, 'taken');
    await mkdir(taken);
    await writeFile(join(taken, TEST_CLOCK_FILE_NAME), '{}');
    const notYet = join(scratch, 'not-yet');
    // (a) red when a refusal is dropped, its sentence changes, or the start is checked after a
    //     folder is made (`not-yet` exists after the refusal); (b) prints each outcome and what the
    //     scratch folder holds after.
    expect({
      empty: await refused('', new Date(T)),
      cwd: await refused('.', new Date(T)),
      above: await refused(join(scratch, 'a'), new Date(T)),
      taken: await refused(taken, new Date(T)),
      start: await refused(notYet, 'not a time'),
      after: namesUnder(scratch),
    }).toEqual({
      empty: 'Error: a test location needs a root folder: the given root is empty',
      cwd: 'Error: <dir>/a/b is the working directory or a folder above it: a test location cannot be made there',
      above:
        'Error: <dir>/a is the working directory or a folder above it: a test location cannot be made there',
      taken: "Error: <dir>/taken already holds a test location's clock file",
      start: 'RangeError: a test location needs a valid start',
      after: ['a', 'a/b', 'taken', 'taken/.realm-test-clock'],
    });
  });
});
