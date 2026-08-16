// run-agent-openai-output.test.ts — issue #313, the ORCHESTRATION half of OpenAI structured
// output: which provider gets strict, under which eligibility profile, what the compat gate
// does, and what evidence records about provenance.
//
// HOMING RULE (deliberate): the profile-sensitive cells are driven END-TO-END through a real
// OpenAIProvider with a mocked SDK, and they assert a WIRE discriminator — whether json_schema
// appeared on the request. A core-level cell that passes `profile: 'openai'` explicitly would be
// immune to the mutation that drops the profile argument at run-agent's verdict call, and so
// would not pin the thing that actually matters.
import { describe, expect, it, vi } from 'vitest';
import { runAgent } from './run-agent.js';
import type { WorkflowDefinition, StructuredOutputMeta } from '@sensigo/realm';
import { CURRENT_WORKFLOW_SCHEMA_VERSION, createDefaultRegistry } from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { OpenAIProvider } from './providers/openai-provider.js';
import { LlmProvider } from './providers/llm-provider.js';

const mockCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

function jsonAnswer(obj: Record<string, unknown>) {
  return { choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }] };
}

/** A one-step strict-declared agent workflow whose output schema is supplied by the caller. */
function wf(outputSchema: Record<string, unknown>): WorkflowDefinition {
  return {
    id: 'openai-output-wf',
    name: 'OpenAI Output WF',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      classify: {
        description: 'Classify',
        execution: 'agent',
        structured_output: 'strict',
        output_schema: outputSchema,
      },
    },
  };
}

async function drive(
  def: WorkflowDefinition,
  provider: LlmProvider,
  deps: { providerId?: `module:${string}` } = {},
): Promise<StructuredOutputMeta | undefined> {
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
      ...(deps.providerId !== undefined ? { providerId: deps.providerId } : {}),
      registry: createDefaultRegistry(),
    },
    { definition: def, params: {} },
  );
  const runs = await store.list();
  return runs[0]!.evidence.at(-1)?.diagnostics?.structured_output;
}

/** Did the request that reached the wire carry a json_schema response_format? */
function wireSentStrict(n = 0): boolean {
  const rf = (mockCreate.mock.calls[n]?.[0] as { response_format?: { type?: string } } | undefined)
    ?.response_format;
  return rf?.type === 'json_schema';
}

// A schema that is ELIGIBLE under Anthropic (an optional property is merely a caveat there) but
// INELIGIBLE under OpenAI (every property must be required). This asymmetry is the whole
// discriminator for the profile cells below.
const OPTIONAL_BEARING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category'],
  properties: { category: { type: 'string' }, note: { type: 'string' } },
};

// All-required with a null union — OpenAI's sanctioned way to express "may be absent".
const NULL_UNION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'note'],
  properties: { category: { type: 'string' }, note: { type: ['string', 'null'] } },
};

const ALL_REQUIRED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category'],
  properties: { category: { type: 'string' } },
};

describe('runAgent — OpenAI structured output (issue #313)', () => {
  // -------------------------------------------------------------------------------------------
  // Profile selection, pinned through the WIRE
  // -------------------------------------------------------------------------------------------
  it('profile: an optional-bearing schema is INELIGIBLE under OpenAI — strict never reaches the wire, and evidence says gate_ineligible', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(jsonAnswer({ category: 'billing' }));

    const meta = await drive(wf(OPTIONAL_BEARING_SCHEMA), new OpenAIProvider('gpt-4o'));

    // THE discriminator: no json_schema on the request. Under the Anthropic profile this same
    // schema is merely caveated, so strict WOULD have been sent.
    expect(wireSentStrict(0)).toBe(false);
    expect(meta).toMatchObject({
      requested: true,
      sent: false,
      downgrade_reason: 'gate_ineligible',
      provider: 'openai',
    });
  });

  it('profile: an all-required schema IS eligible under OpenAI — strict reaches the wire and evidence is exactly requested+sent', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(jsonAnswer({ category: 'billing' }));

    const meta = await drive(wf(ALL_REQUIRED_SCHEMA), new OpenAIProvider('gpt-4o'));

    expect(wireSentStrict(0)).toBe(true);
    // The success-path honesty cell at orchestration level: NO downgrade_reason may appear.
    expect(meta).toEqual({ requested: true, sent: true, provider: 'openai' });
  });

  it('profile: an all-required NULL-UNION schema is eligible WITH the measured null_union_emission caveat', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(jsonAnswer({ category: 'billing', note: null }));

    const meta = await drive(wf(NULL_UNION_SCHEMA), new OpenAIProvider('gpt-4o'));

    expect(wireSentStrict(0)).toBe(true);
    expect(meta?.caveats).toEqual(['null_union_emission']);
  });

  it('profile: the SAME optional-bearing schema stays eligible under a non-OpenAI provider (Anthropic profile zero-diff)', async () => {
    // A minimal capability-declaring double standing in for a non-OpenAI provider: it must take
    // the Anthropic profile, under which an optional property is a caveat, not a rejection.
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ category: 'billing' });
      callStepWithMeta = vi.fn(async () => ({
        output: { category: 'billing' },
        meta: { requested: true, sent: true } as StructuredOutputMeta,
      }));
      capabilities() {
        return { jsonMode: false, providerId: 'anthropic' as const };
      }
    })();

    const meta = await drive(wf(OPTIONAL_BEARING_SCHEMA), provider);

    // Sent, not gated — the OpenAI rule did not leak across profiles.
    expect(meta).toMatchObject({ requested: true, sent: true, provider: 'anthropic' });
    expect(meta?.downgrade_reason).toBeUndefined();
  });

  // -------------------------------------------------------------------------------------------
  // The compat gate
  // -------------------------------------------------------------------------------------------
  it('compat DEFAULT-OFF: a --base-url endpoint records compat_endpoint and never puts strict on the wire', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(jsonAnswer({ category: 'billing' }));

    const meta = await drive(
      wf(ALL_REQUIRED_SCHEMA),
      new OpenAIProvider('gpt-4o', 'https://compat.example.com'),
    );

    expect(wireSentStrict(0)).toBe(false);
    expect(meta).toMatchObject({
      requested: true,
      sent: false,
      downgrade_reason: 'compat_endpoint',
      provider: 'openai',
    });
  });

  it('compat OPT-IN: --strict-base-url lifts the gate and strict is attempted on the same endpoint', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(jsonAnswer({ category: 'billing' }));

    const meta = await drive(
      wf(ALL_REQUIRED_SCHEMA),
      new OpenAIProvider('gpt-4o', 'https://compat.example.com', true),
    );

    expect(wireSentStrict(0)).toBe(true);
    expect(meta).toMatchObject({ requested: true, sent: true });
  });

  it('compat is assessed BEFORE eligibility: an ineligible schema on a compat endpoint still reports compat_endpoint (strict could not be sent regardless)', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(jsonAnswer({ category: 'billing' }));

    const meta = await drive(
      wf(OPTIONAL_BEARING_SCHEMA),
      new OpenAIProvider('gpt-4o', 'https://compat.example.com'),
    );

    expect(meta?.downgrade_reason).toBe('compat_endpoint');
  });

  it('compat NEVER arms sticky: the gate is structurally outside the sticky-arming path', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(jsonAnswer({ category: 'billing' }));
    const provider = new OpenAIProvider('gpt-4o', 'https://compat.example.com');

    // Two steps: if the compat arm armed sticky, the second step's meta would carry the sticky
    // reason rather than a freshly-derived compat_endpoint — indistinguishable by literal, so
    // this asserts the mechanism through a step that was never attempted.
    const def: WorkflowDefinition = {
      id: 'compat-two-step',
      name: 'Compat Two Step',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        first: {
          description: 'First',
          execution: 'agent',
          structured_output: 'strict',
          output_schema: ALL_REQUIRED_SCHEMA,
        },
        second: {
          description: 'Second',
          execution: 'agent',
          depends_on: ['first'],
          structured_output: 'strict',
          output_schema: ALL_REQUIRED_SCHEMA,
        },
      },
    };
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

    const runs = await store.list();
    for (const entry of runs[0]!.evidence) {
      const m = entry.diagnostics?.structured_output;
      if (m === undefined) continue;
      // Every step reports the endpoint fact freshly; none inherits a remembered downgrade.
      expect(m.downgrade_reason).toBe('compat_endpoint');
      expect(m.api_message).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------------------------
  // Provenance
  // -------------------------------------------------------------------------------------------
  it('provenance: a third-party module provider is named module:<basename> and assessed under the Anthropic profile', async () => {
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ category: 'billing' });
    })();

    const meta = await drive(wf(ALL_REQUIRED_SCHEMA), provider, {
      providerId: 'module:my-provider.js',
    });

    expect(meta?.provider).toBe('module:my-provider.js');
    // It never overrode callStepWithMeta, so the honest synthesis still applies.
    expect(meta?.downgrade_reason).toBe('provider_unsupported');
  });

  it('provenance: a provider that declares NOTHING and has no module identity carries no provider field (never a guess)', async () => {
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ category: 'billing' });
    })();

    const meta = await drive(wf(ALL_REQUIRED_SCHEMA), provider);

    expect(meta).not.toHaveProperty('provider');
  });

  // -------------------------------------------------------------------------------------------
  // The remediation nudge
  // -------------------------------------------------------------------------------------------
  it('the nudge prints the remediation once per step on stderr for an ineligible verdict', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(jsonAnswer({ category: 'billing' }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await drive(wf(OPTIONAL_BEARING_SCHEMA), new OpenAIProvider('gpt-4o'));

    const printed = errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l) => l.includes('structured_output: strict'));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("'note' is not listed in 'required'");
    errSpy.mockRestore();
  });

  it('the nudge also fires for a CAVEATED verdict (an author who got strict, with a behavioural caveat, still needs to know)', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(jsonAnswer({ category: 'billing', note: null }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await drive(wf(NULL_UNION_SCHEMA), new OpenAIProvider('gpt-4o'));

    const printed = errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l) => l.includes('structured_output: strict'));
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('null');
    errSpy.mockRestore();
  });

  it('the nudge fires on ANTHROPIC drives too — the cross-provider blast radius, stated and pinned', async () => {
    const provider = new (class extends LlmProvider {
      callStep = vi.fn().mockResolvedValue({ category: 'billing' });
      capabilities() {
        return { jsonMode: false, providerId: 'anthropic' as const };
      }
    })();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Ineligible under Anthropic too: a root that is not type:'object'.
    await drive(wf({ type: 'array' }), provider);

    const printed = errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l) => l.includes('structured_output: strict'));
    expect(printed).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('the nudge fires ONCE PER STEP even when the step is repaired — the repairsUsed gate, not a per-attempt print', async () => {
    // The step's first answer fails its own output_schema, so the #217 repair loop re-drives it.
    // A per-attempt print would emit the same remediation twice for one authoring mistake.
    const def: WorkflowDefinition = {
      id: 'nudge-repair-wf',
      name: 'Nudge Repair',
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
            properties: {
              category: { type: 'string', enum: ['billing'] },
              note: { type: 'string' },
            },
          },
        },
      },
    };
    let calls = 0;
    const provider = new (class extends LlmProvider {
      callStep = vi.fn(async () => {
        calls += 1;
        return calls === 1 ? { category: 'WRONG' } : { category: 'billing' };
      });
      capabilities() {
        return { jsonMode: false, providerId: 'anthropic' as const };
      }
    })();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

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
        schemaRetries: 2,
      },
      { definition: def, params: {} },
    );

    const printed = errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l) => l.includes('structured_output: strict'));
    errSpy.mockRestore();
    expect(calls).toBe(2); // the repair genuinely happened
    expect(printed).toHaveLength(1); // and the nudge still printed once
  });

  it('the nudge stays SILENT for a fully eligible schema', async () => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(jsonAnswer({ category: 'billing' }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await drive(wf(ALL_REQUIRED_SCHEMA), new OpenAIProvider('gpt-4o'));

    expect(
      errSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .filter((l) => l.includes('structured_output: strict')),
    ).toHaveLength(0);
    errSpy.mockRestore();
  });
});
