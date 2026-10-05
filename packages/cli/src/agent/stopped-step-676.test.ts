// stopped-step-676.test.ts — issue #676 (review): when a step the engine runs AFTER the one the
// drive called stops the call, `realm agent` and `realm workflow run` name THAT step.
//
// The engine says which step a non-ok reply belongs to (`stopped_step`); before it did, every line
// below named the called step — `✗ Step 'draft' failed: …` for a handler that threw in `publish`.
// Each `realm agent` cell drives the real `runAgent` over an in-memory store with a provider that
// returns a fixed submission; the dev-run cells read the line function the dev-run loop prints.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import type { AgentDeps } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { renderStepFailureLine } from '../commands/run.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** Returns each submission in turn, then the last one again. */
class FixedProvider extends LlmProvider {
  private calls = 0;
  constructor(private readonly submissions: Array<Record<string, unknown>>) {
    super();
  }
  async callStep(): Promise<Record<string, unknown>> {
    const i = Math.min(this.calls, this.submissions.length - 1);
    this.calls += 1;
    return { ...this.submissions[i]! };
  }
}

const DRAFT_SCHEMA = {
  type: 'object',
  required: ['text'],
  properties: { text: { type: 'string' } },
};

/** `draft` (agent) → `publish` (auto, shaped by `publish`). */
function draftThenPublish(id: string, publish: Record<string, unknown>): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: 1,
    steps: {
      draft: { description: 'Write the draft', execution: 'agent', input_schema: DRAFT_SCHEMA },
      publish: { description: 'Publish it', execution: 'auto', depends_on: ['draft'], ...publish },
    },
  } as unknown as WorkflowDefinition;
}

/** A registry whose `boom` handler throws. */
function boomRegistry(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.register('handler', 'boom', {
    id: 'boom',
    execute: async () => {
      throw new Error('the printer is on fire');
    },
  });
  return registry;
}

/** Drives the workflow to its end; returns the run, its id and every line printed to stderr. */
async function drive(
  definition: WorkflowDefinition,
  opts: {
    submissions?: Array<Record<string, unknown>>;
    registry?: ExtensionRegistry;
    schemaRetries?: number;
  } = {},
): Promise<{ store: InMemoryStore; runId: string; lines: string[] }> {
  const store = new InMemoryStore();
  const errors: string[] = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation((m: unknown) => {
    errors.push(String(m));
  });
  const deps = {
    store,
    workflowStore: {
      register: async () => {},
      get: async () => {
        throw new Error('not registered');
      },
      list: async () => [],
    },
    provider: new FixedProvider(opts.submissions ?? [{ text: 'hello' }]),
    registry: opts.registry ?? new ExtensionRegistry(),
    reattachFlags: '--model m',
    ...(opts.schemaRetries !== undefined ? { schemaRetries: opts.schemaRetries } : {}),
  } as unknown as AgentDeps;
  await runAgent(deps, { definition, params: {} });
  vi.restoreAllMocks();
  const runs = await store.list();
  return {
    store,
    runId: runs[0]!.id,
    lines: errors.join('\n').split('\n'),
  };
}

const startsWith = (lines: string[], prefix: string): string =>
  lines.find((l) => l.startsWith(prefix)) ??
  `(no line starting "${prefix}" in: ${lines.join(' | ')})`;

describe("realm agent names the step that stopped the call, when the engine ran it after the drive's step", () => {
  it("✗ — a chained step's handler throws: the line names it and says the engine ran it after the drive's step", async () => {
    const { lines } = await drive(draftThenPublish('stopped-cli-fail', { handler: 'boom' }), {
      registry: boomRegistry(),
    });
    const line = startsWith(lines, '✗ Step ');
    // (a) red when the line names the drive's step (`stepName` instead of `stopped_step`), or drops
    //     the clause; (b) prints the line, or every stderr line when none starts with "✗ Step ".
    expect(
      line.startsWith("✗ Step 'publish' (run by the engine after 'draft' finished) failed: "),
    ).toBe(true);
    // (a) red when the line loses the step's own error; (b) prints the line.
    expect(line).toContain('the printer is on fire');
  });

  it('⚠ — a chained step blocked on a missing handler: the line names it and the handler it needs', async () => {
    const { runId, lines } = await drive(
      draftThenPublish('stopped-cli-block', { handler: 'enricher' }),
    );
    // #625 PR-2a re-pin (round 9): PR-2a holds a chained capability block (decision C64, keyed on
    // `stopped_step` by C73): the agent step is said as completed, the blocked step is named once
    // on its `•` line, and the drive's exit — whose step IS the blocked one — prints the block line
    // without "(run by the engine after …)". (a) red when the line names the drive's step, or the
    // block lookup keys on the drive's step (the requirement then degrades to "the missing
    // handler"); (b) prints the line.
    expect(startsWith(lines, '⚠ Step ')).toBe(
      "⚠ Step 'publish' is blocked: handler 'enricher' is not registered in this runner. " +
        `The run is NOT failed — add handler 'enricher' and re-attach (\`realm agent --run-id ${runId} --model m\`).`,
    );
  });

  it("the drive-failure entry for a chained step's input refusal names that step", async () => {
    // `publish` requires `title`; the engine gives a chained step `{}`, so it is refused before its
    // claim — a wedge that only the drive-failure entry records.
    const { store, runId, lines } = await drive(
      draftThenPublish('stopped-cli-wedge', {
        input_schema: {
          type: 'object',
          required: ['title'],
          properties: { title: { type: 'string' } },
        },
      }),
    );
    // #625 PR-2a re-pin (round 9): PR-2a's chain never runs a step it refuses before its claim
    // (decision C13); the drive names it once and, with nothing else to run, stops on it (C31) —
    // recording the same wedge entry, under the refused step. (a) red when the line names the
    // drive's step; (b) prints the line.
    expect(
      startsWith(lines, '✗ The drive stops').startsWith(
        "✗ The drive stops: nothing else can run, and 'publish' cannot run (input_schema). ",
      ),
    ).toBe(true);
    const run = await store.get(runId);
    // (a) red when the entry's `step` is the drive's step; (b) prints every entry's step and class.
    expect(
      run.drive_failures?.entries.map((e) => ({ step: e.step, error_class: e.error_class })),
    ).toEqual([{ step: 'publish', error_class: 'validation_rejected' }]);
  });

  it("the schema-repair count stays with the drive's own step: a chained failure never says 'after N schema-repair attempts'", async () => {
    // The first submission misses `text` and is repaired once; the second is accepted, and the
    // chained step's handler then throws.
    const { lines } = await drive(draftThenPublish('stopped-cli-repair', { handler: 'boom' }), {
      submissions: [{}, { text: 'hello' }],
      registry: boomRegistry(),
    });
    // The repair really happened. (a) red when the provider's first submission is accepted;
    // (b) prints every stderr line.
    expect(lines.some((l) => l.includes('repairing (attempt 1/'))).toBe(true);
    const line = startsWith(lines, '✗ Step ');
    // (a) red when the suffix attaches to a chained step's line; (b) prints the line.
    expect(
      line.startsWith("✗ Step 'publish' (run by the engine after 'draft' finished) failed: "),
    ).toBe(true);
    expect(line).not.toContain('schema-repair');
  });

  it("CONTROL — the drive's own step fails: the line names it, with no clause", async () => {
    const def = {
      id: 'stopped-cli-own',
      name: 'own',
      version: 1,
      schema_version: 1,
      steps: { publish: { description: 'Publish it', execution: 'auto', handler: 'boom' } },
    } as unknown as WorkflowDefinition;
    const { lines } = await drive(def, { registry: boomRegistry() });
    const line = startsWith(lines, '✗ Step ');
    // (a) red when the clause is printed for the step's own reply; (b) prints the line.
    expect(line.startsWith("✗ Step 'publish' failed: ")).toBe(true);
  });
});

describe('realm workflow run names the step a failed reply belongs to', () => {
  it('a reply from a step the engine ran after the prompted one names both', () => {
    // (a) red when the clause is dropped or names the prompted step; (b) prints the line.
    expect(
      renderStepFailureLine(
        { status: 'error', errors: ["Handler 'boom' failed: x"], stopped_step: 'publish' },
        'draft',
      ),
    ).toBe(
      "  ✗ error (step 'publish', run by the engine after 'draft' finished): Handler 'boom' failed: x",
    );
  });

  it("CONTROL — the prompted step's own reply prints as before: it names that step itself", () => {
    // (a) red when the clause is printed whenever `stopped_step` is present — the prompted step's
    //     own reply names itself; (b) prints the line.
    expect(
      renderStepFailureLine(
        { status: 'error', errors: ['bad input'], stopped_step: 'draft' },
        'draft',
      ),
    ).toBe('  ✗ error: bad input');
    // A reply no step produced (an error of the chain itself). (a) red when the clause is printed
    //     without `stopped_step`; (b) prints the line.
    expect(renderStepFailureLine({ status: 'error', errors: ['bad input'] }, 'draft')).toBe(
      '  ✗ error: bad input',
    );
  });
});
