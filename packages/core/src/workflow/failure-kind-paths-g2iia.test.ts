// failure-kind-paths-g2iia.test.ts — gap 2, unit (ii-a): the loader admits
// `$settlement.<step>.failure_kind` in a template, an `input_map` and a `when`, and judges it may be
// absent: it is set only when the step's model request failed and the step took its failure path. A
// template or `input_map` read without `| default` gets the findings an absent value gets; a `when`
// gets none (absent reads null). Each refusal sentence lists the field. Every cell loads a file with
// `loadWorkflowFromStringWithDiagnostics`.
//
// Each assertion carries (a) the change that turns it red and (b) what it prints when it fails.
import { describe, it, expect } from 'vitest';
import { loadWorkflowFromStringWithDiagnostics } from './yaml-loader.js';

const CODES = new Set([
  'TEMPLATE_PATH_UNRESOLVABLE',
  'TEMPLATE_PATH_NO_DEFAULT',
  'TEMPLATE_PATH_UNCERTAIN',
  'INPUT_MAP_PATH_UNRESOLVABLE',
  'INPUT_MAP_PATH_UNCERTAIN',
  'WHEN_PATH_UNRESOLVABLE',
  'WHEN_PATH_UNCERTAIN',
]);

/** The path findings of `yaml` as `code: message`, the file loaded (never refused). */
function found(yaml: string): string[] {
  let loaded;
  try {
    loaded = loadWorkflowFromStringWithDiagnostics(yaml);
  } catch (err) {
    throw new Error(`refused: ${(err as Error).message}`, { cause: err });
  }
  return loaded.warnings.filter((w) => CODES.has(w.code)).map((w) => `${w.code}: ${w.message}`);
}

/** The 1-based line of the first line of `yaml` containing `text`. */
const lineOf = (yaml: string, text: string): number =>
  yaml.split('\n').findIndex((l) => l.includes(text)) + 1;

/** `classify` (`dep`, an agent step by default), then `notify`, which runs only after it failed. */
const workflow = (notify: string, dep = '    execution: agent\n'): string => `id: fk
name: FK
version: 1
steps:
  classify:
    description: Classify.
${dep}  notify:
    description: Tell someone.
    depends_on: [classify]
    trigger_rule: one_failed
${notify}`;

const gate = (message: string): string =>
  `    execution: auto\n    trust: human_confirmed\n    gate:\n      choices: [ok]\n      message: ${JSON.stringify(message)}\n`;

// Gap 2, unit (iii), Words 7: the reason names the key, which `default` also takes.
const WHY =
  "'failure_kind' is set only when step 'classify''s model request failed and the step has " +
  'on_model_failure';

describe('gap 2, unit (ii-a) — the loader judges failure_kind may be absent (check 8)', () => {
  it('a gate message reading it without | default is refused TEMPLATE_PATH_NO_DEFAULT', () => {
    const yaml = workflow(
      gate('Failed: {{ context.resources.$settlement.classify.failure_kind }}'),
    );
    // (a) red when the field is judged found (no finding); (b) prints the findings.
    expect(found(yaml)).toEqual([
      "TEMPLATE_PATH_NO_DEFAULT: Step 'notify': gate.message reads " +
        "'context.resources.$settlement.classify.failure_kind' in '{{ context.resources.$settlement.classify.failure_kind }}', which may " +
        `be missing when the gate opens (${WHY}), so then the gate does not open, and the run stays open with the step not done. ` +
        "Add '| default: <value>' as its first filter, keeping after it only filters that take " +
        `that value. (line ${lineOf(yaml, 'message:')})`,
    ]);
  });

  it('with | default it loads with no finding', () => {
    const yaml = workflow(
      gate(
        "Failed: {{ context.resources.$settlement.classify.failure_kind | default: 'unknown' }}",
      ),
    );
    // (a) red when '| default' is not taken as filling it; (b) prints the findings.
    expect(found(yaml)).toEqual([]);
  });

  it('an input_map read gets INPUT_MAP_PATH_UNCERTAIN, and the file loads', () => {
    const yaml = workflow(
      '    execution: auto\n    handler: h\n    input_map:\n      kind: context.resources.$settlement.classify.failure_kind\n',
    );
    // (a) red when the field is judged found, or refused; (b) prints the findings.
    expect(found(yaml)).toEqual([
      "INPUT_MAP_PATH_UNCERTAIN: Step 'notify': input_map 'kind' reads " +
        "'context.resources.$settlement.classify.failure_kind', which may be absent when this step " +
        `runs (${WHY}); the step then receives no value for 'kind'. (line ${lineOf(yaml, 'kind: ')})`,
    ]);
  });

  it('a when reading it gets no finding', () => {
    const yaml = workflow(
      '    execution: auto\n    handler: h\n    when: "$settlement.classify.failure_kind == \'transient\'"\n',
    );
    // (a) red when a when gets the may-be-absent finding; (b) prints the findings.
    expect(found(yaml)).toEqual([]);
  });

  it('a read on a step that is not an agent step gets the same finding (Amendment 2)', () => {
    const yaml = workflow(
      gate('Failed: {{ context.resources.$settlement.classify.failure_kind }}'),
      '    execution: auto\n    handler: h\n',
    );
    // (a) red when such a read is judged another way; (b) prints the codes.
    expect(found(yaml).map((f) => f.split(':')[0])).toEqual(['TEMPLATE_PATH_NO_DEFAULT']);
  });
});

describe('gap 2, unit (ii-a) — each refusal sentence lists failure_kind (check 8, Words 1)', () => {
  // Gap 2, unit (iv-a1), Words 3: the sentences now list 'message' too.
  const HOLDS =
    "'$settlement.classify' holds only 'failed', 'settled_by_default', 'validation_rejections', " +
    "'failure_kind' and 'message'";

  it('a template', () => {
    const yaml = workflow(
      gate("{{ context.resources.$settlement.classify.failur_kind | default: 'x' }}"),
    );
    // (a) red when the sentence lists the old three; (b) prints the finding.
    expect(found(yaml)).toEqual([
      "TEMPLATE_PATH_UNRESOLVABLE: Step 'notify': gate.message reads " +
        "'context.resources.$settlement.classify.failur_kind' in '{{ context.resources.$settlement.classify.failur_kind | default: 'x' }}', " +
        `which can never be found: ${HOLDS}, so the question always shows what '| default' gives. ` +
        `Did you mean 'failure_kind'? (line ${lineOf(yaml, 'message:')})`,
    ]);
  });

  it('an input_map', () => {
    const yaml = workflow(
      '    execution: auto\n    handler: h\n    input_map:\n      kind: context.resources.$settlement.classify.failur_kind\n',
    );
    // (a) red when the sentence lists the old three; (b) prints the finding.
    expect(found(yaml)).toEqual([
      "INPUT_MAP_PATH_UNRESOLVABLE: Step 'notify': input_map 'kind' reads " +
        "'context.resources.$settlement.classify.failur_kind', but " +
        `${HOLDS}. Did you mean 'failure_kind'? (line ${lineOf(yaml, 'kind: ')})`,
    ]);
  });

  it('a when', () => {
    const yaml = workflow(
      '    execution: auto\n    handler: h\n    when: "$settlement.classify.failur_kind == \'x\'"\n',
    );
    // (a) red when the sentence lists the old three; (b) prints the finding.
    expect(found(yaml).map((f) => f.includes(`${HOLDS}.`))).toEqual([true]);
  });
});
