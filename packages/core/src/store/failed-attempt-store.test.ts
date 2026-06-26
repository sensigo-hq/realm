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
});
