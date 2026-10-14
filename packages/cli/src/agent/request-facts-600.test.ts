// request-facts-600.test.ts — issue #600 PR 2 (C4, A3 b; G11, G12): `realm agent` stamps each
// request with the provider that served it, over anything an adapter or a provider module wrote,
// and bounds the request names on a failed drive's usage before the write. Every cell drives
// `runAgent` in-process and reads the STORED record, never a render. On a failing CI host each cell
// prints the stored requests' `provider` and `model` fields: test values only.
import { describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunRecord,
  type StepDefinition,
  type UsageRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import {
  LlmProvider,
  type CallStepWithMetaResult,
  type ProviderCapabilities,
} from './providers/llm-provider.js';

const DEF: WorkflowDefinition = {
  id: 'request-facts-600',
  name: 'request-facts-600',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { ask: { description: 'Ask.', execution: 'agent' } as StepDefinition },
};

const request = (extra: Record<string, unknown>): UsageRecord =>
  ({
    request_index: 0,
    request_start: '2026-10-14T00:00:00.000Z',
    prompt_tokens: 10,
    ...extra,
  }) as UsageRecord;

/**
 * One drive of DEF. The provider declares `providerId` when given, answers with `usage`, or — when
 * `throwWith` is given — throws an error carrying it as billed usage (the chokepoint's input).
 */
async function drive(opts: {
  providerId?: ProviderCapabilities['providerId'];
  moduleProviderId?: `module:${string}`;
  usage?: unknown[];
  throwWith?: unknown[];
}): Promise<RunRecord> {
  const store = new InMemoryStore();
  const provider = new (class extends LlmProvider {
    override capabilities(): ProviderCapabilities {
      return {
        jsonMode: false,
        ...(opts.providerId !== undefined ? { providerId: opts.providerId } : {}),
      };
    }
    async callStep(): Promise<Record<string, unknown>> {
      return {};
    }
    override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
      if (opts.throwWith !== undefined) {
        throw Object.assign(new Error('the model call failed'), {
          driveCall: { usage: opts.throwWith },
        });
      }
      return { output: {}, usage: opts.usage as UsageRecord[] };
    }
  })();
  for (const kind of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, kind).mockImplementation(() => {});
  }
  try {
    await runAgent(
      {
        store,
        workflowStore: {
          async register() {},
          async get() {
            return DEF;
          },
          async list() {
            return [DEF];
          },
        },
        provider,
        ...(opts.moduleProviderId !== undefined ? { providerId: opts.moduleProviderId } : {}),
        registry: createDefaultRegistry(),
      },
      { definition: DEF, params: {} },
    );
  } finally {
    vi.restoreAllMocks();
  }
  return store.get((await store.list())[0]!.id);
}

const stepRequests = (run: RunRecord) =>
  (run.evidence.find((e) => e.step_id === 'ask')?.diagnostics?.cache?.requests ?? []) as unknown[];
const failureUsage = (run: RunRecord) => (run.drive_failures?.entries[0]?.usage ?? []) as unknown[];
const pick = (requests: unknown[], field: string) =>
  requests.map((r) =>
    r !== null && typeof r === 'object' ? (r as Record<string, unknown>)[field] : r,
  );

describe('the provider on each request, stamped by realm agent (issue #600 PR 2, C4)', () => {
  // G11, step evidence. (a) red when the stamp at the step's usage is removed; (b) prints the
  // stored providers.
  it("a step's requests carry the provider's own id, over what the adapter wrote", async () => {
    const run = await drive({
      providerId: 'anthropic',
      usage: [request({ provider: 'adapter-wrote-this' }), request({ request_index: 1 })],
    });
    expect(pick(stepRequests(run), 'provider')).toEqual(['anthropic', 'anthropic']);
  });

  it("a provider module's requests carry module:<file>", async () => {
    const run = await drive({ moduleProviderId: 'module:p.mjs', usage: [request({})] });
    expect(pick(stepRequests(run), 'provider')).toEqual(['module:p.mjs']);
  });

  // G11, drive failure. (a) red when recordDriveFailure does not stamp; (b) prints the stored
  // providers.
  it("a failed drive's usage carries the entry's provider, over what the adapter wrote", async () => {
    const run = await drive({
      providerId: 'openai',
      throwWith: [request({ provider: 'adapter-wrote-this' })],
    });
    expect({
      entry: run.drive_failures?.entries[0]?.provider,
      usage: pick(failureUsage(run), 'provider'),
    }).toEqual({
      entry: 'openai',
      usage: ['openai'],
    });
  });

  it("guard: a failed drive whose provider is 'unknown' stamps none", async () => {
    const run = await drive({ throwWith: [request({})] });
    expect({
      entry: run.drive_failures?.entries[0]?.provider,
      usage: pick(failureUsage(run), 'provider'),
    }).toEqual({
      entry: 'unknown',
      usage: [undefined],
    });
  });
});

describe("a failed drive's usage is bounded before the write (issue #600 PR 2, A3 b)", () => {
  // G12. (a) red when recordDriveFailure does not bound the usage; (b) prints the stored models.
  it('a model with ESC is not stored in drive_failures; a trailing newline is trimmed', async () => {
    const run = await drive({
      providerId: 'anthropic',
      throwWith: [
        request({ model: 'claude-\u001b[31mx' }),
        request({ request_index: 1, model: 'claude-y\n' }),
      ],
    });
    expect(pick(failureUsage(run), 'model')).toEqual([undefined, 'claude-y']);
  });

  // G12. (a) red when the stamp spreads every entry (the `null` becomes `{ provider }`), or the
  // write loses the record; (b) prints the stored usage.
  it("a provider module's null entry is stored as null, and the record is not lost", async () => {
    const run = await drive({
      moduleProviderId: 'module:p.mjs',
      throwWith: [null, request({ request_index: 1 })],
    });
    expect(run.drive_failures?.total).toBe(1);
    expect(failureUsage(run)).toEqual([
      null,
      { ...request({ request_index: 1 }), provider: 'module:p.mjs' },
    ]);
  });
});
