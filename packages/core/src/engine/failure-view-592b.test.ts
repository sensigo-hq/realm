// failure-view-592b.test.ts — Q1 (#592) unit b (prompt q1-b-one-composer-two-carriers.md): the one
// composer of a run's failures, read from the record alone. Checks 1, 5 and 6 of the prompt: one
// cell per state the composer meets (words, the retried step, a cleanup step and a guard, missing
// words, an entry written before the words, no entry, an unknown word, the cap, a malformed
// record), the fail seal beside `terminal_reason`, and resume.
//
// Every assertion names (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { executeStep, executeChain } from './execution-loop.js';
import type { StepDispatcher } from './execution-loop.js';
import { applyResume } from './apply-resume.js';
import { composeFailures } from './failure-view.js';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { StepHandler } from '../extensions/step-handler.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { EvidenceSnapshot, RunRecord } from '../types/run-record.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import { capText } from '../utils/redaction.js';

const oneStep = (step: Partial<StepDefinition>, extra: Record<string, StepDefinition> = {}) =>
  ({
    id: 'fv-592b',
    name: 'Failure view',
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
  await executeStep(store, def, {
    runId: record.id,
    command: 'work',
    input: {},
    dispatcher,
    ...(registry !== undefined ? { registry } : {}),
  });
  return (await store.get(record.id)).record;
}
const lastError = (r: RunRecord, step: string) =>
  r.evidence.filter((e) => e.step_id === step && typeof e.error === 'string').at(-1)?.error;

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
function handlerRegistry(h: StepHandler['execute']): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register('handler', 'h', { id: 'h', execute: h } as StepHandler);
  return registry;
}

/** A hand-built record: `failed_steps` and the entries given, nothing else. */
const recordOf = (failed: unknown, evidence: unknown): RunRecord =>
  ({
    id: 'r-592b',
    workflow_id: 'fv-592b',
    workflow_version: 1,
    run_phase: 'running',
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: failed,
    skipped_steps: [],
    version: 1,
    params: {},
    evidence,
    created_at: '2026-11-21T00:00:00.000Z',
    updated_at: '2026-11-21T00:00:00.000Z',
    terminal_state: false,
  }) as RunRecord;
const entry = (over: Partial<EvidenceSnapshot> & Record<string, unknown>): EvidenceSnapshot =>
  ({
    step_id: 'work',
    started_at: '2026-11-21T00:00:00.000Z',
    completed_at: '2026-11-21T00:00:01.000Z',
    duration_ms: 1,
    input_summary: {},
    output_summary: {},
    status: 'error',
    evidence_hash: 'h',
    ...over,
  }) as EvidenceSnapshot;

describe('Q1 (#592) unit b — check 1: the composer, one cell per state (engine-written records)', () => {
  it('a step failed with its words, no retry block: the full view, attempt 1', async () => {
    const stored = await run(
      oneStep({}),
      throwing(err('VALIDATION_INPUT_SCHEMA', 'VALIDATION', 'provide_input', false)),
    );
    // (a) red when the composer reads other words, another entry or drops a key; (b) prints the view.
    expect(composeFailures(stored)).toEqual([
      {
        step: 'work',
        code: 'VALIDATION_INPUT_SCHEMA',
        category: 'VALIDATION',
        stop_reason: 'no_retry_policy',
        agent_action: 'provide_input',
        attempt: 1,
        message: lastError(stored, 'work'),
      },
    ]);
    expect(lastError(stored, 'work')).toBe('VALIDATION_INPUT_SCHEMA from the test');
  });

  it("a step that ran out of retries: stop_reason attempts, the wrap's report_to_user, the last attempt and its error", async () => {
    let calls = 0;
    const stored = await run(
      oneStep({ retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 1 } }),
      async () => {
        calls += 1;
        throw new WorkflowError(`upstream returned 503 (call ${calls})`, {
          code: 'SERVICE_RATE_LIMITED',
          category: 'SERVICE',
          agentAction: 'wait_and_proceed',
          retryable: true,
        });
      },
    );
    // (a) red when the composer picks an earlier attempt's entry, or not the wrap's action; (b)
    //     prints the view.
    expect(composeFailures(stored)).toEqual([
      {
        step: 'work',
        code: 'SERVICE_RATE_LIMITED',
        category: 'SERVICE',
        stop_reason: 'attempts',
        agent_action: 'report_to_user',
        attempt: 3,
        message: 'upstream returned 503 (call 3)',
      },
    ]);
  });

  it("a cleanup step in failed_steps: its own entry's words", async () => {
    const def = oneStep(
      { execution: 'agent' },
      {
        fin: {
          description: 'Cleanup',
          execution: 'finalizer',
          on_outcome: 'fail',
          handler: 'h',
        } as StepDefinition,
      },
    );
    const stored = await run(
      def,
      throwing(new Error('step boom')),
      handlerRegistry(async () => {
        throw new Error('cleanup boom');
      }),
    );
    const fin = composeFailures(stored).find((v) => v.step === 'fin');
    // (a) red when the cleanup step is not listed, or with another entry's words; (b) prints it.
    expect([stored.failed_steps.includes('fin'), fin]).toEqual([
      true,
      {
        step: 'fin',
        code: 'ENGINE_HANDLER_FAILED',
        category: 'ENGINE',
        stop_reason: 'no_retry_policy',
        agent_action: 'stop',
        message: lastError(stored, 'fin'),
      },
    ]);
  });

  it("a guard in failed_steps: its resolution error's words", async () => {
    const def = oneStep(
      { execution: 'agent' },
      {
        g: {
          description: 'Guard',
          execution: 'guard',
          depends_on: ['work'],
          abort_unless: ['$.nope.field == true'],
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
    const stored = (await store.get(record.id)).record;
    // (a) red when the guard is not listed, or with words other than its entry's; (b) prints it.
    expect(composeFailures(stored)).toEqual([
      {
        step: 'g',
        code: 'GUARD_RESOLUTION_ERROR',
        category: 'ENGINE',
        stop_reason: 'no_retry_policy',
        agent_action: 'report_to_user',
        message: lastError(stored, 'g'),
      },
    ]);
  });
});

describe('Q1 (#592) unit b — check 1: the composer, one cell per state (hand-built records)', () => {
  it('an entry with a code but no category, action or stop word: those keys absent, never undefined', () => {
    const [view] = composeFailures(
      recordOf(['work'], [entry({ error: 'boom', error_code: 'ENGINE_INTERNAL' as never })]),
    );
    // (a) red when a missing word is guessed or printed as undefined; (b) prints the view and keys.
    expect([view, Object.keys(view!)]).toEqual([
      { step: 'work', code: 'ENGINE_INTERNAL', message: 'boom' },
      ['step', 'code', 'message'],
    ]);
  });

  it('an entry written before the words (error, no error_code), with and without attempt: the absence, its message', () => {
    const views = composeFailures(
      recordOf(
        ['a', 'b'],
        [
          entry({ step_id: 'a', error: 'old a', attempt: 2 }),
          entry({ step_id: 'b', error: 'old b' }),
        ],
      ),
    );
    // (a) red when the absence is not named, the message is dropped, or attempt is lost or
    //     invented; (b) prints both views.
    expect(views).toEqual([
      { step: 'a', absent: 'written_before_failure_words', message: 'old a', attempt: 2 },
      { step: 'b', absent: 'written_before_failure_words', message: 'old b' },
    ]);
  });

  it('a failed_steps name with no failed entry, or whose error is not a string: entry_not_found', () => {
    const views = composeFailures(
      recordOf(
        ['none', 'number'],
        [
          entry({ step_id: 'none', status: 'success' }),
          entry({ step_id: 'number', error: 42 as never }),
        ],
      ),
    );
    // (a) red when a name with no string error is given a view other than entry_not_found; (b)
    //     prints the views.
    expect(views).toEqual([
      { step: 'none', absent: 'entry_not_found' },
      { step: 'number', absent: 'entry_not_found' },
    ]);
  });

  it("a stop word outside its list: carried as recorded, named in unknown by the view's key", () => {
    const [view] = composeFailures(
      recordOf(
        ['work'],
        [
          entry({
            error: 'boom',
            error_code: 'ENGINE_INTERNAL' as never,
            error_category: 'ENGINE',
            agent_action: 'stop',
            stop_reason: 'budget_spent' as never,
          }),
        ],
      ),
    );
    // (a) red when the word is replaced, dropped, or named by the entry's field; (b) prints the view.
    expect(view).toEqual({
      step: 'work',
      code: 'ENGINE_INTERNAL',
      category: 'ENGINE',
      stop_reason: 'budget_spent',
      agent_action: 'stop',
      message: 'boom',
      unknown: ['stop_reason'],
    });
  });

  it('an unknown code and category: unknown names code and category, the view keys', () => {
    const [view] = composeFailures(
      recordOf(
        ['work'],
        [
          entry({
            error: 'boom',
            error_code: 'NEW_CODE' as never,
            error_category: 'NEWCAT' as never,
          }),
        ],
      ),
    );
    // (a) red when unknown holds the reader's field names; (b) prints it.
    expect(view).toEqual({
      step: 'work',
      code: 'NEW_CODE',
      category: 'NEWCAT',
      message: 'boom',
      unknown: ['code', 'category'],
    });
  });

  it('a message over 500 characters: the text capText gives, on both the words and the absence', () => {
    const long = 'x'.repeat(501);
    const views = composeFailures(
      recordOf(
        ['a', 'b'],
        [
          entry({ step_id: 'a', error: long, error_code: 'ENGINE_INTERNAL' as never }),
          entry({ step_id: 'b', error: long }),
        ],
      ),
    );
    // (a) red when the message is not bounded, or bounded another way; (b) prints the messages.
    expect(views.map((v) => ('message' in v ? v.message : undefined))).toEqual([
      capText(long),
      capText(long),
    ]);
    expect(capText(long)).toBe('‹501 characters, not kept›');
  });

  it('the LAST failed entry of the step is read, not the first', () => {
    const [view] = composeFailures(
      recordOf(
        ['work'],
        [
          entry({ error: 'first', error_code: 'ENGINE_INTERNAL' as never, attempt: 1 }),
          entry({ error: 'second', error_code: 'STEP_TIMEOUT' as never, attempt: 2 }),
          entry({ status: 'success' }),
        ],
      ),
    );
    // (a) red when the composer takes the first failed entry; (b) prints the view.
    expect(view).toEqual({ step: 'work', code: 'STEP_TIMEOUT', attempt: 2, message: 'second' });
  });

  it('a malformed record: evidence not an array, entries not objects, a word not a string — no throw, the absences', () => {
    // (a) red when any of these throws, or reads a non-string word as a word; (b) prints the views.
    expect([
      composeFailures(recordOf(['work'], 'not a list')),
      composeFailures(recordOf(['work'], [null, 7, 'x'])),
      composeFailures(recordOf('not a list', [])),
      composeFailures(recordOf(['work', 3], [entry({ error: 'boom', error_code: 5 as never })])),
    ]).toEqual([
      [{ step: 'work', absent: 'entry_not_found' }],
      [{ step: 'work', absent: 'entry_not_found' }],
      [],
      [{ step: 'work', absent: 'written_before_failure_words', message: 'boom' }],
    ]);
  });

  it('nothing failed: []', () => {
    // (a) red when an empty failed_steps yields a view; (b) prints it.
    expect(composeFailures(recordOf([], [entry({ error: 'boom' })]))).toEqual([]);
  });
});

describe('Q1 (#592) unit b — check 5: a fail seal, beside terminal_reason', () => {
  it("a single non-retried failure: the view's message is the entry's error; terminal_reason as the base writes it", async () => {
    const stored = await run(oneStep({}), throwing(new Error('plain boom')));
    const [view] = composeFailures(stored);
    // (a) red when the view's message is not the entry's, or terminal_reason changes; (b) prints both.
    expect({
      message: view !== undefined && 'message' in view ? view.message : undefined,
      entry: lastError(stored, 'work'),
      terminal_reason: stored.terminal_reason,
    }).toEqual({
      message: lastError(stored, 'work'),
      entry: 'Dispatcher failed: plain boom',
      terminal_reason: "Step 'work' failed: Dispatcher failed: plain boom",
    });
  });

  it("a retried step's failure: the view says the last attempt's own error, terminal_reason keeps the wrap's sentence", async () => {
    const stored = await run(
      oneStep({ retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 1 } }),
      throwing(err('SERVICE_RATE_LIMITED', 'SERVICE', 'wait_and_proceed', true)),
    );
    const [view] = composeFailures(stored);
    // (a) red when either changes; (b) prints both.
    expect({
      message: view !== undefined && 'message' in view ? view.message : undefined,
      terminal_reason: stored.terminal_reason,
    }).toEqual({
      message: 'SERVICE_RATE_LIMITED from the test',
      terminal_reason: "Step 'work' failed: Step 'work' failed after 2 attempts",
    });
  });
});

describe('Q1 (#592) unit b — check 6: resume', () => {
  it('a resumed step leaves failures before it runs again; failing again, it is listed once with the new words', async () => {
    const def: WorkflowDefinition = {
      id: 'fv-592b-resume',
      name: 'Resume',
      version: 1,
      steps: {
        fail_a: { description: 'A', execution: 'agent', depends_on: [] },
        fail_b: { description: 'B', execution: 'agent', depends_on: [] },
      },
    };
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    for (const step of ['fail_a', 'fail_b']) {
      await executeStep(store, def, {
        runId: record.id,
        command: step,
        input: {},
        dispatcher: throwing(new Error(`${step} v1`)),
      });
    }
    const sealed = (await store.get(record.id)).record;
    const { run: resumed } = applyResume(sealed, 'fail_a', def);
    const afterResume = composeFailures(resumed).map((v) => v.step);
    await store.update(resumed);
    await executeStep(store, def, {
      runId: record.id,
      command: 'fail_a',
      input: {},
      dispatcher: throwing(err('VALIDATION_OUTPUT_SCHEMA', 'VALIDATION', 'provide_input', false)),
    });
    const again = composeFailures((await store.get(record.id)).record);
    // (a) red when the resumed step is still listed, is listed twice, or keeps the old words; (b)
    //     prints the steps after resume and the views after the second failure.
    expect({ before: composeFailures(sealed).map((v) => v.step), afterResume, again }).toEqual({
      before: ['fail_a', 'fail_b'],
      afterResume: ['fail_b'],
      again: [
        {
          step: 'fail_b',
          code: 'ENGINE_INTERNAL',
          category: 'ENGINE',
          stop_reason: 'no_retry_policy',
          agent_action: 'stop',
          attempt: 1,
          message: 'Dispatcher failed: fail_b v1',
        },
        {
          step: 'fail_a',
          code: 'VALIDATION_OUTPUT_SCHEMA',
          category: 'VALIDATION',
          stop_reason: 'no_retry_policy',
          agent_action: 'provide_input',
          attempt: 1,
          message: 'VALIDATION_OUTPUT_SCHEMA from the test',
        },
      ],
    });
  });
});

describe('gap 2 (ii-b1) — the composer reads the failure’s kind (check 5)', () => {
  const words = {
    error: 'boom',
    error_code: 'MODEL_REQUEST_FAILED' as never,
    error_category: 'SERVICE' as never,
    agent_action: 'report_to_user' as never,
    stop_reason: 'non_retryable' as never,
    attempt: 1,
  };
  const viewOf = (diagnostics: unknown) =>
    composeFailures(
      recordOf(['work'], [entry({ ...words, diagnostics: diagnostics as never })]),
    )[0];
  const base = {
    step: 'work',
    code: 'MODEL_REQUEST_FAILED',
    category: 'SERVICE',
    stop_reason: 'non_retryable',
    agent_action: 'report_to_user',
    attempt: 1,
    message: 'boom',
  };

  it("an entry a model failure's path wrote (executeChain's modelFailure): failure_kind, after agent_action", async () => {
    const def = {
      id: 'fv-g2iib1',
      name: 'g2iib1',
      version: 1,
      steps: { classify: { description: 'Classify.', execution: 'agent', depends_on: [] } },
    } as WorkflowDefinition;
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeChain(store, def, {
      runId: record.id,
      command: 'classify',
      input: {},
      dispatcher: async () => ({}),
      modelFailure: {
        kind: 'transient',
        stop_reason: 'attempts',
        message: 'Anthropic 529: overloaded (fake)',
        attempt: 3,
        error_class: 'api_status',
        status: 529,
      },
    });
    const [view] = composeFailures((await store.get(record.id)).record);
    // (a) red when the composer does not read diagnostics.failure_kind, or places it elsewhere;
    //     (b) prints the view and its key order.
    expect([view, Object.keys(view!)]).toEqual([
      {
        step: 'classify',
        code: 'STEP_RETRY_EXHAUSTED',
        category: 'ENGINE',
        stop_reason: 'attempts',
        agent_action: 'report_to_user',
        failure_kind: 'transient',
        attempt: 3,
        message: 'Anthropic 529: overloaded (fake)',
      },
      [
        'step',
        'code',
        'category',
        'stop_reason',
        'agent_action',
        'failure_kind',
        'attempt',
        'message',
      ],
    ]);
  });

  it('permanent is kept with no unknown; a word outside transient and permanent is kept and named in unknown', () => {
    // (a) red when the closure is removed (`setup` not named), or a known kind is named unknown;
    //     (b) prints the views.
    expect([
      viewOf({ precondition_trace: [], failure_kind: 'permanent' }),
      viewOf({ precondition_trace: [], failure_kind: 'setup' }),
    ]).toEqual([
      { ...base, failure_kind: 'permanent' },
      { ...base, failure_kind: 'setup', unknown: ['failure_kind'] },
    ]);
  });

  it('a kind that is not a string, or diagnostics that are not an object: no failure_kind, no throw', () => {
    // (a) red when a non-string kind is carried, or a malformed diagnostics throws; (b) prints the
    //     views.
    expect([
      viewOf({ precondition_trace: [], failure_kind: 7 }),
      viewOf('not an object'),
      viewOf(null),
      viewOf(undefined),
    ]).toEqual([base, base, base, base]);
  });
});
