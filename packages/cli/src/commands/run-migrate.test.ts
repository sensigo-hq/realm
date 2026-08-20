// run-migrate.test.ts — issue #367 (part 3): the acceptance suite for the migration vehicle.
//
// THIS SUITE EXISTS TO BE A REFUTATION. An earlier revision of this program shipped an acceptance
// test that passed against a vehicle which did nothing at all — green on inertness. So every cell
// here is written to FAIL against an inert sweep, and the red-first run is in the report.
//
// The corpus is seeded through the sanctioned channel — direct `writeFile` into a scratch runsDir
// — because these are pre-#367 shapes the store boundary would refuse if they were written through
// it. That is the point: they are what real legacy records look like.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
import type { RunRecord, RunStore, SealArm } from '@sensigo/realm';
import {
  migrateStampSeals,
  migrateExitCode,
  renderMigrateReport,
  ORDERING_LINE,
} from './run-migrate.js';

let dir: string;
let store: JsonFileStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-migrate-'));
  await mkdir(dir, { recursive: true });
  store = new JsonFileStore(dir);
});

const AT = '2026-01-01T00:00:00.000Z';

/** Seeds a record verbatim — the sanctioned legacy channel. */
async function seed(id: string, fields: Partial<RunRecord>): Promise<RunRecord> {
  const record = {
    id,
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    skip_details: {},
    claims: {},
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: AT,
    updated_at: AT,
    terminal_state: true,
    ...fields,
  } as RunRecord;
  await writeFile(join(dir, `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

async function onDisk(id: string): Promise<RunRecord> {
  return JSON.parse(await readFile(join(dir, `${id}.json`), 'utf8')) as RunRecord;
}

/** Every classifiable legacy shape, with the arm it must receive. */
const SHAPES: Array<[string, Partial<RunRecord>, SealArm, string]> = [
  [
    'complete',
    { terminal_reason: 'Workflow completed.', run_phase: 'completed' },
    'complete',
    'completed',
  ],
  [
    'step-failure',
    { terminal_reason: "Step 'a' failed: boom", failed_steps: ['a'], run_phase: 'failed' },
    'step_failure',
    'failed',
  ],
  // issue #373's multi-failure sentence.
  [
    'multi-failure',
    {
      terminal_reason: '2 steps failed: a ("x"), b ("y").',
      failed_steps: ['a', 'b'],
      run_phase: 'failed',
    },
    'step_failure',
    'failed',
  ],
  [
    'guard-resolution',
    {
      terminal_reason: "Guard step 'g' failed: unresolvable path '$.x'",
      failed_steps: ['g'],
      run_phase: 'failed',
    },
    'guard_resolution_error',
    'failed',
  ],
  // Both #372 startup shapes — these are the REMAP rows: abandoned on disk, failed once stamped.
  ['spawn', { terminal_reason: 'spawn_failed', run_phase: 'abandoned' }, 'spawn_failure', 'failed'],
  [
    'ext-load',
    { terminal_reason: 'extensions_load_failed', run_phase: 'abandoned' },
    'extensions_load_failure',
    'failed',
  ],
  // The reason-LESS abort: marker-only visible.
  ['guard-abort', { aborted_at: { step_id: 'g' }, run_phase: 'aborted' }, 'guard_abort', 'aborted'],
  [
    'handler-abort',
    {
      terminal_reason: "Handler 'h' aborted the run: nope",
      aborted_at: { step_id: 'h' },
      run_phase: 'aborted',
    },
    'handler_abort',
    'aborted',
  ],
  [
    'gate-expiry-abort',
    {
      terminal_reason: "Gate 'g' expired and the run aborted",
      aborted_at: { step_id: 'g' },
      run_phase: 'aborted',
    },
    'gate_expiry_abort',
    'aborted',
  ],
  // Free-text abandon, and the cleanup sweep's own prose.
  [
    'abandon',
    {
      terminal_reason: 'Abandoned by the operator, reason unrecorded',
      abandoned_at: AT,
      run_phase: 'abandoned',
    },
    'abandon_requested',
    'abandoned',
  ],
  [
    'cleanup',
    {
      terminal_reason: 'Marked abandoned by realm cleanup',
      abandoned_at: AT,
      run_phase: 'abandoned',
    },
    'cleanup_sweep',
    'abandoned',
  ],
];

/** Seeds the whole corpus: every shape + one unclassifiable + one live control + two incoherents. */
async function seedCorpus(): Promise<void> {
  for (const [id, fields] of SHAPES) await seed(id, fields);
  await seed('unclassifiable', {
    terminal_reason: 'something nobody has ever written',
    run_phase: 'abandoned',
  });
  await seed('live-control', { terminal_state: false, run_phase: 'running' });
  // INCOHERENT #1 — a stamp whose arm contradicts the record's own fail prose. Its phase-level
  // disagreement is visible to the boundary too; here the COMMAND is the observer.
  await seed('incoherent-prose', {
    terminal_reason: "Step 'a' failed: boom",
    failed_steps: ['a'],
    run_phase: 'failed',
    sealed_by: { arm: 'complete' },
  });
  // INCOHERENT #2 — the abandon-marker stale arm. The store boundary's comparator ABSTAINS here by
  // design, so the store accepts this record; the vehicle's audit, using the FULL classifier, does
  // not. This record is the two-arm blindness and its observer, in one fixture.
  await seed('incoherent-abandon', {
    terminal_reason: 'Abandoned by the operator',
    abandoned_at: AT,
    run_phase: 'abandoned',
    sealed_by: { arm: 'complete' },
  });
}

describe('#367 part 3 — the migration vehicle stamps every classifiable shape', () => {
  it('stamps each legacy shape with the arm it has always meant', async () => {
    await seedCorpus();
    const buckets = await migrateStampSeals(store, { force: true });
    for (const [id, , arm] of SHAPES) {
      const record = await onDisk(id);
      expect(record.sealed_by?.arm, `${id} should be stamped '${arm}'`).toBe(arm);
    }
    expect(buckets.stamped).toHaveLength(SHAPES.length);
  });

  it('every vehicle-minted stamp carries `classified: true`, and no step is fabricated', async () => {
    await seedCorpus();
    await migrateStampSeals(store, { force: true });
    for (const [id] of SHAPES) {
      const record = await onDisk(id);
      expect(record.sealed_by?.classified).toBe(true);
      expect(record.sealed_by?.step).toBeUndefined();
    }
  });

  it('CONTROL: a WRITER-sealed record carries NO `classified` marker', async () => {
    // The polarity that makes the cell above mean something: if `classified` were on everything,
    // it would distinguish nothing.
    await seed('writer-sealed', {
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
      sealed_by: { arm: 'complete' },
    });
    await migrateStampSeals(store, { force: true });
    expect((await onDisk('writer-sealed')).sealed_by?.classified).toBeUndefined();
  });

  it('`updated_at` is BYTE-preserved on every record — the whole reason this is not `gc --heal`', async () => {
    await seedCorpus();
    await migrateStampSeals(store, { force: true });
    for (const [id] of SHAPES) {
      expect((await onDisk(id)).updated_at, `${id} retention clock`).toBe(AT);
    }
  });

  it('`version` is bumped ONLY on records that were actually stamped', async () => {
    await seedCorpus();
    await migrateStampSeals(store, { force: true });
    for (const [id] of SHAPES) expect((await onDisk(id)).version, id).toBe(2);
    // Untouched records keep their version.
    expect((await onDisk('unclassifiable')).version).toBe(1);
    expect((await onDisk('live-control')).version).toBe(1);
    expect((await onDisk('incoherent-prose')).version).toBe(1);
  });

  it('`run_phase` MATERIALISES on remap rows and is retained on agreeing rows', async () => {
    // The startup deaths sat on disk as `abandoned` and derive `failed` since the substrate. This
    // is the clock-preserving materialisation `--heal` cannot do: the phase moves, the clock does
    // not.
    await seedCorpus();
    await migrateStampSeals(store, { force: true });
    for (const [id, , , expectedPhase] of SHAPES) {
      expect((await onDisk(id)).run_phase, `${id} phase`).toBe(expectedPhase);
    }
    const spawn = await onDisk('spawn');
    expect(spawn.run_phase).toBe('failed'); // was 'abandoned' on disk
    expect(spawn.updated_at).toBe(AT); // and the clock did not move
  });

  it('an UNCLASSIFIABLE record is bucketed, printed, and never written', async () => {
    await seedCorpus();
    const before = await onDisk('unclassifiable');
    const buckets = await migrateStampSeals(store, { force: true });
    expect(buckets.unclassifiable.map((e) => e.id)).toEqual(['unclassifiable']);
    expect(await onDisk('unclassifiable')).toEqual(before); // byte-identical
    expect(migrateExitCode(buckets)).toBe(1);
  });

  it('BOTH incoherent shapes are bucketed and never auto-rewritten', async () => {
    await seedCorpus();
    const before = await onDisk('incoherent-abandon');
    const buckets = await migrateStampSeals(store, { force: true });
    const ids = buckets.incoherent.map((e) => e.id).sort();
    expect(ids).toEqual(['incoherent-abandon', 'incoherent-prose']);
    expect(await onDisk('incoherent-abandon')).toEqual(before);
    expect(migrateExitCode(buckets)).toBe(1);
  });

  it('the abandon-marker stale arm: the STORE accepts it, and the vehicle catches it', async () => {
    // Two facts in one cell, because they are the same design decision seen from both ends. The
    // boundary's comparator abstains on abandon-marker records — a named blindness — so the store
    // takes this write. The vehicle's audit uses the FULL classifier, which does not abstain. That
    // is the observer observing.
    const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    const stale: RunRecord = {
      ...run,
      terminal_state: true,
      terminal_reason: 'Abandoned by the operator',
      abandoned_at: AT,
      sealed_by: { arm: 'complete' },
    };
    await expect(store.update(stale)).resolves.toBeDefined(); // the boundary ACCEPTS it

    const buckets = await migrateStampSeals(store, { force: true });
    expect(buckets.incoherent.map((e) => e.id)).toContain(run.id);
    const entry = buckets.incoherent.find((e) => e.id === run.id)!;
    expect(entry.arm).toBe('complete');
    expect(entry.classified).toBe('abandon_requested');
  });

  it('the NON-TERMINAL control is byte-identical after the sweep', async () => {
    await seedCorpus();
    const before = await onDisk('live-control');
    await migrateStampSeals(store, { force: true });
    expect(await onDisk('live-control')).toEqual(before);
  });

  it('IDEMPOTENT: a second run stamps nothing and leaves the corpus byte-identical', async () => {
    await seedCorpus();
    await migrateStampSeals(store, { force: true });
    const snapshot: Record<string, RunRecord> = {};
    for (const [id] of SHAPES) snapshot[id] = await onDisk(id);

    const second = await migrateStampSeals(store, { force: true });
    expect(second.stamped).toEqual([]);
    // Every previously-stamped record now enters the STAMPED arm, agrees, and reports so.
    for (const [id] of SHAPES) {
      expect(second.already_stamped).toContain(id);
      expect(await onDisk(id)).toEqual(snapshot[id]);
    }
  });

  it('DRY RUN is the default: it reports what it would do and writes nothing', async () => {
    await seedCorpus();
    const before = await onDisk('spawn');
    const buckets = await migrateStampSeals(store);
    expect(buckets.stamped).toHaveLength(SHAPES.length);
    expect(await onDisk('spawn')).toEqual(before);
  });

  it('a store without `stampSeal` refuses the batch and points at its own tooling', async () => {
    const nonDeclaring = {
      persistsClaims: true,
      create: store.create.bind(store),
      get: store.get.bind(store),
      update: store.update.bind(store),
      list: store.list.bind(store),
      claimStep: store.claimStep.bind(store),
    } as unknown as RunStore;
    await expect(migrateStampSeals(nonDeclaring, { force: true })).rejects.toThrow(
      /does not implement stampSeal/,
    );
  });
});

describe('#367 part 3 — the report says no more than the branch it is printed in', () => {
  it('dry-run WITH candidates: counts, per-id lines, the ordering footer, and how to execute', async () => {
    await seedCorpus();
    const lines = renderMigrateReport(await migrateStampSeals(store), {});
    const text = lines.join('\n');
    expect(text).toContain('WOULD be stamped');
    expect(text).toContain('• spawn: spawn_failure (phase abandoned → failed)');
    expect(text).toContain('Re-run with --force to actually stamp.');
    expect(text).toContain(ORDERING_LINE);
  });

  it('--force: stamped lines, no "would", and the footer still prints', async () => {
    await seedCorpus();
    const buckets = await migrateStampSeals(store, { force: true });
    const text = renderMigrateReport(buckets, { force: true }).join('\n');
    expect(text).toContain('Stamped 11 run(s) with their seal arm.');
    expect(text).not.toContain('WOULD be stamped');
    expect(text).not.toContain('Re-run with --force');
    expect(text).toContain(ORDERING_LINE);
  });

  it('--force with ZERO candidates: the force wording, and the footer still prints', async () => {
    await seed('done', {
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
      sealed_by: { arm: 'complete' },
    });
    const text = renderMigrateReport(await migrateStampSeals(store, { force: true }), {
      force: true,
    }).join('\n');
    expect(text).toContain('Nothing to stamp');
    expect(text).not.toContain('Nothing would be stamped');
    expect(text).toContain(ORDERING_LINE);
  });

  it('EMPTY dry run: the empty text, and the footer still prints', async () => {
    const text = renderMigrateReport(await migrateStampSeals(store), {}).join('\n');
    expect(text).toContain('No terminal runs found to migrate.');
    expect(text).toContain(ORDERING_LINE);
  });

  it('unclassifiable: ids, WHY, and exit 1', async () => {
    await seed('mystery', { terminal_reason: 'who knows', run_phase: 'abandoned' });
    const buckets = await migrateStampSeals(store, { force: true });
    const text = renderMigrateReport(buckets, { force: true }).join('\n');
    expect(text).toContain('• mystery: terminal reason "who knows" matches no known seal shape');
    expect(text).toContain('left untouched');
    expect(migrateExitCode(buckets)).toBe(1);
  });

  it('incoherent: BOTH oracles named on the line, and nothing was rewritten', async () => {
    await seed('conflict', {
      terminal_reason: "Step 'a' failed: boom",
      failed_steps: ['a'],
      run_phase: 'failed',
      sealed_by: { arm: 'complete' },
    });
    const buckets = await migrateStampSeals(store, { force: true });
    const text = renderMigrateReport(buckets, { force: true }).join('\n');
    expect(text).toContain("recorded arm 'complete' (phase completed)");
    expect(text).toContain("read as 'step_failure' (phase failed)");
    expect(text).toContain('adjudicate these yourself; nothing was rewritten');
    expect(migrateExitCode(buckets)).toBe(1);
  });

  it('skipped_conflict: the honest wording — the other writer owns it, this run did not heal it', async () => {
    const text = renderMigrateReport(
      { ...emptyForRender(), skipped_conflict: ['moved'] },
      { force: true },
    ).join('\n');
    expect(text).toContain('their own next write path owns them');
    expect(text).not.toContain('which heals them too');
    expect(migrateExitCode({ ...emptyForRender(), skipped_conflict: ['moved'] })).toBe(0);
  });

  it('failed: an infra error is reported per record, the sweep continued, and the exit code is 1', async () => {
    const buckets = { ...emptyForRender(), failed: [{ id: 'broken', error: 'EACCES' }] };
    expect(renderMigrateReport(buckets, { force: true }).join('\n')).toContain('✗ broken: EACCES');
    expect(migrateExitCode(buckets)).toBe(1);
  });

  it('a MIXED batch composes: residue counts and exit code account for every bucket', async () => {
    await seedCorpus();
    const buckets = await migrateStampSeals(store, { force: true });
    const text = renderMigrateReport(buckets, { force: true }).join('\n');
    expect(text).toContain('Stamped 11 run(s)');
    expect(text).toContain('1 run(s) could NOT be classified');
    expect(text).toContain('2 run(s) carry an arm that disagrees');
    expect(text).toContain('Residue: 1 terminal run(s) still without a recorded seal arm.');
    expect(migrateExitCode(buckets)).toBe(1);
  });

  it('the SECOND run reports everything already stamped', async () => {
    await seedCorpus();
    await migrateStampSeals(store, { force: true });
    const text = renderMigrateReport(await migrateStampSeals(store, { force: true }), {
      force: true,
    }).join('\n');
    expect(text).toContain('Nothing to stamp');
    expect(text).toContain('run(s) already stamped and coherent.');
  });
});

/** An all-empty bucket set for the render-only cells. */
function emptyForRender(): Parameters<typeof renderMigrateReport>[0] {
  return {
    stamped: [],
    already_stamped: [],
    unclassifiable: [],
    incoherent: [],
    skipped_conflict: [],
    failed: [],
  };
}
