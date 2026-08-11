// reclaim-gate-advisory.test.ts — issue #291, Deliverable 4c ([F7] defer-to-drain advisory):
// reclaimStep never enacts a sibling gate's expiry itself — it only discloses it, pointing at
// `realm run drain --expired` as the guaranteed-reachable lever.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reclaimStep } from './reclaim-step.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { RunRecord } from '../types/run-record.js';

const pastIso = () => new Date(Date.now() - 60_000).toISOString();

describe('reclaimStep — gate expiry advisory (issue #291, [F7])', () => {
  let store: JsonFileStore;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-reclaim-gate-advisory-'));
    store = new JsonFileStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedRunWithStaleSiblingAndExpiredGate(
    overrides: Partial<RunRecord['pending_gate']>,
  ): Promise<RunRecord> {
    const { run } = await store.create({
      workflowId: 'reclaim-gate-advisory-wf',
      workflowVersion: 1,
      params: {},
    });
    // Mirrors the design's own "mint all claims BEFORE opening any gate" ordering: a sibling
    // step claimed, then a gate opened on a DIFFERENT step — both coexist on the record.
    return store.update({
      ...run,
      in_progress_steps: ['sibling'],
      claims: { sibling: { deadline: pastIso() } },
      pending_gate: {
        gate_id: 'gate-1',
        step_name: 'approve',
        preview: {},
        choices: ['approve', 'reject'],
        opened_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-01T00:05:00.000Z',
        on_expiry: 'abort',
        ...overrides,
      },
    });
  }

  it('reclaiming a stale SIBLING while the run ALSO carries an expired, enactable gate carries the advisory — but does NOT enact it', async () => {
    const run = await seedRunWithStaleSiblingAndExpiredGate({});
    const result = await reclaimStep(store, run.id, 'sibling');
    expect(result.outcome).toBe('reclaimed');
    expect(result.gateAdvisory).toBeDefined();
    expect(result.gateAdvisory).toContain("gate 'approve'");
    expect(result.gateAdvisory).toContain('on_expiry: abort');
    expect(result.gateAdvisory).toContain('realm run drain --expired');

    // reclaimStep itself never enacted anything — the gate is UNTOUCHED.
    const after = await store.get(run.id);
    expect(after.pending_gate).toBeDefined();
    expect(after.pending_gate?.gate_id).toBe('gate-1');
    expect(after.terminal_state).toBe(false);
  });

  it('no advisory when the gate has NOT yet expired', async () => {
    const future = new Date(Date.now() + 999_999_000).toISOString();
    const run = await seedRunWithStaleSiblingAndExpiredGate({ expires_at: future });
    const result = await reclaimStep(store, run.id, 'sibling');
    expect(result.gateAdvisory).toBeUndefined();
  });

  it('no advisory for a finding-only gate (expired but no on_expiry) — nothing enactable to point at', async () => {
    const run = await seedRunWithStaleSiblingAndExpiredGate({ on_expiry: undefined });
    const result = await reclaimStep(store, run.id, 'sibling');
    expect(result.gateAdvisory).toBeUndefined();
  });

  it('no advisory when the run carries no gate at all', async () => {
    const { run } = await store.create({
      workflowId: 'reclaim-gate-advisory-wf2',
      workflowVersion: 1,
      params: {},
    });
    const seeded = await store.update({
      ...run,
      in_progress_steps: ['sibling'],
      claims: { sibling: { deadline: pastIso() } },
    });
    const result = await reclaimStep(store, seeded.id, 'sibling');
    expect(result.gateAdvisory).toBeUndefined();
  });
});
