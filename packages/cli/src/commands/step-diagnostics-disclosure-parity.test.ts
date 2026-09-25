// step-diagnostics-disclosure-parity.test.ts — issue #600 PR 1a (D7): every field of
// `StepDiagnostics` must reach an operator through `realm run inspect`, or carry a written reason
// why it does not.
//
// Same guard, same reasoning, as the `SealedBy` and `DriveFailureRecord` siblings: a field that
// ships with no read surface is invisible, and nothing — not the type system, not any hand-written
// render cell — can see "we added a field and forgot to show it". The
// `satisfies Record<keyof StepDiagnostics, DisclosureRoute>` below is the trigger: add a field to
// `StepDiagnostics` and this file stops compiling until someone routes it.
//
// ⚠ THIS GUARD MINTS A CONVENTION ITS SIBLINGS DO NOT HAVE: a NAMED WAIVER SET. The other four
// disclosure guards assert `waived === []` ("v1 waives NOTHING"). Three of this record's fields
// genuinely reach operators by another route, so waiving them is correct and each waiver states
// where. A waiver with an empty reason fails below, so the set cannot grow silently.
//
// ⚠ THE MCP HALF IS DELIBERATELY OUT OF SCOPE. `get_run_state` has no per-step surface at all until
// PR 1b, so an mcp-side twin would be an all-waived table that guards nothing. It arrives with the
// surface it is meant to guard.
import { describe, it, expect } from 'vitest';
import type { RunRecord, StepDiagnostics, UsageRecord } from '@sensigo/realm';
import { inspectRun } from './inspect.js';

type DisclosureRoute =
  { surface: 'rendered'; probe: (out: string) => void } | { surface: 'waived'; reason: string };

const DIAG: StepDiagnostics = {
  input_token_estimate: 32,
  precondition_trace: [],
  validation_rejections: 3,
  settled_by_default: true,
  structured_output: { requested: true, sent: false, downgrade_reason: 'provider_unsupported' },
  cache: {
    state: 'engaged',
    basis: 'provider_reported',
    requests: [
      {
        request_index: 0,
        request_start: '2026-01-01T00:00:00.000Z',
        prompt_tokens: 1200,
        uncached_input_tokens: 50,
        cache_read_input_tokens: 1150,
      },
    ],
  },
};

const STEP_DIAGNOSTICS_DISCLOSURE = {
  input_token_estimate: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('~32 tokens (estimate)'),
  },
  precondition_trace: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('no preconditions'),
  },
  cache: {
    surface: 'rendered',
    // The sub-fields are D6's obligation, not this guard's: a `keyof` guard sees top-level keys
    // only, so `state`/`basis`/`requests` are covered by D6's five branch cells in
    // `inspect-cache-render.test.ts`. This probe proves the segment reaches the screen at all,
    // carrying both the measured prompt size and the provenance word.
    probe: (out) => {
      expect(out).toContain('1200 prompt tokens (measured, first request)');
      expect(out).toContain('cache: read 1150, wrote 0 (provider-reported, 1 request)');
    },
  },
  validation_rejections: {
    surface: 'waived',
    reason:
      'Persisted and reaching NO operator surface. Its readers are the engine (the exhaustion ' +
      'threshold) and `buildSettlementNamespace`, i.e. workflow AUTHORS via `$settlement` — not ' +
      'an operator on a screen. Rendering it would be new disclosure, not parity.',
  },
  settled_by_default: {
    surface: 'waived',
    reason:
      'Disclosed at RUN level as `defaulted_steps` (#232), not per step. The operator learns which ' +
      'steps fell back to a default from that list; a per-step repeat is redundant, not missing.',
  },
  structured_output: {
    surface: 'waived',
    reason:
      'Reaches operators through the #316 `structured_output_downgraded` run-health finding, which ' +
      'names the affected steps. The per-step record is the finding’s evidence, not its surface.',
  },
} satisfies Record<keyof StepDiagnostics, DisclosureRoute>;

const run = {
  id: 'run_diag1',
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
      diagnostics: DIAG,
    },
  ],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  terminal_state: true,
} as unknown as RunRecord;

const store = { get: async () => run, list: async () => [run] } as never;
const workflowStore = {
  get: async () => {
    throw new Error('not registered');
  },
  register: async () => {},
  list: async () => [],
} as never;

describe('#600 PR 1a (D7) — every StepDiagnostics field reaches an inspect reader, or says why not', () => {
  it('runs each field OWN probe against the real rendered output', async () => {
    const out = await inspectRun('run_diag1', store, workflowStore, { verbose: true });
    for (const [field, route] of Object.entries(STEP_DIAGNOSTICS_DISCLOSURE) as Array<
      [string, DisclosureRoute]
    >) {
      if (route.surface === 'rendered') route.probe(out);
      else
        expect(
          route.reason.trim().length,
          `waiver for '${field}' has an empty reason`,
        ).toBeGreaterThan(0);
    }
  });

  it('the registry covers every field, and the waiver set is exactly the three named above', () => {
    expect(Object.keys(STEP_DIAGNOSTICS_DISCLOSURE).sort()).toEqual([
      'cache',
      'input_token_estimate',
      'precondition_trace',
      'settled_by_default',
      'structured_output',
      'validation_rejections',
    ]);
    const waived = Object.entries(STEP_DIAGNOSTICS_DISCLOSURE)
      .filter(([, r]) => (r as DisclosureRoute).surface === 'waived')
      .map(([f]) => f)
      .sort();
    // NOT `[]` — see the header. A fourth waiver is a decision someone must make in this file.
    expect(waived).toEqual(['settled_by_default', 'structured_output', 'validation_rejections']);
  });
});

// ---------------------------------------------------------------------------------------------
// The SAME discipline one level down. `keyof StepDiagnostics` sees `cache` as ONE key, so it is
// structurally blind to the fields inside `UsageRecord` — which is where every number about money
// actually lives. Without this second registry, a counter can be persisted by all three provider
// mappers and rendered nowhere, and no guard in this PR would notice: exactly the defect the
// `cache` field exists to prevent, one level below the guard that prevents it.
// ---------------------------------------------------------------------------------------------
const USAGE_DISCLOSURE = {
  prompt_tokens: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('1200 prompt tokens (measured, first request)'),
  },
  cache_read_input_tokens: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('read 1150'),
  },
  cache_creation_input_tokens: {
    surface: 'rendered',
    // Summed with `cache_write_tokens` into the rendered `wrote N`.
    probe: (out) => expect(out).toMatch(/wrote \d+/),
  },
  cache_write_tokens: {
    surface: 'rendered',
    probe: (out) => expect(out).toMatch(/wrote \d+/),
  },
  output_tokens: {
    surface: 'waived',
    reason:
      'Rendered on the FAILED-drive surface (`realm run inspect`\'s "Drive failures:" block, ' +
      "guarded by `drive-failure-disclosure-parity.test.ts`), not on a successful step's line — an " +
      'operator asking what a step cost is asking about the prompt, and output tokens are not a ' +
      'caching question. Not unrendered; rendered on the other surface.',
  },
  request_index: {
    surface: 'waived',
    reason:
      'The screen shows the COUNT (`N requests`), taken from the array length. The index exists so ' +
      "a consumer pairing entries after a JSON round-trip never depends on array position — PR 2's " +
      "duplicate-write detector reads it. No operator question needs a single request's ordinal.",
  },
  request_start: {
    surface: 'waived',
    reason:
      "Per-request timestamps exist for the TTL/cadence work (the plan's §8.9): whether a 5-minute " +
      "cache stayed warm between calls is answered from these, and that question is PR 2's. No " +
      "operator question today is answered by one request's start time.",
  },
  cache_creation: {
    surface: 'waived',
    reason:
      "The TTL split. `cache_creation_input_tokens` EQUALS its sum by the provider's own documented " +
      'invariant, and that aggregate IS rendered — so rendering the split too would print the same ' +
      "tokens twice under two names. It is carried because it is the provider's own datum and " +
      "because PR 4's TTL choice is decided from it.",
  },
  uncached_input_tokens: {
    surface: 'waived',
    reason:
      'Derivable from the three rendered terms (prompt minus read minus creation). It is carried ' +
      "because on Anthropic it is the provider's OWN reported number (`input_tokens`) and this " +
      'record never re-derives a figure a provider stated — but printing a fourth token count an ' +
      'operator can compute would cost line width for no question.',
  },
} satisfies Record<keyof UsageRecord, DisclosureRoute>;

describe('#600 PR 1a (D7) — every UsageRecord field reaches an inspect reader, or says why not', () => {
  it('runs each field OWN probe against the real rendered output', async () => {
    const out = await inspectRun('run_diag1', store, workflowStore, { verbose: true });
    for (const [field, route] of Object.entries(USAGE_DISCLOSURE) as Array<
      [string, DisclosureRoute]
    >) {
      if (route.surface === 'rendered') route.probe(out);
      else
        expect(
          route.reason.trim().length,
          `waiver for '${field}' has an empty reason`,
        ).toBeGreaterThan(0);
    }
  });

  it('the registry covers every UsageRecord field', () => {
    expect(Object.keys(USAGE_DISCLOSURE).sort()).toEqual([
      'cache_creation',
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'cache_write_tokens',
      'output_tokens',
      'prompt_tokens',
      'request_index',
      'request_start',
      'uncached_input_tokens',
    ]);
  });
});
