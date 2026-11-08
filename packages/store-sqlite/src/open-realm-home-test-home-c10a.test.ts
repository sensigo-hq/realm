// open-realm-home-test-home-c10a.test.ts — issue #616 PR-2c, unit c10a-0: a SQLite home opened on a
// test home (`createTestHome`, @sensigo/realm-testing). The real case: a CLI or MCP test, once its door
// is the SQLite store (c10a, c10b), opens a home on a test home's root to move the store's time; the
// legacy guard must not refuse it (a test location's `runs/` folder would be refused), the store's
// stamps must be the file's time, and `remove()` must leave the store the test made, which the test
// removes with the root. This cell lives here, beside `open-realm-home-616.test.ts`'s check 3, because
// the testing package cannot depend on the store package (store-sqlite dev-depends on testing).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHome } from '@sensigo/realm-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { openRealmHome } from './index.js';

const START = Date.parse('2034-07-08T09:10:11.012Z');
const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('#616 PR-2c c10a-0 — a SQLite home on a test home', () => {
  it('opens on a given root with no legacy refusal, stamps the moved time, and keeps its store after remove()', async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'realm-c10a0-store-')));
    scratches.push(scratch);
    const h = await createTestHome({ start: new Date(START), root: join(scratch, 'home') });
    let opened = 'opened';
    let stamped = 'no run';
    try {
      const home = await openRealmHome({ home: h.root });
      try {
        await h.clock.advance(3_600_000);
        const { record } = await home.runStore.create({
          workflowId: 'triage',
          workflowVersion: 1,
          params: {},
          extensionIdentity: [],
        });
        stamped = record.created_at;
      } finally {
        home.close();
      }
    } catch (err) {
      opened = `${(err as { code?: string }).code ?? (err as Error).name}: ${(err as Error).message}`;
    }
    await h.remove();
    // (1) red when the helper makes `runs/` (the open refuses STATE_HOME_HOLDS_LEGACY_STORE), when
    //     the store does not read the file's time (the stamp is the system's), or when remove() is
    //     recursive on a given root (`realm.db` and the fences gone); (2) prints the open's outcome,
    //     the run's stamp and what the root holds after remove().
    const after = existsSync(h.root) ? readdirSync(h.root).sort() : '(gone)';
    expect({ opened, stamped, after }).toEqual({
      opened: 'opened',
      stamped: new Date(START + 3_600_000).toISOString(),
      after: ['dedup', 'realm.db', 'replays', 'runs', 'workflows'],
    });
  });
});
