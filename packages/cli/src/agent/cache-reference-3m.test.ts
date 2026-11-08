// cache-reference-3m.test.ts — caching 3-M piece A-1 at the driver: when a step's first request in a
// drive has an earlier request of the same step on the run's own record (an earlier drive that failed
// the step, or a step resumed and driven again), that request carries `reference`, a copy of the
// earlier request's facts, `from: 'run'`; every other request carries none (its predecessor is an
// earlier entry of the same list). Piece A-1b: the earlier request is the first request of the
// step's last call on the record, found by its `request_in_call` 0. Driven through the real
// `runAgent` against the real `InMemoryStore`, with a scripted provider double; a later drive
// re-attaches with `existingRunId` (`realm agent --run-id`) and a failed step is reopened with
// `applyResume` (`realm run resume`).
// Every value is a fake. Each assertion names (a) the change that turns it red and (b) what it prints
// when it fails: the request ids and the `reference` objects compared, never a prompt's text.
import { describe, it, expect, vi } from 'vitest';
import type { RunRecord, UsageRecord, WorkflowDefinition } from '@sensigo/realm';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  applyResume,
  createDefaultRegistry,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { runAgent } from './run-agent.js';
import { ToolCapableLlmProvider } from './providers/llm-provider.js';
import type { McpClient, McpTool, StepWithToolsResult } from './mcp/mcp-extensions.js';

/**
 * The request a drive bills and the record keeps — the shape Anthropic's adapter returns for a
 * split single-shot request (the counters `toUsageRecord` maps, the ask `requestFacts` writes, the
 * split's facts `anthropicSplitFacts` writes: no `format` part, `prefix_sha256` equal to
 * `prefix_parts.prompt`), as `inspect-split-3b.test.ts` records it. `provider` is not here: the
 * driver stamps it.
 */
const PROMPT_HEAD = 'c'.repeat(64);
const billed = (second: number, prompt: number): UsageRecord => ({
  request_index: 0,
  request_start: `2026-11-08T10:00:${String(second).padStart(2, '0')}.000Z`,
  prompt_tokens: prompt,
  uncached_input_tokens: 20,
  cache_read_input_tokens: prompt - 1520,
  cache_creation_input_tokens: 1500,
  output_tokens: 7,
  cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 0 },
  model: 'claude-test-20260101',
  cache_requested: 'lifetime',
  cache_lifetime_s: 300,
  cache_ttl_sent: false,
  cache_requested_source: 'runner_default',
  cache_requested_by: 'realm agent',
  endpoint: 'default',
  cache_split_offered: true,
  prefix_sha256: PROMPT_HEAD,
  prefix_chars: 4000,
  prefix_parts: { system: 'b'.repeat(64), prompt: PROMPT_HEAD },
  cache_marked: ['system', 'prompt'],
  request_strict_sent: false,
});

/** The fields `CacheReference` copies, read off a stored request: what a reference to it holds. */
const referenceTo = (stored: UsageRecord) => ({
  from: 'run',
  request_start: stored.request_start,
  request_id: stored.request_id,
  provider: stored.provider,
  model: stored.model,
  endpoint: stored.endpoint,
  cache_requested: stored.cache_requested,
  cache_read_input_tokens: stored.cache_read_input_tokens,
  cache_creation_input_tokens: stored.cache_creation_input_tokens,
  cache_creation: stored.cache_creation,
  cache_lifetime_s: stored.cache_lifetime_s,
  cache_ttl_sent: stored.cache_ttl_sent,
  prefix_chars: stored.prefix_chars,
  prefix_parts: stored.prefix_parts,
  cache_marked: stored.cache_marked,
  request_strict_sent: stored.request_strict_sent,
});

type Call =
  | { output: Record<string, unknown>; usage?: UsageRecord[]; toolCalls?: number }
  | { throw: true; usage?: UsageRecord[] };

/** A provider double: each model call, tools or single-shot, answers the next scripted call. */
function scripted(calls: Call[]) {
  let n = 0;
  const next = (): Call => {
    const call = calls[n];
    n += 1;
    if (call === undefined) throw new Error(`unscripted call ${String(n)}`);
    return call;
  };
  const thrown = (usage: UsageRecord[] | undefined): Error => {
    const err = new Error('the model service went away');
    if (usage !== undefined) Object.assign(err, { driveCall: { usage } });
    return err;
  };
  const provider = new (class extends ToolCapableLlmProvider {
    // As an in-repo provider does: it names itself, and the driver stamps the name on its requests.
    capabilities() {
      return { jsonMode: false, providerId: 'anthropic' as const };
    }
    callStep = vi.fn();
    async callStepWithMeta() {
      const call = next();
      if ('throw' in call) throw thrown(call.usage);
      return { output: call.output, ...(call.usage !== undefined ? { usage: call.usage } : {}) };
    }
    async callStepWithTools(): Promise<StepWithToolsResult> {
      const call = next();
      if ('throw' in call) throw thrown(call.usage);
      return {
        output: call.output,
        toolCalls: Array.from({ length: call.toolCalls ?? 0 }, () => ({
          server_id: 'srv',
          tool: 't',
          args: {},
          result: 'ok',
          duration_ms: 1,
        })),
        ...(call.usage !== undefined ? { usage: call.usage } : {}),
      };
    }
  })();
  return { provider, calls: () => n };
}

const client: McpClient = {
  async connect() {},
  async getTools(_serverId: string, allowList: string[]): Promise<McpTool[]> {
    return allowList.map((name) => ({
      name,
      description: 'A tool',
      inputSchema: { type: 'object' },
    }));
  },
  async call() {
    return { result: 'ok' };
  },
  async disconnect() {},
};

/** One agent step `draft` (single-shot, `OK` passes its schema) or `classify` (tools); `extra` adds
 *  to the step. */
function workflow(
  kind: 'single' | 'tools',
  extra: Record<string, unknown> = {},
): WorkflowDefinition {
  const step =
    kind === 'single'
      ? {
          draft: {
            description: 'Draft',
            execution: 'agent',
            output_schema: {
              type: 'object',
              properties: { status: { type: 'string', enum: ['OK'] } },
              required: ['status'],
            },
            ...extra,
          },
        }
      : {
          classify: {
            description: 'Classify',
            execution: 'agent',
            tools: ['srv:t'],
            output_schema: {
              type: 'object',
              additionalProperties: false,
              required: ['category'],
              properties: { category: { type: 'string' } },
            },
            ...extra,
          },
        };
  return {
    id: `reference-3m-${kind}`,
    name: 'reference 3-M',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    ...(kind === 'tools'
      ? {
          mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
        }
      : {}),
    steps: step,
  } as unknown as WorkflowDefinition;
}

/** One drive of `def` on `store` (a re-attach when `runId` is given); returns the run after it and
 *  the number of model calls the drive made. */
async function drive(
  store: InMemoryStore,
  def: WorkflowDefinition,
  calls: Call[],
  runId?: string,
): Promise<{ run: RunRecord; calls: number }> {
  const { provider, calls: made } = scripted(calls);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await runAgent(
      {
        store,
        workflowStore: {
          async register() {},
          async get() {
            return def;
          },
          async list() {
            return [def];
          },
        },
        provider,
        registry: createDefaultRegistry(),
        mcpClientFactory: () => client,
      },
      { definition: def, params: {}, ...(runId !== undefined ? { existingRunId: runId } : {}) },
    );
  } finally {
    vi.restoreAllMocks();
  }
  const id = runId ?? (await store.list()).snapshots[0]!.record.id;
  return { run: (await store.get(id)).record, calls: made() };
}

/** `realm run resume <run> <step>`: reopens the failed step on the stored run. */
async function resume(store: InMemoryStore, runId: string, step: string, def: WorkflowDefinition) {
  const { record } = await store.get(runId);
  await store.update(applyResume(record, step, def).run);
}

/** A step that settles failed at its first rejected answer (the #220 threshold of 1, `fail`). */
const FAILS_AT_ONCE = { validation_exhaustion: { threshold: 1, mode: 'fail' } };

/** A stored request's id and `reference`, the two things each check compares. */
const idAndReference = (r: UsageRecord | undefined) => ({
  id: r?.request_id,
  reference: r?.reference,
});

/** The step's requests on its latest evidence entry, and on its latest drive-failure entry. */
const lastEvidenceRequests = (run: RunRecord, step: string): UsageRecord[] =>
  run.evidence.filter((e) => e.step_id === step).at(-1)?.diagnostics?.cache?.requests ?? [];
const lastFailureRequests = (run: RunRecord, step: string): UsageRecord[] =>
  (run.drive_failures?.entries ?? []).filter((f) => f.step === step).at(-1)?.usage ?? [];

describe('caching 3-M A-1 — a drive re-attached after a drive failed the step', () => {
  it('check 1: its first request carries the stored request as `reference`, `from: run`; its second request carries none', async () => {
    const store = new InMemoryStore();
    const def = workflow('single');
    const failed = await drive(store, def, [{ throw: true, usage: [billed(1, 2000)] }]);
    const before = lastFailureRequests(failed.run, 'draft')[0]!;
    const again = await drive(
      store,
      def,
      [{ output: { status: 'OK' }, usage: [billed(5, 2010), billed(6, 2020)] }],
      failed.run.id,
    );
    const [first, second] = lastEvidenceRequests(again.run, 'draft');
    // (a) red when the driver does not look up the first request of the step's last call on the
    //     record (no reference), or puts one on every arriving request (the second's); (b) prints
    //     the ids and the references compared.
    expect({ first: idAndReference(first), second: idAndReference(second) }).toEqual({
      first: { id: expect.any(String), reference: referenceTo(before) },
      second: { id: expect.any(String), reference: undefined },
    });
  });

  it('check 1: a repair on that drive — the second call’s first request carries none', async () => {
    const store = new InMemoryStore();
    const def = workflow('single');
    const failed = await drive(store, def, [{ throw: true, usage: [billed(1, 2000)] }]);
    const before = lastFailureRequests(failed.run, 'draft')[0]!;
    const again = await drive(
      store,
      def,
      [
        { output: { status: 'BAD' }, usage: [billed(5, 2010)] },
        { output: { status: 'OK' }, usage: [billed(7, 2030)] },
      ],
      failed.run.id,
    );
    const requests = lastEvidenceRequests(again.run, 'draft');
    // Two mechanisms keep the second call's request clean: the driver looks the record up only
    // while the step holds no request of the drive, and `attachRecordedReference` gives none when
    // `prior` is non-empty. (a) red when both are dropped (the record consulted at every call);
    // (b) prints the calls made, the ids and the references.
    expect({ calls: again.calls, requests: requests.map(idAndReference) }).toEqual({
      calls: 2,
      requests: [
        { id: expect.any(String), reference: referenceTo(before) },
        { id: expect.any(String), reference: undefined },
      ],
    });
  });
});

describe('caching 3-M A-1 — a resumed step', () => {
  it('check 2: settled failed with its request on the evidence entry, resumed, driven again — its first request references that request', async () => {
    const store = new InMemoryStore();
    const def = workflow('tools', FAILS_AT_ONCE);
    const settled = await drive(store, def, [
      { output: {}, toolCalls: 1, usage: [billed(1, 2000)] },
    ]);
    const failedEntry = settled.run.evidence.filter((e) => e.step_id === 'classify').at(-1);
    // fixture: `fail` settles the step failed — the step in `failed_steps`, its entry's status
    // `error` — with its request on the entry (verify-first, A3MA1-34).
    expect({
      failed: settled.run.failed_steps,
      status: failedEntry?.status,
      requests: failedEntry?.diagnostics?.cache?.requests.length,
    }).toEqual({ failed: ['classify'], status: 'error', requests: 1 });
    const before = lastEvidenceRequests(settled.run, 'classify')[0]!;
    await resume(store, settled.run.id, 'classify', def);
    const again = await drive(
      store,
      def,
      [{ output: { category: 'billing' }, toolCalls: 1, usage: [billed(5, 2010)] }],
      settled.run.id,
    );
    const [first] = lastEvidenceRequests(again.run, 'classify');
    // (a) red when the lookup reads the drive failures only; (b) prints the id and the reference.
    expect(idAndReference(first)).toEqual({
      id: expect.any(String),
      reference: referenceTo(before),
    });
  });
});

describe('caching 3-M A-1 — both an evidence entry and a drive failure on the record', () => {
  it('check 3: settled failed, resumed, then a drive failed it mid-call — the next drive references the drive failure’s request', async () => {
    const store = new InMemoryStore();
    const def = workflow('tools', FAILS_AT_ONCE);
    const settled = await drive(store, def, [
      { output: {}, toolCalls: 1, usage: [billed(1, 2000)] },
    ]);
    await resume(store, settled.run.id, 'classify', def);
    const failed = await drive(
      store,
      def,
      [{ throw: true, usage: [billed(3, 2005)] }],
      settled.run.id,
    );
    const before = lastFailureRequests(failed.run, 'classify')[0]!;
    const again = await drive(
      store,
      def,
      [{ output: { category: 'billing' }, toolCalls: 1, usage: [billed(5, 2010)] }],
      settled.run.id,
    );
    const [first] = lastEvidenceRequests(again.run, 'classify');
    // (a) red when the evidence entry is always preferred; (b) prints the id, the reference, the
    //     failure's evidence count and where the failed entry sits.
    expect({
      first: idAndReference(first),
      failureCount: failed.run.drive_failures?.entries.at(-1)?.evidence_count,
      failedEntryAt: failed.run.evidence.findIndex(
        (e) => e.step_id === 'classify' && e.status === 'error',
      ),
    }).toEqual({
      first: { id: expect.any(String), reference: referenceTo(before) },
      failureCount: 1,
      failedEntryAt: 0,
    });
  });

  it('check 3, the mirror: a drive failed the step, a re-attach settled it failed, resumed — the next drive references the evidence entry’s request', async () => {
    const store = new InMemoryStore();
    const def = workflow('tools', FAILS_AT_ONCE);
    const failed = await drive(store, def, [{ throw: true, usage: [billed(1, 2000)] }]);
    const settled = await drive(
      store,
      def,
      [{ output: {}, toolCalls: 1, usage: [billed(3, 2005)] }],
      failed.run.id,
    );
    const before = lastEvidenceRequests(settled.run, 'classify')[0]!;
    await resume(store, failed.run.id, 'classify', def);
    const again = await drive(
      store,
      def,
      [{ output: { category: 'billing' }, toolCalls: 1, usage: [billed(5, 2010)] }],
      failed.run.id,
    );
    const [first] = lastEvidenceRequests(again.run, 'classify');
    // (a) red when the drive failure is always preferred; (b) prints the id, the reference, the
    //     failure's evidence count and where the failed entry sits.
    expect({
      first: idAndReference(first),
      failureCount: settled.run.drive_failures?.entries.at(-1)?.evidence_count,
      failedEntryAt: settled.run.evidence.findIndex(
        (e) => e.step_id === 'classify' && e.status === 'error',
      ),
    }).toEqual({
      first: { id: expect.any(String), reference: referenceTo(before) },
      failureCount: 0,
      failedEntryAt: 0,
    });
  });
});

describe('caching 3-M A-1 — a failed first call on a re-attached drive', () => {
  for (const kind of ['tools', 'single'] as const) {
    const step = kind === 'tools' ? 'classify' : 'draft';
    const which =
      kind === 'tools'
        ? 'chokepoint (1), the tools catch'
        : 'chokepoint (2), the single-shot catch';
    it(`check 4: ${which} — the new drive-failure entry's first request carries the earlier failure's request`, async () => {
      const store = new InMemoryStore();
      const def = workflow(kind);
      const failed = await drive(store, def, [{ throw: true, usage: [billed(1, 2000)] }]);
      const before = lastFailureRequests(failed.run, step)[0]!;
      const again = await drive(
        store,
        def,
        [{ throw: true, usage: [billed(5, 2010)] }],
        failed.run.id,
      );
      const entries = (again.run.drive_failures?.entries ?? []).filter((f) => f.step === step);
      // (a) red when this catch does not attach the reference; (b) prints the entry count, the
      //     new entry's first request id and its reference.
      expect({
        entries: entries.length,
        first: idAndReference(entries.at(-1)?.usage?.[0]),
      }).toEqual({
        entries: 2,
        first: { id: expect.any(String), reference: referenceTo(before) },
      });
    });
  }
});

describe('caching 3-M A-1 — a re-attached drive on a step that declares strict structured output', () => {
  it('check 1 on a strict step (S2): its first request carries the drive failure’s request as `reference`', async () => {
    const store = new InMemoryStore();
    const def = workflow('single', { structured_output: 'strict' });
    const failed = await drive(store, def, [{ throw: true, usage: [billed(1, 2000)] }]);
    const before = lastFailureRequests(failed.run, 'draft')[0]!;
    const again = await drive(
      store,
      def,
      [{ output: { status: 'OK' }, usage: [billed(5, 2010)] }],
      failed.run.id,
    );
    const entry = again.run.evidence.filter((e) => e.step_id === 'draft').at(-1);
    const [first] = entry?.diagnostics?.cache?.requests ?? [];
    // `strict` is the fixture: on a single-shot step only the strict branch (S2) writes the
    // structured-output disclosure, so `requested: true` says this call went through S2.
    // (a) red when S2 does not attach the reference, or when the call stops reaching S2; (b) prints
    //     the disclosure's `requested`, the id and the reference.
    expect({
      strict: entry?.diagnostics?.structured_output?.requested,
      first: idAndReference(first),
    }).toEqual({
      strict: true,
      first: { id: expect.any(String), reference: referenceTo(before) },
    });
  });
});

/** Two single-shot agent steps: `draft`, then `review`, which depends on it; `OK` passes each. */
function twoSteps(): WorkflowDefinition {
  const output_schema = {
    type: 'object',
    properties: { status: { type: 'string', enum: ['OK'] } },
    required: ['status'],
  };
  return {
    id: 'reference-3m-two-steps',
    name: 'reference 3-M, two steps',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      draft: { description: 'Draft', execution: 'agent', output_schema },
      review: { description: 'Review', execution: 'agent', depends_on: ['draft'], output_schema },
    },
  } as unknown as WorkflowDefinition;
}

describe('caching 3-M A-1 — a multi-step run: the copy comes from the same step', () => {
  it('the same step only: after a drive failed the first step, the re-attached drive’s first request on that step references it, and the second step’s first request carries none', async () => {
    const store = new InMemoryStore();
    const def = twoSteps();
    const failed = await drive(store, def, [{ throw: true, usage: [billed(1, 2000)] }]);
    const before = lastFailureRequests(failed.run, 'draft')[0]!;
    const again = await drive(
      store,
      def,
      [
        { output: { status: 'OK' }, usage: [billed(5, 2010)] },
        { output: { status: 'OK' }, usage: [billed(8, 2040)] },
      ],
      failed.run.id,
    );
    const [draftFirst] = lastEvidenceRequests(again.run, 'draft');
    const [reviewFirst] = lastEvidenceRequests(again.run, 'review');
    // (a) red when the lookup stops matching the step on the evidence entries (the second step gets
    //     the first step's settled request) or on the drive failures (it gets the first step's
    //     failed request); `review`'s id says its request is there, so its `undefined` is not an
    //     absent request; (b) prints the calls made, the ids and the references.
    expect({
      calls: again.calls,
      draft: idAndReference(draftFirst),
      review: idAndReference(reviewFirst),
    }).toEqual({
      calls: 2,
      draft: { id: expect.any(String), reference: referenceTo(before) },
      review: { id: expect.any(String), reference: undefined },
    });
  });
});

/** Caching 3-M (piece A-1b): each stored request's `request_index`, `request_in_call` and id, what
 *  check 3's cells print about the list a reference was taken from. */
const places = (requests: UsageRecord[]) =>
  requests.map((r) => ({ index: r.request_index, in_call: r.request_in_call, id: r.request_id }));

describe('caching 3-M A-1b — the copy across drives is the first request of the step’s last call', () => {
  it('check 3 (a): a tool step whose drive failed after two turns and its final request — the re-attached drive references the FIRST turn', async () => {
    const store = new InMemoryStore();
    const def = workflow('tools');
    // One call's three requests: two main turns, then the final request (one array, one call),
    // numbered as a provider numbers its own array (on a drive's first call no append re-bases them).
    const failed = await drive(store, def, [
      {
        throw: true,
        usage: [
          billed(1, 2000),
          { ...billed(2, 2010), request_index: 1 },
          { ...billed(3, 2020), request_index: 2 },
        ],
      },
    ]);
    const earlier = lastFailureRequests(failed.run, 'classify');
    const again = await drive(
      store,
      def,
      [{ output: { category: 'billing' }, toolCalls: 1, usage: [billed(5, 2030)] }],
      failed.run.id,
    );
    const [first] = lastEvidenceRequests(again.run, 'classify');
    // (a) red when the lookup takes the list's last request (A-1's pick: the final request); (b)
    //     prints the earlier list's indexes, places and ids, and the new request's id and reference.
    expect({ earlier: places(earlier), first: idAndReference(first) }).toEqual({
      earlier: [
        { index: 0, in_call: 0, id: expect.any(String) },
        { index: 1, in_call: 1, id: expect.any(String) },
        { index: 2, in_call: 2, id: expect.any(String) },
      ],
      first: { id: expect.any(String), reference: referenceTo(earlier[0]!) },
    });
  });

  it('check 3 (b): an earlier drive whose list holds two calls (a repair, then a failure) — the reference is the SECOND call’s first request', async () => {
    const store = new InMemoryStore();
    const def = workflow('tools');
    const failed = await drive(store, def, [
      // The first call runs no tool and its answer is rejected (a call that ran a tool is never
      // repaired); the repair call throws after two requests.
      { output: {}, usage: [billed(1, 2000), billed(2, 2010)] },
      { throw: true, usage: [billed(3, 2020), billed(4, 2030)] },
    ]);
    const earlier = lastFailureRequests(failed.run, 'classify');
    const again = await drive(
      store,
      def,
      [{ output: { category: 'billing' }, toolCalls: 1, usage: [billed(5, 2040)] }],
      failed.run.id,
    );
    const [first] = lastEvidenceRequests(again.run, 'classify');
    // (a) red when the lookup takes the list's first call opener instead of its last; (b) prints
    //     the earlier list's indexes, places and ids, and the new request's id and reference.
    expect({ earlier: places(earlier), first: idAndReference(first) }).toEqual({
      earlier: [
        { index: 0, in_call: 0, id: expect.any(String) },
        { index: 1, in_call: 1, id: expect.any(String) },
        { index: 2, in_call: 0, id: expect.any(String) },
        { index: 3, in_call: 1, id: expect.any(String) },
      ],
      first: { id: expect.any(String), reference: referenceTo(earlier[2]!) },
    });
  });

  it('check 3 (c): a recorded list with no `request_in_call` anywhere (recorded before A-1b) — no reference', async () => {
    const store = new InMemoryStore();
    const def = workflow('tools');
    const failed = await drive(store, def, [{ throw: true, usage: [billed(1, 2000)] }]);
    // The stored entry's requests lose `request_in_call`, as a request recorded before this piece
    // has none; written back the way the file's `resume` helper writes.
    const { record } = await store.get(failed.run.id);
    await store.update({
      ...record,
      drive_failures: {
        ...record.drive_failures!,
        entries: record.drive_failures!.entries.map((f) =>
          f.usage === undefined
            ? f
            : { ...f, usage: f.usage.map(({ request_in_call: _gone, ...rest }) => rest) },
        ),
      },
    });
    const again = await drive(
      store,
      def,
      [{ output: { category: 'billing' }, toolCalls: 1, usage: [billed(5, 2030)] }],
      failed.run.id,
    );
    const earlier = lastFailureRequests(again.run, 'classify');
    const [first] = lastEvidenceRequests(again.run, 'classify');
    // (a) red when an absent `request_in_call` is read as 0 (the old request becomes the copy);
    //     (b) prints the earlier list's indexes, places and ids, and the new request's id and
    //     reference.
    expect({ earlier: places(earlier), first: idAndReference(first) }).toEqual({
      earlier: [{ index: 0, in_call: undefined, id: expect.any(String) }],
      first: { id: expect.any(String), reference: undefined },
    });
  });
});
