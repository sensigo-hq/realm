// plant-registry-row-616.test.ts — issue #616 PR-2c (c10a-4a's cell, moved here with the module by
// c10b-2b, DELTAS 58e): the planting helper leaves the store as Realm made it. A child process (`realm
// mcp`, `realm-mcp`) opens a planted home afresh, and every fresh open compares the schema text object
// by object, so a guard trigger the plant failed to put back refuses the whole home. The real cases: a
// plant on a workflow never registered (the listing's cell), and a plant on one a run already references
// (the run's copy damaged after it began).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openRealmHome, type RealmHome } from './open-realm-home.js';
import { plantRegistryRow } from './test-support/plant-registry-row.js';

const dirs: string[] = [];
const homes: RealmHome[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const GOOD: WorkflowDefinition = {
  id: 'good',
  name: 'Good',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { draft: { description: 'd', execution: 'agent' } },
};

describe('#616 PR-2c c10b-2b — plantRegistryRow', () => {
  it.each([
    ['a workflow never registered (the pointer inserted)', 'planted'],
    ['a workflow already registered (the pointer moved)', 'good'],
  ])(
    'planted while no handle is open, on %s: the home opens afresh with no tamper refusal, and the copy reads as the pointer arm',
    async (_case, id) => {
      const dir = mkdtempSync(join(tmpdir(), 'realm-616-plant-'));
      dirs.push(dir);
      const home = join(dir, 'home');
      const first = await openRealmHome({ home });
      await first.workflowStore.register(GOOD);
      // A cached handle runs no schema compare: only an open after this close does.
      first.close();
      await plantRegistryRow(home, { id, text: '{ not json' });

      const reopened = await openRealmHome({ home }).then(
        (opened) => ({ opened, code: undefined }),
        (err: unknown) => ({ opened: undefined, code: (err as { code?: unknown }).code }),
      );
      if (reopened.opened !== undefined) homes.push(reopened.opened);
      const refusal = await reopened.opened?.workflowStore.get(id).then(
        () => 'read',
        (err: unknown) => (err as Error).message,
      );
      // (1) red when the trigger is not re-created, or is re-created with other text (the fresh open
      //     refuses `STATE_STORE_SCHEMA_TAMPERED`), when an id already registered keeps its old pointer
      //     (`get` reads the good copy), or when the text does not land where `get` reads it; (2) prints
      //     the open's refusal code and the read's refusal.
      expect({ openCode: reopened.code, refusal }).toEqual({
        openCode: undefined,
        refusal: `The registered copy of workflow '${id}' is missing from the store or is not JSON: something other than Realm changed the database. Register the workflow again from its source; if this message comes back, restore the database from a backup.`,
      });
    },
  );
});
