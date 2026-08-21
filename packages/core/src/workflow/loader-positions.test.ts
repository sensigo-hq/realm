// loader-positions.test.ts — issue #392: positions on the WARNINGS CHANNEL, where an agent reads
// them as data rather than parsing them back out of prose.
//
// TWINS (the lesson is two PRs old): #170 flipped two codes and every cell outside the policy
// table drove only one of them. The same set applies here — workflow-level and step-level unknown
// keys are separate call sites with separate paths — so each gets its own cell at each layer.
//
// FIXTURE RULE: every fixture below asserts its own text at the line it claims, so a template
// literal's leading newline (which shifts every line by one) cannot make a cell agree with a
// wrong number.
import { describe, it, expect, vi } from 'vitest';
import { loadWorkflowFromStringWithDiagnostics, loadWorkflowFromString } from './yaml-loader.js';

/** Asserts the fixture genuinely holds `text` at `line` — the defence against a shifted count. */
function assertSourceLine(src: string, line: number, text: string): void {
  expect(src.split('\n')[line - 1]).toContain(text);
}

describe('#392 — the structured channel carries the full range', () => {
  const WF = `id: positions-wf
name: Positions WF
version: 1
descriptoin: a top-level typo
steps:
  step_one:
    description: First step
    execution: auto
    dependson: [nothing]
`;

  it('TWIN 1 — a workflow-level unknown key carries all four coordinates', () => {
    assertSourceLine(WF, 4, 'descriptoin:');
    const { warnings } = loadWorkflowFromStringWithDiagnostics(WF);
    const w = warnings.find((x) => x.code === 'UNKNOWN_WORKFLOW_KEY');
    expect(w).toBeDefined();
    // Asserted as one object: all four or none is the contract, and four separate expects would
    // let a partial position pass three of them.
    expect({
      line: w?.line,
      column: w?.column,
      endLine: w?.endLine,
      endColumn: w?.endColumn,
    }).toEqual({ line: 4, column: 1, endLine: 4, endColumn: 12 });
  });

  it('TWIN 2 — a step-level unknown key carries all four, at its own indentation', () => {
    assertSourceLine(WF, 9, 'dependson:');
    const { warnings } = loadWorkflowFromStringWithDiagnostics(WF);
    const w = warnings.find((x) => x.code === 'UNKNOWN_STEP_KEY');
    expect({
      line: w?.line,
      column: w?.column,
      endLine: w?.endLine,
      endColumn: w?.endColumn,
    }).toEqual({ line: 9, column: 5, endLine: 9, endColumn: 14 });
  });

  it('the prose carries the START line only — humans do not read ranges', () => {
    const { warnings } = loadWorkflowFromStringWithDiagnostics(WF);
    for (const w of warnings) {
      expect(w.message).toContain(`(line ${String(w.line)})`);
      // The range is on the structured channel and nowhere in the sentence.
      expect(w.message).not.toContain(`${String(w.line)}:${String(w.column)}`);
    }
  });

  it('the position is spliced BEFORE the "— ignored" clause, leaving that anchor intact', () => {
    // The CLI's #170 refusal substitution rewrites "— ignored" at print time. If the position
    // landed after that anchor, the two edits would be fighting over the same span.
    const { warnings } = loadWorkflowFromStringWithDiagnostics(WF);
    const w = warnings.find((x) => x.code === 'UNKNOWN_STEP_KEY');
    expect(w?.message).toBe(
      "step 'step_one': unknown key 'dependson' (line 9) — ignored (did you mean 'depends_on'?)",
    );
  });

  it('a key containing an em-dash cannot garble the splice', () => {
    // The insertion is anchored on the key's closing quote, not on the first ' — ' in the string,
    // so a key that itself contains an em-dash still gets exactly one position, in the right place.
    const odd = `id: em-dash-wf
name: Em Dash
version: 1
"we — ird": true
steps:
  step_one:
    description: First step
    execution: auto
`;
    const { warnings } = loadWorkflowFromStringWithDiagnostics(odd);
    const w = warnings.find((x) => x.key === 'we — ird');
    expect(w?.message).toContain(`'we — ird' (line 4) — ignored`);
    expect(w?.message.match(/\(line 4\)/g)).toHaveLength(1);
  });
});

describe('#392 — the unresolvable branch renders exactly as it did before', () => {
  it('a key the map cannot place carries NO position and the byte-identical old message', () => {
    // A merge key makes the step's mapping unpairable, so the position map refuses the whole
    // mapping — which is the branch that has to degrade to the pre-#392 output rather than to a
    // guess. Asserted as full equality: this is the "byte-identical" claim.
    const src = `id: unplaceable-wf
name: Unplaceable
version: 1
defaults: &d
  execution: auto
steps:
  step_one:
    <<: *d
    description: First step
    dependson: [nothing]
`;
    const { warnings } = loadWorkflowFromStringWithDiagnostics(src);
    const w = warnings.find((x) => x.key === 'dependson');
    expect(w).toBeDefined();
    expect(w?.line).toBeUndefined();
    expect(w?.column).toBeUndefined();
    expect(w?.endLine).toBeUndefined();
    expect(w?.endColumn).toBeUndefined();
    expect(w?.message).toBe(
      "step 'step_one': unknown key 'dependson' — ignored (did you mean 'depends_on'?)",
    );
    expect(w?.message).not.toContain('line');
  });

  it('the console render of an unplaceable key is byte-identical too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadWorkflowFromString(`id: unplaceable-render-wf
name: Unplaceable Render
version: 1
defaults: &d
  execution: auto
steps:
  step_one:
    <<: *d
    description: First step
    dependson: [nothing]
`);
    const out = warn.mock.calls.flat().join('\n');
    expect(out).toContain(
      "⚠ step 'step_one': unknown key 'dependson' — ignored (did you mean 'depends_on'?)",
    );
    warn.mockRestore();
  });
});

describe('#392 — the step-scoped ERROR channel names its step line', () => {
  it('a step-scoped loader error ends with the line of its own step key', () => {
    const src = `id: step-error-wf
name: Step Error
version: 1
steps:
  step_one:
    description: First
    execution: agent
  step_two:
    description: Second
    execution: guard
    depends_on: [step_one]
    abort_unless: "step_one.x == 1"
    timeout_seconds: 5
`;
    assertSourceLine(src, 8, 'step_two:');
    let message = '';
    try {
      loadWorkflowFromString(src);
    } catch (err) {
      message = (err as Error).message;
    }
    // The suffix names where the STEP is, not where the offending field is: a step's errors are
    // about the step, and one line per step keeps a long error list readable.
    expect(message).toContain(
      "Step 'step_two': 'timeout_seconds' is not valid on execution: guard steps (line 8)",
    );
  });

  it('every error in ONE step is positioned, or none is — never a mix', () => {
    // A step that trips several checks, including one whose message is minted deep inside the
    // input_map walk. A reader seeing "(line N)" on some of them would reasonably ask what is
    // different about the others.
    const src = `id: mixed-wf
name: Mixed
version: 1
steps:
  step_one:
    description: First
    execution: auto
    handler: h
    input_map:
      a: 123
      b: 456
`;
    assertSourceLine(src, 5, 'step_one:');
    let message = '';
    try {
      loadWorkflowFromString(src);
    } catch (err) {
      message = (err as Error).message;
    }
    const parts = message.replace('Invalid workflow: ', '').split('; ');
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part, `unpositioned: ${part}`).toContain('(line 5)');
    }
  });
});
