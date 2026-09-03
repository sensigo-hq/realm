// Tests for `realm run drain` (issue #279, increment 1, PR-B) — the classifier's four rank-pass
// classes (pure unit tests), plus the full command behavior (--void / --all / per-run dry-run and
// --force) driven directly through `runDrainAction` against an EXPLICITLY-constructed store.
//
// issue #279 (increment 1, PR-B) — CORRECTED test-isolation approach: an earlier draft of this
// file drove `drainCommand.parseAsync(...)` under a `$HOME` override (mirroring abandon.test.ts).
// That is UNRELIABLE for `drain.ts` specifically: `drain.ts` statically imports
// `loadProjectExtensions`, which itself has a top-level VALUE import of `@sensigo/realm` — so
// merely importing anything from `drain.js` (even dynamically, even mid-test) eagerly evaluates
// `@sensigo/realm`'s module graph, including JsonFileStore's module-load-time
// `DEFAULT_RUNS_DIR = join(homedir(), ...)` capture. Confirmed empirically: an isolated run of the
// (now-replaced) $HOME-override version of these tests silently wrote real run files into the
// ACTUAL `~/.realm/runs` (verified via file timestamps/content, then cleaned up) — the seeding
// store and `drainCommand`'s internal store both resolved to the same frozen-wrong default, so the
// tests still "passed" while polluting real user data. `runDrainAction` (drain.ts) now takes
// `runStore`/`workflowStore`/its three `@sensigo/realm` runtime values as EXPLICIT parameters —
// tests below construct `new JsonFileStore(tmpDir)` with an EXPLICIT directory and inject
// `drainFinalizers`/`captureEvidence`/`DRAIN_LEASE_MAX` directly, never relying on `$HOME` or any
// default at all. A static top-level import of `@sensigo/realm` is therefore safe here (no
// `$HOME`-timing dependency exists to defeat).
// issue #285 (2026-08-13): the capture itself is now fixed at the root — `DEFAULT_RUNS_DIR` no
// longer exists; the default resolves at CONSTRUCTION time (drain.ts's header has the full
// account). Historicized here only — this file's explicit-directory approach is unaffected either
// way.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  drainFinalizers,
  captureEvidence,
  DRAIN_LEASE_MAX,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { RunRecord, WorkflowDefinition } from '@sensigo/realm';
import {
  classifyDrainRankPass,
  isBatchActionable,
  runDrainAction,
  type DrainRuntimeDeps,
} from './drain.js';

const NOW = new Date('2026-07-08T12:00:00.000Z');
const past = new Date(NOW.getTime() - 60_000).toISOString();
const future = new Date(NOW.getTime() + 60_000).toISOString();
// The CLI-level describe block below drives the REAL action function, which reads the REAL system
// clock (`new Date()`), not the fixed NOW above — its fixtures must be relative to Date.now().
const realFuture = new Date(Date.now() + 60_000).toISOString();

const DEPS: DrainRuntimeDeps = { drainFinalizers, captureEvidence, drainLeaseMax: DRAIN_LEASE_MAX };

function makeRun(over: Partial<RunRecord>): RunRecord {
  return {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'completed',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: true,
    sealed_by: { arm: 'complete' },
    ...over,
  };
}

describe('classifyDrainRankPass — the four rank-pass classes (issue #279, increment 1, PR-B)', () => {
  it('empty ledger ⇒ zero entries (caller renders no_pendings)', () => {
    expect(classifyDrainRankPass(undefined, NOW)).toEqual([]);
    expect(classifyDrainRankPass({}, NOW)).toEqual([]);
  });

  it('a single never-leased pending entry ⇒ actionable', () => {
    const entries = classifyDrainRankPass({ fin: { status: 'pending', rank: 0 } }, NOW);
    expect(entries).toEqual([{ name: 'fin', rank: 0, class: 'actionable' }]);
  });

  it('a single EXPIRED-lease pending entry ⇒ actionable (not lease_held)', () => {
    const entries = classifyDrainRankPass(
      { fin: { status: 'pending', rank: 0, lease_token: 'dead', lease_deadline: past } },
      NOW,
    );
    expect(entries).toEqual([{ name: 'fin', rank: 0, class: 'actionable' }]);
  });

  it('a single UNEXPIRED-lease pending entry ⇒ lease_held', () => {
    const entries = classifyDrainRankPass(
      { fin: { status: 'pending', rank: 0, lease_token: 'live', lease_deadline: future } },
      NOW,
    );
    expect(entries).toEqual([
      { name: 'fin', rank: 0, class: 'lease_held', lease_deadline: future },
    ]);
  });

  it('a held lease at rank 0 blocks EVERY higher-ranked pending entry (rank_blocked_behind_held_lease) — R11', () => {
    const entries = classifyDrainRankPass(
      {
        first: { status: 'pending', rank: 0, lease_token: 'live', lease_deadline: future },
        second: { status: 'pending', rank: 1 },
        third: { status: 'pending', rank: 2 },
      },
      NOW,
    );
    expect(entries.map((e) => e.class)).toEqual([
      'lease_held',
      'rank_blocked_behind_held_lease',
      'rank_blocked_behind_held_lease',
    ]);
  });

  it('multiple actionable entries before any held lease are ALL actionable', () => {
    const entries = classifyDrainRankPass(
      {
        first: { status: 'pending', rank: 0 },
        second: { status: 'pending', rank: 1 },
      },
      NOW,
    );
    expect(entries.map((e) => e.class)).toEqual(['actionable', 'actionable']);
  });

  it('non-pending entries (completed/failed/voided) are excluded entirely', () => {
    const entries = classifyDrainRankPass(
      {
        done: { status: 'completed', rank: 0 },
        gone: { status: 'voided', rank: 1 },
        actionable: { status: 'pending', rank: 2 },
      },
      NOW,
    );
    expect(entries).toEqual([{ name: 'actionable', rank: 2, class: 'actionable' }]);
  });
});

describe('isBatchActionable', () => {
  it('true when at least one pending entry is actionable', () => {
    expect(
      isBatchActionable(
        makeRun({ finalizer_ledger: { fin: { status: 'pending', rank: 0 } } }),
        NOW,
      ),
    ).toBe(true);
  });

  it('false when the only pending entry is lease_held', () => {
    const run = makeRun({
      finalizer_ledger: {
        fin: { status: 'pending', rank: 0, lease_token: 'live', lease_deadline: future },
      },
    });
    expect(isBatchActionable(run, NOW)).toBe(false);
  });

  it('false when there is no ledger at all', () => {
    expect(isBatchActionable(makeRun({}), NOW)).toBe(false);
  });
});

describe('runDrainAction (issue #279, increment 1, PR-B) — explicit store injection, no $HOME reliance', () => {
  let dir: string;
  let store: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-drain-cli-'));
    store = new JsonFileStore(dir);
    workflowStore = new JsonWorkflowStore(join(dir, 'workflows'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  const wf: WorkflowDefinition = {
    id: 'drain-wf',
    name: 'Drain WF',
    version: 1,
    steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
  };

  it('dry-run (default, no --force) renders the rank-pass classes and mutates nothing', async () => {
    await workflowStore.register(wf);
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    await runDrainAction(run.id, {}, store, workflowStore, DEPS);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('actionable'))).toBe(
      true,
    );
    const reloaded = await store.get(run.id);
    expect(reloaded.finalizer_ledger?.['fin']?.status).toBe('pending'); // untouched
  });

  it('a non-terminal run reports "nothing to drain" and mutates nothing', async () => {
    await workflowStore.register(wf);
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });

    await runDrainAction(run.id, {}, store, workflowStore, DEPS);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('not terminal'))).toBe(
      true,
    );
  });

  it('--void voids a pending finalizer with operator-provenance evidence and the never-leased disclosure', async () => {
    await workflowStore.register(wf);
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    await runDrainAction(run.id, { void: 'fin' }, store, workflowStore, DEPS);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('never executed'))).toBe(
      true,
    );
    const reloaded = await store.get(run.id);
    expect(reloaded.finalizer_ledger?.['fin']?.status).toBe('voided');
    const voidEvidence = reloaded.evidence.find((e) => e.step_id === 'fin');
    expect(voidEvidence).toBeDefined();
    expect(voidEvidence?.output_summary?.['provenance']).toBe('operator');
  });

  it('--void refuses on an unexpired lease — not force-bypassable', async () => {
    await workflowStore.register(wf);
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: {
        fin: { status: 'pending', rank: 0, lease_token: 'live', lease_deadline: realFuture },
      },
    });

    await expect(
      runDrainAction(run.id, { void: 'fin' }, store, workflowStore, DEPS),
    ).rejects.toThrow('process.exit');
    expect(
      errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('active drain lease')),
    ).toBe(true);
    const reloaded = await store.get(run.id);
    expect(reloaded.finalizer_ledger?.['fin']?.status).toBe('pending');
  });

  it('--force actually drains a terminal run with an actionable finalizer', async () => {
    await workflowStore.register({
      id: 'drain-wf',
      name: 'Drain WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        work: { description: 'w', execution: 'agent', depends_on: [] },
        fin: {
          description: 'f',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'fin-handler',
        },
      },
    });
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    const registry = new ExtensionRegistry();
    registry.register('handler', 'fin-handler', {
      id: 'fin-handler',
      execute: async () => ({ data: {} }),
    });
    await runDrainAction(run.id, { force: true }, store, workflowStore, {
      ...DEPS,
      resolveRegistry: async () => registry,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('Drained run'))).toBe(
      true,
    );
    const reloaded = await store.get(run.id);
    expect(reloaded.finalizer_ledger?.['fin']?.status).toBe('completed');
  });

  it('--all batch mode drains every actionable run and reports the tally', async () => {
    await workflowStore.register({
      id: 'drain-wf',
      name: 'Drain WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        work: { description: 'w', execution: 'agent', depends_on: [] },
        fin: {
          description: 'f',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'fin-handler',
        },
      },
    });
    const { run: run1 } = await store.create({
      workflowId: 'drain-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run1,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });
    const { run: run2 } = await store.create({
      workflowId: 'drain-wf',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run2,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    const registry = new ExtensionRegistry();
    registry.register('handler', 'fin-handler', {
      id: 'fin-handler',
      execute: async () => ({ data: {} }),
    });
    await runDrainAction(undefined, { all: true, force: true }, store, workflowStore, {
      ...DEPS,
      resolveRegistry: async () => registry,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('Drained 2/2'))).toBe(
      true,
    );
    const reloaded1 = await store.get(run1.id);
    const reloaded2 = await store.get(run2.id);
    expect(reloaded1.finalizer_ledger?.['fin']?.status).toBe('completed');
    expect(reloaded2.finalizer_ledger?.['fin']?.status).toBe('completed');
  });

  it('C6 (issue #456) single --force, workflow absent: the banner composition carries the remedy as ONE line', async () => {
    // NOT registered — the workflow_id resolves to nothing. resolveRegistry's OWN throw is what
    // must now carry the remedy — DEPS (below) carries no resolveRegistry override, so the real
    // one (drain.ts's default) runs.
    const { run } = await store.create({ workflowId: 'dev456', workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    await expect(
      runDrainAction(run.id, { force: true }, store, workflowStore, DEPS),
    ).rejects.toThrow('process.exit');

    // ONE line — two independent toContains over the joined stderr would pass split lines, so
    // this checks a SINGLE call carries every fragment.
    const calls: string[] = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      calls.some(
        (line: string) =>
          line.includes(
            `Error loading extensions: Workflow not found: ${run.workflow_id} — most often`,
          ) &&
          line.includes('most often') &&
          line.includes('drain again.'),
      ),
    ).toBe(true);
    // NESTED-EXIT ARTIFACT (the #466 class, this file's :432-434 precedent comment): assert the
    // call, never the count.
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('C7 (issue #456) batch --all --force, TWO workflow-absent runs: both ✗ lines carry the remedy', async () => {
    const { run: run1 } = await store.create({
      workflowId: 'dev456-a',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run1,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });
    const { run: run2 } = await store.create({
      workflowId: 'dev456-b',
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run2,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    await runDrainAction(undefined, { all: true, force: true }, store, workflowStore, DEPS);

    // The verb conjunct is what mutant (iv) reds — a `most often`-only pin stays green under a
    // verb swap, so both fragments are required on EACH run's line.
    const calls: string[] = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    for (const run of [run1, run2]) {
      expect(
        calls.some(
          (line: string) =>
            line.includes(`  ✗ ${run.id}: Error loading extensions: Workflow not found`) &&
            line.includes('most often') &&
            line.includes('drain again.'),
        ),
      ).toBe(true);
    }
    expect(
      logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('Drained 0/2 run(s).')),
    ).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('D1 (issue #466) single --force: a module that cannot be resolved reports `Error loading extensions:`', async () => {
    // Red-first on main: the raw resolver message, no prefix — `Cannot resolve extension module
    // …`, exit 1. run/validate/register/watch/agent/respond already named this failure.
    await workflowStore.register({
      id: 'drain-wf',
      name: 'Drain WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        work: { description: 'w', execution: 'agent', depends_on: [] },
        fin: {
          description: 'f',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'fin-handler',
        },
      },
    });
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    await expect(
      runDrainAction(run.id, { force: true }, store, workflowStore, {
        ...DEPS,
        resolveRegistry: async () => {
          throw new Error("Cannot resolve extension module './nope.js'");
        },
      }),
    ).rejects.toThrow('process.exit');

    const errored = errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(errored).toMatch(/^Error loading extensions: Cannot resolve extension module/m);
    expect(errored).not.toMatch(/^Cannot resolve extension module/m);
    // NESTED-EXIT ARTIFACT (the #466 class): the inner catch's process.exit(1) throws under this
    // mock into the outer catch, which re-prints and exits again — production-neutral. Assert the
    // call, never the count.
    expect(exitSpy).toHaveBeenCalledWith(1);
    const reloaded = await store.get(run.id);
    expect(reloaded.finalizer_ledger?.['fin']?.status).toBe('pending');
  });

  it('D2 (issue #466) batch finalizer arm: `Error loading extensions:` per-run, counted as not-drained', async () => {
    await workflowStore.register({
      id: 'drain-wf',
      name: 'Drain WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        work: { description: 'w', execution: 'agent', depends_on: [] },
        fin: {
          description: 'f',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'fin-handler',
        },
      },
    });
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    await store.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });

    await runDrainAction(undefined, { all: true, force: true }, store, workflowStore, {
      ...DEPS,
      resolveRegistry: async () => {
        throw new Error("Cannot resolve extension module './nope.js'");
      },
    });

    // Two-space indent — a substring pin, never `^✗`-anchored (the drain family's own idiom).
    expect(
      errSpy.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes(
          `  ✗ ${run.id}: Error loading extensions: Cannot resolve extension module './nope.js'`,
        ),
      ),
    ).toBe(true);
    expect(
      logSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('Drained 0/1 run(s).')),
    ).toBe(true);
    // No exit for a batch failure — the #478 line: only a per-run continue.
    expect(exitSpy).not.toHaveBeenCalled();
    const reloaded = await store.get(run.id);
    expect(reloaded.finalizer_ledger?.['fin']?.status).toBe('pending');
  });

  it('D2b (issue #466) batch gate-enact arm: the enactment stays counted, only the drain fails', async () => {
    // The per-member cell: the batch has TWO resolution sites (finalizer arm, gate-enact arm),
    // and D2 alone leaves the gate arm's split invisible to a mutant. This arm's resolve is
    // CONDITIONAL — reached only when the expiry enactment itself terminalizes the run with an
    // actionable finalizer ledger — so the fixture is a gate step whose `settle_default` expiry
    // is the run's LAST step, plus a sibling `execution: finalizer` step (`on_outcome: 'always'`)
    // so the terminal seal mints a pending ledger entry via mintFresh. Reachability was confirmed
    // by execution BEFORE this cell was written, with a WORKING registry: the ledger mints, and
    // isBatchActionable goes true.
    //
    // Red-first (today's shape, MA-executed): `  ✓ <id>: gate enacted` (already printed — the
    // enactment ran and counted BEFORE the resolve that fails) then `  ✗ <id>: Cannot resolve …`
    // (raw, no prefix), then `Drained 1/1 run(s).` — the enactment stays counted even though the
    // finalizer never drained.
    const gatedFinWf: WorkflowDefinition = {
      id: 'drain-expired-fin-wf',
      name: 'Drain Expired Fin WF',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        approve: { description: 'a', execution: 'auto', depends_on: [], handler: 'h' },
        fin: {
          description: 'f',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'fin-handler',
        },
      },
    };
    await workflowStore.register(gatedFinWf);
    const { run } = await store.create({
      workflowId: gatedFinWf.id,
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run,
      in_progress_steps: ['approve'],
      claims: { approve: { deadline: null } },
      pending_gate: {
        gate_id: 'gate-1',
        step_name: 'approve',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-01T00:05:00.000Z',
        on_expiry: 'settle_default',
        default_choice: 'approve',
      },
    });

    await runDrainAction(
      undefined,
      { all: true, expired: true, force: true },
      store,
      workflowStore,
      {
        ...DEPS,
        resolveRegistry: async () => {
          throw new Error("Cannot resolve extension module './nope.js'");
        },
      },
    );

    const logged: string[] = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(logged.some((l: string) => l.includes(`  ✓ ${run.id}: gate enacted`))).toBe(true);
    expect(logged.some((l: string) => l.includes('Drained 1/1 run(s).'))).toBe(true);
    expect(
      errSpy.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes(
          `  ✗ ${run.id}: Error loading extensions: Cannot resolve extension module './nope.js'`,
        ),
      ),
    ).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    const reloaded = await store.get(run.id);
    expect(reloaded.terminal_state).toBe(true);
    expect(reloaded.pending_gate).toBeUndefined();
    // The drain itself failed — the ledger entry never advanced past pending.
    expect(reloaded.finalizer_ledger?.['fin']?.status).toBe('pending');
  });
});
