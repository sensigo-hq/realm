// Fix 1, piece 3a-ii-a — every `{{ … }}` path in an approval question (`gate.message`) and in a step's
// `display`, judged against what the workflow declares when the file loads
// (`loadWorkflowFromStringWithDiagnostics`). The command cells (validate's exit and lines, register,
// the run) are in the CLI's validate-template-paths.test.ts.
//
// Each cell names the break that turns it red (prompts/ai-authoring-fix1-u3a2a-gate-display.md).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderTemplate } from '../engine/render-template.js';
import { DEFAULT_POLICY, resolveSeverity } from './diagnostics.js';
import { PathIndex } from './path-resolver.js';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';

const CODES = new Set([
  'TEMPLATE_PATH_UNRESOLVABLE',
  'TEMPLATE_PATH_NO_DEFAULT',
  'TEMPLATE_PATH_UNCERTAIN',
]);

function load(yaml: string) {
  try {
    return loadWorkflowFromStringWithDiagnostics(yaml);
  } catch (err) {
    throw new Error(`refused: ${(err as Error).message}`, { cause: err });
  }
}
/** The piece's findings as `code: message`. */
const found = (yaml: string): string[] =>
  load(yaml)
    .warnings.filter((w) => CODES.has(w.code))
    .map((w) => `${w.code}: ${w.message}`);
/** The template references listed as not checked. */
const listed = (yaml: string) => load(yaml).notChecked.filter((n) => n.surface === 'template');

/** A closed answer (`review`) and a gated auto step whose question is `message`. */
const question = (message: string, extra = ''): string => `id: q
name: Q
version: 1
steps:
  review:
    description: Review.
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [risk, key_changes]
      properties:
        risk: { type: string }
        key_changes: { type: array, items: { type: string } }
        notes: { type: string }
        amount: { type: number }
  approve:
    description: Approve.
    execution: auto
    trust: human_confirmed
    depends_on: [review]
${extra}    gate:
      choices: [approve, reject]
      message: ${JSON.stringify(message)}
`;

/** A gated agent step (`ask`) whose own closed answer declares `risk`, with a question and a display. */
const own = (message: string, display = 'ok', choice = false): string => `id: o
name: O
version: 1
steps:
  ask:
    description: Ask.
    execution: agent
    trust: human_confirmed
    input_schema:
      type: object
      additionalProperties: false
      required: [risk, key_changes${choice ? ', choice' : ''}]
      properties:
        risk: { type: string }
        notes: { type: string }
        key_changes: { type: array, items: { type: string } }${choice ? '\n        choice: { type: string }' : ''}
    gate:
      choices: [approve, reject]
      message: ${JSON.stringify(message)}
    display: ${JSON.stringify(display)}
`;

const GATE_STOPS = 'the gate does not open, and the run stays open with the step not done';
const DEFAULT_FIX =
  "Add '| default: <value>' as its first filter, keeping after it only filters that take that value";

describe('fix 1, piece 3a-ii-a — paths in approval questions and display', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the three codes and their policy', () => {
    // (1) red when an error code is 'warn' or the display one 'error'; (2) prints them.
    expect(
      [...CODES].map((c) => [c, resolveSeverity(c as never), DEFAULT_POLICY[c as never]]),
    ).toEqual([
      ['TEMPLATE_PATH_UNRESOLVABLE', 'error', 'error'],
      ['TEMPLATE_PATH_NO_DEFAULT', 'error', 'error'],
      ['TEMPLATE_PATH_UNCERTAIN', 'warn', 'warn'],
    ]);
  });

  it("check 1: a misspelt field in a question is refused with the did-you-mean and the key's line; the right field gives nothing", () => {
    const bad = load(question('Risk: {{ context.resources.review.riks }}'));
    const w = bad.warnings.filter((x) => CODES.has(x.code));
    // (1) red when gate.message paths are not judged, or the words, line or did-you-mean change;
    // (2) prints the findings.
    expect(
      w.map((x) => ({
        code: x.code,
        key: x.key,
        step: x.step,
        line: x.line,
        dym: x.did_you_mean,
        message: x.message,
      })),
    ).toEqual([
      {
        code: 'TEMPLATE_PATH_UNRESOLVABLE',
        key: 'gate.message',
        step: 'approve',
        line: 24,
        dym: 'risk',
        message:
          "Step 'approve': gate.message reads 'context.resources.review.riks' in '{{ context.resources.review.riks }}', which can never be found: step 'review' has no field 'riks' there, and its schema allows no other fields, so " +
          GATE_STOPS +
          ". Did you mean 'risk'? (line 24)",
      },
    ]);
    expect(found(question('Risk: {{ context.resources.review.risk }}'))).toEqual([]);
  });

  it("check 2: the step's own output — its own field is there; its own $settlement and choice are not, each with its reason", () => {
    // (1) red when the own output is treated as running after, or the exception widened to
    // $settlement or choice; (2) prints the findings.
    expect({
      ownField: found(own('Risk {{ context.resources.ask.risk }}')),
      settlement: found(own('S {{ context.resources.$settlement.ask.failed }}')),
      choice: found(own('C {{ context.resources.ask.choice }}')),
      declaredChoice: found(own('C {{ context.resources.ask.choice }}', 'ok', true)),
    }).toEqual({
      ownField: [],
      settlement: [
        "TEMPLATE_PATH_UNRESOLVABLE: Step 'ask': gate.message reads 'context.resources.$settlement.ask.failed' in '{{ context.resources.$settlement.ask.failed }}', which can never be found: '$settlement.ask' is there only once the step is settled, after its gate is answered, so " +
          GATE_STOPS +
          '. (line 19)',
      ],
      choice: [
        "TEMPLATE_PATH_UNRESOLVABLE: Step 'ask': gate.message reads 'context.resources.ask.choice' in '{{ context.resources.ask.choice }}', which can never be found: 'choice' is the answer to this question, so it is not there when the gate opens, so " +
          GATE_STOPS +
          '. (line 19)',
      ],
      declaredChoice: [],
    });
  });

  it('check 2: another step that runs after this one is never there when the gate opens', () => {
    const yaml = `id: later
name: Later
version: 1
steps:
  ask:
    description: Ask.
    execution: auto
    trust: human_confirmed
    gate:
      choices: [approve, reject]
      message: 'After {{ context.resources.later.risk }}'
  later:
    description: Later.
    execution: agent
    depends_on: [ask]
    input_schema:
      type: object
      required: [risk]
      properties:
        risk: { type: string }
`;
    // (1) red when a later step is only "may be missing"; (2) prints the finding.
    expect(found(yaml)).toEqual([
      "TEMPLATE_PATH_UNRESOLVABLE: Step 'ask': gate.message reads 'context.resources.later.risk' in '{{ context.resources.later.risk }}', which can never be found: step 'later' runs after this one, so its output is not there when the gate opens, so " +
        GATE_STOPS +
        '. (line 11)',
    ]);
  });

  it('check 3: filled by `| default` — an optional field is refused in a question and warned in display; a filling default gives nothing; a default the later filters cannot take does not fill', () => {
    const q = (m: string) => found(question(m));
    // (1) red when `default` is ignored, any default anywhere fills, a leading default fills whatever
    // follows, or the question's may-be-missing is only warned; (2) prints the findings.
    expect({
      bare: q('N {{ context.resources.review.notes }}'),
      display: found(own('ok', 'N {{ notes }}')),
      filled: q("N {{ context.resources.review.notes | default: 'n/a' }}"),
      filledUpper: q("N {{ context.resources.review.notes | default: 'none' | upper }}"),
      displayFilled: found(
        own('ok', "N {{ notes | default: 'n/a' }} {{ notes | default: 'none' | upper }}"),
      ),
      upperThenDefault: q("N {{ context.resources.review.notes | upper | default: 'n/a' }}"),
      defaultThenRound: q("A {{ context.resources.review.amount | default: '0' | round: 2 }}"),
    }).toEqual({
      bare: [
        `TEMPLATE_PATH_NO_DEFAULT: Step 'approve': gate.message reads 'context.resources.review.notes' in '{{ context.resources.review.notes }}', which may be missing when the gate opens ('notes' is optional in its schema), so then ${GATE_STOPS}. ${DEFAULT_FIX}, or make 'notes' required. (line 24)`,
      ],
      display: [
        `TEMPLATE_PATH_UNCERTAIN: Step 'ask': display reads 'notes' in '{{ notes }}', which may be missing ('notes' is optional in its schema), so then the placeholder is shown as nothing. ${DEFAULT_FIX}, or make 'notes' required. (line 20)`,
      ],
      filled: [],
      filledUpper: [],
      displayFilled: [],
      upperThenDefault: [
        `TEMPLATE_PATH_NO_DEFAULT: Step 'approve': gate.message reads 'context.resources.review.notes' in '{{ context.resources.review.notes | upper | default: 'n/a' }}', which may be missing when the gate opens ('notes' is optional in its schema), so then the question shows the placeholder as written. ${DEFAULT_FIX}, or make 'notes' required. (line 24)`,
      ],
      defaultThenRound: [
        "TEMPLATE_PATH_NO_DEFAULT: Step 'approve': gate.message reads 'context.resources.review.amount' in '{{ context.resources.review.amount | default: '0' | round: 2 }}', which may be missing when the gate opens ('amount' is optional in its schema), so then the question shows the placeholder as written. The filters after '| default' give nothing from its value, so its default is never shown. (line 24)",
      ],
    });
  });

  it("check 3: a never-found path that `| default` fills says the question always shows the default's", () => {
    // (1) red when the filled form's consequence is not chosen; (2) prints the finding.
    expect(found(question("R {{ context.resources.review.riks | default: 'n/a' }}"))).toEqual([
      "TEMPLATE_PATH_UNRESOLVABLE: Step 'approve': gate.message reads 'context.resources.review.riks' in '{{ context.resources.review.riks | default: 'n/a' }}', which can never be found: step 'review' has no field 'riks' there, and its schema allows no other fields, so the question always shows what '| default' gives. Did you mean 'risk'? (line 24)",
    ]);
  });

  it('check 4: each may-be-missing cause has its own why, and its own fix where it has one', () => {
    const open = `id: c
name: C
version: 1
params_schema:
  type: object
  properties:
    order_id: { type: string }
steps:
  review:
    description: Review.
    execution: agent
    input_schema:
      type: object
      required: [risk, items]
      properties:
        risk: { type: string }
        items: { type: array, items: { type: string } }
  other:
    description: Other.
    execution: agent
  approve:
    description: Approve.
    execution: auto
    trust: human_confirmed
    depends_on: [review]
    gate:
      choices: [approve, reject]
      message: 'F {{ context.resources.review.riks }} P {{ run.params.order_idd }} D {{ context.resources.other.x }} L {{ context.resources.review.items.0 }}'
  later:
    description: Later.
    execution: auto
    trust: human_confirmed
    trigger_rule: all_done
    depends_on: [review]
    gate:
      choices: [approve, reject]
      message: 'T {{ context.resources.review.risk }}'
`;
    const out = found(open).map(
      (m) =>
        m.split(', so then ')[0]!.split('which may be missing when the gate opens ')[1] +
        ' | ' +
        m.split(', so then ')[1],
    );
    // (1) red when one sentence serves every cause, or a "Declare" fix is printed; (2) prints them.
    expect(out).toEqual([
      `(step 'review' does not declare this path) | ${GATE_STOPS}. Did you mean 'risk'? (line 28)`,
      `(params_schema does not declare this path) | ${GATE_STOPS}. Did you mean 'order_id'? (line 28)`,
      `(this step does not depend on 'other') | ${GATE_STOPS}. Add 'other' to depends_on. (line 28)`,
      `('0' is a position in a list that may be shorter) | ${GATE_STOPS}. ${DEFAULT_FIX}. (line 28)`,
      `(this step's trigger_rule lets it run when 'review' did not complete) | ${GATE_STOPS}. ${DEFAULT_FIX}, or change the trigger_rule. (line 37)`,
    ]);
  });

  it("check 4: `{{ riks }}` in display on a bare gated auto step is warned as that step's undeclared path, with no Declare sentence", () => {
    const yaml = `id: bare
name: Bare
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
  confirm_review:
    description: Confirm.
    execution: auto
    trust: human_confirmed
    depends_on: [review]
    display: 'Risk {{ riks }}'
`;
    // (1) red when a "Declare" fix is printed, or the bare step's miss is refused; (2) prints it.
    expect(found(yaml)).toEqual([
      "TEMPLATE_PATH_UNCERTAIN: Step 'confirm_review': display reads 'riks' in '{{ riks }}', which may be missing (step 'confirm_review' does not declare this path), so then the placeholder is shown as nothing. Did you mean 'risk'? (line 19)",
    ]);
  });

  it('check 5: roots — a wrong start with its fix, a bare $settlement with its fix, an undeclared context entry with its did-you-mean, `.raw`, an undeclared `schema` listed, and no name', () => {
    const yaml = `id: roots
name: Roots
version: 1
workflow_context:
  glossary:
    source:
      path: ./glossary.md
    description: Terms.
steps:
  review:
    description: Review.
    execution: agent
    input_schema:
      type: object
      required: [risk]
      properties:
        risk: { type: string }
  approve:
    description: Approve.
    execution: auto
    trust: human_confirmed
    depends_on: [review]
    gate:
      choices: [approve, reject]
      message: 'A {{ name }} B {{ steps.review.output.risk }} C {{ $settlement.review.failed }} D {{ workflow.context.glosary }} E {{ workflow.context.glossary.raw }} F {{ workflow.context.glossary }} G {{ workflow.context.schema }} H {{ workflow.context }}'
`;
    const roots =
      "an approval question reads only 'context.resources.<step>.', 'run.params.' and 'workflow.context.<name>'";
    // (1) red when the root row is skipped, or the `.raw` rule is dropped (E refused); (2) prints them.
    expect({
      found: found(yaml).map((m) => m.split('which can never be found: ')[1]),
      listed: listed(yaml),
    }).toEqual({
      found: [
        `${roots}, so ${GATE_STOPS}. (line 25)`,
        `${roots}, so ${GATE_STOPS}. Write it as 'context.resources.review.risk'. (line 25)`,
        `${roots}, so ${GATE_STOPS}. Write it as 'context.resources.$settlement.review.failed'. (line 25)`,
        `workflow_context declares no entry 'glosary', so ${GATE_STOPS}. Did you mean 'glossary'? (line 25)`,
        `'workflow.context' must be followed by the name of a workflow_context entry, so ${GATE_STOPS}. (line 25)`,
      ],
      listed: [
        {
          surface: 'template',
          step: 'approve',
          key: 'gate.message',
          path: 'workflow.context.schema',
          why: 'added_from_file',
        },
      ],
    });
  });

  it("check 5: the context-entry name rule agrees with the renderer's own (`resolveWorkflowContextRef`)", () => {
    const declared = ['glossary', 'team.notes'];
    const yaml = (path: string) => `id: n
name: N
version: 1
workflow_context:
  glossary: { source: { path: ./g.md } }
  team.notes: { source: { path: ./t.md } }
steps:
  approve:
    description: Approve.
    execution: auto
    trust: human_confirmed
    gate:
      choices: [approve, reject]
      message: '{{ ${path} }}'
`;
    const snapshots = Object.fromEntries(
      declared.map((n) => [n, { name: n, content: 'C', loaded_at: '2026-11-16T00:00:00.000Z' }]),
    );
    const paths = [
      'workflow.context.glossary',
      'workflow.context.glossary.raw',
      'workflow.context.team.notes',
      'workflow.context.team.notes.raw',
      'workflow.context.team',
      'workflow.context.raw',
      'workflow.context.glossary.terms',
    ];
    const rows = paths.map((p) => {
      const rendered = renderTemplate(`{{ ${p} }}`, {
        evidenceByStep: {},
        runParams: {},
        workflowContext: { snapshots: snapshots as never, wrapper: 'xml' },
      });
      return { p, renders: !rendered.includes('{{'), loads: found(yaml(p)).length === 0 };
    });
    // (1) red when the two rules part (e.g. the `.raw` rule dropped); (2) prints each path's two answers.
    expect(rows.filter((r) => r.renders !== r.loads)).toEqual([]);
    expect(rows.map((r) => r.loads)).toEqual([true, true, true, true, false, false, false]);
  });

  it("check 6: display — a closed answer's misspelt name, a required list with a filter, another root, and the step's own path with its fix", () => {
    const handler = `id: h
name: H
version: 1
steps:
  send:
    description: Send.
    execution: auto
    trust: human_confirmed
    handler: send_it
    display: 'P {{ run.params.x }}'
`;
    // (1) red when display names are not judged, or another root is only warned; (2) prints them.
    expect({
      own: found(
        own('ok', 'R {{ riks }} K {{ key_changes | bullets }} S {{ context.resources.ask.risk }}'),
      ),
      handler: found(handler),
    }).toEqual({
      own: [
        "TEMPLATE_PATH_UNRESOLVABLE: Step 'ask': display reads 'riks' in '{{ riks }}', which can never be found: step 'ask' has no field 'riks' there, and its schema allows no other fields, so the placeholder is shown as nothing. Did you mean 'risk'? (line 20)",
        "TEMPLATE_PATH_UNRESOLVABLE: Step 'ask': display reads 'context.resources.ask.risk' in '{{ context.resources.ask.risk }}', which can never be found: display reads only the names of the step's own answer, so the placeholder is shown as nothing. Write it as 'risk'. (line 20)",
      ],
      handler: [
        "TEMPLATE_PATH_UNRESOLVABLE: Step 'send': display reads 'run.params.x' in '{{ run.params.x }}', which can never be found: display reads only the names of the step's own answer, so the placeholder is shown as nothing. (line 10)",
      ],
    });
  });

  it("check 7: no second finding — a placeholder 3a-i reports, and a field that is not text, get only 3a-i's", () => {
    const codes = (yaml: string) => load(yaml).warnings.map((w) => w.code);
    // (1) red when every placeholder is judged here too; (2) prints the codes.
    expect({
      unknown: codes(question('X {{ context.resources.review.riks | shoutloud }}')),
      notText: (() => {
        try {
          return codes(question('x').replace('message: "x"', 'message: 42'));
        } catch (err) {
          return ((err as Error).cause as { warnings?: Array<{ code: string }> }).warnings?.map(
            (w) => w.code,
          );
        }
      })(),
    }).toEqual({ unknown: ['TEMPLATE_FILTER_UNKNOWN'], notText: ['TEMPLATED_FIELD_NOT_TEXT'] });
  });

  it("check 8: a question reading a handler's output is listed; behind all_done it is also refused when `| default` does not fill it", () => {
    const yaml = (rule: string, message: string) => `id: nc
name: NC
version: 1
steps:
  fetch:
    description: Fetch.
    execution: auto
    handler: fetch_it
  approve:
    description: Approve.
    execution: auto
    trust: human_confirmed
    depends_on: [fetch]
${rule}    gate:
      choices: [approve, reject]
      message: ${JSON.stringify(message)}
`;
    const entry = {
      surface: 'template',
      step: 'approve',
      key: 'gate.message',
      path: 'context.resources.fetch.title',
      why: 'producer_declares_no_shape',
    };
    // (1) red when such a reference is not listed, or its step cause is dropped; (2) prints them.
    expect({
      listed: listed(yaml('', 'T {{ context.resources.fetch.title }}')),
      clean: found(yaml('', 'T {{ context.resources.fetch.title }}')),
      allDone: found(
        yaml('    trigger_rule: all_done\n', 'T {{ context.resources.fetch.title }}'),
      ).map((m) => m.split(':')[0]),
      allDoneListed: listed(
        yaml('    trigger_rule: all_done\n', 'T {{ context.resources.fetch.title }}'),
      ),
      allDoneFilled: found(
        yaml(
          '    trigger_rule: all_done\n',
          "T {{ context.resources.fetch.title | default: 'n/a' }}",
        ),
      ),
    }).toEqual({
      listed: [entry],
      clean: [],
      allDone: ['TEMPLATE_PATH_NO_DEFAULT'],
      allDoneListed: [entry],
      allDoneFilled: [],
    });
  });

  it('check 8: a throw while judging one placeholder lists it as check_failed, and the others are judged', () => {
    const real = PathIndex.prototype.shapeOf;
    vi.spyOn(PathIndex.prototype, 'shapeOf').mockImplementation(function (
      this: PathIndex,
      name: string,
    ) {
      if (name === 'boom') throw new Error('planted');
      return real.call(this, name);
    });
    const yaml = `id: cf
name: CF
version: 1
steps:
  boom:
    description: Boom.
    execution: agent
    display: 'B {{ x }}'
  review:
    description: Review.
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      properties:
        risk: { type: string }
    display: 'R {{ riks }}'
`;
    // (1) red when there is no catch (the load throws) or the throw is not listed; (2) prints them.
    expect({
      listed: listed(yaml),
      codes: found(yaml).map((m) => m.split(':')[0]),
    }).toEqual({
      listed: [
        { surface: 'template', step: 'boom', key: 'display', path: 'x', why: 'check_failed' },
      ],
      codes: ['TEMPLATE_PATH_UNRESOLVABLE'],
    });
  });

  it("not judged: a gateless auto step's display, a step without gate trust's question, and `{% %}` tags; a `{{ }}` between them is judged", () => {
    const yaml = `id: nj
name: NJ
version: 1
steps:
  plain:
    description: Plain.
    execution: auto
    display: 'D {{ nope }}'
  ask:
    description: Ask.
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      properties:
        items: { type: array, items: { type: string } }
    display: '{% for i in items %}{{ itemz }}{% endfor %}'
`;
    // (1) red when an unread display is judged, or a `{{ }}` between tags is skipped; (2) prints them.
    expect(found(yaml).map((m) => m.split(' reads ')[0])).toEqual([
      "TEMPLATE_PATH_UNRESOLVABLE: Step 'ask': display",
    ]);
  });

  it("item 7: the field's key line, else the step's — a display taken through a YAML merge key", () => {
    const yaml = `id: m
name: M
version: 1
steps:
  a: &base
    description: A.
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      properties:
        risk: { type: string }
    display: 'R {{ riks }}'
  b:
    <<: *base
    description: B.
`;
    // (1) red when the step-line fallback is removed (b's finding has no line); (2) prints the endings.
    expect(
      load(yaml)
        .warnings.filter((w) => w.code === 'TEMPLATE_PATH_UNRESOLVABLE')
        .map((w) => ({
          step: w.step,
          end: w.message.slice(w.message.lastIndexOf('?') + 1),
          line: w.line,
        })),
    ).toEqual([
      { step: 'a', end: ' (line 13)', line: 13 },
      { step: 'b', end: ' (step at line 14)', line: undefined },
    ]);
  });

  it("correction 1 (a): a bare gated step's own `choice` follows its chain — nothing when its dependency declares it, refused when the dependency's closed answer lacks it", () => {
    const yaml = (declares: boolean) => `id: bc
name: BC
version: 1
steps:
  review:
    description: Review.
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [risk${declares ? ', choice' : ''}]
      properties:
        risk: { type: string }${declares ? '\n        choice: { type: string }' : ''}
  confirm:
    description: Confirm.
    execution: auto
    trust: human_confirmed
    depends_on: [review]
    gate:
      choices: [approve, reject]
      message: 'Chose {{ context.resources.confirm.choice }}'
`;
    // (1) red when the own_choice rule applies whatever the step's shape (as on a1113f46); (2) prints them.
    expect({
      declared: found(yaml(true)),
      lacking: found(yaml(false)).map(
        (m) => m.split(': Step')[0] + ' / ' + m.split('which ')[1]!.split(',')[0],
      ),
    }).toEqual({
      declared: [],
      lacking: [
        "TEMPLATE_PATH_NO_DEFAULT / may be missing when the gate opens (step 'confirm' does not declare this path)",
      ],
    });
  });

  it("correction 1 (b): a gated handler step's own `choice` is listed as not checked, as its other own fields are", () => {
    const yaml = `id: hc
name: HC
version: 1
steps:
  send:
    description: Send.
    execution: auto
    trust: human_confirmed
    handler: send_it
    gate:
      choices: [approve, reject]
      message: 'Chose {{ context.resources.send.choice }} {{ context.resources.send.title }}'
`;
    // (1) red when the own_choice rule applies whatever the step's shape; (2) prints them.
    expect({ found: found(yaml), listed: listed(yaml).map((n) => `${n.path}/${n.why}`) }).toEqual({
      found: [],
      listed: [
        'context.resources.send.choice/producer_declares_no_shape',
        'context.resources.send.title/producer_declares_no_shape',
      ],
    });
  });

  it("correction 1 (d): `{{ workflow }}` alone gets the question's root reason; `{{ workflow.context }}` keeps its own", () => {
    const yaml = (m: string) => `id: w
name: W
version: 1
steps:
  approve:
    description: Approve.
    execution: auto
    trust: human_confirmed
    gate:
      choices: [approve, reject]
      message: '${m}'
`;
    const reason = (m: string) =>
      found(yaml(m)).map((x) => x.split('which can never be found: ')[1]!.split(', so ')[0]);
    // (1) red when `workflow` alone gets the context sentence (as on a1113f46); (2) prints them.
    expect({
      workflow: reason('{{ workflow }}'),
      other: reason('{{ workflow.name }}'),
      context: reason('{{ workflow.context }}'),
    }).toEqual({
      workflow: [
        "an approval question reads only 'context.resources.<step>.', 'run.params.' and 'workflow.context.<name>'",
      ],
      other: [
        "an approval question reads only 'context.resources.<step>.', 'run.params.' and 'workflow.context.<name>'",
      ],
      context: ["'workflow.context' must be followed by the name of a workflow_context entry"],
    });
  });

  it('the default piece, check 5: one parse through the fill check — a bare `default: 0` before round fills; quoted it does not; before `upper` it does not, with the new words', () => {
    const q = (m: string) => found(question(m));
    // (1) red when a reader does not pass the quote flags (the bare 0 read as text: refused); (2)
    // prints the findings.
    expect({
      bare: q('A {{ context.resources.review.amount | default: 0 | round: 2 }}'),
      quoted: q("A {{ context.resources.review.amount | default: '0' | round: 2 }}").map(
        (m) => m.split(':')[0],
      ),
      upper: q('N {{ context.resources.review.notes | default: 0 | upper }}').map(
        (m) => m.split(', so then ')[1],
      ),
    }).toEqual({
      bare: [],
      quoted: ['TEMPLATE_PATH_NO_DEFAULT'],
      upper: [
        "the question shows the placeholder as written. The filters after '| default' give nothing from its value, so its default is never shown. (line 24)",
      ],
    });
  });

  it("input_map's bare `$settlement` gets the same fix (the shared stepFix)", () => {
    const yaml = `id: im
name: IM
version: 1
steps:
  a:
    description: A.
    execution: agent
  b:
    description: B.
    execution: auto
    handler: h
    depends_on: [a]
    input_map:
      failed: $settlement.a.failed
`;
    // (1) red when stepFix gives a bare `$settlement` no fix; (2) prints the message.
    expect(
      load(yaml)
        .warnings.filter((w) => w.code === 'INPUT_MAP_PATH_UNRESOLVABLE')
        .map((w) => w.message),
    ).toEqual([
      "Step 'b': input_map 'failed' reads '$settlement.a.failed', which can never be found: a path starts with 'run.params.' or 'context.resources.<step>.'. Write it as 'context.resources.$settlement.a.failed'. (line 14)",
    ]);
  });
});
