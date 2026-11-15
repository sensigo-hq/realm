// Fix 1, piece 3a-i — a template's filters, their arguments and a templated field's type, judged
// when the file loads (`loadWorkflowFromStringWithDiagnostics`). The command cells (validate's exit,
// register, `--registered`, the cache lines, the run, the docs) are in the CLI's
// validate-template-check.test.ts.
//
// Each cell names the break that turns it red (prompts/ai-authoring-fix1-u3a1-filters.md).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILTER_STABILITY } from '../engine/render-template.js';
import { DEFAULT_POLICY, resolveSeverity } from './diagnostics.js';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const CODES = new Set([
  'TEMPLATE_FILTER_UNKNOWN',
  'TEMPLATE_FILTER_ARGUMENT',
  'TEMPLATED_FIELD_NOT_TEXT',
]);

/** The loader's piece-3a-i findings for `yaml`, read from the warnings or from a refusal's warnings. */
function findings(yaml: string) {
  try {
    return loadWorkflowFromStringWithDiagnostics(yaml).warnings.filter((w) => CODES.has(w.code));
  } catch (err) {
    const w = (err as { warnings?: Array<{ code: string }> }).warnings ?? [];
    throw new Error(`refused: ${(err as Error).message} ${JSON.stringify(w.map((x) => x.code))}`, {
      cause: err,
    });
  }
}
const messages = (yaml: string): string[] => findings(yaml).map((w) => w.message);

/** One agent step whose `prompt` is `text`. */
const agentPrompt = (text: string): string => `id: t
name: T
version: 1
steps:
  a:
    description: A.
    execution: agent
    prompt: ${JSON.stringify(text)}
`;

/** Check 1's four fields: a gated auto's `gate.message` and `instructions`, an agent's `prompt` and
 *  `display`, and a gateless agent step's `instructions` (the twin). */
const FOUR_FIELDS = (bad: string): string => `id: four
name: Four
version: 1
steps:
  ask:
    description: Ask.
    execution: auto
    trust: human_confirmed
    instructions: 'Do {{ run.params.s | ${bad} }}'
    gate:
      choices: [approve, reject]
      message: 'Go {{ run.params.s | ${bad} }}?'
  write:
    description: Write.
    execution: agent
    depends_on: [ask]
    prompt: 'Write {{ run.params.s | ${bad} }}'
    display: 'Shown {{ s | ${bad} }}'
  free:
    description: Free.
    execution: agent
    depends_on: [write]
    instructions: 'Raw {{ run.params.s | ${bad} }}'
`;

/** A valid form of each filter Realm has; its keys are held equal to FILTER_STABILITY's below. */
const VALID_FORMS: Record<string, string> = {
  bullets: 'bullets',
  join: 'join: " / "',
  default: 'default: "none"',
  upper: 'upper',
  lower: 'lower',
  capitalize: 'capitalize',
  truncate: 'truncate: 30',
  pluck: 'pluck: "title"',
  count: 'count',
  limit: 'limit: 2',
  compact: 'compact',
  round: 'round: 1',
  floor: 'floor',
  ceil: 'ceil',
  abs: 'abs',
  number_format: 'number_format: 2',
  percent: 'percent: 1',
  replace: 'replace: "/", " / "',
  yesno: 'yesno: "Active", "Inactive"',
  and_join: 'and_join',
  trim: 'trim',
  first: 'first',
  last: 'last',
  sum: 'sum',
  flatten: 'flatten',
  split: 'split: ","',
  sort: 'sort',
  unique: 'unique',
  title: 'title',
  code: 'code',
  indent: 'indent: 2',
  date: 'date: "long"',
  from_now: 'from_now',
  duration: 'duration',
};

describe('fix 1, piece 3a-i — template filters, arguments and field types', () => {
  it('the three codes are errors by policy', () => {
    // (1) red when any code is 'warn'; (2) prints the three.
    expect(
      [...CODES].map((c) => [c, resolveSeverity(c as never), DEFAULT_POLICY[c as never]]),
    ).toEqual([
      ['TEMPLATE_FILTER_UNKNOWN', 'error', 'error'],
      ['TEMPLATE_FILTER_ARGUMENT', 'error', 'error'],
      ['TEMPLATED_FIELD_NOT_TEXT', 'error', 'error'],
    ]);
  });

  it('check 1: an unknown filter in each judged field, with that field’s consequence; the gateless agent step’s instructions are not judged', () => {
    // (1) red when filters are not judged, a field is left out, a consequence changes, or every
    // step's instructions are judged (the `free` step); (2) prints the messages.
    expect(messages(FOUR_FIELDS('shoutloud'))).toEqual([
      "Step 'ask': gate.message uses the filter 'shoutloud' in '{{ run.params.s | shoutloud }}', which Realm does not have, so the gate does not open, and the run stays open with the step not done. (line 12)",
      "Step 'ask': instructions uses the filter 'shoutloud' in '{{ run.params.s | shoutloud }}', which Realm does not have, so the placeholder is passed on as written. (line 9)",
      "Step 'write': prompt uses the filter 'shoutloud' in '{{ run.params.s | shoutloud }}', which Realm does not have, so the placeholder is passed on as written. (line 17)",
      "Step 'write': display uses the filter 'shoutloud' in '{{ s | shoutloud }}', which Realm does not have, so that placeholder is not filled in where the step's result is shown. (line 18)",
    ]);
  });

  it("check 1: `bulets` gets \"Did you mean 'bullets'?\" in every field, and the finding's fields", () => {
    const got = findings(FOUR_FIELDS('bulets'));
    // (1) red when the did-you-mean is not the loader's closestKey over the known names; (2) prints them.
    expect(
      got.map((w) => ({
        code: w.code,
        severity: w.severity,
        step: w.step,
        key: w.key,
        dym: w.did_you_mean,
        ends: w.message.slice(w.message.indexOf('.') + 1).includes("Did you mean 'bullets'?"),
      })),
    ).toEqual([
      {
        code: 'TEMPLATE_FILTER_UNKNOWN',
        severity: 'error',
        step: 'ask',
        key: 'gate.message',
        dym: 'bullets',
        ends: true,
      },
      {
        code: 'TEMPLATE_FILTER_UNKNOWN',
        severity: 'error',
        step: 'ask',
        key: 'instructions',
        dym: 'bullets',
        ends: true,
      },
      {
        code: 'TEMPLATE_FILTER_UNKNOWN',
        severity: 'error',
        step: 'write',
        key: 'prompt',
        dym: 'bullets',
        ends: true,
      },
      {
        code: 'TEMPLATE_FILTER_UNKNOWN',
        severity: 'error',
        step: 'write',
        key: 'display',
        dym: 'bullets',
        ends: true,
      },
    ]);
  });

  it("check 1 (MA 4, 2026-11-15): a gated agent step's instructions are judged — the gate's opening reply renders them", () => {
    const yaml = `id: ga
name: GA
version: 1
steps:
  ask:
    description: Ask.
    execution: agent
    trust: human_confirmed
    instructions: 'Do {{ run.params.s | shoutloud }}'
`;
    // (1) red when only a gated auto's instructions are judged; (2) prints the codes and keys.
    expect(findings(yaml).map((w) => `${w.code} ${w.step}.${w.key}`)).toEqual([
      'TEMPLATE_FILTER_UNKNOWN ask.instructions',
    ]);
  });

  it('check 1: all 34 filters Realm has, each in a valid form, give no finding', () => {
    // (1) red when the known names come from a list that lacks one (that filter is then unknown), or
    // when a filter Realm adds has no valid form here; (2) prints the names and the findings.
    expect(Object.keys(VALID_FORMS).sort()).toEqual(Object.keys(FILTER_STABILITY).sort());
    const prompt = Object.values(VALID_FORMS)
      .map((form) => `{{ run.params.v | ${form} }}`)
      .join('\n');
    expect({
      count: Object.keys(VALID_FORMS).length,
      findings: messages(agentPrompt(prompt)),
    }).toEqual({ count: 34, findings: [] });
  });

  it('check 2: an argument no value accepts — out of range on a number or a text, or accepted by no value', () => {
    const prompt = [
      '{{ run.params.n | round: 500 }}',
      '{{ run.params.n | percent: 200 }}',
      '{{ run.params.s | indent: -1 }}',
      '{{ run.params.t | date: "%Y-%m-%d" }}',
      '{{ run.params.s | truncate }}',
    ].join('\n');
    // (1) red when arguments are not judged, or "no sample gives a value" is not judged (`date` and
    // `truncate` pass), or the cause's words change; (2) prints the messages.
    expect(messages(agentPrompt(prompt))).toEqual([
      "Step 'a': prompt gives the filter 'round' an argument no value accepts in '{{ run.params.n | round: 500 }}', so the step stops with an error when the run reaches it with a number. (line 8)",
      "Step 'a': prompt gives the filter 'percent' an argument no value accepts in '{{ run.params.n | percent: 200 }}', so the step stops with an error when the run reaches it with a number. (line 8)",
      "Step 'a': prompt gives the filter 'indent' an argument no value accepts in '{{ run.params.s | indent: -1 }}', so the step stops with an error when the run reaches it with a text. (line 8)",
      "Step 'a': prompt gives the filter 'date' an argument no value accepts in '{{ run.params.t | date: \"%Y-%m-%d\" }}', so the placeholder is passed on as written. (line 8)",
      "Step 'a': prompt gives the filter 'truncate' an argument no value accepts in '{{ run.params.s | truncate }}', so the placeholder is passed on as written. (line 8)",
    ]);
  });

  it("check 2: each example in the docs' filter table, and the docs' examples named in the prompt, give no finding", () => {
    const page = readFileSync(
      join(ROOT, 'docs/reference/workflow/input-map-and-templates.md'),
      'utf8',
    );
    // The filter table's rows: `| \`name\` | args | takes | \`example\` | result |`.
    const rows = page
      .split('\n')
      .filter((l) => /^\| `[a-z_]+` +\|/.test(l))
      .map((l) => l.split(/(?<!\\)\|/).map((c) => c.trim()))
      .filter((cells) => cells.length >= 6 && /^`.+`$/.test(cells[4] ?? ''));
    const examples = rows.map((cells) => cells[4]!.slice(1, -1).replace(/\\\|/g, '|'));
    const named = [
      'run.params.n | round: 2',
      'run.params.s | truncate: 12',
      'run.params.t | date: long',
      'run.params.b | yesno: "A", "B"',
      'run.params.t | from_now',
      'run.params.l | sum',
      'run.params.l | pluck: "sku"',
    ];
    const prompt = [...examples, ...named].map((e) => `{{ ${e} }}`).join('\n');
    // (1) red when a legal argument is refused; (2) prints the examples read and the findings.
    expect({ rows: examples.length, findings: messages(agentPrompt(prompt)) }).toEqual({
      rows: 34,
      findings: [],
    });
  });

  it('check 2: two chains — each filter is judged on its own, never fed the previous one’s output', () => {
    const prompt = [
      '{{ run.params.l | pluck: "ts" | first | date: long }}',
      '{{ run.params.l | pluck: "sku" | and_join }}',
    ].join('\n');
    // (1) red when the chain is fed through (both are refused then); (2) prints the findings.
    expect(messages(agentPrompt(prompt))).toEqual([]);
  });

  it('check 2: the consequence by field and cause — instructions out of range, gate.message accepted by no value, display either', () => {
    const yaml = `id: cons
name: Cons
version: 1
steps:
  ask:
    description: Ask.
    execution: auto
    trust: human_confirmed
    instructions: 'Do {{ run.params.n | round: 500 }}'
    gate:
      choices: [approve, reject]
      message: 'Go {{ run.params.t | date: "%Y-%m-%d" }} {{ run.params.n | round: 500 }}?'
  write:
    description: Write.
    execution: agent
    depends_on: [ask]
    display: '{{ n | round: 500 }} {{ t | date: "%Y-%m-%d" }}'
`;
    // (1) red when a field's or a cause's consequence changes; (2) prints the consequences.
    expect(messages(yaml).map((m) => `${m.split(':')[0]} ${m.split(', so ')[1]}`)).toEqual([
      "Step 'ask' the question shows the placeholder as written. (line 12)",
      "Step 'ask' the step stops with an error when the run reaches it with a number. (line 12)",
      "Step 'ask' the call that opens the gate fails with an error after the question is already open. (line 9)",
      "Step 'write' that placeholder is not filled in where the step's result is shown. (line 17)",
      "Step 'write' that placeholder is not filled in where the step's result is shown. (line 17)",
    ]);
  });

  it('item 5: one finding per bad filter in chain order, up to and including the first unknown one', () => {
    const prompt = '{{ run.params.n | round: 500 | shoutloud | indent: -1 }}';
    // (1) red when a chain stops at its first finding, or a filter after an unknown one is judged;
    // (2) prints the codes.
    expect(findings(agentPrompt(prompt)).map((w) => w.code)).toEqual([
      'TEMPLATE_FILTER_ARGUMENT',
      'TEMPLATE_FILTER_UNKNOWN',
    ]);
  });

  it('check 3: a templated field that is not text, with the type named; the gateless agent step’s instructions are not judged', () => {
    const yaml = `id: types
name: Types
version: 1
steps:
  ask:
    description: Ask.
    execution: auto
    trust: human_confirmed
    instructions: 42
    gate:
      choices: [approve, reject]
      message: 42
  write:
    description: Write.
    execution: agent
    depends_on: [ask]
    prompt: [a, b]
    display:
  other:
    description: Other.
    execution: agent
    depends_on: [write]
    prompt: { a: 1 }
    display: true
  free:
    description: Free.
    execution: agent
    depends_on: [other]
    instructions: 42
`;
    // (1) red when the type is not judged, a type word changes, or every step's instructions are
    // judged (`free`); (2) prints the messages.
    expect(messages(yaml)).toEqual([
      "Step 'ask': gate.message must be text; it is a number, so Realm stops with an error when it reads it. (line 12)",
      "Step 'ask': instructions must be text; it is a number, so Realm stops with an error when it reads it. (line 9)",
      "Step 'write': prompt must be text; it is a list, so Realm stops with an error when it reads it. (line 17)",
      "Step 'write': display must be text; it is empty, so Realm stops with an error when it reads it. (line 18)",
      "Step 'other': prompt must be text; it is a map, so Realm stops with an error when it reads it. (line 23)",
      "Step 'other': display must be text; it is true or false, so Realm stops with an error when it reads it. (line 24)",
    ]);
  });

  it('not judged: an empty text, and a placeholder with no filters (its path is 3a-ii’s)', () => {
    // (1) red when an empty string or a bare path is judged; (2) prints the findings.
    expect({
      empty: messages(agentPrompt('')),
      bare: messages(agentPrompt('{{ run.params.nope }} {{ context.resources.x.y }}')),
    }).toEqual({ empty: [], bare: [] });
  });

  it("the line: the key's own line, else the step's (a field taken through a YAML merge key)", () => {
    const yaml = `id: merge
name: Merge
version: 1
steps:
  a: &base
    description: A.
    execution: agent
    prompt: '{{ run.params.s | shoutloud }}'
  b:
    <<: *base
    description: B.
`;
    // (1) red when the fallback is removed or a line is invented; (2) prints the endings and lines.
    expect(
      findings(yaml).map((w) => ({
        step: w.step,
        end: w.message.slice(w.message.lastIndexOf('.') + 1),
        line: w.line,
      })),
    ).toEqual([
      { step: 'a', end: ' (line 8)', line: 8 },
      { step: 'b', end: ' (step at line 9)', line: undefined },
    ]);
  });

  it('a refused file still carries every finding (the codes ride the refusal)', () => {
    // A dependency on a step that does not exist is refused by the loader; the template finding
    // still rides the refusal.
    const yaml = `${agentPrompt('{{ run.params.s | shoutloud }}')}    depends_on: [nope]\n`;
    let codes: string[] = ['not refused'];
    try {
      loadWorkflowFromStringWithDiagnostics(yaml);
    } catch (err) {
      codes = ((err as { warnings?: Array<{ code: string }> }).warnings ?? []).map((w) => w.code);
    }
    // (1) red when the check is skipped on a file with another problem; (2) prints the codes.
    expect(codes.filter((c) => CODES.has(c))).toEqual(['TEMPLATE_FILTER_UNKNOWN']);
  });
});
