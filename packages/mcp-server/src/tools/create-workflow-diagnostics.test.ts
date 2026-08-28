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
import { handleCreateWorkflow, stepSchema, type CreateWorkflowArgs } from './create-workflow.js';

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
