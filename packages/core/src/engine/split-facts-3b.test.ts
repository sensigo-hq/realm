// split-facts-3b.test.ts — caching 3-B, Parts A5 and A6: the split's record facts are kept in their
// one shape at the write (`boundRequestFacts`) or dropped, so a provider module's record cannot put
// its own text under a `fact` row; and the describer's one narrow export renders a step's prompt with
// its stable boundary against the workflow's static context. Each cell names (a) the change that
// turns it red and (b) what it prints: the kept facts (fake digests) or the boundary.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { boundRequestFacts } from './request-facts.js';
import { renderStepPromptWithBoundary } from './step-prompt-boundary.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const HEX = 'a'.repeat(64);
const GOOD = {
  prefix_sha256: HEX,
  prefix_chars: 48,
  prefix_parts: {
    system: HEX,
    prompt: 'b'.repeat(64),
    tools: 'c'.repeat(64),
    format: 'd'.repeat(64),
  },
  cache_marked: ['system', 'prompt'],
  request_strict_sent: true,
  cache_controls_rejected: {
    status: 400,
    dropped: ['cache_fields'],
    proven: 'none',
    fields: ['cache_control', 'prompt_cache_key'],
  },
  cache_key_sent: true,
};

describe('caching 3-B A6 — the split facts at the write', () => {
  it('a well-formed record keeps every split fact unchanged', () => {
    // (a) red when a normaliser drops or rewrites a valid value; (b) prints the kept record.
    expect(boundRequestFacts([{ request_index: 0, ...GOOD }])).toEqual([
      { request_index: 0, ...GOOD },
    ]);
  });

  it('each fact out of its shape is dropped, one at a time, and the others stay', () => {
    const bad: Record<keyof typeof GOOD, unknown[]> = {
      prefix_sha256: ['sha256:' + HEX, HEX.toUpperCase(), 'a'.repeat(63), 42],
      prefix_chars: [-1, 1.5, '48', Number.MAX_SAFE_INTEGER + 2],
      prefix_parts: [{ prompt: HEX }, { system: 'nope' }, { system: HEX, prompt: 'x' }, [HEX], 'x'],
      cache_marked: [[], ['breakpoint'], ['system', 'system'], 'system'],
      request_strict_sent: ['true', 1],
      cache_controls_rejected: [
        { ...GOOD.cache_controls_rejected, status: 422 },
        { ...GOOD.cache_controls_rejected, dropped: ['strict'] },
        { ...GOOD.cache_controls_rejected, proven: 'maybe' },
        { ...GOOD.cache_controls_rejected, fields: ['temperature'] },
        { ...GOOD.cache_controls_rejected, fields: [] },
        { ...GOOD.cache_controls_rejected, fields: ['cache_control', 'cache_control'] },
      ],
      cache_key_sent: [false, 'true'],
    };
    const kept: string[] = [];
    for (const [field, values] of Object.entries(bad)) {
      for (const value of values) {
        const [out] = boundRequestFacts([{ ...GOOD, [field]: value }]) as Record<string, unknown>[];
        if (Object.hasOwn(out!, field)) kept.push(`${field} = ${JSON.stringify(value)}`);
        const others = Object.keys(GOOD).filter((k) => k !== field && !Object.hasOwn(out!, k));
        if (others.length > 0) kept.push(`${field}: lost ${others.join(', ')}`);
      }
    }
    // (a) red when a normaliser keeps a value outside its shape (or drops a sibling); (b) prints
    //     each kept bad value with its field.
    expect(kept).toEqual([]);
  });

  it('prefix_parts keeps only its four keys; another key is removed and the rest kept', () => {
    const [out] = boundRequestFacts([
      { prefix_parts: { system: HEX, extra: 'secret-ish text' } },
    ]) as Record<string, unknown>[];
    // (a) red when an unknown key passes; (b) prints the kept parts.
    expect(out!['prefix_parts']).toEqual({ system: HEX });
  });
});

describe('caching 3-B A5 — renderStepPromptWithBoundary', () => {
  it('renders the step prompt against the static context, the boundary at the first run value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-3b-a5-'));
    try {
      const file = join(dir, 'rules.md');
      await writeFile(file, 'Be brief.', 'utf8');
      const def = {
        id: 'wf',
        name: 'wf',
        version: 1,
        workflow_context: { rules: { source: { path: file } } },
        steps: {
          ask: {
            description: 'Ask.',
            execution: 'agent',
            prompt: 'Rules: {{ workflow.context.rules.raw }}\nTicket: {{ run.params.ticket }}',
          },
          plain: { description: 'Plain.', execution: 'auto' },
        },
      } as unknown as WorkflowDefinition;
      const got = await renderStepPromptWithBoundary(def, 'ask', new Date('2026-01-01T00:00:00Z'));
      // (a) red when the static context is not loaded (the head would stop at `Rules: `) or a run
      //     value is treated as stable; (b) prints the text and the boundary.
      expect(got).toEqual({
        text: 'Rules: Be brief.\nTicket: {{ run.params.ticket }}',
        stable: { chars: 'Rules: Be brief.\nTicket: '.length, unit: 'utf16' },
      });
      expect(
        await renderStepPromptWithBoundary(def, 'plain', new Date('2026-01-01T00:00:00Z')),
      ).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
