// pathless-repair-616c5c.test.ts — #616 PR-2c c5c on the real SQLite registry: a damaged pointer (a
// workflow whose current version is missing, which only a writer that removed the file's guards can
// leave) carries its own way on in its refusal, so core's one composer adds no repair act after it —
// never a second remedy, never `rm` with an empty path. The refusal is this package's own
// (`damagedPointerError`, private to `workflow-store.ts`), so these cells live here; core's cells for
// the other pathless states are in `packages/core/src/workflow/pathless-repair-616c5c.test.ts`.
//
// The fixture is B3's (`workflow-store-616.test.ts`, the 11-series): `wf` registered, then its pointer
// moved by plain SQL, on a second connection that dropped the two pointer guards, to the hash of a
// text no version has.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWorkflowForRun,
  loadWorkflowFromString,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseLike } from './driver.js';
import { openRealmHome, type RealmHome } from './open-realm-home.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

/** The damaged-pointer refusal's words, written out (B3's "Words a user reads"). */
const DAMAGED_POINTER =
  "The registered copy of workflow 'wf' is missing from the store or is not JSON: something other " +
  'than Realm changed the database. Register the workflow again from its source; if this message ' +
  'comes back, restore the database from a backup.';

const dirs: string[] = [];
const homes: RealmHome[] = [];
const connections: DatabaseLike[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const h of homes.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A workflow as core's loader makes it. */
function workflow(id: string, steps: readonly string[]): WorkflowDefinition {
  return loadWorkflowFromString(
    `id: ${id}\nname: ${id}\nversion: 1\nsteps:\n` +
      steps
        .map(
          (s) => `  ${s}:\n    description: step ${s}\n    execution: agent\n    depends_on: []\n`,
        )
        .join(''),
  );
}

/** A home whose workflow `wf` points at a version that is not stored, and a live run of `wf`. */
async function pointerToMissingVersion(): Promise<{ home: RealmHome; run: RunRecord }> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-c5c-'));
  dirs.push(dir);
  const path = join(dir, '.realm');
  const home = await openRealmHome({ home: path });
  homes.push(home);
  await home.workflowStore.register(workflow('wf', ['a']));
  const { record: run } = await home.runStore.create({
    workflowId: 'wf',
    workflowVersion: 1,
    params: {},
  });
  const c = await openForeignConnection(path);
  connections.push(c);
  c.exec('DROP TRIGGER workflows_insert_own');
  c.exec('DROP TRIGGER workflows_update_own');
  const missing = createHash('sha256')
    .update(JSON.stringify(workflow('wf', ['x'])), 'utf8')
    .digest('hex');
  c.prepare('UPDATE workflows SET current_hash = ? WHERE id = ?').run(missing, 'wf');
  return { home, run };
}

describe('#616 PR-2c c5c — a damaged pointer on the SQLite registry gets no repair act after its own words', () => {
  it("getWorkflowForRun, a live run and a run at a live question: the pointer's own words, the way to end the run, and — at the question — what comes after registering; no 'To repair:', no 'rm'", async () => {
    const { home, run } = await pointerToMissingVersion();
    const atGate: RunRecord = {
      ...run,
      pending_gate: {
        gate_id: 'g1',
        step_name: 'a',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: run.created_at,
      },
    };
    const refused = async (r: RunRecord) => {
      const err = await getWorkflowForRun(home.workflowStore, r, {
        retryVerb: 'retry',
        verb: 'run',
      }).then(
        () => undefined,
        (e: unknown) => e as { code: string; message: string; details: Record<string, unknown> },
      );
      return {
        code: err?.code,
        message: err?.message,
        repair_command: err !== undefined && 'repair_command' in err.details,
      };
    };
    // (1) red when the composer appends a repair act after the pointer's own remedy (the `fault`
    //     condition removed, so the pointer gets the re-register act: "To repair: …, then retry"
    //     and, before c5c, "(rm ) instead"), or when the question's closing sentence is dropped;
    //     (2) prints each run's code, message and whether a repair command rides it.
    expect({ live: await refused(run), gate: await refused(atGate) }).toEqual({
      live: {
        code: 'RESOURCE_FORMAT_INVALID',
        message: `${DAMAGED_POINTER} To end the run: realm run abandon ${run.id}.`,
        repair_command: false,
      },
      gate: {
        code: 'RESOURCE_FORMAT_INVALID',
        message:
          `${DAMAGED_POINTER} This run is waiting on human gate 'a', which cannot be answered ` +
          'until its workflow can be read; realm run abandon refuses a run that is waiting on a ' +
          'gate. Once re-registered, answer the gate.',
        repair_command: false,
      },
    });
  });
});
