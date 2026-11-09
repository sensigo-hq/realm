// settlement-282-cli-integration.test.ts — CLI integration pins for the #282 class closure (issue
// #279, increment 2, PR-C — design record §8, "CLI integration"). The G fixtures are seeded through
// the store's `save()` (#616 PR-2c, c10a-2b), bypassing create/update: it keeps the record — its
// `pending_gate` included — and derives `run_phase`, so a stale label cannot outlive the seed on
// either store; the kept cells pin the disclosure and the gate line, never the label.
import { describe, it, expect } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { resumeRun } from './resume.js';
import { buildExportBundle } from './export.js';
import { listRuns } from './list.js';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, deriveRunPhase } from '@sensigo/realm';
import type { RunRecord, WorkflowDefinition } from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

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
    // issue #367: deliberately UNSTAMPED. This factory is seeded through the store's `save()` — the
    // import channel, which takes pre-#367 shapes past create/update's checks (#616 PR-2c, c10a-2b) —
    // and its whole purpose is to be a grandfathered record whose phase must be recovered by
    // `classifyLegacySeal`. A stamp here would decide the phase the test exists to derive.
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

/** Save a G fixture through the store's `save`, its phase the one the store derives (computed
 *  last: a fixture plants no label by hand). */
async function injectRun(store: TempHome['home']['runStore'], run: RunRecord): Promise<void> {
  await store.save({ ...run, run_phase: deriveRunPhase(run) });
}

describe('RESUME_STRIPS_ZOMBIE_GATE / RESUME_ADMITS_GRANDFATHERED (issue #279, increment 2, PR-C)', () => {
  it('resume, through the CLI admission gate, ADMITS a grandfathered G fixture and strips its zombie gate — the disclosure is returned for the CLI to print', async () => {
    const h = await makeTempHome();
    try {
      const runStore = h.home.runStore;
      const workflowStore = h.home.workflowStore;
      await workflowStore.register(def);
      const run = makeGrandfatheredFixture({
        completed_steps: [],
        failed_steps: ['a'],
        terminal_reason: undefined,
        run_phase: 'gate_waiting', // stale — RESUMABLE_PHASES.has(deriveRunPhase(run)) must admit it
      });
      await injectRun(runStore, run);

      const { voided, disclosures } = await resumeRun(run.id, 'a', runStore, workflowStore);

      expect(voided).toEqual([]);
      expect(disclosures).toHaveLength(1);
      expect(disclosures[0]).toMatch(/zombie gate 'stale' on 'a' cleared by resume/);

      const { record: resumed } = await runStore.get(run.id);
      expect(resumed.pending_gate).toBeUndefined();
      expect(resumed.failed_steps).not.toContain('a');
      expect(resumed.terminal_state).toBe(false);
    } finally {
      await h.cleanup();
    }
  });
});

describe('EXPORT_TERMINAL_KEYED (issue #279, increment 2, PR-C)', () => {
  it('exporting a genuinely-terminal honest run (green today) is verbatim, no best-effort-snapshot warning', async () => {
    const h = await makeTempHome();
    try {
      const runStore = h.home.runStore;
      const traceBufferStore = h.home.traceBufferStore;
      const { record: run } = await runStore.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      const { record: sealed } = await runStore.update({
        ...run,
        completed_steps: ['a', 'b'],
        terminal_state: true,
        sealed_by: { arm: 'complete' as const },
        terminal_reason: 'Workflow completed.',
      });
      const { warning } = await buildExportBundle(sealed.id, {
        runStore,
        failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
        traceBufferStore,
      });
      expect(warning).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });
});

describe('list/inspect render pins (issue #279, increment 2, PR-C)', () => {
  it('list.ts renders the DERIVED phase for a grandfathered G fixture, and shows no live-looking gate line', async () => {
    const h = await makeTempHome();
    try {
      const runStore = h.home.runStore;
      const run = makeGrandfatheredFixture({});
      await injectRun(runStore, run);

      const output = await listRuns(undefined, runStore);
      // The derived-phase half is vacuous once `save()` derives (it does today): the gate line is the pin.
      expect(output).toContain('completed');
      expect(output).not.toContain('gate_waiting');
      expect(output).not.toContain('gate:');
    } finally {
      await h.cleanup();
    }
  });
});

describe('SAVE_DERIVES_ON_IMPORT (issue #279, increment 2, PR-C)', () => {
  it('a G record imported via save() persists the DERIVED phase on get(); pending_gate itself is NOT stripped (a verbatim import, not a resume)', async () => {
    const h = await makeTempHome();
    try {
      const runStore = h.home.runStore;
      const run = makeGrandfatheredFixture({
        completed_steps: [],
        failed_steps: ['a'],
        terminal_reason: undefined,
      });

      await runStore.save(run);
      const { record: reread } = await runStore.get(run.id);

      expect(reread.run_phase).toBe('failed');
      expect(reread.pending_gate).toBeDefined(); // NOT stripped — save() is a verbatim import
    } finally {
      await h.cleanup();
    }
  });
});
