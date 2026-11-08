// inspect-misses-3m.test.ts — caching 3-M A-2b1: `realm run inspect` prints one line per request
// that missed the cache, beneath the line of the attempt it belongs to, two spaces deeper. Each cell
// names its real case, the change that turns it red, and prints the rendered lines around the
// attempt's line (counts only; no record holds prompt text or a digest that prints).
import { describe, it, expect } from 'vitest';
import type { RunRecord } from '@sensigo/realm';
import { inspectRun } from './inspect.js';
import { listing, snap } from '../test-support/snapshot-double.js';

const workflowStore = {
  get: async () => {
    throw new Error('not registered');
  },
  register: async () => {},
  list: async () => [],
} as never;

const PARTS = { tools: 'a'.repeat(64), system: 'b'.repeat(64), prompt: 'c'.repeat(64) };

/** One Anthropic tool turn of one call, as a provider writes it after A-0 and A-1b. */
function turn(
  i: number,
  t: { start: string; prompt: number; uncached: number; read: number; write: number; out: number },
): Record<string, unknown> {
  return {
    request_start: t.start,
    request_index: i,
    request_in_call: i,
    model: 'claude-sonnet-5-5',
    endpoint: 'default',
    provider: 'anthropic',
    prompt_tokens: t.prompt,
    uncached_input_tokens: t.uncached,
    output_tokens: t.out,
    cache_read_input_tokens: t.read,
    cache_creation_input_tokens: t.write,
    cache_creation: { ephemeral_5m_input_tokens: t.write, ephemeral_1h_input_tokens: 0 },
    cache_requested: 'lifetime',
    cache_lifetime_s: 300,
    request_strict_sent: false,
    prefix_parts: PARTS,
    cache_marked: ['system', 'conversation'],
  };
}

/** An execution attempt of `step` that sent `requests`. */
function attempt(
  step: string,
  status: 'error' | 'success',
  at: string,
  requests: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    step_id: step,
    kind: 'execution',
    status,
    started_at: at,
    completed_at: at,
    duration_ms: 10,
    input_summary: {},
    output_summary: {},
    evidence_hash: `h-${step}-${at}`,
    diagnostics: {
      input_token_estimate: 1,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests },
    },
  };
}

/** The rendered lines of a run holding `evidence`. */
async function render(evidence: Record<string, unknown>[]): Promise<string[]> {
  const run = {
    id: 'run_miss',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: ['classify'],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'completed',
    version: 1,
    params: {},
    evidence,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: true,
  } as unknown as RunRecord;
  const out = await inspectRun(
    'run_miss',
    { get: async () => snap(run), list: async () => listing([run]) } as never,
    workflowStore,
  );
  return out.split('\n');
}

/** The line that starts with `head`, and the two after it: what a failing cell prints. */
function around(lines: readonly string[], head: string): string[] {
  const at = lines.findIndex((l) => l.startsWith(head));
  return at < 0 ? [`(no line starting ${JSON.stringify(head)})`] : lines.slice(at, at + 3);
}

/**
 * A step with two attempts, a miss in each: the earlier attempt (a failed settle, reopened by a
 * resume, keeps its usage) and the last. In each, the call's second turn read 0 where the first
 * had just written (the provider did not keep the entry, which the record cannot see:
 * `unexplained`). The counts differ per attempt so each line is told apart.
 */
function twoAttempts(): Record<string, unknown>[] {
  const pair = (day: string, write: number): Record<string, unknown>[] => [
    turn(0, {
      start: `${day}T05:00:00.000Z`,
      prompt: write + 4,
      uncached: 4,
      read: 0,
      write,
      out: 40,
    }),
    turn(1, {
      start: `${day}T05:00:01.000Z`,
      prompt: write + 4,
      uncached: 4,
      read: 0,
      write,
      out: 40,
    }),
  ];
  return [
    attempt('classify', 'error', '2026-11-08T05:00:00.000Z', pair('2026-11-08', 6897)),
    attempt('classify', 'success', '2026-11-08T06:00:00.000Z', pair('2026-11-08', 5000)),
  ];
}

describe('caching 3-M A-2b1 — inspect prints each miss beneath its own attempt', () => {
  // Can fail: misses printed for the current attempt only (the earlier attempt's line has none).
  it("the earlier attempt's miss sits beneath `attempt 1/2:`", async () => {
    const lines = await render(twoAttempts());
    const near = around(lines, '     attempt 1/2: ');
    expect(near[1], near.join('\n')).toBe(
      '       cache miss: request 2 of 2 read 0 of 6897 expected tokens — nothing the cache covers differs on the record from request 1; the provider may have dropped the entry; it started 1 second after that request',
    );
  });

  // Can fail: misses printed only on the single-attempt branch (the last attempt's line has none).
  it("the last attempt's miss sits beneath `Diagnostics (attempt 2/2):`", async () => {
    const lines = await render(twoAttempts());
    const near = around(lines, '     Diagnostics (attempt 2/2): ');
    expect(near[1], near.join('\n')).toBe(
      '       cache miss: request 2 of 2 read 0 of 5000 expected tokens — nothing the cache covers differs on the record from request 1; the provider may have dropped the entry; it started 1 second after that request',
    );
  });

  // A single-attempt step: live-899's drive_a (six Anthropic tool turns of one call, counts and
  // stamps as captured in plans/llm-prompt-caching/tools-path/live-899/), constructed with two
  // misses. Turn 2 read only 1000 and wrote 6087 (a lookback that reached only an earlier
  // breakpoint, #946); turn 4 started 420 s after turn 3 (constructed: the capture's turns are
  // seconds apart) and read 0.
  // Can fail: the line's read count taken from the shortfall (5993, 7181). Prints the lines.
  it("a single attempt's misses sit beneath `Diagnostics:`, each with what it read", async () => {
    const requests = [
      {
        start: '2026-10-29T16:07:28.795Z',
        prompt: 6901,
        uncached: 4,
        read: 0,
        write: 6897,
        out: 47,
      },
      {
        start: '2026-10-29T16:07:30.900Z',
        prompt: 6995,
        uncached: 2,
        read: 6897,
        write: 96,
        out: 47,
      },
      {
        start: '2026-10-29T16:07:32.286Z',
        prompt: 7089,
        uncached: 2,
        read: 1000,
        write: 6087,
        out: 47,
      },
      {
        start: '2026-10-29T16:07:33.595Z',
        prompt: 7183,
        uncached: 2,
        read: 7087,
        write: 94,
        out: 47,
      },
      {
        start: '2026-10-29T16:14:33.595Z',
        prompt: 7277,
        uncached: 2,
        read: 0,
        write: 7275,
        out: 47,
      },
      {
        start: '2026-10-29T16:14:34.908Z',
        prompt: 7363,
        uncached: 2,
        read: 7275,
        write: 86,
        out: 11,
      },
    ].map((t, i) => turn(i, t));
    const lines = await render([
      attempt('classify', 'success', '2026-10-29T16:07:28.000Z', requests),
    ]);
    const near = around(lines, '     Diagnostics: ');
    expect(near.slice(1), near.join('\n')).toEqual([
      '       cache miss: request 3 of 6 read 1000 of 6993 expected tokens — nothing the cache covers differs on the record from request 2; the provider may have dropped the entry; it started 2 seconds after that request',
      '       cache miss: request 5 of 6 read 0 of 7181 expected tokens — possibly expired: it started 7 minutes after request 4, longer than the 5 minutes the provider granted',
    ]);
  });
});
