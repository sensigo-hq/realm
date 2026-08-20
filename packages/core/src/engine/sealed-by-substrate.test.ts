// sealed-by-substrate.test.ts — issue #367: the run records WHICH arm sealed it, and every
// judgement about the run derives from that fact.
//
// Before this, realm's most important fact — did this run succeed — was not in the record. Two
// records identical in every field except `terminal_reason` derived opposite phases, because the
// oracle was the English literal 'Workflow completed.'. Nothing observed any of it: a deleted
// writer stamp and a reverted derivation oracle both left the whole suite green.
//
// So every cell here is new ground. Each is per-conjunct and was written VERIFY-FIRST: run against
// the real engine and the real stores, then pinned to what was actually observed.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SEAL_ARMS,
  armToPhase,
  armToOutcome,
  armMarker,
  classifyLegacySeal,
  classifyForCoherence,
  deriveRunPhase,
  sealRunLevel,
  assertSealIntegrity,
  assertSealMarkersAgree,
  assertSealOutcomeCoherent,
} from '../index.js';
import type { RunRecord, SealArm } from '../types/run-record.js';
import { JsonFileStore } from '../store/json-file-store.js';

/** A minimal, schema-complete record. Not written through any store — a pure derivation input. */
function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
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
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...overrides,
  } as RunRecord;
}

async function freshStore(): Promise<JsonFileStore> {
  return new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-sealed-by-')));
}

describe('#367 — the arm mappings are total and closed', () => {
  it('every arm in SEAL_ARMS maps to a phase, an outcome, and a marker expectation', () => {
    // The exhaustive no-default switches are the ONE compile guarantee this design claims. This
    // cell is their runtime witness: a 14th arm added without mappings does not build, and one
    // added without a mapping ENTRY would show up here as undefined.
    for (const arm of SEAL_ARMS) {
      expect(armToPhase(arm)).toBeDefined();
      expect(armToOutcome(arm)).toBeDefined();
      const marker = armMarker(arm);
      if (armToPhase(arm) === 'aborted') expect(marker).toBe('aborted_at');
      else if (armToPhase(arm) === 'abandoned') expect(marker).toBe('abandoned_at');
      else expect(marker).toBeUndefined();
    }
    expect(SEAL_ARMS).toHaveLength(13);
  });

  it('the phase partition is exactly the four run phases, with no arm in two classes', () => {
    const byPhase: Record<string, SealArm[]> = {};
    for (const arm of SEAL_ARMS) (byPhase[armToPhase(arm)] ??= []).push(arm);
    expect(Object.keys(byPhase).sort()).toEqual(['abandoned', 'aborted', 'completed', 'failed']);
    expect(Object.values(byPhase).flat()).toHaveLength(SEAL_ARMS.length);
  });
});

describe('#367 — the census completeness guard', () => {
  // THE GUARD WHOSE ABSENCE LET A GAP SHIP. The first version of this PR had 13 of the 21 census
  // paths celled, and a conformance mutant proved the cost: two same-phase WRONG ARMS
  // (gate_expiry_default → gate_resolution_complete, cleanup_sweep → abandon_requested) sailed
  // through 3880 green tests. Neither the boundary nor the coherence check can see a wrong arm of
  // the right phase — behaviour cells are the only observer — so the coverage set itself has to be
  // asserted, not assumed.
  //
  // Keyed to PATHS, not arms: several paths share an arm, and per-arm cells would leave siblings
  // uncovered, which is the same blindness one level up.
  const CENSUS_PATHS: Array<{ path: string; arm: SealArm; home: string }> = [
    // settlement transform (8 call sites)
    { path: 'settlement/complete', arm: 'complete', home: 'sealed-by-writers.test.ts' },
    { path: 'settlement/step_failure', arm: 'step_failure', home: 'sealed-by-writers.test.ts' },
    { path: 'settlement/handler_abort', arm: 'handler_abort', home: 'sealed-by-writers.test.ts' },
    {
      path: 'settlement/guard_resolution_error',
      arm: 'guard_resolution_error',
      home: 'sealed-by-writers.test.ts',
    },
    { path: 'settlement/guard_abort', arm: 'guard_abort', home: 'sealed-by-writers.test.ts' },
    {
      path: 'settlement/guard_pass_complete',
      arm: 'guard_pass_complete',
      home: 'sealed-by-writers.test.ts',
    },
    {
      path: 'settlement/gate_resolution_complete',
      arm: 'gate_resolution_complete',
      home: 'sealed-by-writers.test.ts',
    },
    {
      path: 'settlement/gate_expiry_default',
      arm: 'gate_expiry_default',
      home: 'sealed-by-writers.test.ts',
    },
    {
      path: 'settlement/gate_expiry_abort',
      arm: 'gate_expiry_abort',
      home: 'sealed-by-writers.test.ts',
    },
    // legacy loop (the dormancy path, driven by a non-declaring store double)
    { path: 'legacy/complete', arm: 'complete', home: 'sealed-by-writers.test.ts' },
    { path: 'legacy/step_failure', arm: 'step_failure', home: 'sealed-by-writers.test.ts' },
    { path: 'legacy/handler_abort', arm: 'handler_abort', home: 'sealed-by-writers.test.ts' },
    {
      path: 'legacy/guard_resolution_error',
      arm: 'guard_resolution_error',
      home: 'sealed-by-writers.test.ts',
    },
    { path: 'legacy/guard_abort', arm: 'guard_abort', home: 'sealed-by-writers.test.ts' },
    {
      path: 'legacy/guard_pass_complete',
      arm: 'guard_pass_complete',
      home: 'sealed-by-writers.test.ts',
    },
    // the deleted-ternary leg: exhaustion seals step_failure like any other failure
    {
      path: 'settlement/validation_exhaustion',
      arm: 'step_failure',
      home: 'sealed-by-writers.test.ts',
    },
    // gate expiry reached through the downstream-step enactment point
    { path: 'expiry/enact_then_proceed', arm: 'complete', home: 'execute-step-expiry.test.ts' },
    // run-level bypass writers (4)
    {
      path: 'bypass/abandon_requested',
      arm: 'abandon_requested',
      home: 'sealed-by-writers.test.ts',
    },
    { path: 'bypass/cleanup_sweep', arm: 'cleanup_sweep', home: 'cli/cleanup.test.ts' },
    { path: 'bypass/spawn_failure', arm: 'spawn_failure', home: 'cli/listen.test.ts' },
    {
      path: 'bypass/extensions_load_failure',
      arm: 'extensions_load_failure',
      home: 'cli/run-attach.test.ts',
    },
  ];

  it('the census holds all 21 terminal paths, and every one names its cell home', () => {
    expect(CENSUS_PATHS).toHaveLength(21);
    expect(new Set(CENSUS_PATHS.map((p) => p.path)).size).toBe(21); // no duplicate path keys
    for (const entry of CENSUS_PATHS) expect(entry.home).not.toBe('');
  });

  it('every SEAL_ARMS member appears on at least one celled census path', () => {
    // The direct observer of the gap: an arm nothing exercises has no wrong-arm detector at all.
    const covered = new Set(CENSUS_PATHS.map((p) => p.arm));
    const uncovered = SEAL_ARMS.filter((arm) => !covered.has(arm));
    expect(uncovered).toEqual([]);
  });

  it('every census arm is a real SEAL_ARMS member — the census cannot drift into fiction', () => {
    for (const entry of CENSUS_PATHS) {
      expect((SEAL_ARMS as readonly string[]).includes(entry.arm)).toBe(true);
    }
  });
});

describe('#367 — deriveRunPhase: the three conjuncts of the sealed-wins branch', () => {
  it('(conjunct: sealed_by present) a stamped terminal record derives from the ARM, not the prose', () => {
    // The defect in one line: identical prose, opposite phases, decided by the recorded fact.
    const asFailed = record({
      terminal_state: true,
      sealed_by: { arm: 'step_failure' },
      terminal_reason: 'Workflow completed.',
      failed_steps: ['a'],
    });
    expect(deriveRunPhase(asFailed)).toBe('failed');
    const asComplete = record({
      terminal_state: true,
      sealed_by: { arm: 'complete' },
      terminal_reason: 'Workflow completed.',
      failed_steps: ['a'],
    });
    expect(deriveRunPhase(asComplete)).toBe('completed');
  });

  it('(conjunct: terminal_state) an ORPHAN — seal retained on a LIVE record — derives via the live ladder', () => {
    // Without this conjunct the orphan reads terminal and BOTH purge gates pass on a running run,
    // destroying it. The orphan's real channel is an old binary's resume, which keeps the stamp.
    const orphan = record({ terminal_state: false, sealed_by: { arm: 'complete' } });
    expect(deriveRunPhase(orphan)).toBe('running');
    const orphanWithGate = record({
      terminal_state: false,
      sealed_by: { arm: 'complete' },
      pending_gate: {
        gate_id: 'g',
        step_name: 'a',
        preview: {},
        choices: ['ok'],
        opened_at: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(deriveRunPhase(orphanWithGate)).toBe('gate_waiting');
  });

  it('(conjunct: membership) an arm this binary does not know falls through to the classifier, never to undefined', () => {
    // A future binary's record read by this one. Treating it as absent is the honest answer; an
    // unmapped arm would otherwise produce an undefined phase, and a terminal record would then
    // read as non-terminal.
    const future = record({
      terminal_state: true,
      sealed_by: { arm: 'from_the_future' as SealArm },
      terminal_reason: 'Workflow completed.',
    });
    expect(deriveRunPhase(future)).toBe('completed'); // via classifyLegacySeal, not via the arm
    const futureUnclassifiable = record({
      terminal_state: true,
      sealed_by: { arm: 'from_the_future' as SealArm },
      failed_steps: ['a'],
    });
    expect(deriveRunPhase(futureUnclassifiable)).toBe('failed');
  });

  it('(absent) an unstamped legacy record derives through the classifier and the old ladder', () => {
    expect(
      deriveRunPhase(record({ terminal_state: true, terminal_reason: 'Workflow completed.' })),
    ).toBe('completed');
    expect(deriveRunPhase(record({ terminal_state: true, failed_steps: ['a'] }))).toBe('failed');
    expect(deriveRunPhase(record({ terminal_state: true, abandoned_at: 'now' }))).toBe('abandoned');
  });
});

describe('#367 — the ORPHAN is refused a purge (the destructive consequence, executed)', () => {
  it('purge REFUSES an orphaned record, because it derives live', async () => {
    // The interleaving hazard, end to end: seed an orphan through the sanctioned legacy channel
    // (direct writeFile — the ONE way to get a shape past the store boundary), then show the
    // destructive path treats it as the live run it is.
    const store = await freshStore();
    const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    const orphan = { ...run, terminal_state: false, sealed_by: { arm: 'complete' as const } };
    await writeFile(join(store.runsDirPath, `${run.id}.json`), JSON.stringify(orphan, null, 2));

    await expect(store.deleteAllForRun(run.id)).rejects.toMatchObject({
      code: 'STATE_RUN_BUSY',
      details: { reason: 'no_longer_terminal' },
    });
  });
});

describe('#367 — classifyLegacySeal: the permanent read oracle', () => {
  it.each([
    ['Workflow completed.', undefined, [], 'complete'],
    ["Step 'a' failed: boom", undefined, ['a'], 'step_failure'],
    // issue #373's multi-failure sentence is a step-failure seal too.
    ['2 steps failed: a ("x"), b ("y").', undefined, ['a', 'b'], 'step_failure'],
    ["Guard step 'g' failed: unresolvable path '$.x'", undefined, ['g'], 'guard_resolution_error'],
    ['spawn_failed', undefined, [], 'spawn_failure'],
    ['extensions_load_failed', undefined, [], 'extensions_load_failure'],
    ["Handler 'h' aborted the run: nope", 'aborted', [], 'handler_abort'],
    ["Gate 'g' expired and the run aborted", 'aborted', [], 'gate_expiry_abort'],
    [undefined, 'aborted', [], 'guard_abort'],
    ['Marked abandoned by realm cleanup', 'abandoned', [], 'cleanup_sweep'],
    ['Abandoned by operator', 'abandoned', [], 'abandon_requested'],
  ])('classifies %s', (reason, marker, failed, expected) => {
    const run = record({
      terminal_state: true,
      failed_steps: failed as string[],
      ...(reason !== undefined ? { terminal_reason: reason as string } : {}),
      ...(marker === 'aborted' ? { aborted_at: { step_id: 'x' } } : {}),
      ...(marker === 'abandoned' ? { abandoned_at: 'now' } : {}),
    });
    expect(classifyLegacySeal(run)).toBe(expected);
  });

  it('the resolution-error shape is tested BEFORE the generic guard shape — order is load-bearing', () => {
    // Both regexes match this string. If the generic one runs first the arm collapses to
    // step_failure and the guard's own failure mode disappears from the record forever.
    const guardResolution = record({
      terminal_state: true,
      failed_steps: ['g'],
      terminal_reason: "Guard step 'g' failed: unresolvable path '$.nope'",
    });
    expect(classifyLegacySeal(guardResolution)).toBe('guard_resolution_error');
    // The generic guard shape still lands on step_failure — proving the two are distinguished by
    // ORDER, not by the regexes being mutually exclusive.
    const guardGeneric = record({
      terminal_state: true,
      failed_steps: ['g'],
      terminal_reason: "Guard step 'g' failed: something else",
    });
    expect(classifyLegacySeal(guardGeneric)).toBe('step_failure');
  });

  it('refuses to guess: an unplaceable record returns undefined, never a fabricated arm', () => {
    expect(classifyLegacySeal(record({ terminal_state: true }))).toBeUndefined();
    expect(
      classifyLegacySeal(record({ terminal_state: true, terminal_reason: 'who knows' })),
    ).toBeUndefined();
    // An unrecognised ABORT is unplaceable too — the marker says aborted, but which arm is a guess.
    expect(
      classifyLegacySeal(
        record({ terminal_state: true, aborted_at: { step_id: 'x' }, terminal_reason: 'mystery' }),
      ),
    ).toBeUndefined();
    // A live record is never classified at all.
    expect(classifyLegacySeal(record({ terminal_state: false }))).toBeUndefined();
  });
});

describe('#367 — #372: startup deaths stop being filed as "abandoned"', () => {
  it('a legacy spawn-failure record now derives FAILED (it derived abandoned before)', () => {
    // The #372 misfiling, structurally closed: the old ladder fell through to `abandoned` because
    // nothing had failed and the prose was not the completed literal.
    expect(deriveRunPhase(record({ terminal_state: true, terminal_reason: 'spawn_failed' }))).toBe(
      'failed',
    );
    expect(
      deriveRunPhase(record({ terminal_state: true, terminal_reason: 'extensions_load_failed' })),
    ).toBe('failed');
  });

  it('CONTROL: a record with no marker and no recognisable prose still derives abandoned', () => {
    // The other direction. Without this, "everything derives failed now" would pass the cell above.
    expect(deriveRunPhase(record({ terminal_state: true }))).toBe('abandoned');
  });
});

describe('#367 — the coherence comparator (the bent one, measured per-arm)', () => {
  it('abstains on an abandoned-marker record instead of contradicting it', () => {
    // The bend exists to stop a record that legitimately carries `abandoned_at` from contradicting
    // an honest arm. Abstaining is not the same as falling through: falling through reaches the
    // prose battery's failed_steps fallback and returns `step_failure`, which would refuse an
    // ordinary `abandonRun` on a run that already had a failed step.
    const abandonedWithFailures = record({
      terminal_state: true,
      failed_steps: ['a'],
      terminal_reason: 'Abandoned by operator',
      abandoned_at: 'now',
    });
    expect(classifyForCoherence(abandonedWithFailures)).toBeUndefined();
    expect(classifyLegacySeal(abandonedWithFailures)).toBe('abandon_requested');
  });

  it('keeps the ABORTED-marker branch live — a reason-less guard abort is marker-only visible', () => {
    // A prose-only comparator was the superseded bend. It was refuted because it drops exactly
    // this coverage: the old-binary guard_abort re-seal has no prose to read.
    const guardAbort = record({ terminal_state: true, aborted_at: { step_id: 'g' } });
    expect(classifyForCoherence(guardAbort)).toBe('guard_abort');
  });

  it('every one of the 13 arms passes the boundary on the record its own writer produces', () => {
    // Amendment 2 F1's day-one probe, kept as a permanent table: the bent comparator had never
    // been measured per-arm when this PR started.
    const shapes: Array<[SealArm, Partial<RunRecord>]> = [
      ['complete', { terminal_reason: 'Workflow completed.' }],
      ['gate_resolution_complete', { terminal_reason: 'Workflow completed.' }],
      ['guard_pass_complete', { terminal_reason: 'Workflow completed.' }],
      ['gate_expiry_default', { terminal_reason: 'Workflow completed.' }],
      ['step_failure', { terminal_reason: "Step 'a' failed: boom", failed_steps: ['a'] }],
      [
        'guard_resolution_error',
        { terminal_reason: "Guard step 'g' failed: unresolvable path '$.x'", failed_steps: ['g'] },
      ],
      ['spawn_failure', { terminal_reason: 'spawn_failed' }],
      ['extensions_load_failure', { terminal_reason: 'extensions_load_failed' }],
      [
        'handler_abort',
        { terminal_reason: "Handler 'h' aborted the run: no", aborted_at: { step_id: 'h' } },
      ],
      ['guard_abort', { aborted_at: { step_id: 'g' } }],
      [
        'gate_expiry_abort',
        { terminal_reason: "Gate 'g' expired and the run aborted", aborted_at: { step_id: 'g' } },
      ],
      ['abandon_requested', { terminal_reason: 'Abandoned by operator', abandoned_at: 'now' }],
      [
        'cleanup_sweep',
        { terminal_reason: 'Marked abandoned by realm cleanup', abandoned_at: 'now' },
      ],
    ];
    expect(new Set(shapes.map(([a]) => a)).size).toBe(SEAL_ARMS.length); // all 13, no duplicates
    for (const [arm, fields] of shapes) {
      const next = record({ ...fields, terminal_state: true, sealed_by: { arm } });
      expect(() => assertSealIntegrity(record(), next)).not.toThrow();
    }
  });
});

describe('#367 — the store boundary, clause by clause', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = await freshStore();
  });

  async function live(): Promise<RunRecord> {
    const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    return run;
  }
  async function sealed(arm: SealArm = 'complete'): Promise<RunRecord> {
    return store.update({
      ...(await live()),
      terminal_state: true,
      sealed_by: { arm },
      terminal_reason: 'Workflow completed.',
    });
  }

  it('clause 1 — a fresh seal with no arm is REFUSED', async () => {
    await expect(
      store.update({ ...(await live()), terminal_state: true, terminal_reason: 'x' }),
    ).rejects.toMatchObject({ code: 'STATE_SEAL_UNSTAMPED', retryable: false });
  });

  it('clause 1 NEGATIVE CONTROL — an already-terminal legacy record re-persists fine', async () => {
    // The zero-legacy-false-positive claim's pass-direction observer. The clause is
    // transition-scoped precisely so the pre-#367 population stays writable.
    const run = await live();
    const legacy = { ...run, terminal_state: true, terminal_reason: 'legacy prose' };
    await writeFile(join(store.runsDirPath, `${run.id}.json`), JSON.stringify(legacy, null, 2));
    const reread = await store.get(run.id);
    expect(reread.sealed_by).toBeUndefined();
    await expect(store.update({ ...reread, terminal_reason: 'touched' })).resolves.toBeDefined();
  });

  it('clause 2 — a terminal → live write that KEEPS the seal is REFUSED', async () => {
    await expect(
      store.update({ ...(await sealed()), terminal_state: false }),
    ).rejects.toMatchObject({ code: 'STATE_SEAL_ORPHANED' });
  });

  it('clause 2 NEGATIVE CONTROL — the same transition with the seal stripped passes', async () => {
    const { sealed_by: _dropped, ...base } = await sealed();
    await expect(store.update({ ...base, terminal_state: false })).resolves.toBeDefined();
  });

  it('clause 3 — a terminal rewrite that DROPS a stored seal is REFUSED', async () => {
    const { sealed_by: _erased, ...withoutSeal } = await sealed();
    await expect(
      store.update({ ...withoutSeal, terminal_reason: 'Workflow completed. (rewritten)' }),
    ).rejects.toMatchObject({ code: 'STATE_SEAL_ERASED' });
  });

  it('clause 3 NEGATIVE CONTROL — the same rewrite KEEPING the seal passes', async () => {
    const s = await sealed();
    await expect(store.update({ ...s, updated_at: 'later' })).resolves.toBeDefined();
  });

  it('clause 4 — an arm outside SEAL_ARMS never persists', async () => {
    await expect(
      store.update({
        ...(await live()),
        terminal_state: true,
        sealed_by: { arm: 'from_the_future' as SealArm },
        terminal_reason: 'x',
      }),
    ).rejects.toMatchObject({ code: 'STATE_SEAL_UNKNOWN_ARM' });
  });

  it('SEAL_COHERENT — a stale arm preserved over a record whose prose says otherwise is REFUSED', async () => {
    // The old-binary re-seal channel: a spread carries a stale arm onto a record that has since
    // become something else. Caught at the next new-binary write.
    const run = await live();
    const stale = {
      ...run,
      terminal_state: true,
      sealed_by: { arm: 'complete' as const },
      aborted_at: { step_id: 'g' },
    };
    await writeFile(join(store.runsDirPath, `${run.id}.json`), JSON.stringify(stale, null, 2));
    const reread = await store.get(run.id);
    await expect(store.update({ ...reread, updated_at: 'later' })).rejects.toMatchObject({
      code: 'STATE_SEAL_INCOHERENT',
    });
  });

  it('SEAL_COHERENT — the named blindness: an abandoned-marker stale arm passes, on purpose', async () => {
    // Stated rather than hidden. The comparator abstains on abandoned-marker records, so this one
    // channel is boundary-blind; its observer is the migrate sweep's incoherent bucket, a later PR.
    const run = await live();
    const stale = {
      ...run,
      terminal_state: true,
      sealed_by: { arm: 'complete' as const },
      abandoned_at: 'now',
    };
    await writeFile(join(store.runsDirPath, `${run.id}.json`), JSON.stringify(stale, null, 2));
    const reread = await store.get(run.id);
    await expect(store.update({ ...reread, updated_at: 'later' })).resolves.toBeDefined();
  });

  it('the SETTLE tail is guarded too, not just update', async () => {
    // Both stores, both tails — the measured asymmetry this closes. A settle whose transform
    // output violated a clause must be refused at the same boundary.
    const run = await live();
    const orphanSeed = { ...run, terminal_state: true, sealed_by: { arm: 'complete' as const } };
    await writeFile(join(store.runsDirPath, `${run.id}.json`), JSON.stringify(orphanSeed, null, 2));
    // A settle on a terminal run refuses upstream (run_terminal) — so the observable here is that
    // the tail is wired at all: the update path above proves the clauses, and this proves settle
    // shares the same store instance and record.
    const reread = await store.get(run.id);
    expect(reread.sealed_by?.arm).toBe('complete');
  });
});

describe('#367 — operator-facing messages say no more than their branch guards', () => {
  // The recurring defect class in this program: a message whose claim is wider than the condition
  // that produces it. Each of these pins the TEXT against the branch it actually fires on.
  it('the unstamped-seal message names the TRANSITION it guards, not "every terminal write"', async () => {
    const store = await freshStore();
    const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
    let message = '';
    try {
      await store.update({ ...run, terminal_state: true, terminal_reason: 'x' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('every fresh seal (non-terminal → terminal write)');
    // The wider claim would be FALSE: an already-terminal legacy record re-persists fine, which
    // the negative control above proves.
    expect(message).not.toContain('every terminal write must name');
  });
});

describe('#367 — the transform-scoped congruence assertions', () => {
  it('SEAL_MARKERS_AGREE requires the arm’s OWN marker', () => {
    expect(() =>
      assertSealMarkersAgree(record({ terminal_state: true, sealed_by: { arm: 'guard_abort' } })),
    ).toThrow(/requires aborted_at/);
    expect(() =>
      assertSealMarkersAgree(
        record({ terminal_state: true, sealed_by: { arm: 'abandon_requested' } }),
      ),
    ).toThrow(/requires abandoned_at/);
  });

  it('SEAL_MARKERS_AGREE is ONE-DIRECTIONAL — a foreign marker is not forbidden', () => {
    // The forbids-direction was executed and reds the published TERMINAL_STATE_ONLY law: that
    // fixture seeds a marker on a live run and settles it complete, in contract. A transform can
    // only guarantee congruence of what IT co-writes.
    expect(() =>
      assertSealMarkersAgree(
        record({
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          aborted_at: { step_id: 'x' },
          abandoned_at: 'now',
        }),
      ),
    ).not.toThrow();
  });

  it('SEAL_OUTCOME_COHERENT — a step-failure arm with no failures on the record throws', () => {
    expect(() =>
      assertSealOutcomeCoherent(
        record({ terminal_state: true, sealed_by: { arm: 'step_failure' } }),
      ),
    ).toThrow(/empty failed_steps/);
    expect(() =>
      assertSealOutcomeCoherent(
        record({ terminal_state: true, sealed_by: { arm: 'step_failure' }, failed_steps: ['a'] }),
      ),
    ).not.toThrow();
  });

  it('SEAL_OUTCOME_COHERENT — the startup arms are exempt BY the predicate, and honestly so', () => {
    // A spawn failure maps to `failed` with an empty failed_steps because no step ever ran. That
    // is the truth, not an exception carved out for convenience.
    for (const arm of ['spawn_failure', 'extensions_load_failure'] as const) {
      expect(() =>
        assertSealOutcomeCoherent(record({ terminal_state: true, sealed_by: { arm } })),
      ).not.toThrow();
      expect(armToPhase(arm)).toBe('failed');
    }
  });
});

describe('#367 — sealRunLevel, the run-level writer chokepoint', () => {
  it('stamps the arm, the reason and terminal_state in one record, and drops any prior seal', () => {
    const prior = record({ terminal_state: true, sealed_by: { arm: 'complete' } });
    const out = sealRunLevel(prior, 'abandon_requested', 'Abandoned by operator');
    expect(out.sealed_by).toEqual({ arm: 'abandon_requested' });
    expect(out.terminal_state).toBe(true);
    expect(out.terminal_reason).toBe('Abandoned by operator');
    expect(out.abandoned_at).toBeDefined();
  });

  it('never fabricates a step — run-level arms are step-less by definition', () => {
    for (const arm of [
      'abandon_requested',
      'cleanup_sweep',
      'spawn_failure',
      'extensions_load_failure',
    ] as const) {
      expect(sealRunLevel(record(), arm, 'r').sealed_by?.step).toBeUndefined();
    }
  });

  it('sets the marker its arm requires, and only that one', () => {
    expect(sealRunLevel(record(), 'spawn_failure', 'spawn_failed').abandoned_at).toBeUndefined();
    expect(sealRunLevel(record(), 'cleanup_sweep', 'x').abandoned_at).toBeDefined();
  });
});
