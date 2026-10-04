// gate-claim-stable-625.test.ts — issue #625 (the holder slice, PR-H): law GATE_CLAIM_STABLE_WHILE_OPEN,
// the half that lives in the CLI package.
//
// The engine's own operations are cell'd in core (`gate-claim-stable-625.test.ts` there). The
// commands below live here: resume, cleanup, drain, purge, gc --heal, migrate --stamp-seals and the
// batch reclaim selector. While a question is open, none of them changes or removes the claim of
// the step that opened it — the claim's token is the proof an answer may pass back, so a command that
// re-minted it would silently stop the token meaning anything.
//
// Real stores in a scratch directory; no `$HOME`. Each cell asserts (a) the claim is byte-identical
// afterwards — token, holder, since, deadline — AND the question is still open. Each carries the
// change that turns it red and what it prints on failure: synthetic ids only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  executeStep,
  drainFinalizers,
  captureEvidence,
  deriveRunPhase,
  DRAIN_LEASE_MAX,
  classifyInProgressClaims,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type {
  Attributed,
  ClaimRecord,
  RunRecord,
  StepDispatcher,
  WorkflowDefinition,
  WorkflowRegistrar,
} from '@sensigo/realm';
import { resumeRun } from './resume.js';
import { cleanupRuns } from './cleanup.js';
import { runDrainAction, type DrainRuntimeDeps } from './drain.js';
import { purgeRuns } from './purge.js';
import { sweepStalePhases } from './gc.js';
import { migrateStampSeals } from './run-migrate.js';
import { isAutoReclaimable } from './reclaim.js';

const echo: StepDispatcher = async (_step, input) => ({ ...input });
const PROGRAM: Attributed = { by: 'alice@host', by_source: 'derived', channel: 'agent' };
const DEPS: DrainRuntimeDeps = { drainFinalizers, captureEvidence, drainLeaseMax: DRAIN_LEASE_MAX };

const definition: WorkflowDefinition = {
  id: 'gate-claim-stable-cli-wf',
  name: 'gate claim stable',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'] },
    },
    finish: { description: 'Finish', execution: 'agent', depends_on: ['confirm'] },
  },
};

const workflowStore: WorkflowRegistrar = {
  register: async () => {},
  get: async () => definition,
  list: async () => [],
};

let dir: string;
let store: JsonFileStore;
let runId: string;
let before: ClaimRecord;
let gateId: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-gate-claim-stable-cli-'));
  store = new JsonFileStore(dir);
  const { run } = await store.create({ workflowId: definition.id, workflowVersion: 1, params: {} });
  runId = run.id;
  const reply = await executeStep(store, definition, {
    runId,
    command: 'confirm',
    input: {},
    dispatcher: echo,
    driver: PROGRAM,
  });
  if (reply.status !== 'confirm_required')
    throw new Error(`fixture: gate not open (${reply.status})`);
  const open = await store.get(runId);
  before = open.claims!['confirm']!;
  gateId = open.pending_gate!.gate_id;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The claim and the open question must be exactly what the fixture opened. */
async function expectStable(): Promise<RunRecord> {
  const after = await store.get(runId);
  // (a) red when the command replaced, re-minted or removed the claim; (b) prints the claim
  //     before and after — synthetic values only.
  expect(after.claims?.['confirm']).toEqual(before);
  expect(after.pending_gate?.gate_id).toBe(gateId);
  expect(after.in_progress_steps).toContain('confirm');
  return after;
}

describe('GATE_CLAIM_STABLE_WHILE_OPEN — the commands', () => {
  it('resume (without and with --force): refused — a run at a gate has no failed step to resume', async () => {
    await expect(resumeRun(runId, 'confirm', store, workflowStore, {})).rejects.toBeDefined();
    await expectStable();
    await expect(
      resumeRun(runId, 'confirm', store, workflowStore, { force: true }),
    ).rejects.toBeDefined();
    await expectStable();
  });

  it('cleanup: a run at an open gate is skipped (somebody may be answering it)', async () => {
    const { affected } = await cleanupRuns({ olderThan: '0m' }, store);
    expect(affected.map((r) => r.id)).not.toContain(runId);
    await expectStable();
  });

  it('drain (plain and --force and --expired --force): a run that has not ended is not drained', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${String(code)}`);
    }) as never);
    for (const opts of [{}, { force: true }, { expired: true, force: true }]) {
      try {
        await runDrainAction(runId, opts, store, workflowStore, DEPS);
      } catch {
        /* a refusal exits non-zero — the cell is about the record */
      }
      await expectStable();
    }
    expect(log).toBeDefined();
  });

  it('purge --force (single id): refused — a run that has not ended is never purged', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await purgeRuns({ runId, dryRun: false }, store, []);
    expect(result.purged).not.toContain(runId);
    await expectStable();
  });

  it('gc --heal --force: rewrites a stale PHASE only — never the claim', async () => {
    // The store re-derives the phase on every write, so a stale persisted phase cannot be planted
    // through it: write the file directly — the case heal exists for.
    const file = join(dir, `${runId}.json`);
    const planted = JSON.parse(await readFile(file, 'utf8')) as RunRecord;
    await writeFile(file, JSON.stringify({ ...planted, run_phase: 'running' }), 'utf8');
    expect((JSON.parse(await readFile(file, 'utf8')) as RunRecord).run_phase).toBe('running');
    const result = await sweepStalePhases(store, { force: true, deriveRunPhase });
    // (a) red when the heal fails or skips the record (the cell then proves nothing); (b) prints it.
    expect(result.failed).toEqual([]);
    expect(result.healed).toHaveLength(1);
    const after = await expectStable();
    expect(after.run_phase).toBe('gate_waiting');
  });

  it('migrate --stamp-seals --force: only terminal records are offered, so a live run is never rewritten', async () => {
    const buckets = await migrateStampSeals(store, { force: true });
    expect(buckets.stamped.map((s) => s.id)).not.toContain(runId);
    await expectStable();
  });

  it('reclaim --all --force: the batch selector never selects the open gate’s claim (a gated step is per-step only)', async () => {
    const open = await store.get(runId);
    const claims = classifyInProgressClaims(open, new Date(Date.now() + 10 * 24 * 3600_000));
    const claim = claims.find((c) => c.step === 'confirm');
    expect(claim).toBeDefined();
    expect(
      isAutoReclaimable(
        open,
        claim!,
        { ...definition.steps['confirm']!, idempotent: true },
        {
          now: Date.now() + 10 * 24 * 3600_000,
        },
      ),
    ).toBe(false);
    await expectStable();
  });
});
