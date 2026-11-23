// claim-deadline-cause-592f2.test.ts — Q1 (#592) unit f2 (prompt q1-f2-claim-deadline-cause.md): a
// claim with no time limit says why. Checks 1 to 3 at core: the helper and its words, the writer core
// ships (`JsonFileStore`; the in-memory and SQLite stores are held by the fidelity law
// CLAIM_KEEPS_DEADLINE_CAUSE, in testing and store-sqlite), the gate-open rewrite of a leased claim,
// and the readers (`classifyInProgressClaims`, run-health's claim branch).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import {
  CLAIM_DEADLINE_ABSENT_CAUSES,
  claimDeadlineOf,
  classifyInProgressClaims,
  computeClaimDeadline,
} from './claim-liveness.js';
import { classifyRunHealth } from './run-health.js';
import { writtenSnapshot } from './snapshot.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { jsonAsRunStore } from '../test-support/json-as-run-store.js';
import type { ClaimRecord, PendingGate, RunRecord } from '../types/run-record.js';
import type { ClaimDeadlineAbsent } from './claim-liveness.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const step = (execution: StepDefinition['execution']): StepDefinition => ({
  description: 'S.',
  execution,
  depends_on: [],
});
const def = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  steps,
});
/** The three shapes Realm's writers meet, each with one step `work` eligible on a fresh run. */
const AUTO = def('f2-auto', { work: step('auto') });
const AGENT = def('f2-agent', { work: step('agent') });
const FINALIZED = def('f2-finalized', { work: step('auto'), tidy: step('finalizer') });
/** An agent step in a workflow with a finalizer: `step_not_auto` is judged first. */
const AGENT_FINALIZED = def('f2-agent-finalized', { work: step('agent'), tidy: step('finalizer') });

describe('Q1 (#592) unit f2 — check 1: the helper and its words', () => {
  it('the words, in the order they are judged', () => {
    // (a) red when a word is added, dropped, renamed or moved; (b) prints the list.
    expect(CLAIM_DEADLINE_ABSENT_CAUSES).toEqual([
      'step_unknown',
      'step_not_auto',
      'finalizer_bearing',
    ]);
  });

  it('the four cases and the precedence: a deadline with no cause; step_unknown, step_not_auto, finalizer_bearing; an agent step beside a finalizer is step_not_auto', () => {
    const of = (d: WorkflowDefinition, s = 'work') => {
      const r = claimDeadlineOf(d, s, NOW);
      return { deadline: typeof r.deadline, absent: r.absent };
    };
    // (a) red when a cause is swapped, the precedence reversed (finalizer_bearing judged before
    //     step_not_auto), or a deadline comes with a cause; (b) prints each answer.
    expect({
      auto: of(AUTO),
      unknown: of(AUTO, 'ghost'),
      agent: of(AGENT),
      finalized: of(FINALIZED),
      agentFinalized: of(AGENT_FINALIZED),
    }).toEqual({
      auto: { deadline: 'string', absent: undefined },
      unknown: { deadline: 'object', absent: 'step_unknown' },
      agent: { deadline: 'object', absent: 'step_not_auto' },
      finalized: { deadline: 'object', absent: 'finalizer_bearing' },
      agentFinalized: { deadline: 'object', absent: 'step_not_auto' },
    });
    // (a) red when a concrete deadline carries an `absent` key at all; (b) prints the keys.
    expect(Object.keys(claimDeadlineOf(AUTO, 'work', NOW))).toEqual(['deadline']);
  });

  it('computeClaimDeadline gives claimDeadlineOf’s deadline, byte for byte, on every shape', () => {
    const pairs = [
      [AUTO, 'work'],
      [AUTO, 'ghost'],
      [AGENT, 'work'],
      [FINALIZED, 'work'],
    ] as const;
    // (a) red when the two disagree; (b) prints both.
    expect(pairs.map(([d, s]) => computeClaimDeadline(d, s, NOW))).toEqual(
      pairs.map(([d, s]) => claimDeadlineOf(d, s, NOW).deadline),
    );
  });
});

describe('Q1 (#592) unit f2 — check 2: the JSON-file store writes the cause', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('claimStep on the three shapes: a deadline and no cause; null and step_not_auto; null and finalizer_bearing; get returns each', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-f2-json-'));
    dirs.push(dir);
    const store = jsonAsRunStore(new JsonFileStore(dir));
    const claimOf = async (d: WorkflowDefinition) => {
      const { record } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const { record: claimed } = await store.claimStep(record.id, 'work', d);
      const { record: read } = await store.get(record.id);
      const shape = (c: ClaimRecord | undefined) => ({
        deadline: typeof c?.deadline,
        has: c !== undefined && 'deadline_absent' in c,
        absent: c?.deadline_absent,
      });
      return { returned: shape(claimed.claims?.['work']), read: shape(read.claims?.['work']) };
    };
    const none = { deadline: 'string', has: false, absent: undefined };
    const agent = { deadline: 'object', has: true, absent: 'step_not_auto' };
    const finalized = { deadline: 'object', has: true, absent: 'finalizer_bearing' };
    // (a) red when the JSON-file store drops the spread, writes the cause beside a deadline, or does
    //     not keep it on the stored record; (b) prints each claim's shape, returned and read.
    expect({
      auto: await claimOf(AUTO),
      agent: await claimOf(AGENT),
      finalized: await claimOf(FINALIZED),
    }).toEqual({
      auto: { returned: none, read: none },
      agent: { returned: agent, read: agent },
      finalized: { returned: finalized, read: finalized },
    });
  });
});

describe('Q1 (#592) unit f2 — check 2: the gate opened on a leased claim keeps the cause', () => {
  it('a leased claim on an agent step, then its gate opened: the claim names no lease and still says step_not_auto', async () => {
    const double = createLeaseDouble();
    const store = new InMemoryStore({ leases: double });
    const gated: WorkflowDefinition = def('f2-gated', {
      work: {
        description: 'Ask.',
        execution: 'agent',
        depends_on: [],
        trust: 'human_confirmed',
        gate: { choices: ['yes', 'no'] },
      },
    });
    const { record } = await store.create({ workflowId: gated.id, workflowVersion: 1, params: {} });
    const held = await double.hold();
    if (!('held' in held)) throw new Error('fixture: the double made no lease');
    const { record: claimed } = await store.claimStep(
      record.id,
      'work',
      gated,
      undefined,
      held.held,
    );
    const claim = claimed.claims!['work']!;
    const gate: PendingGate = {
      gate_id: 'f2-gate',
      step_name: 'work',
      preview: {},
      choices: ['yes', 'no'],
      opened_at: NOW.toISOString(),
    };
    const result = await store.settleStep!(
      record.id,
      {
        kind: 'open_gate',
        step: 'work',
        claimToken: claim.token!,
        pendingGate: gate,
        evidence: [],
      },
      gated,
    );
    const kept = (await store.get(record.id)).record.claims?.['work'];
    // (a) red when the gate-open write rebuilds the claim instead of spreading it (the cause is
    //     lost), or keeps the lease; (b) prints the claim before and after.
    expect({
      applied: result.applied,
      before: { lease: claim.lease !== undefined, absent: claim.deadline_absent },
      after: { lease: kept?.lease, absent: kept?.deadline_absent, token: kept?.token },
    }).toEqual({
      applied: true,
      before: { lease: true, absent: 'step_not_auto' },
      after: { lease: undefined, absent: 'step_not_auto', token: claim.token },
    });
  });
});

/** A running run with `work` in progress under `claim` (or no claim record at all). */
function runWith(claim: ClaimRecord | undefined, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    workflow_id: 'f2-agent',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: ['work'],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: ago(3_600_000),
    updated_at: ago(61_000),
    terminal_state: false,
    ...(claim !== undefined ? { claims: { work: claim } } : {}),
    ...over,
  };
}

describe('Q1 (#592) unit f2 — check 3: the readers', () => {
  const info = (claim: ClaimRecord | undefined) =>
    classifyInProgressClaims(writtenSnapshot(runWith(claim), NOW))[0]!;
  const evidenceOf = (claim: ClaimRecord | undefined) =>
    classifyRunHealth(writtenSnapshot(runWith(claim), NOW), { definition: AGENT }).find(
      (f) => f.kind === 'stale_claim',
    )?.evidence;

  it('classifyInProgressClaims: the stored word as it is; not_recorded for a claim without the field or no claim; nothing beside a string deadline', () => {
    // (a) red when the reader guesses a cause for a missing field (step_not_auto where not_recorded
    //     is due), replaces a word it does not know, or reads a cause beside a string deadline;
    //     (b) prints each info.
    expect({
      recorded: info({ deadline: null, deadline_absent: 'step_not_auto' }),
      finalizer: info({ deadline: null, deadline_absent: 'finalizer_bearing' }),
      preF2: info({ deadline: null }),
      noClaim: info(undefined),
      foreign: info({
        deadline: null,
        deadline_absent: 'whatever' as ClaimDeadlineAbsent,
      }),
      both: info({ deadline: ago(1_000), deadline_absent: 'step_not_auto' }),
    }).toEqual({
      recorded: {
        step: 'work',
        state: 'claim_unknown_age',
        deadline: null,
        deadline_absent: 'step_not_auto',
      },
      finalizer: {
        step: 'work',
        state: 'claim_unknown_age',
        deadline: null,
        deadline_absent: 'finalizer_bearing',
      },
      preF2: {
        step: 'work',
        state: 'claim_unknown_age',
        deadline: null,
        deadline_absent: 'not_recorded',
      },
      noClaim: {
        step: 'work',
        state: 'claim_unknown_age',
        deadline: null,
        deadline_absent: 'not_recorded',
      },
      foreign: {
        step: 'work',
        state: 'claim_unknown_age',
        deadline: null,
        deadline_absent: 'whatever',
      },
      both: { step: 'work', state: 'claim_stale', deadline: ago(1_000) },
    });
  });

  it('run-health’s claim evidence carries the same word; a deadline with a cause beside it is judged by the deadline, the cause not on the evidence', () => {
    // (a) red when the evidence drops the cause, guesses one, or carries it beside a deadline;
    //     (b) prints each evidence.
    expect({
      recorded: evidenceOf({ deadline: null, deadline_absent: 'step_not_auto' }),
      preF2: evidenceOf({ deadline: null }),
      foreign: evidenceOf({
        deadline: null,
        deadline_absent: 'whatever' as ClaimDeadlineAbsent,
      }),
      both: evidenceOf({ deadline: ago(1_000), deadline_absent: 'step_not_auto' }),
    }).toEqual({
      recorded: { state: 'claim_unknown_age', deadline: null, deadline_absent: 'step_not_auto' },
      preF2: { state: 'claim_unknown_age', deadline: null, deadline_absent: 'not_recorded' },
      foreign: { state: 'claim_unknown_age', deadline: null, deadline_absent: 'whatever' },
      both: { state: 'claim_stale', deadline: ago(1_000) },
    });
  });
});
