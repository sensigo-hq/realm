// Tests for JsonTraceBufferStore — focused on deleteAllForRun and its dirEntries wiring (issue
// #107). append/read/delete are exercised indirectly elsewhere (execution-loop finalization); this
// file did not previously have dedicated coverage, so a handful of sanity tests are included too.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonTraceBufferStore } from './json-trace-buffer-store.js';

describe('JsonTraceBufferStore', () => {
  let dir: string;
  let store: JsonTraceBufferStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'jtbs-'));
    store = new JsonTraceBufferStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('append + read round-trips entries', async () => {
    await store.append('run-1', 'step-1', [{ event: 'evt', data: { k: 'v' } }]);
    const entries = await store.read('run-1', 'step-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.event).toBe('evt');
  });

  describe('deleteAllForRun (issue #107)', () => {
    it('deletes every WAL file for the run across multiple steps', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      await store.append('run-1', 'step-b', [{ event: 'b' }]);
      const before = await readdir(dir);
      expect(before.filter((f) => f.startsWith('trace-buffer-run-1-'))).toHaveLength(2);

      await store.deleteAllForRun('run-1');

      const after = await readdir(dir);
      expect(after.filter((f) => f.startsWith('trace-buffer-run-1-'))).toHaveLength(0);
    });

    it('leaves a different run’s WAL files untouched', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      await store.append('run-2', 'step-a', [{ event: 'b' }]);

      await store.deleteAllForRun('run-1');

      expect(await store.read('run-1', 'step-a')).toEqual([]);
      expect(await store.read('run-2', 'step-a')).toHaveLength(1);
    });

    it('is idempotent: no WAL files for the run (or an already-deleted run) is a no-op', async () => {
      await expect(store.deleteAllForRun('never-had-any-wal')).resolves.toBeUndefined();
      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      await store.deleteAllForRun('run-1');
      await expect(store.deleteAllForRun('run-1')).resolves.toBeUndefined();
    });

    it('a missing runsDir is a no-op (own readdir fallback path), not a throw', async () => {
      const missingDirStore = new JsonTraceBufferStore(join(dir, 'does', 'not', 'exist'));
      await expect(missingDirStore.deleteAllForRun('run-1')).resolves.toBeUndefined();
    });

    it('uses the dirEntries hint when supplied, instead of re-scanning the directory', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      const walFiles = (await readdir(dir)).filter((f) => f.startsWith('trace-buffer-run-1-'));
      expect(walFiles).toHaveLength(1);

      // A dirEntries snapshot taken BEFORE a second, unrelated WAL file is written on disk without
      // going through readdir again — deleteAllForRun must filter the *given* list, not re-scan,
      // so the unrelated file (absent from the stale hint) survives even though it matches the
      // run's prefix.
      const staleHint = [...walFiles];
      await writeFile(
        join(dir, `trace-buffer-run-1-${Buffer.from('step-b').toString('base64url')}.jsonl`),
        '',
      );

      await store.deleteAllForRun('run-1', staleHint);

      const remaining = await readdir(dir);
      expect(remaining.filter((f) => f.startsWith('trace-buffer-run-1-'))).toHaveLength(1); // step-b survived
      expect(existsSync(join(dir, walFiles[0]!))).toBe(false); // step-a (in the hint) was deleted
    });

    it('a dirEntries hint containing unrelated filenames does not delete them', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      const walFiles = await readdir(dir);

      await store.deleteAllForRun('run-1', [
        ...walFiles,
        'unrelated-run.json',
        'keys/somehash.json',
      ]);

      expect(existsSync(join(dir, 'unrelated-run.json'))).toBe(false); // never existed — sanity
      expect((await readdir(dir)).filter((f) => f.startsWith('trace-buffer-run-1-'))).toHaveLength(
        0,
      );
    });
  });
});
