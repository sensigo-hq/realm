// temp-home.test.ts — issue #616 PR-2a, unit (ii-a): the helper every test that builds the MCP server
// takes its stores from. The real case: a test that builds a store on the developer's real home
// writes runs into it (the library's defaults are the real `~/.realm`). The cell points HOME at a
// decoy folder, so a store built on the default home writes there and the cell sees it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadWorkflowFromString } from '@sensigo/realm';
import { makeTempHome } from './temp-home.js';

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
    home.cleanup();
    home.cleanup();
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
