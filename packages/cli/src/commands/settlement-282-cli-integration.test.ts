// settlement-282-cli-integration.test.ts — CLI integration pins for the #282 class closure (issue
// #279, increment 2, PR-C — design record §8, "CLI integration"). Raw run-file writing per the
// purge.test.ts / export.test.ts idiom (bypassing store.create/update so the fixture's own
// run_phase can be deliberately stale — the whole point of a #282 "G" fixture).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { purgeRuns } from './purge.js';
import { resumeRun } from './resume.js';
import { buildExportBundle } from './export.js';
import { listRuns } from './list.js';
import { JsonFileStore, JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { RunRecord, WorkflowDefinition } from '@sensigo/realm';
import { JsonTraceBufferStore } from '@sensigo/realm-mcp';

const def: WorkflowDefinition = {
  id: 'wf-282',
  name: '#282 CLI integration fixture',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'a', execution: 'agent', depends_on: [] },
    b: { description: 'b', execution: 'agent', depends_on: [] },
  },
};

/** A "G" (#282-class) fixture: genuinely terminal, but the persisted `run_phase` field is STALE
 *  ('gate_waiting'-shaped leftover) and a `pending_gate` was never cleared — a grandfathered
 *  record from before this closure (or a mixed-fleet old-binary writer). */
function makeGrandfatheredFixture(
  // issue #337: some call sites pass `terminal_reason: undefined` to ERASE the base default below
  // (simulating a grandfathered record whose stale write never carried a terminal_reason at all —
  // the "fail∧gate shape" case) — widen only this field to admit explicit undefined.
  overrides: Partial<Omit<RunRecord, 'terminal_reason'>> & {
    id?: string;
    terminal_reason?: string | undefined;
  },
): RunRecord {
  const id = overrides.id ?? uuidv4();
  const now = new Date().toISOString();
  const { terminal_reason: terminalReasonOverride, ...rest } = overrides;
  return {
    id,
    workflow_id: def.id,
    workflow_version: 1,
    completed_steps: ['a', 'b'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'gate_waiting', // STALE — the record is actually terminal
    version: 0,
    params: {},
    evidence: [],
    created_at: now,
    updated_at: now,
    terminal_state: true,
    ...(terminalReasonOverride !== undefined
      ? { terminal_reason: terminalReasonOverride }
      : 'terminal_reason' in overrides
        ? {}
        : { terminal_reason: 'Workflow completed.' }),
    pending_gate: {
      gate_id: 'stale',
      step_name: 'a',
      preview: {},
      choices: ['approve', 'reject'],
      opened_at: now,
    },
    ...rest,
  };
}

async function injectRun(dir: string, run: RunRecord): Promise<void> {
  await writeFile(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
}

describe('PURGE_DERIVES_PHASE end-to-end (issue #279, increment 2, PR-C)', () => {
  it('a grandfathered ("G") fixture purges (bucket "purged", not "blocked") — real JsonTraceBufferStore + real JsonFileStore', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-purge-'));
    try {
      const runStore = new JsonFileStore(dir);
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const run = makeGrandfatheredFixture({});
      await injectRun(dir, run);

      const result = await purgeRuns({ runId: run.id, dryRun: false }, runStore, [
        traceBufferStore,
      ]);

      expect(result.purged).toContain(run.id);
      expect(result.blocked).toHaveLength(0);
      expect(existsSync(join(dir, `${run.id}.json`))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a second G fixture with an unknown-age claim is skipped in BATCH mode (not force-purged), and reports resumable:true for the fail∧gate shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-purge-batch-'));
    try {
      const runStore = new JsonFileStore(dir);
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const run = makeGrandfatheredFixture({
        id: 'g-unknown-claim',
        completed_steps: [],
        failed_steps: ['a'],
        terminal_reason: undefined,
        in_progress_steps: ['b'],
        claims: { b: { deadline: null } }, // unknown-age (no deadline) — batch must skip it
      });
      await injectRun(dir, run);

      const dryRun = await purgeRuns({ dryRun: true }, runStore, [traceBufferStore]);
      const skippedIds = dryRun.skipped.map((s) => s.runId);
      expect(skippedIds).toContain(run.id);

      const selected = dryRun.selected.find((c) => c.run.id === run.id);
      // A resumable check on any OTHER, cleanly-selected G fixture (fail∧gate shape) — construct
      // one alongside to prove `resumable` derives correctly for the class.
      const cleanFailFixture = makeGrandfatheredFixture({
        id: 'g-clean-fail',
        completed_steps: [],
        failed_steps: ['a'],
        terminal_reason: undefined,
      });
      await injectRun(dir, cleanFailFixture);
      const dryRun2 = await purgeRuns({ runId: cleanFailFixture.id, dryRun: true }, runStore, [
        traceBufferStore,
      ]);
      expect(dryRun2.selected[0]?.resumable).toBe(true);
      expect(selected).toBeUndefined(); // the unknown-claim fixture never entered `selected` in batch
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('RESUME_STRIPS_ZOMBIE_GATE / RESUME_ADMITS_GRANDFATHERED (issue #279, increment 2, PR-C)', () => {
  it('resume, through the CLI admission gate, ADMITS a grandfathered G fixture and strips its zombie gate — the disclosure is returned for the CLI to print', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-resume-'));
    try {
      const runStore = new JsonFileStore(dir);
      const workflowStore = new JsonWorkflowStore(join(dir, 'workflows'));
      await workflowStore.register(def);
      const run = makeGrandfatheredFixture({
        completed_steps: [],
        failed_steps: ['a'],
        terminal_reason: undefined,
        run_phase: 'gate_waiting', // stale — RESUMABLE_PHASES.has(deriveRunPhase(run)) must admit it
      });
      await injectRun(dir, run);

      const { voided, disclosures } = await resumeRun(run.id, 'a', runStore, workflowStore);

      expect(voided).toEqual([]);
      expect(disclosures).toHaveLength(1);
      expect(disclosures[0]).toMatch(/zombie gate 'stale' on 'a' cleared by resume/);

      const resumed = await runStore.get(run.id);
      expect(resumed.pending_gate).toBeUndefined();
      expect(resumed.failed_steps).not.toContain('a');
      expect(resumed.terminal_state).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('EXPORT_TERMINAL_KEYED (issue #279, increment 2, PR-C)', () => {
  it('exporting a genuinely-terminal honest run (green today) is verbatim, no best-effort-snapshot warning', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-export-honest-'));
    try {
      const runStore = new JsonFileStore(dir);
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const sealed = await runStore.update({
        ...run,
        completed_steps: ['a', 'b'],
        terminal_state: true,
        terminal_reason: 'Workflow completed.',
      });
      const { warning } = await buildExportBundle(sealed.id, {
        runStore,
        failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
        traceBufferStore,
      });
      expect(warning).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a synthetic stale-gate ∧ pending-ledger record surfaces the drain-warning (mutually exclusive with the non-terminal warning)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-export-drain-'));
    try {
      const runStore = new JsonFileStore(dir);
      const traceBufferStore = new JsonTraceBufferStore(dir);
      const run = makeGrandfatheredFixture({
        finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
      });
      await injectRun(dir, run);
      const { warning } = await buildExportBundle(run.id, {
        runStore,
        failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
        traceBufferStore,
      });
      expect(warning).toMatch(/finalizer\(s\) not yet delivered — realm run drain/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('list/inspect render pins (issue #279, increment 2, PR-C)', () => {
  it('list.ts renders the DERIVED phase for a grandfathered G fixture, and shows no live-looking gate line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-list-'));
    try {
      const runStore = new JsonFileStore(dir);
      const run = makeGrandfatheredFixture({});
      await injectRun(dir, run);

      const output = await listRuns(undefined, runStore);
      expect(output).toContain('completed');
      expect(output).not.toContain('gate_waiting');
      expect(output).not.toContain('gate:');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('list.ts --status completed FINDS a grandfathered G fixture (filter derives, never trusts persisted)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-list-filter-'));
    try {
      const runStore = new JsonFileStore(dir);
      const run = makeGrandfatheredFixture({});
      await injectRun(dir, run);

      const output = await listRuns(undefined, runStore, 'completed');
      expect(output).toContain(run.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SAVE_DERIVES_ON_IMPORT (issue #279, increment 2, PR-C)', () => {
  it('a G record imported via save() persists the DERIVED phase on get(); pending_gate itself is NOT stripped (a verbatim import, not a resume)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-282-save-'));
    try {
      await mkdir(dir, { recursive: true });
      const runStore = new JsonFileStore(dir);
      const run = makeGrandfatheredFixture({
        completed_steps: [],
        failed_steps: ['a'],
        terminal_reason: undefined,
      });

      await runStore.save(run);
      const reread = await runStore.get(run.id);

      expect(reread.run_phase).toBe('failed');
      expect(reread.pending_gate).toBeDefined(); // NOT stripped — save() is a verbatim import
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
