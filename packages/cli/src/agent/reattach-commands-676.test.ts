// reattach-commands-676.test.ts — issue #676: every command realm prints for an operator to
// continue a run names the model flags it needs (realm has no default model).
//
// - `realm run resume` and the dev-run detach map cannot know them: they print
//   `--provider <provider> --model <model>` for the operator to fill in.
// - A drive blocked by a missing handler knows how it was started: its re-attach command repeats
//   the drive's own model flags (`AgentDeps.reattachFlags`, built by `buildReattachFlags`).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
} from '@sensigo/realm';
import type { RunRecord, WorkflowDefinition } from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import type { AgentDeps } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { renderDetachMap } from '../commands/run.js';
import { resumeCommand } from '../commands/resume.js';
import { buildReattachFlags } from '../commands/agent.js';

const PLACEHOLDER = '--provider <provider> --model <model>';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('realm run resume prints the model flags to fill in (issue #676)', () => {
  it('the whole "Drive it with:" line', async () => {
    const savedHome = process.env['HOME'];
    const home = mkdtempSync(join(tmpdir(), 'realm-676-resume-'));
    process.env['HOME'] = home;
    try {
      const workflow: WorkflowDefinition = {
        id: 'resume-676-wf',
        name: 'Resume 676',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: { 'step-one': { description: 'First step', execution: 'auto' } },
      };
      // Built AFTER HOME is set: both stores resolve their folder at construction.
      const runStore = new JsonFileStore();
      await new JsonWorkflowStore().register(workflow);
      const { run } = await runStore.create({
        workflowId: workflow.id,
        workflowVersion: 1,
        params: {},
      });
      await runStore.update({
        ...run,
        run_phase: 'failed',
        failed_steps: ['step-one'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        terminal_reason: 'Something went wrong',
      });

      const printed: string[] = [];
      vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
        printed.push(String(m));
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${String(code)})`);
      }) as () => never);

      await resumeCommand.parseAsync([run.id, '--from', 'step-one'], { from: 'user' });

      const line = printed
        .join('\n')
        .split('\n')
        .find((l) => l.startsWith('Drive it with:'));
      expect(line).toBe(`Drive it with: realm agent --run-id ${run.id} ${PLACEHOLDER}`);
      // The command cannot carry the drive's other flags (a different command took them), so the
      // next line says to add them and where to find the extension module the run loaded.
      // (a) red when that line is dropped or reworded; (b) prints the line after "Drive it with:".
      const lines = printed.join('\n').split('\n');
      expect(lines[lines.indexOf(line!) + 1]).toBe(
        `Add the other flags the run was driven with, such as --extensions-module or --project (realm run inspect ${run.id} shows the extension module the run loaded).`,
      );
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('the dev-run detach map prints the model flags to fill in (issue #676)', () => {
  it('the whole "Drive it:" line', () => {
    const record = {
      id: 'run_abc',
      workflow_id: 'wf',
      workflow_version: 1,
      version: 1,
      run_phase: 'running',
      terminal_state: false,
      params: {},
      completed_steps: [],
      failed_steps: [],
      evidence: [],
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    } as unknown as RunRecord;
    const line = renderDetachMap(record, 'summarise')
      .split('\n')
      .find((l) => l.startsWith('  Drive it:'));
    expect(line).toBe(`  Drive it:  realm agent --run-id run_abc ${PLACEHOLDER}`);
    // The flags the dev run was given that `realm agent` takes too ride on the same line.
    // (a) red when `driveFlags` is not appended; (b) prints the line.
    const withFlags = renderDetachMap(record, 'summarise', {
      driveFlags: buildReattachFlags({ extensionsModule: './ext.mjs', mintWriterNonce: true }),
    })
      .split('\n')
      .find((l) => l.startsWith('  Drive it:'));
    expect(withFlags).toBe(
      `  Drive it:  realm agent --run-id run_abc ${PLACEHOLDER} --extensions-module ./ext.mjs --mint-writer-nonce`,
    );
  });
});

describe('a drive blocked by a missing handler repeats its own model flags (issue #676)', () => {
  /** A provider that is never called: the only step is an `auto` step. */
  class UnusedProvider extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      throw new Error('not called');
    }
  }

  const BLOCKED_WF = {
    id: 'reattach-676',
    name: 'Reattach 676',
    version: 1,
    schema_version: 1,
    steps: { enrich: { description: 'Enrich', execution: 'auto', handler: 'enricher' } },
  } as unknown as WorkflowDefinition;

  /** Drives the run to the block; returns the run id and the printed "is blocked" line. */
  async function blockedLine(reattachFlags?: string): Promise<{ runId: string; line: string }> {
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
      provider: new UnusedProvider(),
      registry: new ExtensionRegistry(),
      ...(reattachFlags !== undefined ? { reattachFlags } : {}),
    } as unknown as AgentDeps;
    await runAgent(deps, { definition: BLOCKED_WF, params: {} });
    vi.restoreAllMocks();
    const runs = await store.list();
    const line = errors
      .join('\n')
      .split('\n')
      .find((l) => l.startsWith("⚠ Step 'enrich' is blocked:"));
    return { runId: runs[0]!.id, line: line ?? `(no blocked line in: ${errors.join(' | ')})` };
  }

  const expected = (runId: string, flags: string): string =>
    "⚠ Step 'enrich' is blocked: handler 'enricher' is not registered in this runner. " +
    `The run is NOT failed — add handler 'enricher' and re-attach (\`realm agent --run-id ${runId} ${flags}\`).`;

  it('--model claude-x', async () => {
    const { runId, line } = await blockedLine('--model claude-x');
    expect(line).toBe(expected(runId, '--model claude-x'));
  });

  it('--provider anthropic --model claude-x', async () => {
    const { runId, line } = await blockedLine('--provider anthropic --model claude-x');
    expect(line).toBe(expected(runId, '--provider anthropic --model claude-x'));
  });

  it('--provider-module ./p.mjs', async () => {
    const { runId, line } = await blockedLine('--provider-module ./p.mjs');
    expect(line).toBe(expected(runId, '--provider-module ./p.mjs'));
  });

  it("a quoted value with a space and a ' (built by buildReattachFlags)", async () => {
    const flags = buildReattachFlags({ provider: 'anthropic', model: "my model's" });
    const { runId, line } = await blockedLine(flags);
    expect(line).toBe(expected(runId, `--provider anthropic --model 'my model'\\''s'`));
  });

  it('no reattachFlags (a host that calls runAgent itself) → the placeholder', async () => {
    const { runId, line } = await blockedLine(undefined);
    expect(line).toBe(expected(runId, PLACEHOLDER));
  });
});

describe('buildReattachFlags (issue #676)', () => {
  it('the order: --provider, --model, --base-url, --strict-base-url', () => {
    expect(
      buildReattachFlags({
        strictBaseUrl: true,
        baseUrl: 'https://compat.example/v1',
        model: 'deepseek-chat',
        provider: 'openai',
      }),
    ).toBe(
      '--provider openai --model deepseek-chat --base-url https://compat.example/v1 --strict-base-url',
    );
  });

  it('--provider-module alone when given', () => {
    expect(buildReattachFlags({ providerModule: './p.mjs' })).toBe('--provider-module ./p.mjs');
  });

  it('each drive flag the operator gave is repeated, each on its own (issue #676 review)', () => {
    expect(buildReattachFlags({ model: 'm', extensionsModule: './ext.mjs' })).toBe(
      '--model m --extensions-module ./ext.mjs',
    );
    expect(buildReattachFlags({ model: 'm', project: '/srv/app' })).toBe(
      '--model m --project /srv/app',
    );
    expect(buildReattachFlags({ model: 'm', schemaRetries: 0 })).toBe(
      '--model m --schema-retries 0',
    );
    expect(buildReattachFlags({ model: 'm', llmTimeout: 45 })).toBe('--model m --llm-timeout 45');
    expect(buildReattachFlags({ model: 'm', mintWriterNonce: true })).toBe(
      '--model m --mint-writer-nonce',
    );
  });

  it('--schema-retries at its default (2), and flags left unset, are not repeated', () => {
    expect(buildReattachFlags({ model: 'm', schemaRetries: 2, mintWriterNonce: false })).toBe(
      '--model m',
    );
  });

  it('--provider-module with the other drive flags, in order', () => {
    expect(
      buildReattachFlags({
        providerModule: './p.mjs',
        extensionsModule: './ext.mjs',
        project: '/srv/app',
        schemaRetries: 4,
        llmTimeout: 30,
        mintWriterNonce: true,
      }),
    ).toBe(
      '--provider-module ./p.mjs --extensions-module ./ext.mjs --project /srv/app --schema-retries 4 --llm-timeout 30 --mint-writer-nonce',
    );
  });

  it('flags that only apply when a run is created are never repeated', () => {
    const opts = {
      model: 'm',
      workflow: './wf.yaml',
      params: '{"a":1}',
      register: true,
      releaseLineAdvisory: false,
    } as unknown as Parameters<typeof buildReattachFlags>[0];
    expect(buildReattachFlags(opts)).toBe('--model m');
  });

  it('a value with a space is single-quoted', () => {
    expect(buildReattachFlags({ providerModule: './my providers/p.mjs' })).toBe(
      "--provider-module './my providers/p.mjs'",
    );
  });
});
