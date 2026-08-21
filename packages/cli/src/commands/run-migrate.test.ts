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
import { mkdtemp, writeFile, readFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
import type { RunRecord, RunStore, SealArm } from '@sensigo/realm';
import {
  migrateStampSeals,
  migrateExitCode,
  renderMigrateReport,
  runMigrateCommand,
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
    // Exit 0 by default: the command did its job and said so loudly. Residue is chronic — an
    // unclassifiable record stays unclassifiable — so a nonzero exit here would make every
    // scheduled run fail forever, and a chronic alarm gets silenced.
    expect(migrateExitCode(buckets)).toBe(0);
    // Automation that wants to gate on residue opts in.
    expect(migrateExitCode(buckets, { detailed: true })).toBe(2);
  });

  it('BOTH incoherent shapes are bucketed and never auto-rewritten', async () => {
    await seedCorpus();
    const before = await onDisk('incoherent-abandon');
    const buckets = await migrateStampSeals(store, { force: true });
    const ids = buckets.incoherent.map((e) => e.id).sort();
    expect(ids).toEqual(['incoherent-abandon', 'incoherent-prose']);
    expect(await onDisk('incoherent-abandon')).toEqual(before);
    expect(migrateExitCode(buckets)).toBe(0);
    expect(migrateExitCode(buckets, { detailed: true })).toBe(2);
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
      expect(second.already_stamped.map((e) => e.id)).toContain(id);
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
    // The universal clause must NOT appear — this record is the counterexample to it.
    expect(text).not.toContain('every terminal run already carries its seal arm');
    expect(migrateExitCode(buckets)).toBe(0);
    expect(migrateExitCode(buckets, { detailed: true })).toBe(2);
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
    expect(text).not.toContain('every terminal run already carries its seal arm');
    expect(migrateExitCode(buckets)).toBe(0);
    expect(migrateExitCode(buckets, { detailed: true })).toBe(2);
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
    const text = renderMigrateReport(buckets, { force: true }).join('\n');
    expect(text).toContain('1 run(s) FAILED to stamp and still have no seal arm:'); // its header
    expect(text).toContain('✗ broken: EACCES');
    // A failed WRITE is the command failing at its job — exit 1 in both modes.
    expect(migrateExitCode(buckets)).toBe(1);
    expect(migrateExitCode(buckets, { detailed: true })).toBe(1);
  });

  it('a MIXED batch composes: residue counts and exit code account for every bucket', async () => {
    await seedCorpus();
    const buckets = await migrateStampSeals(store, { force: true });
    const text = renderMigrateReport(buckets, { force: true }).join('\n');
    expect(text).toContain('Stamped 11 run(s)');
    expect(text).toContain('1 run(s) could NOT be classified');
    expect(text).toContain('2 run(s) carry an arm that disagrees');
    expect(text).toContain('Residue: 1 terminal run(s) still without a recorded seal arm.');
    expect(migrateExitCode(buckets)).toBe(0);
    expect(migrateExitCode(buckets, { detailed: true })).toBe(2);
  });

  it('LEG 1 executed: force + a REAL unclassifiable record, driven through the store', async () => {
    await seed('mystery', { terminal_reason: 'who knows', run_phase: 'abandoned' });
    const text = renderMigrateReport(await migrateStampSeals(store, { force: true }), {
      force: true,
    }).join('\n');
    expect(text).not.toContain('every terminal run already carries its seal arm');
  });

  it('LEG 1 executed: force + a REAL failed write (a FRESH lock the sweep cannot take)', async () => {
    // The lock must be FRESH: proper-lockfile steals a stale one, and the stamp would then
    // SUCCEED — the fixture would prove nothing. `mkdir` + a current mtime is what makes the
    // acquisition genuinely fail.
    await seed('locked', { terminal_reason: 'Workflow completed.', run_phase: 'completed' });
    await mkdir(join(dir, 'locked.json.lock'), { recursive: true });
    const now = new Date();
    await utimes(join(dir, 'locked.json.lock'), now, now);

    const buckets = await migrateStampSeals(store, { force: true });
    expect(buckets.failed).toHaveLength(1); // non-vacuity: the write really did fail
    const text = renderMigrateReport(buckets, { force: true }).join('\n');
    expect(text).not.toContain('every terminal run already carries its seal arm');
    // LEG 2: a failed write leaves the record armless, so it IS residue.
    expect(text).toContain('Residue: 1 terminal run(s) still without a recorded seal arm.');
    expect((await onDisk('locked')).sealed_by).toBeUndefined();
    expect(migrateExitCode(buckets)).toBe(1);
    // The lock-retry backoff is real time — this cell waits it out rather than mocking it, so the
    // failure it observes is the one an operator would actually hit.
  }, 30_000);

  it('LEG 1 executed: DRY RUN + an unclassifiable record', async () => {
    await seed('mystery', { terminal_reason: 'who knows', run_phase: 'abandoned' });
    const text = renderMigrateReport(await migrateStampSeals(store), {}).join('\n');
    expect(text).not.toContain('every terminal run already carries its seal arm');
    // LEG 3.1: force would stamp nothing here, so do not invite the operator to run it.
    expect(text).not.toContain('Re-run with --force');
  });

  it('LEG 1 executed: skipped-only — a writer that moves the version between list and stamp', async () => {
    await seed('moving', { terminal_reason: 'Workflow completed.', run_phase: 'completed' });
    const shifting = {
      ...store,
      persistsClaims: store.persistsClaims,
      list: store.list.bind(store),
      get: store.get.bind(store),
      create: store.create.bind(store),
      update: store.update.bind(store),
      claimStep: store.claimStep.bind(store),
      // Someone else wrote between the sweep's read and this call.
      stampSeal: async (
        id: string,
        sealedBy: Parameters<typeof store.stampSeal>[1],
        version: number,
      ) => store.stampSeal(id, sealedBy, version + 1),
    } as unknown as RunStore;

    const buckets = await migrateStampSeals(shifting, { force: true });
    expect(buckets.skipped_conflict).toEqual(['moving']);
    const text = renderMigrateReport(buckets, { force: true }).join('\n');
    expect(text).not.toContain('every terminal run already carries its seal arm');
    // LEG 2: a skipped record's arm state is UNKNOWN — disclosed, never counted as residue.
    expect(text).toContain('(+1 skipped — arm state unknown until their own writer settles)');
    expect(text).toContain('Residue: 0 terminal run(s)');
    expect(migrateExitCode(buckets)).toBe(0); // the other writer owns it; this command did its job
  });

  it('LEG 3.2: an arm the audit could NOT check is reported as unverifiable, never as coherent', async () => {
    // The classifier abstains on this record — its prose places it nowhere — so the audit has
    // nothing to compare the arm against. "Coherent" would be a finding it never made.
    await seed('abstained', {
      terminal_reason: 'prose nothing recognises',
      run_phase: 'completed',
      sealed_by: { arm: 'complete' },
    });
    const buckets = await migrateStampSeals(store, { force: true });
    expect(buckets.already_stamped).toEqual([{ id: 'abstained', verified: false }]);
    const text = renderMigrateReport(buckets, { force: true }).join('\n');
    expect(text).toContain('1 unverifiable — nothing in the record to check the arm against');
    expect(text).not.toContain('agree with the record');
  });

  it('the SECOND run reports everything already stamped', async () => {
    await seedCorpus();
    await migrateStampSeals(store, { force: true });
    const text = renderMigrateReport(await migrateStampSeals(store, { force: true }), {
      force: true,
    }).join('\n');
    // This corpus still holds an unclassifiable record and two incoherent ones, so the universal
    // clause must NOT appear — those records are its counterexamples.
    expect(text).toContain('Nothing was stamped.');
    expect(text).not.toContain('every terminal run already carries its seal arm');
    expect(text).toContain('run(s) already stamped');
  });

  it('the universal clause appears ONLY when all four falsifying buckets are empty', () => {
    // The other polarity. Without this, "never print the clause" would pass every cell above.
    const clean = { ...emptyForRender(), already_stamped: [{ id: 'a', verified: true }] };
    expect(renderMigrateReport(clean, { force: true }).join('\n')).toContain(
      'Nothing to stamp — every terminal run already carries its seal arm.',
    );
    for (const falsifier of [
      { unclassifiable: [{ id: 'u', why: 'w' }] },
      { failed: [{ id: 'f', error: 'e' }] },
      {
        incoherent: [
          {
            id: 'i',
            arm: 'complete' as const,
            classified: 'step_failure' as const,
            arm_phase: 'completed',
            classified_phase: 'failed',
          },
        ],
      },
      { skipped_conflict: ['s'] },
    ]) {
      const text = renderMigrateReport({ ...clean, ...falsifier }, { force: true }).join('\n');
      expect(text, JSON.stringify(falsifier)).not.toContain(
        'every terminal run already carries its seal arm',
      );
    }
  });
});

describe('#367 part 4 — the audit honors an operator ruling', () => {
  /** A record already carrying an operator ruling. */
  async function seedRuled(id: string, extra: Partial<RunRecord> = {}): Promise<void> {
    await seed(id, {
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
      sealed_by: {
        arm: 'complete',
        adjudicated: { by: 'mihai', at: '2026-08-20T00:00:00.000Z', previous_arm: 'complete' },
      },
      ...extra,
    });
  }

  it('an adjudicated-INCOHERENT record is `already_stamped {ruled}`, not `incoherent`', async () => {
    // The closure the ruling exists to deliver: without the short-circuit, a record an operator has
    // already ruled on re-parks as incoherent on EVERY future sweep, forever.
    await seedRuled('ruled-scarred', {
      terminal_reason: "Step 'a' failed: from an earlier epoch",
      failed_steps: ['a'],
      run_phase: 'failed',
    });
    const buckets = await migrateStampSeals(store, { force: true });
    expect(buckets.incoherent).toEqual([]);
    expect(buckets.already_stamped).toEqual([{ id: 'ruled-scarred', verified: true, ruled: true }]);
  });

  it('CONTROL: the SAME record without the ruling is still bucketed incoherent', async () => {
    // The audit did not go blind — it defers to a ruling, and only to a ruling.
    await seed('unruled-scarred', {
      terminal_reason: "Step 'a' failed: from an earlier epoch",
      failed_steps: ['a'],
      run_phase: 'failed',
      sealed_by: { arm: 'complete' },
    });
    const buckets = await migrateStampSeals(store, { force: true });
    expect(buckets.incoherent.map((e) => e.id)).toEqual(['unruled-scarred']);
    expect(buckets.already_stamped).toEqual([]);
  });

  it('the arithmetic holds: checked + ruled + unverifiable = the already-stamped total', async () => {
    await seed('checked', {
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
      sealed_by: { arm: 'complete' },
    });
    await seedRuled('ruled');
    await seed('abstained', {
      terminal_reason: 'prose nothing recognises',
      run_phase: 'completed',
      sealed_by: { arm: 'complete' },
    });
    const { already_stamped: entries } = await migrateStampSeals(store, { force: true });
    const X = entries.filter((e) => e.verified && e.ruled !== true).length;
    const R = entries.filter((e) => e.ruled === true).length;
    const U = entries.filter((e) => !e.verified).length;
    expect([X, R, U]).toEqual([1, 1, 1]);
    expect(X + R + U).toBe(entries.length);
  });

  it('R=0 — the line is byte-identical to what it was before rulings existed', async () => {
    await seed('checked', {
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
      sealed_by: { arm: 'complete' },
    });
    const text = renderMigrateReport(await migrateStampSeals(store, { force: true }), {
      force: true,
    }).join('\n');
    expect(text).toContain('1 run(s) already stamped, and their arms agree with the record.');
  });

  it('R>0 and U>0 — the split form shows both segments', async () => {
    await seedRuled('ruled');
    await seed('abstained', {
      terminal_reason: 'prose nothing recognises',
      run_phase: 'completed',
      sealed_by: { arm: 'complete' },
    });
    const text = renderMigrateReport(await migrateStampSeals(store, { force: true }), {
      force: true,
    }).join('\n');
    expect(text).toContain('1 ruled by an operator — the ruling stands');
    expect(text).toContain('1 unverifiable — nothing in the record to check the arm against');
    expect(text).not.toContain('their arms agree with the record');
  });

  it('R=N and U=0 — "agree with the record" is ABSENT and the ruled segment is PRESENT', async () => {
    // Both halves asserted deliberately: the absence alone passes vacuously if the whole line
    // stops printing, so the presence conjunct is what actually catches a lost segment.
    await seedRuled('ruled-a');
    await seedRuled('ruled-b');
    const text = renderMigrateReport(await migrateStampSeals(store, { force: true }), {
      force: true,
    }).join('\n');
    expect(text).not.toContain('their arms agree with the record');
    expect(text).toContain(
      '2 run(s) already stamped (2 ruled by an operator — the ruling stands).',
    );
  });

  it('X>0, R>0, U=0 — the checked and ruled segments show, and the unverifiable one is omitted', async () => {
    // The one segment-omission composition no other cell executes.
    await seed('checked', {
      terminal_reason: 'Workflow completed.',
      run_phase: 'completed',
      sealed_by: { arm: 'complete' },
    });
    await seedRuled('ruled');
    const text = renderMigrateReport(await migrateStampSeals(store, { force: true }), {
      force: true,
    }).join('\n');
    expect(text).toContain(
      '2 run(s) already stamped (1 checked against the record, 1 ruled by an operator — the ruling stands).',
    );
    expect(text).not.toContain('unverifiable');
  });

  it('an arm this binary does not know renders as unknown, never as "phase undefined"', async () => {
    // `armToPhase` is total over SEAL_ARMS and returns undefined for anything else; interpolated
    // raw, that printed "(phase undefined)", which reads as a bug in this command rather than a
    // record written by a newer version.
    await seed('from-the-future', {
      terminal_reason: "Step 'a' failed: boom",
      failed_steps: ['a'],
      run_phase: 'failed',
      sealed_by: { arm: 'from_the_future' as never },
    });
    const text = renderMigrateReport(await migrateStampSeals(store, { force: true }), {
      force: true,
    }).join('\n');
    expect(text).toContain('phase unknown to this binary (written by a newer version?)');
    expect(text).not.toContain('phase undefined');
  });
});

describe("#367 part 5 — the operator's loop, end to end", () => {
  // The PR-4 cells above pin the short-circuit in isolation. These two walk the whole journey the
  // short-circuit exists for: sweep parks a record, operator rules on it, next sweep leaves it
  // alone and says so. A loop that closes on paper and not in the tool is not closed.

  it('J3 — an UNCLASSIFIABLE record: parked, first-stamped with null provenance, then it stands', async () => {
    // Leg 1: nothing in the record's prose matches a known seal shape, so the sweep refuses to
    // guess and parks it.
    await seed('halted-in-migration', {
      terminal_reason: 'Halted by an operator during the 0.9 migration',
      run_phase: 'failed',
    });
    const before = await migrateStampSeals(store, { force: true });
    expect(before.unclassifiable.map((e) => e.id)).toEqual(['halted-in-migration']);
    expect(before.stamped).toEqual([]);

    // Leg 2: the operator reads it and rules. There was no arm to correct, so the only truthful
    // provenance is `previous_arm: null` — the first-stamp form.
    const parked = await onDisk('halted-in-migration');
    const result = await store.stampSeal(
      'halted-in-migration',
      {
        arm: 'abandon_requested',
        adjudicated: {
          by: 'mihai',
          at: '2026-08-21T00:00:00.000Z',
          previous_arm: null,
          reason: 'halted deliberately during the migration; no step failed',
        },
      },
      parked.version,
    );
    expect(result.stamped).toBe(true);

    // Leg 3: the next sweep honours it — out of `unclassifiable` for good, and the report says
    // whose call it was rather than re-raising the question.
    const after = await migrateStampSeals(store, { force: true });
    expect(after.unclassifiable).toEqual([]);
    expect(after.already_stamped).toEqual([
      { id: 'halted-in-migration', verified: true, ruled: true },
    ]);
    expect(renderMigrateReport(after, { force: true }).join('\n')).toContain(
      'ruled by an operator — the ruling stands',
    );
  });

  it('J4 — an INCOHERENT abandon record: parked, acknowledged as it stands, then it stands', async () => {
    // The harder half. Here the operator does NOT correct the arm — they acknowledge it. The loop
    // has to close on "I know, leave it" too, or the tool keeps arguing with a decision already
    // made.
    const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    const stale: RunRecord = {
      ...run,
      terminal_state: true,
      terminal_reason: 'Abandoned by the operator',
      abandoned_at: AT,
      sealed_by: { arm: 'complete' },
    };
    const written = await store.update(stale); // the boundary's comparator abstains on abandon markers
    const before = await migrateStampSeals(store, { force: true });
    expect(before.incoherent.map((e) => e.id)).toEqual([run.id]);

    // The ack: same arm, and a previous_arm that says truthfully what was there.
    await store.update({
      ...written,
      sealed_by: {
        arm: 'complete',
        adjudicated: {
          by: 'mihai',
          at: '2026-08-21T00:00:00.000Z',
          previous_arm: 'complete',
          reason: 'the work finished; the abandon marker is scar tissue from a later cleanup',
        },
      },
    });

    const after = await migrateStampSeals(store, { force: true });
    expect(after.incoherent).toEqual([]);
    expect(after.already_stamped).toEqual([{ id: run.id, verified: true, ruled: true }]);
  });
});

describe('#367 part 3 — the exit taxonomy, per bucket combination and per mode', () => {
  const E = (): Parameters<typeof migrateExitCode>[0] => ({
    stamped: [],
    already_stamped: [],
    unclassifiable: [],
    incoherent: [],
    skipped_conflict: [],
    failed: [],
  });
  const U = { ...E(), unclassifiable: [{ id: 'u', why: 'w' }] };
  const I = {
    ...E(),
    incoherent: [
      {
        id: 'i',
        arm: 'complete' as const,
        classified: 'step_failure' as const,
        arm_phase: 'completed',
        classified_phase: 'failed',
      },
    ],
  };
  const F = { ...E(), failed: [{ id: 'f', error: 'e' }] };
  const S = { ...E(), skipped_conflict: ['s'] };

  it.each([
    ['clean', E(), 0, 0],
    ['unclassifiable', U, 0, 2],
    ['incoherent', I, 0, 2],
    ['unclassifiable + incoherent', { ...U, incoherent: I.incoherent }, 0, 2],
    ['skipped only', S, 0, 0],
    ['failed', F, 1, 1],
    ['failed + unclassifiable', { ...F, unclassifiable: U.unclassifiable }, 1, 1],
  ])('%s ⇒ default %i, --detailed-exitcode %i', (_label, buckets, plain, detailed) => {
    expect(migrateExitCode(buckets)).toBe(plain);
    expect(migrateExitCode(buckets, { detailed: true })).toBe(detailed);
  });

  it('THE CRY-WOLF COMPOSITION: a parked corpus exits 0 on every repeat run, and 2 under the flag', async () => {
    // The reason residue is not exit 1. An unclassifiable record stays unclassifiable and an
    // incoherent one stays parked until a human adjudicates it, so a nonzero default would make
    // every scheduled run of this command fail forever — and a chronic alarm is one that gets
    // silenced, taking the real failures with it.
    await seed('mystery', { terminal_reason: 'who knows', run_phase: 'abandoned' });
    await seed('parked', {
      terminal_reason: "Step 'a' failed: boom",
      failed_steps: ['a'],
      run_phase: 'failed',
      sealed_by: { arm: 'complete' },
    });
    for (let runNumber = 1; runNumber <= 3; runNumber += 1) {
      const buckets = await migrateStampSeals(store, { force: true });
      expect(buckets.unclassifiable, `run ${runNumber}`).toHaveLength(1);
      expect(buckets.incoherent, `run ${runNumber}`).toHaveLength(1);
      expect(migrateExitCode(buckets), `run ${runNumber} default`).toBe(0);
      expect(migrateExitCode(buckets, { detailed: true }), `run ${runNumber} strict`).toBe(2);
    }
  });

  it('the required flag: `realm run migrate` with no --stamp-seals is refused by Commander', () => {
    // DQ2's gap from the base report. The gc `requiredOption` precedent: the flag is required, so
    // the bare command is an error rather than a silent no-op.
    const option = runMigrateCommand.options.find((o) => o.long === '--stamp-seals');
    expect(option?.required || option?.mandatory).toBe(true);
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
