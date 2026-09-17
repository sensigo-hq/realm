// Tests for the cleanupRuns function — CLI cleanup command logic.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRuns, cleanupCommand } from './cleanup.js';
import { JsonFileStore } from '@sensigo/realm';
import type { RunRecord } from '@sensigo/realm';
import { v4 as uuidv4 } from 'uuid';

/** Write a RunRecord directly to the store dir, bypassing store.create/update timestamps. */
async function injectRun(dir: string, run: RunRecord): Promise<void> {
  await writeFile(join(dir, `${run.id}.json`), JSON.stringify(run, null, 2), 'utf8');
}

function makeRun(overrides: Partial<RunRecord> & { id?: string }): RunRecord {
  const id = overrides.id ?? uuidv4();
  return {
    id,
    workflow_id: 'test-wf',
    workflow_version: 1,
    run_phase: 'running',
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    params: {},
    evidence: [],
    version: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    terminal_state: false,
    ...overrides,
  };
}

describe('cleanupRuns', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-cleanup-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('marks old non-terminal runs as abandoned', async () => {
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);

    const oldTime = new Date(now.getTime() - 2 * 86_400_000).toISOString(); // 2 days ago
    const run = makeRun({ updated_at: oldTime });
    await injectRun(dir, run);

    const store = new JsonFileStore(dir);
    const { affected } = await cleanupRuns({ olderThan: '1d' }, store);

    expect(affected).toHaveLength(1);
    expect(affected[0]?.id).toBe(run.id);

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('abandoned');
    expect(updated.terminal_state).toBe(true);
    expect(updated.terminal_reason).toBe('Marked abandoned by realm cleanup');
  });

  it('leaves runs updated within the threshold untouched', async () => {
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);

    const recentTime = new Date(now.getTime() - 30 * 60_000).toISOString(); // 30 minutes ago
    const run = makeRun({ updated_at: recentTime });
    await injectRun(dir, run);

    const store = new JsonFileStore(dir);
    const { affected } = await cleanupRuns({ olderThan: '1h' }, store);

    expect(affected).toHaveLength(0);

    const unchanged = await store.get(run.id);
    expect(unchanged.run_phase).toBe('running');
  });

  it('dry-run reports affected runs without writing changes', async () => {
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);

    const oldTime = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const run = makeRun({ updated_at: oldTime });
    await injectRun(dir, run);

    const store = new JsonFileStore(dir);
    const { affected } = await cleanupRuns({ olderThan: '1d', dryRun: true }, store);

    expect(affected).toHaveLength(1);

    // State should NOT have changed because dryRun is true.
    const unchanged = await store.get(run.id);
    expect(unchanged.run_phase).toBe('running');
    expect(unchanged.terminal_state).toBe(false);
  });

  it('skips runs that are already terminal', async () => {
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);

    const oldTime = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const terminalRun = makeRun({
      updated_at: oldTime,
      run_phase: 'completed',
      terminal_state: true,
    });
    await injectRun(dir, terminalRun);

    const store = new JsonFileStore(dir);
    const { affected } = await cleanupRuns({ olderThan: '1d' }, store);

    expect(affected).toHaveLength(0);
  });

  it('does not abandon gate-waiting runs', async () => {
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);

    const oldTime = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    // issue #367: the fixture now carries the GATE, not just the label. It used to set
    // `run_phase: 'gate_waiting'` with no `pending_gate` behind it, which pinned the old
    // label-trusting skip — a record claiming to wait on a gate that does not exist is the #282
    // stale-label shape, and such a run is genuinely idle.
    const gateRun = makeRun({
      updated_at: oldTime,
      run_phase: 'gate_waiting',
      pending_gate: {
        gate_id: 'g1',
        step_name: 'step-one',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: oldTime,
      },
    });
    await injectRun(dir, gateRun);

    const store = new JsonFileStore(dir);
    const { affected } = await cleanupRuns({ olderThan: '1d' }, store);

    expect(affected).toHaveLength(0);

    const unchanged = await store.get(gateRun.id);
    expect(unchanged.terminal_state).toBe(false);
  });

  it('does not kill a run waiting on a LIVE gate whose persisted phase is STALE', async () => {
    // The defect this closes: the waiting-skip keyed on the PERSISTED `run_phase`, so a record
    // whose label had gone stale while a human was genuinely mid-gate got swept — sealed
    // `cleanup_sweep` with `pending_gate` still on the terminal record, freshly minting the very
    // zombie shape #282 closed. The stale-phase population is exactly what `gc --heal` exists for,
    // so cleanup-before-heal is an ordinary ordering, not an exotic one.
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);
    const oldTime = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const staleGated = makeRun({
      updated_at: oldTime,
      run_phase: 'running', // STALE — a human is actually waiting on the gate below
      pending_gate: {
        gate_id: 'g-live',
        step_name: 'step-one',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: oldTime,
      },
    });
    await injectRun(dir, staleGated);

    const store = new JsonFileStore(dir);
    const { affected } = await cleanupRuns({ olderThan: '1d' }, store);
    expect(affected).toHaveLength(0);

    const unchanged = await store.get(staleGated.id);
    expect(unchanged.terminal_state).toBe(false);
    expect(unchanged.sealed_by).toBeUndefined();
    expect(unchanged.pending_gate).toBeDefined();
  });

  it('a stale gate LABEL with no gate behind it is NOT protected — it is an idle run', async () => {
    // The other polarity, so "skip anything that mentions a gate" cannot pass the cell above.
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);
    const oldTime = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const labelOnly = makeRun({ updated_at: oldTime, run_phase: 'gate_waiting' });
    await injectRun(dir, labelOnly);

    const store = new JsonFileStore(dir);
    const { affected } = await cleanupRuns({ olderThan: '1d' }, store);
    expect(affected).toHaveLength(1);
  });

  it('the sweep seals arm `cleanup_sweep`, and says what it killed', async () => {
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);
    const oldTime = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const idle = makeRun({ updated_at: oldTime, run_phase: 'running' });
    await injectRun(dir, idle);

    const store = new JsonFileStore(dir);
    await cleanupRuns({ olderThan: '1d' }, store);
    const swept = await store.get(idle.id);
    expect(swept.sealed_by).toEqual({ arm: 'cleanup_sweep' });
    expect(swept.run_phase).toBe('abandoned');
    expect(swept.terminal_state).toBe(true);
  });

  it('sets abandoned_at and derives abandoned (not failed) for an idle running run carrying failed_steps', async () => {
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);

    const oldTime = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    // A running run that already accumulated a failed step — without the authoritative marker this
    // would derive to 'failed' on cleanup's update().
    const run = makeRun({ updated_at: oldTime, run_phase: 'running', failed_steps: ['step_a'] });
    await injectRun(dir, run);

    const store = new JsonFileStore(dir);
    const { affected } = await cleanupRuns({ olderThan: '1d' }, store);
    expect(affected).toHaveLength(1);

    const updated = await store.get(run.id);
    expect(updated.abandoned_at).toBeDefined();
    expect(updated.run_phase).toBe('abandoned'); // authoritative marker beats failed_steps
    expect(updated.terminal_state).toBe(true);
  });

  it('issue #558 PR-C: the sweep releases every claim in the same write it seals with', async () => {
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);
    const oldTime = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    // An idle run that died mid-claim: a claimed step with an open-ended claim. Before PR-C the
    // sweep sealed it and left the claim, so `purge` refused the dead run on a claim nobody held.
    const run = makeRun({
      updated_at: oldTime,
      in_progress_steps: ['analyze'],
      claims: { analyze: { deadline: null } },
    });
    await injectRun(dir, run);

    const store = new JsonFileStore(dir);
    const { affected } = await cleanupRuns({ olderThan: '1d' }, store);
    expect(affected).toHaveLength(1);

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('abandoned');
    expect(updated.in_progress_steps).toEqual([]);
    expect(updated.claims).toEqual({});
  });

  it('issue #558 PR-C: `realm run cleanup` prints the kill advisory — the THIRD surface of the one mint', async () => {
    // The per-member sweep found the mint pinned at two surfaces and this render pinned nowhere:
    // deleting the line left this file green. The command, not the function, prints it.
    const { ABANDON_KILL_ADVISORY } = await import('@sensigo/realm');
    const now = new Date('2024-06-01T12:00:00Z');
    vi.setSystemTime(now);
    const oldTime = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const home = await mkdtemp(join(tmpdir(), 'realm-cleanup-home-'));
    const runsDir = join(home, '.realm', 'runs');
    await mkdir(runsDir, { recursive: true });
    await injectRun(runsDir, makeRun({ updated_at: oldTime }));
    const originalHome = process.env['HOME'];
    process.env['HOME'] = home;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await cleanupCommand.parseAsync(['--older-than', '1d'], { from: 'user' });
      const logged = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(logged).toContain(ABANDON_KILL_ADVISORY);
    } finally {
      logSpy.mockRestore();
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
      await rm(home, { recursive: true, force: true });
    }
  });
});
