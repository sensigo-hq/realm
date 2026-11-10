// start-line-600.test.ts — issue #600 PR 2 (D1, G23): the drive's start line, one cell per form,
// per `<source>` row and per `<name>`, the absent-`deps.promptCache` case, the tools clause and the
// listen-child notice; and one drive that prints it after `Run ID:`. On a failing CI host each cell
// prints the line it built: no environment, header or key.
import { describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { promptCacheStartLine, type ResolvedPromptCache } from './prompt-cache.js';
import { runAgent } from './run-agent.js';
import { LlmProvider, type ProviderCapabilities } from './providers/llm-provider.js';

const agent = (tools?: string[]): StepDefinition =>
  ({ description: 'S.', execution: 'agent', ...(tools ? { tools } : {}) }) as StepDefinition;
const auto = { description: 'S.', execution: 'auto' } as StepDefinition;
const def = (steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id: 'start-line-600',
  name: 'start-line-600',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});
const SINGLE = def({ a: agent() });
const MIXED = def({ a: agent(), t: agent(['srv:op']) });
const ALL_TOOLS = def({ t: agent(['srv:op']) });
const NO_AGENT = def({ x: auto });

type Asked = 'off' | { lifetime_s: number };
const ANTHROPIC = (
  promptCache: Asked,
): Pick<ProviderCapabilities, 'promptCache' | 'providerId' | 'jsonMode'> => ({
  jsonMode: false,
  providerId: 'anthropic',
  promptCache,
});
const SHORT: Asked = { lifetime_s: 300 };
const LONG: Asked = { lifetime_s: 3600 };
const pc = (
  value: 'auto' | 'short' | 'long' | 'off',
  source: 'stated' | 'runner_default',
  by: 'realm agent' | 'realm listen',
  auto?: ResolvedPromptCache['auto'],
): ResolvedPromptCache => ({ value, source, by, ...(auto !== undefined ? { auto } : {}) });
const line = (
  caps: Pick<ProviderCapabilities, 'promptCache' | 'providerId' | 'jsonMode' | 'endpoint'>,
  promptCache: ResolvedPromptCache | undefined,
  definition: WorkflowDefinition = SINGLE,
  moduleProviderId?: string,
): string => promptCacheStartLine({ caps, promptCache, moduleProviderId, definition });
const FIX =
  "Caching: Anthropic is asked to cache each step's fixed instructions and the stable start of its prompt for";
const LISTEN_DEFAULT = "realm listen's default; change it with realm listen --prompt-cache";
const AGENT_DEFAULT = "realm agent's default; turn it off with --prompt-cache off";
const TOOLS_TAIL =
  ' On a step that calls tools, it is also asked to cache the conversation so far, at each turn.';

describe('the drive start line (issue #600, D1; the lifetime unit — B8)', () => {
  // Caching 3-M D-3 check 1: under `auto` the start line names no single lifetime, since each step
  // chooses its own from that step's earlier runs. The real cases: a drive `realm agent` starts, one
  // `realm listen` starts, and a stated `auto` on each, on each shape of workflow, on Anthropic and on
  // OpenAI in the explicit set. (a) red when the instance's lifetime is printed, or the tool sentence
  // is dropped on a mix (that row); (b) prints the line.
  const AUTO_ASK = `${FIX} 5 minutes, 1 hour or not at all, as auto chooses per step from that step's own earlier runs`;
  const AUTO_TOOLS =
    ' On a step that calls tools, it is asked for 5 minutes and also to cache the conversation so far, at each turn.';
  const OPENAI_EXPLICIT = {
    providerId: 'openai' as const,
    jsonMode: true,
    promptCache: { lifetime_s: 1800 },
    endpoint: 'default' as const,
  };
  const OPENAI_ASK =
    "Caching: OpenAI is asked to cache each step's fixed instructions and the stable start of its prompt for 30 minutes or not at all, as auto chooses per step from that step's own earlier runs";
  const OPENAI_TOOLS =
    " A step that calls tools is left to OpenAI's own caching, which reuses each turn at the next.";
  const AGENT_AUTO = pc('auto', 'runner_default', 'realm agent', { basis: 'no_measurement' });
  const LISTEN_AUTO = pc('auto', 'runner_default', 'realm listen', { basis: 'no_measurement' });
  it.each<[string, Parameters<typeof line>[0], ResolvedPromptCache, WorkflowDefinition, string]>([
    [
      'Anthropic, steps without tools only',
      ANTHROPIC(SHORT),
      AGENT_AUTO,
      SINGLE,
      `${AUTO_ASK} (${AGENT_DEFAULT}).`,
    ],
    [
      'Anthropic, a mix',
      ANTHROPIC(LONG),
      LISTEN_AUTO,
      MIXED,
      `${AUTO_ASK} (${LISTEN_DEFAULT}).${AUTO_TOOLS}`,
    ],
    [
      'Anthropic, every step with tools',
      ANTHROPIC(SHORT),
      pc('auto', 'stated', 'realm agent', { basis: 'no_measurement' }),
      ALL_TOOLS,
      "Caching: every agent step calls tools, so Anthropic is asked to cache each step's fixed instructions and the conversation so far, at each turn, for 5 minutes (set by --prompt-cache auto).",
    ],
    [
      'OpenAI in the explicit set, steps without tools only',
      OPENAI_EXPLICIT,
      pc('auto', 'stated', 'realm listen', { basis: 'no_measurement' }),
      SINGLE,
      `${OPENAI_ASK} (set by realm listen --prompt-cache auto).`,
    ],
    [
      'OpenAI in the explicit set, a mix',
      OPENAI_EXPLICIT,
      AGENT_AUTO,
      MIXED,
      `${OPENAI_ASK} (${AGENT_DEFAULT}).${OPENAI_TOOLS}`,
    ],
    [
      'OpenAI in the explicit set, every step with tools',
      OPENAI_EXPLICIT,
      AGENT_AUTO,
      ALL_TOOLS,
      "Caching: every agent step calls tools, so each is left to OpenAI's own caching, which reuses each turn at the next; Realm sends a cache key (auto, realm agent's default; turn it off with --prompt-cache off).",
    ],
    [
      'a workflow with no agent step',
      ANTHROPIC(SHORT),
      AGENT_AUTO,
      NO_AGENT,
      'Caching: no step is cached; this workflow has no agent step.',
    ],
  ])('auto: %s', (_case, caps, promptCache, definition, expected) => {
    expect(line(caps, promptCache, definition)).toBe(expected);
  });

  it('a stated short, long and off — no auto clause', () => {
    expect([
      line(ANTHROPIC(SHORT), pc('short', 'stated', 'realm agent')),
      line(ANTHROPIC(LONG), pc('long', 'stated', 'realm listen')),
      line(ANTHROPIC('off'), pc('off', 'stated', 'realm agent')),
      line(ANTHROPIC('off'), pc('off', 'stated', 'realm listen')),
    ]).toEqual([
      `${FIX} 5 minutes (set by --prompt-cache short).`,
      `${FIX} 1 hour (set by realm listen --prompt-cache long).`,
      'Caching: off; Anthropic is asked to cache nothing (set by --prompt-cache off).',
      'Caching: off; Anthropic is asked to cache nothing (set by realm listen --prompt-cache off).',
    ]);
  });

  // F1. (a) red when a module's own setting is attributed to the flag, or a value Realm cannot read
  // is printed as if it could; (b) prints the lines.
  it("F1 — a provider module's own setting: 'off', a readable lifetime, and one Realm cannot read", () => {
    const module = (promptCache: unknown) =>
      line(
        { jsonMode: false, promptCache: promptCache as Asked },
        undefined,
        SINGLE,
        'module:p.mjs',
      );
    expect([module('off'), module({ lifetime_s: 3600 }), module('1h')]).toEqual([
      'Caching: your provider module asks for no caching by its own setting; --prompt-cache does not apply to provider modules.',
      'Caching: your provider module asks for 1 hour by its own setting; --prompt-cache does not apply to provider modules.',
      'Caching: your provider module declares a caching setting Realm cannot read; --prompt-cache does not apply to provider modules.',
    ]);
  });

  // F2, per `<name>`. (a) red when `<name>` is always OpenAI; (b) prints the four lines.
  // caching 3-B (row 1): F2 is now only a provider without the capability; the OpenAI providers
  // declare 'provider' and get D4's words (all branches: `openai-endpoint-3b.test.ts`). (a) red when
  // an OpenAI provider falls to F2's old words, or F2 loses its own; (b) prints the lines.
  it('F2 — no capability: this provider; the OpenAI providers, declaring provider, take D4’s words', () => {
    const runner = pc('auto', 'runner_default', 'realm agent', { basis: 'no_measurement' });
    const OPENAI_LINE =
      "Caching: OpenAI caches by its own rules; Realm sends a cache key that helps repeated steps reach the same cache (OpenAI treats it as a hint). Realm cannot set OpenAI's lifetime or turn its caching off.";
    expect([
      line({ jsonMode: false }, runner),
      line(
        {
          providerId: 'openai-reasoning',
          jsonMode: false,
          promptCache: 'provider',
          endpoint: 'default',
        },
        runner,
      ),
      line(
        { providerId: 'openai', jsonMode: true, promptCache: 'provider', endpoint: 'default' },
        runner,
      ),
    ]).toEqual([
      'Caching: Realm asks this provider for no caching; any caching it does is its own.',
      OPENAI_LINE,
      OPENAI_LINE,
    ]);
  });

  // caching 3-B (row 1): a realm listen child on OpenAI given --prompt-cache long says D4's words
  // (F2's listen notice is gone with F2's OpenAI arm). (a) red when the child keeps the old notice;
  // (b) prints the lines.
  it('a realm listen child on OpenAI given --prompt-cache long says the key goes out and long sets no lifetime there', () => {
    const caps = {
      providerId: 'openai' as const,
      jsonMode: true,
      promptCache: 'provider' as const,
      endpoint: 'default' as const,
    };
    const OPENAI_LINE =
      "Caching: OpenAI caches by its own rules; Realm sends a cache key that helps repeated steps reach the same cache (OpenAI treats it as a hint). Realm cannot set OpenAI's lifetime or turn its caching off.";
    expect(line(caps, pc('long', 'stated', 'realm listen'))).toBe(
      `${OPENAI_LINE} --prompt-cache long sets no lifetime on OpenAI.`,
    );
    // Its default is not a flag anyone gave: no once-line.
    expect(
      line(caps, pc('auto', 'runner_default', 'realm listen', { basis: 'no_measurement' })),
    ).toBe(OPENAI_LINE);
  });

  // A tools-only workflow (issue #899: F4a is gone; caching 3-M D-3: under `auto`, its own line) and
  // F4b. (a) red when a tools-only workflow is said to have no step cached; (b) prints the lines.
  it('auto, every agent step calls tools: asked for 5 minutes at each turn (was F4a); F4b — on, no agent step', () => {
    expect([
      line(
        ANTHROPIC(SHORT),
        pc('auto', 'runner_default', 'realm agent', { basis: 'no_measurement' }),
        ALL_TOOLS,
      ),
      line(ANTHROPIC(LONG), pc('long', 'stated', 'realm listen'), NO_AGENT),
    ]).toEqual([
      `Caching: every agent step calls tools, so Anthropic is asked to cache each step's fixed instructions and the conversation so far, at each turn, for 5 minutes (${AGENT_DEFAULT}).`,
      'Caching: no step is cached; this workflow has no agent step.',
    ]);
  });

  // The tools clause. (a) red when it is never printed; (b) prints the line.
  it('F5 — a workflow that also has tool-calling agent steps says they are asked to cache the conversation at each turn', () => {
    expect(line(ANTHROPIC(SHORT), pc('short', 'stated', 'realm agent'), MIXED)).toBe(
      `${FIX} 5 minutes (set by --prompt-cache short).${TOOLS_TAIL}`,
    );
  });

  // M10 (issue #899): one line per producing branch, the at-stake branch first. (a) red when the
  // condition goes back to `singleShot === 0` (the tools-only line becomes F4b), or when the tail
  // prints without a step that calls tools; (b) prints the four lines.
  it('M10 — tools only → F5 with the tail; mixed → F5 with the tail; single-shot only → F5 without it; no agent step → F4b', () => {
    const stated = pc('short', 'stated', 'realm agent');
    expect([
      line(ANTHROPIC(SHORT), stated, ALL_TOOLS),
      line(ANTHROPIC(SHORT), stated, MIXED),
      line(ANTHROPIC(SHORT), stated, SINGLE),
      line(ANTHROPIC(SHORT), stated, NO_AGENT),
    ]).toEqual([
      `${FIX} 5 minutes (set by --prompt-cache short).${TOOLS_TAIL}`,
      `${FIX} 5 minutes (set by --prompt-cache short).${TOOLS_TAIL}`,
      `${FIX} 5 minutes (set by --prompt-cache short).`,
      'Caching: no step is cached; this workflow has no agent step.',
    ]);
  });

  // Absent `deps.promptCache` (a host calling runAgent itself). (a) red when F3 or F5 print a
  // parenthetical they have no source for; (b) prints the lines.
  it('a host that passes no promptCache: F3 and F5 leave out their parenthetical', () => {
    expect([line(ANTHROPIC('off'), undefined), line(ANTHROPIC(LONG), undefined)]).toEqual([
      'Caching: off; Anthropic is asked to cache nothing.',
      `${FIX} 1 hour.`,
    ]);
  });

  // The drive prints it, between `Run ID:` and the blank line, from deps.promptCache. (a) red when
  // the drive does not pass deps.promptCache to the line; (b) prints the drive's first lines.
  it('a drive prints the line after Run ID:, with the setting realm agent resolved', async () => {
    const store = new InMemoryStore();
    const provider = new (class extends LlmProvider {
      override capabilities(): ProviderCapabilities {
        return { jsonMode: false, providerId: 'anthropic', promptCache: { lifetime_s: 300 } };
      }
      async callStep(): Promise<Record<string, unknown>> {
        return {};
      }
    })();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runAgent(
        {
          store,
          workflowStore: {
            async register() {},
            async get() {
              return SINGLE;
            },
            async list() {
              return [SINGLE];
            },
          },
          provider,
          registry: createDefaultRegistry(),
          promptCache: pc('auto', 'runner_default', 'realm agent', { basis: 'no_measurement' }),
        },
        { definition: SINGLE, params: {} },
      );
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.slice(1, 4).map((l) => l.replace(/Run ID: \S+/, 'Run ID: <run>'))).toEqual([
      'Run ID: <run>',
      `${FIX} 5 minutes, 1 hour or not at all, as auto chooses per step from that step's own earlier runs (${AGENT_DEFAULT}).`,
      '',
    ]);
  });
});
