// issue #558 PR-T — the LABEL LAW, and the residual render group it exists to guard.
//
// `renderFindingLabel` is `never`-exhaustive (`list.ts`'s `default:` arm), so a new finding kind
// fails to COMPILE without a label. But `listRuns` RENDERS through five hard-coded kind groups —
// a kind in none of them is SELECTED by `--stuck` and prints no label at all (executed on main).
// The compile guard guards the renderer, not the render PATH. This law closes that gap: for every
// kind `renderFindingLabel` labels, a run carrying a finding of that kind renders a row CONTAINING
// that label. Stated per FINDING (a fixture may carry other findings — `capability_block`'s
// antecedent co-fires), so the assertion is containment, never equality.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRuns, listCommand } from './list.js';
import { STUCK_DEFINITION_PARSE_CAP_BYTES, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { RunStore, RunRecord, RunHealthFinding } from '@sensigo/realm';

type Kind = RunHealthFinding['kind'];

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-abc123',
    workflow_id: 'test-workflow',
    workflow_version: 1,
    run_phase: 'running',
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    version: 2,
    params: {},
    evidence: [],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: new Date(Date.now() - 47 * 86_400_000).toISOString(),
    terminal_state: false,
    ...overrides,
  };
}

function makeStore(runs: RunRecord[]): RunStore {
  return {
    persistsClaims: true,
    get: async () => runs[0]!,
    create: async () => ({ run: runs[0]!, created: true }),
    update: async () => runs[0]!,
    list: async () => runs,
    claimStep: async () => {
      throw new Error('unused');
    },
  };
}

const OLD = new Date(Date.now() - 47 * 86_400_000).toISOString();

/**
 * One fixture per LABELLED kind. Each is a real `RunRecord` that makes `classifyRunHealth`
 * produce that kind — never a hand-built finding, because the law is about the RENDER PATH and a
 * synthesized finding would bypass the producer that puts it there.
 */
const FIXTURES: Array<{ kind: Kind; run: RunRecord; probe?: boolean; contains: string }> = [
  {
    kind: 'stale_claim',
    run: makeRun({
      in_progress_steps: ['s1'],
      claims: {
        s1: { run_version: 1, claimed_at: OLD, deadline: OLD, claimant: 'x', attempt: 1 },
      },
    } as Partial<RunRecord>),
    contains: 's1=',
  },
  {
    kind: 'terminal_pending_finalizer',
    run: makeRun({
      terminal_state: true,
      run_phase: 'failed',
      failed_steps: ['s1'],
      finalizer_ledger: { cleanup: { status: 'pending', rank: 1 } },
    } as Partial<RunRecord>),
    contains: '(realm run drain)',
  },
  {
    kind: 'gate_corruption',
    run: makeRun({
      pending_gate: {
        gate_id: 'g1',
        step_name: 'confirm',
        preview: {},
        choices: ['a'],
        opened_at: OLD,
      },
      settled: { confirm: { token: 'g1', outcome: 'gate', choice: 'a' } },
    } as unknown as Partial<RunRecord>),
    contains: 'gate_corruption',
  },
  {
    kind: 'definition_unresolvable',
    run: makeRun(),
    probe: true,
    contains: 'definition_unresolvable (unreadable) (realm run inspect run-abc123)',
  },
];

describe('the --stuck label law (issue #558 PR-T)', () => {
  it('LAW every kind renderFindingLabel labels renders its label on the --stuck row', async () => {
    for (const f of FIXTURES) {
      const out = await listRuns(
        undefined,
        makeStore([f.run]),
        undefined,
        true,
        undefined,
        undefined,
        f.probe === true
          ? () => ({
              code: 'STATE_WORKFLOW_UNREADABLE',
              message: 'the registered copy could not be read (EACCES: /x.json)',
              class: 'unreadable',
            })
          : undefined,
      );
      expect(out, `kind ${f.kind} must be SELECTED by --stuck`).toContain('run-abc123');
      expect(out, `kind ${f.kind} must RENDER its label`).toContain(f.contains);
    }
  });

  it('LAW-b the fixture set covers every kind renderFindingLabel returns a string for — the law cannot silently shrink', () => {
    // The census is derived, not asserted from memory: the kinds that carry NO label are the
    // five `list.ts` names as its deliberate no-label decisions (issue #406 settled each).
    const UNLABELLED: Kind[] = [
      'never_claimed_idle',
      'resolved_gate_with_eligible_guard',
      'completed_with_failed_steps',
      'structured_output_downgraded',
      'trust_value_invalid',
    ];
    // The labelled kinds this law does NOT carry a fixture for are named here with the reason,
    // so adding a kind without a fixture is a visible edit rather than a silent gap.
    const LABELLED_WITHOUT_FIXTURE: Kind[] = [
      'wedged_gate_sibling', // shares stale_claim's `${step}=${reason}` arm and its group
      'capability_block', // shares stale_claim's group; needs a definition to fire
      'gate_expired_awaiting_drive', // #406's own cells cover the disposition matrix
      'terminal_with_stale_gate', // #406's own cells
      'drive_failing', // #401's own cells
    ];
    const covered = new Set<Kind>(FIXTURES.map((f) => f.kind));
    for (const k of LABELLED_WITHOUT_FIXTURE) expect(covered.has(k)).toBe(false);
    expect(UNLABELLED.length + LABELLED_WITHOUT_FIXTURE.length + covered.size).toBe(14);
  });

  it('LAW-c a `definition_unresolvable` finding is SELECTED and labelled even though it belongs to none of the five hard-coded groups — the RESIDUAL group is what makes that true', async () => {
    const out = await listRuns(
      undefined,
      makeStore([makeRun({ updated_at: new Date().toISOString() })]),
      undefined,
      true,
      undefined,
      undefined,
      () => ({
        code: 'RESOURCE_FORMAT_INVALID',
        message: "the registered copy of 'test-workflow' is not parseable JSON: ...",
        class: 'parse',
      }),
    );
    expect(out).toContain('run-abc123');
    expect(out).toContain('definition_unresolvable (parse) (realm run inspect run-abc123)');
  });

  it('LAW-d no probe ⇒ no finding, and every OTHER kind’s selection is unchanged', async () => {
    const fresh = makeRun({ updated_at: new Date().toISOString() });
    const out = await listRuns(undefined, makeStore([fresh]), undefined, true);
    expect(out).not.toContain('definition_unresolvable');
    expect(out).toContain('No stuck runs');
  });
});

// ---------------------------------------------------------------------------------------------
// issue #558 PR-T — the LISTING CAP. It lives in the `--stuck` probe closure and NOWHERE else:
// `get()` stays uncapped by #552's Resolution, so the run path is unchanged. Above the cap the
// finding NAMES the size and reads ZERO bytes — a listing must never be the surface that
// detonates a #557 expansion bomb.
describe('the --stuck listing cap (issue #558 PR-T)', () => {
  let home: string;
  let wfDir: string;
  let runsDir: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-stuck-cap-'));
    wfDir = join(home, '.realm', 'workflows');
    runsDir = join(home, '.realm', 'runs');
    mkdirSync(wfDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const OLDER = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const plantRun = (
    id: string,
    workflowId: string,
    updatedAt: string = OLDER,
    extra: Record<string, unknown> = {},
  ): void => {
    writeFileSync(
      join(runsDir, `${id}.json`),
      JSON.stringify({
        id,
        workflow_id: workflowId,
        workflow_version: 1,
        run_phase: 'running',
        completed_steps: [],
        in_progress_steps: [],
        failed_steps: [],
        skipped_steps: [],
        version: 1,
        params: {},
        evidence: [],
        created_at: OLDER,
        updated_at: updatedAt,
        terminal_state: false,
        ...extra,
      }),
      'utf8',
    );
  };
  const out = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  const err = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  it('CAP1 an entry ONE BYTE over the cap is never parsed — zero bytes read — and is NOT a finding: no row, one stderr footer naming it by SIZE (review fold C4)', async () => {
    const big = join(wfDir, 'wf-big.json');
    const pad = 'x'.repeat(STUCK_DEFINITION_PARSE_CAP_BYTES);
    writeFileSync(big, JSON.stringify({ id: 'wf-big', schema_version: 3, pad }), 'utf8');
    expect(statSync(big).size).toBeGreaterThan(STUCK_DEFINITION_PARSE_CAP_BYTES);
    // Touched NOW: the fixture's default `updated_at` is old enough to be idle-selected under
    // the default 24h gate, which would list the run for a DIFFERENT reason.
    plantRun('run-big', 'wf-big', new Date().toISOString());

    // The instrument: a spy on the module's own reader would not see `readFileSync` through the
    // built core, so the claim is pinned at the OBSERVABLE the cap produces — the size sentence,
    // which only the zero-read branch can mint — plus the class that only it sets.
    // Under the default 24h idle gate this run is selected by NOTHING — so the copy over the
    // cap must not put it on the list either.
    await listCommand.parseAsync(['--stuck'], { from: 'user' });

    expect(out()).not.toContain('run-big');
    expect(out()).not.toContain('definition_unresolvable');
    // The stdout verdict says the sweep was partial (review fold C20) — no positional word.
    expect(out()).toContain(
      'No stuck runs found (threshold 24h; 1 definition not inspected: wf-big).',
    );
    expect(err()).toContain(
      '⚠ workflow definition wf-big (4.0 MiB, 1 run) was not inspected by --stuck (over the ' +
        '4 MiB listing cap): this run was not checked for a broken definition; ' +
        'realm run list --workflow wf-big lists it, ' +
        'realm workflow validate --registered wf-big reads the copy.',
    );
  });

  it('CAP6 TWO definitions over the cap get ONE line EACH, every command carrying its own id — never an `<id>` placeholder (review fold C18)', async () => {
    const pad = 'x'.repeat(STUCK_DEFINITION_PARSE_CAP_BYTES);
    for (const id of ['wf-big', 'wf-big2']) {
      writeFileSync(
        join(wfDir, `${id}.json`),
        JSON.stringify({ id, schema_version: 3, pad }),
        'utf8',
      );
    }
    plantRun('run-a', 'wf-big');
    plantRun('run-b', 'wf-big');
    plantRun('run-c', 'wf-big2');

    await listCommand.parseAsync(['--stuck', '--older-than', '0m'], { from: 'user' });

    const lines = err().split('\n');
    expect(lines.filter((l) => l.startsWith('⚠ workflow definition ')).length).toBe(2);
    expect(err()).toContain(
      '⚠ workflow definition wf-big (4.0 MiB, 2 runs) was not inspected by --stuck (over the ' +
        '4 MiB listing cap): these runs were not checked for a broken definition; ' +
        'realm run list --workflow wf-big lists them, ' +
        'realm workflow validate --registered wf-big reads the copy.',
    );
    expect(err()).toContain('realm run list --workflow wf-big2 lists it');
    expect(err()).not.toContain('<id>');
    expect(out()).toContain(
      'Stuck runs (threshold 0m; 2 definitions not inspected: wf-big, wf-big2):',
    );
  });

  it('CAP1b with --older-than 0m the run IS listed (idle) with NO definition label, and the footer still names the copy', async () => {
    const pad = 'x'.repeat(STUCK_DEFINITION_PARSE_CAP_BYTES);
    writeFileSync(
      join(wfDir, 'wf-big.json'),
      JSON.stringify({ id: 'wf-big', schema_version: 3, pad }),
      'utf8',
    );
    plantRun('run-big', 'wf-big');

    await listCommand.parseAsync(['--stuck', '--older-than', '0m'], { from: 'user' });

    const bigLine =
      out()
        .split('\n')
        .find((l) => l.startsWith('run-big')) ?? '';
    expect(bigLine).not.toBe('');
    expect(bigLine).not.toContain('definition_unresolvable');
    expect(out()).toContain('Stuck runs (threshold 0m; 1 definition not inspected: wf-big):');
    expect(err()).toContain('wf-big (4.0 MiB, 1 run)');
  });

  it('CAP2 an UNDER-cap corrupt copy is PARSED and SELECTED — invariant (iii) made total', async () => {
    writeFileSync(join(wfDir, 'wf-corrupt.json'), '{ not json', 'utf8');
    plantRun('run-corrupt', 'wf-corrupt');

    await listCommand.parseAsync(['--stuck', '--older-than', '0m'], { from: 'user' });

    expect(out()).toContain('run-corrupt');
    expect(out()).toContain('definition_unresolvable');
  });

  it('CAP3 an over-cap entry and a corrupt one are DISTINGUISHABLE: the corrupt one is a labelled row, the over-cap one is a footer and never a label', async () => {
    const pad = 'x'.repeat(STUCK_DEFINITION_PARSE_CAP_BYTES);
    writeFileSync(
      join(wfDir, 'wf-big.json'),
      JSON.stringify({ id: 'wf-big', schema_version: 3, pad }),
      'utf8',
    );
    writeFileSync(join(wfDir, 'wf-corrupt.json'), '{ not json', 'utf8');
    plantRun('run-big', 'wf-big');
    plantRun('run-corrupt', 'wf-corrupt');

    await listCommand.parseAsync(['--stuck', '--older-than', '0m'], { from: 'user' });

    const lines = out().split('\n');
    const bigLine = lines.find((l) => l.startsWith('run-big')) ?? '';
    const corruptLine = lines.find((l) => l.startsWith('run-corrupt')) ?? '';
    expect(bigLine).not.toContain('definition_unresolvable');
    expect(corruptLine).toContain('definition_unresolvable (corrupt)');
    expect(err()).toContain('wf-big (4.0 MiB, 1 run)');
    expect(err()).not.toContain('wf-corrupt');
  });

  it('LAW-u a probe result that carries NO class renders `(unknown)` — never its error code (review fold C15)', async () => {
    const out = await listRuns(
      undefined,
      makeStore([makeRun({ updated_at: new Date().toISOString() })]),
      undefined,
      true,
      undefined,
      undefined,
      () => ({ code: 'ENGINE_INTERNAL', message: 'boom' }),
    );
    expect(out).toContain('definition_unresolvable (unknown) (realm run inspect run-abc123)');
    expect(out).not.toContain('ENGINE_INTERNAL');
  });

  it('LAW-g a GATE-WAITING run with an unreadable copy IS selected, and its label points at inspect (review fold C13; since R9 every live run does — the walk found abandon as the only offered act destroyed a repairable run)', async () => {
    const { chmodSync } = await import('node:fs');
    const copy = join(wfDir, 'wf-gate.json');
    writeFileSync(copy, JSON.stringify({ id: 'wf-gate', schema_version: 3 }), 'utf8');
    chmodSync(copy, 0o000);
    plantRun('run-g', 'wf-gate', OLDER, {
      run_phase: 'gate_waiting',
      pending_gate: {
        gate_id: 'g1',
        step_name: 's1',
        choices: ['a', 'b'],
        opened_at: OLDER,
        preview: {},
      },
    });
    try {
      await listCommand.parseAsync(['--stuck', '--older-than', '0m'], { from: 'user' });
    } finally {
      chmodSync(copy, 0o644);
    }
    const line =
      out()
        .split('\n')
        .find((l) => l.startsWith('run-g')) ?? '';
    expect(line).toContain('definition_unresolvable (unreadable) (realm run inspect run-g)');
    expect(line).not.toContain('abandon');
  });

  it('CAP5 a corrupt copy and a legacy copy render WORDS in the class slot — never an error code', async () => {
    writeFileSync(join(wfDir, 'wf-corrupt.json'), '{ not json', 'utf8');
    writeFileSync(join(wfDir, 'wf-legacy.json'), JSON.stringify({ id: 'wf-legacy' }), 'utf8');
    plantRun('run-corrupt', 'wf-corrupt');
    plantRun('run-legacy', 'wf-legacy');

    await listCommand.parseAsync(['--stuck', '--older-than', '0m'], { from: 'user' });

    const lines = out().split('\n');
    const corruptLine = lines.find((l) => l.startsWith('run-corrupt')) ?? '';
    const legacyLine = lines.find((l) => l.startsWith('run-legacy')) ?? '';
    // The review's probe: both rendered their CODE (`RESOURCE_FORMAT_INVALID` /
    // `STATE_LEGACY_FORMAT`) in a slot every other class fills with a word.
    expect(corruptLine).toContain('definition_unresolvable (corrupt)');
    expect(legacyLine).toContain('definition_unresolvable (legacy)');
    expect(out()).not.toContain('RESOURCE_FORMAT_INVALID');
    expect(out()).not.toContain('STATE_LEGACY_FORMAT');
  });

  it('WITNESS the --stuck closure narrows its catch with instanceof — never a duck-typed `err as { code?`', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'list.ts'), 'utf8');
    expect(src).not.toMatch(/err as \{\s*code\?:/);
    expect(src).toContain('err instanceof WorkflowError');
  });

  it('CAP4 a HEALTHY copy produces no definition_unresolvable label at all', async () => {
    writeFileSync(
      join(wfDir, 'wf-ok.json'),
      JSON.stringify({
        id: 'wf-ok',
        name: 'n',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        origin: 'human',
        steps: { a: { description: 'a', execution: 'agent' } },
      }),
      'utf8',
    );
    plantRun('run-ok', 'wf-ok');

    await listCommand.parseAsync(['--stuck', '--older-than', '0m'], { from: 'user' });

    expect(out()).toContain('run-ok');
    expect(out()).not.toContain('definition_unresolvable');
  });
});
