// Execution matrix for `execution: finalizer` — the workflow-level try/catch/finally drain.
// Source: execution-loop.ts (buildFinalizedSeal + the five terminal sites).
//
// Terminal outcome mapping: complete = success/try · fail|abort = catch · always = finally.
// The engine owns only WHICH finalizers run, WHEN (terminal transition), in what ORDER, and
// at-most-ONCE. A finalizer failure is recorded but never changes the run outcome.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeChain } from './execution-loop.js';
import { abandonRun } from './abandon-run.js';
import { JsonFileStore } from '../store/json-file-store.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { StepDispatcher } from './execution-loop.js';
import type { StepHandler } from '../extensions/step-handler.js';

const echoDispatcher: StepDispatcher = async (_step, input) => ({ ...input });

// Handler factories — each records its own id into a shared order array on invocation.
function okHandler(id: string, order: string[]): StepHandler {
  return {
    id,
    execute: vi.fn(async () => {
      order.push(id);
      return { data: { ran: id } };
    }),
  };
}
function throwHandler(id: string, order: string[]): StepHandler {
  return {
    id,
    execute: vi.fn(async () => {
      order.push(id);
      throw new Error(`${id} boom`);
    }),
  };
}
function abortHandler(id: string, order: string[]): StepHandler {
  return {
    id,
    execute: vi.fn(async () => {
      order.push(id);
      return { abort: { message: `${id} abort` } };
    }),
  };
}
function slowHandler(id: string, order: string[]): StepHandler {
  // Resolves after 200ms unless the timeout signal aborts first (then clears its timer cleanly).
  return {
    id,
    execute: vi.fn(
      (_inputs: unknown, _ctx: unknown, signal?: AbortSignal) =>
        new Promise((resolve) => {
          const t = setTimeout(() => {
            order.push(id);
            resolve({ data: {} });
          }, 200);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            resolve({ data: {} });
          });
        }) as ReturnType<StepHandler['execute']>,
    ),
  };
}

/** The three-arm matrix workflow: one auto domain step + complete/catch/always finalizers. */
function matrixWorkflow(domainHandler: string): WorkflowDefinition {
  return {
    id: 'fin-matrix',
    name: 'Finalizer Matrix',
    version: 1,
    steps: {
      work: {
        description: 'Domain step',
        execution: 'auto',
        depends_on: [],
        handler: domainHandler,
      },
      on_complete: {
        description: 'success finalizer',
        execution: 'finalizer',
        on_outcome: 'complete',
        handler: 'h_complete',
      },
      on_catch: {
        description: 'catch finalizer',
        execution: 'finalizer',
        on_outcome: ['fail', 'abort'],
        handler: 'h_catch',
      },
      on_always: {
        description: 'finally finalizer',
        execution: 'finalizer',
        on_outcome: 'always',
        handler: 'h_always',
      },
    },
  };
}

describe('finalizer drain — outcome matching', () => {
  let store: JsonFileStore;
  let dir: string;
  let order: string[];
  let registry: ExtensionRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-finalizer-'));
    store = new JsonFileStore(dir);
    order = [];
    registry = new ExtensionRegistry();
    registry.register('handler', 'h_complete', okHandler('h_complete', order));
    registry.register('handler', 'h_catch', okHandler('h_catch', order));
    registry.register('handler', 'h_always', okHandler('h_always', order));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function drive(domainHandler: StepHandler): Promise<string> {
    registry.register('handler', domainHandler.id, domainHandler);
    const def = matrixWorkflow(domainHandler.id);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeChain(store, def, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });
    return run.id;
  }

  it('complete → runs on_complete + always, NOT catch', async () => {
    const run = await store.get(await drive(okHandler('domain_ok', order)));
    expect(run.run_phase).toBe('completed');
    expect(order).toContain('h_complete');
    expect(order).toContain('h_always');
    expect(order).not.toContain('h_catch');
    expect(run.completed_steps).toEqual(expect.arrayContaining(['on_complete', 'on_always']));
    expect(run.completed_steps).not.toContain('on_catch');
  });

  it('fail → runs catch + always, NOT on_complete', async () => {
    const run = await store.get(await drive(throwHandler('domain_fail', order)));
    expect(run.run_phase).toBe('failed');
    expect(order).toContain('h_catch');
    expect(order).toContain('h_always');
    expect(order).not.toContain('h_complete');
    // domain failure keeps phase 'failed' even though the catch/always finalizers completed
    expect(run.failed_steps).toContain('work');
    expect(run.completed_steps).toEqual(expect.arrayContaining(['on_catch', 'on_always']));
  });

  it('abort (handler-abort) → runs catch + always, NOT on_complete', async () => {
    const run = await store.get(await drive(abortHandler('domain_abort', order)));
    expect(run.run_phase).toBe('aborted');
    expect(order).toContain('h_catch');
    expect(order).toContain('h_always');
    expect(order).not.toContain('h_complete');
    expect(run.aborted_at?.step_id).toBe('work');
  });
});

describe('finalizer drain — ordering', () => {
  let store: JsonFileStore;
  let dir: string;
  let order: string[];
  let registry: ExtensionRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-finalizer-order-'));
    store = new JsonFileStore(dir);
    order = [];
    registry = new ExtensionRegistry();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('outcome-specific finalizers run in declaration order, always runs LAST', async () => {
    registry.register('handler', 'domain_ok', okHandler('domain_ok', order));
    registry.register('handler', 'h_a', okHandler('h_a', order));
    registry.register('handler', 'h_b', okHandler('h_b', order));
    registry.register('handler', 'h_always', okHandler('h_always', order));
    const def: WorkflowDefinition = {
      id: 'fin-order',
      name: 'Finalizer Order',
      version: 1,
      steps: {
        work: { description: 'work', execution: 'auto', depends_on: [], handler: 'domain_ok' },
        fin_a: { description: 'a', execution: 'finalizer', on_outcome: 'complete', handler: 'h_a' },
        fin_b: { description: 'b', execution: 'finalizer', on_outcome: 'complete', handler: 'h_b' },
        fin_always: {
          description: 'z',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h_always',
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeChain(store, def, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });
    // Group A (complete) in declaration order, then Group B (always).
    expect(order.filter((o) => o.startsWith('h_'))).toEqual(['h_a', 'h_b', 'h_always']);
  });

  it('a finalizer listing both its outcome AND always runs ONCE (in Group A)', async () => {
    const both = okHandler('h_both', order);
    registry.register('handler', 'domain_ok', okHandler('domain_ok', order));
    registry.register('handler', 'h_both', both);
    const def: WorkflowDefinition = {
      id: 'fin-both',
      name: 'Finalizer Both',
      version: 1,
      steps: {
        work: { description: 'work', execution: 'auto', depends_on: [], handler: 'domain_ok' },
        fin_both: {
          description: 'both',
          execution: 'finalizer',
          on_outcome: ['complete', 'always'],
          handler: 'h_both',
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeChain(store, def, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });
    expect(both.execute).toHaveBeenCalledTimes(1);
    const saved = await store.get(run.id);
    expect(saved.completed_steps.filter((s) => s === 'fin_both')).toHaveLength(1);
  });
});

describe('finalizer drain — failure handling (non-fatal, drain continues)', () => {
  let store: JsonFileStore;
  let dir: string;
  let order: string[];
  let registry: ExtensionRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-finalizer-fail-'));
    store = new JsonFileStore(dir);
    order = [];
    registry = new ExtensionRegistry();
    registry.register('handler', 'domain_ok', okHandler('domain_ok', order));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function driveComplete(def: WorkflowDefinition): Promise<string> {
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeChain(store, def, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });
    return run.id;
  }

  it('a finalizer that THROWS is recorded failed; the run outcome is unchanged and later finalizers still run', async () => {
    registry.register('handler', 'h_boom', throwHandler('h_boom', order));
    registry.register('handler', 'h_ok', okHandler('h_ok', order));
    const def: WorkflowDefinition = {
      id: 'fin-throw',
      name: 'Finalizer Throw',
      version: 1,
      steps: {
        work: { description: 'work', execution: 'auto', depends_on: [], handler: 'domain_ok' },
        fin_boom: {
          description: '1',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h_boom',
        },
        fin_ok: { description: '2', execution: 'finalizer', on_outcome: 'always', handler: 'h_ok' },
      },
    };
    const runId = await driveComplete(def);
    const run = await store.get(runId);
    expect(run.run_phase).toBe('completed'); // outcome unchanged
    expect(run.failed_steps).toContain('fin_boom');
    expect(run.completed_steps).toContain('fin_ok'); // drain continued
    expect(order).toContain('h_ok');
    const snap = run.evidence.find((e) => e.step_id === 'fin_boom');
    expect(snap?.error).toContain('boom');
  });

  it('a finalizer returning { abort } is recorded failed (non-fatal) — aborted_at/terminal_reason unchanged', async () => {
    registry.register('handler', 'h_abort', abortHandler('h_abort', order));
    registry.register('handler', 'h_ok', okHandler('h_ok', order));
    const def: WorkflowDefinition = {
      id: 'fin-abort',
      name: 'Finalizer Abort',
      version: 1,
      steps: {
        work: { description: 'work', execution: 'auto', depends_on: [], handler: 'domain_ok' },
        fin_abort: {
          description: '1',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h_abort',
        },
        fin_ok: { description: '2', execution: 'finalizer', on_outcome: 'always', handler: 'h_ok' },
      },
    };
    const runId = await driveComplete(def);
    const run = await store.get(runId);
    expect(run.run_phase).toBe('completed');
    expect(run.aborted_at).toBeUndefined(); // finalizer abort never sets aborted_at
    expect(run.terminal_reason).toBe('Workflow completed.');
    expect(run.failed_steps).toContain('fin_abort');
    expect(run.completed_steps).toContain('fin_ok');
  });

  // issue #140 drain-outside-cap pin: the DOMAIN step's total-time cap (capMs/capStart/capExhausted)
  // is local to that single executeStep call — buildFinalizedSeal's OWN finalizer-timeout wrap
  // (:2610-ish, outside cap scope per the design record) must apply in FULL, never truncated to
  // whatever thin budget the domain step's cap had left. Finalizers themselves cannot even declare
  // `retry:` (loader-prohibited), so this is purely about the DOMAIN step's cap not leaking across
  // the terminal-drain boundary into a SEPARATE step's SEPARATE timeout.
  it('drain-outside-cap: a finalizer with an adequate timeout_seconds completes in full, unaffected by the domain step’s (tiny, unconsumed) total-time cap', async () => {
    registry.register('handler', 'h_slow', slowHandler('h_slow', order));
    const def: WorkflowDefinition = {
      id: 'fin-drain-outside-cap',
      name: 'Finalizer Drain Outside Cap',
      version: 1,
      steps: {
        work: {
          description: 'domain step — declares a tiny total_timeout_seconds but succeeds instantly',
          execution: 'auto',
          depends_on: [],
          handler: 'domain_ok',
          timeout_seconds: 0.05,
          // S6 correction: raised from 0.01 (a ~10ms real-timer budget the review flagged as the
          // same flake class the reliability.test.ts redesigns targeted) to 0.15 — with real
          // headroom against the domain_ok handler's near-instant resolution. The load-bearing
          // bounds are against the FINALIZER's own numbers, not the domain step's: this cap
          // (0.15s) must stay BELOW h_slow's 0.20s runtime (a cap leaking into the finalizer's
          // timeout resolution would truncate it below 200ms ⇒ fin_slow times out ⇒ this test
          // reds) and below fin_slow's own 0.35s timeout_seconds (else the leaked bound would
          // never bind at all, and the test would prove nothing).
          retry: { max_attempts: 2, base_delay_ms: 5, total_timeout_seconds: 0.15 },
        },
        fin_slow: {
          description:
            'finalizer with an adequate (350ms) timeout — comfortably more than h_slow’s 200ms',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h_slow',
          timeout_seconds: 0.35,
        },
      },
    };
    // domain_ok succeeds on attempt 1, immediately — the domain step's cap never actually binds;
    // what this test proves is that its mere PRESENCE (capMs/capStart local to that one
    // executeStep call) cannot leak forward into buildFinalizedSeal's own, separate timeout wrap.
    const runId = await driveComplete(def);
    const run = await store.get(runId);
    expect(run.run_phase).toBe('completed');
    // The finalizer COMPLETED (its own 350ms budget applied in full) — had the domain step's
    // near-zero leftover cap somehow leaked into the finalizer's own timeout resolution, this
    // would instead show up in failed_steps with a "timed out" evidence error.
    expect(run.completed_steps).toContain('fin_slow');
    expect(run.failed_steps).not.toContain('fin_slow');
    const snap = run.evidence.find((e) => e.step_id === 'fin_slow');
    expect(snap?.error).toBeUndefined();
  });

  it('a finalizer that TIMES OUT is recorded failed and the drain continues', async () => {
    registry.register('handler', 'h_slow', slowHandler('h_slow', order));
    registry.register('handler', 'h_ok', okHandler('h_ok', order));
    const def: WorkflowDefinition = {
      id: 'fin-timeout',
      name: 'Finalizer Timeout',
      version: 1,
      steps: {
        work: { description: 'work', execution: 'auto', depends_on: [], handler: 'domain_ok' },
        fin_slow: {
          description: '1',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h_slow',
          timeout_seconds: 0.05,
        },
        fin_ok: { description: '2', execution: 'finalizer', on_outcome: 'always', handler: 'h_ok' },
      },
    };
    const runId = await driveComplete(def);
    const run = await store.get(runId);
    expect(run.run_phase).toBe('completed');
    expect(run.failed_steps).toContain('fin_slow');
    expect(run.completed_steps).toContain('fin_ok');
    const snap = run.evidence.find((e) => e.step_id === 'fin_slow');
    expect(snap?.error).toContain('timed out');
  });
});

describe('finalizer drain — idempotent at-most-once', () => {
  let store: JsonFileStore;
  let dir: string;
  let order: string[];
  let registry: ExtensionRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-finalizer-idem-'));
    store = new JsonFileStore(dir);
    order = [];
    registry = new ExtensionRegistry();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a finalizer already in completed_steps is not re-run (resume / re-drive safety)', async () => {
    const cleanup = okHandler('h_always', order);
    registry.register('handler', 'domain_ok', okHandler('domain_ok', order));
    registry.register('handler', 'h_always', cleanup);
    const def: WorkflowDefinition = {
      id: 'fin-idem',
      name: 'Finalizer Idempotent',
      version: 1,
      steps: {
        work: { description: 'work', execution: 'auto', depends_on: [], handler: 'domain_ok' },
        cleanup: {
          description: 'cleanup',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h_always',
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    // Pretend a prior drive already ran the finalizer: pre-seed completed_steps with it.
    const seeded = await store.get(run.id);
    await store.update({ ...seeded, completed_steps: [...seeded.completed_steps, 'cleanup'] });

    await executeChain(store, def, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: echoDispatcher,
      registry,
    });

    expect(cleanup.execute).not.toHaveBeenCalled(); // skipped — already settled
    const saved = await store.get(run.id);
    expect(saved.completed_steps.filter((s) => s === 'cleanup')).toHaveLength(1); // no duplicate
    expect(saved.run_phase).toBe('completed');
  });
});

describe('finalizer drain — guard-terminated runs (Blocking fix #1)', () => {
  let store: JsonFileStore;
  let dir: string;
  let order: string[];
  let registry: ExtensionRegistry;

  const guardWorkflow: WorkflowDefinition = {
    id: 'fin-guard',
    name: 'Finalizer Guard',
    version: 1,
    steps: {
      work: { description: 'work', execution: 'agent', depends_on: [] },
      final_guard: {
        description: 'terminal guard',
        execution: 'guard',
        depends_on: ['work'],
        abort_unless: ["work.status == 'open'"],
      },
      on_complete: {
        description: 'success finalizer',
        execution: 'finalizer',
        on_outcome: 'complete',
        handler: 'h_complete',
      },
      on_catch: {
        description: 'catch finalizer',
        execution: 'finalizer',
        on_outcome: ['fail', 'abort'],
        handler: 'h_catch',
      },
      on_always: {
        description: 'finally finalizer',
        execution: 'finalizer',
        on_outcome: 'always',
        handler: 'h_always',
      },
    },
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-finalizer-guard-'));
    store = new JsonFileStore(dir);
    order = [];
    registry = new ExtensionRegistry();
    registry.register('handler', 'h_complete', okHandler('h_complete', order));
    registry.register('handler', 'h_catch', okHandler('h_catch', order));
    registry.register('handler', 'h_always', okHandler('h_always', order));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function driveGuard(status: Record<string, unknown>): Promise<string> {
    const { run } = await store.create({
      workflowId: guardWorkflow.id,
      workflowVersion: 1,
      params: {},
    });
    await executeChain(store, guardWorkflow, {
      runId: run.id,
      command: 'work',
      input: {},
      dispatcher: async () => status,
      registry,
    });
    return run.id;
  }

  it('a PASSING terminal guard runs on_complete + always, NOT the catch finalizers', async () => {
    // Blocking fix #1: classify by the sealed record — a passing guard completes the run, so
    // `aborted_at ? abort : fail` would WRONGLY run the catch arm. It must run on_complete.
    const runId = await driveGuard({ status: 'open' });
    const run = await store.get(runId);
    expect(run.run_phase).toBe('completed');
    expect(order).toContain('h_complete');
    expect(order).toContain('h_always');
    expect(order).not.toContain('h_catch');
  });

  it('an ABORTING guard runs the catch + always finalizers, NOT on_complete', async () => {
    const runId = await driveGuard({ status: 'closed' });
    const run = await store.get(runId);
    expect(run.run_phase).toBe('aborted');
    expect(order).toContain('h_catch');
    expect(order).toContain('h_always');
    expect(order).not.toContain('h_complete');
  });

  it('a guard RESOLUTION ERROR runs the catch + always finalizers, NOT on_complete', async () => {
    // No 'status' field → the abort_unless path is unresolvable → guard fails (not aborts).
    const runId = await driveGuard({ other_field: 'x' });
    const run = await store.get(runId);
    expect(run.run_phase).toBe('failed');
    expect(order).toContain('h_catch');
    expect(order).toContain('h_always');
    expect(order).not.toContain('h_complete');
  });
});

describe('finalizer drain — abandon runs no finalizers', () => {
  let store: JsonFileStore;
  let dir: string;
  let order: string[];
  let registry: ExtensionRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'realm-finalizer-abandon-'));
    store = new JsonFileStore(dir);
    order = [];
    registry = new ExtensionRegistry();
    registry.register('handler', 'h_always', okHandler('h_always', order));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // issue #302 (D-B): this contract is now DOCUMENTED (docs/reference/yaml-schema.md's
  // `execution: finalizer` section) + runtime-advised (the abandon_run MCP tool's `note` field,
  // `realm run abandon`'s success line) — this pin proves the underlying BEHAVIOR still holds,
  // unchanged; the docs/advisory additions describe it, they do not alter it.
  it('abandoning a run runs NO finalizers (a kill runs no finally)', async () => {
    const cleanup = okHandler('h_always', order);
    registry.register('handler', 'h_always', cleanup);
    const def: WorkflowDefinition = {
      id: 'fin-abandon',
      name: 'Finalizer Abandon',
      version: 1,
      steps: {
        work: { description: 'work', execution: 'agent', depends_on: [] },
        cleanup: {
          description: 'cleanup',
          execution: 'finalizer',
          on_outcome: 'always',
          handler: 'h_always',
        },
      },
    };
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const abandoned = await abandonRun(store, run.id, 'operator kill');

    expect(abandoned.run_phase).toBe('abandoned');
    expect(cleanup.execute).not.toHaveBeenCalled();
    expect(abandoned.evidence.some((e) => e.step_id === 'cleanup')).toBe(false);
  });
});
