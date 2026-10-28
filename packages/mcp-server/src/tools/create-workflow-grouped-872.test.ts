// create-workflow-grouped-872.test.ts — #872 (b1) A4: `create_workflow`'s refusal says each broken
// rule ONCE — the first step's full message, then `(also 's2', 's3' and k more)` (#872 (a)'s
// vocabulary: three names, then the exact count) — so every fault class shows at once and the reply's
// size no longer follows the step count. The cells call `handleCreateWorkflow` directly (R1 and R13
// cannot be reached through the door: zod refuses first). Beside each: (a) what turns it red; (b)
// what it prints on failure — rule lines, step names, counts and sizes.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, compileDisclosure } from '@sensigo/realm';
import { handleCreateWorkflow, type CreateWorkflowArgs } from './create-workflow.js';
import { MCP_ENVELOPE_TABLE, toolContentOf } from '../render-reply.js';

async function stores() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-cw-872-'));
  return {
    workflowStore: new JsonWorkflowStore(join(dir, 'wf')),
    runStore: new JsonFileStore(join(dir, 'runs')),
  };
}
const set = compileDisclosure([], {
  declared: 'resolved',
  audience: 'agent',
  environment: 'swept',
}).set;
/** The refusal's lines, and the size of the reply an agent reads. */
async function refuse(args: CreateWorkflowArgs): Promise<{ errors: string[]; size: number }> {
  const reply = await handleCreateWorkflow(args, await stores());
  const text = toolContentOf({ ...reply }, { set, audience: 'agent', table: MCP_ENVELOPE_TABLE })
    .content[0]!.text;
  return { errors: reply.errors, size: text.length };
}
type Step = CreateWorkflowArgs['steps'][number];
const step = (id: string, over: Record<string, unknown> = {}): Step =>
  ({ id, description: `Step ${id}.`, ...over }) as Step;

describe('#872 (b1) B7 — create_workflow: one line per rule', () => {
  it('200 steps each breaking only R11 (empty description) → ONE line, three names then the count, under 10,000', async () => {
    const r = await refuse({
      steps: Array.from({ length: 200 }, (_, i) => step(`s${i}`, { description: '' })),
    });
    // (a) red when the grouping is removed (200 lines) or the names or the count change; (b) prints
    //     the lines' count, the line and the size.
    expect({ lines: r.errors.length, line: r.errors[0], under: r.size < 10_000 }).toEqual({
      lines: 1,
      line: "Step 's0': description must be non-empty (also 's1', 's2' and 197 more)",
      under: true,
    });
  });

  it('group sizes 2, 3 and 4 on one rule — no count, then `and 1 more`', async () => {
    const lineFor = async (n: number) =>
      (
        await refuse({
          steps: Array.from({ length: n }, (_, i) => step(`s${i}`, { description: '' })),
        })
      ).errors;
    // (a) red when a group names more than three steps or counts wrong; (b) prints the lines.
    expect([await lineFor(2), await lineFor(3), await lineFor(4)]).toEqual([
      ["Step 's0': description must be non-empty (also 's1')"],
      ["Step 's0': description must be non-empty (also 's1', 's2')"],
      ["Step 's0': description must be non-empty (also 's1', 's2' and 1 more)"],
    ]);
  });

  it('R8, R11 and R15 broken on several steps → three lines, in the order of each rule’s first fault, exact counts', async () => {
    const r = await refuse({
      steps: [
        step('a'),
        step('a'),
        step('b', { description: '' }),
        step('c', { description: '', depends_on: ['zz'] }),
        step('d', { description: '', depends_on: ['zz'] }),
        step('e', { description: '', depends_on: ['zz'] }),
        step('f', { depends_on: ['zz'] }),
        step('a'),
      ],
    });
    // (a) red when the rules are ordered otherwise, a rule splits into several lines, or a count is
    //     wrong; (b) prints the lines.
    expect(r.errors).toEqual([
      "Duplicate step id: 'a' (also 'a')",
      "Step 'b': description must be non-empty (also 'c', 'd' and 1 more)",
      "Step 'c': depends_on references unknown step 'zz' (also 'd', 'e' and 1 more)",
    ]);
  });

  // Each rule's own fixture: steps breaking ONLY that rule (two of them where the rule allows two).
  const LONG = (prefix: string) => prefix.padEnd(100, 'x');
  const RULES: Array<[string, CreateWorkflowArgs, RegExp, string | undefined]> = [
    ['R1', { steps: [] }, /^steps must contain at least one step$/, undefined],
    [
      'R2',
      {
        steps: [
          step('a', { input_schema: { $async: true } }),
          step('b', { input_schema: { $async: true } }),
        ],
      },
      /^Step 'a': 'input_schema' declares /,
      'b',
    ],
    [
      'R3',
      {
        steps: [
          step('a', { input_schema: { type: 'nope' } }),
          step('b', { input_schema: { type: 'nope' } }),
        ],
      },
      /^Step 'a': 'input_schema' is not a valid JSON Schema/,
      'b',
    ],
    [
      'R4',
      {
        steps: [
          step('a', {
            structured_output: 'strict',
            input_schema: { type: 'object', properties: { x: { type: 'string' } } },
          }),
          step('b', {
            structured_output: 'strict',
            input_schema: { type: 'object', properties: { x: { type: 'string' } } },
          }),
        ],
      },
      /^Step 'a': 'structured_output: strict' is not eligible/,
      'b',
    ],
    [
      'R5',
      { steps: [step('a', { agent_profile: 'p' }), step('b', { agent_profile: 'p' })] },
      /^Step 'a': agent_profile is not supported/,
      'b',
    ],
    [
      'R6',
      { steps: [step('a')], extensions: {} } as CreateWorkflowArgs,
      /^extensions is not supported on dynamically-created workflows/,
      undefined,
    ],
    [
      'R7',
      { steps: [step('a', { extensions: {} }), step('b', { extensions: {} })] },
      /^Step 'a': extensions is not supported/,
      'b',
    ],
    [
      'R8',
      { steps: [step('a'), step('a'), step('a')] },
      /^Duplicate step id: 'a'$|^Duplicate step id: 'a' /,
      'a',
    ],
    ['R9', { steps: [step('a b'), step('c d')] }, /^Step id 'a b' is invalid/, 'c d'],
    ['R10', { steps: [step('run'), step('context')] }, /^Step id 'run' is reserved/, 'context'],
    [
      'R11',
      { steps: [step('a', { description: '' }), step('b', { description: '' })] },
      /^Step 'a': description must be non-empty/,
      'b',
    ],
    [
      'R12',
      { steps: [step('a', { llm_timeout_seconds: 0 }), step('b', { llm_timeout_seconds: 0 })] },
      /^Step 'a': llm_timeout_seconds must be a positive integer/,
      'b',
    ],
    [
      'R13',
      {
        steps: [
          step('a'),
          step('b', { depends_on: ['a', 'a'] }),
          step('c', { depends_on: ['a', 'b'] }),
        ],
      },
      /^Step 'b': depends_on supports at most one predecessor/,
      'c',
    ],
    [
      'R14',
      { steps: [step('a', { depends_on: ['b'] }), step('b')] },
      /^Step 'a' is the first step/,
      undefined,
    ],
    [
      'R15',
      { steps: [step('a'), step('b', { depends_on: ['zz'] }), step('c', { depends_on: ['yy'] })] },
      /^Step 'b': depends_on references unknown step 'zz'/,
      'c',
    ],
    [
      'R16',
      {
        steps: [
          step('a'),
          step('b', { depends_on: ['d'] }),
          step('c', { depends_on: ['d'] }),
          step('d'),
        ],
      },
      /^Step 'b': depends_on must reference a step that appears earlier/,
      'c',
    ],
    [
      'R17',
      {
        steps: [
          step('a'),
          step('b'),
          step('c', { depends_on: ['a'] }),
          step('d', { depends_on: ['a'] }),
        ],
      },
      /^Step 'c': depends_on names 'a', but steps run in list order/,
      'd',
    ],
  ];

  it.each(RULES)(
    '%s: steps breaking only that rule make ONE line — its first step’s message, the others named',
    async (_rule, args, head, also) => {
      const r = await refuse(args);
      // (a) red when a rule's faults split into several lines, merge with another rule's, or lose the
      //     first step's own words; (b) prints the lines.
      expect({
        lines: r.errors.length,
        head: head.test(r.errors[0] ?? ''),
        also:
          also === undefined
            ? !/\(also /.test(r.errors[0] ?? '')
            : (r.errors[0] ?? '').endsWith(`(also '${also}')`),
      }).toEqual({ lines: 1, head: true, also: true });
    },
  );

  it('the worst cell: every rule that can co-occur, once each, on 100-character step ids — one line each; the size reported', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => LONG(`id${i}_`));
    const r = await refuse({
      extensions: {},
      steps: [
        step(ids[0]!, { depends_on: [ids[1]!] }), // R14: the first step depends on something
        step(ids[1]!, { input_schema: { $async: true } }), // R2
        step(ids[2]!, { input_schema: { type: 'nope' } }), // R3
        step(ids[3]!, {
          structured_output: 'strict',
          input_schema: { type: 'object', properties: { x: { type: 'string' } } },
        }), // R4
        step(ids[4]!, { agent_profile: 'p' }), // R5
        step(ids[5]!, { extensions: {} }), // R7
        step(ids[5]!), // R8 (a duplicate of the step before)
        step(`${ids[6]!.slice(0, 98)} z`), // R9 (a space in the id)
        step('run'), // R10
        step(ids[7]!, { description: '' }), // R11
        step(ids[8]!, { llm_timeout_seconds: 0 }), // R12
        step(ids[9]!, { depends_on: [ids[1]!, ids[2]!] }), // R13
        step(ids[10]!, { depends_on: [LONG('nowhere_')] }), // R15
        step(ids[11]!, { depends_on: [ids[13]!] }), // R16
        step(ids[12]!, { depends_on: [ids[1]!] }), // R17
        step(ids[13]!),
      ],
    } as CreateWorkflowArgs);
    // (a) red when two rules share a line or a rule is lost; (b) prints the count and the size.
    expect({ lines: r.errors.length, size: r.size, underCeiling: r.size <= 40_000 }).toEqual({
      lines: 16,
      size: r.size,
      underCeiling: true,
    });
  });
});
