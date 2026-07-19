// Tests for step-level timeout, retry, pending state, and failure-terminal guarantees.
// Source: execution-loop.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStep } from './execution-loop.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';
import { MockAdapter } from '../adapters/mock-adapter.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { ServiceAdapter, ServiceResponse } from '../extensions/service-adapter.js';
import { DEFAULT_EXECUTION_TIMEOUT_SECONDS } from './claim-liveness.js';
import { loadWorkflowFromString } from '../workflow/yaml-loader.js';

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

// Issue A3, load-bearing regression (Design Reviewer's blocking-fix): an auto step in a
// FINALIZER-BEARING workflow must still be bounded by its timeout_seconds. Enforcement
// (shouldEnforceTimeout) is deliberately NOT conjoined with `!hasFinalizers` — that conjunct is
// correct only for the claim-liveness DETECTION horizon (computeClaimDeadline), never for
// enforcement. Under a wrong `execution === 'auto' && !hasFinalizers` predicate, this step would
// never be wrapped in withTimeout and would hang forever.
const timeoutInFinalizerWorkflowDef: WorkflowDefinition = {
  id: 'timeout-finalizer-wf',
  name: 'Timeout In Finalizer Workflow',
  version: 1,
  steps: {
    'step-one': {
      description: 'Times out',
      execution: 'auto',
      depends_on: [],
      timeout_seconds: 0.05,
    },
    cleanup: {
      description: 'Cleanup finalizer',
      execution: 'finalizer',
      on_outcome: 'always',
      handler: 'do_cleanup',
    },
  },
};

// Issue A3: an auto step with an explicit, generous timeout_seconds that never fires — used to
// confirm the DECLARED value (not the default) is the one surfaced onto the evidence snapshot.
const explicitTimeoutDef: WorkflowDefinition = {
  id: 'explicit-timeout-wf',
  name: 'Explicit Timeout Workflow',
  version: 1,
  steps: {
    'step-one': {
      description: 'Succeeds well within its declared timeout',
      execution: 'auto',
      depends_on: [],
      timeout_seconds: 5,
    },
  },
};

// Issue A3: a step declaring BOTH timeout_seconds and retry — a timeout must consume no retry
// attempt and fail the step terminally (STEP_TIMEOUT stays retryable: false).
const timeoutWithRetryDef: WorkflowDefinition = {
  id: 'timeout-retry-wf',
  name: 'Timeout With Retry Workflow',
  version: 1,
  steps: {
    'step-one': {
      description: 'Times out, has retry',
      execution: 'auto',
      depends_on: [],
      timeout_seconds: 0.05,
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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

  it('LOAD-BEARING (A3 blocking-fix): auto step in a finalizer-bearing workflow still times out', async () => {
    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'timeout-finalizer-wf',
      workflowVersion: 1,
      params: {},
    });

    // Dispatcher takes 200ms; step timeout is 50ms — timeout fires first, exactly as the
    // finalizer-free `timeoutDef` test above. A wrong `execution === 'auto' && !hasFinalizers`
    // predicate would have left this step's timeoutMs undefined (never wrapped in withTimeout),
    // so the dispatcher would have been awaited directly and this test would hang/time out at the
    // suite level instead of asserting a clean STEP_TIMEOUT.
    const slowDispatcher: StepDispatcher = () =>
      new Promise((resolve) => setTimeout(() => resolve({}), 200));

    const envelope = await executeStep(store, timeoutInFinalizerWorkflowDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: slowDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).toContain('timed out');

    const updated = await store.get(run.id);
    // Non-terminal: the finalizer-bearing run is not yet sealed at the domain-step failure alone
    // (see finalizer.test.ts for the drain itself) — the point here is solely that the TIMEOUT fired.
    expect(updated.failed_steps).toContain('step-one');
  });

  it('a timeout on a step WITH a retry: block still fails terminally — consumes no retry attempt', async () => {
    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'timeout-retry-wf',
      workflowVersion: 1,
      params: {},
    });

    let calls = 0;
    const slowDispatcher: StepDispatcher = () => {
      calls++;
      return new Promise((resolve) => setTimeout(() => resolve({}), 200));
    };

    const envelope = await executeStep(store, timeoutWithRetryDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: slowDispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).toContain('timed out');
    expect(envelope.errors[0]).not.toContain('failed after'); // not wrapped as STEP_RETRY_EXHAUSTED
    expect(calls).toBe(1); // a timeout consumes no retry attempt — never called a 2nd time

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('failed');
    expect(updated.terminal_state).toBe(true);
  });

  it('issue A3: evidence surfaces effective_timeout_seconds — the default when undeclared', async () => {
    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
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
    expect(envelope.evidence[0]?.effective_timeout_seconds).toBe(DEFAULT_EXECUTION_TIMEOUT_SECONDS);
  });

  it('issue A3: evidence surfaces effective_timeout_seconds — the declared value when present', async () => {
    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'explicit-timeout-wf',
      workflowVersion: 1,
      params: {},
    });

    const fastDispatcher: StepDispatcher = async () => ({ done: true });

    const envelope = await executeStep(store, explicitTimeoutDef, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: fastDispatcher,
    });

    expect(envelope.status).toBe('ok');
    expect(envelope.evidence[0]?.effective_timeout_seconds).toBe(5);
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
    const { run: run } = await store.create({
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
    const { run: run } = await store.create({
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

  it('proactive acquire → SERVICE_RATE_LIMITED → pause → resume → retry succeeds', async () => {
    // Full integration: verifies that the token bucket is paused when the adapter returns
    // SERVICE_RATE_LIMITED with no retry_after (exercising the fallback_retry_seconds path),
    // and that the second attempt succeeds once the bucket resumes.
    // Uses real timers with a 50ms pause to avoid fake-timer + real-I/O interleaving issues.
    let callCount = 0;
    const faultyAdapter: ServiceAdapter = {
      id: 'faulty',
      async fetch(
        _op: string,
        _params: Record<string, unknown>,
        _config: Record<string, unknown>,
      ): Promise<ServiceResponse> {
        callCount++;
        if (callCount === 1) {
          // No retry_after — exercises the fallback_retry_seconds path.
          throw new WorkflowError('Rate limited', {
            code: 'SERVICE_RATE_LIMITED',
            category: 'SERVICE',
            agentAction: 'wait_and_proceed',
            retryable: true,
          });
        }
        return { status: 200, data: { ok: true } };
      },
      async create(): Promise<ServiceResponse> {
        return { status: 200, data: {} };
      },
      async update(): Promise<ServiceResponse> {
        return { status: 200, data: {} };
      },
    };

    const registry = new ExtensionRegistry();
    registry.register('adapter', 'faulty', faultyAdapter);

    const def: WorkflowDefinition = {
      id: 'rate-limit-integration-wf',
      name: 'Rate Limit Integration Workflow',
      version: 1,
      services: {
        'test-service': {
          adapter: 'faulty',
          trust: 'engine_delivered',
          rate_limit: {
            requests_per_second: 1000, // 1ms refill interval — effectively immediate
            burst: 1,
            fallback_retry_seconds: 0.05, // 50ms pause on 429
          },
        },
      },
      steps: {
        'step-one': {
          description: 'Uses a rate-limited service',
          execution: 'auto',
          depends_on: [],
          uses_service: 'test-service',
          // base_delay_ms omitted — retry waits max(0ms backoff, 50ms retry_after) = 50ms.
          retry: { max_attempts: 2 },
        },
      },
    };

    const store = new JsonFileStore(dir);
    const { run: run } = await store.create({
      workflowId: 'rate-limit-integration-wf',
      workflowVersion: 1,
      params: {},
    });

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher: async () => {
        throw new Error('dispatcher should not be called for uses_service steps');
      },
      registry,
    });

    expect(envelope.status).toBe('ok');
    expect(callCount).toBe(2);
  }, 5000);
});

// Issue #140 — declaration-gated in-place timeout-retry with a clipping total-time cap.
// A dispatcher that never resolves — used wherever a test needs withTimeout's OWN timer to be
// the thing that fires (never the dispatcher racing it), so tests are driven by wall-clock design
// numbers, not incidental promise-resolution timing.
const hang: StepDispatcher = () => new Promise<Record<string, unknown>>(() => undefined);

function makeRateLimitedError(retryAfterSeconds: number): WorkflowError {
  return new WorkflowError('Rate limited', {
    code: 'SERVICE_RATE_LIMITED',
    category: 'SERVICE',
    agentAction: 'wait_and_proceed',
    retryable: true,
    retry_after: retryAfterSeconds,
  });
}

describe('issue #140 — retryable timeout + total-time cap', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-cap-140-'));
  });

  it('two-laws OPTED: on_timeout retry consumes a normal (shared) retry attempt — timeout, timeout, then success', async () => {
    // timeout_seconds:0.05 (50ms), retry max_attempts:3/fixed/base_delay_ms:10 — same numbers as
    // the pre-existing unopted-law fixture (timeoutWithRetryDef) — default cap = 3*0.05+2*0.01 =
    // 0.17s (170ms). Unlike that fixture, on_timeout+idempotent are both declared here.
    const def: WorkflowDefinition = {
      id: 'opted-consumes-shared-attempt-wf',
      name: 'Opted Consumes Shared Attempt',
      version: 1,
      steps: {
        'step-one': {
          description: 'Times out twice, then succeeds',
          execution: 'auto',
          depends_on: [],
          timeout_seconds: 0.05,
          idempotent: true,
          retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 10, on_timeout: true },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      if (calls < 3) return new Promise<Record<string, unknown>>(() => undefined); // hang → timeout
      return Promise.resolve({ ok: true });
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(envelope.status).toBe('ok');
    expect(calls).toBe(3);
    expect(envelope.evidence).toHaveLength(3);
    expect(envelope.evidence[0]?.attempt).toBe(1);
    expect(envelope.evidence[0]?.status).toBe('error');
    expect(envelope.evidence[0]?.error).toContain('timed out');
    expect(envelope.evidence[1]?.attempt).toBe(2);
    expect(envelope.evidence[1]?.status).toBe('error');
    expect(envelope.evidence[2]?.attempt).toBe(3);
    expect(envelope.evidence[2]?.status).toBe('success');
  }, 3000);

  it('two-laws UNOPTED deterministic companion pin (base_delay_ms:100 — ~300ms slack, cannot flake): timeout on a retry-configured-but-unopted step still fails terminally after 1 attempt', async () => {
    // Same shape as reliability.test.ts's pre-existing ":457" law (timeoutWithRetryDef) but with
    // base_delay_ms:100 instead of 10 — default cap = 3*0.05+2*0.1 = 0.35s (350ms), so after the
    // single 50ms timeout the remaining budget is ~300ms (vs. ~120ms for the original fixture) —
    // a witness for the SAME law that cannot flake under CI jitter. A flake here is triaged as
    // timing, never "fixed" by weakening the law itself.
    const def: WorkflowDefinition = {
      id: 'unopted-law-deterministic-wf',
      name: 'Unopted Law Deterministic Companion',
      version: 1,
      steps: {
        'step-one': {
          description: 'Times out, has retry, no on_timeout',
          execution: 'auto',
          depends_on: [],
          timeout_seconds: 0.05,
          retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 100 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      return new Promise((resolve) => setTimeout(() => resolve({}), 200));
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).toContain('timed out');
    expect(envelope.errors[0]).not.toContain('failed after'); // not wrapped as STEP_RETRY_EXHAUSTED
    expect(calls).toBe(1); // a timeout consumes no retry attempt — never called a 2nd time

    const updated = await store.get(run.id);
    expect(updated.run_phase).toBe('failed');
    expect(updated.terminal_state).toBe(true);
  });

  it('third law: idempotent + a default cap alone (NO on_timeout) does NOT enable timeout-retry — terminal after 1 attempt', async () => {
    const def: WorkflowDefinition = {
      id: 'third-law-wf',
      name: 'Third Law — idempotent without on_timeout',
      version: 1,
      steps: {
        'step-one': {
          description: 'Times out; idempotent true but on_timeout absent',
          execution: 'auto',
          depends_on: [],
          timeout_seconds: 0.05,
          idempotent: true,
          retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 10 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      return hang('step-one', {}, run);
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).toContain('timed out');
    expect(envelope.errors[0]).not.toContain('failed after');
    expect(calls).toBe(1);
  });

  it('flagship cap exhaustion (0.2s timeout / 5 max_attempts / 0.3s total_timeout_seconds) ⇒ exhausted_by total_timeout via structured error_details, within 2-3 attempts', async () => {
    // NOTE on the 2-3 tolerance: attempt 2's own clip consumes EXACTLY the remaining budget by
    // construction (effectiveMs === remainingMs() at that instant) — real-timer measurement of
    // "was the cap exhausted after that attempt" can therefore land within ~1ms of Date.now()'s
    // own millisecond-floor granularity on EITHER side. When it reads a hair early (capExhausted
    // still false), on_timeout+idempotent let the loop self-correct with ONE more near-zero-budget
    // attempt (well within max_attempts:5) before robustly detecting exhaustion — never a
    // functional defect, just a real-timer test needing this tolerance (cf. the codebase's
    // existing precedent of widening rather than chasing sub-ms determinism, e.g. #172/#177).
    const def: WorkflowDefinition = {
      id: 'flagship-cap-exhaustion-wf',
      name: 'Flagship Cap Exhaustion',
      version: 1,
      steps: {
        'step-one': {
          description: 'Always times out; the cap runs out before attempts do',
          execution: 'auto',
          depends_on: [],
          timeout_seconds: 0.2,
          idempotent: true,
          retry: { max_attempts: 5, on_timeout: true, total_timeout_seconds: 0.3 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      return new Promise<Record<string, unknown>>(() => undefined);
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(3);
    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).toContain(`failed after ${calls} attempts`);
    expect(envelope.error_code).toBe('STEP_RETRY_EXHAUSTED');
    expect(envelope.error_details?.['exhausted_by']).toBe('total_timeout');
    const lastEvidence = envelope.evidence[envelope.evidence.length - 1];
    expect(lastEvidence?.clipped_to_ms).toBeDefined();
    expect(lastEvidence?.clipped_to_ms).toBeLessThan(200);
    expect(lastEvidence?.exhausted_by).toBe('total_timeout');
  }, 3000);

  it('cap smaller than the first attempt (OPTED): wraps within 1-2 attempts, exhausted_by total_timeout', async () => {
    // Same real-timer tolerance rationale as the flagship test above: attempt 1's clip consumes
    // EXACTLY the (tiny) cap by construction, so detection can occasionally need one more
    // near-zero-budget self-correcting attempt (on_timeout+idempotent make that safe) — well
    // within max_attempts:3.
    const def: WorkflowDefinition = {
      id: 'cap-below-first-attempt-opted-wf',
      name: 'Cap Below First Attempt — Opted',
      version: 1,
      steps: {
        'step-one': {
          description: 'Declared timeout is 1s but the cap is only 100ms',
          execution: 'auto',
          depends_on: [],
          timeout_seconds: 1,
          idempotent: true,
          retry: { max_attempts: 3, on_timeout: true, total_timeout_seconds: 0.1 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      return new Promise<Record<string, unknown>>(() => undefined);
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(2);
    expect(envelope.errors[0]).toContain(`failed after ${calls} attempts`);
    expect(envelope.error_details?.['exhausted_by']).toBe('total_timeout');
    // Every attempt was itself clipped well below the declared 1000ms timeout.
    const lastEvidence = envelope.evidence[envelope.evidence.length - 1];
    expect(lastEvidence?.clipped_to_ms).toBeLessThan(1000);
  });

  it('unopted-capped clip-abort: an UNOPTED step (no on_timeout at all) still wraps via the cap alone, attemptsUsed < maxAttempts', async () => {
    // Proves the wrap is driven by capExhausted alone, uniformly — never conditioned on
    // on_timeout. Deliberately routed through SITE (C) (a normal RETRYABLE error whose backoff
    // wait would blow the cap) rather than a clipped-attempt's own natural end: willRetry's
    // mint-side condition doesn't need on_timeout at all, and `elapsed + waitMs >= capMs` is
    // robust against real-timer jitter by construction here (waitMs=200ms vastly exceeds the
    // 50ms cap — no knife-edge, unlike a clipped attempt's own exact-fit end).
    const def: WorkflowDefinition = {
      id: 'cap-below-first-attempt-unopted-wf',
      name: 'Cap Below First Attempt — Unopted',
      version: 1,
      steps: {
        'step-one': {
          description: 'No on_timeout; a normal retryable error whose backoff would blow the cap',
          execution: 'auto',
          depends_on: [],
          retry: {
            max_attempts: 3,
            backoff: 'fixed',
            base_delay_ms: 200,
            total_timeout_seconds: 0.05,
          },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = async () => {
      calls++;
      throw makeRetryableError();
    };

    const startedAt = Date.now();
    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(calls).toBe(1);
    expect(envelope.errors[0]).toContain('failed after 1 attempts');
    expect(envelope.error_details?.['exhausted_by']).toBe('total_timeout');
    expect(elapsedMs).toBeLessThan(500); // the 200ms backoff was never actually slept
  });

  // S1 correction (restores the record §2 "uniform wrap (unopted-capped clip-abort included)"
  // property's witness — the review verified a wrap-gate mutant exempting unopted STEP_TIMEOUT
  // survives the ENTIRE suite without this test, since the sibling test above was redesigned to
  // route through site (c) instead). HAND-BUILT unopted def, total_timeout_seconds: 0 — robustly
  // (no knife-edge) already-exhausted from the start: remaining = 0 − elapsed is <= 0 for ANY
  // elapsed. Attempt 1 clips to effectiveMs = 0 ⇒ instant STEP_TIMEOUT ⇒ site (b) sets
  // capExhausted ⇒ wraps, uniformly, with NO on_timeout and NO idempotent declared at all.
  it('S1 — unopted clipped-STEP_TIMEOUT wrap witness: a hand-built unopted def with total_timeout_seconds:0 clips attempt 1 to effectiveMs=0 and wraps uniformly', async () => {
    const def: WorkflowDefinition = {
      id: 'unopted-clip-wrap-witness-wf',
      name: 'Unopted Clip Wrap Witness',
      version: 1,
      steps: {
        'step-one': {
          description: 'No on_timeout, no idempotent — cap already exhausted from the start',
          execution: 'auto',
          depends_on: [],
          timeout_seconds: 1,
          retry: { max_attempts: 3, total_timeout_seconds: 0 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      return new Promise<Record<string, unknown>>(() => undefined); // slow/hanging — the clipped 0ms timer wins
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(calls).toBe(1);
    // Structured assertions only — no message-parsing beyond the wrap phrase itself.
    expect(envelope.errors[0]).toContain('failed after 1 attempts');
    expect(envelope.error_code).toBe('STEP_RETRY_EXHAUSTED');
    // The wrap stores the inner error's MESSAGE, not a code — there is no last_error_code field.
    expect(envelope.error_details?.['lastError']).toContain('timed out');
    expect(envelope.error_details?.['exhausted_by']).toBe('total_timeout');
    const lastEvidence = envelope.evidence[envelope.evidence.length - 1];
    expect(lastEvidence?.effective_timeout_seconds).toBe(0);
    expect(lastEvidence?.clipped_to_ms).toBe(0);
  });

  // The test above cannot discriminate the clip floor (max(0, remainingMs())): the capStart→clip
  // stretch is synchronous, so remainingMs() reads ~0 with or without the floor either way. This
  // dedicated pin mocks Date.now so capStart reads T0 and the attempt-1 clip computation reads
  // T0+10ms (simulating 10ms of clock drift/GC-pause between the two) — WITH the floor,
  // effectiveMs clips to 0 (max(0, -10) = 0); WITHOUT it (probe: `max(0, remainingMs())` →
  // `remainingMs()`), effectiveMs would read -10ms ⇒ effective_timeout_seconds === -0.01 ⇒ RED.
  // Date-mocking leaves the real setTimeout the fixture needs untouched (only Date.now is spied).
  //
  // The mock is keyed on the CALLER's stack, not raw call order: JsonFileStore.claimStep acquires
  // a proper-lockfile lock BEFORE execution-loop.ts's own Date.now() calls even begin (that
  // library calls Date.now() internally for its own mtime-precision probing), so a naive
  // call-order queue (mockReturnValueOnce ×2) silently intercepts THOSE calls instead of
  // capStart/effectiveMs — discovered live while writing this pin. Filtering on
  // `stack.includes('execution-loop.ts')` targets exactly the two calls this pin cares about
  // (capStart, then the attempt-1 effectiveMs computation) regardless of how many lock-internal
  // calls precede or follow them.
  it('S1 floor pin: the clip floor prevents a negative effective_timeout_seconds under a simulated clock-drift window between capStart and attempt 1', async () => {
    const def: WorkflowDefinition = {
      id: 'clip-floor-pin-wf',
      name: 'Clip Floor Pin',
      version: 1,
      steps: {
        'step-one': {
          description: 'Cap=0; Date.now mocked to simulate a 10ms drift before attempt 1 clips',
          execution: 'auto',
          depends_on: [],
          timeout_seconds: 1,
          retry: { max_attempts: 3, total_timeout_seconds: 0 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    const realNow = Date.now.bind(Date);
    let executionLoopCallCount = 0;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      const isFromExecutionLoop = (new Error().stack ?? '').includes('execution-loop.ts');
      if (!isFromExecutionLoop) return realNow(); // proper-lockfile's own internal calls, untouched
      executionLoopCallCount++;
      if (executionLoopCallCount === 1) return 1_000_000; // capStart reads T0
      if (executionLoopCallCount === 2) return 1_000_010; // attempt-1's effectiveMs reads T0+10ms
      return realNow(); // site (b) and beyond — real epoch dwarfs T0, capExhausted still ends up true
    });

    try {
      let calls = 0;
      const dispatcher: StepDispatcher = () => {
        calls++;
        return new Promise<Record<string, unknown>>(() => undefined);
      };

      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'step-one',
        input: {},
        dispatcher,
      });

      expect(calls).toBe(1);
      expect(envelope.evidence[0]?.effective_timeout_seconds).toBe(0);
      // Rename-defang guard (correction 2): the `stack.includes('execution-loop.ts')` filter
      // above silently stops discriminating anything if that file is ever renamed or split — every
      // call would then fall through to realNow(), the mock would never fire, and this pin would
      // stay green while proving nothing. Asserting the counter directly makes that failure mode
      // loud: if the filter stops matching, executionLoopCallCount stays at 0, red here.
      expect(executionLoopCallCount).toBeGreaterThanOrEqual(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('sleep-guard-surfaces-429: a huge retry_after is never actually slept — the cap breaks BEFORE the sleep, bounding elapsed wall-clock time', async () => {
    const def: WorkflowDefinition = {
      id: 'sleep-guard-429-wf',
      name: 'Sleep Guard Surfaces 429',
      version: 1,
      steps: {
        'step-one': {
          description: 'Always rate-limited with a 10s retry_after; cap is 100ms',
          execution: 'auto',
          depends_on: [],
          retry: { max_attempts: 3, base_delay_ms: 0, total_timeout_seconds: 0.1 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      return Promise.reject(makeRateLimitedError(10)); // 10 REAL seconds if ever actually slept
    };

    const startedAt = Date.now();
    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(calls).toBe(1);
    expect(envelope.errors[0]).toContain('failed after 1 attempts');
    // The wrap's top-level message is "failed after N attempts"; the original 429 text surfaces
    // in the structured details, not the message — the discriminator-observable design point.
    expect(envelope.error_details?.['lastError']).toMatch(/rate limited/i);
    expect(envelope.error_details?.['exhausted_by']).toBe('total_timeout');
    expect(envelope.error_details?.['retry_after']).toBe(10);
    // The load-bearing assertion: this test completed in well under 1 second, proving the 10s
    // retry_after sleep never actually happened (site (c) broke BEFORE delayMs was awaited).
    expect(elapsedMs).toBeLessThan(2000);
  }, 3000);

  it('both-true tie: attemptsUsed===maxAttempts AND capExhausted both true — exhausted_by reports total_timeout, not attempts', async () => {
    // Deterministic-by-construction (no real-timer knife-edge): max_attempts:1 makes
    // attemptsUsed===maxAttempts true TRIVIALLY on the very first attempt, and
    // total_timeout_seconds:0 makes capExhausted true UNCONDITIONALLY at site (b)
    // (remainingMs() = 0 - elapsed <= 0 for ANY non-negative elapsed, no timing sensitivity at
    // all) — both disjuncts of the wrap gate are GENUINELY, robustly true simultaneously.
    const def: WorkflowDefinition = {
      id: 'both-true-tie-wf',
      name: 'Both-True Tie',
      version: 1,
      steps: {
        'step-one': {
          description:
            'max_attempts:1 (trivially attemptsUsed===max) + total_timeout_seconds:0 (trivially capExhausted)',
          execution: 'auto',
          depends_on: [],
          timeout_seconds: 1,
          retry: { max_attempts: 1, total_timeout_seconds: 0 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = async () => {
      calls++;
      throw makeRetryableError(); // retryable, but attemptNum(1) < maxAttempts(1) is already false
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(calls).toBe(1); // attemptsUsed === maxAttempts, trivially
    expect(envelope.errors[0]).toContain('failed after 1 attempts');
    // Both disjuncts of the wrap gate are true here (attemptsUsed===maxAttempts AND capExhausted)
    // — exhausted_by must report the cap, not attempts, per the tie-break rule.
    expect(envelope.error_details?.['exhausted_by']).toBe('total_timeout');
  });

  it('unopted default-cap: a 429 retry_after exceeding the DECLARED worst-case schedule breaks at the sleep guard and wraps (no on_timeout, no explicit cap)', async () => {
    // No retry.total_timeout_seconds declared — the AMENDED default cap (worstCaseScheduleSeconds)
    // applies: 3*0.05 + 2*0.01 = 0.17s (170ms). A 5-second retry_after materially exceeds it.
    const def: WorkflowDefinition = {
      id: 'unopted-default-cap-429-wf',
      name: 'Unopted Default Cap — 429 Excess',
      version: 1,
      steps: {
        'step-one': {
          description: 'Always rate-limited with a retry_after exceeding the default cap',
          execution: 'auto',
          depends_on: [],
          timeout_seconds: 0.05,
          retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: 10 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      return Promise.reject(makeRateLimitedError(5));
    };

    const startedAt = Date.now();
    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(calls).toBe(1);
    expect(envelope.errors[0]).toContain('failed after 1 attempts');
    // The wrap's top-level message is "failed after N attempts"; the original 429 text surfaces
    // in the structured details, not the message — the discriminator-observable design point.
    expect(envelope.error_details?.['lastError']).toMatch(/rate limited/i);
    expect(envelope.error_details?.['exhausted_by']).toBe('total_timeout');
    expect(elapsedMs).toBeLessThan(2000); // never actually slept the 5s retry_after
  }, 3000);

  it('programmatic gate law + advisory co-occurrence: on_timeout without idempotent never retries, and the envelope carries the advisory warning', async () => {
    // Hand-built definition (bypasses the loader's E1 hard-error) — proves the ENGINE independently
    // re-checks the same conjunct at dispatch time (#119-preserving: advisory only, never gates —
    // the step still never retries either way).
    const def: WorkflowDefinition = {
      id: 'programmatic-gate-wf',
      name: 'Programmatic Gate',
      version: 1,
      steps: {
        'step-one': {
          description: 'on_timeout true but idempotent is NOT declared',
          execution: 'auto',
          depends_on: [],
          timeout_seconds: 0.05,
          retry: { max_attempts: 2, on_timeout: true },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      return new Promise<Record<string, unknown>>(() => undefined);
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(calls).toBe(1); // never retried — the law
    expect(envelope.errors[0]).toContain('timed out');
    expect(envelope.errors[0]).not.toContain('failed after');
    expect(envelope.warnings.some((w) => w.includes('on_timeout ignored'))).toBe(true);
  });

  it('capMs-conjunct pin (non-auto cap-inertness): a hand-built NON-AUTO step with on_timeout+idempotent BOTH true never retries, because capMs is undefined off the enforced auto class', async () => {
    // execution: 'agent' — shouldEnforceTimeout is false, so enforceTimeout/timeoutMs/capMs are
    // ALL undefined regardless of on_timeout/idempotent. The dispatcher throws a SYNTHETIC
    // STEP_TIMEOUT (agent dispatch is never wrapped in withTimeout, so this is the only way to
    // exercise the code path with that discriminator on a non-auto step). If the willRetry
    // disjunct's `capMs !== undefined` conjunct were ever deleted, this would incorrectly retry.
    const def: WorkflowDefinition = {
      id: 'capms-conjunct-wf',
      name: 'CapMs Conjunct Pin',
      version: 1,
      steps: {
        'step-one': {
          description: 'Non-auto step, hand-built with on_timeout + idempotent both true',
          execution: 'agent',
          depends_on: [],
          idempotent: true,
          retry: { max_attempts: 3, on_timeout: true },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = async () => {
      calls++;
      throw new WorkflowError('synthetic timeout', {
        code: 'STEP_TIMEOUT',
        category: 'ENGINE',
        agentAction: 'report_to_user',
        retryable: false,
      });
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(calls).toBe(1);
    expect(envelope.status).toBe('error');
    expect(envelope.errors[0]).not.toContain('failed after');
  });

  it('boundary: the sleep guard fires at (>=) an exact-fit wait, never sleeping into the wall', async () => {
    // total_timeout_seconds:0.1 (100ms), base_delay_ms:100 (fixed) — the computed backoff wait
    // (100ms) alone comes close to the cap (100ms). CORRECTION (review N1): with REAL timers,
    // elapsed since capStart is never exactly 0ms by the time this check runs — the claim,
    // dispatch, and evidence-capture machinery in between always cost at least ~1ms — so
    // `elapsed + waitMs` typically reads >= 101, which a strict `>` ALSO satisfies. This test
    // therefore does NOT discriminate `>=` from `>` at the boundary (it only proves the guard
    // fires SOMEWHERE near the cap); the actual `>=`-vs-`>` boundary is discriminated by
    // `sleepWouldExceedCap`'s own unit pins (claim-liveness.test.ts) plus the source-text call
    // pin (claim-liveness.test.ts) that proves site (c) actually calls that helper rather than an
    // inline, divergent predicate.
    const def: WorkflowDefinition = {
      id: 'boundary-sleep-guard-wf',
      name: 'Boundary Sleep Guard',
      version: 1,
      steps: {
        'step-one': {
          description: 'An exact-fit backoff wait against the cap',
          execution: 'auto',
          depends_on: [],
          retry: {
            max_attempts: 2,
            backoff: 'fixed',
            base_delay_ms: 100,
            total_timeout_seconds: 0.1,
          },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      return Promise.reject(makeRetryableError());
    };

    const startedAt = Date.now();
    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(calls).toBe(1); // the 2nd attempt never happened — the sleep guard broke first
    expect(envelope.errors[0]).toContain('failed after 1 attempts');
    expect(envelope.error_details?.['exhausted_by']).toBe('total_timeout');
    expect(elapsedMs).toBeLessThan(500); // proves the 100ms backoff was never actually slept
  });

  it("boundary: attempt 1 always proceeds even when the cap is ALREADY exhausted at capStart (site (a)'s attemptNum>1 guard)", async () => {
    // total_timeout_seconds:0 — resolveCapMs must treat 0 as a PRESENT cap (`!== undefined`, never
    // truthiness), so capMs=0 and the step is "already exhausted" before the loop even starts.
    // Site (a)'s `attemptNum > 1` conjunct means attempt 1 dispatches anyway.
    const def: WorkflowDefinition = {
      id: 'attempt-1-always-proceeds-wf',
      name: 'Attempt 1 Always Proceeds',
      version: 1,
      steps: {
        'step-one': {
          description: 'A hand-built zero cap — E2 forbids 0 in authored YAML',
          execution: 'auto',
          depends_on: [],
          retry: { max_attempts: 3, total_timeout_seconds: 0 },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = async () => {
      calls++;
      return { ok: true };
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    // Attempt 1 dispatched (and succeeded) despite the cap being 0 from the very start.
    expect(calls).toBe(1);
    expect(envelope.status).toBe('ok');
  });

  it('delayMs is never called for the FINAL (max_attempts-th) failed attempt — no trailing sleep', async () => {
    const SPY_DELAY_MS = 55; // a value distinctive enough not to collide with any other timer
    const def: WorkflowDefinition = {
      id: 'no-trailing-sleep-wf',
      name: 'No Trailing Sleep',
      version: 1,
      steps: {
        'step-one': {
          description: 'Always fails retryably; 2 backoff sleeps expected, never a 3rd',
          execution: 'auto',
          depends_on: [],
          retry: { max_attempts: 3, backoff: 'fixed', base_delay_ms: SPY_DELAY_MS },
        },
      },
    };
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      let calls = 0;
      const dispatcher: StepDispatcher = async () => {
        calls++;
        throw makeRetryableError();
      };

      const envelope = await executeStep(store, def, {
        runId: run.id,
        command: 'step-one',
        input: {},
        dispatcher,
      });

      expect(calls).toBe(3);
      expect(envelope.errors[0]).toContain('failed after 3 attempts');
      const backoffCalls = setTimeoutSpy.mock.calls.filter((c) => c[1] === SPY_DELAY_MS);
      expect(backoffCalls).toHaveLength(2); // between 1→2 and 2→3 — never a 3rd, trailing sleep
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('B1 engine pin: a YAML-LOADED auto step whose retry block lacks max_attempts settles normally — no NaN-cascade instant STEP_TIMEOUT, no wrap', async () => {
    // The loader ADMITS an absent max_attempts (only validates its shape IF present) — this
    // fixture is loaded through the REAL loader path (not hand-built) to prove the state is
    // genuinely reachable via authored YAML, not just a contrived object. Generous timeout_seconds
    // so an instant (NaN-driven) STEP_TIMEOUT would be unmistakable against a dispatcher that
    // resolves in ~10ms.
    const def = loadWorkflowFromString(`
id: no-max-attempts-wf
name: No Max Attempts
version: 1
steps:
  step-one:
    description: Retries without max_attempts declared
    execution: auto
    timeout_seconds: 300
    retry:
      backoff: fixed
      base_delay_ms: 1000
`);
    const store = new JsonFileStore(dir);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });

    let calls = 0;
    const dispatcher: StepDispatcher = () => {
      calls++;
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 10));
    };

    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'step-one',
      input: {},
      dispatcher,
    });

    expect(envelope.status).toBe('ok');
    expect(calls).toBe(1);
  });
});
