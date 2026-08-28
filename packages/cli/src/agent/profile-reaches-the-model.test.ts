// profile-reaches-the-model.test.ts — issue #417 pin debt.
//
// Two shipped messages make claims about the world that nothing pinned:
//
//   `agent_profile` — "its content is resolved into the model prompt"
//   `agent_profile`/`llm_timeout_seconds` — "only an agent step makes a model request"
//
// The first was pinned only at helper level (buildSystemPrompt composes a string), which proves
// the composer works, not that the profile an author wrote reaches a request. The class-level
// provider doubles elsewhere in this suite cannot close that gap: the profile travels to them as
// an ARGUMENT (run-agent.ts:583-586) and is composed into a system prompt only inside the real
// providers, so a `vi.fn()` never sees one.
//
// The second is a STRUCTURAL claim — it is true only while one call site constructs providers.
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '@sensigo/realm-testing';
import { ExtensionRegistry } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { startOpenAiStub } from './test-support/openai-stub.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { runAgent, type AgentDeps } from './run-agent.js';

const PROFILE_CONTENT = 'You are a meticulous reviewer. Cite file and line for every claim.';

describe("#417 — an agent_profile's content reaches the model request", () => {
  it('travels from the definition, through the drive, onto the wire', async () => {
    // FULL CHAIN, and the assertion is on what the wire RECEIVED rather than on what the drive
    // returned. The stub scripts a tool call, and this step advertises no tools, so the drive
    // fails after the request is sent — which is fine: the request is captured before the
    // response is written, and the claim under test is about the request.
    const stub = await startOpenAiStub({
      firstToolCall: { match: /never-used/, arguments: {} },
      finalContent: { summary: 'never reached' },
    });
    // The REAL SDK refuses to construct without one. Distinctive on purpose: `sanitizeError`
    // redacts every env value over four characters as a substring, so a key colliding with the
    // profile text would rewrite the very string this cell asserts on.
    const originalKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-test-profile-chain-0000';

    try {
      const definition = {
        id: 'profile-wf',
        name: 'Profile Workflow',
        version: 1,
        schema_version: 1,
        // Resolved profiles are a plain map read at drive time (run-agent.ts:585) — no external
        // profile files are needed to exercise the path an author's profile actually takes.
        resolved_profiles: { reviewer: { content: PROFILE_CONTENT } },
        steps: {
          review: {
            description: 'Review the change',
            execution: 'agent',
            depends_on: [],
            agent_profile: 'reviewer',
            input_schema: {
              type: 'object',
              properties: { summary: { type: 'string' } },
              required: ['summary'],
            },
          },
        },
      } as unknown as WorkflowDefinition;

      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await runAgent(
        {
          store: new InMemoryStore(),
          workflowStore: {
            register: async () => {},
            get: async () => definition,
            list: async () => [],
          },
          provider: new OpenAIProvider('gpt-x', stub.baseUrl),
          registry: new ExtensionRegistry(),
        } as unknown as AgentDeps,
        { definition, params: {} },
      );
      vi.restoreAllMocks();

      expect(stub.requests.length).toBeGreaterThan(0);
      const system = (stub.requests[0]?.messages ?? []).find((m) => m.role === 'system');
      expect(String(system?.content)).toContain(PROFILE_CONTENT);
    } finally {
      await stub.close();
      if (originalKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = originalKey;
    }
  }, 20_000);

  it('STRUCTURAL — exactly one production site constructs a provider', () => {
    // "Only an agent step makes a model request" is true because provider construction happens in
    // exactly one place, on the agent command's path. A second site anywhere in the CLI would
    // make two shipped messages confidently wrong, and nothing else here would notice.
    //
    // SCOPE: packages/cli/src, excluding tests and the DEFINITION itself in llm-provider.ts — a
    // naive grep counts two and would pass while proving nothing.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const callSites: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.endsWith('.test.ts') &&
          entry.name !== 'llm-provider.ts'
        ) {
          for (const line of readFileSync(full, 'utf8').split('\n')) {
            if (line.includes('resolveProvider(')) callSites.push(`${entry.name}: ${line.trim()}`);
          }
        }
      }
    };
    walk(root);

    expect(callSites, `provider construction sites: ${callSites.join(' | ')}`).toHaveLength(1);
    expect(callSites[0]).toContain('agent.ts');
    // Non-vacuity: the walk read real files, not an empty tree.
    expect(readdirSync(root).length).toBeGreaterThan(3);
  });
});
