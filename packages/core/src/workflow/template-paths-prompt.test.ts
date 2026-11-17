// Fix 1, piece 3a-ii-b — every `{{ … }}` path in a step's `prompt` and in its `instructions`, judged
// against what the workflow declares when the file loads (`loadWorkflowFromStringWithDiagnostics`):
// a path that can never be found is refused, one that may be missing gets a warning (prompts stay
// lenient), and a placeholder that starts with none of Realm's roots, nor a wrong start naming a step
// of the workflow, is text for the model. The command cells (validate, register, the run, the
// not-checked line's cap, the words) are in the CLI's validate-template-paths-prompt.test.ts.
//
// Each cell names the break that turns it red (prompts/ai-authoring-fix1-u3a2b-prompt-instructions.md).
import { describe, it, expect } from 'vitest';
import { resolveSeverity } from './diagnostics.js';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';

const CODES = new Set([
  'TEMPLATE_PATH_UNRESOLVABLE',
  'TEMPLATE_PATH_NO_DEFAULT',
  'TEMPLATE_PATH_UNCERTAIN',
  'TEMPLATE_FILTER_UNKNOWN',
]);

function load(yaml: string) {
  try {
    return loadWorkflowFromStringWithDiagnostics(yaml);
  } catch (err) {
    throw new Error(`refused: ${(err as Error).message}`, { cause: err });
  }
}
/** The findings as `code: message`. */
const found = (yaml: string): string[] =>
  load(yaml)
    .warnings.filter((w) => CODES.has(w.code))
    .map((w) => `${w.code}: ${w.message}`);
/** The template references listed as not checked. */
const listed = (yaml: string) => load(yaml).notChecked.filter((n) => n.surface === 'template');

/** `review`'s closed answer (`risk` required, `notes` optional), and an agent step `draft` whose prompt is `prompt`. */
const prompted = (prompt: string, extra = ''): string => `id: p
name: P
version: 1
steps:
  review:
    description: Review.
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [risk]
      properties:
        risk: { type: string }
        notes: { type: string }
  draft:
    description: Draft.
    execution: agent
    depends_on: [review]
    prompt: ${JSON.stringify(prompt)}
    input_schema:
      type: object
      additionalProperties: false
      required: [text]
      properties:
        text: { type: string }
${extra}`;

/** `review`, then a step `ask` of `kind` with `instructions`; gated (human_confirmed) unless `gated` is false. */
const instructed = (instructions: string, kind = 'agent', gated = true): string => `id: g
name: G
version: 1
steps:
  review:
    description: Review.
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [risk]
      properties:
        risk: { type: string }
        notes: { type: string }
  ask:
    description: Ask.
    execution: ${kind}
    depends_on: [review]
${gated ? '    trust: human_confirmed\n' : ''}    instructions: ${JSON.stringify(instructions)}
    input_schema:
      type: object
      additionalProperties: false
      required: [answer]
      properties:
        answer: { type: string }
${gated ? '    gate:\n      choices: [approve, reject]\n      message: Approve?\n' : ''}`;

const READS = "'context.resources.<step>.', 'run.params.' and 'workflow.context.<name>'";
const SENT = 'the model is sent the placeholder as written';
const SHOWN = 'the instructions show the placeholder as written';
const FIX =
  "Add '| default: <value>' as its first filter, keeping after it only filters that take that value";

describe('fix 1, piece 3a-ii-b — paths in step prompts and instructions', () => {
  it("check 1: a misspelt field in a prompt is refused with the did-you-mean and the key's line; the right field gives nothing", () => {
    // (1) red when `prompt` is not judged; (2) prints the findings.
    expect({
      misspelt: found(prompted('P {{ context.resources.review.riks }}')),
      right: found(prompted('P {{ context.resources.review.risk }}')),
    }).toEqual({
      misspelt: [
        `TEMPLATE_PATH_UNRESOLVABLE: Step 'draft': prompt reads 'context.resources.review.riks' in '{{ context.resources.review.riks }}', which can never be found: step 'review' has no field 'riks' there, and its schema allows no other fields, so ${SENT}. Did you mean 'risk'? (line 19)`,
      ],
      right: [],
    });
  });

  it('check 2: a path that may be missing in a prompt is a warning, never a refusal; `| default` fills it; another filter does not', () => {
    const warning = load(prompted('P {{ context.resources.review.notes }}')).warnings.find(
      (w) => w.code === 'TEMPLATE_PATH_UNCERTAIN',
    );
    // (1) red when may-be-missing is refused in a prompt (another code, or severity 'error'), or the
    // fill rule is not applied (the `default` cell gets a finding); (2) prints them.
    expect({
      severity: warning?.severity,
      policy: resolveSeverity('TEMPLATE_PATH_UNCERTAIN'),
      missing: found(prompted('P {{ context.resources.review.notes }}')),
      filled: found(prompted("P {{ context.resources.review.notes | default: 'n/a' }}")),
      otherFilter: found(prompted('P {{ context.resources.review.notes | upper }}')),
    }).toEqual({
      severity: 'warn',
      policy: 'warn',
      missing: [
        `TEMPLATE_PATH_UNCERTAIN: Step 'draft': prompt reads 'context.resources.review.notes' in '{{ context.resources.review.notes }}', which may be missing when the prompt is sent ('notes' is optional in its schema), so then ${SENT}. ${FIX}, or make 'notes' required. (line 19)`,
      ],
      filled: [],
      otherFilter: [
        `TEMPLATE_PATH_UNCERTAIN: Step 'draft': prompt reads 'context.resources.review.notes' in '{{ context.resources.review.notes | upper }}', which may be missing when the prompt is sent ('notes' is optional in its schema), so then ${SENT}. ${FIX}, or make 'notes' required. (line 19)`,
      ],
    });
  });

  it("check 3: the step's own output in its prompt is refused with its own reason; a later step's with the prompt's moment", () => {
    const after =
      '  after:\n    description: After.\n    execution: agent\n    depends_on: [draft]\n' +
      '    input_schema:\n      type: object\n      properties:\n        x: { type: string }\n';
    // (1) red when the prompt surface reads its own output (no finding), or the reasons name the
    // gate; (2) prints them.
    expect({
      own: found(prompted('P {{ context.resources.draft.text }}')),
      later: found(prompted('P {{ context.resources.after.x }}', after)),
    }).toEqual({
      own: [
        `TEMPLATE_PATH_UNRESOLVABLE: Step 'draft': prompt reads 'context.resources.draft.text' in '{{ context.resources.draft.text }}', which can never be found: this step's own output is not there when its prompt is sent, so ${SENT}. (line 19)`,
      ],
      later: [
        `TEMPLATE_PATH_UNRESOLVABLE: Step 'draft': prompt reads 'context.resources.after.x' in '{{ context.resources.after.x }}', which can never be found: step 'after' runs after this one, so its output is not there when the prompt is sent, so ${SENT}. (line 19)`,
      ],
    });
  });

  it("check 4: instructions on a gated step read its own answer and are judged; a gateless step's are not", () => {
    // (1) red when instructions are not judged (no finding for `riks`), or a gateless step's are
    // judged, or the own field is refused; (2) prints them.
    expect({
      ownRequired: found(instructed('I {{ context.resources.ask.answer }}')),
      misspelt: found(instructed('I {{ context.resources.review.riks }}')),
      autoGated: found(instructed('I {{ context.resources.review.riks }}', 'auto')),
      gateless: found(instructed('I {{ context.resources.review.riks }}', 'agent', false)),
    }).toEqual({
      ownRequired: [],
      misspelt: [
        `TEMPLATE_PATH_UNRESOLVABLE: Step 'ask': instructions reads 'context.resources.review.riks' in '{{ context.resources.review.riks }}', which can never be found: step 'review' has no field 'riks' there, and its schema allows no other fields, so ${SHOWN}. Did you mean 'risk'? (line 20)`,
      ],
      autoGated: [
        `TEMPLATE_PATH_UNRESOLVABLE: Step 'ask': instructions reads 'context.resources.review.riks' in '{{ context.resources.review.riks }}', which can never be found: step 'review' has no field 'riks' there, and its schema allows no other fields, so ${SHOWN}. Did you mean 'risk'? (line 20)`,
      ],
      gateless: [],
    });
  });

  it("check 4: instructions' own words — may be missing when the gate opens, and their root reason", () => {
    // (1) red when instructions take the prompt's moment or root reason, or a may-be-missing path is
    // refused there; (2) prints them.
    expect({
      notes: found(instructed('I {{ context.resources.review.notes }}')),
      runId: found(instructed('I {{ run.id }}')),
    }).toEqual({
      notes: [
        `TEMPLATE_PATH_UNCERTAIN: Step 'ask': instructions reads 'context.resources.review.notes' in '{{ context.resources.review.notes }}', which may be missing when the gate opens ('notes' is optional in its schema), so then ${SHOWN}. ${FIX}, or make 'notes' required. (line 20)`,
      ],
      runId: [
        `TEMPLATE_PATH_UNRESOLVABLE: Step 'ask': instructions reads 'run.id' in '{{ run.id }}', which can never be found: step instructions read only ${READS}, so ${SHOWN}. (line 20)`,
      ],
    });
  });

  it('check 5: roots — a wrong start naming a step is refused with its fix; `run.id` with the root reason; text for the model gets nothing', () => {
    const rootReason = (path: string, fix?: string): string =>
      `TEMPLATE_PATH_UNRESOLVABLE: Step 'draft': prompt reads '${path}' in '{{ ${path} }}', which can never be found: a prompt reads only ${READS}, so ${SENT}.` +
      (fix !== undefined ? ` Write it as '${fix}'.` : '') +
      ' (line 19)';
    // (1) red when text for the model is judged (`finding`, `name`, `steps.build…` refused), a wrong
    // start is left alone (`steps.review.output.risk` gets nothing), a bare step name is left alone
    // (`review.risk` gets nothing), or `steps.<x>` is judged when `<x>` is not a step; (2) prints them.
    expect({
      stepsOutput: found(prompted('P {{ steps.review.output.risk }}')),
      runId: found(prompted('P {{ run.id }}')),
      bareStep: found(prompted('P {{ review.risk }}')),
      settlement: found(prompted('P {{ $settlement.review.failed }}')),
      text: found(prompted('P {{ finding }} {{ name }} {{ steps.build.outputs.v }}')),
      stepsNoOutput: found(prompted('P {{ steps.review.risk }}')),
    }).toEqual({
      stepsOutput: [rootReason('steps.review.output.risk', 'context.resources.review.risk')],
      runId: [rootReason('run.id')],
      bareStep: [rootReason('review.risk', 'context.resources.review.risk')],
      settlement: [
        rootReason('$settlement.review.failed', 'context.resources.$settlement.review.failed'),
      ],
      text: [],
      stepsNoOutput: [],
    });
  });

  it("check 5: a never-found path that `| default` fills says the prompt, or the instructions, always show the default's", () => {
    // (1) red when the filled form's words are not the field's own; (2) prints them.
    expect({
      prompt: found(prompted("P {{ context.resources.review.riks | default: 'x' }}")),
      instructions: found(instructed("I {{ context.resources.review.riks | default: 'x' }}")),
    }).toEqual({
      prompt: [
        "TEMPLATE_PATH_UNRESOLVABLE: Step 'draft': prompt reads 'context.resources.review.riks' in '{{ context.resources.review.riks | default: 'x' }}', which can never be found: step 'review' has no field 'riks' there, and its schema allows no other fields, so the prompt always shows what '| default' gives. Did you mean 'risk'? (line 19)",
      ],
      instructions: [
        "TEMPLATE_PATH_UNRESOLVABLE: Step 'ask': instructions reads 'context.resources.review.riks' in '{{ context.resources.review.riks | default: 'x' }}', which can never be found: step 'review' has no field 'riks' there, and its schema allows no other fields, so the instructions always show what '| default' gives. Did you mean 'risk'? (line 20)",
      ],
    });
  });

  it("check 6: no second finding — a placeholder 3a-i reports gets only 3a-i's, under a root or as text", () => {
    // (1) red when every placeholder is judged (a path finding beside 3a-i's); (2) prints them.
    expect(
      found(prompted('P {{ x | shoutloud }} {{ context.resources.review.riks | shoutloud }}')),
    ).toEqual([
      "TEMPLATE_FILTER_UNKNOWN: Step 'draft': prompt uses the filter 'shoutloud' in '{{ x | shoutloud }}', which Realm does not have, so the placeholder is passed on as written. (line 19)",
      "TEMPLATE_FILTER_UNKNOWN: Step 'draft': prompt uses the filter 'shoutloud' in '{{ context.resources.review.riks | shoutloud }}', which Realm does not have, so the placeholder is passed on as written. (line 19)",
    ]);
  });

  it("check 7: a prompt reading a handler's output is listed as not checked with key 'prompt'", () => {
    const yaml = `id: h
name: H
version: 1
steps:
  fetch:
    description: Fetch.
    execution: auto
    handler: fetch_it
  draft:
    description: Draft.
    execution: agent
    depends_on: [fetch]
    prompt: 'T {{ context.resources.fetch.title }}'
`;
    // (1) red when such a reference is not listed; (2) prints the list and the findings.
    expect({ listed: listed(yaml), found: found(yaml) }).toEqual({
      listed: [
        {
          surface: 'template',
          step: 'draft',
          key: 'prompt',
          path: 'context.resources.fetch.title',
          why: 'producer_declares_no_shape',
        },
      ],
      found: [],
    });
  });
});
