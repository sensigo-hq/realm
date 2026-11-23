// model-failure-key-g2iib2.test.ts — gap 2, unit (ii-b2), check 7: core's admission of
// `executeChain`'s `modelFailure` member (rule 10).
//
// A program that drives a run can settle an agent step failed because its model request failed
// (unit (ii-a)). From this unit on, core takes the member only for a step that declares
// `on_model_failure: fail`, and only with a stop reason the step's `retry` does not contradict:
// `attempts` or `total_timeout` say Realm's `retry` used up its tries or its time, so a step with no
// `retry` cannot have them; `no_retry_policy` says the step has no `retry`. Each refusal is a
// `VALIDATION_OPTION_INVALID` throw before anything is read or written. Every assertion carries
// (a) the break that turns it red and (b) what it prints.
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { executeChain, type ExecuteChainOptions } from './execution-loop.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

type ModelFailure = NonNullable<ExecuteChainOptions['modelFailure']>;

const RETRY = { max_attempts: 3 };
const wf = (step: Partial<StepDefinition>): WorkflowDefinition =>
  ({
    id: 'wf-g2iib2-admit',
    name: 'g2iib2 admit',
    version: 1,
    steps: {
      classify: { description: 'Classify.', execution: 'agent', depends_on: [], ...step },
    },
  }) as WorkflowDefinition;
const failure = (over: Partial<ModelFailure>): ModelFailure => ({
  kind: 'transient',
  stop_reason: 'attempts',
  message: 'Anthropic 503: overloaded (fake)',
  attempt: 3,
  error_class: 'api_status',
  status: 503,
  ...over,
});

/** The call, its refusal's code and message (or none), and whether the run's record moved. */
async function call(d: WorkflowDefinition, mf: ModelFailure) {
  const store = new InMemoryStore();
  const { record } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  const outcome = await executeChain(store, d, {
    runId: record.id,
    command: 'classify',
    input: {},
    dispatcher: async () => ({}),
    modelFailure: mf,
  }).then(
    (reply) => ({ code: reply.error_code ?? null, message: null as string | null }),
    (err: { code?: string; message?: string }) => ({
      code: err.code ?? null,
      message: err.message ?? null,
    }),
  );
  const after = (await store.get(record.id)).record;
  return { ...outcome, written: after.version !== record.version, failed: after.failed_steps };
}

const refusal = (...clauses: string[]) =>
  `executeChain was called with ${clauses.length} invalid option(s): ${clauses.join('; ')}. Nothing was read or written.`;
const A =
  "options.modelFailure must be given only for a step that declares on_model_failure: fail ('classify' does not)";
const B = (r: string) =>
  `options.modelFailure.stop_reason must be non_retryable or no_retry_policy for a step that declares no retry ('classify' declares none; '${r}' says its retry used up its tries or its time)`;
const C =
  "options.modelFailure.stop_reason must be attempts, total_timeout or non_retryable for a step that declares retry ('classify' declares one; 'no_retry_policy' says it has none)";

describe('gap 2 (ii-b2), check 7 — core refuses the member a step did not opt in to, or a stop reason its retry contradicts', () => {
  it('(a) a step without on_model_failure: fail', async () => {
    const got = await call(wf({ retry: RETRY }), failure({}));
    // (a) red when check (a) is removed (the step settles failed); (b) prints the code, the
    //     message and whether the record moved.
    expect(got).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message: refusal(A),
      written: false,
      failed: [],
    });
  });

  it.each(['attempts', 'total_timeout'] as const)(
    '(b) %s on a step that declares no retry',
    async (stop) => {
      const got = await call(wf({ on_model_failure: 'fail' }), failure({ stop_reason: stop }));
      // (a) red when check (b) is removed; (b) prints the refusal.
      expect(got).toEqual({
        code: 'VALIDATION_OPTION_INVALID',
        message: refusal(B(stop)),
        written: false,
        failed: [],
      });
    },
  );

  it('(c) no_retry_policy on a step that declares retry', async () => {
    const got = await call(
      wf({ on_model_failure: 'fail', retry: RETRY }),
      failure({ stop_reason: 'no_retry_policy' }),
    );
    // (a) red when check (c) is removed; (b) prints the refusal.
    expect(got).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message: refusal(C),
      written: false,
      failed: [],
    });
  });

  it.each([
    [
      'transient × attempts, with retry',
      { retry: RETRY },
      { stop_reason: 'attempts' },
      'STEP_RETRY_EXHAUSTED',
    ],
    [
      'transient × total_timeout, with retry',
      { retry: RETRY },
      { stop_reason: 'total_timeout' },
      'STEP_RETRY_EXHAUSTED',
    ],
    [
      'transient × non_retryable, with retry',
      { retry: RETRY },
      { stop_reason: 'non_retryable' },
      'MODEL_REQUEST_FAILED',
    ],
    [
      'transient × non_retryable, without retry',
      {},
      { stop_reason: 'non_retryable' },
      'MODEL_REQUEST_FAILED',
    ],
    [
      'transient × no_retry_policy, without retry',
      {},
      { stop_reason: 'no_retry_policy' },
      'MODEL_REQUEST_FAILED',
    ],
    [
      'permanent × non_retryable, with retry',
      { retry: RETRY },
      { kind: 'permanent', stop_reason: 'non_retryable', status: 400 },
      'MODEL_REQUEST_FAILED',
    ],
    [
      'permanent × non_retryable, without retry',
      {},
      { kind: 'permanent', stop_reason: 'non_retryable', status: 400 },
      'MODEL_REQUEST_FAILED',
    ],
  ] as const)('passes: %s', async (_n, step, mf, code) => {
    const got = await call(
      wf({ on_model_failure: 'fail', ...step } as Partial<StepDefinition>),
      failure(mf as Partial<ModelFailure>),
    );
    // (a) red when a legal pair is refused (a check judged too widely); (b) prints the outcome.
    expect(got).toEqual({ code, message: null, written: true, failed: ['classify'] });
  });

  it("an auto step with the member: only (ii-a)'s one clause", async () => {
    const d = {
      id: 'wf-g2iib2-auto',
      name: 'g2iib2 auto',
      version: 1,
      steps: { classify: { description: 'Classify.', execution: 'auto', depends_on: [] } },
    } as unknown as WorkflowDefinition;
    const got = await call(d, failure({}));
    // (a) red when (a)–(c) are judged on a step that is not an agent step (more clauses); (b)
    //     prints the refusal.
    expect(got).toEqual({
      code: 'VALIDATION_OPTION_INVALID',
      message: refusal(
        "options.modelFailure must be given only for an agent step ('classify' is an auto step)",
      ),
      written: false,
      failed: [],
    });
  });
});
