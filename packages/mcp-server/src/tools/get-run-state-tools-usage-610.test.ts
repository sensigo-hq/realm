// get-run-state-tools-usage-610.test.ts — issue #610 at `get_run_state`: with `include_steps`, a
// tool-using step whose attempt carries its requests gets a `cost`, through the same composer as any
// agent step; an entry an older Realm wrote (tool calls, no `cache`) keeps `cost_unrecorded:
// tool_calling_step`. No reader code changed: these cells show the record reaches the surface.
// Every value is a fake. Each assertion names (a) the change that turns it red and (b) what it
// prints when it fails: the step's cost keys and cause.
import { declared } from '../test-support/declared.js';
import { describe, it, expect } from 'vitest';
import { WorkflowError } from '@sensigo/realm';
import type { JsonWorkflowStore, RunRecord, RunStore, UsageRecord } from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';

const req = (i: number, prompt: number): UsageRecord => ({
  request_index: i,
  request_start: `2026-10-27T10:00:0${i}.000Z`,
  prompt_tokens: prompt,
  output_tokens: prompt / 10,
  model: 'claude-test-1',
});

function runWith(usage: UsageRecord[] | undefined): RunRecord {
  return {
    id: 'r1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: ['classify'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'completed',
    version: 1,
    params: {},
    created_at: '2026-10-27T10:00:00.000Z',
    updated_at: '2026-10-27T10:00:05.000Z',
    terminal_state: true,
    evidence: [
      {
        step_id: 'classify',
        status: 'success',
        started_at: '2026-10-27T10:00:00.000Z',
        completed_at: '2026-10-27T10:00:05.000Z',
        duration_ms: 5000,
        input_summary: {},
        output_summary: { category: 'billing' },
        evidence_hash: 'h',
        agent_profile: 'classifier',
        tool_calls: [{ server_id: 'srv', tool: 't', args: {}, result: 'ok', duration_ms: 1 }],
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          ...(usage !== undefined
            ? { cache: { state: 'engaged', basis: 'provider_reported', requests: usage } }
            : {}),
        },
      },
    ],
  } as unknown as RunRecord;
}

const runStore = (run: RunRecord): RunStore =>
  declared({
    persistsClaims: true,
    get: async () => run,
    create: async () => {
      throw new Error('not exercised');
    },
    update: async () => {
      throw new Error('not exercised');
    },
    list: async () => {
      throw new Error('not exercised');
    },
    claimStep: async () => {
      throw new Error('not exercised');
    },
  } as unknown as RunStore);

// The definition is not needed: the step classifies as an agent step by its `agent_profile`.
const notFound = (): JsonWorkflowStore =>
  declared({
    register: async () => {},
    list: async () => [],
    get: async () => {
      throw new WorkflowError('Workflow not found: wf', {
        code: 'STATE_WORKFLOW_NOT_FOUND',
        category: 'STATE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    },
  } as unknown as JsonWorkflowStore);

/** The tools step's first attempt, as `include_steps` composes it. */
async function stepOf(run: RunRecord): Promise<Record<string, unknown>> {
  const summary = await handleGetRunState(
    { run_id: 'r1', include_steps: true },
    { runStore: runStore(run), workflowStore: notFound() },
  );
  return summary.steps?.['classify']?.attempts[0] as unknown as Record<string, unknown>;
}

describe('#610 — get_run_state shows a tool-using step’s cost', () => {
  it('V2: a tools step whose attempt carries 2 requests has a `cost`, and no `cost_unrecorded`', async () => {
    const step = await stepOf(runWith([req(0, 100), req(1, 200)]));
    // (a) red when the entry carries no usage (it then reads as an older record); (b) prints the
    //     step's keys.
    expect(
      {
        cost: step?.['cost'] !== undefined,
        unrecorded: step?.['cost_unrecorded'],
      },
      JSON.stringify(Object.keys(step ?? {})),
    ).toEqual({ cost: true, unrecorded: undefined });
  });

  it('V2 control: an entry an older Realm wrote (tool calls, no `cache`) keeps `cost_unrecorded: tool_calling_step`', async () => {
    const step = await stepOf(runWith(undefined));
    // (a) red when the older record's cause changes; (b) prints the cause.
    expect(step?.['cost_unrecorded']).toBe('tool_calling_step');
  });
});
