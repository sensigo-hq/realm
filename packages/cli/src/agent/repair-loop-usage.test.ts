// repair-loop-usage.test.ts — issue #600: a step realm's driver repairs (the #217 schema-repair
// loop) records every wire request it billed, exactly once, in wire order, on whichever record the
// step ends on: its evidence (exit 1), the drive-failure entry of a later throw (exit 2), the
// `validation_rejected` wedge entry (exit 3), or the last-resort catch before the step was saved
// (exit 4). Driven through the real `runAgent` against the real `InMemoryStore`.
import { describe, it, expect, vi } from 'vitest';
import type { RunRecord, UsageRecord, WorkflowDefinition, RunStore } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { appendRequests } from './providers/agent-utils.js';
import { inspectRun } from '../commands/inspect.js';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['OK'] } },
  required: ['status'],
};

const oneStep = {
  id: 'repair-one',
  name: 'Repair one',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    draft: { description: 'Draft', execution: 'agent', output_schema: OUTPUT_SCHEMA },
  },
} as WorkflowDefinition;

const agentThenAgent = {
  id: 'repair-agent-agent',
  name: 'Repair agent then agent',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    draft: { description: 'Draft', execution: 'agent', output_schema: OUTPUT_SCHEMA },
    review: { description: 'Review', execution: 'agent', depends_on: ['draft'] },
  },
} as WorkflowDefinition;

const agentThenAuto = {
  id: 'repair-agent-auto',
  name: 'Repair agent then auto',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    draft: { description: 'Draft', execution: 'agent', output_schema: OUTPUT_SCHEMA },
    finish: { description: 'Finish', execution: 'auto', depends_on: ['draft'] },
  },
} as WorkflowDefinition;

const workflowStore = (def: WorkflowDefinition) =>
  ({ register: async () => {}, get: async () => def, list: async () => [def] }) as never;

/** One scripted model call: an output (`BAD` is rejected by the schema), its billed tokens, or a throw. */
type Call =
  | { output: 'BAD' | 'OK'; prompt?: number; out?: number }
  | { throwPrompt: number; throwOut: number };

/** A real provider numbers each call's requests from 0 — so every call's one request is index 0. */
function usageFor(prompt: number | undefined, out: number | undefined): UsageRecord[] | undefined {
  if (prompt === undefined) return undefined;
  return [
    {
      request_index: 0,
      request_start: '2026-09-27T00:00:00.000Z',
      prompt_tokens: prompt,
      ...(out !== undefined ? { output_tokens: out } : {}),
    },
  ];
}

function scriptedProvider(calls: Call[]) {
  let n = 0;
  const provider = new (class extends LlmProvider {
    callStep = vi.fn();
    async callStepWithMeta() {
      const call = calls[n];
      n += 1;
      if (call === undefined) throw new Error(`unscripted call ${String(n)}`);
      if ('throwPrompt' in call) {
        const err = new Error('upstream exploded') as Error & { driveCall?: unknown };
        err.driveCall = { usage: usageFor(call.throwPrompt, call.throwOut) };
        throw err;
      }
      const usage = usageFor(call.prompt, call.out);
      return {
        output: { status: call.output },
        ...(usage !== undefined ? { usage } : {}),
      } as never;
    }
  })();
  return { provider, calls: () => n };
}

async function drive(
  store: RunStore,
  def: WorkflowDefinition,
  provider: LlmProvider,
  schemaRetries?: number,
) {
  return runAgent(
    {
      store,
      workflowStore: workflowStore(def),
      provider,
      registry: createDefaultRegistry(),
      ...(schemaRetries !== undefined ? { schemaRetries } : {}),
    },
    { definition: def, params: {} },
  );
}

async function onlyRun(store: InMemoryStore): Promise<RunRecord> {
  const runs = await store.list();
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

function executionEvidence(run: RunRecord, step: string) {
  return run.evidence.filter((e) => e.step_id === step && e.kind !== 'gate_response');
}

const quiet = () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
};

describe('issue #600 — a repaired step records every call it paid for', () => {
  it('cell 1 — exit 1: the settled step evidence carries all three calls, in wire order', async () => {
    quiet();
    const store = new InMemoryStore();
    const { provider } = scriptedProvider([
      { output: 'BAD', prompt: 1000, out: 100 },
      { output: 'BAD', prompt: 2000, out: 200 },
      { output: 'OK', prompt: 3000, out: 300 },
    ]);
    await drive(store, oneStep, provider);
    const run = await onlyRun(store);
    const snaps = executionEvidence(run, 'draft');
    expect(snaps).toHaveLength(1);
    const requests = snaps[0]!.diagnostics?.cache?.requests ?? [];
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.request_index)).toEqual([0, 1, 2]);
    expect(requests.map((r) => r.prompt_tokens)).toEqual([1000, 2000, 3000]);
    expect(requests.map((r) => r.output_tokens)).toEqual([100, 200, 300]);
    const out = await inspectRun(run.id, store, workflowStore(oneStep));
    expect(out).toContain('6000 prompt tokens (measured, totals across 3 requests)');
    expect(out).toContain('cache: not reported by the provider (totals across 3 requests)');
  });

  it('cell 2 — exit 2: a throw after two rejected calls keeps all three on the drive-failure entry', async () => {
    quiet();
    const store = new InMemoryStore();
    const { provider } = scriptedProvider([
      { output: 'BAD', prompt: 1000, out: 100 },
      { output: 'BAD', prompt: 2000, out: 200 },
      { throwPrompt: 3000, throwOut: 300 },
    ]);
    await drive(store, oneStep, provider);
    const run = await onlyRun(store);
    const entries = run.drive_failures?.entries ?? [];
    expect(entries).toHaveLength(1);
    const usage = entries[0]!.usage ?? [];
    expect(usage).toHaveLength(3);
    expect(usage.map((r) => r.request_index)).toEqual([0, 1, 2]);
    expect(usage.map((r) => r.prompt_tokens)).toEqual([1000, 2000, 3000]);
  });

  it('cell 3 — exit 3: the wedge entry carries every call of the exhausted budget and says it was a rejection', async () => {
    quiet();
    const store = new InMemoryStore();
    const { provider } = scriptedProvider([
      { output: 'BAD', prompt: 1000, out: 100 },
      { output: 'BAD', prompt: 2000, out: 200 },
      { output: 'BAD', prompt: 3000, out: 300 },
    ]);
    await drive(store, oneStep, provider, 2);
    const run = await onlyRun(store);
    const entries = run.drive_failures?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.error_class).toBe('validation_rejected');
    expect((entries[0]!.usage ?? []).map((r) => r.prompt_tokens)).toEqual([1000, 2000, 3000]);
    const out = await inspectRun(run.id, store, workflowStore(oneStep));
    expect(out).toContain('billed before the output was rejected');
    expect(out).not.toContain('before the throw');
  });

  it('cell 4 — exit 3, provider reports nothing: no usage key and no usage line', async () => {
    quiet();
    const store = new InMemoryStore();
    const { provider } = scriptedProvider([
      { output: 'BAD' },
      { output: 'BAD' },
      { output: 'BAD' },
    ]);
    await drive(store, oneStep, provider, 2);
    const run = await onlyRun(store);
    const entries = run.drive_failures?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.error_class).toBe('validation_rejected');
    expect('usage' in entries[0]!).toBe(false);
    const out = await inspectRun(run.id, store, workflowStore(oneStep));
    expect(out).not.toContain('usage:');
  });

  it('cell 5 — exit 4 before anything was saved: the last-resort entry carries both calls', async () => {
    quiet();
    // Throws once, from the SECOND `get` whose immediate caller is the public `executeChain`
    // wrapper — the first such call belongs to the rejected attempt. That wrapper re-throws any
    // read failure other than STATE_RUN_NOT_FOUND, so `executeChain` throws before claiming.
    class FaultStore extends InMemoryStore {
      private wrapperReads = 0;
      override async get(runId: string): Promise<RunRecord> {
        const caller = (new Error().stack ?? '').split('\n')[2] ?? '';
        if (/\bat executeChain \(/.test(caller)) {
          this.wrapperReads += 1;
          if (this.wrapperReads === 2) throw new Error('read failed');
        }
        return super.get(runId);
      }
    }
    const store = new FaultStore();
    const { provider } = scriptedProvider([
      { output: 'BAD', prompt: 1000, out: 100 },
      { output: 'OK', prompt: 2000, out: 200 },
    ]);
    await expect(drive(store, oneStep, provider)).rejects.toThrow('read failed');
    const run = await onlyRun(store);
    expect(executionEvidence(run, 'draft')).toHaveLength(0);
    const entries = run.drive_failures?.entries ?? [];
    expect(entries).toHaveLength(1);
    const usage = entries[0]!.usage ?? [];
    expect(usage.map((r) => r.prompt_tokens)).toEqual([1000, 2000]);
    expect(usage.map((r) => r.request_index)).toEqual([0, 1]);
  });

  it('cell 6 — exit 4 after executeChain returned: the calls appear exactly once, on the evidence', async () => {
    quiet();
    // Throws once, from the first `get` the DRIVER itself makes (no execution-loop frame on the
    // stack) after `draft` has settled. The engine's own post-settle reads are left alone: they are
    // caught inside the engine and must not be the one that throws.
    class FaultStore extends InMemoryStore {
      private fired = false;
      override async get(runId: string): Promise<RunRecord> {
        const stack = new Error().stack ?? '';
        const record = await super.get(runId);
        if (
          !this.fired &&
          !stack.includes('execution-loop') &&
          record.completed_steps.includes('draft')
        ) {
          this.fired = true;
          throw new Error('read failed');
        }
        return record;
      }
    }
    const store = new FaultStore();
    const { provider } = scriptedProvider([
      { output: 'BAD', prompt: 1000, out: 100 },
      { output: 'OK', prompt: 2000, out: 200 },
    ]);
    await expect(drive(store, agentThenAgent, provider)).rejects.toThrow('read failed');
    const run = await onlyRun(store);
    const snaps = executionEvidence(run, 'draft');
    expect(snaps).toHaveLength(1);
    expect((snaps[0]!.diagnostics?.cache?.requests ?? []).map((r) => r.prompt_tokens)).toEqual([
      1000, 2000,
    ]);
    const entries = run.drive_failures?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain('read failed');
    expect('usage' in entries[0]!).toBe(false);
  });

  // D4 rests on this: every store failure inside `executeChain` AFTER a step was saved comes back
  // as an error ENVELOPE, never a throw. If this cell ever turns red, a throw now leaves
  // `executeChain` after a save, and D4 needs a double-count guard again.
  it.each(['claimStep', 'settleStep'] as const)(
    'cell 7 — the invariant D4 rests on: the auto step %s failing once never throws out of executeChain',
    async (method) => {
      quiet();
      class FaultStore extends InMemoryStore {
        private fired = false;
        override async claimStep(
          ...args: Parameters<InMemoryStore['claimStep']>
        ): ReturnType<InMemoryStore['claimStep']> {
          if (method === 'claimStep' && !this.fired && args[1] === 'finish') {
            this.fired = true;
            throw new Error('claim failed');
          }
          return super.claimStep(...args);
        }
        override async settleStep(
          ...args: Parameters<InMemoryStore['settleStep']>
        ): ReturnType<InMemoryStore['settleStep']> {
          const delta = args[1];
          if (
            method === 'settleStep' &&
            !this.fired &&
            delta.kind === 'settle_step' &&
            delta.step === 'finish'
          ) {
            this.fired = true;
            throw new Error('settle failed');
          }
          return super.settleStep(...args);
        }
      }
      const store = new FaultStore();
      const { provider } = scriptedProvider([
        { output: 'BAD', prompt: 1000, out: 100 },
        { output: 'OK', prompt: 2000, out: 200 },
      ]);
      await expect(drive(store, agentThenAuto, provider)).resolves.toBeDefined();
      const run = await onlyRun(store);
      const snaps = executionEvidence(run, 'draft');
      expect(snaps).toHaveLength(1);
      expect((snaps[0]!.diagnostics?.cache?.requests ?? []).map((r) => r.prompt_tokens)).toEqual([
        1000, 2000,
      ]);
      expect(run.drive_failures).toBeUndefined();
    },
  );
});

describe('issue #600 — appendRequests', () => {
  const req = (index: number, prompt: number): UsageRecord => ({
    request_index: index,
    request_start: `2026-09-27T00:00:0${String(prompt % 10)}.000Z`,
    prompt_tokens: prompt,
  });

  it('both undefined stays undefined', () => {
    expect(appendRequests(undefined, undefined)).toBeUndefined();
  });

  it('prior comes first, then next — the order is wire order', () => {
    const result = appendRequests([req(0, 11), req(1, 12)], [req(0, 13)]);
    expect(result.map((r) => r.prompt_tokens)).toEqual([11, 12, 13]);
  });

  it('every entry is re-based to its position in the result', () => {
    const result = appendRequests([req(0, 11)], [req(0, 12), req(0, 13)]);
    expect(result.map((r) => r.request_index)).toEqual([0, 1, 2]);
  });

  it('an absent side is treated as empty', () => {
    expect(appendRequests(undefined, [req(5, 12)]).map((r) => r.request_index)).toEqual([0]);
    expect(appendRequests([req(7, 11)], undefined).map((r) => r.request_index)).toEqual([0]);
  });

  it('every other field is copied unchanged', () => {
    const full: UsageRecord = {
      request_index: 4,
      request_start: '2026-09-27T01:02:03.000Z',
      prompt_tokens: 900,
      uncached_input_tokens: 100,
      cache_read_input_tokens: 700,
      cache_creation_input_tokens: 100,
      cache_write_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 },
      output_tokens: 12,
    };
    const [copy] = appendRequests([full], []);
    expect(copy!.request_start).toBe(full.request_start);
    expect(copy!.prompt_tokens).toBe(full.prompt_tokens);
    expect(copy!.uncached_input_tokens).toBe(full.uncached_input_tokens);
    expect(copy!.cache_read_input_tokens).toBe(full.cache_read_input_tokens);
    expect(copy!.cache_creation_input_tokens).toBe(full.cache_creation_input_tokens);
    expect(copy!.cache_write_tokens).toBe(full.cache_write_tokens);
    expect(copy!.cache_creation).toEqual(full.cache_creation);
    expect(copy!.output_tokens).toBe(full.output_tokens);
  });

  it('neither input array is mutated', () => {
    const prior = Object.freeze([Object.freeze(req(3, 11))]);
    const next = Object.freeze([Object.freeze(req(3, 12))]);
    expect(() => appendRequests(prior, next)).not.toThrow();
    expect(prior.map((r) => r.request_index)).toEqual([3]);
    expect(next.map((r) => r.request_index)).toEqual([3]);
    expect(prior).toHaveLength(1);
    expect(next).toHaveLength(1);
  });
});
