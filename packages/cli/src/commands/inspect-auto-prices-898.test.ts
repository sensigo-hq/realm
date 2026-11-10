// inspect-auto-prices-898.test.ts — issue #898 S10: where `auto`'s choice took its prices, in words.
// Each row of `autoPricesText` in `realm run inspect`'s ask entry and as `get_run_state`'s structured
// `entry.auto.prices` — the at-stake branches (`none`, `excluded`) first — then the record with no
// kept gaps (no clause) and a stored `none` with a 5-minute ask (the cause, no tail, no throw); and
// guardrail 7's cross cell: `inspect` and `get_run_state` carry the same `prices` for the same
// request. Caching 3-M D-3: the start line no longer carries `auto`'s evidence or prices. Beside
// each: (a) the change that turns it red; (b) what it prints when it fails — the line, or the
// entry's `auto`.
import { describe, expect, it } from 'vitest';
import { handleGetRunState } from '@sensigo/realm-mcp/dist/tools/get-run-state.js';
import type {
  CacheAutoPrices,
  EvidenceSnapshot,
  RunRecord,
  RunStore,
  UsageRecord,
  WorkflowDefinition,
  WorkflowRegistrar,
} from '@sensigo/realm';
import { declared } from '../test-support/declared.js';
import { inspectRun } from './inspect.js';
import { autoPricesText } from '../agent/prompt-cache.js';
import {
  doubleClock,
  noSettle,
  snap,
  neverPurges,
  scanning,
} from '../test-support/snapshot-double.js';

const DEF: WorkflowDefinition = {
  id: 'wf-898',
  name: 'wf 898',
  version: 1,
  steps: { ask: { description: 'Ask.', execution: 'agent' } },
};
const GAPS = [420, 720];
const LISTEN = {
  cache_requested_source: 'runner_default',
  cache_requested_by: 'realm listen',
} as const;

/** One request record of an `auto` ask: the lifetime asked (seconds) or `off`, and `cache_auto`. */
const request = (asked: number | 'off', cacheAuto: unknown): UsageRecord =>
  ({
    request_index: 0,
    request_start: '2026-10-29T12:00:00.000Z',
    ...(asked === 'off'
      ? { cache_requested: 'off' }
      : { cache_requested: 'lifetime', cache_lifetime_s: asked, cache_ttl_sent: asked === 3600 }),
    ...LISTEN,
    cache_auto: cacheAuto,
  }) as UsageRecord;

/** A completed run whose one step recorded `requests`. */
function runOf(requests: UsageRecord[]): RunRecord {
  const snapshot: EvidenceSnapshot = {
    step_id: 'ask',
    started_at: '2026-10-29T12:00:00.000Z',
    completed_at: '2026-10-29T12:00:01.000Z',
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
    id: 'run_898',
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
    created_at: '2026-10-29T12:00:00.000Z',
    updated_at: '2026-10-29T12:00:01.000Z',
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
    scan: scanning(() => [run]),
    ...neverPurges,
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

/** `inspect`'s ask entry for one request: the text after `(1 request)`. */
async function inspectAsk(r: UsageRecord): Promise<string> {
  const { runStore, workflowStore } = stores(runOf([r]));
  const out = await inspectRun('run_898', runStore, workflowStore);
  const line = out.split('\n').find((l) => l.includes('Diagnostics: ')) ?? `(no line in: ${out})`;
  return line.slice(line.indexOf('(1 request)') + '(1 request)'.length);
}
/** `get_run_state`'s structured `auto` of the step's one ask. */
async function stateAuto(r: UsageRecord): Promise<unknown> {
  const { runStore, workflowStore } = stores(runOf([r]));
  const summary = await handleGetRunState(
    { run_id: 'run_898', include_steps: true },
    { runStore, workflowStore: workflowStore as never },
  );
  const cost = summary.steps?.['ask']?.attempts[0]?.cost as
    { cache_requested?: { entries?: Array<{ auto?: unknown }> } } | undefined;
  return cost?.cache_requested?.entries?.[0]?.auto;
}

/** Every stored `prices` row, the at-stake ones first, with the lifetime it was asked under. */
const ROWS: Array<[string, CacheAutoPrices, number | 'off']> = [
  ['none no_file, 1 hour', { from: 'none', cause: 'no_file' }, 3600],
  ['none no_file, off', { from: 'none', cause: 'no_file' }, 'off'],
  ['none economics_unreachable', { from: 'none', cause: 'economics_unreachable' }, 3600],
  ['none economics_unreadable', { from: 'none', cause: 'economics_unreadable' }, 3600],
  ['none model_unknown', { from: 'none', cause: 'model_unknown' }, 3600],
  ['none input_zero', { from: 'none', cause: 'input_zero' }, 'off'],
  [
    'none rate_missing',
    { from: 'none', cause: 'rate_missing', missing: ['cache_write_5m', 'cache_write_1h'] },
    3600,
  ],
  ['excluded long', { from: 'economics', excluded: ['long'], missing: ['cache_write_1h'] }, 300],
  ['excluded short', { from: 'economics', excluded: ['short'], missing: ['cache_write_5m'] }, 3600],
  ['economics', { from: 'economics' }, 300],
];
const WORDS: Record<string, string> = {
  'none no_file, 1 hour':
    'no price file (runner.cache.economics is not set), so 1 hour without prices',
  'none no_file, off':
    'no price file (runner.cache.economics is not set), and no gap was under 54 minutes, so no caching',
  'none economics_unreachable': 'the price file could not be read, so 1 hour without prices',
  'none economics_unreadable': 'the price file is not a valid price file, so 1 hour without prices',
  'none model_unknown': 'the price file does not price this model, so 1 hour without prices',
  'none input_zero':
    'the price file prices input at 0 for this model, and no gap was under 54 minutes, so no caching',
  'none rate_missing':
    'the price file has no cache_write_5m or cache_write_1h rate for this model, so 1 hour without prices',
  'excluded long':
    'priced from your price file without 1 hour: it has no cache_write_1h rate for this model',
  'excluded short':
    'priced from your price file without 5 minutes: it has no cache_write_5m rate for this model',
  economics: 'priced from your price file',
};
const EVIDENCE =
  "auto: the last 2 gaps between this step's runs were about 7 minutes and 12 minutes";

describe('#898 S10 — realm run inspect and get_run_state carry it, from core’s one view', () => {
  // (a) red when inspect drops the clause; (b) prints each ask entry.
  it('inspect: each stored row; no clause with no kept gaps; a stored none under 5 minutes gives the cause with no tail', async () => {
    const asks = [
      ...(await Promise.all(
        ROWS.map(async ([name, prices, asked]) => [
          name,
          await inspectAsk(request(asked, { basis: 'step_gaps', gaps_s: GAPS, prices })),
        ]),
      )),
      ['no kept gaps', await inspectAsk(request(3600, { basis: 'step_gaps', gaps_s: [] }))],
      [
        'none under 5 minutes',
        await inspectAsk(
          request(300, {
            basis: 'step_gaps',
            gaps_s: GAPS,
            prices: { from: 'none', cause: 'model_unknown' },
          }),
        ),
      ],
    ];
    const ask = (asked: number | 'off', clause: string): string =>
      asked === 'off'
        ? `; asked for no caching (realm listen's default; ${EVIDENCE}; ${clause})`
        : `; asked for ${asked === 3600 ? '1 hour' : '5 minutes'} (${asked === 3600 ? 'sent as 1 hour' : "the provider's default lifetime"}; realm listen's default; ${EVIDENCE}; ${clause})`;
    expect(asks).toEqual([
      ...ROWS.map(([name, , asked]) => [name, ask(asked, WORDS[name]!)]),
      [
        'no kept gaps',
        "; asked for 1 hour (sent as 1 hour; realm listen's default; auto: Realm found no earlier request of this step from the last 7 days)",
      ],
      ['none under 5 minutes', ask(300, 'the price file does not price this model')],
    ]);
  });

  // (a) red when the view drops a stored prices; (b) prints each entry's `auto`.
  it('get_run_state: entry.auto.prices as structured data — each stored row, none with no kept gaps', async () => {
    const got = [
      ...(await Promise.all(
        ROWS.map(([, prices, asked]) =>
          stateAuto(request(asked, { basis: 'step_gaps', gaps_s: GAPS, prices })),
        ),
      )),
      await stateAuto(request(3600, { basis: 'step_gaps', gaps_s: [] })),
    ];
    expect(got).toEqual([
      ...ROWS.map(([, prices]) => ({ basis: 'step_gaps', gaps_s: GAPS, prices })),
      { basis: 'step_gaps', gaps_s: [] },
    ]);
  });

  // Guardrail 7 (b)'s cross cell. (a) red when one carrier drops or changes `prices` (or inspect
  //     derives its own); (b) prints both carriers' words for each request.
  it('cross: for the same request, inspect says exactly the words of get_run_state’s prices', async () => {
    const records = [
      ...ROWS.map(([, prices, asked]) =>
        request(asked, { basis: 'step_gaps', gaps_s: GAPS, prices }),
      ),
    ];
    const pairs = await Promise.all(
      records.map(async (r) => {
        const auto = (await stateAuto(r)) as { prices?: CacheAutoPrices } | undefined;
        const asked = r.cache_requested === 'off' ? 'off' : r.cache_lifetime_s!;
        const fromState =
          auto?.prices === undefined ? '(no prices)' : autoPricesText(auto.prices, asked);
        return [fromState, (await inspectAsk(r)).includes(`; ${fromState})`)];
      }),
    );
    expect(pairs.filter(([, same]) => same !== true)).toEqual([]);
  });
});
