// inspect-auto-bases-3m-d3.test.ts — caching 3-M piece D-3, checks 6 and 7, through `realm run
// inspect`'s ask entry and `get_run_state`'s structured entry, over one stored request record.
// Check 6: a record an earlier version wrote with a basis D-3 removes (`listen_trigger_gaps`,
// `listen_gaps_unreadable`) reads as having no `auto`: the ask without an `auto` clause, no `auto` on
// the entry, and neither throws ("NO backward compatibility, ever."). Check 7: `no_measurement` (a
// host that passes no choice) says `no gaps were measured`. Beside each: (a) the change that turns it
// red; (b) what it prints when it fails — the ask entry and the entry's `auto`, never a record.
import { describe, expect, it } from 'vitest';
import { handleGetRunState } from '@sensigo/realm-mcp/dist/tools/get-run-state.js';
import type {
  EvidenceSnapshot,
  RunRecord,
  RunStore,
  UsageRecord,
  WorkflowDefinition,
  WorkflowRegistrar,
} from '@sensigo/realm';
import { declared } from '../test-support/declared.js';
import { inspectRun } from './inspect.js';
import { doubleClock, listing, noSettle, snap } from '../test-support/snapshot-double.js';

const DEF: WorkflowDefinition = {
  id: 'wf-3m-d3',
  name: 'wf 3m d3',
  version: 1,
  steps: { ask: { description: 'Ask.', execution: 'agent' } },
};

/** One request record of an `auto` ask by `by`: the lifetime asked (seconds), and `cache_auto`. */
const request = (by: string, asked: 300 | 3600, cacheAuto: unknown): UsageRecord =>
  ({
    request_index: 0,
    request_start: '2026-11-01T12:00:00.000Z',
    cache_requested: 'lifetime',
    cache_lifetime_s: asked,
    cache_ttl_sent: asked === 3600,
    cache_requested_source: 'runner_default',
    cache_requested_by: by,
    cache_auto: cacheAuto,
  }) as UsageRecord;

/** A completed run whose one step recorded `requests`. */
function runOf(requests: UsageRecord[]): RunRecord {
  const snapshot: EvidenceSnapshot = {
    step_id: 'ask',
    started_at: '2026-11-01T12:00:00.000Z',
    completed_at: '2026-11-01T12:00:01.000Z',
    duration_ms: 1000,
    input_summary: {},
    output_summary: {},
    status: 'success',
    evidence_hash: 'abc123def456789012345678901234567890abcd',
    diagnostics: {
      input_token_estimate: 1,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests },
    },
  };
  return {
    id: 'run_3m_d3',
    workflow_id: DEF.id,
    workflow_version: 1,
    run_phase: 'completed',
    terminal_reason: 'Workflow completed.',
    completed_steps: ['ask'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    version: 1,
    params: {},
    evidence: [snapshot],
    created_at: '2026-11-01T12:00:00.000Z',
    updated_at: '2026-11-01T12:00:01.000Z',
    terminal_state: true,
  };
}
const stores = (run: RunRecord): { runStore: RunStore; workflowStore: WorkflowRegistrar } => ({
  runStore: declared({
    persistsClaims: true,
    clock: doubleClock,
    settleStep: noSettle,
    get: async () => snap(run),
    create: async () => ({ ...snap(run), created: true }),
    update: async () => snap(run),
    list: async () => listing([run]),
    claimStep: async () => {
      throw new Error('claimStep is not used here');
    },
  }),
  workflowStore: declared({
    register: async () => {},
    get: async () => DEF,
    list: async () => [DEF],
  }),
});

/** `inspect`'s ask entry for one request, from `asked for` to the end of its brackets; or the error. */
async function inspectAsk(r: UsageRecord): Promise<string> {
  try {
    const { runStore, workflowStore } = stores(runOf([r]));
    const out = await inspectRun('run_3m_d3', runStore, workflowStore);
    const line = out.split('\n').find((l) => l.includes('Diagnostics: ')) ?? `(no line in: ${out})`;
    const from = line.slice(line.indexOf('asked for'));
    return from.slice(0, from.indexOf(')') + 1);
  } catch (e) {
    return `threw: ${String(e)}`;
  }
}
/** `get_run_state`'s entry for the step's one ask: whether it has `auto`, and its value; or the error. */
async function stateEntry(r: UsageRecord): Promise<unknown> {
  try {
    const { runStore, workflowStore } = stores(runOf([r]));
    const summary = await handleGetRunState(
      { run_id: 'run_3m_d3', include_steps: true },
      { runStore, workflowStore: workflowStore as never },
    );
    const cost = summary.steps?.['ask']?.attempts[0]?.cost as
      { cache_requested?: { entries?: Array<Record<string, unknown>> } } | undefined;
    const entry = cost?.cache_requested?.entries?.[0];
    return entry === undefined
      ? '(no entry)'
      : { value: entry['value'], hasAuto: 'auto' in entry, auto: entry['auto'] };
  } catch (e) {
    return `threw: ${String(e)}`;
  }
}

describe('caching 3-M D-3 check 6 — an older record with a removed basis', () => {
  // The real case: a run a drive `realm listen` started before D-3, its request recorded with the
  // workflow's trigger gaps, or with listen's measurement unreadable, read after the upgrade. (a) red
  // when the word is left in `CACHE_AUTO_BASES` (the record keeps an `auto` that has no words); (b)
  // prints the ask entry and get_run_state's entry.
  it.each<[string, unknown]>([
    ['listen_trigger_gaps with gaps', { basis: 'listen_trigger_gaps', gaps_s: [420, 720] }],
    ['listen_gaps_unreadable', { basis: 'listen_gaps_unreadable' }],
  ])('%s: the ask with no auto clause, no auto on the entry, nothing thrown', async (_n, auto) => {
    const r = request('realm listen', 3600, auto);
    expect({ inspect: await inspectAsk(r), state: await stateEntry(r) }).toEqual({
      inspect: "asked for 1 hour (sent as 1 hour; realm listen's default)",
      state: { value: 'lifetime', hasAuto: false, auto: undefined },
    });
  });
});

describe('caching 3-M D-3 check 7 — no_measurement’s words', () => {
  // The real case: a host that builds the provider itself and passes no per-step choice, so its
  // request records `no_measurement`. (a) red when the old sentence is kept (`a drive realm agent
  // starts on its own has no trigger history`); (b) prints the ask entry.
  it('inspect: auto: no gaps were measured', async () => {
    expect(await inspectAsk(request('realm agent', 300, { basis: 'no_measurement' }))).toBe(
      "asked for 5 minutes (the provider's default lifetime; realm agent's default; auto: no gaps were measured)",
    );
  });
});
