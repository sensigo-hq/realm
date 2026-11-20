// failure-words-592.test.ts — Q1 (#592) unit a (prompt q1-a-failure-words-on-the-entry.md): a failed
// step's evidence entry carries its error's code, category and action word, and on its last entry
// why Realm stopped retrying — written at the six failure sites, by the code that has the words.
// Checks 1–6 of the prompt: one cell per site, one per stop word, the cross cells (the
// `STEP_RETRY_EXHAUSTED` wrap and the not-registered carve-out), `exhausted_by` beside the stop word,
// `attempt` on every attempt, and the reader.
//
// Every assertion names (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { executeStep, executeChain } from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { readFailureWords } from './ways.js';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { StepHandler } from '../extensions/step-handler.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { EvidenceSnapshot, RunRecord } from '../types/run-record.js';
import { STOP_REASONS } from '../types/run-record.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';

const WORD_KEYS = [
  'error_code',
  'error_category',
  'agent_action',
  'stop_reason',
  'exhausted_by',
  'attempt',
] as const;
/** The entry's failure words, `exhausted_by` and `attempt` — only the keys it has. */
const wordsOf = (e: EvidenceSnapshot | undefined): Record<string, unknown> =>
  Object.fromEntries(WORD_KEYS.filter((k) => e !== undefined && k in e).map((k) => [k, e![k]]));

const oneStep = (step: Partial<StepDefinition>, extra: Record<string, StepDefinition> = {}) =>
  ({
    id: 'fw-592',
    name: 'Failure words',
    version: 1,
    steps: {
      work: { description: 'Work', execution: 'auto', depends_on: [], ...step },
      ...extra,
    },
  }) as WorkflowDefinition;

async function run(
  def: WorkflowDefinition,
  dispatcher: StepDispatcher,
  registry?: ExtensionRegistry,
) {
  const store = new InMemoryStore();
  const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  const reply = await executeStep(store, def, {
    runId: record.id,
    command: 'work',
    input: {},
    dispatcher,
    ...(registry !== undefined ? { registry } : {}),
  });
  const stored = (await store.get(record.id)).record;
  return { reply, stored };
}
const entriesOf = (r: RunRecord, step: string) => r.evidence.filter((e) => e.step_id === step);

const err = (code: string, category: string, agentAction: string, retryable: boolean) =>
  new WorkflowError(`${code} from the test`, {
    code: code as never,
    category: category as never,
    agentAction: agentAction as never,
    retryable,
  });
const throwing =
  (e: unknown): StepDispatcher =>
  async () => {
    throw e;
  };
const neverEnds: StepDispatcher = () => new Promise<Record<string, unknown>>(() => undefined);

function handlerRegistry(h: StepHandler['execute']): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register('handler', 'h', { id: 'h', execute: h } as StepHandler);
  return registry;
}

describe('Q1 (#592) unit a — check 1: the words at each failure site', () => {
  it('a handler that throws at the attempt: ENGINE_HANDLER_FAILED · ENGINE · stop, attempt 1, no_retry_policy', async () => {
    const { stored } = await run(
      oneStep({ handler: 'h' }),
      async () => ({}),
      handlerRegistry(async () => {
        throw new Error('handler boom');
      }),
    );
    // (a) red when the attempt site writes no words, or the words are not the error's; (b) prints them.
    expect(wordsOf(entriesOf(stored, 'work').at(-1))).toEqual({
      error_code: 'ENGINE_HANDLER_FAILED',
      error_category: 'ENGINE',
      agent_action: 'stop',
      stop_reason: 'no_retry_policy',
      attempt: 1,
    });
  });

  it('a plain Error from the dispatcher: ENGINE_INTERNAL · ENGINE · stop (the site normalises it)', async () => {
    const { stored } = await run(oneStep({}), throwing(new Error('plain')));
    // (a) red when a non-realm throw is captured without the normalised words; (b) prints them.
    expect(wordsOf(entriesOf(stored, 'work').at(-1))).toEqual({
      error_code: 'ENGINE_INTERNAL',
      error_category: 'ENGINE',
      agent_action: 'stop',
      stop_reason: 'no_retry_policy',
      attempt: 1,
    });
  });

  it('a retried attempt (a 429) carries its own words and no stop word; the success after it carries none', async () => {
    let n = 0;
    const { stored } = await run(
      oneStep({ retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 1 } }),
      async () => {
        n++;
        if (n === 1) throw err('SERVICE_RATE_LIMITED', 'SERVICE', 'wait_for_service', true);
        return { ok: true };
      },
    );
    const [first, second] = entriesOf(stored, 'work');
    // (a) red when a retried attempt's entry has no words, the attempt's own action, or a stop word
    //     on a non-last entry; (b) prints both entries' words.
    expect([wordsOf(first), wordsOf(second)]).toEqual([
      {
        error_code: 'SERVICE_RATE_LIMITED',
        error_category: 'SERVICE',
        agent_action: 'wait_for_service',
        attempt: 1,
      },
      { attempt: 2 },
    ]);
  });

  it('the validation budget runs out: VALIDATION_EXHAUSTED · VALIDATION · stop, attempts, attempt = the rejections', async () => {
    const def: WorkflowDefinition = {
      id: 'fw-592-vx',
      name: 'vx',
      version: 1,
      steps: {
        draft: {
          description: 'Draft',
          execution: 'agent',
          output_schema: { type: 'object', required: ['c'], properties: { c: { type: 'string' } } },
          validation_exhaustion: { threshold: 2 },
        },
      },
    };
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const echo: StepDispatcher = async (_s, input) => input as Record<string, unknown>;
    for (let i = 0; i < 2; i++)
      await executeStep(store, def, {
        runId: record.id,
        command: 'draft',
        input: {},
        dispatcher: echo,
      });
    const stored = (await store.get(record.id)).record;
    const entries = entriesOf(stored, 'draft');
    // (a) red when the exhaustion entry has no words, a stop word other than `attempts`, an
    //     `attempt` other than the rejections counted, or is stamped twice; (b) prints the entries.
    expect(entries.map(wordsOf)).toEqual([
      {
        error_code: 'VALIDATION_EXHAUSTED',
        error_category: 'VALIDATION',
        agent_action: 'stop',
        stop_reason: 'attempts',
        attempt: 2,
      },
    ]);
  });
});

describe('Q1 (#592) unit a — check 1: a cleanup step and a guard', () => {
  /** One agent step that fails (a plain throw) and a fail-finalizer whose handler is `h`. */
  const withFinalizer = (finalizer: Partial<StepDefinition> = {}) =>
    oneStep(
      { execution: 'agent' },
      {
        fin: {
          description: 'Cleanup',
          execution: 'finalizer',
          on_outcome: 'fail',
          handler: 'h',
          ...finalizer,
        } as StepDefinition,
      },
    );

  it('a cleanup step whose handler returned abort: ENGINE_HANDLER_FAILED · ENGINE · report_to_user, no_retry_policy', async () => {
    const { stored } = await run(
      withFinalizer(),
      throwing(new Error('step boom')),
      handlerRegistry(async () => ({ abort: { message: 'cannot clean up' } }) as never),
    );
    // (a) red when the abort arm writes no words, or other words; (b) prints the cleanup entry.
    expect(wordsOf(entriesOf(stored, 'fin').at(-1))).toEqual({
      error_code: 'ENGINE_HANDLER_FAILED',
      error_category: 'ENGINE',
      agent_action: 'report_to_user',
      stop_reason: 'no_retry_policy',
    });
  });

  it('a cleanup step whose handler threw an ordinary error: ENGINE_HANDLER_FAILED · ENGINE · stop', async () => {
    const { stored } = await run(
      withFinalizer(),
      throwing(new Error('step boom')),
      handlerRegistry(async () => {
        throw new Error('cleanup boom');
      }),
    );
    // (a) red when the throw arm writes no words, or not the wrapped error's; (b) prints them.
    expect(wordsOf(entriesOf(stored, 'fin').at(-1))).toEqual({
      error_code: 'ENGINE_HANDLER_FAILED',
      error_category: 'ENGINE',
      agent_action: 'stop',
      stop_reason: 'no_retry_policy',
    });
  });

  it('a cleanup step that timed out: STEP_TIMEOUT · ENGINE · report_to_user', async () => {
    const { stored } = await run(
      withFinalizer({ timeout_seconds: 0.05 }),
      throwing(new Error('step boom')),
      handlerRegistry(() => new Promise(() => undefined)),
    );
    // (a) red when the time-out is not the thrown STEP_TIMEOUT's words; (b) prints them.
    expect(wordsOf(entriesOf(stored, 'fin').at(-1))).toEqual({
      error_code: 'STEP_TIMEOUT',
      error_category: 'ENGINE',
      agent_action: 'report_to_user',
      stop_reason: 'no_retry_policy',
    });
  });

  /** An agent step, then a guard after it with `guard` set; the chain runs the guard inline. */
  async function guardRun(guard: Record<string, unknown>) {
    const def = oneStep(
      { execution: 'agent' },
      {
        g: {
          description: 'Guard',
          execution: 'guard',
          depends_on: ['work'],
          ...guard,
        } as StepDefinition,
      },
    );
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeChain(store, def, {
      runId: record.id,
      command: 'work',
      input: { ok: false },
      dispatcher: async (_s, input) => input as Record<string, unknown>,
    });
    return (await store.get(record.id)).record;
  }
  const GUARD_WORDS = {
    error_code: 'GUARD_RESOLUTION_ERROR',
    error_category: 'ENGINE',
    agent_action: 'report_to_user',
    stop_reason: 'no_retry_policy',
  };

  it('a guard with an unresolvable path: GUARD_RESOLUTION_ERROR · ENGINE · report_to_user; the step fails', async () => {
    const stored = await guardRun({ abort_unless: ['$.nope.field == true'] });
    // (a) red when the guard's failed entry has no words; (b) prints the entry and the membership.
    expect([wordsOf(entriesOf(stored, 'g').at(-1)), stored.failed_steps]).toEqual([
      GUARD_WORDS,
      ['g'],
    ]);
  });

  it('a guard whose expression threw (`when: 42`): the same words', async () => {
    const stored = await guardRun({ when: 42 });
    // (a) red when the second resolution-error arm writes no words; (b) prints the entry.
    expect([wordsOf(entriesOf(stored, 'g').at(-1)), stored.failed_steps]).toEqual([
      GUARD_WORDS,
      ['g'],
    ]);
  });

  it("a guard that fired (its abort entry, status 'error', step skipped) carries none of the four", async () => {
    const stored = await guardRun({ abort_unless: ['work.ok == true'] });
    const entry = entriesOf(stored, 'g').at(-1);
    // (a) red when the abort site is given words; (b) prints the entry's status, words and skip.
    expect([entry?.status, wordsOf(entry), stored.skipped_steps.includes('g')]).toEqual([
      'error',
      {},
      true,
    ]);
  });
});

describe('Q1 (#592) unit a — check 2: one cell per stop word', () => {
  it('no retry block, a retryable error → no_retry_policy, no exhausted_by', async () => {
    const { stored } = await run(
      oneStep({}),
      throwing(err('SERVICE_UNAVAILABLE', 'SERVICE', 'wait_for_service', true)),
    );
    // (a) red when the stop word is not `no_retry_policy`, or exhausted_by appears; (b) prints them.
    expect(wordsOf(entriesOf(stored, 'work').at(-1))).toEqual({
      error_code: 'SERVICE_UNAVAILABLE',
      error_category: 'SERVICE',
      agent_action: 'wait_for_service',
      stop_reason: 'no_retry_policy',
      attempt: 1,
    });
  });

  it('the cap spent by an attempt (its bound was the budget, it timed out) → total_timeout', async () => {
    const { stored } = await run(
      oneStep({ timeout_seconds: 5, retry: { max_attempts: 3, total_timeout_seconds: 0.05 } }),
      neverEnds,
    );
    const last = entriesOf(stored, 'work').at(-1);
    // (a) red when the cap is judged after retryability (it would read `non_retryable`); (b) prints.
    expect([last?.stop_reason, last?.exhausted_by, last?.error_code]).toEqual([
      'total_timeout',
      'total_timeout',
      'STEP_TIMEOUT',
    ]);
  });

  it("the sleep guard's stop (the next wait would pass the cap) → total_timeout", async () => {
    let calls = 0;
    const { stored } = await run(
      oneStep({
        retry: {
          max_attempts: 5,
          backoff: 'fixed',
          base_delay_ms: 500,
          total_timeout_seconds: 0.2,
        },
      }),
      async () => {
        calls++;
        throw err('SERVICE_UNAVAILABLE', 'SERVICE', 'wait_for_service', true);
      },
    );
    const last = entriesOf(stored, 'work').at(-1);
    // (a) red when the sleep guard's exit reads `attempts`; (b) prints the calls and the words.
    expect([calls, last?.stop_reason, last?.exhausted_by]).toEqual([
      1,
      'total_timeout',
      'total_timeout',
    ]);
  });

  it('a non-retryable error with slots left → non_retryable, no exhausted_by', async () => {
    const { stored, reply } = await run(
      oneStep({ retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 1 } }),
      throwing(err('VALIDATION_INPUT_SCHEMA', 'VALIDATION', 'provide_input', false)),
    );
    const last = entriesOf(stored, 'work').at(-1);
    // (a) red when the stop word is wrong, exhausted_by appears, or the reply is wrapped; (b) prints.
    expect([wordsOf(last), reply.error_code]).toEqual([
      {
        error_code: 'VALIDATION_INPUT_SCHEMA',
        error_category: 'VALIDATION',
        agent_action: 'provide_input',
        stop_reason: 'non_retryable',
        attempt: 1,
      },
      'VALIDATION_INPUT_SCHEMA',
    ]);
  });

  it('a non-retryable error on the final slot → non_retryable beside exhausted_by attempts; the reply wrapped as today', async () => {
    const { stored, reply } = await run(
      oneStep({ retry: { max_attempts: 1 } }),
      throwing(err('VALIDATION_INPUT_SCHEMA', 'VALIDATION', 'provide_input', false)),
    );
    const last = entriesOf(stored, 'work').at(-1);
    // (a) red when the final slot reads `attempts`, exhausted_by changes, or the wrap is gone;
    //     (b) prints the words and the reply's code.
    expect([last?.stop_reason, last?.exhausted_by, reply.error_code]).toEqual([
      'non_retryable',
      'attempts',
      'STEP_RETRY_EXHAUSTED',
    ]);
  });

  it('a retryable error out of slots → attempts', async () => {
    const { stored } = await run(
      oneStep({ retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 1 } }),
      throwing(err('SERVICE_UNAVAILABLE', 'SERVICE', 'wait_for_service', true)),
    );
    const entries = entriesOf(stored, 'work');
    // (a) red when the stop word is not `attempts`, or sits on a non-last entry; (b) prints them.
    expect(entries.map((e) => [e.attempt, e.stop_reason ?? null])).toEqual([
      [1, null],
      [2, 'attempts'],
    ]);
  });

  it('the opted-in time-out out of slots → attempts', async () => {
    const { stored } = await run(
      oneStep({
        timeout_seconds: 0.05,
        idempotent: true,
        retry: {
          max_attempts: 2,
          backoff: 'fixed',
          base_delay_ms: 1,
          on_timeout: true,
          total_timeout_seconds: 10,
        },
      }),
      neverEnds,
    );
    const last = entriesOf(stored, 'work').at(-1);
    // (a) red when the opt-in's three are not read (it would read `non_retryable`); (b) prints them.
    expect([last?.error_code, last?.stop_reason, last?.exhausted_by, last?.attempt]).toEqual([
      'STEP_TIMEOUT',
      'attempts',
      'attempts',
      2,
    ]);
  });
});

describe('Q1 (#592) unit a — check 3: the cross cells', () => {
  it("a retry block ran out: the entry keeps the inner code with the wrap's report_to_user; the reply is STEP_RETRY_EXHAUSTED as today", async () => {
    const { stored, reply } = await run(
      oneStep({ retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 1 } }),
      throwing(err('SERVICE_UNAVAILABLE', 'SERVICE', 'wait_for_service', true)),
    );
    const last = entriesOf(stored, 'work').at(-1);
    // (a) red when the wrap's line is gone (the entry would say wait_for_service), the entry takes
    //     the outer code, or the reply's details change; (b) prints both.
    expect({
      entry: [last?.error_code, last?.agent_action],
      reply: [
        reply.error_code,
        reply.error_details?.['attempts'],
        reply.error_details?.['exhausted_by'],
      ],
    }).toEqual({
      entry: ['SERVICE_UNAVAILABLE', 'report_to_user'],
      reply: ['STEP_RETRY_EXHAUSTED', 2, 'attempts'],
    });
  });

  it('the not-registered carve-out: the entry keeps the inner action (stop); the step settles recoverably as today', async () => {
    const { stored, reply } = await run(
      oneStep({ handler: 'missing', retry: { max_attempts: 1 } }),
      async () => ({}),
      new ExtensionRegistry(),
    );
    const replyEntry = reply.evidence.filter((e) => e.step_id === 'work').at(-1);
    // (a) red when the wrap's line reaches the carve-out, or the step is failed; (b) prints them.
    expect({
      entry: [replyEntry?.error_code, replyEntry?.agent_action, replyEntry?.stop_reason],
      failed: stored.failed_steps.includes('work'),
    }).toEqual({
      entry: ['ENGINE_HANDLER_NOT_REGISTERED', 'stop', 'non_retryable'],
      failed: false,
    });
  });

  it('a no-retry step: the reply keeps the inner code, unchanged; the entry says no_retry_policy', async () => {
    const { stored, reply } = await run(
      oneStep({}),
      throwing(err('VALIDATION_INPUT_SCHEMA', 'VALIDATION', 'provide_input', false)),
    );
    // (a) red when the reply's code changes or the stop word is wrong; (b) prints both.
    expect([reply.error_code, entriesOf(stored, 'work').at(-1)?.stop_reason]).toEqual([
      'VALIDATION_INPUT_SCHEMA',
      'no_retry_policy',
    ]);
  });
});

describe('Q1 (#592) unit a — check 5: attempt on every attempt', () => {
  it('a step without a retry block that succeeds writes attempt 1 and no failure word', async () => {
    const { stored } = await run(oneStep({}), async () => ({ ok: true }));
    // (a) red when `attempt` is written only with a retry block; (b) prints the entry's words.
    expect(wordsOf(entriesOf(stored, 'work').at(-1))).toEqual({ attempt: 1 });
  });
});

describe('Q1 (#592) unit a — check 6: the reader', () => {
  const failed = (extra: Partial<EvidenceSnapshot>): EvidenceSnapshot => ({
    step_id: 'work',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:01.000Z',
    duration_ms: 1,
    input_summary: {},
    output_summary: {},
    status: 'error',
    error: 'x',
    evidence_hash: 'h',
    ...extra,
  });

  it('an entry written before the words → written_before_failure_words', () => {
    // (a) red when an absence is read as words or as a guess; (b) prints the reader's answer.
    expect(readFailureWords(failed({}))).toEqual({ absent: 'written_before_failure_words' });
  });

  it('a stop word outside STOP_REASONS → returned as recorded, marked unknown', () => {
    const entry = failed({ error_code: 'STEP_TIMEOUT', stop_reason: 'cancelled_by_host' as never });
    // (a) red when an unknown word is refused, replaced or not marked; (b) prints the answer.
    expect(readFailureWords(entry)).toEqual({
      words: {
        error_code: 'STEP_TIMEOUT',
        stop_reason: 'cancelled_by_host',
        unknown: ['stop_reason'],
      },
    });
  });

  it('every listed stop word, with listed code, category and action → returned as is, nothing unknown', () => {
    const answers = STOP_REASONS.map((stop_reason) =>
      readFailureWords(
        failed({
          error_code: 'STEP_TIMEOUT',
          error_category: 'ENGINE',
          agent_action: 'report_to_user',
          stop_reason,
        }),
      ),
    );
    // (a) red when a listed word is marked unknown or dropped; (b) prints the answers.
    expect(answers).toEqual(
      STOP_REASONS.map((stop_reason) => ({
        words: {
          error_code: 'STEP_TIMEOUT',
          error_category: 'ENGINE',
          agent_action: 'report_to_user',
          stop_reason,
          unknown: [],
        },
      })),
    );
  });
});
