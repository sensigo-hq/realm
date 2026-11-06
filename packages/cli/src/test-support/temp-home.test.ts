// temp-home.test.ts — issue #616 PR-2b, b1: the CLI's test helper `makeTempHome()` opens the CLI's
// own door on a temp folder, and the repo's vitest setup file starts every test file with HOME at a
// fresh temp folder. The helper's real case: a test seeds a run through the handle and drives a
// command in a child with `HOME: root`; the command must read the same folder. The guard's: a test
// file that forgets its HOME stub must never write into the developer's `~/.realm`.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { realmHomePath } from '@sensigo/realm';
import { createTestLocation, type TestLocation } from '@sensigo/realm-testing';
import { makeTempHome, type TempHome } from './temp-home.js';

const handles: TempHome[] = [];
const scratches: string[] = [];
const locations: TestLocation[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.cleanup();
  for (const l of locations.splice(0)) await l.remove();
  for (const s of scratches.splice(0)) rmSync(s, { recursive: true, force: true });
});
function scratch(): string {
  const s = mkdtempSync(join(tmpdir(), 'realm-temp-home-test-'));
  scratches.push(s);
  return s;
}

describe('#616 PR-2b b1 — makeTempHome()', () => {
  it('a fresh handle: root under the temp folder, the door on <root>/.realm, the runs a child with HOME: root opens', async () => {
    const h = await makeTempHome();
    handles.push(h);
    // (1) red when the door is opened on `root` instead of `<root>/.realm` (every path below loses
    //     its `.realm`), or the root is made elsewhere or named otherwise;
    // (2) prints the root's place and name, whether it exists, and the three paths.
    expect({
      underTmp: dirname(h.root) === tmpdir(),
      named: basename(h.root).startsWith('realm-temp-home-'),
      exists: existsSync(h.root),
      path: h.path,
      doorPath: h.home.path,
      runsDir: h.home.runStore.runsDirPath,
    }).toEqual({
      underTmp: true,
      named: true,
      exists: true,
      path: join(h.root, '.realm'),
      doorPath: join(h.root, '.realm'),
      runsDir: join(h.root, '.realm', 'runs'),
    });
  });

  it('a given .realm path: its parent is the root, the path as given, and nothing is created', async () => {
    const s = scratch();
    const given = join(s, '.realm');
    const h = await makeTempHome({ home: given });
    handles.push(h);
    // (1) red when `root` is undefined on every given path, or the helper or the door creates the
    //     folder at the open; (2) prints `root`, `path` and whether the folder exists.
    expect({ root: h.root, path: h.path, exists: existsSync(h.path) }).toEqual({
      root: s,
      path: given,
      exists: false,
    });
  });

  it('a test location by its own root: no root, the location’s runs, and its clock read at the open', async () => {
    const T = '2031-04-05T06:07:08.000Z';
    const location = await createTestLocation({ start: T, root: join(scratch(), 'loc') });
    locations.push(location);
    const h = await makeTempHome({ home: location.root });
    handles.push(h);
    const { record } = await h.home.runStore.create({
      workflowId: 'wf',
      workflowVersion: 1,
      params: {},
    });
    const { at } = await h.home.runStore.get(record.id);
    // (1) red when `root` is `dirname(home)` on every given path (a location's parent is no child's
    //     HOME), or the door opens another folder than the location's, or the run store runs on the
    //     real clock (a handle opened before the location's clock file existed);
    // (2) prints `root`, both runs folders and the snapshot's `at`.
    expect({
      root: h.root,
      path: h.path,
      runsDir: h.home.runStore.runsDirPath,
      at: at.toISOString(),
    }).toEqual({ root: undefined, path: location.root, runsDir: location.runsDir, at: T });
  });

  it('cleanup() removes the helper’s own root, and a second call resolves', async () => {
    const h = await makeTempHome();
    await h.cleanup();
    const second = await h.cleanup().then(
      () => 'resolved',
      (e: unknown) => `rejected: ${String(e)}`,
    );
    // (1) red when cleanup leaves the root (no removal), or a second call rejects;
    // (2) prints the root, whether it still exists, and how the second call ended.
    expect({ root: h.root, exists: existsSync(h.root), second }).toEqual({
      root: h.root,
      exists: false,
      second: 'resolved',
    });
  });

  it('cleanup() on a given home removes nothing', async () => {
    const given = join(scratch(), '.realm');
    mkdirSync(given);
    const h = await makeTempHome({ home: given });
    await h.cleanup();
    // (1) red when cleanup removes the folder (or its parent) on every handle, the helper's own or
    //     not; (2) prints the folder and whether it, and its parent, still exist.
    expect({ given, exists: existsSync(given), parent: existsSync(dirname(given)) }).toEqual({
      given,
      exists: true,
      parent: true,
    });
  });
});

describe('#616 PR-2b b1 — the HOME guard (scripts/vitest-pin-environment.mjs)', () => {
  it('this file started with HOME at a fresh temp folder of its own, which homedir() and realm read', () => {
    const home = process.env['HOME'] ?? '';
    // (1) red when the setup file's guard lines are deleted (HOME is then the machine's: the
    //     developer's, CI's or the run's own), or homedir() or realm reads another variable;
    // (2) prints HOME and what homedir() and realmHomePath() return.
    expect({
      home,
      underTmp: dirname(home) === tmpdir(),
      named: basename(home).startsWith('realm-vitest-home-'),
      exists: existsSync(home),
      homedir: homedir(),
      realmHome: realmHomePath(),
    }).toEqual({
      home,
      underTmp: true,
      named: true,
      exists: true,
      homedir: home,
      realmHome: join(home, '.realm'),
    });
  });
});
