// drain-purge-integration.test.ts — verification item 3 (issue #279, increment 1, PR-B): the
// full recovery-closure loop — purge refuses `drain_pending` on a terminal run with an undrained
// finalizer (every mode, including single-id --force), and after an operator `--void` (via
// `runDrainAction`, the real drain-command logic), purge proceeds normally.
//
// `purgeRuns` (unlike `purgeCommand`) and `runDrainAction` (unlike driving `drainCommand` via
// `.parseAsync`) both take EXPLICIT store parameters — the established purge.test.ts precedent,
// now matched by drain.ts (see drain.ts's file-header note and drain.test.ts's header note for the
// full account of why a `$HOME`-override + `drainCommand.parseAsync(...)` test is unreliable here:
// `drain.ts` statically imports `loadProjectExtensions`, which itself has a top-level VALUE import
// of `@sensigo/realm` — eagerly capturing JsonFileStore's `DEFAULT_RUNS_DIR` at module-load time,
// before any `beforeEach` can override `$HOME`. Confirmed empirically: an earlier, $HOME-override
// draft of this test silently read/wrote the REAL `~/.realm/runs` instead of a temp dir). Neither
// function here relies on `$HOME` or any default at all — both take an explicit store — so a
// static top-level import is safe.
// issue #285 (2026-08-13): the capture itself is now fixed at the root — `DEFAULT_RUNS_DIR` no
// longer exists; the default resolves at CONSTRUCTION time (drain.ts's header has the full
// account). Historicized here only — this file's explicit-store approach is unaffected either way.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  JsonFileStore,
  JsonWorkflowStore,
  drainFinalizers,
  captureEvidence,
  DRAIN_LEASE_MAX,
} from '@sensigo/realm';
import { runDrainAction, type DrainRuntimeDeps } from './drain.js';
import { purgeRuns } from './purge.js';

const DEPS: DrainRuntimeDeps = { drainFinalizers, captureEvidence, drainLeaseMax: DRAIN_LEASE_MAX };

describe('purge ⟷ drain recovery closure (issue #279, increment 1, PR-B, verification item 3)', () => {
  let dir: string;
  let runsDir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-drain-purge-'));
    runsDir = join(dir, 'runs');
    await mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('purge refuses drain_pending (single-id --force included) → --void (via runDrainAction) → purge proceeds', async () => {
    const anchorStore = new JsonFileStore(runsDir);
    const workflowStore = new JsonWorkflowStore(join(dir, 'workflows'));
    const { run } = await anchorStore.create({
      workflowId: 'drain-purge-wf',
      workflowVersion: 1,
      params: {},
    });
    await anchorStore.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    // 1. purge (dry-run) reports it, but does not delete.
    const dryRunResult = await purgeRuns({ runId: run.id, dryRun: true }, anchorStore, []);
    expect(dryRunResult.selected.length + dryRunResult.skipped.length).toBeGreaterThan(0);
    expect(existsSync(join(runsDir, `${run.id}.json`))).toBe(true);

    // 2. purge --force (dryRun:false) STILL refuses — drain_pending is not force-bypassable.
    const forcedResult = await purgeRuns({ runId: run.id, dryRun: false }, anchorStore, []);
    expect(forcedResult.blocked).toHaveLength(1);
    expect(forcedResult.blocked[0]?.reason).toContain('drain_pending');
    expect(existsSync(join(runsDir, `${run.id}.json`))).toBe(true); // survives intact

    // 3. Operator voids the finalizer via `runDrainAction` (the same logic `realm run drain
    // --void` wires, driven directly against the explicit anchorStore — no $HOME involved).
    await runDrainAction(run.id, { void: 'fin' }, anchorStore, workflowStore, DEPS);
    const afterVoid = await anchorStore.get(run.id);
    expect(afterVoid.finalizer_ledger?.['fin']?.status).toBe('voided');

    // 4. purge --force now proceeds — no pending entries left.
    const finalResult = await purgeRuns({ runId: run.id, dryRun: false }, anchorStore, []);
    expect(finalResult.purged).toContain(run.id);
    expect(existsSync(join(runsDir, `${run.id}.json`))).toBe(false);
  });
});
