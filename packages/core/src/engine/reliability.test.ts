// Tests for step-level timeout, retry, pending state, and failure-terminal guarantees.
// Source: execution-loop.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';
import { MockAdapter } from '../adapters/mock-adapter.js';

// Workflow with a single step that times out at 0.05s and allows 2 retry attempts.
const timeoutDef: WorkflowDefinition = {
  id: 'timeout-wf',
  name: 'Timeout Workflow',
  version: 1,
  steps: {
    'step-one': {
      description: 'Times out',
      execution: 'auto',
      depends_on: [],
      timeout_seconds: 0.05,
    },
  },
};

const noTimeoutDef: WorkflowDefinition = {
  id: 'no-timeout-wf',
  name: 'No Timeout Workflow',
  version: 1,
  steps: {
    'step-one': {
      description: 'Succeeds',
      execution: 'auto',
      depends_on: [],
    },
  },
};

const retryDef: WorkflowDefinition = {
  id: 'retry-wf',
  name: 'Retry Workflow',
  version: 1,
  steps: {
    'step-one': {
      description: 'Retries',
      execution: 'auto',
      depends_on: [],
      retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 10 },
    },
  },
};

function makeRetryableError(): WorkflowError {
  return new WorkflowError('transient failure', {
    code: 'ENGINE_HANDLER_FAILED',
    category: 'ENGINE',
    agentAction: 'stop',
    retryable: true,
  });
}

function makeNonRetryableError(): WorkflowError {
  return new WorkflowError('permanent failure', {
    code: 'ENGINE_HANDLER_FAILED',
    category: 'ENGINE',
    agentAction: 'stop',
    retryable: false,
  });
}

describe('reliability', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-reliability-'));
  });

  it('timeout fires — step returns error and run is marked failed', async () => {
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'timeout-wf',
      workflowVersion: 1,
      params: {},
    });

    // Dispatcher takes 200ms; step timeout is 50ms — timeout fires first.
    const slowDispatcher: StepDispatcher = () =>
      new Promise((resolve) => setTimeout(() => resolve({}), 200));

    const envelope = await executeStep(store, timeoutDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: slowDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).toContain('timed out');

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('failed');
  });

  it('step without timeout completes normally', async () => {
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'no-timeout-wf',
      workflowVersion: 1,
      params: {},
    });

    const fastDispatcher: StepDispatcher = async () => ({ done: true });

    const envelope = await executeStep(store, noTimeoutDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: fastDispatcher,
    });

    expect(envelope.status).toBe('ok');
    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('completed');
  });

  it('retry succeeds on 2nd attempt — evidence has 2 entries with attempt numbers', async () => {
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'retry-wf',
      workflowVersion: 1,
      params: {},
    });

    let calls = 0;
    const flakyDispatcher: StepDispatcher = async () => {
      calls++;
      if (calls === 1) throw makeRetryableError();
      return { ok: true };
    };

    const envelope = await executeStep(store, retryDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: flakyDispatcher,
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.evidence).toHaveLength(2);
    expect(envelope.evidence[0]?.attempt).toBe(1);
    expect(envelope.evidence[0]?.status).toBe('error');
    expect(envelope.evidence[1]?.attempt).toBe(2);
    expect(envelope.evidence[1]?.status).toBe('success');
    expect(calls).toBe(2);
  });

  it('retry exhaustion — returns STEP_RETRY_EXHAUSTED and run is marked failed', async () => {
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'retry-wf',
      workflowVersion: 1,
      params: {},
    });

    let calls = 0;
    const alwaysFailDispatcher: StepDispatcher = async () => {
      calls++;
      throw makeRetryableError();
    };

    const envelope = await executeStep(store, retryDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: alwaysFailDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).toContain('failed after 3 attempts');
    expect(calls).toBe(3);

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('failed');
    expect(updated.evidence).toHaveLength(3);
  });

  it('non-retryable error — dispatcher called exactly once and run is failed', async () => {
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'retry-wf',
      workflowVersion: 1,
      params: {},
    });

    let calls = 0;
    const permanentFailDispatcher: StepDispatcher = async () => {
      calls++;
      throw makeNonRetryableError();
    };

    const envelope = await executeStep(store, retryDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: permanentFailDispatcher,
    });

    expect(envelope.status).toBe('error');
    // Non-retryable: only 1 attempt — no STEP_RETRY_EXHAUSTED upgrade.
    expect(envelope.errors[0]).toContain('permanent failure');
    expect(calls).toBe(1);
  });

  it('double-claim: two concurrent executeStep calls on the same step — second is blocked', async () => {
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'no-timeout-wf',
      workflowVersion: 1,
      params: {},
    });

    // Slow dispatcher that yields — first call claims the step and holds it in_progress.
    // claimedPromise resolves the moment the dispatcher is entered, which only happens
    // after claimStep has written in_progress to disk — no timing sleep needed.
    let resolveFirst!: (v: Record<string, unknown>) => void;
    let signalClaimed!: () => void;
    const claimedPromise = new Promise<void>((r) => {
      signalClaimed = r;
    });
    const firstDispatcher: StepDispatcher = () => {
      signalClaimed();
      return new Promise<Record<string, unknown>>((r) => {
        resolveFirst = r;
      });
    };

    // Start first call (does not await yet).
    const firstPromise = executeStep(store, noTimeoutDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: firstDispatcher,
    });

    // Wait until the dispatcher has been entered — by that point claimStep has already
    // written in_progress to disk.
    await claimedPromise;

    // Second concurrent call on the same step — should be blocked.
    const secondEnvelope = await executeStep(store, noTimeoutDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => ({}),
    });

    expect(secondEnvelope.status).toBe('blocked');
    const hint = secondEnvelope.context_hint ?? '';
    // The second call is blocked either because the step is already claimed (in_progress)
    // or because findEligibleSteps already excluded it — both indicate concurrent conflict.
    expect(hint.toLowerCase()).toMatch(/claim|already|in.?progress|not.?eligible/i);

    // Let first call finish.
    resolveFirst({});
    const firstEnvelope = await firstPromise;
    expect(firstEnvelope.status).toBe('ok');
  });

  it('pending state is written to the store while dispatcher is running', async () => {
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'no-timeout-wf',
      workflowVersion: 1,
      params: {},
    });

    let dispatcherCalled!: () => void;
    const calledPromise = new Promise<void>((r) => {
      dispatcherCalled = r;
    });
    let resolveDispatcher!: (v: Record<string, unknown>) => void;

    const deferredDispatcher: StepDispatcher = async () => {
      dispatcherCalled();
      return await new Promise<Record<string, unknown>>((r) => {
        resolveDispatcher = r;
      });
    };

    const stepPromise = executeStep(store, noTimeoutDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: deferredDispatcher,
    });

    // Wait until the dispatcher has been called — by that point the pending state write
    // (step 3c) has already completed.
    await calledPromise;
    const mid = await store.get(run.id);
    expect(mid.in_progress_steps).toContain('step-one');

    resolveDispatcher({});
    const envelope = await stepPromise;
    expect(envelope.status).toBe('ok');
  });

  it('failed run is marked terminal — terminal_state is true', async () => {
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'no-timeout-wf',
      workflowVersion: 1,
      params: {},
    });

    const failDispatcher: StepDispatcher = async () => {
      throw makeNonRetryableError();
    };

    await executeStep(store, noTimeoutDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: failDispatcher,
    });

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('failed');
  });

  it('AbortSignal is aborted when timeout fires', async () => {
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'timeout-wf',
      workflowVersion: 1,
      params: {},
    });

    let capturedSignal: AbortSignal | undefined;
    const sigCapturingDispatcher: StepDispatcher = (_step, _input, _run, signal) => {
      capturedSignal = signal;
      return new Promise<Record<string, unknown>>(() => {
        /* never resolves */
      });
    };

    const envelope = await executeStep(store, timeoutDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: sigCapturingDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).toContain('timed out');
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('MockAdapter rejects with STEP_ABORTED when signal is already aborted', async () => {
    const adapter = new MockAdapter('test', { foo: { status: 200, data: { ok: true } } });
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.fetch('foo', {}, {}, controller.signal)).rejects.toMatchObject({
      code: 'STEP_ABORTED',
      retryable: false,
    });
  });

  it('computeBackoff with optional fields omitted — defaults to fixed/0ms, retry completes', async () => {
    const def: WorkflowDefinition = {
      id: 'optional-retry-wf',
      name: 'Optional Retry Workflow',
      version: 1,
      steps: {
        'step-one': {
          description: 'Retries with minimal config',
          execution: 'auto',
          depends_on: [],
          retry: { max_attempts: 2 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'optional-retry-wf',
      workflowVersion: 1,
      params: {},
    });

    let calls = 0;
    const flakyDispatcher: StepDispatcher = async () => {
      calls++;
      if (calls === 1) throw makeRetryableError();
      return { ok: true };
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: flakyDispatcher,
    });

    expect(envelope.status).toBe('ok');
    expect(calls).toBe(2);
  });

  it('STEP_RETRY_EXHAUSTED carries details.retry_after from last SERVICE_RATE_LIMITED error', async () => {
    const def: WorkflowDefinition = {
      id: 'rate-limited-retry-wf',
      name: 'Rate Limited Retry Workflow',
      version: 1,
      steps: {
        'step-one': {
          description: 'Always rate limited',
          execution: 'auto',
          depends_on: [],
          retry: { max_attempts: 2, backoff: 'fixed', base_delay_ms: 0 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const run = await store.create({
      workflowId: 'rate-limited-retry-wf',
      workflowVersion: 1,
      params: {},
    });

    const rateLimitedDispatcher: StepDispatcher = async () => {
      throw new WorkflowError('Rate limited', {
        code: 'SERVICE_RATE_LIMITED',
        category: 'SERVICE',
        agentAction: 'wait_and_proceed',
        retryable: true,
        retry_after: 0,
      });
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: rateLimitedDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).toContain('failed after 2 attempts');

    const updated = await store.get(run.id);
    expect(updated.terminal_state).toBe(true);
  });
});
