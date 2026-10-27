// lib/cacheability.test.ts — issue #600 caching PR 5 (C3.2–C3.5): the host's own rules, called
// directly where the commands' cells (validate-cacheability.test.ts) cannot reach them cleanly — the
// flags' edge values, the share filter's length rule, the economics detail's escaping, and the
// once-lines printed once per process. On a failing host each cell prints realm's words and the
// flags' answers: test values only, the scratch path written `<dir>`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from '@sensigo/realm';
import {
  buildCacheabilityReport,
  checkCacheFlags,
  renderCacheabilityLines,
} from './cacheability.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** A definition with the given agent steps (no profile). */
function definition(steps: Record<string, Record<string, unknown>>): WorkflowDefinition {
  return {
    id: 'w',
    name: 'w',
    version: 1,
    steps: Object.fromEntries(
      Object.entries(steps).map(([id, s]) => [
        id,
        { description: id, execution: 'agent', depends_on: [], ...s },
      ]),
    ),
  } as unknown as WorkflowDefinition;
}

describe('the flags (C3.5)', () => {
  // (a) red when a value the rule refuses is accepted, or one it accepts refused; (b) prints each
  //     answer: the checked flags, or the first word of the refusal's subject.
  it('--floor is a whole number ≥ 1; --ratio a plain number > 0; --model needs --provider', () => {
    const answer = (opts: Parameters<typeof checkCacheFlags>[0]): unknown => {
      const r = checkCacheFlags(opts);
      return r.ok ? r.flags : r.message.split(' ')[1];
    };
    expect([
      answer({ floor: '512' }),
      answer({ floor: '0' }),
      answer({ floor: '+5' }),
      answer({ floor: '1e3' }),
      answer({ floor: ' 5' }),
      answer({ ratio: '3.7' }),
      answer({ ratio: '.5' }),
      answer({ ratio: '0.0' }),
      answer({ ratio: '-1' }),
      answer({ ratio: '1e2' }),
      answer({ provider: 'openai' }),
      answer({ model: 'gpt-5' }),
      answer({ provider: 'openai', model: 'gpt-5' }),
    ]).toEqual([
      { floor: 512 },
      '--floor',
      '--floor',
      '--floor',
      '--floor',
      { ratio: 3.7 },
      { ratio: 0.5 },
      '--ratio',
      '--ratio',
      '--ratio',
      { provider: 'openai' },
      '--provider',
      { provider: 'openai', model: 'gpt-5' },
    ]);
  });
});

describe('the sharing filter (C3.2; Δ12)', () => {
  // Two schemas that differ at their first property: on anthropic the tool's 118-char header plus
  // the schema's 32-char opening make 150 shared chars, under realm's shorter base (155) — shared
  // boilerplate, not printed; on openai the base and the schema line come first, so 226 are shared
  // and the clause prints. (a) red when the length rule is dropped (the anthropic clause appears) or
  // applied to the openai pair; (b) prints the step line.
  it("a share shorter than realm's 155-char base is not printed: anthropic hides it, openai shows it", async () => {
    const def = definition({
      a: { input_schema: { type: 'object', properties: { a: { type: 'string' } } } },
      b: { input_schema: { type: 'object', properties: { b: { type: 'string' } } } },
    });
    const lines = renderCacheabilityLines(await buildCacheabilityReport(def, {})).steps;
    expect(lines[0]!.split(' — ').slice(-1)[0]).toBe(
      'openai: shares its first 226 chars with b: the schemas differ',
    );
  });
  // The profile rule alone: two profiles that share their first 200 characters part inside the
  // profile, past realm's 155-char base, so the length rule lets the pair through and only the
  // profile rule keeps it out. (a) red when a pair that parts inside a profile is printed; (b)
  // prints whether the line names a share.
  it('a pair that parts inside its profile is not printed, even past 155 shared chars', async () => {
    const shared = 'x'.repeat(200);
    const def = {
      ...definition({ a: { agent_profile: 'pa' }, b: { agent_profile: 'pb' } }),
      resolved_profiles: {
        pa: { content: `${shared} one`, content_hash: 'h1' },
        pb: { content: `${shared} two`, content_hash: 'h2' },
      },
    } as WorkflowDefinition;
    const line = renderCacheabilityLines(await buildCacheabilityReport(def, { provider: 'openai' }))
      .steps[0]!;
    expect(line.includes('shares')).toBe(false);
  });
});

describe('the economics detail (C3.4)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // A detail that escaping would change is printed quoted, as `realm run inspect` prints it. (a) red
  // when the detail is printed raw; (b) prints the clause, the path written `<dir>`.
  it('a path with a double quote is printed quoted, as inspect quotes it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'realm-pr5-quote-'));
    const path = join(dir, 'a"b', 'economics.yaml');
    const report = await buildCacheabilityReport(
      definition({ a: {} }),
      { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      { cacheEconomicsPath: path },
    );
    const line = renderCacheabilityLines(report).steps[0]!;
    expect(line.slice(line.indexOf(' — economics')).split(dir).join('<dir>')).toBe(
      ` — economics unreachable: "cannot read '<dir>/a\\"b/economics.yaml': ENOENT"`,
    );
  });
});

describe('the once-lines, once per process (C3.4)', () => {
  // (a) red when a block printed again prints its once-lines again; (b) prints every line logged.
  it('a second block prints its step lines and none of the once-lines already printed', async () => {
    vi.resetModules();
    const fresh = await import('./cacheability.js');
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const lines = fresh.renderCacheabilityLines(
      await fresh.buildCacheabilityReport(definition({ a: {} }), { provider: 'openai' }),
    );
    fresh.printCacheabilityLines(lines, '> ');
    fresh.printCacheabilityLines(lines, '> ');
    expect(logged.map((l) => l.slice(0, 18))).toEqual([
      '> cache: a — 155 c',
      '> openai: realm se',
      '> cache: a — 155 c',
    ]);
  });
});
