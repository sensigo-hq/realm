// start-line-600.test.ts — issue #600 PR 2 (D1, G23): the drive's start line, one cell per form,
// per `<source>` row and per `<name>`, the absent-`deps.promptCache` case, the tools clause and the
// listen-child notice; and one drive that prints it after `Run ID:`. On a failing CI host each cell
// prints the line it built: no environment, header or key.
import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAnthropicStub } from './test-support/anthropic-stub.js';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { lifetimeText, promptCacheStartLine, type ResolvedPromptCache } from './prompt-cache.js';
import { runAgent } from './run-agent.js';
import { LlmProvider, type ProviderCapabilities } from './providers/llm-provider.js';
import { makeTempHome, runIds } from '../test-support/temp-home.js';

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
  // One cell per producing branch of B8, the at-stake branch first: `auto` choosing the long
  // lifetime from listen's gaps. (a) red when the reason clause drops what `auto` read, or the
  // duration is not in words; (b) prints the line (test values only).
  it('auto → long, from the gaps listen measured', () => {
    expect(
      line(
        ANTHROPIC(LONG),
        pc('auto', 'runner_default', 'realm listen', {
          basis: 'listen_trigger_gaps',
          gaps_s: [420, 720],
        }),
      ),
    ).toBe(
      `${FIX} 1 hour (auto: the last 2 gaps between this workflow's triggers were about 7 minutes and 12 minutes; ${LISTEN_DEFAULT}).`,
    );
  });

  it('auto → short (a drive realm agent starts on its own) and auto → off (gaps of two hours)', () => {
    expect([
      line(
        ANTHROPIC(SHORT),
        pc('auto', 'runner_default', 'realm agent', { basis: 'no_measurement' }),
      ),
      line(
        ANTHROPIC('off'),
        pc('auto', 'runner_default', 'realm listen', {
          basis: 'listen_trigger_gaps',
          gaps_s: [7200, 7200, 7200],
        }),
      ),
    ]).toEqual([
      `${FIX} 5 minutes (auto: a drive realm agent starts on its own has no trigger history; ${AGENT_DEFAULT}).`,
      `Caching: off; Anthropic is asked to cache nothing (auto: the last 3 gaps between this workflow's triggers were about 2 hours, 2 hours and 2 hours; ${LISTEN_DEFAULT}).`,
    ]);
  });

  it("auto — listen's first trigger of a workflow, and a measurement that could not be read", () => {
    expect([
      line(
        ANTHROPIC(LONG),
        pc('auto', 'runner_default', 'realm listen', { basis: 'listen_trigger_gaps', gaps_s: [] }),
      ),
      line(
        ANTHROPIC(LONG),
        pc('auto', 'runner_default', 'realm listen', { basis: 'listen_gaps_unreadable' }),
      ),
      line(
        ANTHROPIC(SHORT),
        pc('auto', 'runner_default', 'realm listen', {
          basis: 'listen_trigger_gaps',
          gaps_s: [10],
        }),
      ),
    ]).toEqual([
      `${FIX} 1 hour (auto: no earlier trigger of this workflow since realm listen started; ${LISTEN_DEFAULT}).`,
      `${FIX} 1 hour (auto: realm listen's measurement could not be read; ${LISTEN_DEFAULT}).`,
      `${FIX} 5 minutes (auto: the last gap between this workflow's triggers was about 10 seconds; ${LISTEN_DEFAULT}).`,
    ]);
  });

  it('a stated auto, on realm agent and on realm listen', () => {
    expect([
      line(ANTHROPIC(SHORT), pc('auto', 'stated', 'realm agent', { basis: 'no_measurement' })),
      line(
        ANTHROPIC(LONG),
        pc('auto', 'stated', 'realm listen', { basis: 'listen_trigger_gaps', gaps_s: [600] }),
      ),
    ]).toEqual([
      `${FIX} 5 minutes (auto: a drive realm agent starts on its own has no trigger history; set by --prompt-cache auto).`,
      `${FIX} 1 hour (auto: the last gap between this workflow's triggers was about 10 minutes; set by realm listen --prompt-cache auto).`,
    ]);
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
      line(
        caps,
        pc('auto', 'runner_default', 'realm listen', { basis: 'listen_trigger_gaps', gaps_s: [] }),
      ),
    ).toBe(OPENAI_LINE);
  });

  // F5 for a tools-only workflow (issue #899: F4a is gone) and F4b. (a) red when a tools-only
  // workflow is said to have no step cached; (b) prints the lines.
  it('F5 with the tools tail — on, every agent step calls tools (was F4a); F4b — on, no agent step', () => {
    expect([
      line(
        ANTHROPIC(SHORT),
        pc('auto', 'runner_default', 'realm agent', { basis: 'no_measurement' }),
        ALL_TOOLS,
      ),
      line(ANTHROPIC(LONG), pc('long', 'stated', 'realm listen'), NO_AGENT),
    ]).toEqual([
      `${FIX} 5 minutes (auto: a drive realm agent starts on its own has no trigger history; ${AGENT_DEFAULT}).${TOOLS_TAIL}`,
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
      `${FIX} 5 minutes (auto: a drive realm agent starts on its own has no trigger history; ${AGENT_DEFAULT}).`,
      '',
    ]);
  });
});

// Guardrail 7(b)'s CROSS cell (the lifetime unit, cell 8): where `auto`'s prior and its choice differ
// — a listen child (prior: long) whose gaps choose short. Caching 3-M D-2 (MA 2's ruling, registry
// MA2-3MD2-03): until D-3 the start line says the drive's choice, while the request follows its
// step, which on the workflow's first run has no gap and asks the listen prior. The built CLI against the in-test Anthropic stand-in (local, answers 200),
// with a scratch HOME and only a dummy key; on a failing host it prints the start line and the
// recorded seconds — never an environment, a header or a key.
describe('until D-3, the start line says the drive’s choice and the record the step’s (issue #600, cell 8; caching 3-M D-2)', () => {
  it('until D-3, a listen child given gaps 10,10,10,7200,7200 says the drive’s 5 minutes and records the step’s own prior, 3600 (red: the step’s choice not passed — the record goes back to 300 — or the start line from the prior)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realm-600-cross-'));
    const h = await makeTempHome();
    const stub = await startAnthropicStub({
      finalContent: { summary: 'ok' },
      answeredModel: 'claude-x-20260101',
      usage: {
        input_tokens: 20,
        output_tokens: 3,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    try {
      const home = h.root;
      writeFileSync(
        join(root, 'workflow.yaml'),
        'id: cross-600\nname: Cross 600\nversion: 1\nsteps:\n  ask:\n    description: Answer.\n    execution: agent\n',
        'utf8',
      );
      // #898: `auto` with gaps is priced from the runner's price file. A full file at today's
      // Anthropic ratios keeps this cell's choice where the shipped multiples put it: 5 minutes.
      writeFileSync(
        join(root, 'realm.yaml'),
        'version: 1\nrunner:\n  cache:\n    economics: prices.json\n',
        'utf8',
      );
      writeFileSync(
        join(root, 'prices.json'),
        JSON.stringify({
          version: 1,
          currency: 'USD',
          models: {
            'claude-x': {
              prices: [
                {
                  per_million_tokens: {
                    input: 3,
                    output: 15,
                    cache_read: 0.3,
                    cache_write_5m: 3.75,
                    cache_write_1h: 6,
                  },
                },
              ],
            },
          },
        }),
        'utf8',
      );
      const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
      const stdout = await new Promise<string>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            cli,
            'agent',
            '--workflow',
            join(root, 'workflow.yaml'),
            '--model',
            'claude-x',
            '--spawned-by-listen',
            '--cache-gaps',
            '10,10,10,7200,7200',
          ],
          {
            cwd: root,
            env: {
              PATH: process.env['PATH'] ?? '',
              HOME: home,
              ANTHROPIC_API_KEY: 'k-600',
              ANTHROPIC_BASE_URL: stub.baseUrl,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        child.stdout.on('data', (c: Buffer) => (out += c.toString()));
        const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
        child.on('close', () => {
          clearTimeout(timer);
          resolve(out);
        });
      });
      const { record } = await h.home.runStore.get((await runIds(h.home.runStore))[0]!);
      const request = record.evidence[0]!.diagnostics!.cache!.requests[0]!;
      const startLine = stdout.split('\n').find((l) => l.startsWith('Caching:')) ?? '';
      const words = /fixed instructions and the stable start of its prompt for (.+?) \(/.exec(
        startLine,
      )?.[1];
      expect({
        recorded: request.cache_lifetime_s,
        auto: request.cache_auto,
        words,
        wordsOfRecord: lifetimeText(request.cache_lifetime_s ?? 0),
        // #898: the start line says where the choice took its prices.
        priced: startLine.includes('; priced from your price file; '),
      }).toEqual({
        recorded: 3600,
        auto: { basis: 'step_gaps', gaps_s: [] },
        words: '5 minutes',
        wordsOfRecord: '1 hour',
        priced: true,
      });
    } finally {
      await stub.close();
      await h.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
