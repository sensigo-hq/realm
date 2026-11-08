// store-test-support-616.test.ts — issue #616 PR-2c c9a (DELTAS row 49): a CLI test reaches a second,
// raw connection on a home's `realm.db` through the store package's `./test-support` entry, the one
// lawful way (the store's one-loader law refuses any other file that loads the built-in). The real
// case: the CLI's SQLite cells (c7's `db migrate` cells; c10a, c10b and c11 later) plant states the
// store never writes, by SQL on their own connection beside the store. This cell is the one they can
// cite for "the helper works from the CLI package"; what a held lock does to the store is the store's
// own cells' (`connection.test.ts`), not this one's. The entry's surface and the tarball are pinned in
// the store package and in `../store-sqlite-package-616.test.ts`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRealmHome } from '@sensigo/realm-store-sqlite';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { afterEach, describe, expect, it } from 'vitest';

/** The connection's type, as a consumer writes it: the entry exports the function and no type. */
type ForeignConnection = Awaited<ReturnType<typeof openForeignConnection>>;

let home: string | undefined;

afterEach(() => {
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe('#616 PR-2c c9a — the store test support from the CLI package', () => {
  it("a home opened through the store's entry, a run written and the handle closed: openForeignConnection, imported by the package's ./test-support subpath, reads that run's row by SQL", async () => {
    home = mkdtempSync(join(tmpdir(), 'realm-616-c9a-'));
    const handle = await openRealmHome({ home });
    const { record } = await handle.runStore.create({
      workflowId: 'triage',
      workflowVersion: 1,
      params: {},
      extensionIdentity: [],
    });
    handle.close();
    const connection: ForeignConnection = await openForeignConnection(home);
    let ids: unknown[];
    try {
      ids = connection
        .prepare('SELECT id FROM runs')
        .all()
        .map((row) => row['id']);
    } finally {
      connection.close();
    }
    // (1) red when the store package no longer exports `./test-support` (the import fails and the
    //     file does not load), and when the helper opens some other file than the home's `realm.db`
    //     (it reads no run); (2) prints the run ids the connection read against the one written.
    expect({ ids }).toEqual({ ids: [record.id] });
  });
});
