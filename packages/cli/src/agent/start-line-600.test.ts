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

const ANTHROPIC = (
  value: 'off' | '5m' | '1h',
): Pick<ProviderCapabilities, 'promptCache' | 'providerId' | 'jsonMode'> => ({
  jsonMode: false,
  providerId: 'anthropic',
  promptCache: value,
});
const pc = (
  value: 'off' | '5m' | '1h',
  source: 'stated' | 'runner_default',
  by: 'realm agent' | 'realm listen',
): ResolvedPromptCache => ({ value, source, by });
const line = (
  caps: Pick<ProviderCapabilities, 'promptCache' | 'providerId' | 'jsonMode'>,
  promptCache: ResolvedPromptCache | undefined,
  definition: WorkflowDefinition = SINGLE,
  moduleProviderId?: string,
): string => promptCacheStartLine({ caps, promptCache, moduleProviderId, definition });

describe('the drive start line (issue #600 PR 2, D1)', () => {
  // F1. (a) red when a module's own setting is attributed to the flag; (b) prints the line.
  it('F1 — a provider module that declares promptCache: its own setting, which the flag does not reach', () => {
    const caps = { jsonMode: false, promptCache: '1h' as const };
    expect(line(caps, undefined, SINGLE, 'module:p.mjs')).toBe(
      'Caching: your provider module asks for 1h by its own setting; --prompt-cache does not apply to provider modules.',
    );
    expect(line({ jsonMode: false, promptCache: 'off' }, undefined, SINGLE, 'module:p.mjs')).toBe(
      'Caching: your provider module asks for no caching by its own setting; --prompt-cache does not apply to provider modules.',
    );
  });

  // F2, per `<name>`. (a) red when `<name>` is always OpenAI; (b) prints the four lines.
  it('F2 — no capability: OpenAI (o1, and OpenAI native), this endpoint (OpenAI at --base-url), this provider', () => {
    const f2 = (caps: Pick<ProviderCapabilities, 'providerId' | 'jsonMode'>) =>
      line({ ...caps }, pc('5m', 'runner_default', 'realm agent'));
    expect([
      f2({ providerId: 'openai-reasoning', jsonMode: false }),
      f2({ providerId: 'openai', jsonMode: true }),
      f2({ providerId: 'openai', jsonMode: false }),
      f2({ jsonMode: false }),
    ]).toEqual([
      'Caching: Realm asks OpenAI for no caching; any caching it does is its own.',
      'Caching: Realm asks OpenAI for no caching; any caching it does is its own.',
      'Caching: Realm asks this endpoint for no caching; any caching it does is its own.',
      'Caching: Realm asks this provider for no caching; any caching it does is its own.',
    ]);
  });

  // F2's listen-child notice. (a) red when a listen child given the flag gets F2 without its
  // notice; (b) prints the line.
  it("F2 — a realm listen child given --prompt-cache adds that listen's flag applies only to Anthropic", () => {
    const caps = { providerId: 'openai' as const, jsonMode: true };
    expect(line(caps, pc('1h', 'stated', 'realm listen'))).toBe(
      'Caching: Realm asks OpenAI for no caching; any caching it does is its own. realm listen --prompt-cache 1h applies only to Anthropic.',
    );
    // Its default is not a flag anyone gave: no notice.
    expect(line(caps, pc('1h', 'runner_default', 'realm listen'))).toBe(
      'Caching: Realm asks OpenAI for no caching; any caching it does is its own.',
    );
  });

  // F3, with each `<source>` row. (a) red when F5 is tested before F3, or the stated and default
  // source texts are swapped; (b) prints the lines.
  it('F3 — off, with each source row', () => {
    expect([
      line(ANTHROPIC('off'), pc('off', 'stated', 'realm agent')),
      line(ANTHROPIC('off'), pc('off', 'stated', 'realm listen')),
    ]).toEqual([
      'Caching: off; Anthropic is asked to cache nothing (set by --prompt-cache off).',
      'Caching: off; Anthropic is asked to cache nothing (set by realm listen --prompt-cache off).',
    ]);
  });

  // F4a and F4b. (a) red when the two are swapped; (b) prints the lines.
  it('F4a — on, every agent step calls tools; F4b — on, no agent step', () => {
    expect([
      line(ANTHROPIC('5m'), pc('5m', 'runner_default', 'realm agent'), ALL_TOOLS),
      line(ANTHROPIC('1h'), pc('1h', 'runner_default', 'realm listen'), NO_AGENT),
    ]).toEqual([
      'Caching: no step is cached; every agent step in this workflow calls tools, and steps that call tools are not cached yet.',
      'Caching: no step is cached; this workflow has no agent step.',
    ]);
  });

  // F5, with each `<source>` row. (a) red when the stated and default texts are swapped; (b) prints
  // the lines.
  it('F5 — on, with single-shot steps, with each source row', () => {
    expect([
      line(ANTHROPIC('1h'), pc('1h', 'stated', 'realm agent')),
      line(ANTHROPIC('5m'), pc('5m', 'stated', 'realm listen')),
      line(ANTHROPIC('5m'), pc('5m', 'runner_default', 'realm agent')),
      line(ANTHROPIC('1h'), pc('1h', 'runner_default', 'realm listen')),
    ]).toEqual([
      "Caching: Anthropic is asked to cache each step's fixed instructions for 1h (set by --prompt-cache 1h).",
      "Caching: Anthropic is asked to cache each step's fixed instructions for 5m (set by realm listen --prompt-cache 5m).",
      "Caching: Anthropic is asked to cache each step's fixed instructions for 5m (realm agent's default; turn it off with --prompt-cache off).",
      "Caching: Anthropic is asked to cache each step's fixed instructions for 1h (realm listen's default; change it with realm listen --prompt-cache).",
    ]);
  });

  // The tools clause. (a) red when it is never printed; (b) prints the line.
  it('F5 — a workflow that also has tool-calling agent steps says they are not cached yet', () => {
    expect(line(ANTHROPIC('5m'), pc('5m', 'runner_default', 'realm agent'), MIXED)).toBe(
      "Caching: Anthropic is asked to cache each step's fixed instructions for 5m (realm agent's default; turn it off with --prompt-cache off). Steps that call tools are not cached yet.",
    );
  });

  // Absent `deps.promptCache` (a host calling runAgent itself). (a) red when F3 or F5 print a
  // parenthetical they have no source for; (b) prints the lines.
  it('a host that passes no promptCache: F3 and F5 leave out their parenthetical', () => {
    expect([line(ANTHROPIC('off'), undefined), line(ANTHROPIC('1h'), undefined)]).toEqual([
      'Caching: off; Anthropic is asked to cache nothing.',
      "Caching: Anthropic is asked to cache each step's fixed instructions for 1h.",
    ]);
  });

  // The drive prints it, between `Run ID:` and the blank line, from deps.promptCache. (a) red when
  // the drive does not pass deps.promptCache to the line; (b) prints the drive's first lines.
  it('a drive prints the line after Run ID:, with the setting realm agent resolved', async () => {
    const store = new InMemoryStore();
    const provider = new (class extends LlmProvider {
      override capabilities(): ProviderCapabilities {
        return { jsonMode: false, providerId: 'anthropic', promptCache: '5m' };
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
          promptCache: pc('5m', 'runner_default', 'realm agent'),
        },
        { definition: SINGLE, params: {} },
      );
    } finally {
      vi.restoreAllMocks();
    }
    expect(lines.slice(1, 4).map((l) => l.replace(/Run ID: \S+/, 'Run ID: <run>'))).toEqual([
      'Run ID: <run>',
      "Caching: Anthropic is asked to cache each step's fixed instructions for 5m (realm agent's default; turn it off with --prompt-cache off).",
      '',
    ]);
  });
});
