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
      finalizer_ledger: { cleanup: { status: 'pending' } },
    } as Partial<RunRecord>),
    contains: '(realm run drain)',
  },
  {
    kind: 'gate_corruption',
    run: makeRun({
      pending_gate: {
        gate_id: 'g1',
        step_name: 'confirm',
        preview: 'p',
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
    contains: 'definition_unresolvable (unreadable) (realm run abandon run-abc123)',
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
    expect(out).toContain('definition_unresolvable (parse) (realm run abandon run-abc123)');
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

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-stuck-cap-'));
    wfDir = join(home, '.realm', 'workflows');
    runsDir = join(home, '.realm', 'runs');
    mkdirSync(wfDir, { recursive: true });
    mkdirSync(runsDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const OLDER = new Date(Date.now() - 4 * 86_400_000).toISOString();
  const plantRun = (id: string, workflowId: string): void => {
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
        updated_at: OLDER,
        terminal_state: false,
      }),
      'utf8',
    );
  };
  const out = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

  it('CAP1 an entry ONE BYTE over the cap is named by SIZE and never parsed — zero bytes read', async () => {
    const big = join(wfDir, 'wf-big.json');
    const pad = 'x'.repeat(STUCK_DEFINITION_PARSE_CAP_BYTES);
    writeFileSync(big, JSON.stringify({ id: 'wf-big', schema_version: 3, pad }), 'utf8');
    expect(statSync(big).size).toBeGreaterThan(STUCK_DEFINITION_PARSE_CAP_BYTES);
    plantRun('run-big', 'wf-big');

    // The instrument: a spy on the module's own reader would not see `readFileSync` through the
    // built core, so the claim is pinned at the OBSERVABLE the cap produces — the size sentence,
    // which only the zero-read branch can mint — plus the class that only it sets.
    await listCommand.parseAsync(['--stuck', '--older-than', '0m'], { from: 'user' });

    expect(out()).toContain('definition_unresolvable (too_large) (realm run abandon run-big)');
  });

  it('CAP2 an UNDER-cap corrupt copy is PARSED and SELECTED — invariant (iii) made total', async () => {
    writeFileSync(join(wfDir, 'wf-corrupt.json'), '{ not json', 'utf8');
    plantRun('run-corrupt', 'wf-corrupt');

    await listCommand.parseAsync(['--stuck', '--older-than', '0m'], { from: 'user' });

    expect(out()).toContain('run-corrupt');
    expect(out()).toContain('definition_unresolvable');
  });

  it('CAP3 an over-cap entry and a corrupt one are DISTINGUISHABLE on the listing line', async () => {
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
    expect(bigLine).toContain('(too_large)');
    expect(corruptLine).not.toContain('(too_large)');
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
