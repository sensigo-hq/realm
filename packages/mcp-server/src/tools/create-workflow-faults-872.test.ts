// create-workflow-faults-872.test.ts — #872 (b1) correction 1 AC4 (C4): `create_workflow`'s faults
// are grouped only when they are the SAME — the rule and the message its push site writes for one
// sentinel id — never by rule alone; the 8,000-character cap and the one closing line. The cells call
// `handleCreateWorkflow` directly and measure the reply the door sends. Beside each: (a) the change
// that turns it red; (b) what it prints on failure — lines, step names, counts and sizes.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore, compileDisclosure } from '@sensigo/realm';
import {
  FAULT_LINES_CAP,
  handleCreateWorkflow,
  type CreateWorkflowArgs,
} from './create-workflow.js';
import { MCP_ENVELOPE_TABLE, toolContentOf } from '../render-reply.js';

const set = compileDisclosure([], {
  declared: 'resolved',
  audience: 'agent',
  environment: 'swept',
}).set;
/** The refusal: its lines, its status, and the size of the reply an agent reads. */
async function refuse(
  args: CreateWorkflowArgs,
): Promise<{ errors: string[]; status: unknown; size: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'realm-ac4-872-'));
  const reply = await handleCreateWorkflow(args, {
    workflowStore: new JsonWorkflowStore(join(dir, 'wf')),
    runStore: new JsonFileStore(join(dir, 'runs')),
  });
  const text = toolContentOf({ ...reply }, { set, audience: 'agent', table: MCP_ENVELOPE_TABLE })
    .content[0]!.text;
  return { errors: reply.errors, status: reply.status, size: text.length };
}
type Step = CreateWorkflowArgs['steps'][number];
const step = (id: string, over: Record<string, unknown> = {}): Step =>
  ({ id, description: `Step ${id}.`, ...over }) as Step;
/** An input_schema whose fault names its own property — every step's R3 detail differs. */
const badSchema = (i: number) => ({
  type: 'object',
  properties: { [`p${i}`]: { type: 'zz' } },
});
const joined = (lines: readonly string[]) => lines.join('\n').length;

describe('#872 (b1) correction 1 AC4 (C4) — faults grouped only when they are the same', () => {
  it('four R3 faults with four different details → four lines, one refusal', async () => {
    const r = await refuse({
      steps: [
        step('a', { input_schema: { type: 'nope' } }),
        step('b', { input_schema: { minimum: 'x' } }),
        step('c', { input_schema: { required: 5 } }),
        step('d', { input_schema: { properties: 3 } }),
      ],
    });
    // (a) red when faults are grouped by rule alone (one line: 'b''s, 'c''s and 'd''s faults
    //     claimed to be 'a''s); (b) prints the status and each line's head.
    expect({ status: r.status, heads: r.errors.map((e) => e.slice(0, 12)) }).toEqual({
      status: 'error',
      heads: ["Step 'a': 'i", "Step 'b': 'i", "Step 'c': 'i", "Step 'd': 'i"],
    });
  });

  it('R15: two different unknown names → two lines; the same name → one line, the other step named', async () => {
    const two = await refuse({
      steps: [step('a'), step('b', { depends_on: ['zz'] }), step('c', { depends_on: ['yy'] })],
    });
    const one = await refuse({
      steps: [step('a'), step('b', { depends_on: ['zz'] }), step('c', { depends_on: ['zz'] })],
    });
    // (a) red when different names share a line, or the same one splits; (b) prints the lines.
    expect({ two: two.errors, one: one.errors }).toEqual({
      two: [
        "Step 'b': depends_on references unknown step 'zz'",
        "Step 'c': depends_on references unknown step 'yy'",
      ],
      one: ["Step 'b': depends_on references unknown step 'zz' (also 'c')"],
    });
  });

  it('R8: each id named once — three steps "a" give one line with no also; "a" and "b" each twice give one line naming "b"', async () => {
    const three = await refuse({ steps: [step('a'), step('a'), step('a')] });
    const pairs = await refuse({ steps: [step('a'), step('b'), step('a'), step('b')] });
    // (a) red when an id is named twice ("(also 'a')") or a distinct id is lost; (b) prints the lines.
    expect({ three: three.errors, pairs: pairs.errors }).toEqual({
      three: ["Duplicate step id: 'a'"],
      pairs: ["Duplicate step id: 'a' (also 'b')"],
    });
  });

  it('200 steps, each with a different R3 detail → lines up to the 8,000-character cap, then the closing line; the reply under 10,000', async () => {
    const r = await refuse({
      steps: Array.from({ length: 200 }, (_, i) => step(`s${i}`, { input_schema: badSchema(i) })),
    });
    const shown = r.errors.slice(0, -1);
    const closing = r.errors.at(-1)!;
    const left = 200 - shown.length;
    // The next fault's own line, from a refusal of that step alone.
    const next = (
      await refuse({
        steps: [step(`s${shown.length}`, { input_schema: badSchema(shown.length) })],
      })
    ).errors[0]!;
    // (a) red when the cap is removed (200 lines, ~61 K), a line past the cap is added, or the
    //     closing line's count or names are wrong; (b) prints the counts, the sizes and the line.
    expect({
      cap: FAULT_LINES_CAP,
      underCap: joined(shown) <= FAULT_LINES_CAP,
      oneMoreOver: joined([...shown, next]) > FAULT_LINES_CAP,
      closing,
      size: r.size < 10_000,
    }).toEqual({
      cap: 8_000,
      underCap: true,
      oneMoreOver: true,
      closing: `and ${left} more faults on 's${shown.length}', 's${shown.length + 1}', 's${shown.length + 2}' and ${left - 3} more — fix the faults above, then submit again.`,
      size: true,
    });
    // The measured count of lines shown, pinned (verify-first: 25 lines join to 7,729 characters;
    // a 26th would pass the cap).
    expect(shown.length).toBe(25);
  }, 60_000);

  it('a first line alone over 8,000 (a 3,000-character id in R17) → that line, then the closing line', async () => {
    const long = `L${'l'.repeat(2_999)}`;
    const r = await refuse({
      steps: [
        step('a'),
        step('b'),
        step(long, { depends_on: ['a'] }),
        step('d'),
        step('e', { depends_on: ['a'] }),
      ],
    });
    // (a) red when the first line is dropped for its length, or the second R17 fault (a different
    //     predecessor) is added past the cap; (b) prints the first line's size and the second line.
    expect({
      lines: r.errors.length,
      firstOver: r.errors[0]!.length > FAULT_LINES_CAP,
      firstHead: r.errors[0]!.startsWith(`Step '${long}': depends_on names 'a'`),
      closing: r.errors[1],
    }).toEqual({
      lines: 2,
      firstOver: true,
      firstHead: true,
      closing: "and 1 more fault on 'e' — fix the faults above, then submit again.",
    });
  });

  it('the closing line names a step-less fault (R6) as "the workflow", unquoted, and a step with two faults once (25 R3 lines fit; s25, s26 twice and R6 are left)', async () => {
    const r = await refuse({
      extensions: {},
      steps: [
        ...Array.from({ length: 26 }, (_, i) => step(`s${i}`, { input_schema: badSchema(i) })),
        step('s26', { input_schema: badSchema(26), agent_profile: 'p' }),
      ],
    } as CreateWorkflowArgs);
    // (a) red when a step-less fault is quoted or dropped, or a step is named once per fault; (b)
    //     prints the closing line.
    expect(r.errors.at(-1)).toBe(
      "and 4 more faults on 's25', 's26', the workflow — fix the faults above, then submit again.",
    );
  });
});
