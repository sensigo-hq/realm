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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  abandonRun,
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

  // issue #558 PR-C (walk 2 fold X1): this fixture carried no `schema_version`, so PR-T's registrar
  // read it back as a LEGACY copy and the dry run — correctly — said it could not read it. A
  // registered copy in these cells is a current one; the dry run reads it and labels `fin` as the
  // finalizer `wf` never declares.
  const wf: WorkflowDefinition = {
    id: 'drain-wf',
    name: 'Drain WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
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
    // issue #558 PR-C (walk 1): `wf` declares NO finalizer, so the rank-pass class `actionable`
    // renders as the honest per-finalizer label — the copy reads, and `fin` is not in it.
    expect(
      logSpy.mock.calls.some((c: unknown[]) =>
        String(c[0]).includes('NOT declared by the workflow definition'),
      ),
    ).toBe(true);
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
    // NOT registered — the workflow_id resolves to nothing. the definition fetch's OWN throw (outside the extensions try — review fold C5) is what
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
          line.startsWith(`Workflow not found: ${run.workflow_id} — most often`) &&
          !line.includes('Error loading extensions') && // review fold C5: the heading was false
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
            line.includes(`  ✗ ${run.id}: Workflow not found`) &&
            !line.includes('Error loading extensions') && // review fold C5
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

// issue #558 PR-C (C-3 + C-5): the disposal surfaces say what the record says.
// C-3 — the non-terminal sentences render the DERIVED phase and carry the way out.
// C-5 — a pass that left a finalizer pending names the void command PER finalizer and exits 1;
//       a pass that leased nothing and had nothing to lease says so instead of `Drained run`.
describe('realm run drain — disposal coherence (issue #558 PR-C)', () => {
  let dir: string;
  let store: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-drain-558c-'));
    store = new JsonFileStore(dir);
    workflowStore = new JsonWorkflowStore(join(dir, 'workflows'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The house idiom throws on ANY exit — which cannot tell exit(1) from exit(0). This PR CHANGES
    // an exit code on an operator surface (`--stuck`-driven CI gates read it), so the cells below
    // assert the CODE, not merely that some exit happened. Executed: with a bare
    // `rejects.toThrow('process.exit')`, forcing the left-pending arm to `process.exit(0)` left
    // every cell in this file green.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number): never => {
      throw new Error(`process.exit:${String(code)}`);
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
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { work: { description: 'w', execution: 'agent', depends_on: [] } },
  };

  const logs = (): string[] => logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  const errs = (): string[] => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));

  // ---- C-3: the DERIVED phase, and the way out -----------------------------------------------

  /**
   * The G2 fixture — PERSISTED `run_phase: 'completed'` with `terminal_state: false`, so the label
   * and the derived phase (`running`) DISAGREE. It has to be planted as RAW BYTES: every store
   * write tail re-derives `run_phase` (PHASE_IS_GENERATED, the #282 class), so a
   * `store.update({ ...run, run_phase: 'completed' })` lands as `running` and the two agree again —
   * a cell built that way passes with the persisted label restored and pins NOTHING. Executed: the
   * `${run.run_phase}` mutant left the whole file green until this fixture was planted directly.
   */
  async function plantDivergentRun(): Promise<RunRecord> {
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    const planted: RunRecord = { ...run, run_phase: 'completed', terminal_state: false };
    await writeFile(join(dir, `${run.id}.json`), JSON.stringify(planted, null, 2), 'utf8');
    const readBack = await store.get(run.id);
    // The premise the cells below rest on, asserted rather than assumed.
    expect(readBack.run_phase).toBe('completed');
    expect(readBack.terminal_state).toBe(false);
    return readBack;
  }

  it('C-3 dry-run: a non-terminal run prints the DERIVED phase and the way out, whole', async () => {
    await workflowStore.register(wf);
    const run = await plantDivergentRun();

    await runDrainAction(run.id, {}, store, workflowStore, DEPS);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logs()).toContain(
      `Run '${run.id}' is not terminal (phase: 'running') — nothing to drain. ` +
        `To end the run: realm run abandon ${run.id}.`,
    );
  });

  it('C-3 --force: the same sentence on stderr, exit 1 kept', async () => {
    await workflowStore.register(wf);
    const run = await plantDivergentRun();

    await expect(
      runDrainAction(run.id, { force: true }, store, workflowStore, DEPS),
    ).rejects.toThrow('process.exit:1');
    // The FIRST exit call is the one this arm made. `runDrainAction`'s body sits inside a
    // try/catch that itself exits 1, and the spy's throw lands in that catch — so
    // `toHaveBeenCalledWith(1)` passes even when this arm exits 0 (executed: forcing
    // `process.exit(0)` here left every cell in the file green). Only the first call discriminates.
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1);

    expect(errs()).toContain(
      `Run '${run.id}' is not terminal (phase: 'running') — nothing to drain. ` +
        `To end the run: realm run abandon ${run.id}.`,
    );
  });

  // ---- C-5: left-pending names the escape per finalizer ---------------------------------------

  async function seedUndeclaredFinalizers(names: string[]): Promise<RunRecord> {
    await workflowStore.register(wf); // `wf` declares NO finalizer — every ledger entry is unrunnable
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    const ledger = Object.fromEntries(
      names.map((n, i) => [n, { status: 'pending' as const, rank: i }]),
    );
    return await store.update({
      ...run,
      run_phase: 'failed',
      terminal_state: true,
      sealed_by: { arm: 'step_failure' },
      terminal_reason: 'boom',
      finalizer_ledger: ledger,
    });
  }

  it('C-5 arm (a): one left-pending finalizer ⇒ the named escape + exit 1, ledger untouched', async () => {
    const run = await seedUndeclaredFinalizers(['fin']);

    await expect(
      runDrainAction(run.id, { force: true }, store, workflowStore, DEPS),
    ).rejects.toThrow('process.exit:1');
    // The FIRST exit call is the one this arm made. `runDrainAction`'s body sits inside a
    // try/catch that itself exits 1, and the spy's throw lands in that catch — so
    // `toHaveBeenCalledWith(1)` passes even when this arm exits 0 (executed: forcing
    // `process.exit(0)` here left every cell in the file green). Only the first call discriminates.
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1);

    expect(logs()).toContain(
      `Run '${run.id}' — nothing drained; 1 finalizer(s) left pending: fin. To void:`,
    );
    expect(logs()).toContain(`  realm run drain ${run.id} --void fin --force`);
    expect(logs().some((l) => l === `Drained run '${run.id}'.`)).toBe(false);
    const reloaded = await store.get(run.id);
    expect(reloaded.finalizer_ledger?.['fin']?.status).toBe('pending');
  });

  it('C-5 arm (a): TWO left-pending finalizers ⇒ TWO void lines, each with its own name', async () => {
    // `drainFinalizers` HALTS at the first unrunnable finalizer (R11), so `fin2` behind it is left
    // pending too. Naming only the halted-on one sent the operator round the loop once per
    // finalizer (the round-1 audit executed it: `--stuck` still listed `fin2`).
    const run = await seedUndeclaredFinalizers(['fin', 'fin2']);

    await expect(
      runDrainAction(run.id, { force: true }, store, workflowStore, DEPS),
    ).rejects.toThrow('process.exit:1');
    // The FIRST exit call is the one this arm made. `runDrainAction`'s body sits inside a
    // try/catch that itself exits 1, and the spy's throw lands in that catch — so
    // `toHaveBeenCalledWith(1)` passes even when this arm exits 0 (executed: forcing
    // `process.exit(0)` here left every cell in the file green). Only the first call discriminates.
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1);

    expect(logs()).toContain(
      `Run '${run.id}' — nothing drained; 2 finalizer(s) left pending: fin, fin2. To void:`,
    );
    // walk 2: one ⚠ for the halted-on finalizer read as "fin2 was handled" — each left-behind
    // finalizer gets its own line with the reason it was never reached.
    expect(logs()).toContain(
      `  ⚠ finalizer 'fin2' left pending — not declared by the workflow definition (nothing can run it; void it); it also sits behind 'fin' in rank order`,
    );
    expect(logs()).toContain(`  realm run drain ${run.id} --void fin --force`);
    expect(logs()).toContain(`  realm run drain ${run.id} --void fin2 --force`);
  });

  it('C-5 arm (b): a run with NO ledger says "nothing to drain", never "Drained run"', async () => {
    // The abandoned-run case: `sealRunLevel` mints no `finalizer_ledger` at all, so the pass
    // leases nothing and leaves nothing pending. Saying `Drained run` here contradicted the
    // abandon output one line earlier ("declared finalizers did NOT run and will not").
    await workflowStore.register(wf);
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    const abandoned = await abandonRun(store, run.id, 'Abandoned via realm run abandon');
    expect(abandoned.finalizer_ledger).toBeUndefined();

    await runDrainAction(run.id, { force: true }, store, workflowStore, DEPS);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logs()).toContain(`Run '${run.id}' has no pending finalizers. Nothing to drain.`);
    expect(logs().some((l) => l.startsWith('Drained run'))).toBe(false);
  });

  it('C-5 arm (b): the dry-run twin renders the IDENTICAL sentence (one mint, two sites)', async () => {
    await workflowStore.register(wf);
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    await abandonRun(store, run.id, 'Abandoned via realm run abandon');

    await runDrainAction(run.id, {}, store, workflowStore, DEPS);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(logs()).toContain(`Run '${run.id}' has no pending finalizers. Nothing to drain.`);
  });

  it('C-5 arm (c) CONTROL: a pass that actually ran a finalizer still says `Drained run`', async () => {
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
    expect(logs()).toContain(`Drained run '${run.id}'.`);
  });

  // ---- issue #558 PR-C (walk): the dry run predicts what --force will do, per finalizer --------

  const finWf = () =>
    workflowStore.register({
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
  async function seedLedger(ledger: Record<string, number>): Promise<RunRecord> {
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    return await store.update({
      ...run,
      run_phase: 'completed',
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      finalizer_ledger: Object.fromEntries(
        Object.entries(ledger).map(([n, rank]) => [n, { status: 'pending' as const, rank }]),
      ),
    });
  }
  const finHandlerRegistry = () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'fin-handler', {
      id: 'fin-handler',
      execute: async () => ({ data: {} }),
    });
    return registry;
  };

  it('dry run: a pending finalizer the workflow does NOT declare is named as such, with its void command', async () => {
    // The walker's RED: the dry run said "would lease, execute, and mark on --force" for `fin`,
    // then --force halted on it. The dry run reads the registered copy (a JSON read) and says so.
    const run = await seedUndeclaredFinalizers(['fin']);
    await runDrainAction(run.id, {}, store, workflowStore, DEPS);
    expect(logs()).toContain(
      `  • [0] fin: NOT declared by the workflow definition — --force would leave it pending; to void it: realm run drain ${run.id} --void fin --force`,
    );
    expect(logs().some((l) => l.includes('would lease'))).toBe(false);
    // walk 3: no listed finalizer is declared — the footer must not invite a --force that drains
    // nothing.
    expect(logs()).toContain(
      `\n--force would drain nothing here: no listed finalizer is declared by the workflow. Use --void <finalizer> --force to void each one.`,
    );
    expect(logs().some((l) => l.includes('Re-run with --force'))).toBe(false);
  });

  it('dry run: a DECLARED pending finalizer is predicted honestly (conditional on its handler resolving)', async () => {
    await finWf();
    const run = await seedLedger({ fin: 0 });
    await runDrainAction(run.id, {}, store, workflowStore, DEPS);
    expect(logs()).toContain(
      `  • [0] fin: actionable — would lease and run on --force, if its handler resolves on this surface`,
    );
    // The default footer arm, pinned POSITIVELY (its two siblings had cells; this one had only
    // absence guards — the per-member sweep's find).
    expect(logs()).toContain(
      `\nRe-run with --force to actually drain. Use --void <finalizer> to void one instead.`,
    );
  });

  it('--force: a DECLARED finalizer behind an undeclared halted one is reported as behind it, in rank order', async () => {
    // The declared-behind arm of the halt warning (its undeclared-behind sibling is pinned by the
    // two-finalizer cell). `ghost` (rank 0, undeclared) halts the pass; `fin` (rank 1, declared,
    // runnable) is never reached — its line says why.
    await finWf();
    const run = await seedLedger({ ghost: 0, fin: 1 });
    await expect(
      runDrainAction(run.id, { force: true }, store, workflowStore, {
        ...DEPS,
        resolveRegistry: async () => finHandlerRegistry(),
      }),
    ).rejects.toThrow('process.exit:1');
    expect(logs()).toContain(
      `  ⚠ finalizer 'ghost' left pending — not declared by the workflow definition (nothing can run it; void it)`,
    );
    expect(logs()).toContain(
      `  ⚠ finalizer 'fin' left pending — behind 'ghost' in rank order (the pass halts there)`,
    );
    expect(logs()).toContain(
      `Run '${run.id}' — nothing drained; 2 finalizer(s) left pending: ghost, fin. To void:`,
    );
  });

  it('dry run: when the workflow copy cannot be read, say so and still list the ledger — never predict blind', async () => {
    // No registration at all → getWorkflowForRun refuses (PR-T's composed refusal) → the dry run
    // discloses the unknown and points at inspect, then lists the ledger without a prediction.
    const { run: fresh } = await store.create({
      workflowId: 'drain-wf',
      workflowVersion: 1,
      params: {},
    });
    const run = await store.update({
      ...fresh,
      run_phase: 'failed',
      terminal_state: true,
      sealed_by: { arm: 'step_failure' },
      terminal_reason: 'boom',
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });
    await runDrainAction(run.id, {}, store, workflowStore, DEPS);
    expect(logs()).toContain(
      `⚠ could not read this run's workflow copy, so which finalizers it declares is unknown — realm run inspect ${run.id} shows the reason.`,
    );
    // walk 2: after saying it could not check, the dry run must not predict — --force would
    // REFUSE (Workflow not found), and the screen had said "re-run with --force".
    expect(logs()).toContain(
      `  • [0] fin: unknown — the workflow copy could not be read, so --force will refuse until it is repaired; to void it instead: realm run drain ${run.id} --void fin --force`,
    );
    expect(logs()).toContain(
      `\n--force will refuse until the workflow copy reads (realm run inspect ${run.id}). Use --void <finalizer> --force to void one instead.`,
    );
    expect(logs().some((l) => l.includes('would lease') || l.includes('Re-run with --force'))).toBe(
      false,
    );
  });

  // ---- issue #558 PR-C (walk 2): the non-terminal way out is forked on the gate ---------------

  async function seedGateWaiting(): Promise<RunRecord> {
    await workflowStore.register(wf);
    const { run } = await store.create({ workflowId: 'drain-wf', workflowVersion: 1, params: {} });
    return await store.update({
      ...run,
      pending_gate: {
        gate_id: 'g-approve-1',
        step_name: 'review',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: new Date().toISOString(),
      },
    });
  }

  it('a gate-waiting run: the way out names the answer command FIRST, then abandon — on the dry run and on --force', async () => {
    // walk 2 RED: `To end the run: realm run abandon <id>` on a gate-waiting run named a command
    // that refuses on the next line (abandon refuses a run waiting on a human gate).
    const run = await seedGateWaiting();
    const expected =
      `Run '${run.id}' is not terminal (phase: 'gate_waiting') — nothing to drain. ` +
      `Answer its gate first: realm run respond ${run.id} --gate g-approve-1 --choice <one of: approve, reject>; then realm run abandon ${run.id}.`;
    await runDrainAction(run.id, {}, store, workflowStore, DEPS);
    expect(logs()).toContain(expected);
    await expect(
      runDrainAction(run.id, { force: true }, store, workflowStore, DEPS),
    ).rejects.toThrow('process.exit:1');
    expect(errs()).toContain(expected);
  });

  it('the #432-class divergent record (persisted gate_waiting, no pending_gate): the way out is abandon — there is no gate to answer', async () => {
    await workflowStore.register(wf);
    const { run: fresh } = await store.create({
      workflowId: 'drain-wf',
      workflowVersion: 1,
      params: {},
    });
    await writeFile(
      join(dir, `${fresh.id}.json`),
      JSON.stringify({ ...fresh, run_phase: 'gate_waiting' }, null, 2),
      'utf8',
    );
    await runDrainAction(fresh.id, {}, store, workflowStore, DEPS);
    expect(logs()).toContain(
      // The derived phase is 'running' (nothing supports the persisted label) and the record
      // carries no gate — `abandon` keys on the gate too, so the way out it names is the one that
      // works (walk 3: an "answer its gate" fork on the LABEL stranded the operator).
      `Run '${fresh.id}' is not terminal (phase: 'running') — nothing to drain. ` +
        `To end the run: realm run abandon ${fresh.id}.`,
    );
  });

  it('--force: a pass that RAN one finalizer and left an undeclared one pending says both, and exits 1', async () => {
    // The walker's RED: the summary opened `Drained run` when nothing had drained. The opener
    // forks on `attempted`; the per-finalizer reason is the ⚠ line, and `not declared` is its own
    // reason (a handler-hunt would find nothing).
    await finWf();
    const run = await seedLedger({ fin: 0, fin2: 1 });
    await expect(
      runDrainAction(run.id, { force: true }, store, workflowStore, {
        ...DEPS,
        resolveRegistry: async () => finHandlerRegistry(),
      }),
    ).rejects.toThrow('process.exit:1');
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1);
    expect(logs()).toContain(
      `  ⚠ finalizer 'fin2' left pending — not declared by the workflow definition (nothing can run it; void it)`,
    );
    expect(logs()).toContain(
      `Drained run '${run.id}' (1 ran) — 1 finalizer(s) left pending: fin2. To void:`,
    );
    expect(logs()).toContain(`  realm run drain ${run.id} --void fin2 --force`);
  });

  it('--force: a DECLARED finalizer whose handler is not on this surface keeps the surface-keyed reason', async () => {
    await finWf();
    const run = await seedLedger({ fin: 0 });
    await expect(
      runDrainAction(run.id, { force: true }, store, workflowStore, {
        ...DEPS,
        resolveRegistry: async () => new ExtensionRegistry(),
      }),
    ).rejects.toThrow('process.exit:1');
    expect(logs()).toContain(
      `  ⚠ finalizer 'fin' left pending — handler not available on this surface`,
    );
    expect(logs()).toContain(
      `Run '${run.id}' — nothing drained; 1 finalizer(s) left pending: fin. To void:`,
    );
  });
});
