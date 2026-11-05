// home.test.ts — issue #616 PR-2a, unit (iii): the CLI's one door. Every store it opens sits under the
// one home it was given, and the home is read when a command opens it, never when the module loads.
// The real case is #188's mixed wiring: a command that built one of its stores on another folder (the
// default home, say) wrote records its other stores never read. Each cell points HOME at a decoy
// folder, so a store built on the default home writes there and the cell sees it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowFromString } from '@sensigo/realm';
import { openCliHome } from './home.js';

const YAML = [
  'id: door616',
  'name: door616',
  'version: 1',
  'steps:',
  '  a:',
  '    description: A step.',
  '    execution: auto',
].join('\n');

let scratch: string;
let decoy: string;
let savedHome: string | undefined;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'realm-door-616-'));
  decoy = mkdtempSync(join(tmpdir(), 'realm-door-616-decoy-'));
  savedHome = process.env['HOME'];
  process.env['HOME'] = decoy;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(scratch, { recursive: true, force: true });
  rmSync(decoy, { recursive: true, force: true });
});

describe('#616 PR-2a (iii) — openCliHome: one home for every store', () => {
  it('every store writes under the home it was given, and the registry folder appears only on first use', async () => {
    const path = join(scratch, '.realm');
    const home = await openCliHome({ home: path });
    const registryFolderAtOpen = existsSync(join(path, 'workflows'));

    const { record: run } = await home.runStore.create({
      workflowId: 'door616',
      workflowVersion: 1,
      params: {},
    });
    await home.workflowStore.register(loadWorkflowFromString(YAML));
    await home.failedAttemptStore.append(run.id, '{"attempt":1}');
    // The fenced append reads the run through the trace buffer's reader: it passes only when that
    // reader is THIS home's run store, which holds the run (a reader on another folder refuses).
    await home.traceBufferStore.appendFenced(run.id, 'a', [{ event: 'e' }], {
      kind: 'run_at_version',
      version: run.version,
    });
    const replay = await home.replayStore.save({
      origin_run_id: run.id,
      workflow_id: 'door616',
      overrides: [],
      results: [],
    });
    await home.dedupStoreFor('door616').record('delivery-1', 3_600_000);

    const runs = readdirSync(join(path, 'runs'));
    // (1) red when the door builds one of its stores on another folder — the default home (the
    //     decoy then holds a `.realm`), or a trace buffer whose reader is another folder's run store
    //     (the fenced append above refuses: the run is absent there) — or when the registry is built
    //     at the open (its folder exists before first use);
    // (2) prints what each store left where, and whether the decoy holds a `.realm`.
    expect({
      path: home.path,
      registryFolderAtOpen,
      run: runs.includes(`${run.id}.json`),
      failedAttempt: runs.includes(`${run.id}.attempts.jsonl`),
      trace: runs.some((f) => f.startsWith(`trace-buffer-${run.id}-`)),
      workflow: readdirSync(join(path, 'workflows')).length > 0,
      replay: existsSync(join(path, 'replays', `${replay.id}.json`)),
      dedup: existsSync(join(path, 'dedup', 'door616')),
      decoyHasRealm: existsSync(join(decoy, '.realm')),
    }).toEqual({
      path,
      registryFolderAtOpen: false,
      run: true,
      failedAttempt: true,
      trace: true,
      workflow: true,
      replay: true,
      dedup: true,
      decoyHasRealm: false,
    });
  });

  it('the default home is read at the open, not when the module loads', async () => {
    // This module was imported before HOME was set (in beforeEach, above); a home captured at load
    // would be the one in place then.
    process.env['HOME'] = scratch;
    const home = await openCliHome();
    const { record: run } = await home.runStore.create({
      workflowId: 'door616',
      workflowVersion: 1,
      params: {},
    });
    // (1) red when the door reads the home once, at module load (`homedir()` captured in a module
    //     constant): the run then lands under the home in place at import, not under this HOME;
    // (2) prints the home's path and whether the run file is under this HOME.
    expect({
      path: home.path,
      run: existsSync(join(scratch, '.realm', 'runs', `${run.id}.json`)),
    }).toEqual({ path: join(scratch, '.realm'), run: true });
  });
});
