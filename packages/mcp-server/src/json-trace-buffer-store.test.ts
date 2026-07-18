// Tests for JsonTraceBufferStore — focused on deleteAllForRun and its dirEntries wiring (issue
// #107). append/read/delete are exercised indirectly elsewhere (execution-loop finalization); this
// file did not previously have dedicated coverage, so a handful of sanity tests are included too.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeDeclaresSeal, storeDeclaresNonceCarriage } from '@sensigo/realm';
import { JsonTraceBufferStore } from './json-trace-buffer-store.js';

/** Recomputes the exact on-disk WAL filename `walPath` uses — test-side only. */
function walFileName(runId: string, stepId: string): string {
  return `trace-buffer-${runId}-${Buffer.from(stepId).toString('base64url')}.jsonl`;
}

/** Recomputes the exact on-disk SEALED artifact filename `sealedWalPath` uses (issue #197 PR-1)
 *  — test-side only. */
function sealedFileName(runId: string, stepId: string, seq: number): string {
  return `sealed-trace-${runId}-${Buffer.from(stepId).toString('base64url')}.${seq}.jsonl`;
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

    it('a sealed artifact whose run is NOT live is also reported as an orphan (issue #197 PR-1)', async () => {
      await store.append(ORPHAN, 'step-a', [{ event: 'x' }]);
      const sealed = await store.sealFenced(ORPHAN, 'step-a', async () => {});
      expect(sealed).toEqual({ sealed: true });

      const orphans = await store.listOrphans(new Set());

      expect(orphans).toHaveLength(1);
      expect(orphans[0]?.runId).toBe(ORPHAN);
      expect(orphans[0]?.path).toBe(join(dir, sealedFileName(ORPHAN, 'step-a', 0)));
    });

    it('a sealed artifact whose run IS live is not reported', async () => {
      await store.append(LIVE, 'step-a', [{ event: 'x' }]);
      await store.sealFenced(LIVE, 'step-a', async () => {});

      const orphans = await store.listOrphans(new Set([LIVE]));

      expect(orphans).toEqual([]);
    });
  });

  describe('capability declaration (issue #197 PR-1)', () => {
    it('declares BOTH the seal and writer_nonce_carriage rungs, and both predicates hold', () => {
      expect(store.traceCapabilities).toEqual(new Set(['seal', 'writer_nonce_carriage']));
      expect(storeDeclaresSeal(store)).toBe(true);
      expect(storeDeclaresNonceCarriage(store)).toBe(true);
    });

    it('traceCapabilities is immutable across reads (same reference, content-identical)', () => {
      const first = store.traceCapabilities;
      const second = store.traceCapabilities;
      expect(first).toBe(second);
    });
  });

  describe('filename collision (issue #197 PR-1 — sealed vs live-WAL matchers)', () => {
    it('a sealed artifact filename never matches the live-WAL matcher, and vice versa', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      await store.sealFenced('run-1', 'step-a', async () => {});

      const files = await readdir(dir);
      const liveMatches = files.filter(
        (f) => f.startsWith('trace-buffer-') && f.endsWith('.jsonl'),
      );
      const sealedMatches = files.filter(
        (f) => f.startsWith('sealed-trace-') && f.endsWith('.jsonl'),
      );

      // The live WAL was moved (sealed), so it no longer exists as a live-matcher hit; the sealed
      // artifact exists and matches ONLY the sealed prefix, never both.
      expect(liveMatches).toEqual([]);
      expect(sealedMatches).toEqual([sealedFileName('run-1', 'step-a', 0)]);
      for (const f of sealedMatches) {
        expect(f.startsWith('trace-buffer-')).toBe(false);
      }
    });
  });

  describe('sealFenced (issue #197 PR-1, the seal rung)', () => {
    it('seals a live WAL: the live file is gone, a sealed artifact exists with the same lines', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a1' }]);
      await store.append('run-1', 'step-a', [{ event: 'a2' }]);

      const result = await store.sealFenced('run-1', 'step-a', async () => {});

      expect(result).toEqual({ sealed: true });
      expect(existsSync(join(dir, walFileName('run-1', 'step-a')))).toBe(false);
      const sealedArtifacts = await store.listSealedForRun('run-1');
      expect(sealedArtifacts).toHaveLength(1);
      expect(sealedArtifacts[0]?.seq).toBe(0);
      expect(sealedArtifacts[0]?.lines.flatMap((l) => l.entries)).toEqual([
        { event: 'a1' },
        { event: 'a2' },
      ]);
    });

    it('returns {sealed:false, reason:"absent"} when no live WAL exists for this key', async () => {
      const result = await store.sealFenced('run-1', 'never-appended', async () => {});
      expect(result).toEqual({ sealed: false, reason: 'absent' });
    });

    it('repeated seals of the same key get ascending seq numbers', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a1' }]);
      await store.sealFenced('run-1', 'step-a', async () => {});
      await store.append('run-1', 'step-a', [{ event: 'a2' }]);
      await store.sealFenced('run-1', 'step-a', async () => {});

      const sealedArtifacts = await store.listSealedForRun('run-1');
      expect(sealedArtifacts.map((a) => a.seq).sort()).toEqual([0, 1]);
    });

    it('returns {sealed:false, reason:"capped"} once SEALED_ARTIFACTS_LIMIT_PER_STEP is reached', async () => {
      for (let i = 0; i < 8; i++) {
        await store.append('run-1', 'step-a', [{ event: `a${i}` }]);
        const result = await store.sealFenced('run-1', 'step-a', async () => {});
        expect(result).toEqual({ sealed: true });
      }
      await store.append('run-1', 'step-a', [{ event: 'one-too-many' }]);
      const result = await store.sealFenced('run-1', 'step-a', async () => {});
      expect(result).toEqual({ sealed: false, reason: 'capped' });
    });

    it('no-clobber: a pre-existing file at seq 0 is never overwritten — the seal bumps to seq 1 and the sentinel bytes survive byte-for-byte (issue #197 PR-1)', async () => {
      const sentinelPath = join(dir, sealedFileName('run-1', 'step-a', 0));
      const sentinelBytes = 'SENTINEL-DO-NOT-CLOBBER- -bytes\n';
      await writeFile(sentinelPath, sentinelBytes);

      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      const result = await store.sealFenced('run-1', 'step-a', async () => {});

      expect(result).toEqual({ sealed: true });
      const sentinelAfter = await readFile(sentinelPath, 'utf8');
      expect(sentinelAfter).toBe(sentinelBytes); // byte-for-byte untouched

      const sealedArtifacts = await store.listSealedForRun('run-1');
      const bumpedArtifact = sealedArtifacts.find((a) => a.step_id === 'step-a' && a.seq === 1);
      expect(bumpedArtifact).toBeDefined(); // the real seal landed at seq 1, not seq 0
      expect(bumpedArtifact?.lines.flatMap((l) => l.entries)).toEqual([{ event: 'a' }]);
    });

    it('the guard runs even when the result is "absent" (guard-in-CS, not conditional on presence)', async () => {
      let guardCalls = 0;
      await store.sealFenced('run-1', 'never-appended', async () => {
        guardCalls++;
      });
      expect(guardCalls).toBe(1);
    });

    it('a refusing guard rejects the whole call — no seal happens', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      await expect(
        store.sealFenced('run-1', 'step-a', async () => {
          throw new Error('refused');
        }),
      ).rejects.toThrow('refused');
      expect(existsSync(join(dir, walFileName('run-1', 'step-a')))).toBe(true); // untouched
    });
  });

  describe('writer nonce carriage + per-writer/file budgets (issue #197 PR-1)', () => {
    it('append/appendFenced accept an options.writerNonce and read() re-attaches it as _nonce', async () => {
      await store.append('run-1', 'step-a', [{ event: 'nonced' }], { writerNonce: 'nonce-x' });
      await store.append('run-1', 'step-a', [{ event: 'bare' }]);

      const entries = await store.read('run-1', 'step-a');

      const nonced = entries.find((e) => e.event === 'nonced');
      const bare = entries.find((e) => e.event === 'bare');
      expect(nonced?._nonce).toBe('nonce-x');
      expect(bare).not.toHaveProperty('_nonce'); // never fabricated for a bare line
    });

    it('AppendResult reports separate writer-scope (buffer_*) and file-scope (file_*) numbers', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a' }, { event: 'b' }], {
        writerNonce: 'nonce-x',
      });
      const result = await store.append('run-1', 'step-a', [{ event: 'c' }]); // bare, second writer

      expect(result.buffer_count).toBe(1); // this (bare) writer's own share only
      expect(result.file_count).toBe(3); // whole file, both writers combined
      expect(result.file_limit_count).toBeGreaterThan(result.limit_count); // backstop > per-writer
    });

    it('a lone bare writer is byte-identical to the pre-#197 whole-file numbers (compat law)', async () => {
      const r1 = await store.append('run-1', 'step-a', [{ event: 'a' }]);
      const r2 = await store.append('run-1', 'step-a', [{ event: 'b' }]);

      expect(r1.buffer_count).toBe(r1.file_count);
      expect(r1.buffer_bytes).toBe(r1.file_bytes);
      expect(r2.buffer_count).toBe(r2.file_count);
      expect(r2.buffer_bytes).toBe(r2.file_bytes);
    });
  });

  describe('sealed artifacts join deleteAllForRun (issue #197 PR-1)', () => {
    it('deleteAllForRun removes sealed artifacts for the run alongside live WAL files', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      await store.sealFenced('run-1', 'step-a', async () => {});
      await store.append('run-1', 'step-b', [{ event: 'b' }]); // stays live, unset

      await store.deleteAllForRun('run-1');

      expect(await store.listSealedForRun('run-1')).toEqual([]);
      expect(existsSync(join(dir, walFileName('run-1', 'step-b')))).toBe(false);
    });

    it('leaves a different run’s sealed artifacts untouched', async () => {
      await store.append('run-1', 'step-a', [{ event: 'a' }]);
      await store.sealFenced('run-1', 'step-a', async () => {});
      await store.append('run-2', 'step-a', [{ event: 'b' }]);
      await store.sealFenced('run-2', 'step-a', async () => {});

      await store.deleteAllForRun('run-1');

      expect(await store.listSealedForRun('run-1')).toEqual([]);
      expect(await store.listSealedForRun('run-2')).toHaveLength(1);
    });
  });
});
