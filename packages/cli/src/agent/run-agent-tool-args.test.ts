// run-agent-tool-args.test.ts — issue #311, the orchestration half of strict MCP tool-call
// arguments: which tools get strict (eligibility × budget, in declared order), how a live drop is
// recorded, and how stickiness behaves across repair attempts.
//
// The WIRE half (what `strict` looks like on the request, and the per-turn 400/503 ladder) is
// pinned in providers/anthropic-provider-tool-args.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { runAgent } from './run-agent.js';
import type { WorkflowDefinition, StructuredOutputMeta } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ToolCapableLlmProvider } from './providers/llm-provider.js';
import type {
  McpClient,
  McpTool,
  ToolDefinition,
  StepWithToolsResult,
} from './mcp/mcp-extensions.js';
import {
  GITHUB_LIST_PULL_REQUESTS_SCHEMA,
  ELIGIBLE_NO_OPTIONALS_SCHEMA,
  INELIGIBLE_NO_OPTIONALS_SCHEMA,
  CONVERTER_DERIVED_WITH_CAVEATS_SCHEMA,
  eligibleWithOptionals,
} from './fixtures/tool-schemas.js';

type ToolArgs = NonNullable<StructuredOutputMeta['tool_args']>;

/** Builds a one-step tools workflow. `tools` is the DECLARED list, in declared order. */
function toolsWorkflow(
  tools: string[],
  opts: { strict?: boolean; outputSchema?: Record<string, unknown>; servers?: string[] } = {},
): WorkflowDefinition {
  return {
    id: 'tool-args-wf',
    name: 'Tool Args WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    mcp_servers: (opts.servers ?? ['srv']).map((id) => ({
      id,
      transport: 'stdio' as const,
      command: 'npx',
      args: ['-y', `mcp-${id}`],
    })),
    steps: {
      classify: {
        description: 'Classify',
        execution: 'agent',
        tools,
        ...(opts.strict === true ? { structured_output: 'strict' as const } : {}),
        output_schema: opts.outputSchema ?? {
          type: 'object',
          additionalProperties: false,
          required: ['category'],
          properties: { category: { type: 'string' } },
        },
      },
    },
  };
}

/** An MCP client whose tools carry the given schemas, keyed by BARE tool name. */
function mockClient(schemas: Record<string, Record<string, unknown>>): McpClient {
  return {
    async connect() {},
    async getTools(_serverId: string, allowList: string[]): Promise<McpTool[]> {
      return allowList.map((name) => ({
        name,
        description: `Tool ${name}`,
        inputSchema: schemas[name] ?? { type: 'object' },
      }));
    },
    async call() {
      return { result: 'ok' };
    },
    async disconnect() {},
  };
}

/**
 * A tool-capable provider double that RECORDS the ToolDefinition[] it was handed per call, and
 * can report a drop. `results` supplies one response per call (the last repeats).
 */
function recordingProvider(
  results: Array<{
    output?: Record<string, unknown>;
    drop?: StepWithToolsResult['toolArgsStrictDrop'];
  }> = [{}],
) {
  const seen: ToolDefinition[][] = [];
  let call = 0;
  const provider = new (class extends ToolCapableLlmProvider {
    callStep = vi.fn();
    callStepWithTools = vi.fn(async (_prompt: string, tools: ToolDefinition[]) => {
      // Snapshot the array AND each entry — run-agent must not be able to mutate history.
      seen.push(tools.map((t) => ({ ...t })));
      const r = results[Math.min(call, results.length - 1)]!;
      call += 1;
      return {
        output: r.output ?? { category: 'billing' },
        toolCalls: [],
        ...(r.drop !== undefined ? { toolArgsStrictDrop: r.drop } : {}),
      };
    });
  })();
  return { provider, seen };
}

async function drive(
  def: WorkflowDefinition,
  client: McpClient,
  provider: ToolCapableLlmProvider,
  opts: { schemaRetries?: number } = {},
): Promise<{ meta: StructuredOutputMeta | undefined; result: string }> {
  const store = new InMemoryStore();
  const result = await runAgent(
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
      ...(opts.schemaRetries !== undefined ? { schemaRetries: opts.schemaRetries } : {}),
    },
    { definition: def, params: {} },
  );
  const runs = await store.list();
  const evidence = runs[0]!.evidence;
  return { meta: evidence.at(-1)?.diagnostics?.structured_output, result };
}

/** The names of tools that reached the provider carrying strict, on call `n`. */
function strictNames(seen: ToolDefinition[][], n = 0): string[] {
  return (seen[n] ?? []).filter((t) => t.strict === true).map((t) => t.name);
}

const DROP_400: StepWithToolsResult['toolArgsStrictDrop'] = {
  reason: 'api_rejected_schema',
  api_message: 'tools.0.custom: schema rejected',
  strict_turns_before_drop: 2,
};
const DROP_503: StepWithToolsResult['toolArgsStrictDrop'] = {
  reason: 'service_unavailable',
  api_message: 'overloaded_error',
  strict_turns_before_drop: 0,
};

describe('runAgent — strict tool-call arguments (issue #311)', () => {
  // -------------------------------------------------------------------------------------------
  // Pin 11 — the re-sort is GATED on the strict declaration
  // -------------------------------------------------------------------------------------------
  // The two orders must genuinely DIFFER for these pins to discriminate anything. Assembly walks
  // SERVER BY SERVER, so interleaving two servers in the declared list is what separates them:
  //   declared  = a1, b1, a2   (the author's list)
  //   assembled = a1, a2, b1   (grouped by server)
  // A single-server fixture would make the re-sort a no-op and the pin vacuous.
  const INTERLEAVED = ['alpha:a1', 'beta:b1', 'alpha:a2'];
  const INTERLEAVED_SERVERS = ['alpha', 'beta'];
  const INTERLEAVED_SCHEMAS = {
    a1: ELIGIBLE_NO_OPTIONALS_SCHEMA,
    a2: ELIGIBLE_NO_OPTIONALS_SCHEMA,
    b1: ELIGIBLE_NO_OPTIONALS_SCHEMA,
  };

  it('pin 11: a NON-opted-in step is byte-identical — no strict markers, and the ASSEMBLED order is left exactly as it was (never re-sorted into declared order)', async () => {
    const def = toolsWorkflow(INTERLEAVED, { strict: false, servers: INTERLEAVED_SERVERS });
    const { provider, seen } = recordingProvider();

    const { meta } = await drive(def, mockClient(INTERLEAVED_SCHEMAS), provider);

    // Server-grouped, NOT declared — proving the re-sort never ran for this step.
    expect(seen[0]!.map((t) => t.name)).toEqual(['a1', 'a2', 'b1']);
    for (const t of seen[0]!) expect(t).not.toHaveProperty('strict');
    // No structured_output declaration at all ⇒ no meta of any kind.
    expect(meta).toBeUndefined();
  });

  it('pin 11 (positive half): an OPTED-IN step IS re-sorted into the author’s declared order', async () => {
    const def = toolsWorkflow(INTERLEAVED, { strict: true, servers: INTERLEAVED_SERVERS });
    const { provider, seen } = recordingProvider();

    await drive(def, mockClient(INTERLEAVED_SCHEMAS), provider);

    expect(seen[0]!.map((t) => t.name)).toEqual(['a1', 'b1', 'a2']);
  });

  // -------------------------------------------------------------------------------------------
  // Pin 9 — eligibility × budget composition: ineligible tools consume ZERO budget
  // -------------------------------------------------------------------------------------------
  it('pin 9: an ineligible tool consumes ZERO budget — a later eligible tool still gets strict even when the ineligible one would have exhausted it', async () => {
    // ineligible-with-20-optionals FIRST, then an eligible 6-optional tool. If the ineligible
    // tool were charged (20), the eligible one (6) would blow the 24 sum and be excluded.
    const ineligibleFat = { ...eligibleWithOptionals(20) };
    delete (ineligibleFat as Record<string, unknown>)['additionalProperties']; // now G1-ineligible
    const def = toolsWorkflow(['srv:fat_ineligible', 'srv:slim_eligible'], { strict: true });
    const client = mockClient({
      fat_ineligible: ineligibleFat,
      slim_eligible: eligibleWithOptionals(6),
    });
    const { provider, seen } = recordingProvider();

    const { meta } = await drive(def, client, provider);

    expect(strictNames(seen)).toEqual(['slim_eligible']);
    const tools = (meta!.tool_args as ToolArgs).tools;
    expect(tools[0]).toMatchObject({
      name: 'fat_ineligible',
      strict_sent: false,
      reasons: ['missing_additional_properties'],
    });
    expect(tools[1]).toMatchObject({ name: 'slim_eligible', strict_sent: true });
  });

  // -------------------------------------------------------------------------------------------
  // Pin 10 — budget boundaries, INCLUSIVE, greedy-skip (never prefix-stop)
  // -------------------------------------------------------------------------------------------
  it('pin 10a: landing exactly on 24 summed optionals FITS', async () => {
    const def = toolsWorkflow(['srv:a', 'srv:b'], { strict: true });
    const client = mockClient({ a: eligibleWithOptionals(20), b: eligibleWithOptionals(4) });
    const { provider, seen } = recordingProvider();

    await drive(def, client, provider);

    expect(strictNames(seen)).toEqual(['a', 'b']); // 20 + 4 = 24 ⇒ both fit
  });

  it('pin 10b: 24-then-0 — the over-budget tool is SKIPPED and the walk CONTINUES, so a later 0-optional tool still gets strict', async () => {
    const def = toolsWorkflow(['srv:full', 'srv:over', 'srv:free'], { strict: true });
    const client = mockClient({
      full: eligibleWithOptionals(24),
      over: eligibleWithOptionals(1), // 24 + 1 = 25 ⇒ skipped, NOT a stop
      free: ELIGIBLE_NO_OPTIONALS_SCHEMA, // 24 + 0 = 24 ⇒ still fits
    });
    const { provider, seen } = recordingProvider();

    const { meta } = await drive(def, client, provider);

    expect(strictNames(seen)).toEqual(['full', 'free']);
    const tools = (meta!.tool_args as ToolArgs).tools;
    expect(tools[1]).toMatchObject({
      name: 'over',
      strict_sent: false,
      reasons: ['budget_excluded'],
    });
  });

  it('pin 10c: the 20-tool count cap is inclusive — the 21st 0-optional tool is skipped as budget_excluded', async () => {
    const names = Array.from({ length: 21 }, (_, i) => `t${i}`);
    const def = toolsWorkflow(
      names.map((n) => `srv:${n}`),
      { strict: true },
    );
    const client = mockClient(
      Object.fromEntries(names.map((n) => [n, ELIGIBLE_NO_OPTIONALS_SCHEMA])),
    );
    const { provider, seen } = recordingProvider();

    const { meta } = await drive(def, client, provider);

    expect(strictNames(seen)).toHaveLength(20);
    const tools = (meta!.tool_args as ToolArgs).tools;
    expect(tools[19]).toMatchObject({ name: 't19', strict_sent: true });
    expect(tools[20]).toMatchObject({
      name: 't20',
      strict_sent: false,
      reasons: ['budget_excluded'],
    });
  });

  // -------------------------------------------------------------------------------------------
  // Pin 12 — per-tool caveats, including optional_emission
  // -------------------------------------------------------------------------------------------
  it('pin 12: a strict-attached tool still reports its own caveats (dialect stamp + optional_emission)', async () => {
    const def = toolsWorkflow(['srv:converted'], { strict: true });
    const client = mockClient({ converted: CONVERTER_DERIVED_WITH_CAVEATS_SCHEMA });
    const { provider, seen } = recordingProvider();

    const { meta } = await drive(def, client, provider);

    expect(strictNames(seen)).toEqual(['converted']); // caveats never block strict
    expect((meta!.tool_args as ToolArgs).tools[0]).toEqual({
      name: 'converted',
      strict_requested: true,
      strict_sent: true,
      caveats: ['unenforced_keyword', 'optional_emission'],
    });
  });

  it('a REAL third-party schema (github list_pull_requests, MIT snapshot) is reported ineligible with the server as fix-owner', async () => {
    const def = toolsWorkflow(['srv:list_pull_requests'], { strict: true });
    const client = mockClient({ list_pull_requests: GITHUB_LIST_PULL_REQUESTS_SCHEMA });
    const { provider, seen } = recordingProvider();

    const { meta } = await drive(def, client, provider);

    expect(strictNames(seen)).toEqual([]);
    const entry = (meta!.tool_args as ToolArgs).tools[0]!;
    // Both census-dominant blockers are reported, deduped per code by the walk's own path keying.
    expect(entry.reasons).toContain('missing_additional_properties');
    expect(entry.reasons).toContain('unsupported_keyword');
    expect(entry.strict_sent).toBe(false);
  });

  // -------------------------------------------------------------------------------------------
  // Pins 5, 6, 13, 17 — drop truth
  // -------------------------------------------------------------------------------------------
  it('pins 5+6: a mid-attempt drop flips ONLY the strict-attached entries; ineligible and budget entries keep their own reasons verbatim', async () => {
    const def = toolsWorkflow(['srv:bad', 'srv:good', 'srv:over'], { strict: true });
    const client = mockClient({
      // ZERO-optional ineligible: this pin is about DROP truth, so the ineligible tool must not
      // be able to perturb the budget arithmetic that a different pin owns.
      bad: INELIGIBLE_NO_OPTIONALS_SCHEMA,
      good: eligibleWithOptionals(24), // takes the whole optional budget, gets strict
      over: eligibleWithOptionals(1), // budget_excluded
    });
    const { provider } = recordingProvider([{ drop: DROP_400 }]);

    const { meta } = await drive(def, client, provider);
    const tools = (meta!.tool_args as ToolArgs).tools;

    // The ineligible entry is untouched by the drop — overwriting it would erase WHY it was skipped.
    expect(tools[0]!.reasons).toContain('missing_additional_properties');
    expect(tools[0]!.reasons).not.toContain('api_rejected_schema');
    // The strict-attached entry flips to the FINAL posture of the attempt.
    expect(tools[1]).toMatchObject({
      name: 'good',
      strict_sent: false,
      reasons: ['api_rejected_schema'],
    });
    // The budget entry keeps its own reason.
    expect(tools[2]!.reasons).toEqual(['budget_excluded']);
    // dropped_mid_attempt carries the api_message — and it lives HERE, never on the step meta.
    expect((meta!.tool_args as ToolArgs).dropped_mid_attempt).toEqual(DROP_400);
    expect(meta!.api_message).toBeUndefined();
  });

  it('pin 17: a 400 on the first strict-carrying turn reports strict_turns_before_drop: 0', async () => {
    const def = toolsWorkflow(['srv:a'], { strict: true });
    const client = mockClient({ a: ELIGIBLE_NO_OPTIONALS_SCHEMA });
    const { provider } = recordingProvider([
      { drop: { reason: 'api_rejected_schema', strict_turns_before_drop: 0 } },
    ]);

    const { meta } = await drive(def, client, provider);

    expect((meta!.tool_args as ToolArgs).dropped_mid_attempt).toEqual({
      reason: 'api_rejected_schema',
      strict_turns_before_drop: 0,
    });
  });

  it('pin 13 (COEXIST): a partially-strict step reports BOTH dimensions — output unconstrained, some tools strict', async () => {
    const def = toolsWorkflow(['srv:good', 'srv:bad'], { strict: true });
    const client = mockClient({
      good: ELIGIBLE_NO_OPTIONALS_SCHEMA,
      bad: GITHUB_LIST_PULL_REQUESTS_SCHEMA,
    });
    const { provider } = recordingProvider();

    const { meta } = await drive(def, client, provider);

    // OUTPUT dimension: unchanged, still honestly unconstrained.
    expect(meta).toMatchObject({
      requested: true,
      sent: false,
      downgrade_reason: 'unsupported_context_tools',
    });
    // TOOL-ARGS dimension: genuinely on for one tool. The two co-occur and neither is a lie.
    const tools = (meta!.tool_args as ToolArgs).tools;
    expect(tools.map((t) => t.strict_sent)).toEqual([true, false]);
  });

  it('a clean attempt records no dropped_mid_attempt at all', async () => {
    const def = toolsWorkflow(['srv:a'], { strict: true });
    const client = mockClient({ a: ELIGIBLE_NO_OPTIONALS_SCHEMA });
    const { provider } = recordingProvider();

    const { meta } = await drive(def, client, provider);

    expect((meta!.tool_args as ToolArgs).dropped_mid_attempt).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------
  // Pins 3, 7, 8 — stickiness across repair attempts
  // -------------------------------------------------------------------------------------------
  // The repair loop re-drives the SAME step when its submission fails the step's own
  // output_schema. VERIFIED BEHAVIOUR (this shaped the fixtures): a step that never satisfies its
  // schema ends the run `failed` with ZERO evidence entries — nothing is persisted to read a meta
  // from. So attempt 1 returns a schema-violating answer (triggering the repair) and attempt 2
  // returns a valid one, making attempt 2 — the STICKY attempt — the one whose evidence lands.
  const RETRY_OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['category'],
    properties: { category: { type: 'string', enum: ['billing'] } },
  };
  const BAD_THEN_GOOD = [
    { output: { category: 'NOT_IN_ENUM' } },
    { output: { category: 'billing' } },
  ];

  it('pins 7+3: a 400 is STICKY — the next repair attempt re-sends nothing strict, and its evidence mirrors the ORIGINAL reason', async () => {
    const def = toolsWorkflow(['srv:a'], { strict: true, outputSchema: RETRY_OUTPUT_SCHEMA });
    const client = mockClient({ a: ELIGIBLE_NO_OPTIONALS_SCHEMA });
    const { provider, seen } = recordingProvider([
      { ...BAD_THEN_GOOD[0]!, drop: DROP_400 },
      BAD_THEN_GOOD[1]!,
    ]);

    const { meta } = await drive(def, client, provider, { schemaRetries: 1 });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(strictNames(seen, 0)).toEqual(['a']); // attempt 1 tried strict
    expect(strictNames(seen, 1)).toEqual([]); // attempt 2 did not — sticky held
    // The evidence that landed is the STICKY attempt's, and it mirrors the original reason
    // rather than inventing a new one.
    const tools = (meta!.tool_args as ToolArgs).tools;
    expect(tools[0]).toMatchObject({ strict_sent: false, reasons: ['api_rejected_schema'] });
    // PER-ATTEMPT: the sticky attempt never attached strict, so it has no drop to describe.
    expect((meta!.tool_args as ToolArgs).dropped_mid_attempt).toBeUndefined();
  });

  it('pin 8: a 503 is NON-sticky — the next attempt re-attaches strict (transient overload must not disable the feature for the whole drive)', async () => {
    const def = toolsWorkflow(['srv:a'], { strict: true, outputSchema: RETRY_OUTPUT_SCHEMA });
    const client = mockClient({ a: ELIGIBLE_NO_OPTIONALS_SCHEMA });
    const { provider, seen } = recordingProvider([
      { ...BAD_THEN_GOOD[0]!, drop: DROP_503 },
      BAD_THEN_GOOD[1]!,
    ]);

    const { meta } = await drive(def, client, provider, { schemaRetries: 1 });

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(strictNames(seen, 0)).toEqual(['a']);
    expect(strictNames(seen, 1)).toEqual(['a']); // re-attached — the 503 armed nothing
    // And the re-attached attempt's evidence says so: strict was sent, no lingering reason.
    expect((meta!.tool_args as ToolArgs).tools[0]).toMatchObject({ strict_sent: true });
  });

  it('pin 2: stickiness is keyed PER STEP — a 400 on one step never disables strict on a different step', async () => {
    const def: WorkflowDefinition = {
      id: 'two-step-wf',
      name: 'Two Step',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      mcp_servers: [{ id: 'srv', transport: 'stdio', command: 'npx', args: ['-y', 'mcp-srv'] }],
      steps: {
        first: {
          description: 'First',
          execution: 'agent',
          tools: ['srv:a'],
          structured_output: 'strict',
          output_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['category'],
            properties: { category: { type: 'string' } },
          },
        },
        second: {
          description: 'Second',
          execution: 'agent',
          depends_on: ['first'],
          tools: ['srv:a'],
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
    const client = mockClient({ a: ELIGIBLE_NO_OPTIONALS_SCHEMA });
    // Step 'first' takes the 400; step 'second' must be unaffected.
    const { provider, seen } = recordingProvider([{ drop: DROP_400 }, {}]);

    await drive(def, client, provider);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(strictNames(seen, 0)).toEqual(['a']);
    expect(strictNames(seen, 1)).toEqual(['a']); // the other step still attaches strict
  });

  // -------------------------------------------------------------------------------------------
  // Pin 16 — the #338 corner, pinned AS BUILT (adjudication belongs to #338, not here)
  // -------------------------------------------------------------------------------------------
  it('pin 16 (#338 as-built): a strict step that declares tools but has NO mcp_servers never reaches the tools path — no tool_args, and the OUTPUT gate assesses the step schema instead', async () => {
    // No `mcp_servers` ⇒ no mcpClient ⇒ run-agent takes the SUBMIT path, where the step's own
    // schema is gated normally and tools are silently never offered. This is the #338 corner: it
    // is pinned here so the contract is visible, NOT endorsed — see issue #338.
    const def: WorkflowDefinition = {
      id: 'no-servers-wf',
      name: 'No Servers',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        classify: {
          description: 'Classify',
          execution: 'agent',
          tools: ['srv:a'],
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
    const provider = new (class extends ToolCapableLlmProvider {
      callStep = vi.fn();
      callStepWithTools = vi.fn();
      callStepWithMeta = vi.fn(async () => ({
        output: { category: 'billing' },
        meta: { requested: true, sent: true } as StructuredOutputMeta,
      }));
    })();
    const store = new InMemoryStore();

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
      },
      { definition: def, params: {} },
    );

    expect(provider.callStepWithTools).not.toHaveBeenCalled();
    const runs = await store.list();
    const meta = runs[0]!.evidence.at(-1)?.diagnostics?.structured_output;
    expect(meta?.tool_args).toBeUndefined();
  });
});
