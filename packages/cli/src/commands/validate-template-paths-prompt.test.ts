// Fix 1, piece 3a-ii-b — paths in a step's `prompt` and `instructions`, on the commands. `validate`,
// `register` and `watch` refuse a path that can never be found (the code's policy is 'error'); one
// that may be missing is a warning, so the file is still Valid; a reference on data with no declared
// shape is listed as not checked, the human line naming ten at most; `realm workflow run` prints the
// findings and runs. In-process via commander's parseAsync. The loader-level cells (every root,
// reason and field) are core's template-paths-prompt.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { runCommand } from './run.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Check 1's file: a misspelt field of review's closed answer, read by an agent step's prompt. */
const MISSPELT = `id: p
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
    prompt: 'Risk: {{ context.resources.review.riks }}'
`;
const FINDING =
  "⚠ Step 'draft': prompt reads 'context.resources.review.riks' in '{{ context.resources.review.riks }}', " +
  "which can never be found: step 'review' has no field 'riks' there, and its schema allows no other fields, so " +
  "the model is sent the placeholder as written. Did you mean 'risk'? (line 19)";
const REFUSAL =
  "Invalid: 1 warning, 1 escalated to an error by policy: TEMPLATE_PATH_UNRESOLVABLE 'prompt'";

/** A prompt reading `n` fields of a handler's output: each listed as not checked. */
const handlerReads = (n: number): string => `id: nc
name: NC
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
    prompt: '${Array.from({ length: n }, (_, i) => `{{ context.resources.fetch.f${i} }}`).join(' ')}'
`;
const NOT_CHECKED =
  'template reference(s) on data the workflow declares no shape for, or a context entry only a file adds: ';
const refs = (from: number, to: number): string =>
  Array.from(
    { length: to - from },
    (_, i) => `draft.prompt: context.resources.fetch.f${from + i}`,
  ).join(', ');

describe('validate, register and run — fix 1, piece 3a-ii-b: paths in prompts and instructions', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-template-paths-prompt-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  function write(yaml: string): string {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, yaml, 'utf8');
    return file;
  }
  const lines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c: unknown[]) => String(c[0]));
  async function exitOf(run: () => Promise<unknown>): Promise<number> {
    try {
      await run();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
    }
    const call = exitSpy.mock.calls.at(-1);
    return call === undefined ? 0 : Number(call[0] ?? 0);
  }

  it('check 1: `validate` refuses a misspelt field in a prompt, with the did-you-mean and the line', async () => {
    const code = await exitOf(() =>
      validateCommand.parseAsync([write(MISSPELT)], { from: 'user' }),
    );
    // (1) red when prompt paths are not judged (exit 0), or the code is a warning; (2) prints them.
    expect({ code, warnings: lines(warnSpy), errors: lines(errSpy) }).toEqual({
      code: 1,
      warnings: [FINDING],
      errors: [REFUSAL],
    });
  });

  it('check 1: `register` refuses it and stores nothing; the right field registers', async () => {
    write(MISSPELT);
    const code = await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }));
    const refused = {
      code,
      first: lines(errSpy)[0],
      stored: (await h.home.workflowStore.list()).length,
    };
    exitSpy.mockClear();
    write(MISSPELT.replace('review.riks', 'review.risk'));
    const ok = await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }));
    // (1) red when the code's policy is 'warn' (stored), or the right field is refused; (2) prints them.
    expect({ refused, ok, stored: (await h.home.workflowStore.list()).map((d) => d.id) }).toEqual({
      refused: { code: 1, first: REFUSAL, stored: 0 },
      ok: 0,
      stored: ['p'],
    });
  });

  it('check 2: a prompt path that may be missing is a warning, and `validate` still prints Valid', async () => {
    const code = await exitOf(() =>
      validateCommand.parseAsync([write(MISSPELT.replace('review.riks', 'review.notes'))], {
        from: 'user',
      }),
    );
    // (1) red when may-be-missing is refused in a prompt (exit 1, no Valid); (2) prints them.
    expect({
      code,
      warnings: lines(warnSpy).map((l) => l.slice(0, l.indexOf(" ('notes'"))),
      valid: lines(logSpy).filter((l) => l.startsWith('Valid:')),
      errors: lines(errSpy),
    }).toEqual({
      code: 0,
      warnings: [
        "⚠ Step 'draft': prompt reads 'context.resources.review.notes' in '{{ context.resources.review.notes }}', which may be missing when the prompt is sent",
      ],
      valid: ['Valid: p v1 (2 steps)'],
      errors: [],
    });
  });

  it('check 7: the human not-checked line names ten references, then how many more; `--json` lists every one; ten print as today', async () => {
    const twelve = write(handlerReads(12));
    await exitOf(() => validateCommand.parseAsync([twelve], { from: 'user' }));
    const human = lines(logSpy).filter((l) => l.startsWith('Not checked:'));
    logSpy.mockClear();
    await exitOf(() => validateCommand.parseAsync([twelve, '--json'], { from: 'user' }));
    const json = JSON.parse(lines(logSpy).join('\n')) as {
      not_checked: Array<{ key: string; path: string }>;
    };
    logSpy.mockClear();
    await exitOf(() => validateCommand.parseAsync([write(handlerReads(10))], { from: 'user' }));
    const ten = lines(logSpy).filter((l) => l.startsWith('Not checked:'));
    // (1) red when prompt references are not listed, or the cap is dropped (twelve named), or ten get
    // the "more" tail; (2) prints the lines and the JSON count.
    expect({
      human,
      json: [json.not_checked.length, json.not_checked.every((n) => n.key === 'prompt')],
      ten,
    }).toEqual({
      human: [`Not checked: 12 ${NOT_CHECKED}${refs(0, 10)}, and 2 more; --json lists every one`],
      json: [12, true],
      ten: [`Not checked: 10 ${NOT_CHECKED}${refs(0, 10)}`],
    });
  });

  it("check 8: `realm workflow run` on check 1's file runs and prints the finding as a warning", async () => {
    // `review`'s `when` is never true, so nothing past it is eligible and the run stalls before any
    // prompt (unit 1's check 17 pattern) once `review`, an agent step, is left waiting.
    write(
      MISSPELT.replace(
        '  review:\n    description: Review.\n    execution: agent\n',
        "  review:\n    description: Review.\n    execution: agent\n    when: 'run.params.never_true == true'\n",
      ),
    );
    const savedIsTTY = process.stdin.isTTY;
    try {
      process.stdin.isTTY = true;
      await exitOf(() => runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }));
    } finally {
      process.stdin.isTTY = savedIsTTY;
    }
    // (1) red when the escalation applies at run: the run is refused and none is created; (2) prints them.
    expect({
      runs: (await runIds(h.home.runStore)).length,
      warned: lines(warnSpy).includes(FINDING.replace('(line 19)', '(line 20)')),
      refused: lines(errSpy).join('\n').includes('Invalid workflow'),
    }).toEqual({ runs: 1, warned: true, refused: false });
  });
});

describe('fix 1, piece 3a-ii-b — the words the changelog, the docs transcripts and example 03 carry (check 10)', () => {
  const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
  const NC =
    'Not checked: 1 template reference(s) on data the workflow declares no shape for, or a context entry only a file adds: ';

  it('CHANGELOG.md: the BREAKING line under Changed, and Upgrading item 14', () => {
    const log = read('CHANGELOG.md');
    // #871's form: `[Unreleased]` until a release renames it, then the first section (the release's).
    const top = log.includes('## [Unreleased]')
      ? log.indexOf('## [Unreleased]')
      : log.indexOf('\n## [') + 1;
    const unreleased = log.slice(top, log.indexOf('\n## [', top + 1));
    const section = (name: string): string => {
      const i = unreleased.indexOf(`### ${name}`);
      return unreleased.slice(i, unreleased.indexOf('\n### ', i + 1));
    };
    // (1) red when either is missing, moved or misnumbered; (2) prints the checks.
    expect({
      changed: section('Changed').includes(
        "- **BREAKING: `realm workflow validate`, `register` and `watch` refuse a path in a step's prompt or instructions that can never be found**, with the line and a did-you-mean. A path there that may be missing gets a warning. A path written as `when` or other tools write it (`review.risk`, `steps.review.output.risk`, `$settlement.…`, for a step of the workflow) is refused with the right spelling; a placeholder that starts with none of these, nor `context`, `run` or `workflow`, is not checked, as text for the model. Such a path reached the model, or the gate's opening reply, as written. Running a workflow is not refused.",
      ),
      upgrading: section('Upgrading').includes(
        '**14. `register` and `watch` refuse a prompt or step instructions path that can never be found.** Run `realm workflow validate` on each file, or `realm workflow validate --registered <id>` on each stored workflow, and fix what the refusal names. A stored copy keeps running as it was until you register it again.',
      ),
    }).toEqual({ changed: true, upgrading: true });
  });

  it("the three docs transcripts carry validate's not-checked line after the Valid line, and example 03 fills its runbook", () => {
    // (1) red when a transcript lacks the line, or it moves, or example 03's runbook has no default;
    // (2) prints each check.
    expect({
      stepHandlers: read('docs/guides/step-handlers.md').includes(
        `Valid: price v1 (2 steps)\n${NC}confirm.prompt: context.resources.total.total\nExtensions:`,
      ),
      stepFields: read('docs/reference/workflow/step-fields.md').includes(
        `Valid: every-step-field v1 (6 steps)\n${NC}summarise.prompt: context.resources.read_note.content\nExtensions:`,
      ),
      topLevelFields: read('docs/reference/workflow/top-level-fields.md').includes(
        `  Reads a note, has it reviewed, and files the result.\n${NC}review.prompt: context.resources.read_note.content\nExtensions:`,
      ),
      example03: read('examples/03-incident-response/workflow.yaml').includes(
        "      Runbook: {{ context.resources.analyze_cause.runbook | default: 'none given' }}\n",
      ),
    }).toEqual({ stepHandlers: true, stepFields: true, topLevelFields: true, example03: true });
  });
});
