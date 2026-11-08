// maintenance-migrate-616.test.ts — issue #616 PR-2c, unit c7: the maintenance handle's `migrate`
// (design §2 "Schema evolution", §3 "The re-stamp", §8 `realm db migrate`; DELTAS 41 and 42; SEAMS
// IA-2C6-11). The real cases: the first release that changes the schema, whose operator stops Realm,
// backs the store up and climbs the ladder one step at a time; a step that fails (its schema is not
// its version's, a write error after the step landed) and the second run that resumes; a store with
// nothing to climb; a Realm whose phase derivation changed, whose runs' stored phases must be
// stamped again from their records; a backup the verb must not get past; and the connection's gate,
// which must judge a file against the version the connection was opened under. Every cell works on
// real files through the loader, the versions above 1 through the open's seams.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowError, type CreateRunOptions } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { openRealmHome } from './index.js';
import { openHome } from './open-realm-home.js';
import { migrateSchema } from './schema-ladder.js';
import { openForeignConnection } from './test-support/foreign-connection.js';
import { ladder } from './test-support/schema-versions.js';

const RUN: CreateRunOptions = {
  workflowId: 'triage',
  workflowVersion: 1,
  params: {},
  extensionIdentity: [],
};

const dirs: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) {
    try {
      close();
    } catch {
      // closed by its cell
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-616-c7-'));
  dirs.push(dir);
  return dir;
}

/** A home with a store holding `runs` runs, made by the open and closed again; its ids. */
async function storeWithRuns(path: string, runs = 2): Promise<string[]> {
  const h = await openRealmHome({ home: path });
  const ids: string[] = [];
  for (let i = 0; i < runs; i++) ids.push((await h.runStore.create(RUN)).record.id);
  h.close();
  return ids;
}

/** Moves the home's store file to `version` of the synthetic ladder, from another connection. */
async function climbForeign(path: string, version: number): Promise<void> {
  const foreign = await openForeignConnection(path);
  try {
    migrateSchema(foreign, version, ladder());
  } finally {
    foreign.close();
  }
}

/** A rejection as a reader sees it: a typed refusal's code, message and details, or `resolved`. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof WorkflowError
      ? { code: err.code, message: err.message, details: err.details }
      : `${(err as Error).name}: ${(err as Error).message}`;
  }
}

/** `STATE_STORE_VERSION_NEWER` as the connection words it for a file at `file` under `realm`. */
function newer(file: number, realm: number): unknown {
  return {
    code: 'STATE_STORE_VERSION_NEWER',
    message:
      `This store was migrated by a newer Realm: its schema is version ${file} and this Realm ` +
      `writes version ${realm}. Upgrade Realm to read or write it.`,
    details: { file, realm },
  };
}

describe('#616 PR-2c c7 — the gate judges the file against the version the connection was opened under', () => {
  it('(G) SEAMS IA-2C6-11: a connection opened under version 2 writes a version-2 file, refuses it at version 3 naming both versions, and production still refuses the version-2 file at its open', async () => {
    const live = join(tmp(), '.realm');
    await storeWithRuns(live, 1);
    await climbForeign(live, 2);
    const production = await refusal(openRealmHome({ home: live }));
    const opening = openHome({ home: live }, { schemaVersion: 2, versions: ladder() });
    const openAtTwo = await refusal(opening);
    const atTwo = await opening.catch(() => undefined);
    if (atTwo !== undefined) closers.push(() => atTwo.close());
    const writeAtTwo =
      atTwo === undefined ? 'not opened' : await refusal(atTwo.runStore.create(RUN));
    await climbForeign(live, 3);
    const writeAtThree =
      atTwo === undefined ? 'not opened' : await refusal(atTwo.runStore.create(RUN));
    // (1) red when the gate compares with core's constant (the open's own reads refuse the version-2
    //     file under realm 2, "writes version 1"), when the open does not pass its version to the
    //     connection (the same), or when the refusal names the constant (version 3's refusal says 1);
    //     (2) prints each outcome: its code, message and details, `resolved`, or `not opened`.
    expect({ production, openAtTwo, writeAtTwo, writeAtThree }).toEqual({
      production: newer(2, 1),
      openAtTwo: 'resolved',
      writeAtTwo: 'resolved',
      writeAtThree: newer(3, 2),
    });
  });
});
