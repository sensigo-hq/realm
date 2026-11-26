// Fix 1, piece 2a — a `when` condition checked against what the workflow declares, on the loader
// (`loadWorkflowFromStringWithDiagnostics`). The command cells (validate's exit and lines, register,
// run, the docs) are in the CLI's validate-when-paths.test.ts.
//
// Each cell names the break that turns it red (prompts/ai-authoring-fix1-u2a-when.md).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkflowError } from '../types/workflow-error.js';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';
import { PathIndex } from './path-resolver.js';

const OURS = new Set(['WHEN_PATH_UNRESOLVABLE', 'WHEN_CHOICE_NOT_OFFERED', 'WHEN_PATH_UNCERTAIN']);

/** The loader's `when` findings for `yaml` (`code: message`), and its not-checked list. */
function findings(yaml: string) {
  const { warnings, notChecked } = loadWorkflowFromStringWithDiagnostics(yaml);
  return {
    when: warnings.filter((w) => OURS.has(w.code)).map((w) => `${w.code}: ${w.message}`),
    notChecked,
  };
}

/** The `when` findings, once every leaf was judged: none is left not checked. */
function judged(yaml: string): string[] {
  const { when, notChecked } = findings(yaml);
  expect(notChecked).toEqual([]);
  return when;
}

/** A load that the loader refuses: its errors, and the `when` findings riding the refusal. */
function refused(yaml: string): { errors: readonly string[]; when: string[] } {
  try {
    loadWorkflowFromStringWithDiagnostics(yaml);
  } catch (err) {
    expect(err).toBeInstanceOf(WorkflowError);
    const e = err as WorkflowError;
    return {
      errors: e.errors ?? [],
      when: (e.warnings ?? [])
        .filter((w) => OURS.has(w.code))
        .map((w) => `${w.code}: ${w.message}`),
    };
  }
  throw new Error('expected the loader to refuse the file');
}

/** The 1-based line of the first line of `yaml` that contains `needle`. */
function lineOf(yaml: string, needle: string): number {
  const index = yaml.split('\n').findIndex((l) => l.includes(needle));
  if (index < 0) throw new Error(`fixture has no line with ${needle}`);
  return index + 1;
}

function wf(steps: string, top = ''): string {
  return `id: w\nname: W\nversion: 1\n${top}steps:\n${steps}`;
}

/** An agent step `classify` with a closed answer: `category` (required) and `urgent` (optional). */
const CLASSIFY = `  classify:
    description: classify
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
        urgent: { type: boolean }
`;

/** A handler step `act` after `deps`, with `when: <leaf>` and optional extra lines. */
function act(leaf: string, deps = 'classify', extra = ''): string {
  return `  act:
    description: act
    execution: auto
    handler: h
    depends_on: [${deps}]
${extra}    when: "${leaf}"
`;
}

/** A handler step `name` (it declares no shape). */
const handler = (name: string): string =>
  `  ${name}:\n    description: ${name}\n    execution: auto\n    handler: h\n`;

/** A gated handler step `approve`, with `choices` when given. */
function approve(choices?: string): string {
  return `  approve:
    description: approve
    execution: auto
    handler: h
    trust: human_confirmed
${choices !== undefined ? `    gate:\n      choices: [${choices}]\n` : ''}`;
}

const NEVER = 'This condition is never true, so the step is always skipped.';
const ALWAYS = 'This condition is always true, so it never skips the step.';
const at = (yaml: string): string => `(line ${lineOf(yaml, 'when: ')})`;
const absent = (leaf: string, path: string, why: string, yaml: string): string =>
  `WHEN_PATH_UNCERTAIN: Step 'act': when '${leaf}' reads '${path}', which may be absent when this ` +
  `condition is read (${why}); the condition is then false, and the step is skipped. ${at(yaml)}`;

describe('piece 2a — check 1: a misspelt field at a closed answer', () => {
  it("`classify.categry == 'bug'`: refused, the field reason, \"Did you mean 'category'?\" and the `when` key's line", () => {
    const yaml = wf(CLASSIFY + act("classify.categry == 'bug'"));
    // (1) red when `when` leaves are not judged; (2) prints both.
    expect(judged(yaml)).toEqual([
      "WHEN_PATH_UNRESOLVABLE: Step 'act': when 'classify.categry == 'bug'' reads " +
        "'classify.categry', which can never be found: step 'classify' has no field 'categry' " +
        `there, and its schema allows no other fields. ${NEVER} Did you mean 'category'? ${at(yaml)}`,
    ]);
  });

  it('the structured channel: code, severity, step, key `when`, the key position, did_you_mean', () => {
    const yaml = wf(CLASSIFY + act("classify.categry == 'bug'"));
    const w = loadWorkflowFromStringWithDiagnostics(yaml).warnings.find(
      (x) => x.code === 'WHEN_PATH_UNRESOLVABLE',
    );
    // (1) red when the finding loses its key or position; (2) prints it.
    expect({
      severity: w?.severity,
      scope: w?.scope,
      step: w?.step,
      key: w?.key,
      line: w?.line,
      did_you_mean: w?.did_you_mean,
    }).toEqual({
      severity: 'error',
      scope: 'step',
      step: 'act',
      key: 'when',
      line: lineOf(yaml, 'when: '),
      did_you_mean: 'category',
    });
  });

  it("a list of leaves: every finding cites the `when` key's line (a list item has no position)", () => {
    const yaml = wf(
      CLASSIFY +
        `  act:
    description: act
    execution: auto
    handler: h
    depends_on: [classify]
    when:
      - "classify.category == 'bug'"
      - "classify.categry == 'bug'"
`,
    );
    // (1) red when a list leaf cites another line or none; (2) prints both.
    expect(judged(yaml)).toEqual([
      "WHEN_PATH_UNRESOLVABLE: Step 'act': when 'classify.categry == 'bug'' reads " +
        "'classify.categry', which can never be found: step 'classify' has no field 'categry' " +
        `there, and its schema allows no other fields. ${NEVER} Did you mean 'category'? ` +
        `(line ${lineOf(yaml, 'when:')})`,
    ]);
  });
});

describe('piece 2a — check 2: the consequence by operator', () => {
  const never = (leaf: string, yaml: string, consequence: string): string =>
    `WHEN_PATH_UNRESOLVABLE: Step 'act': when '${leaf}' reads 'classify.categry', which can never ` +
    `be found: step 'classify' has no field 'categry' there, and its schema allows no other ` +
    `fields. ${consequence} Did you mean 'category'? ${at(yaml)}`;

  it('`== null` on a path that is never found: always true', () => {
    const yaml = wf(CLASSIFY + act('classify.categry == null'));
    // (1) red when every form gets one consequence; (2) prints both.
    expect(judged(yaml)).toEqual([never('classify.categry == null', yaml, ALWAYS)]);
  });

  it('`!= null`: never true', () => {
    const yaml = wf(CLASSIFY + act('classify.categry != null'));
    // (1) red when `!= null` is read as a presence test that passes; (2) prints both.
    expect(judged(yaml)).toEqual([never('classify.categry != null', yaml, NEVER)]);
  });

  it('a bare path: never true', () => {
    const yaml = wf(CLASSIFY + act('classify.categry'));
    // (1) red when a bare path gets the always-true words; (2) prints both.
    expect(judged(yaml)).toEqual([never('classify.categry', yaml, NEVER)]);
  });
});

describe('piece 2a — check 3: `$settlement` and params', () => {
  it('`$settlement.extract.faild == true`: refused, "Did you mean \'failed\'?"', () => {
    const yaml = wf(handler('extract') + act('$settlement.extract.faild == true', 'extract'));
    // (1) red when the `when` check skips leaves that start with `$settlement`; (2) prints both.
    expect(judged(yaml)).toEqual([
      "WHEN_PATH_UNRESOLVABLE: Step 'act': when '$settlement.extract.faild == true' reads " +
        "'$settlement.extract.faild', which can never be found: '$settlement.extract' holds only " +
        `'failed', 'settled_by_default', 'validation_rejections', 'failure_kind' and 'message'. ${NEVER} Did you mean ` +
        `'failed'? ${at(yaml)}`,
    ]);
  });

  it("`run.params.ordr_id == 'x'` with a closed params_schema: refused, \"Did you mean 'order_id'?\"", () => {
    const yaml = wf(
      handler('fetch') + act("run.params.ordr_id == 'x'", 'fetch'),
      'params_schema:\n  type: object\n  additionalProperties: false\n  properties:\n    order_id: { type: string }\n',
    );
    // (1) red when params leaves are not judged; (2) prints both.
    expect(judged(yaml)).toEqual([
      "WHEN_PATH_UNRESOLVABLE: Step 'act': when 'run.params.ordr_id == 'x'' reads " +
        "'run.params.ordr_id', which can never be found: params_schema has no parameter " +
        `'ordr_id' and allows no others. ${NEVER} Did you mean 'order_id'? ${at(yaml)}`,
    ]);
  });
});

describe('piece 2a — check 4: a choice the gate does not offer', () => {
  const notOffered = (
    leaf: string,
    x: string,
    choices: string,
    tail: string,
    dym: string,
    yaml: string,
  ): string =>
    `WHEN_CHOICE_NOT_OFFERED: Step 'act': when '${leaf}' compares 'approve.choice' with '${x}', ` +
    `which is not one of the choices step 'approve' offers (${choices}). ${tail} Did you mean ` +
    `'${dym}'? ${at(yaml)}`;

  it("`approve.choice == 'refnd'` against [refund, deny]: refused, \"Did you mean 'refund'?\"", () => {
    const yaml = wf(approve('refund, deny') + act("approve.choice == 'refnd'", 'approve'));
    // (1) red when the literal is not compared with the gate's choices; (2) prints both.
    expect(judged(yaml)).toEqual([
      notOffered("approve.choice == 'refnd'", 'refnd', 'refund, deny', NEVER, 'refund', yaml),
    ]);
  });

  it("`!= 'refnd'`: refused with the `!=` words", () => {
    const yaml = wf(approve('refund, deny') + act("approve.choice != 'refnd'", 'approve'));
    // (1) red when `!=` gets the never-true words, or is let through; (2) prints both.
    expect(judged(yaml)).toEqual([
      notOffered(
        "approve.choice != 'refnd'",
        'refnd',
        'refund, deny',
        'This condition is true whenever the gate has been answered, so it does not test the choice.',
        'refund',
        yaml,
      ),
    ]);
  });

  it('the unquoted `== refnd` is refused too (the engine reads a bare word as a string)', () => {
    const yaml = wf(approve('refund, deny') + act('approve.choice == refnd', 'approve'));
    // (1) red when the right-hand side is not parsed as the engine parses it; (2) prints both.
    expect(judged(yaml)).toEqual([
      notOffered('approve.choice == refnd', 'refnd', 'refund, deny', NEVER, 'refund', yaml),
    ]);
  });

  it("control: `== 'refund'` gets no finding", () => {
    // (1) red when an offered choice is refused; (2) prints both.
    expect(
      judged(wf(approve('refund, deny') + act("approve.choice == 'refund'", 'approve'))),
    ).toEqual([]);
  });

  it("no declared choices: `== 'aprove'` is refused, \"Did you mean 'approve'?\" (the default choices)", () => {
    const yaml = wf(approve() + act("approve.choice == 'aprove'", 'approve'));
    // (1) red when the default choices are not read; (2) prints both.
    expect(judged(yaml)).toEqual([
      notOffered("approve.choice == 'aprove'", 'aprove', 'approve, reject', NEVER, 'approve', yaml),
    ]);
  });

  it("choices only from the answer's `choice` enum [ship, hold]: `== 'shp'` is refused, \"Did you mean 'ship'?\"", () => {
    const yaml = wf(
      `  approve:
    description: approve
    execution: agent
    trust: human_confirmed
    input_schema:
      type: object
      additionalProperties: false
      required: [choice]
      properties:
        choice: { type: string, enum: [ship, hold] }
` + act("approve.choice == 'shp'", 'approve'),
    );
    // (1) red when the literal is compared with `gate.choices` or the default list only, not
    //     `gateChoicesOf`; (2) prints both.
    expect(judged(yaml)).toEqual([
      notOffered("approve.choice == 'shp'", 'shp', 'ship, hold', NEVER, 'ship', yaml),
    ]);
  });

  it("under `trigger_rule: all_done`, `approve.choice == 'refnd'` gets the refusal alone", () => {
    const yaml = wf(
      approve('refund, deny') +
        act("approve.choice == 'refnd'", 'approve', '    trigger_rule: all_done\n'),
    );
    // (1) red when the trigger-rule warning is given for a leaf this rule refuses; (2) prints both.
    expect(judged(yaml)).toEqual([
      notOffered("approve.choice == 'refnd'", 'refnd', 'refund, deny', NEVER, 'refund', yaml),
    ]);
  });
});

describe('piece 2a — check 5: `choice` read from a step that opens no gate', () => {
  const WHY = (s: string): string =>
    `only a gate's answer carries 'choice', and step '${s}' opens no gate`;

  it('a closed answer without `choice`: refused with that reason', () => {
    const yaml = wf(CLASSIFY + act("classify.choice == 'x'"));
    // (1) red when the gate flag is ignored for a step that opens no gate (the field reason);
    //     (2) prints both.
    expect(judged(yaml)).toEqual([
      "WHEN_PATH_UNRESOLVABLE: Step 'act': when 'classify.choice == 'x'' reads 'classify.choice', " +
        "which can never be found: only a gate's answer carries 'choice', step 'classify' opens no " +
        `gate, and its schema allows no other fields. ${NEVER} ${at(yaml)}`,
    ]);
  });

  it('an open answer: the warning with that reason', () => {
    const yaml = wf(
      `  classify:
    description: classify
    execution: agent
    input_schema:
      type: object
      properties:
        category: { type: string }
` + act("classify.choice == 'x'"),
    );
    // (1) red when the gate flag is ignored ("does not declare it"); (2) prints both.
    expect(judged(yaml)).toEqual([
      absent("classify.choice == 'x'", 'classify.choice', WHY('classify'), yaml),
    ]);
  });

  it('a handler step: the warning with that reason, in place of the not-checked listing', () => {
    const yaml = wf(handler('fetch') + act("fetch.choice == 'x'", 'fetch'));
    // (1) red when the leaf is listed as not checked instead; (2) prints both.
    expect(judged(yaml)).toEqual([
      absent("fetch.choice == 'x'", 'fetch.choice', WHY('fetch'), yaml),
    ]);
  });

  it('twin: a closed answer that opens no gate but requires `choice` gets no finding', () => {
    const yaml = wf(
      `  classify:
    description: classify
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [choice]
      properties:
        choice: { type: string }
` + act("classify.choice == 'x'"),
    );
    // (1) red when the reason is given whatever the resolver found; (2) prints both.
    expect(judged(yaml)).toEqual([]);
  });

  const BARE_OVER_GATE = `  review:
    description: review
    execution: agent
    trust: human_confirmed
    input_schema:
      type: object
      additionalProperties: false
      required: [text]
      properties:
        text: { type: string }
  copy:
    description: copy
    execution: auto
    depends_on: [review]
`;

  it('a bare step with no gate of its own, over a gated agent step whose answer is closed: the warning with that reason', () => {
    const yaml = wf(BARE_OVER_GATE + act("copy.choice == 'approve'", 'copy'));
    // (1) red when `choice` is found through a bare step's chain (as on the base); (2) prints both.
    expect(judged(yaml)).toEqual([
      absent("copy.choice == 'approve'", 'copy.choice', WHY('copy'), yaml),
    ]);
  });

  it("unit 1's `input_map` read of that bare step's `choice` gets unit 1's may-be-absent warning", () => {
    const yaml = wf(
      BARE_OVER_GATE +
        `  act:
    description: act
    execution: auto
    handler: h
    depends_on: [copy]
    input_map:
      decision: context.resources.copy.choice
`,
    );
    const { warnings } = loadWorkflowFromStringWithDiagnostics(yaml);
    // (1) red when `choice` is found through a bare step's chain (as on the base: no warning);
    //     (2) prints both.
    expect(
      warnings.filter((w) => w.code.startsWith('INPUT_MAP_PATH_')).map((w) => w.message),
    ).toEqual([
      "Step 'act': input_map 'decision' reads 'context.resources.copy.choice', which step 'copy' " +
        "does not declare; the step receives no value for 'decision' unless the output happens to " +
        `carry it. (line ${lineOf(yaml, 'decision: ')})`,
    ]);
  });
});

describe('piece 2a — check 6: a value that may be absent', () => {
  it('an optional field `classify.urgent == true`: the warning', () => {
    const yaml = wf(CLASSIFY + act('classify.urgent == true'));
    // (1) red when an optional field is not warned; (2) prints both.
    expect(judged(yaml)).toEqual([
      absent(
        'classify.urgent == true',
        'classify.urgent',
        "'urgent' is optional in its schema",
        yaml,
      ),
    ]);
  });

  it.each(['classify.urgent == null', 'classify.urgent != null'])(
    '`%s` tests presence on purpose: no warning',
    (leaf) => {
      // (1) red when the presence-test exemption is missing; (2) prints both.
      expect(judged(wf(CLASSIFY + act(leaf)))).toEqual([]);
    },
  );
});

describe("piece 2a — check 7: the reader's trigger rule", () => {
  it("`trigger_rule: none_failed` over `classify`, reading a required field: the warning with row 9's words", () => {
    const yaml = wf(
      CLASSIFY + act("classify.category == 'bug'", 'classify', '    trigger_rule: none_failed\n'),
    );
    // (1) red when `when` leaves get no step cause; (2) prints both.
    expect(judged(yaml)).toEqual([
      absent(
        "classify.category == 'bug'",
        'classify.category',
        "this step's trigger_rule lets it run when 'classify' did not complete",
        yaml,
      ),
    ]);
  });

  it('control: under the default rule, no finding', () => {
    // (1) red when an `all_success` reader is warned; (2) prints both.
    expect(judged(wf(CLASSIFY + act("classify.category == 'bug'")))).toEqual([]);
  });

  it("the docs' example: `all_done` over [extract, transform] reading `$settlement.extract.failed == true`: no finding", () => {
    const yaml = wf(
      handler('extract') +
        handler('transform') +
        act(
          '$settlement.extract.failed == true',
          'extract, transform',
          '    trigger_rule: all_done\n',
        ),
    );
    // (1) red when the `$settlement` exemption is removed; (2) prints both.
    expect(judged(yaml)).toEqual([]);
  });
});

describe('piece 2a — check 8: not checked', () => {
  it("a condition on a handler's output is listed with `surface: when`, `key: when`; unit 1's entries carry `surface: input_map`", () => {
    const yaml = wf(
      handler('fetch') +
        `  act:
    description: act
    execution: auto
    handler: h
    depends_on: [fetch]
    when: 'fetch.total > 10'
    input_map:
      amount: context.resources.fetch.total
`,
    );
    // (1) red when `when` leaves are not listed; (2) prints both.
    expect(findings(yaml)).toEqual({
      when: [],
      notChecked: [
        {
          surface: 'input_map',
          step: 'act',
          key: 'amount',
          path: 'context.resources.fetch.total',
          why: 'producer_declares_no_shape',
        },
        {
          surface: 'when',
          step: 'act',
          key: 'when',
          path: 'fetch.total',
          why: 'producer_declares_no_shape',
        },
      ],
    });
  });
});

describe('piece 2a — check 9: no second finding', () => {
  it('`steps.x.f == 1` (outside depends_on) gives exactly the existing refusal', () => {
    // `steps` names no step, so the resolver would give no finding even if this leaf were judged;
    // the next cell is the one a judged leaf turns red.
    expect(refused(wf(CLASSIFY + act('steps.x.f == 1')))).toEqual({
      errors: [
        "Step 'act': 'when' references step 'steps' which is not in its depends_on [classify]. Add it to depends_on or use 'run.params.*'. (step at line 15)",
      ],
      when: [],
    });
  });

  it('a misspelt field of a step outside depends_on gives exactly the existing refusal', () => {
    const yaml = wf(CLASSIFY + handler('other') + act("classify.categry == 'bug'", 'other'));
    // (1) red when every leaf is judged (a second, field finding); (2) prints both.
    expect(refused(yaml)).toEqual({
      errors: [
        `Step 'act': 'when' references step 'classify' which is not in its depends_on [other]. Add it to depends_on or use 'run.params.*'. (step at line ${lineOf(yaml, '  act:')})`,
      ],
      when: [],
    });
  });

  it('a gated step reading its own `choice` (a self dependency) gets no finding from this check', () => {
    const yaml = wf(
      `  approve:
    description: approve
    execution: auto
    handler: h
    trust: human_confirmed
    depends_on: [approve]
    when: "approve.choice == 'nope'"
`,
    );
    const r = refused(yaml);
    // (1) red when a leaf reading its own step is judged (the choice refusal); (2) prints both.
    expect({ refused: r.errors.length > 0, when: r.when }).toEqual({ refused: true, when: [] });
  });

  it("a finalizer's `when` gives only its existing refusal", () => {
    // A `run.params` read, so the leaf passes the depends_on check and only the finalizer rule
    // keeps it out of this check.
    const yaml = wf(
      handler('fetch') +
        `  wrap_up:
    description: wrap up
    execution: finalizer
    handler: h
    on_outcome: always
    when: "run.params.ordr_id == 'x'"
`,
      'params_schema:\n  type: object\n  additionalProperties: false\n  properties:\n    order_id: { type: string }\n',
    );
    const r = refused(yaml);
    // (1) red when every leaf is judged, a finalizer's included (a second, params finding);
    //     (2) prints both.
    expect({
      errors: r.errors.map((e) =>
        e.startsWith("Step 'wrap_up': 'when' is not valid on execution: finalizer"),
      ),
      when: r.when,
    }).toEqual({
      errors: [true],
      when: [],
    });
  });

  it("GROUNDING: `$settlement.extract.failed == true` under `none_failed` gives only #362's finding", () => {
    const r = refused(
      wf(
        handler('extract') +
          act('$settlement.extract.failed == true', 'extract', '    trigger_rule: none_failed\n'),
      ),
    );
    // Not acceptance: the `$settlement` exemption keeps it single, so "every leaf judged" cannot
    // turn it red (the prompt's check 9).
    expect({ errors: r.errors.map((e) => e.includes('can never be true')), when: r.when }).toEqual({
      errors: [true],
      when: [],
    });
  });
});

describe('piece 2a — check 10: one index, and never a stopped load', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const MIXED = wf(
    CLASSIFY +
      `  act:
    description: act
    execution: auto
    handler: h
    depends_on: [classify]
    when: "classify.category == 'bug'"
    input_map:
      kind: context.resources.classify.category
  bad:
    description: bad
    execution: auto
    handler: h
    depends_on: [classify]
    when: "classify.urgent == true"
  later:
    description: later
    execution: auto
    handler: h
    depends_on: [classify]
    when: "classify.categry == 'bug'"
`,
  );

  it('the `when` and `input_map` leaves of one file are judged over one PathIndex', () => {
    const indexes = new Set<PathIndex>();
    const original = PathIndex.prototype.stepCause;
    const readers: string[] = [];
    vi.spyOn(PathIndex.prototype, 'stepCause').mockImplementation(function (
      this: PathIndex,
      reader: string,
      s: string,
      settlement: boolean,
    ) {
      indexes.add(this);
      readers.push(reader);
      return original.call(this, reader, s, settlement);
    });
    loadWorkflowFromStringWithDiagnostics(MIXED);
    // (1) red when a second index is built for `when`; (2) prints the count and the readers.
    expect({ indexes: indexes.size, readers }).toEqual({
      indexes: 1,
      readers: ['act', 'act', 'bad'],
    });
  });

  it('a throw while judging a `when` leaf lists it as `check_failed`; the load succeeds and the others keep their findings', () => {
    const original = PathIndex.prototype.stepCause;
    vi.spyOn(PathIndex.prototype, 'stepCause').mockImplementation(function (
      this: PathIndex,
      reader: string,
      s: string,
      settlement: boolean,
    ) {
      if (reader === 'bad') throw new Error('planted: a bug in the when check');
      return original.call(this, reader, s, settlement);
    });
    // (1) red when there is no catch around a `when` leaf (the load throws), or when the `when`
    //     loop stops at the first leaf it failed on (`later`'s finding is lost); (2) prints both.
    expect(findings(MIXED)).toEqual({
      when: [
        "WHEN_PATH_UNRESOLVABLE: Step 'later': when 'classify.categry == 'bug'' reads " +
          "'classify.categry', which can never be found: step 'classify' has no field 'categry' " +
          `there, and its schema allows no other fields. ${NEVER} Did you mean 'category'? ` +
          `(line ${lineOf(MIXED, `when: "classify.categry`)})`,
      ],
      notChecked: [
        { surface: 'when', step: 'bad', key: 'when', path: 'classify.urgent', why: 'check_failed' },
      ],
    });
  });
});
