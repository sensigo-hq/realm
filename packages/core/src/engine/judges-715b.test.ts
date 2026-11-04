// judges-715b.test.ts — issue #715 (b) 02 §A.1 (D6-17, D6-19's rule): each core judge of a record's
// time gives a verdict that DIFFERS between two snapshots of ONE record — one a second before its
// deadline, one a second after — so it reads the snapshot's `at` and nothing else. The record's
// instants are in 2031, far from the host's clock: a judge that read the wall clock would give the
// same verdict for both snapshots.
//
// Judges with no time in their verdict are named, not celled: `nothingRanHint` (it words the record
// only) and `pickNextEngineStep` (it picks among the steps the view owes; the view's own time verdict
// is `describePending`'s, celled here). `findDriveFailing` decides by counts since 02 §D.2 — its
// reason's age is celled here.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { classifyClaim, classifyInProgressClaims } from './claim-liveness.js';
import { computeGateDueState } from './gate-timing.js';
import { describePending, dueExpiry } from './pending.js';
import { classifyRunHealth } from './run-health.js';
import { writtenSnapshot } from './snapshot.js';
import type { PendingGate, RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const DEADLINE = Date.parse('2031-05-06T07:08:09.000Z');
const BEFORE = new Date(DEADLINE - 1_000);
const AFTER = new Date(DEADLINE + 1_000);
const iso = (ms: number) => new Date(ms).toISOString();

const GATE: PendingGate = {
  gate_id: 'g1',
  step_name: 'ask',
  preview: {},
  choices: ['approve', 'reject'],
  opened_at: iso(DEADLINE - 60_000),
  expires_at: iso(DEADLINE),
  on_expiry: 'abort',
} as PendingGate;

const DEF: WorkflowDefinition = {
  id: 'judges-715b',
  name: 'judges 715b',
  version: 1,
  steps: {
    ask: {
      description: 'Ask.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], timeout_seconds: 60, on_expiry: 'abort' },
    },
  },
} as WorkflowDefinition;

const RECORD = {
  id: 'r1',
  workflow_id: DEF.id,
  workflow_version: 1,
  completed_steps: [],
  in_progress_steps: ['ask'],
  failed_steps: [],
  skipped_steps: [],
  run_phase: 'gate_waiting',
  version: 3,
  params: {},
  evidence: [],
  created_at: iso(DEADLINE - 120_000),
  updated_at: iso(DEADLINE - 60_000),
  pending_gate: GATE,
  claims: { ask: { deadline: iso(DEADLINE), token: 't' } },
  drive_failures: {
    first_failed_at: iso(DEADLINE - 60_000),
    total: 1,
    entries: [
      {
        at: iso(DEADLINE - 60_000),
        step: 'ask',
        provider: 'p',
        error_class: 'other',
        message: 'm',
        elapsed_ms: 1,
        evidence_count: 0,
        gate_id: 'g1',
      },
    ],
  },
} as unknown as RunRecord;

const at = (when: Date) => writtenSnapshot(RECORD, when);

describe('#715 (b) §A.1 — each judge reads the snapshot’s at', () => {
  it('describePending: the question is due after its deadline, not before', () => {
    // (a) red when describePending judges at any instant but the snapshot's (the wall clock gives
    //     the same verdict twice); (b) prints both verdicts.
    expect([
      describePending(DEF, at(BEFORE), undefined).expiry_due,
      describePending(DEF, at(AFTER), undefined).expiry_due?.gate_id,
    ]).toEqual([undefined, 'g1']);
  });

  it('classifyRunHealth: gate_expired_awaiting_drive after the deadline, not before; drive_failing’s age is the snapshot’s', () => {
    // (a) red when the health judge reads another instant; (b) prints the kinds and the ages.
    const kinds = (when: Date) => classifyRunHealth(at(when)).map((f) => f.kind);
    const driveAge = (when: Date) =>
      classifyRunHealth(at(when)).find((f) => f.kind === 'drive_failing')?.reason;
    expect({
      before: kinds(BEFORE).includes('gate_expired_awaiting_drive'),
      after: kinds(AFTER).includes('gate_expired_awaiting_drive'),
      agesDiffer: driveAge(BEFORE) !== driveAge(AFTER),
    }).toEqual({ before: false, after: true, agesDiffer: true });
  });

  it('classifyInProgressClaims (and classifyClaim inside it): the claim is healthy before its deadline, stale after', () => {
    // (a) red when the claim judge reads another instant; (b) prints both states.
    expect([
      classifyInProgressClaims(at(BEFORE))[0]?.state,
      classifyInProgressClaims(at(AFTER))[0]?.state,
      classifyClaim(RECORD.claims!['ask'], AFTER),
    ]).toEqual(['healthy', 'claim_stale', 'claim_stale']);
  });

  it('dueExpiry and computeGateDueState (judges of a part, at a snapshot’s at): due after, not before', () => {
    // (a) red when either part judge reads another instant; (b) prints the verdicts.
    expect([
      dueExpiry(GATE, BEFORE),
      dueExpiry(GATE, AFTER)?.gate_id,
      computeGateDueState(GATE, BEFORE).expired,
      computeGateDueState(GATE, AFTER).expired,
    ]).toEqual([undefined, 'g1', false, true]);
  });
});
