// inspect-split-3b.test.ts — caching 3-B (A6's parity table, D2's row 7, E4, M10): the words
// `realm run inspect` prints on a step's cache line for the split's record facts, one cell per
// producing branch, each read from a request record as an adapter writes it; and the cross cell: a
// recorded refusal of the cache fields suppresses the nothing-written clause and its gateway reason.
// Each cell names (a) the change that turns it red and (b) what it prints: the step's cache line,
// built from fake digests and counts.
import { describe, it, expect } from 'vitest';
import type { RunRecord } from '@sensigo/realm';
import { inspectRun } from './inspect.js';

const HEX = 'a'.repeat(64);
const workflowStore = {
  get: async () => {
    throw new Error('not registered');
  },
  register: async () => {},
  list: async () => [],
} as never;

/** One step whose one attempt sent `requests`, on a run `inspect` reads. */
async function lineOf(requests: Record<string, unknown>[]): Promise<string> {
  const run = {
    id: 'run_split',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: ['classify'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'completed',
    version: 1,
    params: {},
    evidence: [
      {
        step_id: 'classify',
        status: 'success',
        started_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-01T00:00:01.000Z',
        duration_ms: 1000,
        input_summary: {},
        output_summary: {},
        evidence_hash: 'h',
        diagnostics: {
          input_token_estimate: 1,
          precondition_trace: [],
          cache: { state: 'engaged', basis: 'provider_reported', requests },
        },
      },
    ],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: true,
  } as unknown as RunRecord;
  const out = await inspectRun(
    'run_split',
    { get: async () => run, list: async () => [run] } as never,
    workflowStore,
  );
  return out.split('\n').find((l) => l.includes('cache:')) ?? '(no cache line)';
}

const anthropic = {
  request_index: 0,
  request_start: '2026-01-01T00:00:00.000Z',
  provider: 'anthropic',
  endpoint: 'default',
  prompt_tokens: 2000,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 1500,
  cache_requested: 'lifetime',
  cache_lifetime_s: 300,
  cache_ttl_sent: false,
  cache_requested_source: 'runner_default',
  cache_requested_by: 'realm agent',
  prefix_sha256: HEX,
  prefix_parts: { system: 'b'.repeat(64), prompt: HEX },
  request_strict_sent: false,
};
const openai = {
  request_index: 0,
  request_start: '2026-01-01T00:00:00.000Z',
  provider: 'openai',
  endpoint: 'default',
  prompt_tokens: 2000,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_requested: 'provider_rules',
  prefix_sha256: HEX,
  prefix_parts: { system: 'b'.repeat(64), prompt: HEX },
  request_strict_sent: false,
};
const REFUSED = {
  status: 400,
  dropped: ['cache_fields'],
  proven: 'cache_fields',
  fields: ['cache_control'],
};

describe('caching 3-B — the cached head on inspect’s step cache line, per producing branch', () => {
  it('Anthropic, two blocks: the head marked with the system text', async () => {
    const line = await lineOf([
      { ...anthropic, prefix_chars: 48, cache_marked: ['system', 'prompt'] },
    ]);
    // (a) red when the clause is not printed or names other parts; (b) prints the line.
    expect(line).toContain('; cached head: 48 characters (marked: system, prompt)');
  });

  it('Anthropic, one block: the head is the whole prompt text, marked', async () => {
    const line = await lineOf([
      { ...anthropic, prefix_chars: 1310, cache_marked: ['system', 'prompt'] },
    ]);
    // (a) red when the one-block head's length is not the one recorded; (b) prints the line.
    expect(line).toContain('; cached head: 1310 characters (marked: system, prompt)');
  });

  it('Anthropic, a whitespace head: the prompt unmarked, only the system text marked', async () => {
    const line = await lineOf([{ ...anthropic, prefix_chars: 3, cache_marked: ['system'] }]);
    // (a) red when an unmarked prompt is reported as marked; (b) prints the line.
    expect(line).toContain('; cached head: 3 characters (marked: system)');
  });

  it('OpenAI: the key, and the ask that says so (row 7’s key branch)', async () => {
    const line = await lineOf([
      { ...openai, prefix_chars: 48, cache_marked: ['key'], cache_key_sent: true },
    ]);
    // (a) red when the key branch is not printed, or the ask keeps its no-key words; (b) prints it.
    expect(line).toContain(
      "asked for nothing but a cache key, a hint (the provider's own caching applies); cached head: 48 characters (marked: key)",
    );
    const without = await lineOf([{ ...openai }]);
    expect(without).toContain("asked for nothing (the provider's own caching, if any, applies)");
    expect(without).not.toContain('cache key');
  });

  it('after a remembered drop: nothing marked, and the refusal with its remedy (E4)', async () => {
    const line = await lineOf([
      { ...anthropic, endpoint: 'custom', prefix_chars: 48, cache_controls_rejected: REFUSED },
    ]);
    // (a) red when the drop is shown as marked, or the refusal line is missing; (b) prints the line.
    expect(line).toContain(
      '; cached head: 48 characters (nothing marked); the endpoint refused the cache fields (400); sent without them for the rest of the drive — to stop sending them: --prompt-cache off',
    );
  });
});

describe('caching 3-B M10 — a recorded refusal replaces the nothing-written clause and its gateway reason', () => {
  it('the clause prints without the refusal, and not with it (cross cell)', async () => {
    const nothing = { ...anthropic, endpoint: 'custom', cache_creation_input_tokens: 0 };
    const without = await lineOf([nothing]);
    const withIt = await lineOf([{ ...nothing, cache_controls_rejected: REFUSED }]);
    // (a) red when the refusal does not suppress the clause, or the control loses it; (b) prints
    //     both lines.
    expect({
      control: without.includes(
        "nothing was written or read: the cached part may be shorter than the model's minimum, or the endpoint dropped the request to cache",
      ),
      suppressed: withIt.includes('nothing was written or read'),
      refusal: withIt.includes('the endpoint refused the cache fields (400)'),
    }).toEqual({ control: true, suppressed: false, refusal: true });
  });
});
