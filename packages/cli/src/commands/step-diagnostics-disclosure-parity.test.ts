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
// THE MCP HALF now has its own guard: `cost-view-disclosure-parity.test.ts` (this package and
// mcp-server) covers `CostView`/`CostFigure`/`AttemptView`/`StepView`/`CostUnrecordedCause` on
// BOTH `realm run inspect` and `get_run_state`'s `include_steps` — this file's `cache` row proves
// the segment reaches the screen at all; the composed view's own fields are that guard's job.
import { describe, it, expect } from 'vitest';
import type { RunRecord, StepDiagnostics, UsageRecord } from '@sensigo/realm';
import { inspectRun } from './inspect.js';

type DisclosureRoute =
  | {
      surface: 'rendered';
      // Two rendered outputs, because one fixture cannot discriminate every field. `out` is the
      // CONFORMING shape (a real Anthropic response: every cache key present). `partial` is the
      // non-conforming one a third-party `--provider-module` can produce — no total, one write
      // spelling. A field whose only render arm needs the second shape asserts against `partial`,
      // so its probe cannot be satisfied by a clause another field produced. Issue #600 PR 2 adds
      // `mismatch`: a request that asked for 1h, part of whose write was kept for 5m, carrying every
      // request fact — the only shape on which the lifetime split has text of its own.
      probe: (out: string, partial: string, mismatch: string) => void;
    }
  | { surface: 'waived'; reason: string };

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
        // Both cache keys are REQUIRED on Anthropic's usage block (`number | null` in the installed
        // SDK type) and an uncached direction reports 0 — the docs' own test for "was this cached?"
        // is that BOTH read 0. Omitting the write key made this fixture describe a response the API
        // never sends, and the render then had to invent `wrote 0` to satisfy the probe below.
        cache_creation_input_tokens: 0,
        // issue #600 PR 1b (#611): output tokens now render on the STEP line too — this is the
        // fixture's only reporting request, so it discriminates the `output_tokens` row below.
        output_tokens: 15,
      },
    ],
  },
};

const STEP_DIAGNOSTICS_DISCLOSURE = {
  input_token_estimate: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('~32 tokens (estimate, step input)'),
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
      // issue #600 PR 1b: every request in this fixture reported the prompt, so the cache clause
      // carries `included in the prompt` — the D2 truth rule fires here, not just in the render
      // suite that names it.
      expect(out).toContain(
        'cache: read 1150, wrote 0 (included in the prompt; provider-reported, 1 request)',
      );
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

// The NON-CONFORMING shape, and the only fixture that can discriminate three of the rows below: a
// record with no total at all (so the uncached fallback arm is the one that fires) whose single
// write figure is spelled `cache_write_tokens` (OpenAI's name, optional on that provider), and with
// the read direction unreported (so the classifier lands on `partially_observed`). Nothing invents
// a zero anywhere in it — that is the point.
const partialRun = {
  ...(run as unknown as RunRecord),
  id: 'run_diag2',
  evidence: [
    {
      ...(run as unknown as RunRecord).evidence[0]!,
      diagnostics: {
        ...DIAG,
        cache: {
          state: 'partially_observed',
          basis: 'provider_reported',
          requests: [
            {
              request_index: 0,
              request_start: '2026-01-01T00:00:00.000Z',
              uncached_input_tokens: 90,
              cache_write_tokens: 77,
            },
          ],
        },
      },
    },
  ],
} as unknown as RunRecord;
const partialStore = {
  get: async () => partialRun,
  list: async () => [partialRun],
} as never;

// issue #600 PR 2 — the MISMATCH shape: one request that asked for 1h (sent as 1h, stated on realm
// agent) and whose write was kept for 5m: a 5-minute split above 0, matching
// `cache_creation_input_tokens`, and every request fact set. `DIAG` cannot show the split: its only
// write figure is 0, and its `wrote 0` probe above is the discriminating one.
const mismatchRun = {
  ...(run as unknown as RunRecord),
  id: 'run_diag3',
  evidence: [
    {
      ...(run as unknown as RunRecord).evidence[0]!,
      diagnostics: {
        ...DIAG,
        cache: {
          state: 'write_only',
          basis: 'provider_reported',
          requests: [
            {
              request_index: 0,
              request_start: '2026-01-01T00:00:00.000Z',
              prompt_tokens: 900,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 64,
              cache_creation: { ephemeral_5m_input_tokens: 64, ephemeral_1h_input_tokens: 0 },
              model: 'claude-x-20260101',
              cache_requested: 'lifetime',
              cache_lifetime_s: 3600,
              cache_ttl_sent: true,
              cache_requested_source: 'stated',
              cache_requested_by: 'realm agent',
              provider: 'anthropic',
              endpoint: 'custom',
              cache_split_offered: true,
            },
          ],
        },
      },
    },
  ],
} as unknown as RunRecord;
const mismatchStore = {
  get: async () => mismatchRun,
  list: async () => [mismatchRun],
} as never;
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
    const partial = await inspectRun('run_diag2', partialStore, workflowStore, { verbose: true });
    const mismatch = await inspectRun('run_diag3', mismatchStore, workflowStore, { verbose: true });
    for (const [field, route] of Object.entries(STEP_DIAGNOSTICS_DISCLOSURE) as Array<
      [string, DisclosureRoute]
    >) {
      if (route.surface === 'rendered') route.probe(out, partial, mismatch);
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
    // Discriminating: this fixture's ONLY write figure. Drop the field and the clause reads
    // `wrote not reported`, so a fabricated zero cannot satisfy this probe either.
    probe: (out) => expect(out).toContain('wrote 0'),
  },
  cache_write_tokens: {
    surface: 'rendered',
    // The alternative SPELLING of the same fact (OpenAI's name), so it can only be discriminated on
    // a fixture where it is the only write figure present. `/wrote \d+/` against the conforming
    // output was VACUOUS — the sibling field's clause satisfied it while this field was absent from
    // the fixture entirely, which is the shape of defect this whole guard exists to catch.
    probe: (_out, partial) => {
      expect(partial).toContain('wrote 77');
      expect(_out).not.toContain('77');
    },
  },
  // issue #600 PR 1b (#611): output tokens now render on the STEP line too — this row was waived
  // only because #611 hadn't shipped yet. Below the FAILED-drive surface's OWN row, unchanged.
  output_tokens: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('15 output tokens'),
  },
  request_index: {
    surface: 'waived',
    reason:
      'The screen shows the COUNT (`N requests`), taken from the array length. The index exists so ' +
      'a consumer pairing entries after a JSON round-trip never depends on array position — the ' +
      "cost-aware fan-out's duplicate-write detector (its PR-1) reads it. No operator question " +
      "needs a single request's ordinal.",
  },
  request_start: {
    surface: 'waived',
    reason:
      'Per-request timestamps exist for the cadence work: whether a cache stayed warm between calls ' +
      "is answered from these, and that question is the cadence unit's (#675, after #616). No " +
      "operator question today is answered by one request's start time.",
  },
  // issue #600 PR 2: the lifetime split moves from waived to rendered — the one line it changes is
  // the mismatch clause, when a write was kept for another lifetime than the one asked.
  cache_creation: {
    surface: 'rendered',
    probe: (out, _partial, mismatch) => {
      expect(mismatch).toContain('; 64 of the tokens written were kept for 5m, not the 1h asked');
      expect(out).not.toContain('of the tokens written were kept for');
    },
  },
  // issue #600 PR 2: the request facts. Each probe reads the mismatch shape, and the conforming
  // shape (which carries none of them) shows none of their words.
  model: {
    surface: 'rendered',
    probe: (out, _partial, mismatch) => {
      expect(mismatch).toContain('| model claude-x-20260101 |');
      expect(out).not.toContain('| model ');
    },
  },
  cache_requested: {
    surface: 'rendered',
    probe: (out, _partial, mismatch) => {
      expect(mismatch).toContain('; asked for 1h');
      expect(out).not.toContain('asked for');
    },
  },
  cache_lifetime_s: {
    surface: 'rendered',
    probe: (_out, _partial, mismatch) => expect(mismatch).toContain('asked for 1h ('),
  },
  cache_ttl_sent: {
    surface: 'rendered',
    probe: (_out, _partial, mismatch) => expect(mismatch).toContain('(sent as 1h; '),
  },
  cache_requested_source: {
    surface: 'rendered',
    probe: (_out, _partial, mismatch) => expect(mismatch).toContain('; stated on '),
  },
  cache_requested_by: {
    surface: 'rendered',
    probe: (_out, _partial, mismatch) => expect(mismatch).toContain('stated on realm agent)'),
  },
  provider: {
    surface: 'waived',
    reason:
      'The change that prices model calls (#600 PR P) reads it to price the request at the ' +
      'provider that served it. Until then the step line names the model, which says more.',
  },
  endpoint: {
    surface: 'waived',
    reason:
      'The change that prices model calls (#600 PR P) renders the custom-endpoint note from it ' +
      "(a price list prices a provider's own endpoint).",
  },
  cache_split_offered: {
    surface: 'waived',
    reason:
      'The change that prices model calls (#600 PR P) keys its lifetime-split precondition on it; ' +
      'on its own it changes no line.',
  },
  uncached_input_tokens: {
    surface: 'rendered',
    // Was waived as "derivable from the three rendered terms" — true only while all three ARE
    // rendered. When the total cannot be derived (a term the provider never reported), this is the
    // one measured input figure left, and withholding it would leave the line with no number at
    // all. So it has its own arm, and the arm names its own limit.
    probe: (_out, partial) =>
      expect(partial).toContain(
        '90 uncached input tokens (measured, first request; whole prompt not reported)',
      ),
  },
} satisfies Record<keyof UsageRecord, DisclosureRoute>;

describe('#600 PR 1a (D7) — every UsageRecord field reaches an inspect reader, or says why not', () => {
  it('runs each field OWN probe against the real rendered output', async () => {
    const out = await inspectRun('run_diag1', store, workflowStore, { verbose: true });
    const partial = await inspectRun('run_diag2', partialStore, workflowStore, { verbose: true });
    const mismatch = await inspectRun('run_diag3', mismatchStore, workflowStore, { verbose: true });
    for (const [field, route] of Object.entries(USAGE_DISCLOSURE) as Array<
      [string, DisclosureRoute]
    >) {
      if (route.surface === 'rendered') route.probe(out, partial, mismatch);
      else
        expect(
          route.reason.trim().length,
          `waiver for '${field}' has an empty reason`,
        ).toBeGreaterThan(0);
    }
  });

  it('the registry covers every UsageRecord field, and the waiver set is exactly the five named above', () => {
    expect(Object.keys(USAGE_DISCLOSURE).sort()).toEqual([
      'cache_creation',
      'cache_creation_input_tokens',
      'cache_lifetime_s',
      'cache_read_input_tokens',
      'cache_requested',
      'cache_requested_by',
      'cache_requested_source',
      'cache_split_offered',
      'cache_ttl_sent',
      'cache_write_tokens',
      'endpoint',
      'model',
      'output_tokens',
      'prompt_tokens',
      'provider',
      'request_index',
      'request_start',
      'uncached_input_tokens',
    ]);
    const waived = Object.entries(USAGE_DISCLOSURE)
      .filter(([, r]) => (r as DisclosureRoute).surface === 'waived')
      .map(([f]) => f)
      .sort();
    // The sibling registry above pins its waiver set; without the same assertion HERE a rendered
    // money field could be re-routed to `waived` with a plausible reason and nothing would notice —
    // the probe loop only runs probes for `rendered` entries, so the guard would fall silent about
    // exactly the numbers it exists to guard. A fourth waiver is a decision someone makes in this
    // file. `output_tokens` moved OUT of this set (issue #600 PR 1b / #611) — it renders now, and
    // `cache_creation` (issue #600 PR 2: the mismatch clause). PR 2 adds three waivers, each naming
    // the change that will render it.
    expect(waived).toEqual([
      'cache_split_offered',
      'endpoint',
      'provider',
      'request_index',
      'request_start',
    ]);
  });
});
