// Tests for JsonTraceBufferStore — focused on deleteAllForRun and its dirEntries wiring (issue
// #107). append/read/delete are exercised indirectly elsewhere (execution-loop finalization); this
// file did not previously have dedicated coverage, so a handful of sanity tests are included too.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonTraceBufferStore } from './json-trace-buffer-store.js';

/** Recomputes the exact on-disk WAL filename `walPath` uses — test-side only. */
function walFileName(runId: string, stepId: string): string {
  return `trace-buffer-${runId}-${Buffer.from(stepId).toString('base64url')}.jsonl`;
}

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

  it('read() is torn-line-safe: a corrupt/partial line is skipped, sibling good lines in the SAME file survive (issue #183)', async () => {
    // Exercises readWal directly (via the public read()/append() surface) — distinct from the
    // readAllForRun torn-line test below, which exercises a DIFFERENT method that already had its
    // own per-line discipline before #183. readWal's old behavior was whole-buffer discard on ANY
    // parse error (`catch { return { count: 0, bytes: 0, lines: [] }; }`) — this proves that's
    // fixed: a crash mid-appendFile no longer nukes every entry recorded before it.
    await store.append('run-1', 'step-a', [{ event: 'a1' }]);
    await store.append('run-1', 'step-a', [{ event: 'a2' }]);
    const path = join(dir, walFileName('run-1', 'step-a'));
    await appendFile(path, '{ this is not valid json\n', 'utf8');

    const entries = await store.read('run-1', 'step-a');

    expect(entries).toHaveLength(2); // only the two well-formed lines — not zero
    expect(entries.map((e) => e.event).sort()).toEqual(['a1', 'a2']);
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

  describe('readAllForRun (issue #159 — export evidence assembly)', () => {
    it('returns every step WAL for the run, keyed by DECODED stepId, across multiple steps', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a1' }]);
      await store.append('run-1', 'step-a', [{ event: 'a2' }]); // second append → second line
      await store.append('run-1', 'step-b', [{ event: 'b1' }]);
      await store.append('run-2', 'step-a', [{ event: 'other-run' }]); // must NOT appear

      const all = await store.readAllForRun('run-1');

      expect(Object.keys(all).sort()).toEqual(['step-a', 'step-b']);
      expect(all['step-a']).toHaveLength(2); // two appends → two WAL lines
      expect(all['step-b']).toHaveLength(1);
      // each element is the raw parsed WAL line shape ({ts, entries}), matching what's on disk.
      const firstLine = (all['step-a'] as Array<{ ts: number; entries: unknown[] }>)[0]!;
      expect(typeof firstLine.ts).toBe('number');
      expect(firstLine.entries).toEqual([{ event: 'a1' }]);
    });

    it('returns {} for a run with no WAL files at all', async () => {
      const all = await store.readAllForRun('never-had-any-wal');
      expect(all).toEqual({});
    });

    it('returns {} (no crash) when runsDir itself is missing', async () => {
      const missingDirStore = new JsonTraceBufferStore(join(dir, 'does', 'not', 'exist'));
      const all = await missingDirStore.readAllForRun('run-1');
      expect(all).toEqual({});
    });

    it('is torn-line-safe: a corrupt/partial line is skipped, sibling good lines in the SAME file survive', async () => {
      // Two good appends (two valid JSONL lines), then a manually-injected torn line appended
      // directly to the file (simulating a crash mid-append) — readWal's own all-or-nothing catch
      // would discard the whole file for this; readAllForRun must not.
      await store.append('run-1', 'step-a', [{ event: 'a1' }]);
      await store.append('run-1', 'step-a', [{ event: 'a2' }]);
      const path = join(dir, walFileName('run-1', 'step-a'));
      await appendFile(path, '{ this is not valid json\n', 'utf8');
      await appendFile(path, '\n', 'utf8'); // a blank line too — also must be skipped, not crash

      const all = await store.readAllForRun('run-1');

      expect(all['step-a']).toHaveLength(2); // only the two well-formed lines
    });

    it('skips a file with an undecodable stepId segment rather than throwing (defensive — never happens via normal writes)', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a1' }]);
      // A malformed filename that still matches the runId prefix/suffix glob but whose "stepId"
      // segment is not valid base64url content in the way we round-trip it.
      await writeFile(
        join(dir, 'trace-buffer-run-1-%%%not-base64%%%.jsonl'),
        '{"ts":1,"entries":[]}\n',
      );

      const all = await store.readAllForRun('run-1');

      // The well-formed step's WAL is still returned; the malformed one is simply absent.
      expect(all['step-a']).toHaveLength(1);
    });

    it('is read-only: calling it never deletes or modifies any WAL file', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      const before = await readdir(dir);

      await store.readAllForRun('run-1');

      const after = await readdir(dir);
      expect(after.sort()).toEqual(before.sort());
      expect(await store.read('run-1', 'step-a')).toHaveLength(1);
    });
  });

  describe('listOrphans (issue #163)', () => {
    // Real 36-char UUIDv4-shaped runIds — listOrphans's runId parse requires the fixed length;
    // a short test id like 'run-1' (used elsewhere in this file) is shorter than 36 chars and
    // would be (correctly) treated as malformed/skipped, not a useful case here.
    const LIVE = '11111111-1111-4111-8111-111111111111';
    const ORPHAN = '22222222-2222-4222-8222-222222222222';

    it('a WAL whose runId is NOT in liveRunIds is returned; one whose runId IS is not', async () => {
      await store.append(LIVE, 'step-a', [{ event: 'x' }]);
      await store.append(ORPHAN, 'step-a', [{ event: 'y' }]);

      const orphans = await store.listOrphans(new Set([LIVE]));

      expect(orphans).toHaveLength(1);
      expect(orphans[0]?.runId).toBe(ORPHAN);
      expect(orphans[0]?.path).toBe(join(dir, walFileName(ORPHAN, 'step-a')));
      expect(orphans[0]?.mtimeMs).toBeGreaterThan(0);
    });

    it('a run with WAL entries across MULTIPLE steps: every step file is reported once, all under the same runId', async () => {
      await store.append(ORPHAN, 'step-a', [{ event: 'x' }]);
      await store.append(ORPHAN, 'step-b', [{ event: 'y' }]);

      const orphans = await store.listOrphans(new Set());

      expect(orphans).toHaveLength(2);
      expect(orphans.every((o) => o.runId === ORPHAN)).toBe(true);
    });

    it('runId parse is correct when the base64url step segment itself contains "-" or "_" (not split-on-dash)', async () => {
      // 'step->' base64url-encodes to 'c3RlcC0-' (ends in '-'); 'step-?' encodes to 'c3RlcC0_'
      // (ends in '_') — both exercise the exact ambiguity a naive split('-') would mis-parse.
      const dashStep = 'step->';
      const underscoreStep = 'step-?';
      expect(Buffer.from(dashStep).toString('base64url')).toContain('-');
      expect(Buffer.from(underscoreStep).toString('base64url')).toContain('_');

      await store.append(LIVE, dashStep, [{ event: 'x' }]);
      await store.append(ORPHAN, underscoreStep, [{ event: 'y' }]);

      const orphans = await store.listOrphans(new Set([LIVE]));

      // The LIVE run's dash-bearing-step WAL must NOT appear (correctly recognized as live);
      // only the ORPHAN run's underscore-bearing-step WAL should.
      expect(orphans).toHaveLength(1);
      expect(orphans[0]?.runId).toBe(ORPHAN);
      expect(orphans[0]?.path).toBe(join(dir, walFileName(ORPHAN, underscoreStep)));
    });

    it('a malformed filename (too short to contain a full UUID) is skipped, not mis-parsed', async () => {
      await writeFile(join(dir, 'trace-buffer-short-c3RlcA.jsonl'), '{"ts":1,"entries":[]}\n');
      const orphans = await store.listOrphans(new Set());
      expect(orphans).toEqual([]);
    });

    it('no WAL files at all: returns []', async () => {
      const orphans = await store.listOrphans(new Set([LIVE]));
      expect(orphans).toEqual([]);
    });

    it('a missing runsDir (ENOENT) resolves to [] — not a throw', async () => {
      const missingStore = new JsonTraceBufferStore(join(dir, 'does', 'not', 'exist'));
      await expect(missingStore.listOrphans(new Set())).resolves.toEqual([]);
    });

    it('fail-closed: a non-ENOENT readdir error THROWS — never a fabricated empty/partial list', async () => {
      const notADir = join(dir, 'i-am-a-file');
      await writeFile(notADir, 'x');
      const brokenStore = new JsonTraceBufferStore(notADir);

      await expect(brokenStore.listOrphans(new Set())).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it('ignores non-WAL files entirely (a run file, a sidecar survive unexamined)', async () => {
      await writeFile(join(dir, `${ORPHAN}.json`), '{}');
      await writeFile(join(dir, `${ORPHAN}.attempts.jsonl`), 'x');
      const orphans = await store.listOrphans(new Set());
      expect(orphans).toEqual([]);
    });
  });
});
