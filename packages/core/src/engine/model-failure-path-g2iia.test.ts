// model-failure-path-g2iia.test.ts — gap 2, unit (ii-a): `executeChain`'s `modelFailure` settles the
// named agent step failed because its model request failed. Core mints the code, and the step gets one
// error evidence entry, written as #220's validation-exhausted entry is, whose `diagnostics.failure_kind`
// a later step reads as `$settlement.<step>.failure_kind`. Every cell runs the real `executeChain` on
// `InMemoryStore`.
//
// Each assertion carries (a) the change that turns it red and (b) what it prints when it fails.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import { executeChain, advanceRun, type StepDispatcher } from './execution-loop.js';
import { buildSettlementNamespace } from './eligibility.js';
import { claimStepForDrive } from './drive-claim.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import { createDefaultRegistry } from '../extensions/default-registry.js';
import { InMemoryTraceBufferStore } from '../store/trace-buffer-store.js';
import type { StepHandler } from '../extensions/step-handler.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import type { EvidenceSnapshot, RunRecord } from '../types/run-record.js';
import type { ExecuteChainOptions } from './execution-loop.js';
import type { RunStore } from '../store/store-interface.js';
import type { TraceBufferStore } from '../store/trace-buffer-store.js';
import type { Attributed } from './holder.js';

type ModelFailure = NonNullable<ExecuteChainOptions['modelFailure']>;

const echo: StepDispatcher = async (_step, input) => ({ ...input });
const DRIVE: Attributed = { by: 'drive', by_source: 'derived', channel: 'agent' };

// Gap 2, unit (ii-b2): the member is given only for a step that declares `on_model_failure: fail`, and
// its stop reason must not contradict the step's `retry`: the step declares one (the default pair is
// `attempts`); a `no_retry_policy` cell's step declares none (`retry: undefined`).
const agent = (over: Partial<StepDefinition> = {}): StepDefinition =>
  ({
    description: 'Classify.',
    execution: 'agent',
    depends_on: [],
    on_model_failure: 'fail',
    retry: { max_attempts: 3 },
    ...over,
  }) as StepDefinition;

/** `step` with no `retry` block, for a `no_retry_policy` cell. */
const withoutRetry = (step: StepDefinition): StepDefinition => {
  const { retry: _retry, ...rest } = step;
  return rest as StepDefinition;
};

const wf = (steps: Record<string, StepDefinition>): WorkflowDefinition =>
  ({ id: 'wf-g2iia', name: 'g2iia', version: 1, steps }) as WorkflowDefinition;

/** A transient 503 the step's retry used up: the first admitted pair. */
const failureOf = (over: Partial<ModelFailure> = {}): ModelFailure => ({
  kind: 'transient',
  stop_reason: 'attempts',
  message: 'Anthropic 503: overloaded',
  attempt: 3,
  error_class: 'api_status',
  status: 503,
  ...over,
});

async function runOf(store: RunStore, d: WorkflowDefinition): Promise<string> {
  const { record } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  return record.id;
}

const failChain = (
  store: RunStore,
  d: WorkflowDefinition,
  runId: string,
  modelFailure: ModelFailure,
  extra: Partial<ExecuteChainOptions> = {},
) =>
  executeChain(store, d, {
    runId,
    command: 'classify',
    input: {},
    dispatcher: echo,
    modelFailure,
    ...extra,
  });

const entriesOf = (run: RunRecord, step: string): EvidenceSnapshot[] =>
  run.evidence.filter((e) => e.step_id === step);

/** One handler that records it ran. */
function okHandler(id: string, ran: string[]): StepHandler {
  return {
    id,
    execute: vi.fn(async () => {
      ran.push(id);
      return { data: { ran: id } };
    }),
  };
}

describe('gap 2, unit (ii-a) — each admitted pair settles the step failed (check 1)', () => {
  const ROWS: Array<{
    name: string;
    failure: ModelFailure;
    code: string;
    category: string;
    exhausted_by?: 'attempts' | 'total_timeout';
  }> = [
    {
      name: 'transient × attempts → STEP_RETRY_EXHAUSTED',
      failure: failureOf({ stop_reason: 'attempts', attempts_sdk: 1 }),
      code: 'STEP_RETRY_EXHAUSTED',
      category: 'ENGINE',
      exhausted_by: 'attempts',
    },
    {
      name: 'transient × total_timeout → STEP_RETRY_EXHAUSTED',
      failure: failureOf({ stop_reason: 'total_timeout', attempt: 2 }),
      code: 'STEP_RETRY_EXHAUSTED',
      category: 'ENGINE',
      exhausted_by: 'total_timeout',
    },
    {
      name: 'transient × non_retryable → MODEL_REQUEST_FAILED',
      failure: failureOf({
        stop_reason: 'non_retryable',
        attempt: 1,
        error_class: 'connection_timeout',
        status: null,
      }),
      code: 'MODEL_REQUEST_FAILED',
      category: 'SERVICE',
    },
    {
      name: 'transient × no_retry_policy → MODEL_REQUEST_FAILED',
      failure: failureOf({ stop_reason: 'no_retry_policy', attempt: 3, attempts_sdk: 3 }),
      code: 'MODEL_REQUEST_FAILED',
      category: 'SERVICE',
    },
    {
      name: 'permanent × non_retryable → MODEL_REQUEST_FAILED',
      failure: failureOf({
        kind: 'permanent',
        stop_reason: 'non_retryable',
        attempt: 1,
        status: 400,
        message: 'Anthropic 400: prompt is too long',
      }),
      code: 'MODEL_REQUEST_FAILED',
      category: 'SERVICE',
    },
  ];

  for (const row of ROWS) {
    it(row.name, async () => {
      const ran: string[] = [];
      const registry = new ExtensionRegistry();
      registry.register('handler', 'h_catch', okHandler('h_catch', ran));
      const d = wf({
        classify: row.failure.stop_reason === 'no_retry_policy' ? withoutRetry(agent()) : agent(),
        on_catch: {
          description: 'Clean up.',
          execution: 'finalizer',
          on_outcome: ['fail'],
          handler: 'h_catch',
        } as StepDefinition,
      });
      const store = new InMemoryStore();
      const runId = await runOf(store, d);
      const f = row.failure;
      const reply = await failChain(store, d, runId, f, { registry });
      const { record: run } = await store.get(runId);

      // (a) red when the member is ignored (the step is dispatched and completes); (b) prints the lists.
      expect(run.failed_steps).toEqual(['classify']);
      expect(run.completed_steps).not.toContain('classify');
      const entries = entriesOf(run, 'classify');
      // (a) red when a second (dispatched) entry is written; (b) prints the entries.
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      // (a) red when a word is not written or is the auto steps' judging; (b) prints the words.
      expect({
        status: entry.status,
        error: entry.error,
        error_code: entry.error_code,
        error_category: entry.error_category,
        agent_action: entry.agent_action,
        stop_reason: entry.stop_reason,
        attempt: entry.attempt,
        exhausted_by: entry.exhausted_by,
        failure_kind: entry.diagnostics?.failure_kind,
        validation_rejections: entry.diagnostics?.validation_rejections,
        input: entry.input_summary,
        output: entry.output_summary,
      }).toEqual({
        status: 'error',
        error: f.message,
        error_code: row.code,
        error_category: row.category,
        agent_action: 'report_to_user',
        stop_reason: f.stop_reason,
        attempt: f.attempt,
        exhausted_by: row.exhausted_by,
        failure_kind: f.kind,
        validation_rejections: undefined,
        input: {},
        output: {},
      });
      // (a) red when the details drop a member or the code changes; (b) prints the reply's details.
      const sdk = f.attempts_sdk !== undefined ? { attempts_sdk: f.attempts_sdk } : {};
      expect(reply.error_details).toEqual(
        row.code === 'STEP_RETRY_EXHAUSTED'
          ? {
              stepName: 'classify',
              attempts: f.attempt,
              lastError: f.message,
              exhausted_by: f.stop_reason,
              failure_kind: f.kind,
              error_class: f.error_class,
              status: f.status,
              ...sdk,
            }
          : {
              stepName: 'classify',
              failure_kind: f.kind,
              error_class: f.error_class,
              status: f.status,
              attempts: f.attempt,
              ...sdk,
            },
      );
      // (a) red when the minted message is not the member's; (b) prints both.
      expect(reply.status).toBe('error');
      expect(reply.error_code).toBe(row.code);
      expect(reply.errors).toEqual([f.message]);
      expect(run.terminal_reason).toBe(`Step 'classify' failed: ${f.message}`);
      // (a) red when the failure does not end the run or its finalizer does not drain; (b) prints them.
      expect(run.terminal_state).toBe(true);
      expect(ran).toEqual(['h_catch']);
    });
  }
});

describe('gap 2, unit (ii-a) — what the member bypasses (check 2)', () => {
  it('2b: the pre-claim input-schema judge does not count a rejection', async () => {
    const d = wf({
      classify: agent({
        input_schema: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
      } as Partial<StepDefinition>),
    });
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    const reply = await failChain(
      store,
      d,
      runId,
      failureOf({ kind: 'permanent', stop_reason: 'non_retryable' }),
    );
    const { record: run } = await store.get(runId);
    // (a) red when 2b runs under the member (it counts `{}` and refuses it); (b) prints code and count.
    expect({ code: reply.error_code, count: run.validation_rejections?.['classify'] ?? 0 }).toEqual(
      {
        code: 'MODEL_REQUEST_FAILED',
        count: 0,
      },
    );
    expect(run.failed_steps).toEqual(['classify']);
  });

  it('2c: the output-schema judge does not run', async () => {
    const d = wf({
      classify: agent({
        output_schema: {
          type: 'object',
          required: ['category'],
          properties: { category: { type: 'string' } },
        },
      } as Partial<StepDefinition>),
    });
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    const reply = await failChain(store, d, runId, failureOf());
    const { record: run } = await store.get(runId);
    // (a) red when 2c runs under the member (VALIDATION_OUTPUT_SCHEMA, a counted rejection); (b) prints both.
    expect({ code: reply.error_code, count: run.validation_rejections?.['classify'] ?? 0 }).toEqual(
      {
        code: 'STEP_RETRY_EXHAUSTED',
        count: 0,
      },
    );
  });

  it('2d: the trace-enforce check does not return', async () => {
    const d = wf({
      classify: agent({
        trace_schema: { type: 'array', items: { type: 'object', required: ['event', 'myField'] } },
        trace_validation_mode: 'enforce',
      } as Partial<StepDefinition>),
    });
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    const reply = await failChain(store, d, runId, failureOf(), {
      trace: [{ event: 'bad_entry' }],
    });
    const { record: run } = await store.get(runId);
    // (a) red when the enforce gate returns under the member (VALIDATION_TRACE_SCHEMA, step open); (b) prints.
    expect({ code: reply.error_code, failed: run.failed_steps }).toEqual({
      code: 'STEP_RETRY_EXHAUSTED',
      failed: ['classify'],
    });
    // The trace is still recorded on the entry, judged in warn shape.
    expect(entriesOf(run, 'classify')[0]?.trace?.[0]?.event).toBe('bad_entry');
  });

  it("dispatch: nothing is dispatched, so the error entry is the step's only entry", async () => {
    const d = wf({ classify: agent() });
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    await failChain(store, d, runId, failureOf());
    const { record: run } = await store.get(runId);
    // (a) red when the dispatch loop runs under the member (a success entry first); (b) prints statuses.
    expect(entriesOf(run, 'classify').map((e) => e.status)).toEqual(['error']);
  });

  it('the stop-reason block keeps the stated stop reason (permanent, no retry block)', async () => {
    const d = wf({ classify: agent() });
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    await failChain(
      store,
      d,
      runId,
      failureOf({ kind: 'permanent', stop_reason: 'non_retryable', attempt: 1 }),
    );
    const { record: run } = await store.get(runId);
    // (a) red when the block rewrites it under the member (no_retry_policy); (b) prints the word.
    expect(entriesOf(run, 'classify')[0]?.stop_reason).toBe('non_retryable');
  });

  it('the retry wrap does not run (a hand-built max_attempts: 0)', async () => {
    // A loader-valid definition cannot reach the wrap (max_attempts >= 1), so this one is hand-built,
    // as validation-exhaustion.test.ts builds its own.
    const d = wf({
      classify: agent({
        retry: { max_attempts: 0, backoff: 'fixed', base_delay_ms: 0 },
      } as Partial<StepDefinition>),
    });
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    const reply = await failChain(
      store,
      d,
      runId,
      failureOf({ kind: 'permanent', stop_reason: 'non_retryable', attempt: 1 }),
    );
    // (a) red when the wrap runs under the member (STEP_RETRY_EXHAUSTED "after 0 attempts"); (b) prints.
    expect({ code: reply.error_code, errors: reply.errors }).toEqual({
      code: 'MODEL_REQUEST_FAILED',
      errors: ['Anthropic 503: overloaded'],
    });
  });
});

describe('gap 2, unit (ii-a) — a step with validation_exhaustion.mode: default still fails (check 3)', () => {
  it('fails, with no settled_by_default and no rejection counted', async () => {
    const d = wf({
      classify: agent({
        output_schema: {
          type: 'object',
          required: ['category'],
          properties: { category: { type: 'string' } },
        },
        validation_exhaustion: {
          threshold: 1,
          mode: 'default',
          default_output: { category: 'unknown' },
        },
      } as Partial<StepDefinition>),
    });
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    await failChain(store, d, runId, failureOf());
    const { record: run } = await store.get(runId);
    const entry = entriesOf(run, 'classify')[0];
    // (a) red when the path is armed through the rejection count (default-settled); (b) prints the facts.
    expect({
      failed: run.failed_steps,
      completed: run.completed_steps,
      by_default: entry?.diagnostics?.settled_by_default,
      count: run.validation_rejections?.['classify'] ?? 0,
    }).toEqual({ failed: ['classify'], completed: [], by_default: undefined, count: 0 });
  });
});

describe('gap 2, unit (ii-a) — admission refuses a bad member, naming it (check 4)', () => {
  const refused = async (
    d: WorkflowDefinition,
    modelFailure: unknown,
    input: Record<string, unknown> = {},
  ): Promise<{ message: string; code: string; written: boolean }> => {
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    const before = (await store.get(runId)).record.version;
    try {
      await executeChain(store, d, {
        runId,
        command: 'classify',
        input,
        dispatcher: echo,
        modelFailure: modelFailure as ModelFailure,
      });
    } catch (err) {
      const after = (await store.get(runId)).record.version;
      return {
        message: (err as Error).message,
        code: (err as { code?: string }).code ?? '',
        written: after !== before,
      };
    }
    throw new Error('not refused');
  };
  const sentence = (clause: string): string =>
    `executeChain was called with 1 invalid option(s): ${clause}. Nothing was read or written.`;

  const CELLS: Array<{
    name: string;
    d?: WorkflowDefinition;
    failure: unknown;
    input?: Record<string, unknown>;
    clause: string;
  }> = [
    {
      name: 'a step that is not an agent step',
      d: wf({
        classify: {
          description: 'Work.',
          execution: 'auto',
          depends_on: [],
          handler: 'h',
        } as StepDefinition,
      }),
      failure: failureOf(),
      clause:
        "options.modelFailure must be given only for an agent step ('classify' is an auto step)",
    },
    {
      name: 'a pair outside the table (permanent × attempts)',
      failure: failureOf({ kind: 'permanent', stop_reason: 'attempts' }),
      clause:
        'options.modelFailure.stop_reason must be attempts, total_timeout, non_retryable or ' +
        'no_retry_policy when kind is transient, and non_retryable when kind is permanent (got string)',
    },
    {
      name: 'a kind outside its type (setup)',
      failure: failureOf({ kind: 'setup' as never }),
      clause: 'options.modelFailure.kind must be one of transient, permanent (got string)',
    },
    {
      name: 'a stop reason outside its type',
      failure: failureOf({ stop_reason: 'later' as never }),
      clause:
        'options.modelFailure.stop_reason must be one of no_retry_policy, total_timeout, ' +
        'non_retryable, attempts (got string)',
    },
    {
      name: 'a message that is not text',
      failure: { ...failureOf(), message: undefined },
      clause: 'options.modelFailure.message must be a string (got undefined)',
    },
    {
      name: 'an attempt of 0',
      failure: failureOf({ attempt: 0 }),
      clause: 'options.modelFailure.attempt must be a whole number above 0 (got number)',
    },
    {
      name: 'a status that is not a whole number or null',
      failure: failureOf({ status: '503' as never }),
      clause: 'options.modelFailure.status must be a whole number or null (got string)',
    },
    {
      name: 'an attempts_sdk of 0',
      failure: failureOf({ attempts_sdk: 0 }),
      clause: 'options.modelFailure.attempts_sdk must be a whole number above 0 (got number)',
    },
    {
      // Amendment 1: a class only Realm's startup writers may mint is not one a program claims.
      name: 'a class outside the claimable list (startup_failure)',
      failure: failureOf({ error_class: 'startup_failure' as never }),
      clause:
        'options.modelFailure.error_class must be one of connection_timeout, connection_error, ' +
        'api_status, sdk_missing, validation_rejected, aborted_by_budget, other (got string)',
    },
    {
      name: 'a non-empty input',
      failure: failureOf(),
      input: { category: 'x' },
      clause:
        'options.input must be an empty object when options.modelFailure is given: a failed model ' +
        'request has no answer (got object)',
    },
  ];

  for (const cell of CELLS) {
    it(cell.name, async () => {
      const got = await refused(cell.d ?? wf({ classify: agent() }), cell.failure, cell.input);
      // (a) red when the arm is removed (the call runs, or another sentence); (b) prints the refusal.
      expect(got).toEqual({
        message: sentence(cell.clause),
        code: 'VALIDATION_OPTION_INVALID',
        written: false,
      });
    });
  }
});

describe('gap 2, unit (ii-a) — under heldClaim (check 5)', () => {
  const registry = createDefaultRegistry();

  async function held() {
    const d = wf({ classify: agent() });
    const store = new InMemoryStore({ leases: createLeaseDouble() });
    const runId = await runOf(store, d);
    const answer = await claimStepForDrive(store, runId, 'classify', {
      definition: d,
      registry,
      driver: DRIVE,
    });
    if (answer.kind !== 'claimed') throw new Error(`not claimed: ${JSON.stringify(answer)}`);
    return { d, store, runId, hold: answer.hold };
  }

  it('the held claim is adopted and the step settles failed under it', async () => {
    const { d, store, runId, hold } = await held();
    const reply = await failChain(store, d, runId, failureOf(), {
      registry,
      driver: DRIVE,
      heldClaim: { hold },
    });
    const { record: run } = await store.get(runId);
    // (a) red when the path claims afresh under a hold (STATE_STEP_ALREADY_CLAIMED); (b) prints both.
    expect({
      code: reply.error_code,
      failed: run.failed_steps,
      claims: run.claims?.['classify'],
    }).toEqual({
      code: 'STEP_RETRY_EXHAUSTED',
      failed: ['classify'],
      claims: undefined,
    });
  });

  it('a hold that is gone is refused STATE_CLAIM_LOST, and nothing settles', async () => {
    const { d, store, runId, hold } = await held();
    // Another program takes the claim over while the call reads its trace, before Step 3.
    let n = 0;
    const traceBufferStore: TraceBufferStore = {
      append: async () => {
        throw new Error('not used');
      },
      read: async () => {
        n += 1;
        if (n === 1) {
          const { record } = await store.get(runId);
          await store.update({
            ...record,
            claims: {
              ...record.claims,
              classify: {
                deadline: null,
                token: 'other-token',
                since: '2026-01-01T00:00:00.000Z',
                holder: { by: 'other', by_source: 'derived', channel: 'agent' },
                lease: { id: 'lease-other' },
              },
            },
          });
        }
        return [];
      },
      delete: async () => {},
      deleteAllForRun: async () => ({ bytes_deleted: 0 }),
      statAllForRun: async () => ({ bytes: 0 }),
      readAllForRun: async () => ({}),
    };
    const reply = await failChain(store, d, runId, failureOf(), {
      registry,
      driver: DRIVE,
      heldClaim: { hold },
      traceBufferStore,
    });
    const { record: run } = await store.get(runId);
    // (a) red when the path settles under a lost hold; (b) prints the code, the refusal and the lists.
    expect({
      code: reply.error_code,
      refusal: reply.refusal?.code,
      failed: run.failed_steps,
      lease: run.claims?.['classify']?.lease,
    }).toEqual({
      code: 'STATE_CLAIM_LOST',
      refusal: 'claim_removed',
      failed: [],
      lease: { id: 'lease-other' },
    });
  });
});

describe('gap 2, unit (ii-a) — the one error entry (check 6)', () => {
  it('carries every stepMeta member, the adopted trace lines, and no made-up structured output', async () => {
    const d = {
      ...wf({
        classify: agent({
          agent_profile: 'reviewer',
          structured_output: 'strict',
        } as Partial<StepDefinition>),
      }),
      resolved_profiles: { reviewer: { content: 'You review.', content_hash: 'sha256:test-hash' } },
    } as WorkflowDefinition;
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    const traceBufferStore = new InMemoryTraceBufferStore(store);
    await traceBufferStore.append(runId, 'classify', [{ event: 'wal-thinking' }]);
    const toolCalls = [
      {
        server_id: 'github',
        tool: 'get_pull_request',
        args: { pr: 1 },
        result: 'PR',
        duration_ms: 5,
      },
    ];
    const modelText = { recorded: false as const, why: 'switched_off' as const };
    const modelAttempts = [
      {
        request: 0,
        kind: 'transient' as const,
        error_class: 'api_status' as const,
        status: 503,
        wait_ms: null,
        retry_after_ms: null,
        exhausted_by: 'attempts' as const,
      },
    ];
    const usage = [{ request_index: 0 }];
    await failChain(store, d, runId, failureOf(), {
      traceBufferStore,
      stepMeta: { toolCalls, modelText, modelAttempts, usage } as never,
    });
    const { record: run } = await store.get(runId);
    const entry = entriesOf(run, 'classify')[0]!;
    // (a) red when the entry is built from texts, tries and usage only; (b) prints what it carries.
    expect({
      tool: entry.tool_calls?.[0]?.tool,
      model_text: entry.model_text,
      tries: entry.model_attempts?.length,
      cache: entry.diagnostics?.cache !== undefined,
      profile: entry.agent_profile,
      trace: entry.trace?.map((t) => t.event),
      structured_output: entry.diagnostics?.structured_output,
    }).toEqual({
      tool: 'get_pull_request',
      model_text: modelText,
      tries: 1,
      cache: true,
      profile: 'reviewer',
      trace: ['wal-thinking'],
      structured_output: undefined,
    });
    // (a) red when Step 5's buffer delete runs before the lines are on the entry; (b) prints what is left.
    expect(await traceBufferStore.read(runId, 'classify')).toEqual([]);
  });

  it('carries the structured output the driver reported', async () => {
    const d = wf({ classify: agent({ structured_output: 'strict' } as Partial<StepDefinition>) });
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    await failChain(store, d, runId, failureOf(), {
      stepMeta: { structuredOutput: { requested: true, sent: true } },
    });
    const { record: run } = await store.get(runId);
    // (a) red when the driver's report is dropped; (b) prints the disclosure.
    expect(entriesOf(run, 'classify')[0]?.diagnostics?.structured_output).toEqual({
      requested: true,
      sent: true,
    });
  });
});

describe('gap 2, unit (ii-a) — $settlement.<step>.failure_kind (check 7)', () => {
  function routed(): { d: WorkflowDefinition; registry: ExtensionRegistry; ran: string[] } {
    const ran: string[] = [];
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h_retry', okHandler('h_retry', ran));
    const d = wf({
      classify: agent(),
      try_later: {
        description: 'Queue a later try.',
        execution: 'auto',
        depends_on: ['classify'],
        trigger_rule: 'one_failed',
        when: "$settlement.classify.failure_kind == 'transient'",
        handler: 'h_retry',
      } as StepDefinition,
    });
    return { d, registry, ran };
  }

  it('a later step runs after a transient failure', async () => {
    const { d, registry, ran } = routed();
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    await failChain(store, d, runId, failureOf(), { registry });
    await advanceRun(store, d, { runId, registry });
    const { record: run } = await store.get(runId);
    // (a) red when failure_kind is not derived (the when reads null, the step is skipped); (b) prints.
    expect({ ran, completed: run.completed_steps }).toEqual({
      ran: ['h_retry'],
      completed: ['try_later'],
    });
  });

  it('and is skipped (when_false) after a permanent one', async () => {
    const { d, registry, ran } = routed();
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    await failChain(
      store,
      d,
      runId,
      failureOf({ kind: 'permanent', stop_reason: 'non_retryable' }),
      { registry },
    );
    await advanceRun(store, d, { runId, registry });
    const { record: run } = await store.get(runId);
    // (a) red when the kind is written as transient; (b) prints the skip.
    expect({
      ran,
      skipped: run.skipped_steps,
      kind: run.skip_details?.['try_later']?.kind,
    }).toEqual({
      ran: [],
      skipped: ['try_later'],
      kind: 'when_false',
    });
  });

  it("is absent for a step failed another way (an auto step's handler error)", async () => {
    const registry = new ExtensionRegistry();
    registry.register('handler', 'h_boom', {
      id: 'h_boom',
      execute: async () => {
        throw new Error('boom');
      },
    });
    const d = wf({
      work: {
        description: 'Work.',
        execution: 'auto',
        depends_on: [],
        handler: 'h_boom',
      } as StepDefinition,
    });
    const store = new InMemoryStore();
    const runId = await runOf(store, d);
    await advanceRun(store, d, { runId, registry });
    const { record: run } = await store.get(runId);
    expect(run.failed_steps).toEqual(['work']);
    // (a) red when the field is written on every failed step; (b) prints the entry.
    expect(buildSettlementNamespace(run)['work']).toEqual({
      settled_by_default: false,
      validation_rejections: 0,
      failed: true,
    });
  });
});
