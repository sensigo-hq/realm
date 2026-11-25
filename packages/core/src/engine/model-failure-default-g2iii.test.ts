// model-failure-default-g2iii.test.ts — gap 2, unit (iii), checks 11 and 1c: core's admission of the
// member for a step with `on_model_failure: default`, and the readers that must still read #220's
// default entry as before.
//
// `executeChain`'s `modelFailure` is admitted for a step that declares `on_model_failure: fail` or
// `default`; for `default` only when the step declares `validation_exhaustion.default_output` (a
// library caller can skip the loader). The default entry of a step with `on_model_failure: default`
// is the answer, not a model call: the step views and the model-text reader pass it over. #220's
// default entry (refused answers, no `failure_kind`) keeps its reads: one an outside assistant drove
// has no usage and truthfully reads "not measured". Every assertion carries (a) the break that turns
// it red and (b) what it prints.
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { executeChain, type ExecuteChainOptions } from './execution-loop.js';
import { composeStepViews } from './step-view.js';
import { evidenceModelTextView } from './model-text-view.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

type ModelFailure = NonNullable<ExecuteChainOptions['modelFailure']>;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['route'],
  properties: { route: { type: 'string' } },
};
const wf = (step: Partial<StepDefinition>): WorkflowDefinition =>
  ({
    id: 'wf-g2iii-admit',
    name: 'g2iii admit',
    version: 1,
    steps: {
      classify: {
        description: 'Classify.',
        execution: 'agent',
        depends_on: [],
        output_schema: SCHEMA,
        ...step,
      },
    },
  }) as WorkflowDefinition;
const FAILURE: ModelFailure = {
  kind: 'permanent',
  stop_reason: 'non_retryable',
  message: 'Anthropic 400: bad (fake)',
  attempt: 1,
  error_class: 'api_status',
  status: 400,
};

/** The call's code, refusal message (or none), whether the record moved, and the step's lists. */
async function call(d: WorkflowDefinition) {
  const store = new InMemoryStore();
  const { record } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  const outcome = await executeChain(store, d, {
    runId: record.id,
    command: 'classify',
    input: {},
    dispatcher: async () => ({}),
    modelFailure: FAILURE,
  }).then(
    (reply) => ({
      code: reply.error_code ?? null,
      message: null as string | null,
      warnings: reply.warnings,
    }),
    (err: { code?: string; message?: string }) => ({
      code: err.code ?? null,
      message: err.message ?? null,
      warnings: [] as string[],
    }),
  );
  const after = (await store.get(record.id)).record;
  const { warnings, ...rest } = outcome;
  return {
    ...rest,
    // Gap 2, unit (iii), Words 8: core's reply warning, when the default was taken.
    defaultWarning: warnings.filter((w) => w.includes('settled with its declared default_output')),
    written: after.version !== record.version,
    completed: after.completed_steps,
    failed: after.failed_steps,
  };
}

const refusal = (...clauses: string[]) =>
  `executeChain was called with ${clauses.length} invalid option(s): ${clauses.join('; ')}. Nothing was read or written.`;
const A =
  "options.modelFailure must be given only for a step that declares on_model_failure: fail or default ('classify' does not)";
const NEW =
  "options.modelFailure must be given for a step with on_model_failure: default only when it declares validation_exhaustion.default_output ('classify' declares none)";
const DEFAULT_OUTPUT = { route: 'human' };

describe('gap 2 (iii), check 11 — core admits the member for fail and default, and refuses default without its answer', () => {
  it('default with default_output: admitted; the step completes', async () => {
    const got = await call(
      wf({
        on_model_failure: 'default',
        validation_exhaustion: { default_output: DEFAULT_OUTPUT },
      }),
    );
    // (a) red when check (a) admits `fail` only (the call is refused); (b) prints the outcome.
    expect(got).toEqual({
      code: null,
      message: null,
      defaultWarning: [
        "Step 'classify' settled with its declared default_output after its model request failed (MODEL_REQUEST_FAILED; on_model_failure: 'default')",
      ],
      written: true,
      completed: ['classify'],
      failed: [],
    });
  });

  it('fail: admitted, as before; the step fails, with no default_output needed', async () => {
    const got = await call(wf({ on_model_failure: 'fail' }));
    // (a) red when the new refusal is not keyed on `default` (a `fail` step with no default_output
    //     is refused); (b) prints the outcome.
    expect(got).toEqual({
      code: 'MODEL_REQUEST_FAILED',
      message: null,
      defaultWarning: [],
      written: true,
      completed: [],
      failed: ['classify'],
    });
  });

  it.each([
    ['no validation_exhaustion block', {}],
    ['a block without default_output', { validation_exhaustion: { threshold: 2 } }],
  ])('default with %s: refused with the new clause, nothing written', async (_n, extra) => {
    const got = await call(wf({ on_model_failure: 'default', ...extra }));
    // (a) red when the default_output conjunct is removed (the call is admitted and the step
    //     completes with no answer); (b) prints the outcome.
    expect(got).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message: refusal(NEW),
      defaultWarning: [],
      written: false,
      completed: [],
      failed: [],
    });
  });

  it('neither fail nor default: refused with clause (a)', async () => {
    const got = await call(wf({}));
    // (a) red when check (a) is removed; (b) prints the outcome.
    expect(got).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message: refusal(A),
      defaultWarning: [],
      written: false,
      completed: [],
      failed: [],
    });
  });
});

// ─── Check 1c: #220's default entry keeps its reads ──────────────────────────────────────────────

/** A run whose agent step `classify` has one execution entry with `diagnostics`. */
const runWith = (diagnostics: Record<string, unknown>): RunRecord =>
  ({
    id: 'r',
    workflow_id: 'wf-g2iii-admit',
    evidence: [
      {
        step_id: 'classify',
        status: 'success',
        started_at: '2026-11-25T00:00:00.000Z',
        completed_at: '2026-11-25T00:00:00.000Z',
        duration_ms: 0,
        input_summary: {},
        output_summary: DEFAULT_OUTPUT,
        evidence_hash: 'h',
        diagnostics: { input_token_estimate: 1, precondition_trace: [], ...diagnostics },
      },
    ],
  }) as unknown as RunRecord;
const DEF = wf({ validation_exhaustion: { mode: 'default', default_output: DEFAULT_OUTPUT } });

describe('gap 2 (iii), check 1c — #220’s default entry, with no usage, still reads "not measured"', () => {
  it.each([
    [
      '#220’s default (refused answers, as an outside assistant drove it)',
      { settled_by_default: true, validation_rejections: 2 },
      'not_measured_by_realm',
      'no_model_call',
    ],
    [
      'this unit’s default (with failure_kind)',
      { settled_by_default: true, validation_rejections: 0, failure_kind: 'transient' },
      null,
      null,
    ],
  ])('%s', (_n, diagnostics, unrecorded, text) => {
    const run = runWith(diagnostics);
    const attempt = composeStepViews(run, { definition: DEF })['classify']?.attempts[0];
    const view = evidenceModelTextView(run.evidence[0], DEF);
    // (a) red when the readers key on `settled_by_default` alone (#220's entry loses its "not
    //     measured" and "no model call"); (b) prints both readings.
    expect({
      unrecorded: attempt?.cost_unrecorded ?? null,
      text: view?.kind ?? null,
    }).toEqual({ unrecorded, text });
  });
});
