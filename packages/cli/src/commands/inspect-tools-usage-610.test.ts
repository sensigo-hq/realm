// inspect-tools-usage-610.test.ts — issue #610 at `realm run inspect`: a tool-using step's
// recorded requests render through the shared composers like any agent step's; an entry an older
// Realm wrote (tool calls, no `cache`) prints the one sentence that says so. No reader code changed:
// these cells show the record reaches the surface. Every value is a fake. Each assertion names (a)
// the change that turns it red and (b) what it prints when it fails: booleans and the rendered line.
import { declared } from '../test-support/declared.js';
import { describe, it, expect } from 'vitest';
import { inspectRun } from './inspect.js';
import type {
  EvidenceSnapshot,
  RunRecord,
  RunStore,
  UsageRecord,
  WorkflowDefinition,
  WorkflowRegistrar,
} from '@sensigo/realm';

const def: WorkflowDefinition = {
  id: 'wf-610',
  name: 'wf 610',
  version: 1,
  steps: { classify: { description: 'Classify', execution: 'agent', tools: ['srv:t'] } },
} as unknown as WorkflowDefinition;

const toolCall = { server_id: 'srv', tool: 't', args: {}, result: 'ok', duration_ms: 1 };
const req = (i: number, prompt: number): UsageRecord => ({
  request_index: i,
  request_start: `2026-10-27T10:00:0${i}.000Z`,
  prompt_tokens: prompt,
  output_tokens: prompt / 10,
  cache_read_input_tokens: 0,
  model: 'claude-test-1',
});

function entry(usage: UsageRecord[] | undefined): EvidenceSnapshot {
  return {
    step_id: 'classify',
    started_at: '2026-10-27T10:00:00.000Z',
    completed_at: '2026-10-27T10:00:05.000Z',
    duration_ms: 5000,
    input_summary: {},
    output_summary: { category: 'billing' },
    status: 'success',
    evidence_hash: 'abc123def456789012345678901234567890abcd',
    tool_calls: [toolCall],
    diagnostics: {
      input_token_estimate: 1,
      precondition_trace: [],
      ...(usage !== undefined
        ? { cache: { state: 'engaged', basis: 'provider_reported', requests: usage } }
        : {}),
    },
  } as unknown as EvidenceSnapshot;
}

async function render(e: EvidenceSnapshot): Promise<string> {
  const run = {
    id: 'run_610',
    workflow_id: 'wf-610',
    workflow_version: 1,
    run_phase: 'completed',
    terminal_reason: 'Workflow completed.',
    completed_steps: ['classify'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    version: 1,
    params: {},
    evidence: [e],
    created_at: '2026-10-27T10:00:00.000Z',
    updated_at: '2026-10-27T10:00:05.000Z',
    terminal_state: true,
  } as unknown as RunRecord;
  const runs: RunStore = declared({
    persistsClaims: true,
    get: async () => run,
    create: async () => ({ run, created: true }),
    update: async () => run,
    list: async () => [run],
    claimStep: async () => {
      throw new Error('not used by inspect');
    },
  });
  const workflows: WorkflowRegistrar = declared({
    register: async () => {},
    get: async () => def,
    list: async () => [def],
  });
  return inspectRun('run_610', runs, workflows);
}

describe('#610 — inspect renders a tool-using step’s requests', () => {
  it('V1: a tools step whose attempt carries 2 requests prints its measured totals, and no `cost: not recorded` line', async () => {
    const out = await render(entry([req(0, 100), req(1, 200)]));
    // (a) red when the entry carries no usage (it then reads as an older record); (b) prints two
    //     booleans.
    expect({
      measured: out.includes('totals across 2 requests'),
      notRecorded: out.includes('cost: not recorded'),
    }).toEqual({ measured: true, notRecorded: false });
  });

  it('V3: an entry an older Realm wrote (tool calls, no `cache`) prints the sentence that says so, exactly', async () => {
    const out = await render(entry(undefined));
    const line = out.split('\n').find((l) => l.includes('cost: not recorded')) ?? '(none)';
    // (a) red when the sentence is changed back to the old one ("tool-calling steps do not record
    //     usage yet"); (b) prints the line.
    expect(line.trim()).toBe(
      'cost: not recorded — tool-calling step with no recorded usage (realm 0.48.0 or earlier recorded none)',
    );
  });
});
