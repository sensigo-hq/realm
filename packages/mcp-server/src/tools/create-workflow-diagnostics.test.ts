// create_workflow structured diagnostics tests (issue #169): an unknown step key surfaces as
// BOTH a rendered string in envelope.warnings (unchanged field, non-breaking) AND a structured
// LoaderWarning in the new envelope.diagnostics field (the agent-native value — a framework can
// self-correct on code/key/did_you_mean instead of parsing text). The workflow is still created
// either way; create_workflow never rejects on an unknown step key.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, DEFAULT_POLICY } from '@sensigo/realm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client';
import {
  handleCreateWorkflow,
  registerCreateWorkflow,
  stepSchema,
  metadataSchema,
  createWorkflowArgsSchema,
  type CreateWorkflowArgs,
} from './create-workflow.js';

describe('create_workflow — structured diagnostics (issue #169)', () => {
  let runDir: string;
  let workflowDir: string;
  let stores: { runStore: JsonFileStore; workflowStore: JsonWorkflowStore };

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-cw-diag-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-cw-diag-wf-'));
    stores = {
      runStore: new JsonFileStore(runDir),
      workflowStore: new JsonWorkflowStore(workflowDir),
    };
  });

  it('an unknown step key is created anyway, and appears in both warnings and diagnostics', async () => {
    const args = {
      steps: [
        {
          id: 'step-a',
          description: 'Do something',
          dependson: ['nowhere'], // typo for depends_on — not a declared CreateWorkflowStep field
        },
      ],
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);

    expect(result.status).toBe('ok');
    // The workflow was still created — an unknown step key never blocks create_workflow.
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(Object.keys(def.steps)).toHaveLength(1);

    // envelope.warnings (unchanged string[] field) carries the rendered text.
    expect(result.warnings.some((w) => w.includes("unknown key 'dependson'"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("did you mean 'depends_on'?"))).toBe(true);

    // envelope.diagnostics (new, additive-optional) carries the structured LoaderWarning.
    expect(result.diagnostics).toBeDefined();
    const diag = result.diagnostics!.find((d) => d.key === 'dependson');
    expect(diag).toBeDefined();
    expect(diag!.code).toBe('UNKNOWN_CREATE_WORKFLOW_KEY');
    expect(diag!.did_you_mean).toBe('depends_on');
    expect(diag!.step).toBe('step-a');
  });

  it('a step with only declared fields produces no diagnostics', async () => {
    const result = await handleCreateWorkflow(
      { steps: [{ id: 'step-a', description: 'Do something' }] },
      stores,
    );
    expect(result.status).toBe('ok');
    expect(result.diagnostics ?? []).toEqual([]);
  });

  it('a far/unrelated unknown key ("produces_state") gets no did_you_mean suggestion', async () => {
    const args = {
      steps: [
        {
          id: 'step-a',
          description: 'Do something',
          produces_state: 'done',
        },
      ],
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);
    expect(result.status).toBe('ok');
    const diag = result.diagnostics!.find((d) => d.key === 'produces_state');
    expect(diag).toBeDefined();
    expect(diag!.did_you_mean).toBeUndefined();
  });

  it('create_workflow diagnostics carry NO source position — there is no source to point into (issue #392)', async () => {
    // Not an omission and not a gap to fill later: create_workflow builds a definition from
    // structured arguments. No YAML text exists anywhere in this path, so a line number would
    // have to be invented, and inventing one is the exact failure the position work is built to
    // avoid. Absence here is the correct and permanent answer.
    const args = {
      steps: [{ id: 'step-a', description: 'Do something', dependson: ['x'] }],
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);

    const diag = result.diagnostics!.find((d) => d.key === 'dependson');
    expect(diag).toBeDefined();
    expect(diag!.line).toBeUndefined();
    expect(diag!.column).toBeUndefined();
    expect(diag!.endLine).toBeUndefined();
    expect(diag!.endColumn).toBeUndefined();
    // And the prose says nothing about a line either.
    expect(diag!.message).not.toContain('(line');
  });

  it('UNKNOWN_CREATE_WORKFLOW_KEY still warns (never refuses) even when UNKNOWN_STEP_KEY is flipped to error (issue #170 leniency proof)', async () => {
    const original = DEFAULT_POLICY.UNKNOWN_STEP_KEY;
    DEFAULT_POLICY.UNKNOWN_STEP_KEY = 'error';
    try {
      const args = {
        steps: [{ id: 'step-a', description: 'Do something', dependson: ['x'] }],
      } as unknown as CreateWorkflowArgs;

      const result = await handleCreateWorkflow(args, stores);

      // create_workflow is UNCHANGED by the loader's UNKNOWN_STEP_KEY flip — it uses a distinct
      // code (UNKNOWN_CREATE_WORKFLOW_KEY) that #170 never touches, so the workflow is still
      // created and the response is still 'ok', not a refusal.
      expect(result.status).toBe('ok');
      expect(result.diagnostics!.some((d) => d.code === 'UNKNOWN_CREATE_WORKFLOW_KEY')).toBe(true);
    } finally {
      DEFAULT_POLICY.UNKNOWN_STEP_KEY = original;
    }
  });
});

// =================================================================================================
// issue #412 — the dead key goes, the live one arrives
//
// Every step this tool mints is `execution: 'agent'`, and nothing enforces `timeout_seconds`
// there. Worse than inert: the engine used to render an `expected_timeout` display from it into
// the NextAction the agent reads, so the authoring surface accepted a bound, the run surface
// advertised it, and no layer applied it. `llm_timeout_seconds` is the key that actually governs
// an agent step's model request (#401), so it takes its place.
// =================================================================================================
describe('create_workflow — timeout keys (issue #412)', () => {
  let runDir: string;
  let workflowDir: string;
  let stores: { runStore: JsonFileStore; workflowStore: JsonWorkflowStore };

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-cw-412-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-cw-412-wf-'));
    stores = {
      runStore: new JsonFileStore(runDir),
      workflowStore: new JsonWorkflowStore(workflowDir),
    };
  });

  it('timeout_seconds is dropped with a TARGETED warning — never an error', async () => {
    // Lenient forever, by design (#169/#176): an agent that still sends the old key gets the
    // workflow it asked for, minus the field, plus an explanation. The message is targeted
    // because did-you-mean cannot bridge the distance to `llm_timeout_seconds` — an agent told
    // only "not a recognized field" would have no way to find the replacement.
    const args = {
      steps: [{ id: 'step-a', description: 'Do something', timeout_seconds: 60 }],
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);

    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.steps['step-a']?.timeout_seconds).toBeUndefined();

    const diag = result.diagnostics?.find((d) => d.key === 'timeout_seconds');
    expect(diag).toBeDefined();
    expect(diag!.code).toBe('UNKNOWN_CREATE_WORKFLOW_KEY');
    expect(diag!.step).toBe('step-a');
    expect(diag!.message).toContain("step 'step-a': 'timeout_seconds' was removed (#412)");
    // Lower-case `step`, matching the generic unknown-key path — one channel, one voice.
    expect(diag!.message).not.toContain("Step '");
    // No structured did_you_mean: the substitution would change semantics, so a human decides.
    expect(diag!.did_you_mean).toBeUndefined();
    expect(diag!.message).toContain('nothing enforces it on agent steps');
    expect(diag!.message).toContain('llm_timeout_seconds');
    expect(result.warnings.some((w) => w.includes("'timeout_seconds' was removed"))).toBe(true);
  });

  it('llm_timeout_seconds is accepted and REACHES the registered definition', async () => {
    // The copy is the whole point: an advertised field that never lands in the definition is a
    // silently-inert authored bound — the same falsity this PR is removing, resurrected.
    const args = {
      steps: [{ id: 'step-a', description: 'Do something', llm_timeout_seconds: 30 }],
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);

    expect(result.status).toBe('ok');
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.steps['step-a']?.llm_timeout_seconds).toBe(30);
    // And it is NOT reported as unknown — it is a declared field now.
    expect(result.diagnostics?.some((d) => d.key === 'llm_timeout_seconds')).toBeFalsy();
  });

  for (const bad of [0, -1, 1.5]) {
    it(`llm_timeout_seconds: ${String(bad)} is rejected`, async () => {
      const args = {
        steps: [{ id: 'step-a', description: 'Do something', llm_timeout_seconds: bad }],
      } as unknown as CreateWorkflowArgs;
      const result = await handleCreateWorkflow(args, stores);
      expect(result.status).toBe('error');
      expect(JSON.stringify(result)).toContain('llm_timeout_seconds must be a positive integer');
    });
  }

  it("llm_timeout_seconds: '30' (a string) is rejected", async () => {
    // Direct-call hits the Rule-5 mirror; over the wire zod's number rejects it before validateArgs
    // ever runs. Two error shapes, both correct — this asserts the direct-call one only.
    const args = {
      steps: [{ id: 'step-a', description: 'Do something', llm_timeout_seconds: '30' }],
    } as unknown as CreateWorkflowArgs;
    const result = await handleCreateWorkflow(args, stores);
    expect(result.status).toBe('error');
  });

  it('GUARDRAIL 7 — every field the description advertises actually survives a create', async () => {
    // The description is a claim made to an agent, which reads it instead of the source. Rather
    // than string-matching the sentence, this drives it: each field the text names is sent, and
    // none of them may come back as "unknown". A description that advertises a dropped field is
    // the same defect class as an authored bound nothing enforces.
    const advertised = (stepSchema.description ?? '')
      .replace(/^.*Valid fields:\s*/s, '')
      .replace(/\..*$/s, '')
      .split(/,\s*/)
      .map((f) => f.trim().split(/\s/)[0]!)
      .filter((f) => /^[a-z_]+$/.test(f));

    // Non-vacuity: the parse found a real list, not an empty one.
    expect(advertised).toContain('id');
    expect(advertised).toContain('llm_timeout_seconds');
    expect(advertised).not.toContain('timeout_seconds');

    const sample: Record<string, unknown> = {
      id: 'step-a',
      description: 'Do something',
      depends_on: [],
      // ELIGIBLE by #236's pre-register gate, because `structured_output: 'strict'` below is
      // checked against it — a bare `{type:'object'}` is refused, and the refusal would look
      // like this sweep failing rather than like the sample being wrong.
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
      llm_timeout_seconds: 30,
      structured_output: 'strict',
    };
    // Every advertised field must have a value here — otherwise the sweep silently skips it.
    for (const field of advertised) expect(Object.keys(sample)).toContain(field);

    const result = await handleCreateWorkflow(
      { steps: [sample] } as unknown as CreateWorkflowArgs,
      stores,
    );
    expect(result.status).toBe('ok');
    for (const field of advertised) {
      expect(result.diagnostics?.some((d) => d.key === field)).toBeFalsy();
    }
  });
});

// =================================================================================================
// issue #419 — the two silent surfaces above the step
//
// The per-step sweep worked because `stepSchema` is `.passthrough()`. Nothing above it was:
// the SDK wrapped the tool's raw shape in a stripping `z.object`, so a top-level key died before
// the handler ran, and `metadata`'s own plain object stripped independently of its parent. An
// agent that sent `workflow_id: 'my-run'` got `warnings: []`, a workflow registered under an id
// it never chose, and a `start_run` that failed STATE_WORKFLOW_NOT_FOUND with no hint. All three
// surfaces now warn and drop.
// =================================================================================================
describe('create_workflow — top-level and metadata unknown keys (issue #419)', () => {
  let runDir: string;
  let workflowDir: string;
  let stores: { runStore: JsonFileStore; workflowStore: JsonWorkflowStore };

  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), 'realm-cw-419-run-'));
    workflowDir = await mkdtemp(join(tmpdir(), 'realm-cw-419-wf-'));
    stores = {
      runStore: new JsonFileStore(runDir),
      workflowStore: new JsonWorkflowStore(workflowDir),
    };
  });

  it('the walk trap: workflow_id gets a TARGETED warning, and never reaches the definition', async () => {
    const args = {
      steps: [{ id: 'step-a', description: 'Do something' }],
      workflow_id: 'crown412',
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);

    expect(result.status).toBe('ok');
    expect(
      result.warnings.some(
        (w) =>
          w.includes("'workflow_id' is ignored") &&
          w.includes('mints its own workflow id') &&
          w.includes('STATE_WORKFLOW_NOT_FOUND') &&
          w.includes('metadata.name'),
      ),
    ).toBe(true);

    const diag = result.diagnostics?.find((d) => d.key === 'workflow_id');
    expect(diag).toBeDefined();
    expect(diag!.code).toBe('UNKNOWN_CREATE_WORKFLOW_KEY');
    expect(diag!.scope).toBe('workflow');
    expect(diag!.id).toBe(result.data['workflow_id']);

    // The no-leak invariant: buildWorkflowDefinition copies an explicit field list and never
    // spreads, so the submitted id cannot survive anywhere in the registered definition — and the
    // id the run actually uses is the minted one the envelope returned.
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(JSON.stringify(def)).not.toContain('crown412');
    expect(def.id).toBe(result.data['workflow_id']);
  });

  it('a generic top-level unknown key reads "not a recognized create_workflow field"', async () => {
    const args = {
      steps: [{ id: 'step-a', description: 'Do something' }],
      bogus_top: 1,
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);

    expect(result.status).toBe('ok');
    const diag = result.diagnostics?.find((d) => d.key === 'bogus_top');
    expect(diag).toBeDefined();
    // The `noun` override is the conjunct under test: without it this would read "not a
    // recognized workflow field", which is the loader's definition-key vocabulary — an agent
    // reading it would go looking at YAML fields that have nothing to do with this tool.
    // Substring, not endsWith: the rendered literal closes with `field).`.
    expect(diag!.message).toContain('not a recognized create_workflow field');
    expect(diag!.message).not.toContain('not a recognized workflow field');
  });

  it('a metadata field submitted at the top level is told where it belongs, and does not take effect', async () => {
    const args = {
      steps: [{ id: 'step-a', description: 'Do something' }],
      name: 'My Workflow',
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);

    expect(result.status).toBe('ok');
    const diag = result.diagnostics?.find((d) => d.key === 'name');
    expect(diag).toBeDefined();
    expect(diag!.message).toContain("'name' belongs under metadata");
    expect(diag!.message).toContain('use metadata.name');
    // The message fires on derived membership, not a hand list — `name` is one of the tool's own
    // accepted metadata fields, submitted one level too high.
    expect(Object.keys(metadataSchema.shape)).toContain('name');

    // The honesty conjunct: the misplaced key did not silently half-work.
    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.name).toBe('Dynamic Workflow');
  });

  it('an unknown key inside metadata is warned, and the known key beside it is unharmed', async () => {
    const args = {
      steps: [{ id: 'step-a', description: 'Do something' }],
      metadata: { name: 'n', author: 'a' },
    } as unknown as CreateWorkflowArgs;

    const result = await handleCreateWorkflow(args, stores);

    expect(result.status).toBe('ok');
    const diag = result.diagnostics?.find((d) => d.key === 'author');
    expect(diag).toBeDefined();
    expect(diag!.code).toBe('UNKNOWN_CREATE_WORKFLOW_KEY');
    // The WHOLE rendered message, not just the noun. `scope` and `id` decide the sentence's
    // subject, and a metadata sweep carrying scope 'step' would address a step that does not
    // exist — `step 'undefined': …` — while every substring assertion above still passed.
    expect(diag!.scope).toBe('workflow');
    expect(diag!.message).toBe(
      `workflow '${result.data['workflow_id'] as string}': unknown key 'author' — ignored (not a recognized metadata field).`,
    );
    expect(result.warnings.some((w) => w.includes("unknown key 'author'"))).toBe(true);

    const def = await stores.workflowStore.get(result.data['workflow_id'] as string);
    expect(def.name).toBe('n');
  });

  it('a clean payload — steps plus all five metadata fields — produces no unknown-key warnings', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'step-a', description: 'Do something' }],
        metadata: {
          name: 'n',
          description: 'what it is for',
          task_description: 'how to begin',
          model: 'some-model',
          agent: 'some-agent',
        },
      },
      stores,
    );

    expect(result.status).toBe('ok');
    expect(
      (result.diagnostics ?? []).filter((d) => d.code === 'UNKNOWN_CREATE_WORKFLOW_KEY'),
    ).toEqual([]);
    expect(result.warnings.some((w) => w.includes('unknown key'))).toBe(false);
  });

  it('extensions still errors, and is on the allow-list so it could never warn instead', async () => {
    const result = await handleCreateWorkflow(
      {
        steps: [{ id: 'step-a', description: 'Do something' }],
        extensions: { foo: 'bar' },
      },
      stores,
    );

    expect(result.status).toBe('error');
    expect(result.errors.some((e) => e.includes('extensions is not supported'))).toBe(true);

    // Why a success-path `extensions` could never ALSO warn: it is a declared field. (Asserting
    // "no warning double-fires" on the error envelope above would be vacuous — validateArgs
    // returns before any sweep runs and that envelope's warnings are empty by construction.)
    expect(Object.keys(createWorkflowArgsSchema.shape)).toContain('extensions');
  });
});

// The wiring cell: every cell above calls handleCreateWorkflow directly, so all of them would
// stay green if the REGISTRATION went back to stripping. This one goes over a real client/server
// pair — the only place the schema's `.passthrough()` is actually exercised.
describe('create_workflow — the registration carries unknown keys to the handler (issue #419)', () => {
  it('a wire call with a top-level AND a metadata unknown key warns about both', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'realm-cw-419-wire-run-'));
    const workflowDir = await mkdtemp(join(tmpdir(), 'realm-cw-419-wire-wf-'));
    const server = new McpServer({ name: 'test', version: '0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // Both stores scratch-rooted: unlike the read-only register-over-transport cells elsewhere in
    // this package, create_workflow REGISTERS a definition and STARTS a run, so a default-store
    // call would write into the real ~/.realm (the #285 class).
    registerCreateWorkflow(server, {
      runStore: new JsonFileStore(runDir),
      workflowStore: new JsonWorkflowStore(workflowDir),
    });
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0' });
    await client.connect(clientTransport);

    try {
      const called = await client.callTool({
        name: 'create_workflow',
        arguments: {
          steps: [{ id: 'step-a', description: 'Do something' }],
          metadata: { name: 'n', author: 'a' },
          workflow_id: 'crown412',
        },
      });
      const text = (called.content as Array<{ type: string; text: string }>)[0]!.text;
      const envelope = JSON.parse(text) as { status: string; warnings: string[] };

      expect(envelope.status).toBe('ok');
      // The top-level half: without the args schema's passthrough this key never reaches the
      // handler and no sweep can see it.
      expect(envelope.warnings.some((w) => w.includes("'workflow_id' is ignored"))).toBe(true);
      // The metadata half, equally load-bearing: a nested plain object strips independently, so
      // reverting metadataSchema to a plain z.object re-hides `author` with every other cell in
      // this file still green.
      expect(envelope.warnings.some((w) => w.includes('not a recognized metadata field'))).toBe(
        true,
      );

      // And the advertisement matches the behaviour, at both levels.
      const listed = await client.listTools();
      const schema = listed.tools.find((t) => t.name === 'create_workflow')?.inputSchema as {
        additionalProperties?: unknown;
        properties?: { metadata?: { additionalProperties?: unknown } };
      };
      expect(schema.additionalProperties).toBe(true);
      expect(schema.properties?.metadata?.additionalProperties).toBe(true);

      // Guardrail 7, top-level half (the step half is the sweep further up this file): the
      // description tells an agent which fields exist, and it is the only place an agent reads
      // that. A field added to the schema without a mention here, or named here without being in
      // the schema, is a false statement to the one reader that has no other source.
      const description = listed.tools.find((t) => t.name === 'create_workflow')?.description ?? '';
      const declared = Object.keys(createWorkflowArgsSchema.shape);
      expect(declared).toEqual(['steps', 'metadata', 'extensions']);
      for (const field of declared) expect(description).toContain(field);
    } finally {
      await client.close();
    }
  });
});
