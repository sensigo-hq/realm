// test-location.test.ts — issue #715 (a) Part C.2 (D6-1, D6-54): `createTestLocation`, and the reach
// of its clock into a SEPARATE process (cell C15). This file builds no JSON store in-process under
// fake timers. Each cell names (a) the change that turns it red and (b) what it prints when it fails:
// instants only — never an environment or a path under a real home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_CLOCK_FILE_NAME } from '@sensigo/realm';
import { createTestLocation, type TestLocation } from './test-location.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const T = Date.parse('2034-07-08T09:10:11.012Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const made: TestLocation[] = [];
afterEach(async () => {
  for (const loc of made.splice(0)) await loc.remove();
});

describe('#715 (a) C.2 — createTestLocation', () => {
  it('C14 the root holds runs/ and the clock file; advancing writes the file; a waiter sees its when; remove() deletes the folders and the clock file the location made; a second location on the root is refused', async () => {
    // (a) red when the file is not updated, or waiters see the end time; (b) prints instants.
    const loc = await createTestLocation({ start: new Date(T) });
    made.push(loc);
    expect(existsSync(loc.runsDir), 'runs/').toBe(true);
    expect(loc.runsDir, 'runsDir').toBe(join(loc.root, 'runs'));
    expect(existsSync(join(loc.root, TEST_CLOCK_FILE_NAME)), 'the clock file').toBe(true);
    expect(loc.clock.now().toISOString(), 'now() = start').toBe(iso(T));
    let seen = '';
    loc.clock.at(new Date(T + 1_800_000), () => {
      seen = loc.clock.now().toISOString();
    });
    await loc.clock.advance(3_600_000);
    const raw = JSON.parse(readFileSync(join(loc.root, TEST_CLOCK_FILE_NAME), 'utf8')) as {
      instant: string;
    };
    expect(raw.instant, 'the FILE after the advance').toBe(iso(T + 3_600_000));
    expect(seen, 'the waiter saw its when').toBe(iso(T + 1_800_000));
    await expect(createTestLocation({ start: new Date(T), root: loc.root })).rejects.toThrow(
      /already holds/,
    );
    await loc.remove();
    expect(existsSync(loc.root), 'removed').toBe(false);
  });

  it('C15 a spawned process reads the location’s time, and the time the test moved it to', async () => {
    // (a) red when a child stamps with the wall clock, or reads a cached file; (b) prints both
    // instants. The child imports the BUILT `@sensigo/realm` (tests run after the build).
    const loc = await createTestLocation({ start: new Date(T) });
    made.push(loc);
    const child = (): string => {
      const r = spawnSync(process.execPath, [join(HERE, 'test-location-child.mjs'), loc.runsDir], {
        encoding: 'utf8',
        timeout: 15_000,
      });
      return `${r.status}:${r.stdout.trim()}`;
    };
    const first = child();
    await loc.clock.advance(3_600_000);
    const second = child();
    expect([first, second], 'the two children’s created_at').toEqual([
      `0:${iso(T)}`,
      `0:${iso(T + 3_600_000)}`,
    ]);
  }, 20_000);
});

// =================================================================================================
// #715 (a) correction 1 (C-3): `remove()` deletes only what the location made. A root the caller gave
// that already holds other files keeps them (prompt 03 said "`remove()` deletes the root", and the
// helper did `rm(root, { recursive: true })`: data loss for a caller-given root). A given root is
// made absolute at creation, and an empty root, the working directory or a folder above it is
// refused (pytest's `validate_basetemp`; Rust tempfile #395). Each cell works inside its own scratch
// folder and prints the names that survived or went, relative to its root.
// =================================================================================================

/** The names under `dir`, recursively, relative to it and sorted; `['(gone)']` when it is gone. */
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

describe('#715 (a) correction 1 (C-3) — remove() deletes only what the location made', () => {
  const home = process.cwd();
  let scratch = '';
  beforeEach(async () => {
    scratch = realpathSync(await mkdtemp(join(tmpdir(), 'realm-c3-')));
  });
  afterEach(async () => {
    process.chdir(home);
    await rm(scratch, { recursive: true, force: true });
  });

  it('(0) an empty root, the working directory and a folder above it are refused; a relative root is made absolute, so remove() after a chdir removes the right folder', async () => {
    // (a) red when the root is not made absolute (`location.root` is relative and `remove()` after
    // the chdir deletes the decoy); (b) prints the names left in both folders.
    const cwd = join(scratch, 'a', 'b');
    const elsewhere = join(scratch, 'elsewhere');
    await mkdir(cwd, { recursive: true });
    await mkdir(join(elsewhere, 'rel'), { recursive: true });
    await writeFile(join(elsewhere, 'rel', 'keep.txt'), 'decoy');
    process.chdir(cwd);
    for (const root of ['', '.', cwd, '..', join(scratch, 'a')]) {
      await expect(
        createTestLocation({ start: new Date(T), root }),
        `root ${JSON.stringify(root.replace(scratch, '<dir>'))}`,
      ).rejects.toThrow(/empty|working directory/);
    }
    expect(namesUnder(join(scratch, 'a')), 'nothing was made above the cwd').toEqual(['b']);
    const loc = await createTestLocation({ start: new Date(T), root: 'rel' });
    expect(isAbsolute(loc.root), `root ${loc.root.replace(scratch, '<dir>')}`).toBe(true);
    process.chdir(elsewhere);
    await loc.remove();
    expect(
      { made: namesUnder(join(cwd, 'rel')), decoy: namesUnder(join(elsewhere, 'rel')) },
      'after remove()',
    ).toEqual({ made: ['(gone)'], decoy: ['keep.txt'] });
  });

  it('(1) a given root that did not exist is gone after remove(), with the folders made above it', async () => {
    // (a) red when remove() leaves a folder it made; (b) prints the names left in the scratch folder.
    const loc = await createTestLocation({
      start: new Date(T),
      root: join(scratch, 'new', 'deep'),
    });
    expect(namesUnder(scratch), 'made').toEqual([
      'new',
      'new/deep',
      'new/deep/.realm-test-clock',
      'new/deep/runs',
    ]);
    await loc.remove();
    expect(namesUnder(scratch), 'after remove()').toEqual([]);
  });

  it('(2) a given root holding other files keeps them; runs/ and the clock file go', async () => {
    // (a) red when remove() deletes the root (`rm(root, { recursive: true })`); (b) prints the names
    // left under the root.
    const root = join(scratch, 'project');
    await mkdir(join(root, 'workflows'), { recursive: true });
    await writeFile(join(root, 'keep.txt'), 'mine');
    await writeFile(join(root, 'workflows', 'w.yaml'), 'id: w');
    const loc = await createTestLocation({ start: new Date(T), root });
    await loc.remove();
    expect(namesUnder(root), 'after remove()').toEqual([
      'keep.txt',
      'workflows',
      'workflows/w.yaml',
    ]);
  });

  it('(3) a given root whose runs/ already existed keeps runs/ and its run file; only the clock file goes', async () => {
    // (a) red when remove() deletes a runs/ it did not make, or the root; (b) prints the names left.
    const root = join(scratch, 'state');
    await mkdir(join(root, 'runs'), { recursive: true });
    await writeFile(join(root, 'runs', 'r-1.json'), '{}');
    const loc = await createTestLocation({ start: new Date(T), root });
    expect(namesUnder(root), 'made').toEqual(['.realm-test-clock', 'runs', 'runs/r-1.json']);
    await loc.remove();
    expect(namesUnder(root), 'after remove()').toEqual(['runs', 'runs/r-1.json']);
  });

  it('(4) an omitted root: the temp folder is gone', async () => {
    // (a) red when remove() leaves the temp folder; (b) prints what is left in it.
    const loc = await createTestLocation({ start: new Date(T) });
    await loc.remove();
    expect(namesUnder(loc.root), 'after remove()').toEqual(['(gone)']);
  });
});
