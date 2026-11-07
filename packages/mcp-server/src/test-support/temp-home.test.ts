// temp-home.test.ts — issue #616 PR-2a, unit (ii-a); PR-2b, b3: the helper every test that builds the
// MCP server takes its stores from. The real case: a test that builds a store on the developer's real
// home writes runs into it (the library's defaults are the real `~/.realm`). The cell points HOME at a
// decoy folder, so a store built on the default home writes there and the cell sees it. b3's cells:
// a test seeds a run through the handle and drives a child with `HOME: root`, or opens the handle on a
// test location; the helper must open the folder the test names and remove only what it made.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadWorkflowFromString } from '@sensigo/realm';
import { createTestLocation, type TestLocation } from '@sensigo/realm-testing';
import { makeTempHome, type TempHome } from './temp-home.js';

const YAML = [
  'id: home616',
  'name: home616',
  'version: 1',
  'steps:',
  '  a:',
  '    description: A step.',
  '    execution: auto',
].join('\n');

let decoy: string;
let savedHome: string | undefined;
beforeEach(() => {
  decoy = mkdtempSync(join(tmpdir(), 'realm-temp-home-decoy-'));
  savedHome = process.env['HOME'];
  process.env['HOME'] = decoy;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(decoy, { recursive: true, force: true });
});

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

describe('#616 PR-2a (ii-a) — makeTempHome', () => {
  it('four stores on one fresh folder; cleanup() twice leaves nothing', async () => {
    const home = await makeTempHome();
    const { runStore, workflowStore, traceBufferStore, failedAttemptStore } = home.stores;
    const { record: run } = await runStore.create({
      workflowId: 'home616',
      workflowVersion: 1,
      params: {},
    });
    await workflowStore.register(loadWorkflowFromString(YAML));
    await failedAttemptStore.append(run.id, '{"attempt":1}');
    // The fenced append reads the run through the trace buffer's reader: it passes only when that
    // reader is this home's run store, which holds the run.
    await traceBufferStore.appendFenced(run.id, 'a', [{ event: 'e' }], {
      kind: 'run_at_version',
      version: run.version,
    });
    const runs = readdirSync(join(home.path, 'runs'));
    const wrote = {
      run: runs.includes(`${run.id}.json`),
      failedAttempt: runs.includes(`${run.id}.attempts.jsonl`),
      trace: runs.some((f) => f.startsWith(`trace-buffer-${run.id}-`)),
      workflow: readdirSync(join(home.path, 'workflows')).length > 0,
      decoyHasRealm: existsSync(join(decoy, '.realm')),
    };
    const folder = dirname(home.path);
    await home.cleanup();
    await home.cleanup();
    // (1) red when the helper builds one of its stores on another folder — the default home (the
    //     decoy then holds a `.realm`; the run, the record or the copy is missing here), or a trace
    //     buffer whose reader is another folder's run store (the fenced append refuses) — or when
    //     `cleanup()` leaves the folder or throws the second time;
    // (2) prints what each store left where, whether the decoy holds a `.realm`, and whether the
    //     temp folder is still there.
    expect({ ...wrote, leftAfterCleanup: existsSync(folder) }).toEqual({
      run: true,
      failedAttempt: true,
      trace: true,
      workflow: true,
      decoyHasRealm: false,
      leftAfterCleanup: false,
    });
  });
});

describe('#616 PR-2b b3 — makeTempHome(), the CLI helper’s shape', () => {
  it('a fresh handle: root under the temp folder, the opener on <root>/.realm, the runs a child with HOME: root opens', async () => {
    const h = await makeTempHome();
    handles.push(h);
    // (1) red when the opener is opened on `root` instead of `<root>/.realm` (every path below loses
    //     its `.realm`), or the root is made elsewhere or named otherwise;
    // (2) prints the root's place and name, whether it exists, and the two paths.
    expect({
      underTmp: dirname(h.root) === tmpdir(),
      named: basename(h.root).startsWith('realm-temp-home-'),
      exists: existsSync(h.root),
      path: h.path,
      runsDir: h.stores.runStore.runsDirPath,
    }).toEqual({
      underTmp: true,
      named: true,
      exists: true,
      path: join(h.root, '.realm'),
      runsDir: join(h.root, '.realm', 'runs'),
    });
  });

  it('a given .realm path: its parent is the root, the path as given, and only the registry’s folder is created', async () => {
    const s = scratch();
    const given = join(s, '.realm');
    const h = await makeTempHome({ home: given });
    handles.push(h);
    // (1) red when `root` is undefined on every given path, or the helper or the opener creates
    //     anything at the open but the registry's folder (this opener builds the registry there,
    //     unlike the CLI's door); (2) prints `root`, `path` and what the scratch folder and the
    //     given folder hold.
    expect({
      root: h.root,
      path: h.path,
      scratch: readdirSync(s),
      given: readdirSync(given),
    }).toEqual({
      root: s,
      path: given,
      scratch: ['.realm'],
      given: ['workflows'],
    });
  });

  it('a test location by its own root: no root, the location’s runs, and its clock read at the open', async () => {
    const T = '2031-04-05T06:07:08.000Z';
    const location = await createTestLocation({ start: T, root: join(scratch(), 'loc') });
    locations.push(location);
    const h = await makeTempHome({ home: location.root });
    handles.push(h);
    const { record } = await h.stores.runStore.create({
      workflowId: 'wf',
      workflowVersion: 1,
      params: {},
    });
    const { at } = await h.stores.runStore.get(record.id);
    // (1) red when `root` is `dirname(home)` on every given path (a location's parent is no child's
    //     HOME), or the opener opens another folder than the location's, or the run store runs on
    //     the real clock (a handle opened before the location's clock file existed);
    // (2) prints `root`, both runs folders and the snapshot's `at`.
    expect({
      root: h.root,
      path: h.path,
      runsDir: h.stores.runStore.runsDirPath,
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
    // (1) red when cleanup removes every root, the helper's own or not (a test location's handle,
    //     or a second handle on another handle's folder, would remove that folder under the test);
    // (2) prints the folder and whether it, and its registry's folder, still exist.
    expect({
      given,
      exists: existsSync(given),
      workflows: existsSync(join(given, 'workflows')),
    }).toEqual({
      given,
      exists: true,
      workflows: true,
    });
  });
});
