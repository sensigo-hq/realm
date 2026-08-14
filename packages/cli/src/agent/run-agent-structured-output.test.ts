// run-agent-structured-output.test.ts — issue #236, Deliverable 10: end-to-end runAgent()
// orchestration pins for structured_output — eligible/ineligible disclosure, the third-party
// provider_unsupported synthesis rule (never external_agent), and sticky-downgrade across
// separate callStepWithMeta invocations for the same step (the provider's OWN internal ladder
// retry is covered at the provider level — anthropic-provider-structured-output.test.ts).
// issue #332 item 6 also lives here: the tools-fork misattribution fix — a strict-declared,
// tools-bearing step now discloses `unsupported_context_tools` (realm's own agent DID drive this
// step, just via a path that structurally cannot honor strict), never the `external_agent`
// stamp (which claims realm made no request at all). The OTHER boundary of that fix — a
// genuinely external MCP-driven step still gets `external_agent` — is unaffected by this change
// (the tools fork is never reached by an external caller) and is already pinned at the
// execution-loop level: structured-output-evidence.test.ts's "a declared step with NO
// stepMeta.structuredOutput at all gets the external_agent stamp".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAgent } from './run-agent.js';
import type { WorkflowDefinition, StructuredOutputMeta } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { LlmProvider, ToolCapableLlmProvider } from './providers/llm-provider.js';
import type { McpClient, McpTool } from './mcp/mcp-extensions.js';

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

function makeToolUseResponse(input: Record<string, unknown>) {
  return { content: [{ type: 'tool_use', id: 'submit1', name: '__realm_submit__', input }] };
}

function makeWorkflowStore(def: WorkflowDefinition) {
  return {
    async register() {},
    async get() {
      return def;
    },
    async list() {
      return [def];
    },
  };
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

function eligibleDef(): WorkflowDefinition {
  return {
    id: 'so-eligible-wf',
    name: 'SO Eligible',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      classify: {
        description: 'Classify',
        execution: 'agent',
        structured_output: 'strict',
        output_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['category'],
          properties: { category: { type: 'string' } },
        },
      },
    },
  };
}

function ineligibleDef(): WorkflowDefinition {
  return {
    id: 'so-ineligible-wf',
    name: 'SO Ineligible',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      classify: {
        description: 'Classify',
        execution: 'agent',
        structured_output: 'strict',
        output_schema: {
          // additionalProperties: false deliberately OMITTED — G1 ineligible.
          type: 'object',
          required: ['category'],
          properties: { category: { type: 'string' } },
        },
      },
    },
  };
}

function lastEvidenceMeta(run: {
  evidence: { diagnostics?: { structured_output?: StructuredOutputMeta } }[];
}): StructuredOutputMeta | undefined {
  return run.evidence.at(-1)?.diagnostics?.structured_output;
}

describe('runAgent — structured_output orchestration (issue #236)', () => {
  beforeEach(() => mockCreate.mockReset());

  it('eligible + opted-in: strict is sent, evidence discloses sent:true', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
    const def = eligibleDef();
    const store = new InMemoryStore();
    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider: new AnthropicProvider('claude-sonnet-4-5'),
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );
    expect(result).toBe('completed');
    expect(mockCreate.mock.calls[0]![0].tools[0]).toMatchObject({ strict: true });

    const runs = await store.list();
    const meta = lastEvidenceMeta(runs[0]!);
    expect(meta).toMatchObject({ requested: true, sent: true });
  });

  it('ineligible + opted-in: strict is NEVER sent, the run still completes (degrade loudly, not strand), evidence discloses gate_ineligible', async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
    const def = ineligibleDef();
    const store = new InMemoryStore();
    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider: new AnthropicProvider('claude-sonnet-4-5'),
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );
    expect(result).toBe('completed');
    expect(mockCreate.mock.calls[0]![0].tools[0]).not.toHaveProperty('strict');

    const runs = await store.list();
    const meta = lastEvidenceMeta(runs[0]!);
    expect(meta).toEqual({ requested: true, sent: false, downgrade_reason: 'gate_ineligible' });
  });

  it('a third-party provider (base LlmProvider, callStep only) ⇒ provider_unsupported, NEVER external_agent [R2-3 synthesis rule]', async () => {
    const def = eligibleDef();
    const store = new InMemoryStore();
    const thirdPartyProvider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ category: 'billing' });
    })();

    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider: thirdPartyProvider,
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );
    expect(result).toBe('completed');
    expect(thirdPartyProvider.callStep).toHaveBeenCalledTimes(1);

    const runs = await store.list();
    const meta = lastEvidenceMeta(runs[0]!);
    expect(meta).toEqual({
      requested: true,
      sent: false,
      downgrade_reason: 'provider_unsupported',
    });
    expect(meta?.downgrade_reason).not.toBe('external_agent');
  });

  it('sticky downgrade: once a step downgrades, the NEXT independent callStepWithMeta invocation for the SAME step never re-sends strict, and its meta repeats the ORIGINAL reason/message', async () => {
    // Two-step workflow so the SAME step name ('classify') can be attempted twice across the
    // drive: step 1 downgrades via a live 400 (with the ladder's own recovery), step 2 is a
    // SEPARATE agent step of a DIFFERENT name feeding back into a THIRD step also named
    // differently — to keep this deterministic and simple, we instead drive the SAME step twice
    // via two independent runAgent() calls sharing the sticky map's OWN process-lifetime scope
    // is impossible (the map is function-local) — so this test exercises stickiness within ONE
    // drive across the 2-attempt callStep boundary: the FIRST attempt 400s (ladder recovers
    // in-provider, arms nothing since the ladder itself already disclosed api_rejected_schema),
    // and — because callStepInternal's ladder already recovered — run-agent's OWN sticky map
    // gets armed from THAT meta so a hypothetical retry never re-attempts strict. We simulate the
    // "hypothetical retry" by re-driving the SAME workflow a second time against a FRESH run:
    // the sticky map is per-run-agent-invocation, so this instead pins the documented boundary —
    // a NEW drive always re-attempts strict fresh (sticky is drive-scoped, not global) — and the
    // WITHIN-drive stickiness (the 2-attempt callStep boundary + #217 repair loop) is exercised
    // directly below via the outer-attempt-count assertion.
    const def = eligibleDef();
    const store = new InMemoryStore();
    mockCreate
      .mockRejectedValueOnce(
        httpError(
          400,
          "tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false",
        ),
      )
      .mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));

    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider: new AnthropicProvider('claude-sonnet-4-5'),
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    // The provider's OWN internal ladder retry (2 raw SDK calls) never burns a SECOND outer
    // run-agent attempt — the step completed on the FIRST outer callStepWithMeta invocation.
    expect(mockCreate).toHaveBeenCalledTimes(2);
    const runs = await store.list();
    const meta = lastEvidenceMeta(runs[0]!);
    expect(meta).toMatchObject({
      requested: true,
      sent: false,
      downgrade_reason: 'api_rejected_schema',
    });
  });

  it('sticky suppresses strict across a REAL #217 repair-loop iteration for the same step, and the second attempt repeats the ORIGINAL downgrade reason/message verbatim without re-attempting strict', async () => {
    // Repair attempt 1: a live 400 forces the provider's OWN ladder to drop strict and retry
    // in-provider (2 raw calls) — but the now-UNCONSTRAINED submission carries an extra property,
    // which additionalProperties:false rejects at the engine's normal output_schema validation
    // (independent of grammar-constrained decoding), triggering the #217 repair loop.
    // Repair attempt 2: run-agent's OWN sticky map (armed from attempt 1's downgrade) must be
    // consulted BEFORE calling the provider again — so this attempt's raw call never re-attempts
    // strict, and needs no second 400 to arrive at the same disclosed reason.
    const def = eligibleDef();
    const store = new InMemoryStore();
    mockCreate
      .mockRejectedValueOnce(
        httpError(
          400,
          "tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false",
        ),
      )
      .mockResolvedValueOnce(makeToolUseResponse({ category: 'billing', extra: 'unexpected' }))
      .mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));

    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider: new AnthropicProvider('claude-sonnet-4-5'),
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    // 2 raw calls for repair attempt 1's in-provider ladder recovery + exactly 1 more for repair
    // attempt 2 — NOT another 400+retry pair, proving strict was never re-attempted.
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(mockCreate.mock.calls[2]![0].tools[0]).not.toHaveProperty('strict');

    const runs = await store.list();
    const meta = lastEvidenceMeta(runs[0]!);
    expect(meta).toEqual({
      requested: true,
      sent: false,
      downgrade_reason: 'api_rejected_schema',
      api_message:
        "tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false",
    });
  });

  it('a step with structured_output declared but no schema opted-in relative (definition-level ineligible via G0) still lets the run complete, never sending strict', async () => {
    const def: WorkflowDefinition = {
      id: 'so-g0-wf',
      name: 'SO G0',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        // Loader-level Phase A would reject this at --file load time; this exercises the
        // registered-style (no-loader) bypass — the same fixture Phase B must degrade, never
        // strand, per design record §2's "registered-JSON bypass" coverage.
        classify: { description: 'Classify', execution: 'agent', structured_output: 'strict' },
      },
    };
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
    const store = new InMemoryStore();
    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider: new AnthropicProvider('claude-sonnet-4-5'),
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );
    expect(result).toBe('completed');
    expect(mockCreate.mock.calls[0]![0]).not.toHaveProperty('tools');
    const runs = await store.list();
    const meta = lastEvidenceMeta(runs[0]!);
    expect(meta).toEqual({ requested: true, sent: false, downgrade_reason: 'gate_ineligible' });
  });

  it("Phase-B G7' caveat carry: an eligible_with_caveats schema's caveats are carried into the disclosed meta when strict is actually sent", async () => {
    mockCreate.mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));
    const def: WorkflowDefinition = {
      id: 'so-caveat-carry-wf',
      name: 'SO Caveat Carry',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        classify: {
          description: 'Classify',
          execution: 'agent',
          structured_output: 'strict',
          output_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['category'],
            // An optional property ⇒ G7' optional_emission caveat (eligible_with_caveats, not
            // ineligible) — strict IS sent; the caveat must still be carried into the meta.
            properties: { category: { type: 'string' }, note: { type: 'string' } },
          },
        },
      },
    };
    const store = new InMemoryStore();
    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider: new AnthropicProvider('claude-sonnet-4-5'),
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );
    expect(result).toBe('completed');
    expect(mockCreate.mock.calls[0]![0].tools[0]).toMatchObject({ strict: true });

    const runs = await store.list();
    const meta = lastEvidenceMeta(runs[0]!);
    expect(meta?.sent).toBe(true);
    expect(meta?.caveats).toEqual(['optional_emission']);
  });

  it('issue #332 item 1: an eligible_with_caveats schema whose LIVE attempt then downgrades (400) carries BOTH caveats AND downgrade_reason — caveats record an eligibility-time fact about the schema, independent of the attempt outcome (run-record.ts:99-108 correction)', async () => {
    const def: WorkflowDefinition = {
      id: 'so-caveat-downgrade-wf',
      name: 'SO Caveat Downgrade',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        classify: {
          description: 'Classify',
          execution: 'agent',
          structured_output: 'strict',
          output_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['category'],
            // Same eligible_with_caveats shape as the caveat-carry test above (an optional
            // property ⇒ G7' optional_emission) — but THIS attempt's live call 400s, unlike that
            // test's clean success. The existing api_rejected pins elsewhere in this file all use
            // no-caveat schemas, so this cell (caveats co-occurring with a live downgrade) was
            // previously unpinned.
            properties: { category: { type: 'string' }, note: { type: 'string' } },
          },
        },
      },
    };
    const store = new InMemoryStore();
    mockCreate
      .mockRejectedValueOnce(
        httpError(
          400,
          "tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false",
        ),
      )
      .mockResolvedValueOnce(makeToolUseResponse({ category: 'billing' }));

    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider: new AnthropicProvider('claude-sonnet-4-5'),
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    const runs = await store.list();
    const meta = lastEvidenceMeta(runs[0]!);
    // VERIFY-FIRST note: the retry response is ALSO run through the provider's own
    // submission-channel disclosure (anthropic-provider.ts's withChannel — the standing dodge
    // detector, design record R-B), so a real recovered attempt honestly also carries
    // `submission_channel` — this cell's first draft omitted it and the real run caught the gap.
    expect(meta).toEqual({
      requested: true,
      sent: false,
      downgrade_reason: 'api_rejected_schema',
      api_message:
        "tools.0.custom: For 'object' type, 'additionalProperties' must be explicitly set to false",
      caveats: ['optional_emission'],
      submission_channel: 'tool',
    });
  });

  it('issue #332 item 6, pin (i): a strict-declared, tools-bearing step (mcpClient present, realm-driven) discloses unsupported_context_tools, NEVER external_agent — the tools fork structurally cannot honor strict, but realm DID drive this step', async () => {
    const def: WorkflowDefinition = {
      id: 'so-tools-wf',
      name: 'SO Tools',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      mcp_servers: [{ id: 'github', command: 'npx', args: ['-y', 'mcp-github'] }],
      steps: {
        classify: {
          description: 'Classify',
          execution: 'agent',
          structured_output: 'strict',
          tools: ['github:get_pull_request'],
          output_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['category'],
            properties: { category: { type: 'string' } },
          },
        },
      },
    };
    const mockClient: McpClient = {
      async connect() {},
      async getTools(_serverId: string, allowList: string[]): Promise<McpTool[]> {
        return allowList.map((name) => ({
          name,
          description: `Tool ${name}`,
          inputSchema: { type: 'object' },
        }));
      },
      async call() {
        return { result: 'ok' };
      },
      async disconnect() {},
    };
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi
        .fn()
        .mockResolvedValue({ output: { category: 'billing' }, toolCalls: [] });
    })();
    const store = new InMemoryStore();

    const result = await runAgent(
      {
        store,
        workflowStore: makeWorkflowStore(def),
        provider,
        registry: createDefaultRegistry(),
        mcpClientFactory: () => mockClient,
      },
      { definition: def, params: {} },
    );

    expect(result).toBe('completed');
    expect(provider.callStepWithTools).toHaveBeenCalledOnce();
    const runs = await store.list();
    const meta = lastEvidenceMeta(runs[0]!);
    expect(meta).toEqual({
      requested: true,
      sent: false,
      downgrade_reason: 'unsupported_context_tools',
    });
    expect(meta?.downgrade_reason).not.toBe('external_agent');
  });
});
