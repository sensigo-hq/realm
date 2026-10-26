// zod4-final-pass.test.ts — the zod 4 unit's final pass (05 rev 3): R1 the refusal's size and shape
// (one summary for two or more issues, the count first, up to ten places, every line cut at 200),
// R2 the numbers (realm's words at the two number sites; the free-form records walked: a non-finite
// number refused, an integer beyond 2^53−1 warned about), R3 `depends_on` (one name, the step just
// before; the silent re-wiring refused), and the docs sentences that state them. Through the real
// door (an in-process client) unless a cell says otherwise. Every value is a fake. Each assertion
// names (a) the change that turns it red and (b) what it prints: texts, lengths, counts and
// booleans, never an environment or a key. Correction 1 (06 rev 2): the walk's lists bounded — the
// first ten named, then the count — on every tool, a long path cut with the diagnostic whole, the
// two walk sites without a cell, (xi)'s non-aborting sibling, and three claims pinned.
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { JsonFileStore, JsonWorkflowStore } from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from '../server.js';
import { createWorkflowArgsSchema } from './create-workflow.js';
import { presentQuestionArgsShape } from './present-question.js';
import { boundedRefusal, MAX_SUMMARY_LINE } from './refusal-format.js';
import {
  ArgsNumbersRefusal,
  checkArgsNumbers,
  checkArgsNumbersJoined,
  walkNumbers,
} from './args-numbers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (t: string) => t.replace(/\s+/g, ' ');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

type Reply = Record<string, unknown>;

/** A door with temp stores (the in-memory transport carries `Infinity` as a number). */
async function connect() {
  const dir = await mkdtemp(join(tmpdir(), 'realm-zod4-final-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  const server = createRealmMcpServer({ runStore, workflowStore });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'zod4-final', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Record<string, unknown>): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
      isError?: boolean;
    };
    const text = raw.content[0]!.text;
    try {
      return JSON.parse(text) as Reply;
    } catch {
      return { _text: text, _isError: raw.isError === true };
    }
  };
  /** A workflow of one agent step `p1`, and a fresh run of it. */
  const oneStep = async () => {
    const wf = await call('create_workflow', { steps: [{ id: 'p1', description: 'd' }] });
    const wid = (wf['data'] as { workflow_id: string }).workflow_id;
    const run = (await call('start_run', { workflow_id: wid }))['run_id'] as string;
    return { wid, run };
  };
  return { call, client, runStore, workflowStore, oneStep };
}

const V = 'MCP error -32602: Input validation error: Invalid arguments for tool ';
const UNION = 'expected a string, a number, a boolean or null';
const step = (extra: Record<string, unknown> = {}) => ({ id: 'a', description: 'b', ...extra });
const steps = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, description: 'd' }));
/** The summary's lines (the SDK's prefix stays on the first). */
const lines = (text: unknown) => String(text).split('\n');

describe('the zod 4 final pass, R1: one summary for two or more issues', () => {
  it('(iii) 10,000 wrong `data` values: one place, the count, the first three keys, under 300 characters', async () => {
    const { call } = await connect();
    const data = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, {}]));
    const r = await call('execute_step', {
      run_id: 'r',
      command: 'c',
      trace: [{ event: 'e', data }],
    });
    // (a) red when the issues print one by one (369 KB), the place splits per value, or the count
    //     moves off the first line; (b) prints the text and its length.
    expect({ text: r['_text'], short: String(r['_text']).length < 300 }).toEqual({
      text: `${V}execute_step: 10000 problems in 1 place\ntrace[0].data: 10000 problems — ${UNION} (first: k0, k1, k2)`,
      short: true,
    });
  });

  it('(iv) eleven places: ten place lines and `and 1 more place (11 in all)`', async () => {
    const { call } = await connect();
    const r = await call('create_workflow', {
      steps: Array.from({ length: 11 }, (_, i) => ({
        id: `s${i}`,
        description: 'd',
        llm_timeout_seconds: 'x',
      })),
    });
    // (a) red when the place lines are not capped at ten, or the closing line's count or noun
    //     moves; (b) prints the lines.
    expect(lines(r['_text'])).toEqual([
      `${V}create_workflow: 11 problems in 11 places`,
      ...Array.from({ length: 10 }, (_, i) => `steps[${i}].llm_timeout_seconds: expected number`),
      'and 1 more place (11 in all)',
    ]);
  });

  it('(v) long keys: every line cut at 200 characters, the whole under 4,000', async () => {
    const { call } = await connect();
    const r = await call('execute_step', {
      run_id: 'r',
      command: 'c',
      trace: Array.from({ length: 11 }, (_, i) => ({
        event: 'e',
        data: { [`${'K'.repeat(1000)}${i}`]: {} },
      })),
    });
    const body = lines(r['_text']).slice(1);
    // (a) red when the cut is removed (each line about 1,030 characters, the whole over 10,000);
    //     (b) prints the length, the longest line's length and the line count.
    expect({
      under4000: String(r['_text']).length < 4000,
      longest: Math.max(...body.map((l) => l.length)),
      count: body.length,
    }).toEqual({ under4000: true, longest: MAX_SUMMARY_LINE + 1, count: 11 });
  });

  it('(vi) a canary inside a wrong field never appears (a string and an array, two kinds)', async () => {
    const { call } = await connect();
    const r = await call('execute_step', {
      run_id: 'r',
      command: 'c',
      trace: [{ event: 'e', data: { k1: { v: 'CANARY-r1vi-a' }, k2: ['CANARY-r1vi-b'] } }],
    });
    // (a) red when a summary line echoes the value it refused; (b) prints the text and booleans.
    expect({
      text: r['_text'],
      a: String(r['_text']).includes('CANARY-r1vi-a'),
      b: String(r['_text']).includes('CANARY-r1vi-b'),
    }).toEqual({
      text: `${V}execute_step: 2 problems in 1 place\ntrace[0].data: 2 problems — ${UNION} (first: k1, k2)`,
      a: false,
      b: false,
    });
  });

  it('(vii) no issue, nothing changes: the bounded schema parses a valid call to what the bare one does', () => {
    const shapes = {
      loose: createWorkflowArgsSchema,
      strip: z.object({ run_id: z.string(), include_steps: z.boolean().optional() }),
      raw: z.object(presentQuestionArgsShape),
    } as const;
    const valid = {
      loose: { steps: [step()], zz: 1 },
      strip: { run_id: 'r', include_steps: true, zz: 1 },
      raw: { run_id: 'r', gate_id: 'g' },
    } as const;
    // (a) red when the check acts on a call with no issue (it adds or replaces one); (b) prints the
    //     three parses.
    expect(
      Object.fromEntries(
        Object.entries(shapes).map(([k, s]) => [
          k,
          JSON.stringify(boundedRefusal(s).safeParse(valid[k as keyof typeof valid])) ===
            JSON.stringify(s.safeParse(valid[k as keyof typeof valid])),
        ]),
      ),
    ).toEqual({ loose: true, strip: true, raw: true });
  });

  it('(viii) the advertised schema is unchanged: JSON Schema byte-equal with and without the helper', () => {
    const forms = {
      loose: createWorkflowArgsSchema,
      strip: z.object({ run_id: z.string() }),
      raw: z.object(presentQuestionArgsShape),
    };
    // (a) red when the helper changes what `tools/list` advertises (a wrapper type, a description);
    //     (b) prints booleans.
    expect(
      Object.fromEntries(
        Object.entries(forms).map(([k, s]) => [
          k,
          JSON.stringify(z.toJSONSchema(boundedRefusal(s))) === JSON.stringify(z.toJSONSchema(s)),
        ]),
      ),
    ).toEqual({ loose: true, strip: true, raw: true });
  });

  it('(ix) the words: a wrong type, a union and a bound each name what they expected, never `undefined`', async () => {
    const { call } = await connect();
    const typed = await call('get_run_state', { run_id: 1, include_steps: 'x' });
    const bound = await call('start_run_batch', { workflow_id: 5, items: [], max_items: 0 });
    const union = await call('execute_step', {
      run_id: 1,
      command: 'c',
      trace: [{ event: 'e', data: { k: {} } }],
    });
    const all = [typed['_text'], bound['_text'], union['_text']].map(String);
    // (a) red when a place's words are read from the raw issue's `message` (absent at check time:
    //     `undefined`); (b) prints the three texts and a boolean.
    expect({ all, undefinedSeen: all.some((t) => t.includes('undefined')) }).toEqual({
      all: [
        `${V}get_run_state: 2 problems in 2 places\nrun_id: expected string\ninclude_steps: expected boolean`,
        `${V}start_run_batch: 2 problems in 2 places\nworkflow_id: expected string\nmax_items: Too small: expected number to be >0`,
        `${V}execute_step: 2 problems in 2 places\nrun_id: expected string\ntrace[0].data.k: ${UNION}`,
      ],
      undefinedSeen: false,
    });
  });

  it('(x) the check runs although the call already holds issues, and sees them all', () => {
    const s = boundedRefusal(z.object({ a: z.string(), b: z.number() }));
    const r = s.safeParse({ a: 1, b: 'x' });
    // (a) red when the check runs only on a clean payload (`when` dropped: the two raw issues stay);
    //     (b) prints the issues.
    expect(r.error?.issues.map((i) => [i.code, i.path, i.message])).toEqual([
      ['custom', [], '2 problems in 2 places\na: expected string\nb: expected number'],
    ]);
  });

  it('(xi) a parse a bound aborted runs no check: zod’s two lines print as they are; the same two places without the abort get the summary', async () => {
    const { call } = await connect();
    const aborted = await call('create_workflow', { steps: steps(201), metadata: 1 });
    const whole = await call('create_workflow', {
      steps: [{ id: 'a', description: 1 }],
      metadata: 1,
    });
    // (a) red when the steps' leading `.max` no longer aborts (`aborted` reads the summary), or the
    //     helper is detached from `create_workflow` (`whole` reads zod's two lines); (b) prints the
    //     two texts.
    expect({ aborted: aborted['_text'], whole: whole['_text'] }).toEqual({
      aborted: `${V}create_workflow: Too big: expected array to have <=200 items at steps\nInvalid input: expected object, received number at metadata`,
      whole: `${V}create_workflow: 2 problems in 2 places\nsteps[0].description: expected string\nmetadata: expected object`,
    });
  });

  it('(xi′) a `max_items` that is not a whole number aborts too: zod’s own lines, no summary', async () => {
    const { call } = await connect();
    const r = await call('start_run_batch', { workflow_id: 5, items: [], max_items: 1.5 });
    // (a) red when the whole-number check no longer aborts (the summary appears); (b) prints the
    //     text.
    expect(r['_text']).toBe(
      `${V}start_run_batch: Invalid input: expected string, received number at workflow_id\nInvalid input: expected int, received number at max_items`,
    );
  });
});

describe('the zod 4 final pass, R2: the numbers', () => {
  it('O1: realm’s words for 2^53 on `max_items` and for a non-finite `llm_timeout_seconds`; zod’s for the rest', async () => {
    const { call } = await connect();
    const texts = [
      (await call('start_run_batch', { workflow_id: 'w', items: [], max_items: 1e16 }))['_text'],
      (await call('create_workflow', { steps: [step({ llm_timeout_seconds: Infinity })] }))[
        '_text'
      ],
      (await call('start_run_batch', { workflow_id: 'w', items: [], max_items: 0 }))['_text'],
      (await call('start_run_batch', { workflow_id: 'w', items: [], max_items: 1.5 }))['_text'],
      (await call('create_workflow', { steps: [step({ llm_timeout_seconds: '30' })] }))['_text'],
    ];
    // (a) red when an `error` function returns zod's words for its own branch (the first two read
    //     zod's lines), or speaks for another branch (the last three change); (b) prints the texts.
    expect(texts).toEqual([
      `${V}start_run_batch: max_items is above 9007199254740991 (2^53−1, the largest integer JSON carries exactly) — send a smaller integer at max_items`,
      `${V}create_workflow: llm_timeout_seconds is not a finite number (a value such as 1e400 arrives as Infinity) — send a finite number of seconds at steps[0].llm_timeout_seconds`,
      `${V}start_run_batch: Too small: expected number to be >0 at max_items`,
      `${V}start_run_batch: Invalid input: expected int, received number at max_items`,
      `${V}create_workflow: Invalid input: expected number, received string at steps[0].llm_timeout_seconds`,
    ]);
  });

  it('O2: a non-finite number in `params` is refused in the door’s own shape, and no run is stored', async () => {
    const { call, runStore, oneStep } = await connect();
    const { wid } = await oneStep();
    const n0 = (await runStore.list()).length;
    const r = await call('start_run', { workflow_id: wid, params: { n: Infinity } });
    const n1 = (await runStore.list()).length;
    // (a) red when the walk is not called before the run is created (a run stored with `n: null`)
    //     or the refusal leaves the door's argument-refusal shape; (b) prints the reply's fields
    //     and the run count.
    expect({
      status: r['status'],
      errors: r['errors'],
      agent_action: r['agent_action'],
      command: r['command'],
      error_code: r['error_code'],
      newRuns: n1 - n0,
    }).toEqual({
      status: 'error',
      errors: [
        'params.n is not a finite number; JSON cannot carry Infinity or NaN, and it would be stored as null — send a finite number',
      ],
      agent_action: 'provide_input',
      command: 'start_run',
      error_code: undefined,
      newRuns: 0,
    });
  });

  it('O2: an integer beyond 2^53−1 in `params` draws a warning naming its path; the run starts', async () => {
    const { call, oneStep } = await connect();
    const { wid } = await oneStep();
    const r = await call('start_run', { workflow_id: wid, params: { id: 2 ** 53 + 2 } });
    // (a) red when the walk finds no such integer (no warning) or echoes its value; (b) prints the
    //     status and the warnings.
    expect({ status: r['status'], warnings: r['warnings'] }).toEqual({
      status: 'ok',
      warnings: [
        'params.id is an integer beyond 2^53−1; JSON numbers past it are rounded, so it may not be what you sent — send identifiers as strings',
      ],
    });
  });

  it('O2: a non-finite number in an `input_schema` is refused, and nothing is stored', async () => {
    const { call, workflowStore } = await connect();
    const w0 = (await workflowStore.list()).length;
    const r = await call('create_workflow', {
      steps: [step({ input_schema: { type: 'object', properties: { n: { const: Infinity } } } })],
    });
    const w1 = (await workflowStore.list()).length;
    // (a) red when the walk is not called on `input_schema` before the id is derived (the
    //     workflow is stored with `null`); (b) prints the errors and the workflow count.
    expect({ errors: r['errors'], newWorkflows: w1 - w0 }).toEqual({
      errors: [
        'steps[0].input_schema.properties.n.const is not a finite number; JSON cannot carry Infinity or NaN, and it would be stored as null — send a finite number',
      ],
      newWorkflows: 0,
    });
  });

  it('O2: `append_trace` warns about an integer beyond 2^53−1 in `data`; the union refuses `Infinity` first', async () => {
    const { call, oneStep } = await connect();
    const { run } = await oneStep();
    const big = await call('append_trace', {
      run_id: run,
      step_id: 'p1',
      entries: [{ event: 'e', data: { k: 2 ** 53 + 2 } }],
    });
    const inf = await call('append_trace', {
      run_id: run,
      step_id: 'p1',
      entries: [{ event: 'e', data: { k: Infinity } }],
    });
    // (a) red when the walk is not called on the entries (no warning), or the union stops refusing
    //     a non-finite value; (b) prints the warnings and the text.
    expect({ warnings: big['warnings'], inf: inf['_text'] }).toEqual({
      warnings: [
        'entries[0].data.k is an integer beyond 2^53−1; JSON numbers past it are rounded, so it may not be what you sent — send identifiers as strings',
      ],
      inf: `${V}append_trace: ${UNION} at entries[0].data.k`,
    });
  });

  it('O2: the walk finds what JSON cannot carry, by path, and nothing else (helper-level)', () => {
    const found = walkNumbers(
      {
        a: [1, 2 ** 53 + 2, Infinity],
        b: { c: NaN, d: -Infinity, e: 2 ** 60 + 0.5, f: 9007199254740991 },
      },
      'params',
    );
    // (a) red when a non-finite number or an integer beyond 2^53−1 is missed, or a safe integer is
    //     reported; (b) prints the two lists.
    expect(found).toEqual({
      nonFinite: ['params.a[2]', 'params.b.c', 'params.b.d'],
      beyondSafe: ['params.a[1]', 'params.b.e'],
    });
  });
});

describe('the zod 4 final pass, R3: `depends_on` names one step, the step just before', () => {
  it('the door refuses what it cannot honour, with the rewrite; it accepts the step just before, `[]` and none', async () => {
    const { call } = await connect();
    const b = { id: 'b', description: 'd' };
    const texts = {
      two: (
        await call('create_workflow', {
          steps: [step(), b, { id: 'c', description: 'd', depends_on: ['a', 'b'] }],
        })
      )['_text'],
      string: (await call('create_workflow', { steps: [step(), { ...b, depends_on: 'a' }] }))[
        '_text'
      ],
      notJustBefore: (
        await call('create_workflow', {
          steps: [step(), b, { id: 'c', description: 'd', depends_on: ['a'] }],
        })
      )['errors'],
      first: (await call('create_workflow', { steps: [step({ depends_on: ['b'] }), b] }))['errors'],
      justBefore: (await call('create_workflow', { steps: [step(), { ...b, depends_on: ['a'] }] }))[
        'status'
      ],
      empty: (await call('create_workflow', { steps: [step(), { ...b, depends_on: [] }] }))[
        'status'
      ],
      none: (await call('create_workflow', { steps: [step(), b] }))['status'],
      unknown: (await call('create_workflow', { steps: [step(), { ...b, depends_on: ['zzz'] }] }))[
        'errors'
      ],
      later: (
        await call('create_workflow', {
          steps: [step(), { ...b, depends_on: ['c'] }, { id: 'c', description: 'd' }],
        })
      )['errors'],
    };
    // (a) red when the bound or its words move, the `error` leaves the check (a string then reads
    //     it), the non-adjacent branch is removed (accepted and re-wired), or the first-step branch
    //     is removed; (b) prints the texts and states.
    expect(texts).toEqual({
      two: `${V}create_workflow: depends_on lists more than one step; create_workflow takes at most one — the step just before this one (steps run in list order) at steps[2].depends_on`,
      string: `${V}create_workflow: Invalid input: expected array, received string at steps[1].depends_on`,
      notJustBefore: [
        "Step 'c': depends_on names 'a', but steps run in list order, so 'c' runs right after 'b'. Name 'b', leave depends_on out, or move 'c' to just below 'a'.",
      ],
      first: ["Step 'a' is the first step; nothing runs before it — leave depends_on out."],
      justBefore: 'ok',
      empty: 'ok',
      none: 'ok',
      // The guide's two rows (correction 1, C1-4 (a)): red when the unknown-name or the later-step
      // branch is removed (each then reads the rewrite).
      unknown: ["Step 'b': depends_on references unknown step 'zzz'"],
      later: ["Step 'b': depends_on must reference a step that appears earlier in the list"],
    });
  });

  it('the advertised schema: `maxItems: 1` and the description', async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    const cw = listed.tools.find((t) => t.name === 'create_workflow')!;
    const props = cw.inputSchema.properties as Record<
      string,
      { items: { properties: Record<string, unknown> } }
    >;
    // (a) red when the bound or the description leaves the schema; (b) prints the property.
    expect(props['steps']!.items.properties['depends_on']).toEqual({
      maxItems: 1,
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional. At most one name: the step listed just before this one. create_workflow runs steps one at a time in list order, so each step already waits for every step above it.',
    });
  });
});

describe('the zod 4 final pass: the docs (each sentence with its cell)', () => {
  const TOOLS = 'docs/reference/mcp/tools.md';
  const GUIDE = 'docs/guides/agent-created-workflows.md';
  const CL = 'CHANGELOG.md';
  it('tools.md and the CHANGELOG: the summary’s three forms (R1 (ii)–(v), (xi))', () => {
    claim(
      TOOLS,
      "With two or more such problems the text is one summary, under 4,000 characters, that never shows a value: its first line counts them (`2 problems in 2 places`); up to 10 lines then name each place and what it expected — `run_id: expected string`, or `trace[0].data: 10000 problems — expected a string, a number, a boolean or null (first: k0, k1, k2)` for many in one record — and `and N more places (T in all)` ends a longer list. A list over its bound, or a `max_items` that is not a whole number, prints zod's own lines.",
    );
    claim(
      CL,
      "One wrong parameter is refused with zod's line; two or more with one summary, under 4,000 characters, so a client that cuts a long text keeps the count: the count on its first line (`2 problems in 2 places`), then up to 10 places, each a path and what it expected (`run_id: expected string`; many problems in one record as `trace[0].data: 10000 problems — expected a string, a number, a boolean or null (first: k0, k1, k2)`), then `and N more places (T in all)`. A list over its bound, or a `max_items` that is not a whole number, prints zod's lines.",
    );
    claim(
      CL,
      "A trace entry's `data` value of another kind reads `expected a string, a number, a boolean or null`. No text shows the value it refused.",
    );
    claim(CL, 'What the server accepts of unknown keys is unchanged.');
  });

  it('tools.md and the CHANGELOG: the numbers (R2 O1, O2)', () => {
    claim(
      TOOLS,
      "**Numbers.** Integers beyond 2^53−1 (64-bit IDs) go as strings: a non-finite number is refused, and an integer beyond 2^53−1 inside `params`, `input_schema` or a trace entry's `data` draws a warning.",
    );
    claim(
      CL,
      "`Infinity` is now refused on `llm_timeout_seconds`, on a trace entry's `data` values and inside `params` and `input_schema` (it was already refused on `max_items`; zod 3 accepted it in the free-form records and stored `null`); a JavaScript client sends such a value as `null`, so this reaches only raw-text callers; an integer beyond 2^53−1 is refused on `max_items` and warned about inside the free-form records.",
    );
  });

  it('tools.md, the guide and the CHANGELOG: `depends_on` (R3)', () => {
    claim(
      TOOLS,
      '| `depends_on` | list | No | The step that must complete first: at most one, the step just before. |',
    );
    claim(
      GUIDE,
      '| `depends_on` | The step that must finish first: the step just before this one. |',
    );
    claim(
      GUIDE,
      'Except where the MCP layer refuses the call — no steps, more than 200 steps, more than one `depends_on` — the reply has `agent_action: provide_input`',
    );
    claim(
      GUIDE,
      '| More than one `depends_on` | `depends_on lists more than one step; create_workflow takes at most one — the step just before this one (steps run in list order) at steps[2].depends_on` |',
    );
    claim(
      GUIDE,
      "| A `depends_on` that is not the step just before | `Step 'c': depends_on names 'a', but steps run in list order, so 'c' runs right after 'b'. Name 'b', leave depends_on out, or move 'c' to just below 'a'.` |",
    );
    claim(
      GUIDE,
      "| A `depends_on` on the first step | `Step 'a' is the first step; nothing runs before it — leave depends_on out.` |",
    );
    claim(
      GUIDE,
      "| A `depends_on` naming no step | `Step 'b': depends_on references unknown step 'zzz'` |",
    );
    claim(
      GUIDE,
      "| A `depends_on` naming a later step | `Step 'b': depends_on must reference a step that appears earlier in the list` |",
    );
    claim(
      CL,
      '`create_workflow` refuses a `depends_on` that is not the step just before (it used to accept and silently re-wire it) and more than one name.',
    );
  });

  it('tools.md and the CHANGELOG: the lists bounded (correction 1, C1-5; cells 1, 2, 6 and 7)', () => {
    claim(
      TOOLS,
      "In the refusal and in the warnings, the first ten are named, then the count — `and 3990 more integers beyond 2^53−1 (4000 in all)`; `start_run_batch` counts each item's warnings on their own.",
    );
    claim(
      CL,
      "In the non-finite refusal and in the warnings, the first ten are named, then the count; `start_run_batch` counts each item's warnings on their own.",
    );
  });
});

describe('correction 1: the walk’s lists bounded — the first ten named, then the count', () => {
  const NF =
    ' is not a finite number; JSON cannot carry Infinity or NaN, and it would be stored as null — send a finite number';
  const BS =
    ' is an integer beyond 2^53−1; JSON numbers past it are rounded, so it may not be what you sent — send identifiers as strings';
  const BIG = 2 ** 53 + 2;
  const many = (n: number, v: number) =>
    Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, v]));
  /** A list's shape, never its whole: (b) a red prints this, not 40,000 lines. */
  const shape = (list: unknown) => {
    const l = (list ?? []) as string[];
    return {
      count: l.length,
      first: l[0],
      last: l.at(-1),
      within200: l.every((x) => x.length <= MAX_SUMMARY_LINE),
      under4000: l.join('\n').length < 4000,
    };
  };

  it('cell 1: 40,000 non-finite numbers in `params` — ten lines, then the count; no run stored', async () => {
    const { call, runStore, oneStep } = await connect();
    const { wid } = await oneStep();
    const n0 = (await runStore.list()).length;
    const r = await call('start_run', { workflow_id: wid, params: many(40_000, Infinity) });
    const n1 = (await runStore.list()).length;
    // (a) red when the refusal's bound is removed (40,000 lines, 5 MB); (b) prints the list's
    //     count, first and last lines, two booleans, the status and the run count.
    expect({ status: r['status'], errors: shape(r['errors']), newRuns: n1 - n0 }).toEqual({
      status: 'error',
      errors: {
        count: 11,
        first: `params.k0${NF}`,
        last: 'and 39990 more values are not finite numbers (40000 in all)',
        within200: true,
        under4000: true,
      },
      newRuns: 0,
    });
  });

  it('cell 2: 40,000 integers beyond 2^53−1 in `params` — the run starts, ten warnings, then the count', async () => {
    const { call, runStore, oneStep } = await connect();
    const { wid } = await oneStep();
    const n0 = (await runStore.list()).length;
    const r = await call('start_run', { workflow_id: wid, params: many(40_000, BIG) });
    const n1 = (await runStore.list()).length;
    // (a) red when the warnings' bound is removed (40,000 lines); (b) prints the list's shape, the
    //     status and the run count.
    expect({ status: r['status'], warnings: shape(r['warnings']), newRuns: n1 - n0 }).toEqual({
      status: 'ok',
      warnings: {
        count: 11,
        first: `params.k0${BS}`,
        last: 'and 39990 more integers beyond 2^53−1 (40000 in all)',
        within200: true,
        under4000: true,
      },
      newRuns: 1,
    });
  });

  it('cell 3: one value, unchanged — no count line; ten values, ten lines and no count line', async () => {
    const { call, oneStep } = await connect();
    const { wid } = await oneStep();
    const one = await call('start_run', { workflow_id: wid, params: { n: Infinity } });
    const oneBig = await call('start_run', { workflow_id: wid, params: { id: BIG } });
    const ten = await call('start_run', { workflow_id: wid, params: many(10, Infinity) });
    // (a) red when the count line is emitted below eleven, or a one-value line changes; (b) prints
    //     the two one-value lists and the ten's shape.
    expect({
      one: one['errors'],
      oneBig: oneBig['warnings'],
      ten: shape(ten['errors']),
    }).toEqual({
      one: [`params.n${NF}`],
      oneBig: [`params.id${BS}`],
      ten: {
        count: 10,
        first: `params.k0${NF}`,
        last: `params.k9${NF}`,
        within200: true,
        under4000: true,
      },
    });
  });

  it('cell 4: a 1,000-character key — the path cut at 75 characters, the diagnostic whole', async () => {
    const { call, oneStep } = await connect();
    const { wid } = await oneStep();
    const key = 'K'.repeat(1000);
    const nf = await call('start_run', { workflow_id: wid, params: { [key]: Infinity } });
    const bs = await call('start_run', { workflow_id: wid, params: { [key]: BIG } });
    const shown = `params.${'K'.repeat(68)}…`;
    const nfLine = (nf['errors'] as string[])[0]!;
    const bsLine = (bs['warnings'] as string[])[0]!;
    // (a) red when the path is not cut (1,120 and 1,131 characters) or the line is cut instead
    //     (the diagnostic lost); (b) prints the two lines' lengths and whether each is the cut
    //     path plus its whole diagnostic — never the lines.
    expect({
      nf: { length: nfLine.length, exact: nfLine === `${shown}${NF}` },
      bs: { length: bsLine.length, exact: bsLine === `${shown}${BS}` },
    }).toEqual({
      nf: { length: 189, exact: true },
      bs: { length: MAX_SUMMARY_LINE, exact: true },
    });
  });

  it('cell 5: `create_workflow` prints the refusal’s bounded list (12 values: ten, then `and 2 more`)', async () => {
    const { call } = await connect();
    const r = await call('create_workflow', {
      steps: [step({ input_schema: { const: Array(12).fill(Infinity) } })],
    });
    // (a) red when `create_workflow` renders the paths itself (12 lines, no count line); (b) prints
    //     the list's shape and the status.
    expect({ status: r['status'], errors: shape(r['errors']) }).toEqual({
      status: 'error',
      errors: {
        count: 11,
        first: `steps[0].input_schema.const[0]${NF}`,
        last: 'and 2 more values are not finite numbers (12 in all)',
        within200: true,
        under4000: true,
      },
    });
  });

  it('cell 6: `append_trace`, 200 entries × 20 — one list for the call, not one per entry', async () => {
    const { call, oneStep } = await connect();
    const { run } = await oneStep();
    const r = await call('append_trace', {
      run_id: run,
      step_id: 'p1',
      entries: Array.from({ length: 200 }, () => ({ event: 'e', data: many(20, BIG) })),
    });
    const w = (r['warnings'] ?? []) as string[];
    // (a) red when each entry's list is bounded alone (2,201 lines) or not at all (4,001); (b)
    //     prints the status, the count, the number lines' first and last, two booleans.
    expect({ status: r['status'], warnings: shape(w.slice(1)), all: w.length }).toEqual({
      status: 'ok',
      warnings: {
        count: 11,
        first: `entries[0].data.k0${BS}`,
        last: 'and 3990 more integers beyond 2^53−1 (4000 in all)',
        within200: true,
        under4000: true,
      },
      all: 12,
    });
  });

  it('cell 7: `start_run_batch` — each item’s warnings bounded on their own, the count line naming the item', async () => {
    const { call, oneStep } = await connect();
    const { wid } = await oneStep();
    const r = await call('start_run_batch', {
      workflow_id: wid,
      items: [{ params: many(20, BIG) }, { params: many(20, BIG) }],
    });
    const started = r['started'] as Array<{ warnings?: string[] }>;
    // (a) red when an item's list is not bounded (20 lines each); (b) prints each item's shape.
    expect(started.map((s) => shape(s.warnings))).toEqual(
      [0, 1].map((i) => ({
        count: 11,
        first: `items[${i}].params.k0${BS}`,
        last: `and 10 more integers beyond 2^53−1 in items[${i}].params (20 in all)`,
        within200: true,
        under4000: true,
      })),
    );
  });

  it('cell 8a: `execute_step` refuses a non-finite number in `params` before the claim', async () => {
    const { call, oneStep } = await connect();
    const { run } = await oneStep();
    const r = await call('execute_step', { run_id: run, command: 'p1', params: { n: Infinity } });
    const state = await call('get_run_state', { run_id: run });
    // (a) red when `execute_step`'s walk is not called (the step runs, `n` stored as null); (b)
    //     prints the reply's fields and the run's claim state.
    expect({
      status: r['status'],
      errors: r['errors'],
      agent_action: r['agent_action'],
      command: r['command'],
      error_code: r['error_code'],
      context_hint: r['context_hint'],
      inProgress: state['in_progress_steps'],
      claims: 'step_claims' in state,
    }).toEqual({
      status: 'error',
      errors: [`params.n${NF}`],
      agent_action: 'provide_input',
      command: 'p1',
      error_code: undefined,
      context_hint: 'Invalid p1 input. Fix the errors and retry.',
      inProgress: [],
      claims: false,
    });
  });

  it('cell 8b: `execute_step` warns about an integer beyond 2^53−1 in a trace entry’s `data`', async () => {
    const { call, oneStep } = await connect();
    const { run } = await oneStep();
    const r = await call('execute_step', {
      run_id: run,
      command: 'p1',
      trace: [{ event: 'e', data: { k: BIG } }],
    });
    // (a) red when `execute_step`'s walk is not called (no warning); (b) prints the status and
    //     the warnings.
    expect({ status: r['status'], warnings: r['warnings'] }).toEqual({
      status: 'ok',
      warnings: [`trace[0].data.k${BS}`],
    });
  });

  it('cell 8c: `start_run_batch` refuses a non-finite number in any item, before any run', async () => {
    const { call, runStore, oneStep } = await connect();
    const { wid } = await oneStep();
    const n0 = (await runStore.list()).length;
    const r = await call('start_run_batch', {
      workflow_id: wid,
      items: [{ params: { n: Infinity } }, { params: {} }],
    });
    const n1 = (await runStore.list()).length;
    // (a) red when the batch's walk is not called (the runs created); (b) prints the status, the
    //     errors and the run count.
    expect({ status: r['status'], errors: r['errors'], newRuns: n1 - n0 }).toEqual({
      status: 'error',
      errors: [`items[0].params.n${NF}`],
      newRuns: 0,
    });
  });

  it('cell 8d: `start_run_batch` puts an item’s warning on its own `started` entry', async () => {
    const { call, oneStep } = await connect();
    const { wid } = await oneStep();
    const r = await call('start_run_batch', { workflow_id: wid, items: [{ params: { id: BIG } }] });
    const started = r['started'] as Array<{ warnings?: string[] }>;
    // (a) red when the batch's walk is not called (no warning); (b) prints the item's warnings and
    //     whether the reply has a top-level `warnings` key.
    expect({ item: started[0]!.warnings, topLevel: 'warnings' in r }).toEqual({
      item: [`items[0].params.id${BS}`],
      topLevel: false,
    });
  });

  it('cell 8e: `create_workflow` warns about an integer beyond 2^53−1 in an `input_schema` `enum`', async () => {
    const { call } = await connect();
    const r = await call('create_workflow', {
      steps: [step({ input_schema: { enum: [BIG] } })],
    });
    // (a) red when `create_workflow`'s walk is not called (no warning); (b) prints the status and
    //     the warnings.
    expect({ status: r['status'], warnings: r['warnings'] }).toEqual({
      status: 'ok',
      warnings: [`steps[0].input_schema.enum[0]${BS}`],
    });
  });

  it('the count line’s singular, and none at exactly ten (helper-level)', () => {
    const paths = (n: number) => Array.from({ length: n }, (_, i) => `params.k${i}`);
    const r11 = new ArgsNumbersRefusal(paths(11));
    // (a) red when the singular reads as the plural, a count line appears at ten, or the message
    //     is not the bounded list; (b) prints the lines and counts.
    expect({
      refusal11: r11.errors.at(-1),
      refusal10: new ArgsNumbersRefusal(paths(10)).errors.length,
      message: r11.message === r11.errors.join('; '),
      joined11: checkArgsNumbersJoined([['params', many(11, BIG)]]).at(-1),
      joined10: checkArgsNumbersJoined([['params', many(10, BIG)]]).length,
      item11: checkArgsNumbers([['items[0].params', many(11, BIG)]])[0]!.at(-1),
    }).toEqual({
      refusal11: 'and 1 more value is not a finite number (11 in all)',
      refusal10: 10,
      message: true,
      joined11: 'and 1 more integer beyond 2^53−1 (11 in all)',
      joined10: 10,
      item11: 'and 1 more integer beyond 2^53−1 in items[0].params (11 in all)',
    });
  });
});
