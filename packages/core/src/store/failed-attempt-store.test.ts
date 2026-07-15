// Tests for FailedAttemptStore — the durable per-run failed-attempt sidecar (observability P3).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FailedAttemptStore, FAILED_ATTEMPT_SIDECAR_MAX_BYTES } from './failed-attempt-store.js';
import {
  buildFailedAttemptRecord as buildRecord,
  serializeFailedAttemptLine,
} from '../observability/failed-attempt-record.js';

const RUN_ID = '11111111-2222-4333-8444-555555555555';

function line(over: Record<string, unknown> = {}): string {
  const rec = buildRecord({
    run_id: RUN_ID,
    workflow_id: 'wf',
    step_id: 'classify',
    ts: '2026-06-27T00:00:00.000Z',
    error_code: 'VALIDATION_OUTPUT_SCHEMA',
    ajv_errors: [],
    params: {},
    trace_entry_count: 0,
  });
  return serializeFailedAttemptLine({ ...rec, ...over }).line;
}

describe('FailedAttemptStore', () => {
  let dir: string;
  let store: FailedAttemptStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fas-'));
    store = new FailedAttemptStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends to <id>.attempts.jsonl (NOT .json) — never creates a .json sibling', async () => {
    await store.append(RUN_ID, line());
    expect(existsSync(join(dir, `${RUN_ID}.attempts.jsonl`))).toBe(true);
    expect(existsSync(join(dir, `${RUN_ID}.attempts.json`))).toBe(false);
    const entries = await readdir(dir);
    expect(entries.some((f) => f.endsWith('.attempts.json') && !f.endsWith('.jsonl'))).toBe(false);
    // The sidecar is invisible to JsonFileStore.list()'s `.json` filter.
    expect(entries.filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('writes exactly one line per record', async () => {
    await store.append(RUN_ID, line({ step_id: 'a' }));
    await store.append(RUN_ID, line({ step_id: 'b' }));
    const content = await readFile(join(dir, `${RUN_ID}.attempts.jsonl`), 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    lines.forEach((l) => expect(() => JSON.parse(l)).not.toThrow());
  });

  it('concurrent appends all land as N valid lines (atomic, lock-free)', async () => {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) => store.append(RUN_ID, line({ step_id: `s${i}` }))),
    );
    const { records } = await store.read(RUN_ID);
    expect(records).toHaveLength(N);
    // every line parsed cleanly (no torn/interleaved writes)
    const steps = new Set(records.map((r) => r.step_id));
    expect(steps.size).toBe(N);
  });

  describe('ceiling (append-and-stop)', () => {
    it('drops further appends once the file is at the ceiling; file stops growing', async () => {
      const sidecar = join(dir, `${RUN_ID}.attempts.jsonl`);
      // Seed the file past the ceiling directly (one big blob).
      await writeFile(sidecar, 'x'.repeat(FAILED_ATTEMPT_SIDECAR_MAX_BYTES + 10), 'utf8');
      const before = (await stat(sidecar)).size;

      await store.append(RUN_ID, line());

      const after = (await stat(sidecar)).size;
      expect(after).toBe(before); // dropped — no growth
    });

    it('appends normally while under the ceiling', async () => {
      await store.append(RUN_ID, line());
      const size = (await stat(join(dir, `${RUN_ID}.attempts.jsonl`))).size;
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(FAILED_ATTEMPT_SIDECAR_MAX_BYTES);
    });

    it('read() reports capped:true when the file is at/over the ceiling', async () => {
      const sidecar = join(dir, `${RUN_ID}.attempts.jsonl`);
      await writeFile(
        sidecar,
        line() + '\n' + 'y'.repeat(FAILED_ATTEMPT_SIDECAR_MAX_BYTES),
        'utf8',
      );
      const { capped } = await store.read(RUN_ID);
      expect(capped).toBe(true);
    });
  });

  describe('read()', () => {
    it('missing file → empty result, capped:false', async () => {
      const res = await store.read('00000000-0000-4000-8000-000000000000');
      expect(res).toEqual({ records: [], capped: false });
    });

    it('parses valid lines and skips a torn/unparseable line without throwing', async () => {
      const sidecar = join(dir, `${RUN_ID}.attempts.jsonl`);
      await writeFile(
        sidecar,
        [line({ step_id: 'ok1' }), '{ this is not valid json', '', line({ step_id: 'ok2' })].join(
          '\n',
        ) + '\n',
        'utf8',
      );
      const { records, capped } = await store.read(RUN_ID);
      expect(records.map((r) => r.step_id)).toEqual(['ok1', 'ok2']); // torn + blank skipped
      expect(capped).toBe(false);
    });
  });

  it('append is best-effort: an unwritable runsDir does not throw', async () => {
    const badStore = new FailedAttemptStore(join(dir, 'does', 'not', 'exist'));
    await expect(badStore.append(RUN_ID, line())).resolves.toBeUndefined();
  });

  describe('deleteAllForRun (issue #107)', () => {
    it('deletes the sidecar for a run that has one', async () => {
      await store.append(RUN_ID, line());
      const sidecar = join(dir, `${RUN_ID}.attempts.jsonl`);
      expect(existsSync(sidecar)).toBe(true);

      await store.deleteAllForRun(RUN_ID);

      expect(existsSync(sidecar)).toBe(false);
    });

    it('is idempotent: a run with no sidecar (never failed, or already deleted) is a no-op', async () => {
      await expect(store.deleteAllForRun('never-recorded-any-attempts')).resolves.toBeUndefined();
      // and a second call after an actual deletion:
      await store.append(RUN_ID, line());
      await store.deleteAllForRun(RUN_ID);
      await expect(store.deleteAllForRun(RUN_ID)).resolves.toBeUndefined();
    });

    it('ignores dirEntries (exact-path store — the batch hint is for glob-based stores only)', async () => {
      await store.append(RUN_ID, line());
      await store.deleteAllForRun(RUN_ID, ['completely-unrelated.json']);
      expect(existsSync(join(dir, `${RUN_ID}.attempts.jsonl`))).toBe(false);
    });

    it('does not affect a different run’s sidecar', async () => {
      const OTHER = '99999999-8888-4777-8666-555555555555';
      await store.append(RUN_ID, line());
      await store.append(OTHER, line());

      await store.deleteAllForRun(RUN_ID);

      expect(existsSync(join(dir, `${RUN_ID}.attempts.jsonl`))).toBe(false);
      expect(existsSync(join(dir, `${OTHER}.attempts.jsonl`))).toBe(true);
    });
  });

  describe('listOrphans (issue #163)', () => {
    const LIVE = '11111111-1111-4111-8111-111111111111';
    const ORPHAN = '22222222-2222-4222-8222-222222222222';

    it('a sidecar whose runId is NOT in liveRunIds is returned; one whose runId IS is not', async () => {
      await store.append(LIVE, line());
      await store.append(ORPHAN, line());

      const orphans = await store.listOrphans(new Set([LIVE]));

      expect(orphans).toHaveLength(1);
      expect(orphans[0]?.runId).toBe(ORPHAN);
      expect(orphans[0]?.path).toBe(join(dir, `${ORPHAN}.attempts.jsonl`));
      expect(orphans[0]?.mtimeMs).toBeGreaterThan(0);
    });

    it('empty liveRunIds: every existing sidecar is a candidate orphan', async () => {
      await store.append(LIVE, line());
      const orphans = await store.listOrphans(new Set());
      expect(orphans.map((o) => o.runId)).toEqual([LIVE]);
    });

    it('no sidecars at all: returns []', async () => {
      const orphans = await store.listOrphans(new Set([LIVE]));
      expect(orphans).toEqual([]);
    });

    it('a missing runsDir (ENOENT) resolves to [] — not a throw', async () => {
      const missingStore = new FailedAttemptStore(join(dir, 'does', 'not', 'exist'));
      await expect(missingStore.listOrphans(new Set())).resolves.toEqual([]);
    });

    it('fail-closed: a non-ENOENT readdir error THROWS — never a fabricated empty/partial list', async () => {
      // A file (not a directory) in place of runsDir — readdir on it fails with ENOTDIR, not ENOENT.
      const notADir = join(dir, 'i-am-a-file');
      await writeFile(notADir, 'x');
      const brokenStore = new FailedAttemptStore(notADir);

      await expect(brokenStore.listOrphans(new Set())).rejects.toMatchObject({ code: 'ENOTDIR' });
    });

    it('ignores non-sidecar files entirely (a run file, a WAL file survive unexamined)', async () => {
      await writeFile(join(dir, `${ORPHAN}.json`), '{}');
      await writeFile(join(dir, `trace-buffer-${ORPHAN}-c3RlcA.jsonl`), 'x');
      const orphans = await store.listOrphans(new Set());
      expect(orphans).toEqual([]);
    });
  });
});
