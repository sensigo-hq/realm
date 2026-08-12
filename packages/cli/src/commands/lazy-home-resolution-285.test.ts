// lazy-home-resolution-285.test.ts — issue #285 red-first regression pin: JsonFileReplayStore must
// resolve its default `replaysDir` at CONSTRUCTION time, never at module load. Companion core pin
// (JsonFileStore) lives at packages/core/src/store/lazy-home-resolution-285.test.ts.
//
// A static top-level import of the STORE ITSELF is safe here (unlike a command module's import of
// `@sensigo/realm`): `JsonFileReplayStore` (this relative path — the replay-store.test.ts:6
// precedent) has, post-fix, NO `homedir()` read at module scope at all — only inside its own
// constructor. This file lives in `commands/`, one level above `store/`, hence the `../store/...`
// relative path (matching every sibling `commands/*.test.ts` file's own relative-import depth).
//
// Read-only discrimination is NOT possible for this pin the way the core pin's `runsDirPath`
// getter allows — `JsonFileReplayStore` exposes no equivalent path getter, so the pin instead
// seeds a valid record directly onto disk (raw `fs`, never `save()` — see below) and asserts
// `get()` can find it under the fake home.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileReplayStore, type ReplayRecord } from '../store/replay-store.js';

describe('JsonFileReplayStore — construction-time home resolution (issue #285)', () => {
  it('resolves the default replaysDir under $HOME AT CONSTRUCTION TIME — red-first: this pin FAILS on the module-scope-capture code this PR removes', async () => {
    const originalHome = process.env['HOME'];
    const fakeHome = await mkdtemp(join(tmpdir(), 'realm-285-cli-pin-'));
    try {
      process.env['HOME'] = fakeHome;
      const replaysDir = join(fakeHome, '.realm', 'replays');
      await mkdir(replaysDir, { recursive: true });

      // Seed a valid replay record DIRECTLY via raw fs — NEVER via store.save(): on the UNFIXED
      // (module-scope-capture) code, a red-first run of a save()-based pin would silently write
      // into the REAL `~/.realm/replays` (this file's module was already imported — and its
      // DEFAULT_REPLAYS_DIR already frozen to the real $HOME — long before this test body's own
      // $HOME override could ever take effect). Seeding by raw fs against the FAKE home's own
      // resolved path sidesteps that: it exercises ONLY the read side (`get()`), never a write
      // through the store's own (possibly-frozen-wrong) default.
      const record: ReplayRecord = {
        id: 'rpl_pin',
        origin_run_id: 'run-pin',
        workflow_id: 'wf-pin',
        overrides: [],
        results: [],
        created_at: '2026-01-01T00:00:00.000Z',
      };
      await writeFile(join(replaysDir, 'rpl_pin.json'), JSON.stringify(record, null, 2), 'utf8');

      const store = new JsonFileReplayStore();
      const got = await store.get('rpl_pin');
      expect(got.id).toBe('rpl_pin');
      expect(got.origin_run_id).toBe('run-pin');
    } finally {
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      await rm(fakeHome, { recursive: true, force: true });
    }
  });
});
