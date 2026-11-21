// failures-592b.test.ts — Q1 (#592) unit b (prompt q1-b-one-composer-two-carriers.md): the first
// carrier, `get_run_state`'s `failures[]`. A key on every ok reply (`[]` when nothing failed), and
// check 7: the reply ceiling shortens `failures` before the kept names. The fixture is sized so
// that the plan's ORDER decides the cut: the reply is a few hundred characters over the ceiling,
// and `failed_steps` alone could close that gap — so with `failures` placed after `failed_steps`
// the pass would cut the names instead (Q1-AUD3-26).
//
// Every assertion names (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { compileDisclosure, discloseReply, type RunRecord } from '@sensigo/realm';
import { REPLY_CEILING_CHARS, toolContentOf } from '../render-reply.js';
import { sseJsonStringify } from '../sse-json.js';
import { RUN_STATE_PLAN, RUN_STATE_SUMMARY_TABLE, handleGetRunState } from './get-run-state.js';
import { declared } from '../test-support/declared.js';
import {
  doubleClock,
  neverPurges,
  noSettle,
  scanning,
  snap,
} from '../test-support/snapshot-double.js';

const set = compileDisclosure([], {
  declared: 'resolved',
  audience: 'agent',
  environment: 'swept',
}).set;
type Reply = Record<string, unknown>;
const shown = (reply: Reply): Reply =>
  JSON.parse(
    toolContentOf(reply, { set, audience: 'agent', table: RUN_STATE_SUMMARY_TABLE }, RUN_STATE_PLAN)
      .content[0]!.text,
  ) as Reply;
const sizeOf = (reply: Reply): number =>
  sseJsonStringify(discloseReply(reply, set, 'agent', RUN_STATE_SUMMARY_TABLE)).length;

/** A run state's head, as every get_run_state reply carries it (the ceiling tests' own). */
const head = (over: Reply): Reply => ({
  run_id: 'r-592b',
  workflow_id: 'w-592b',
  run_phase: 'running',
  terminal_state: false,
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: [],
  failures: [],
  skipped_steps: [],
  evidence_count: 0,
  last_step: null,
  created_at: '2026-11-21T00:00:00.000Z',
  updated_at: '2026-11-21T00:00:00.000Z',
  params: { a: 1 },
  next_actions: [],
  next_actions_status: 'ok',
  ...over,
});

const COUNT = 40;
const names = Array.from(
  { length: COUNT },
  (_, i) => `step_${String(i).padStart(2, '0')}_${'n'.repeat(290)}`,
);
/** The reply with `COUNT` failures, each message `len` characters long. */
const overReply = (len: number): Reply =>
  head({
    failed_steps: names,
    failures: names.map((step) => ({
      step,
      code: 'ENGINE_HANDLER_FAILED',
      category: 'ENGINE',
      stop_reason: 'no_retry_policy',
      agent_action: 'stop',
      attempt: 1,
      message: 'm'.repeat(len),
    })),
  });

describe('Q1 (#592) unit b — the first carrier, get_run_state', () => {
  it('every ok reply carries failures: [] when nothing failed, beside failed_steps', async () => {
    const run = {
      id: 'run_592b',
      workflow_id: 'wf',
      workflow_version: 1,
      run_phase: 'running',
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      version: 1,
      params: {},
      evidence: [],
      created_at: '2026-11-21T00:00:00.000Z',
      updated_at: '2026-11-21T00:00:00.000Z',
      terminal_state: false,
    } as RunRecord;
    const def = {
      id: 'wf',
      name: 'wf',
      version: 1,
      steps: { a: { description: 'A', execution: 'agent' } },
    };
    const reply = await handleGetRunState(
      { run_id: run.id },
      {
        runStore: declared({
          persistsClaims: true,
          clock: doubleClock,
          settleStep: noSettle,
          get: async () => snap(run),
          create: async () => ({ ...snap(run), created: true }),
          update: async () => snap(run),
          scan: scanning(() => [run]),
          ...neverPurges,
          claimStep: async () => {
            throw new Error('claimStep is not used here');
          },
        }),
        workflowStore: declared({
          register: async () => {},
          get: async () => def,
          list: async () => [def],
        }) as never,
      },
    );
    // (a) red when the key is missing on a run with nothing failed, or sits elsewhere than beside
    //     failed_steps; (b) prints the reply's keys around it.
    const keys = Object.keys(reply);
    expect([reply.failures, keys[keys.indexOf('failed_steps') + 1]]).toEqual([[], 'failures']);
  });

  it('check 7: over the ceiling by a few hundred characters, the reply shortens failures (keeping its first, with failures_more) and keeps failed_steps whole', () => {
    // The fixture: find the message length that puts the reply 200–600 characters over.
    const perChar = sizeOf(overReply(1)) - sizeOf(overReply(0));
    const len = Math.ceil((REPLY_CEILING_CHARS + 400 - sizeOf(overReply(0))) / perChar);
    const reply = overReply(len);
    const over = sizeOf(reply) - REPLY_CEILING_CHARS;
    // What cutting `failed_steps` to one name alone would save: the fixture's precondition.
    const namesCut = head({
      ...reply,
      failed_steps: names.slice(0, 1),
      failed_steps_more: COUNT - 1,
    });
    const namesAloneSave = sizeOf(reply) - sizeOf(namesCut);
    // (a) red when the fixture does not let `failed_steps` alone close the gap (it would then prove
    //     nothing about the order); (b) prints the overage and the saving.
    expect({
      overInRange: over > 0 && over < 1_000,
      namesCanCloseIt: namesAloneSave > over,
    }).toEqual({
      overInRange: true,
      namesCanCloseIt: true,
    });

    const json = shown(reply);
    const kept = json['failures'] as unknown[];
    // (a) red when `failures` sits after `failed_steps` in the plan (the names are cut instead),
    //     the cut empties the list, or the count is not exact; (b) prints what was kept and left.
    expect({
      keptAtLeastOne: kept.length >= 1,
      accounted: kept.length + (json['failures_more'] as number),
      failuresMore: (json['failures_more'] as number) > 0,
      failedSteps: (json['failed_steps'] as unknown[]).length,
      failedStepsMore: json['failed_steps_more'],
      firstKept: (kept[0] as { step?: string } | undefined)?.step,
    }).toEqual({
      keptAtLeastOne: true,
      accounted: COUNT,
      failuresMore: true,
      failedSteps: COUNT,
      failedStepsMore: undefined,
      firstKept: names[0],
    });
  });
});
