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
import type { PendingView, RunRecord, WorkflowDefinition } from '@sensigo/realm';
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
        // decision C205: an agent step — `Drive it with:` is printed only when one is ready.
        steps: { 'step-one': { description: 'First step', execution: 'agent' } },
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
        `Add the other flags the run was driven with, such as --extensions-module, --project or --prompt-cache (realm run inspect ${run.id} shows the extension module the run loaded, and, where it recorded them, the model and caching setting of each request).`,
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
    // decision C202: the map offers the drive where an agent step is ready — here, the step asked for.
    const agentReady: { pending: PendingView; workflow: WorkflowDefinition } = {
      pending: {
        owed: [],
        agent_steps: ['summarise'],
        agent_refused: [],
        pending_guards: [],
        engine_runnable: [],
        cannot_run: [],
      },
      // #729 PR-0: the map composes the run's ways from the whole definition.
      workflow: { id: 'wf', name: 'wf', version: 1, steps: {} } as unknown as WorkflowDefinition,
    };
    const line = renderDetachMap(record, 'summarise', agentReady)
      .split('\n')
      .find((l) => l.startsWith('  Drive it:'));
    expect(line).toBe(`  Drive it:  realm agent --run-id run_abc ${PLACEHOLDER}`);
    // The flags the dev run was given that `realm agent` takes too ride on the same line.
    // (a) red when `driveFlags` is not appended; (b) prints the line.
    const withFlags = renderDetachMap(record, 'summarise', agentReady, {
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

  // issue #600 PR 2 (C6, G22). (a) red when a given value is not repeated, or lands before
  // --mint-writer-nonce; (b) prints the flags.
  it('--prompt-cache, when given, is repeated after --mint-writer-nonce; never when not given', () => {
    expect(buildReattachFlags({ model: 'm', mintWriterNonce: true, promptCache: 'long' })).toBe(
      '--model m --mint-writer-nonce --prompt-cache long',
    );
    expect(buildReattachFlags({ model: 'm' })).toBe('--model m');
    // The hidden flags are never printed, whatever the options carry.
    const opts = {
      model: 'm',
      spawnedByListen: true,
      releaseLineAdvisory: false,
    } as unknown as Parameters<typeof buildReattachFlags>[0];
    expect(buildReattachFlags(opts)).toBe('--model m');
  });
});

// #729 PR-0 (RE-CUT; caching PR 2's R6-1): the prompt-cache rule lives INSIDE the one builder — the
// caller says only where the setting came from and whether the provider applies it.
describe('#729 PR-0 — buildReattachFlags owns the prompt-cache rule', () => {
  it('a stated setting the provider applies is repeated; a default, or one the provider cannot apply, never is', () => {
    // (a) red when the rule is left at a caller (the builder repeats whatever it is given); (b)
    //     prints the three flag strings.
    expect([
      buildReattachFlags({
        model: 'm',
        promptCache: 'long',
        promptCacheSource: 'stated',
        providerAppliesPromptCache: true,
      }),
      buildReattachFlags({
        model: 'm',
        promptCache: 'long',
        promptCacheSource: 'default',
        providerAppliesPromptCache: true,
      }),
      buildReattachFlags({
        model: 'm',
        promptCache: 'long',
        promptCacheSource: 'stated',
        providerAppliesPromptCache: false,
      }),
    ]).toEqual(['--model m --prompt-cache long', '--model m', '--model m']);
  });

  // Cell 9 (the lifetime unit), called as the command calls it — its parsed options spread, a
  // listen child's `--cache-gaps` among them. (a) red when the builder repeats `--cache-gaps`, or
  // drops a stated `auto`; (b) prints the flag strings.
  it('a stated auto is repeated like any word; --cache-gaps never is', () => {
    const parsed = {
      model: 'm',
      promptCache: 'auto',
      spawnedByListen: true,
      cacheGaps: '420,720',
    } as unknown as Parameters<typeof buildReattachFlags>[0];
    // The default: the command's options carry no `promptCache` at all.
    const { promptCache: _stated, ...unstated } = parsed;
    expect([
      buildReattachFlags({
        ...parsed,
        promptCacheSource: 'stated',
        providerAppliesPromptCache: true,
      }),
      buildReattachFlags({
        ...unstated,
        promptCacheSource: 'stated',
        providerAppliesPromptCache: true,
      }),
    ]).toEqual(['--model m --prompt-cache auto', '--model m']);
  });
});

// issue #600 PR 2 (C6, G22): the in-flight `Go on:` line (run-agent's goOnLine) carries the flags
// built by buildReattachFlags, a stated --prompt-cache included. (a) red when the line drops it;
// (b) prints the line.
describe('the Go on: line repeats a stated --prompt-cache (issue #600 PR 2)', () => {
  it("a step another program holds: the line ends with the drive's own flags", async () => {
    const def: WorkflowDefinition = {
      id: 'go-on-600',
      name: 'Go on 600',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { write: { description: 'Write', execution: 'agent' } },
    };
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await store.claimStep(run.id, 'write', def, {
      by: 'someone-else',
      by_source: 'stated',
      channel: 'run',
    });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const flags = buildReattachFlags({ model: 'claude-x', promptCache: 'long' });
    await runAgent(
      {
        store,
        workflowStore: { register: async () => {}, get: async () => def, list: async () => [def] },
        provider: new (class extends LlmProvider {
          async callStep(): Promise<Record<string, unknown>> {
            throw new Error('not called');
          }
        })(),
        registry: new ExtensionRegistry(),
        reattachFlags: flags,
      } as unknown as AgentDeps,
      {
        definition: def,
        params: {},
        existingRunId: run.id,
        inFlightPollMs: 5,
        inFlightWatchMs: 20,
      },
    );
    vi.restoreAllMocks();
    expect(lines.find((l) => l.includes('Go on:'))).toBe(
      `  Go on:     once 'write' is no longer in flight, realm agent --run-id ${run.id} --model claude-x --prompt-cache long`,
    );
  });
});
