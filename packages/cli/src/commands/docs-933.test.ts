// docs-933.test.ts — issue #933: what the conditions page and the CHANGELOG say about a precondition
// or a guard (`abort_unless`) whose path starts outside the workflow's steps. Each changed sentence,
// row and example is claimed word for word and its behaviour executed: on the real loader, and on
// the built `realm` for the two printed refusals. No test named the conditions page before this one.
// On a failing host a cell prints the page's text and what realm printed for a scratch workflow
// (step names and the refusals' clauses), never a value of a run or the environment.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  loadWorkflowFromStringWithDiagnostics,
  type WorkflowError,
} from '@sensigo/realm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');
const PAGE = 'docs/reference/workflow/conditions.md';
const CHANGELOG = 'CHANGELOG.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the text word for word; (b) prints the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)).includes(flat(text)), `${page} no longer says: ${text}`).toBe(true);
}
/** The page's one line, inside a fenced block, that starts with `start` (its indent dropped).
 *  (a) red when the page holds none, or more than one; (b) prints how many it holds. */
function printed(page: string, start: string): string {
  const lines = read(page)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith(start));
  expect(lines.length, `${page}: lines starting ${start}`).toBe(1);
  return lines[0]!;
}

/** A workflow from its lines after `version`; the first step's key is on line 5 when `steps:` is
 *  line 4. */
const flow = (...lines: string[]): string =>
  ['id: c933', 'name: c933', 'version: 1', ...lines, ''].join('\n');
/** The loader's refusals, one per item; [] when the file loads. */
function refusals(yaml: string): readonly string[] {
  try {
    loadWorkflowFromStringWithDiagnostics(yaml);
  } catch (err) {
    return (err as WorkflowError).errors ?? [(err as Error).message];
  }
  return [];
}
/** `classify`, then `c` (depending on it, so `when` may read it) carrying `field: [leaf]`; a guard
 *  for `abort_unless`. `c`'s key is on line 8. */
const reading = (field: 'when' | 'preconditions' | 'abort_unless', leaf: string): string =>
  flow(
    'steps:',
    '  classify:',
    '    description: Classify.',
    '    execution: agent',
    '  c:',
    '    description: C.',
    `    execution: ${field === 'abort_unless' ? 'guard' : 'agent'}`,
    '    depends_on: [classify]',
    `    ${field}: ["${leaf}"]`,
  );

let home: string;
let work: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'realm-933-home-'));
  work = mkdtempSync(join(tmpdir(), 'realm-933-work-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});
/** The built `realm` with a scratch HOME; its exit code and stderr's lines. */
function realm(args: string[]): { code: number; err: string[] } {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: work,
    env: { ...process.env, HOME: home, REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { code: r.status ?? -1, err: (r.stderr ?? '').split('\n').filter((l) => l !== '') };
}
/** `realm workflow validate` on the scratch file. */
function validate(yaml: string): { code: number; err: string[] } {
  const dir = join(work, 'wf');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow.yaml'), yaml, 'utf8');
  return realm(['workflow', 'validate', dir]);
}

describe('issue #933 — conditions.md: a precondition or a guard reads only what the steps recorded', () => {
  it('the roots sentence: `run.params.<name>` is read by `when` only; in `preconditions` or `abort_unless` it is refused when the file is loaded', () => {
    claim(
      PAGE,
      "Two other roots exist: `run.params.<name>` for the run's parameters (read by `when` only: in `preconditions` or `abort_unless` it is refused when the file is loaded), and `$settlement.<step>.<field>`",
    );
    // (a) red when `when` refuses the run's input, or a precondition or a guard loads it, or refuses
    //     it as something else than the run's input; (b) prints each field's refusals.
    const opening = (field: string): string =>
      `Step 'c': ${field} 'run.params.mode == 'live'' reads 'run.params.mode', the run's input.`;
    const seen = {
      when: refusals(reading('when', "run.params.mode == 'live'")),
      preconditions: refusals(reading('preconditions', "run.params.mode == 'live'")).map((e) =>
        e.startsWith(opening('precondition')),
      ),
      abort_unless: refusals(reading('abort_unless', "run.params.mode == 'live'")).map((e) =>
        e.startsWith(opening('abort_unless')),
      ),
    };
    expect(seen).toEqual({ when: [], preconditions: [true], abort_unless: [true] });
  });

  it("the `context.resources` paragraph: the `input_map` form is refused in a condition, on all three fields; the page's message is `realm workflow validate`'s", () => {
    claim(
      PAGE,
      "Paths here are shorter than in `input_map` and in template expressions. There, a step's output is `context.resources.classify.category`. In a condition that form is refused:",
    );
    const leaf = "context.resources.classify.category == 'billing'";
    const shown = printed(PAGE, "Invalid workflow: Step 'c': 'when' reads");
    const v = validate(reading('when', leaf));
    // (a) red when `realm workflow validate` prints another line for the page's case, or exits 0;
    //     (b) prints the page's line and realm's.
    expect({ code: v.code, line: v.err[0] }).toEqual({ code: 1, line: shown });
    // (a) red when the form loads in a precondition or a guard, or is refused there without the
    //     path written as a step's output; (b) prints both fields' refusals.
    const fix = "Write it as 'classify.category', then register the workflow again.";
    expect({
      preconditions: refusals(reading('preconditions', leaf)).map((e) => e.includes(fix)),
      abort_unless: refusals(reading('abort_unless', leaf)).map((e) => e.includes(fix)),
    }).toEqual({ preconditions: [true], abort_unless: [true] });
  });

  it('the table under "Where the three fields differ": the `run.params.<name>` row, "A field the step did not output" and "A path whose first part is no step of the workflow"', () => {
    claim(
      PAGE,
      '| `run.params.<name>` | Read | Refused when the file is loaded | Refused when the file is loaded |',
    );
    claim(
      PAGE,
      '| A field the step did not output | The condition is false | The condition is false | The run fails. It is not recorded as aborted. |',
    );
    claim(
      PAGE,
      '| A path whose first part is no step of the workflow | Refused when the file is loaded (not in `depends_on`) | Refused when the file is loaded | Refused when the file is loaded |',
    );
    const loads = (yaml: string): boolean => refusals(yaml).length === 0;
    // (a) red when a row's load-time cell is false: the run's input read by a precondition or a
    //     guard, a missing field refused, a name that is no step loaded; (b) prints each verdict.
    expect({
      runParams: [
        loads(reading('when', 'run.params.ok == true')),
        loads(reading('preconditions', 'run.params.ok == true')),
        loads(reading('abort_unless', 'run.params.ok == true')),
      ],
      missingField: [
        loads(reading('when', 'classify.missing == true')),
        loads(reading('preconditions', 'classify.missing == true')),
        loads(reading('abort_unless', 'classify.missing == true')),
      ],
      noStep: [
        refusals(reading('when', 'nostep.x == true')).some((e) =>
          e.includes("references step 'nostep' which is not in its depends_on"),
        ),
        refusals(reading('preconditions', 'nostep.x == true')).some((e) =>
          e.includes("but 'nostep' is not a step of this workflow."),
        ),
        refusals(reading('abort_unless', 'nostep.x == true')).some((e) =>
          e.includes("but 'nostep' is not a step of this workflow."),
        ),
      ],
    }).toEqual({
      runParams: [true, false, false],
      missingField: [true, true, true],
      noStep: [true, true, true],
    });
  });

  it('"Rules the loader applies": a precondition or guard path starts with a step or `$settlement`; the printed refusal is realm\'s; a step with no `depends_on` is told only `params_schema`', () => {
    claim(
      PAGE,
      'A `preconditions` or `abort_unless` path must start with a step of the workflow, or with `$settlement`. A `run.…` path, a `context.…` path and a name that is no step are refused, each with what to write instead.',
    );
    claim(
      PAGE,
      'On a step with no `depends_on`, the refusal names only `params_schema`: a first step whose `when` is false leaves the run with nothing to run.',
    );
    const shown = printed(PAGE, "Invalid workflow: Step 'c': precondition");
    const v = validate(reading('preconditions', "run.params.mode == 'live'"));
    // (a) red when `realm workflow validate` prints another line for the page's case (the
    //     dependent form), or exits 0; (b) prints the page's line and realm's.
    expect({ code: v.code, line: v.err[0] }).toEqual({ code: 1, line: shown });
    const first = refusals(
      flow(
        'steps:',
        '  c:',
        '    description: C.',
        '    execution: agent',
        `    preconditions: ["run.params.mode == 'live'"]`,
      ),
    );
    // (a) red when a first step's refusal names `when`, or not params_schema; a `$settlement` path,
    //     or one on a step, is refused; each other root's refusal says what to write; (b) prints
    //     each verdict.
    expect({
      firstStep: first.map((e) => [
        e.includes("'when'"),
        e.includes('declare it in params_schema'),
      ]),
      settlement: refusals(reading('preconditions', '$settlement.classify.failed == false')),
      step: refusals(reading('preconditions', 'classify.ok == true')),
      remedies: [
        refusals(reading('preconditions', 'run.id == 1')).map((e) =>
          e.includes("Read a step's output instead"),
        ),
        refusals(reading('preconditions', 'context.foo == 1')).map((e) =>
          e.includes("Write it as '<step>.<field>'"),
        ),
        refusals(reading('abort_unless', 'clasify.ok == true')).map((e) =>
          e.includes("Did you mean 'classify'? Name a step of this workflow"),
        ),
      ],
    }).toEqual({
      firstStep: [[false, true]],
      settlement: [],
      step: [],
      remedies: [[true], [true], [true]],
    });
  });
});

describe('issue #933 — the CHANGELOG entry', () => {
  it('the entry: what is refused, the remedies, `when`’s new words for the `context.resources` form, and `validate --registered` on a copy registered before', () => {
    claim(
      CHANGELOG,
      "**BREAKING — a precondition or a guard (`abort_unless`) whose path starts outside the workflow's steps is refused when the workflow file is loaded (issue #933).** That covers a path on the run (`run`, `run.params.…`, `run.id`), the `input_map` form `context.resources.…`, and a name that is no step of the workflow. Such a check could never be read: the step stayed blocked, or the guard failed the run. Each refusal says what to write instead. For the run's input, declare it in `params_schema` to refuse a run that does not fit, or, on a step that depends on another, put the condition under `when` to skip it. A `when` that uses the `context.resources.…` form now says how to write the path, in place of telling you to add `context` to `depends_on`. A copy registered before this version keeps running as registered; `realm workflow validate --registered <id>` shows whether it would now be refused.",
    );
    const refused = (yaml: string): boolean => refusals(yaml).length === 1;
    // (a) red when one of the named paths loads on a precondition or a guard; (b) prints each.
    expect(
      [
        'run == 1',
        'run.params.ok == true',
        "run.id == 'x'",
        'context.resources.classify.ok == true',
        'nope.ok == true',
      ].map((leaf) => [
        refused(reading('preconditions', leaf)),
        refused(reading('abort_unless', leaf)),
      ]),
    ).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [true, true],
      [true, true],
    ]);
    // (a) red when `when` still tells the author to add `context` to depends_on; (b) prints it.
    const when = refusals(reading('when', 'context.resources.classify.ok == true'));
    expect(
      when.map((e) => [e.includes('depends_on'), e.includes("Write it as 'classify.ok'")]),
    ).toEqual([[false, true]]);
    // A copy registered before this version, written straight into the store (the new build will
    // not register it). (a) red when `validate --registered` does not show the refusal, or exits 0;
    // (b) prints its exit and whether the refusal is in its output.
    const wfDir = join(home, '.realm', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, 'old-copy.json'),
      JSON.stringify({
        id: 'old-copy',
        name: 'old-copy',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          c: {
            description: 'C.',
            execution: 'agent',
            preconditions: ['run.params.ok == true'],
          },
        },
      }),
      'utf8',
    );
    const r = realm(['workflow', 'validate', '--registered', 'old-copy']);
    expect({
      code: r.code,
      refused: r.err.some((l) =>
        l.includes(
          "Step 'c': precondition 'run.params.ok == true' reads 'run.params.ok', the run's input.",
        ),
      ),
    }).toEqual({ code: 1, refused: true });
  });
});
