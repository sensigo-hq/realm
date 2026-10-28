// chained-usage.test.ts — #600 (found by the #612 code lane): a model call is recorded ONCE, on the
// agent step that made it, never again on the auto steps `executeChain` runs after it in the same
// call. Before the fix, one call's `1234 prompt tokens` appeared on every chained step, and both
// cost surfaces counted it on each.
//
// Driven through the real `runAgent`, so the whole path (driver → executeChain → save → both
// surfaces) is under test, not only the engine's recursion.
import { declared } from '../test-support/declared.js';
import { it, expect, vi } from 'vitest';
import type { RunRecord, RunStore, UsageRecord, WorkflowDefinition } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { handleGetRunState } from '@sensigo/realm-mcp/dist/tools/get-run-state.js';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { inspectRun } from '../commands/inspect.js';

// agent `draft` → auto `finish` (a handler) → bare auto `wrap`.
const def = {
  id: 'chained-usage',
  name: 'Chained usage',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    draft: { description: 'Draft', execution: 'agent' },
    finish: {
      description: 'Finish',
      execution: 'auto',
      handler: 'finish_handler',
      depends_on: ['draft'],
    },
    wrap: { description: 'Wrap', execution: 'auto', depends_on: ['finish'] },
  },
} as WorkflowDefinition;

const workflowStore = declared({
  register: async () => {},
  get: async () => def,
  list: async () => [def],
} as never);

it('one model call is counted once: on the agent step, on both inspect and get_run_state', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const provider = new (class extends LlmProvider {
    callStep = vi.fn();
    async callStepWithMeta() {
      return {
        output: { answer: 42 },
        usage: [
          {
            request_index: 0,
            request_start: '2026-09-27T00:00:00.000Z',
            prompt_tokens: 1234,
            output_tokens: 56,
          },
        ],
      } as never;
    }
  })();
  const registry = createDefaultRegistry();
  registry.register('handler', 'finish_handler', {
    id: 'finish_handler',
    execute: async () => ({ data: { finished: true } }),
  });
  const store = new InMemoryStore();

  const result = await runAgent(
    { store, workflowStore, provider, registry },
    { definition: def, params: {} },
  );
  expect(result).toBe('completed');
  const run = (await store.list())[0]!;
  expect(run.completed_steps).toEqual(['draft', 'finish', 'wrap']);

  const screen = await inspectRun(run.id, store, workflowStore);
  // Exactly one step line carries the measured cost, and it is the agent step's.
  expect(screen.match(/1234 prompt tokens \(measured/g)).toHaveLength(1);
  expect(screen.match(/56 output tokens/g)).toHaveLength(1);
  const draftBlock = screen.slice(screen.indexOf('1. draft'), screen.indexOf('2. finish'));
  expect(draftBlock).toContain('1234 prompt tokens (measured, first request)');

  const summary = await handleGetRunState(
    { run_id: run.id, include_steps: true },
    { runStore: store, workflowStore },
  );
  expect(summary.steps!['draft']!.attempts[0]!.cost!.prompt).toEqual({
    value: 1234,
    reported: 1,
    of: 1,
    only_request_index: 0,
  });
  expect(summary.steps!['finish']!.attempts[0]!.cost).toBeUndefined();
  expect(summary.steps!['wrap']!.attempts[0]!.cost).toBeUndefined();
});

// ── the driver's two chokepoints (#600, the context-free read of the engine fix) ──────────────────
// The engine fix stops the chained step's EVIDENCE from carrying the calls. The driver has its own
// copy, `usageForStep`, which chokepoints 3 and 4 attach to a drive-failure entry. A failure in a
// step `executeChain` ran AFTER the driven step saved must not attach it: those calls are already on
// the driven step's record.

function billingProvider() {
  return new (class extends LlmProvider {
    callStep = vi.fn();
    async callStepWithMeta() {
      return {
        output: { answer: 42 },
        usage: [
          {
            request_index: 0,
            request_start: '2026-09-27T00:00:00.000Z',
            prompt_tokens: 1234,
            output_tokens: 56,
          },
        ],
      } as never;
    }
  })();
}

function quiet(): void {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}

it("a chained step's REJECTED input does not re-attach the agent step's calls (chokepoint 4)", async () => {
  quiet();
  // agent `draft` → auto `check`, whose input_schema its `{}` chain input cannot satisfy.
  const rejectDef = {
    id: 'chained-reject',
    name: 'Chained reject',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      draft: { description: 'Draft', execution: 'agent' },
      check: {
        description: 'Check',
        execution: 'auto',
        handler: 'finish_handler',
        depends_on: ['draft'],
        input_schema: {
          type: 'object',
          required: ['needed'],
          properties: { needed: { type: 'string' } },
        },
      },
    },
  } as WorkflowDefinition;
  const wf = declared({
    register: async () => {},
    get: async () => rejectDef,
    list: async () => [rejectDef],
  } as never);
  const registry = createDefaultRegistry();
  registry.register('handler', 'finish_handler', {
    id: 'finish_handler',
    execute: async () => ({ data: { finished: true } }),
  });
  const store = new InMemoryStore();

  const result = await runAgent(
    { store, workflowStore: wf, provider: billingProvider(), registry },
    { definition: rejectDef, params: {} },
  );
  expect(result).toBe('failed');
  const run = (await store.list())[0]!;
  expect(run.completed_steps).toEqual(['draft']);
  // The wedge is still recorded — it just does not carry calls that are already on draft's record.
  const entry = run.drive_failures!.entries[0]!;
  expect(entry.error_class).toBe('validation_rejected');
  expect(entry.usage).toBeUndefined();

  const screen = await inspectRun(run.id, store, wf);
  expect(screen.match(/1234 prompt tokens/g)).toHaveLength(1);
  const summary = await handleGetRunState(
    { run_id: run.id, include_steps: true },
    { runStore: store, workflowStore: wf },
  );
  expect(summary.drive_failure_costs![0]!.cost).toBeUndefined();
});

/**
 * A store that does NOT persist `workflow_context_snapshots` (it drops the field on write, so every
 * step re-takes the snapshot) and whose snapshot write THROWS on its `failOn`-th attempt. That throw
 * is unguarded in the engine, so it escapes `executeChain` and reaches the driver's chokepoint 3.
 */
function snapshotFailingStore(
  failOn: number,
  opts: {
    /** Before throwing, land an entry for `draft` that carries none of its calls (a reclaim's audit line). */
    strayDraftEntry?: boolean;
    /** The first `get` after the throw fails (the driver's re-read), later ones succeed. */
    failNextGet?: boolean;
    /**
     * #715 (R): the stray entry carries one request with the SAME `request_start`, `prompt_tokens`
     * and `output_tokens` as the driven step's call — with this `request_id` (a different request),
     * or with none (`null`: a request an earlier process wrote).
     */
    strayRequestId?: string | null;
    /** #715 (R): the snapshot write's error carries this `driveCall.usage` (a payload-carrying error). */
    throwUsage?: UsageRecord[];
  } = {},
): RunStore {
  const inner = new InMemoryStore();
  let snapshotWrites = 0;
  let getFailuresArmed = false;
  const update = async (record: RunRecord): Promise<RunRecord> => {
    if (record.workflow_context_snapshots !== undefined) {
      snapshotWrites += 1;
      if (snapshotWrites >= failOn) {
        if (opts.strayDraftEntry === true) {
          const current = await inner.get(record.id);
          await inner.update({
            ...current,
            evidence: [
              ...current.evidence,
              {
                step_id: 'draft',
                started_at: '2026-09-27T00:00:01.000Z',
                completed_at: '2026-09-27T00:00:01.000Z',
                duration_ms: 0,
                input_summary: {},
                output_summary: { reclaimed: true },
                status: 'skipped',
                evidence_hash: 'stray',
                ...(opts.strayRequestId !== undefined
                  ? {
                      diagnostics: {
                        input_token_estimate: 0,
                        precondition_trace: [],
                        cache: {
                          state: 'never_engaged' as const,
                          basis: 'provider_reported' as const,
                          requests: [
                            {
                              request_index: 0,
                              request_start: '2026-09-27T00:00:00.000Z',
                              prompt_tokens: 1234,
                              output_tokens: 56,
                              ...(opts.strayRequestId !== null
                                ? { request_id: opts.strayRequestId }
                                : {}),
                            },
                          ],
                        },
                      },
                    }
                  : {}),
              },
            ],
          });
        }
        getFailuresArmed = opts.failNextGet === true;
        throw opts.throwUsage !== undefined
          ? Object.assign(new Error('snapshot write failed'), {
              driveCall: { usage: opts.throwUsage },
            })
          : new Error('snapshot write failed');
      }
      const { workflow_context_snapshots: _dropped, ...rest } = record;
      return inner.update(rest as RunRecord);
    }
    return inner.update(record);
  };
  const get = async (id: string): Promise<RunRecord> => {
    if (getFailuresArmed) {
      getFailuresArmed = false;
      throw new Error('re-read failed');
    }
    return inner.get(id);
  };
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'update') return update;
      if (prop === 'get') return get;
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as unknown as RunStore;
}

const contextDef = {
  ...def,
  id: 'chained-context',
  workflow_context: { doc: { source: { path: '/nonexistent/realm-chained-usage-context.md' } } },
} as WorkflowDefinition;
const contextWf = declared({
  register: async () => {},
  get: async () => contextDef,
  list: async () => [contextDef],
} as never);

async function driveContext(store: RunStore) {
  const registry = createDefaultRegistry();
  registry.register('handler', 'finish_handler', {
    id: 'finish_handler',
    execute: async () => ({ data: { finished: true } }),
  });
  await expect(
    runAgent(
      { store, workflowStore: contextWf, provider: billingProvider(), registry },
      { definition: contextDef, params: {} },
    ),
  ).rejects.toThrow('snapshot write failed');
  return (await store.list())[0]!;
}

it('a throw from a step run AFTER the agent step saved does not re-attach its calls (chokepoint 3)', async () => {
  quiet();
  // Write 1 (draft's snapshot, after its claim) succeeds and is dropped; write 2 (the chained
  // `finish`'s snapshot) throws.
  const run = await driveContext(snapshotFailingStore(2));
  expect(run.completed_steps).toEqual(['draft']);
  expect(
    run.evidence.find((e) => e.step_id === 'draft')!.diagnostics?.cache?.requests,
  ).toHaveLength(1);
  const entry = run.drive_failures!.entries[0]!;
  expect(entry.usage).toBeUndefined();
});

it('CONTROL: the DRIVEN step claimed but did not save — its calls ARE attached (chokepoint 3)', async () => {
  quiet();
  // Write 1 is draft's own snapshot, after its claim landed: the claim moves the run's version, yet
  // the calls were never saved. A version test would drop them here; the content test keeps them.
  const run = await driveContext(snapshotFailingStore(1));
  expect(run.completed_steps).toEqual([]);
  expect(run.in_progress_steps).toEqual(['draft']);
  const entry = run.drive_failures!.entries[0]!;
  expect(entry.usage?.map((r) => r.prompt_tokens)).toEqual([1234]);
});

it('an entry for the driven step that carries none of its calls does not suppress them (chokepoint 3)', async () => {
  quiet();
  // As the CONTROL, plus an entry for `draft` landing before the throw with no usage on it — the
  // shape of a reclaim's audit line. A count of the step's entries would read "saved" and drop the
  // calls; they are not on the record, so they must be attached.
  const run = await driveContext(snapshotFailingStore(1, { strayDraftEntry: true }));
  expect(run.evidence.filter((e) => e.step_id === 'draft')).toHaveLength(1);
  const entry = run.drive_failures!.entries[0]!;
  expect(entry.usage?.map((r) => r.prompt_tokens)).toEqual([1234]);
});

it('when the driver cannot re-read the record, it attaches the calls (the documented fallback)', async () => {
  quiet();
  // As the chokepoint-3 cell above (draft saved, then the chained step threw), but the driver's
  // re-read fails, so it cannot tell whether the calls were saved. It attaches them: the store is
  // failing, and the entry usually will not land (here it does, because only one read fails).
  const run = await driveContext(snapshotFailingStore(2, { failNextGet: true }));
  expect(run.completed_steps).toEqual(['draft']);
  const entry = run.drive_failures!.entries[0]!;
  expect(entry.usage?.map((r) => r.prompt_tokens)).toEqual([1234]);
});

// ═══ issue #715 (R) — "already recorded" is decided by the request's own id, and nothing else ═══

/** A version-4 UUID, as `crypto.randomUUID()` mints it. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it('R5b: a stored request with the SAME start time and token counts but a DIFFERENT request_id is not the same request — the calls are attached (chokepoint 3)', async () => {
  quiet();
  // As the stray-entry cell above, but the stray entry carries a request whose start time and token
  // counts equal draft's call: the collision the old content rule lost (red on 66a279db, where it
  // read "already recorded" and dropped the call). (a) red when the comparison is by content;
  // (b) prints the prompt tokens attached and whether their ids are UUIDs.
  const run = await driveContext(
    snapshotFailingStore(1, {
      strayDraftEntry: true,
      strayRequestId: '715b0000-0000-4000-8000-00000000715b',
    }),
  );
  const entry = run.drive_failures!.entries[0]!;
  expect({
    attached: entry.usage?.map((r) => r.prompt_tokens),
    ids: entry.usage?.map((r) => UUID_V4.test(String(r.request_id))),
    notTheStray: entry.usage?.every((r) => r.request_id !== '715b0000-0000-4000-8000-00000000715b'),
  }).toEqual({ attached: [1234], ids: [true], notTheStray: true });
});

it('R5c: a stored request WITHOUT request_id (an earlier process wrote it) is never "already recorded", even when its content matches — the calls are attached', async () => {
  quiet();
  // (a) red when a fallback to the content rule is left in; (b) prints the prompt tokens attached.
  const run = await driveContext(
    snapshotFailingStore(1, { strayDraftEntry: true, strayRequestId: null }),
  );
  const entry = run.drive_failures!.entries[0]!;
  expect(entry.usage?.map((r) => r.prompt_tokens)).toEqual([1234]);
});

it('R3c (the last-resort catch): an error carrying driveCall.usage is minted in buildEntry; with the step’s unsaved call in front, the entry’s ids are the request mints, in order', async () => {
  quiet();
  // As the CONTROL (draft claimed, not saved), with the snapshot write's error carrying one billed
  // request. The spy sees every UUID minted in the drive, and the stores mint their own
  // (`InMemoryStore.create` a run's id, `claimStep` a claim's; verify-first). So it keeps only the
  // calls made through `mintRequestIds` (read off the call's stack): those must be exactly the
  // requests billed, and the entry's ids those values, in order.
  // (a) red when the funnel is not in `buildEntryUnsafe` (no ids) or the prepend
  // re-mints (more mints than the 2 requests); (b) prints the counts and whether the ids match.
  const minted: string[] = [];
  const real = crypto.randomUUID.bind(crypto);
  const spy = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
    const id = real();
    if (/\bmintRequestIds\b/.test(new Error().stack ?? '')) minted.push(id);
    return id;
  });
  let run: RunRecord;
  try {
    run = await driveContext(
      snapshotFailingStore(1, {
        throwUsage: [
          { request_index: 0, request_start: '2026-09-27T00:00:05.000Z', prompt_tokens: 77 },
        ],
      }),
    );
  } finally {
    spy.mockRestore();
  }
  const usage = run.drive_failures!.entries[0]!.usage ?? [];
  const requestMints = minted;
  expect({
    prompts: usage.map((r) => r.prompt_tokens),
    requestMints: requestMints.length,
    sameInOrder: usage.map((r) => r.request_id).join() === requestMints.join(),
  }).toEqual({ prompts: [1234, 77], requestMints: 2, sameInOrder: true });
});
