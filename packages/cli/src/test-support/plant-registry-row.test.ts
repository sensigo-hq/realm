// plant-registry-row.test.ts — issue #616 PR-2c, c10a-4a: the planting helper leaves the store as Realm
// made it. A child process (`realm mcp`) opens a planted home afresh, and every fresh open compares the
// schema text object by object, so a guard trigger the plant failed to put back refuses the whole home.
//
// Each assertion carries (a) the change that turns it red and (b) what it prints when it fails.
import { afterEach, describe, expect, it } from 'vitest';
import { openCliHome } from '../lib/home.js';
import { plantRegistryRow } from './plant-registry-row.js';
import { makeTempHome, type TempHome } from './temp-home.js';

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.cleanup();
});

describe('#616 PR-2c c10a-4a — plantRegistryRow', () => {
  it('a home planted while no handle is open opens afresh with no tamper refusal, and the planted copy reads as the pointer arm', async () => {
    const h = await makeTempHome();
    handles.push(h);
    // A cached handle runs no schema compare: only an open after this close does.
    await h.home.close();
    await plantRegistryRow(h.path, { id: 'planted', text: '{ not json' });

    const reopened = await openCliHome({ home: h.path }).then(
      (home) => ({ home, code: undefined }),
      (err: unknown) => ({ home: undefined, code: (err as { code?: unknown }).code }),
    );
    const refusal = await reopened.home?.workflowStore.get('planted').then(
      () => 'read',
      (err: unknown) => (err as Error).message,
    );
    await reopened.home?.close();
    // (a) red when the trigger is not re-created (the fresh open refuses
    //     `STATE_STORE_SCHEMA_TAMPERED`), or the text does not land where `get` reads it; (b) prints
    //     the open's refusal code and the read's refusal.
    expect({ openCode: reopened.code, refusal }).toEqual({
      openCode: undefined,
      refusal:
        "The registered copy of workflow 'planted' is missing from the store or is not JSON: something other than Realm changed the database. Register the workflow again from its source; if this message comes back, restore the database from a backup.",
    });
  });
});
