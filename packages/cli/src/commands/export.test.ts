// Tests for export.ts — realm run export (issue #159), the read-only evidence-preserving
// companion to purge. Mirrors purge.test.ts/gc.test.ts's style: the exported LOGIC
// (buildExportBundle, resolveExportPath) is tested directly against real stores over a real,
// isolated tmp directory (NEVER `~/.realm/runs` or cwd's real files) — no console/exit-code
// assertions (that thin formatting layer isn't unit-tested here either, per precedent).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { buildExportBundle, resolveExportPath } from './export.js';
import {
  JsonFileStore,
  FailedAttemptStore,
  buildFailedAttemptRecord,
  serializeFailedAttemptLine,
} from '@sensigo/realm';
import type { RunRecord } from '@sensigo/realm';
import { JsonTraceBufferStore } from '@sensigo/realm-mcp';

async function makeStores(): Promise<{
  dir: string;
  runStore: JsonFileStore;
  failedAttemptStore: FailedAttemptStore;
  traceBufferStore: JsonTraceBufferStore;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'export-test-'));
  return {
    dir,
    runStore: new JsonFileStore(dir),
    failedAttemptStore: new FailedAttemptStore(dir),
    traceBufferStore: new JsonTraceBufferStore(dir),
  };
}

async function injectRun(dir: string, run: RunRecord): Promise<void> {
  await writeFile(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
}

function makeRun(overrides: Partial<RunRecord> & { id?: string }): RunRecord {
  const id = overrides.id ?? uuidv4();
  const now = new Date().toISOString();
  return {
    id,
    workflow_id: 'wf-1',
    workflow_version: 1,
    run_phase: 'completed',
    completed_steps: ['step-a'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    params: { input: 'hello' },
    evidence: [],
    version: 0,
    created_at: now,
    updated_at: now,
    terminal_state: true,
    ...overrides,
  };
}

async function appendSidecarLine(store: FailedAttemptStore, runId: string): Promise<void> {
  const rec = buildFailedAttemptRecord({
    run_id: runId,
    workflow_id: 'wf-1',
    step_id: 'classify',
    ts: '2026-06-27T00:00:00.000Z',
    error_code: 'VALIDATION_OUTPUT_SCHEMA',
    ajv_errors: [],
    params: {},
    trace_entry_count: 0,
  });
  await store.append(runId, serializeFailedAttemptLine(rec).line);
}

describe('buildExportBundle', () => {
  it('terminal run, full artifacts: bundle matches run/attempts/WAL exactly, across multiple WAL steps', async () => {
    const { dir, runStore, failedAttemptStore, traceBufferStore } = await makeStores();
    try {
      const run = makeRun({ run_phase: 'abandoned', terminal_state: true });
      await injectRun(dir, run);
      await appendSidecarLine(failedAttemptStore, run.id);
      await traceBufferStore.append(run.id, 'step-a', [{ event: 'orphaned-a' }]);
      await traceBufferStore.append(run.id, 'step-b', [{ event: 'orphaned-b' }]);

      const now = new Date('2026-07-13T00:00:00.000Z');
      const { bundle, warning } = await buildExportBundle(
        run.id,
        { runStore, failedAttemptStore, traceBufferStore },
        now,
      );

      expect(warning).toBeUndefined(); // terminal — no best-effort warning
      expect(bundle.realm_export_version).toBe(1);
      expect(bundle.exported_at).toBe(now.toISOString());
      expect(bundle.run).toEqual(run);
      expect(bundle.attempts).toHaveLength(1);
      expect(bundle.attempts[0]?.step_id).toBe('classify');
      expect(Object.keys(bundle.wal).sort()).toEqual(['step-a', 'step-b']);
      expect(bundle.wal['step-a']).toHaveLength(1);
      expect(bundle.wal['step-b']).toHaveLength(1);

      // The whole bundle is genuinely JSON-serializable (a real export writes JSON.stringify(bundle)).
      expect(() => JSON.stringify(bundle)).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('clean run (no attempts, no WAL): attempts: [], attempts_capped: false, wal: {} — not an error', async () => {
    const { dir, runStore, failedAttemptStore, traceBufferStore } = await makeStores();
    try {
      const run = makeRun({ run_phase: 'completed', terminal_state: true });
      await injectRun(dir, run);

      const { bundle } = await buildExportBundle(run.id, {
        runStore,
        failedAttemptStore,
        traceBufferStore,
      });

      expect(bundle.attempts).toEqual([]);
      expect(bundle.attempts_capped).toBe(false);
      expect(bundle.wal).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('attempts_capped (correction — the truncation signal)', () => {
    it('a capped failed-attempt sidecar sets bundle.attempts_capped = true', async () => {
      const { dir, runStore, traceBufferStore } = await makeStores();
      try {
        const run = makeRun({ run_phase: 'completed', terminal_state: true });
        await injectRun(dir, run);

        // A stub failedAttemptStore — no real 256KB file needed, per the correction prompt: the
        // store is already injected via ExportStores, so exercising the pass-through only needs a
        // fake read() reporting capped: true.
        const cappedRecord = buildFailedAttemptRecord({
          run_id: run.id,
          workflow_id: 'wf-1',
          step_id: 'classify',
          ts: '2026-06-27T00:00:00.000Z',
          error_code: 'VALIDATION_OUTPUT_SCHEMA',
          ajv_errors: [],
          params: {},
          trace_entry_count: 0,
        });
        const stubFailedAttemptStore = {
          read: async () => ({ records: [cappedRecord], capped: true }),
        };

        const { bundle } = await buildExportBundle(run.id, {
          runStore,
          failedAttemptStore: stubFailedAttemptStore,
          traceBufferStore,
        });

        expect(bundle.attempts_capped).toBe(true);
        expect(bundle.attempts).toEqual([cappedRecord]); // attempts array shape is unchanged
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a non-capped sidecar sets bundle.attempts_capped = false (explicit, not just absence)', async () => {
      const { dir, runStore, traceBufferStore } = await makeStores();
      try {
        const run = makeRun({ run_phase: 'completed', terminal_state: true });
        await injectRun(dir, run);

        const stubFailedAttemptStore = {
          read: async () => ({ records: [], capped: false }),
        };

        const { bundle } = await buildExportBundle(run.id, {
          runStore,
          failedAttemptStore: stubFailedAttemptStore,
          traceBufferStore,
        });

        expect(bundle.attempts_capped).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('attempts_capped serializes into the JSON bundle, sitting alongside attempts', async () => {
      const { dir, runStore, traceBufferStore } = await makeStores();
      try {
        const run = makeRun({ run_phase: 'completed', terminal_state: true });
        await injectRun(dir, run);

        const stubFailedAttemptStore = { read: async () => ({ records: [], capped: true }) };

        const { bundle } = await buildExportBundle(run.id, {
          runStore,
          failedAttemptStore: stubFailedAttemptStore,
          traceBufferStore,
        });

        const parsed = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
        expect(parsed['attempts_capped']).toBe(true);
        expect(Object.keys(parsed)).toContain('attempts');
        // sits adjacent to attempts in key order (schema placement, not just presence)
        const keys = Object.keys(parsed);
        expect(keys.indexOf('attempts_capped')).toBe(keys.indexOf('attempts') + 1);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it('non-terminal run: emits the best-effort warning signal AND still produces the bundle', async () => {
    const { dir, runStore, failedAttemptStore, traceBufferStore } = await makeStores();
    try {
      const run = makeRun({ run_phase: 'running', terminal_state: false });
      await injectRun(dir, run);

      const { bundle, warning } = await buildExportBundle(run.id, {
        runStore,
        failedAttemptStore,
        traceBufferStore,
      });

      expect(warning).toBeDefined();
      expect(warning).toContain(run.id);
      expect(warning).toContain('running');
      expect(warning).toMatch(/best-effort snapshot/);
      expect(bundle.run.id).toBe(run.id); // bundle still produced, not blocked
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('gate_waiting (also non-terminal) run: warning emitted too', async () => {
    const { dir, runStore, failedAttemptStore, traceBufferStore } = await makeStores();
    try {
      const run = makeRun({ run_phase: 'gate_waiting', terminal_state: false });
      await injectRun(dir, run);

      const { warning } = await buildExportBundle(run.id, {
        runStore,
        failedAttemptStore,
        traceBufferStore,
      });

      expect(warning).toMatch(/gate_waiting/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['completed', 'failed', 'abandoned', 'aborted'] as const)(
    'terminal phase %s never emits a warning',
    async (phase) => {
      const { dir, runStore, failedAttemptStore, traceBufferStore } = await makeStores();
      try {
        const run = makeRun({ run_phase: phase, terminal_state: true });
        await injectRun(dir, run);

        const { warning } = await buildExportBundle(run.id, {
          runStore,
          failedAttemptStore,
          traceBufferStore,
        });

        expect(warning).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('nonexistent run: rejects with STATE_RUN_NOT_FOUND, writes nothing', async () => {
    const { dir, runStore, failedAttemptStore, traceBufferStore } = await makeStores();
    try {
      await expect(
        buildExportBundle('never-existed', { runStore, failedAttemptStore, traceBufferStore }),
      ).rejects.toMatchObject({ code: 'STATE_RUN_NOT_FOUND' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does NOT include the idempotency-key pointer anywhere in the bundle', async () => {
    const { dir, runStore, failedAttemptStore, traceBufferStore } = await makeStores();
    try {
      const { run } = await runStore.create({
        workflowId: 'wf-1',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'k1',
      });
      await runStore.update({ ...run, run_phase: 'completed', terminal_state: true });

      const { bundle } = await buildExportBundle(run.id, {
        runStore,
        failedAttemptStore,
        traceBufferStore,
      });

      const serialized = JSON.stringify(bundle);
      expect(serialized).not.toContain('keys');
      expect(serialized).not.toContain('params_hash');
      // the idempotency KEY itself is still present — via the run record, not a separate pointer.
      expect(bundle.run.idempotency_key).toBe('k1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never writes to runsDir: directory is byte-unchanged after building the bundle', async () => {
    const { dir, runStore, failedAttemptStore, traceBufferStore } = await makeStores();
    try {
      const run = makeRun({ run_phase: 'completed', terminal_state: true });
      await injectRun(dir, run);
      await appendSidecarLine(failedAttemptStore, run.id);
      await traceBufferStore.append(run.id, 'step-a', [{ event: 'x' }]);

      const before = await readdir(dir);

      await buildExportBundle(run.id, { runStore, failedAttemptStore, traceBufferStore });

      const after = await readdir(dir);
      expect(after.sort()).toEqual(before.sort()); // no new file, no temp, nothing removed
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveExportPath', () => {
  it('default (no --out): resolves to ./<id>.realm.json in the CURRENT working directory', () => {
    const runId = 'abc123';
    const resolved = resolveExportPath({ runId, runsDir: '/some/unrelated/runs-dir' });
    expect(resolved).toBe(join(process.cwd(), `${runId}.realm.json`));
  });

  it('--out names an existing directory: resolves to <dir>/<id>.realm.json', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'export-out-'));
    try {
      const runId = 'abc123';
      const resolved = resolveExportPath({
        runId,
        out: outDir,
        runsDir: '/some/unrelated/runs-dir',
      });
      expect(resolved).toBe(join(outDir, `${runId}.realm.json`));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('--out names a literal (non-existent) file path: used as-is', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'export-out-'));
    try {
      const target = join(outDir, 'custom-name.json');
      const resolved = resolveExportPath({
        runId: 'abc123',
        out: target,
        runsDir: '/some/unrelated/runs-dir',
      });
      expect(resolved).toBe(target);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('refuse-overwrite: an existing file at the resolved target throws, naming the path', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'export-out-'));
    try {
      const target = join(outDir, 'already-here.json');
      await writeFile(target, 'pre-existing content', 'utf8');

      expect(() =>
        resolveExportPath({ runId: 'abc123', out: target, runsDir: '/some/unrelated/runs-dir' }),
      ).toThrowError(/already-here\.json/);

      // original untouched
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(target, 'utf8')).toBe('pre-existing content');
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it('refuses to resolve inside runsDir itself (the directory)', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'export-runsdir-'));
    try {
      expect(() => resolveExportPath({ runId: 'abc123', out: runsDir, runsDir })).toThrowError(
        /runsDir/,
      );
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  it('refuses to resolve to a literal path INSIDE runsDir (not just the directory itself)', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'export-runsdir-'));
    try {
      const insidePath = join(runsDir, 'sneaky.realm.json');
      expect(() => resolveExportPath({ runId: 'abc123', out: insidePath, runsDir })).toThrowError(
        /runsDir/,
      );
      expect(existsSync(insidePath)).toBe(false); // never created
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  it("a directory INSIDE runsDir (e.g. keys/) is also refused, not just runsDir's own root", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'export-runsdir-'));
    try {
      const keysDir = join(runsDir, 'keys');
      await mkdir(keysDir);
      expect(() => resolveExportPath({ runId: 'abc123', out: keysDir, runsDir })).toThrowError(
        /runsDir/,
      );
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });
});
