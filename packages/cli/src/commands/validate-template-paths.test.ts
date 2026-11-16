// Fix 1, piece 3a-ii-a — paths in approval questions (`gate.message`) and in `display`, on the commands.
// `validate`, `register` and `watch` refuse a path that can never be found, and one in a question
// that may be missing and that `| default` does not fill (their codes' policy is 'error'); a path in
// `display` that may be missing is a warning; a reference on data with no declared shape is listed
// as not checked; `realm workflow run` prints them and runs. In-process via commander's parseAsync.
// The loader-level cells (every cause, root and form) are core's template-paths.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// The built core's resolver, the very module `@sensigo/realm` loads: a cell plants a throw in it.
import { PathIndex } from '../../../core/dist/workflow/path-resolver.js';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { runCommand } from './run.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Check 1's file: a misspelt field of review's closed answer, read by an approval question. */
const MISSPELT = `id: q
name: Q
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
  approve:
    description: Approve.
    execution: auto
    trust: human_confirmed
    depends_on: [review]
    gate:
      choices: [approve, reject]
      message: 'Risk: {{ context.resources.review.riks }}'
`;
const FINDING =
  "⚠ Step 'approve': gate.message reads 'context.resources.review.riks' in '{{ context.resources.review.riks }}', " +
  "which can never be found: step 'review' has no field 'riks' there, and its schema allows no other fields, so " +
  "the gate does not open, and the run stays open with the step not done. Did you mean 'risk'? (line 21)";
const REFUSAL =
  "Invalid: 1 warning, 1 escalated to an error by policy: TEMPLATE_PATH_UNRESOLVABLE 'gate.message'";

/** A question on a handler's output, and an undeclared `schema` context entry: both listed. */
const LISTED = `id: nc
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
    gate:
      choices: [approve, reject]
      message: 'T {{ context.resources.fetch.title }} S {{ workflow.context.schema }}'
`;

describe('validate, register and run — fix 1, piece 3a-ii-a: paths in approval questions and display', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-template-paths-'));
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

  it('check 1: `validate` refuses a misspelt field in a question, with the did-you-mean and the line', async () => {
    const code = await exitOf(() =>
      validateCommand.parseAsync([write(MISSPELT)], { from: 'user' }),
    );
    // (1) red when gate.message paths are not judged (exit 0), or the code is a warning; (2) prints them.
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
      stored: ['q'],
    });
  });

  it("check 8: a question on a handler's output and an undeclared `schema` entry are listed after a Valid result, and in `--json`", async () => {
    const file = write(LISTED);
    const code = await exitOf(() => validateCommand.parseAsync([file], { from: 'user' }));
    const human = lines(logSpy);
    logSpy.mockClear();
    await exitOf(() => validateCommand.parseAsync([file, '--json'], { from: 'user' }));
    const out = JSON.parse(lines(logSpy).join('\n')) as { valid: boolean; not_checked: unknown[] };
    // (1) red when such references are not listed, or the line or its order changes; (2) prints them.
    expect({
      code,
      lines: human.filter((l) => l.startsWith('Valid:') || l.startsWith('Not checked:')),
      json: { valid: out.valid, not_checked: out.not_checked },
    }).toEqual({
      code: 0,
      lines: [
        'Valid: nc v1 (2 steps)',
        'Not checked: 2 template reference(s) on data the workflow declares no shape for, or a context entry only a file adds: approve.gate.message: context.resources.fetch.title, approve.gate.message: workflow.context.schema',
      ],
      json: {
        valid: true,
        not_checked: [
          {
            surface: 'template',
            step: 'approve',
            key: 'gate.message',
            path: 'context.resources.fetch.title',
            why: 'producer_declares_no_shape',
          },
          {
            surface: 'template',
            step: 'approve',
            key: 'gate.message',
            path: 'workflow.context.schema',
            why: 'added_from_file',
          },
        ],
      },
    });
  });

  it('check 8: a throw while judging one placeholder lists it on the failed-check line, and validate still ends', async () => {
    const original = PathIndex.prototype.shapeOf;
    vi.spyOn(PathIndex.prototype, 'shapeOf').mockImplementation(function (
      this: PathIndex,
      name: string,
    ) {
      if (name === 'boom') throw new Error('planted: a bug in the path check');
      return original.call(this, name);
    });
    const code = await exitOf(() =>
      validateCommand.parseAsync(
        [
          write(`id: cf
name: CF
version: 1
steps:
  boom:
    description: Boom.
    execution: agent
    display: 'B {{ x }}'
`),
        ],
        { from: 'user' },
      ),
    );
    // (1) red when there is no catch (validate throws) or no line; (2) prints validate's output.
    expect({
      code,
      lines: lines(logSpy).filter((l) => l.startsWith('Valid:') || l.startsWith('Not checked:')),
    }).toEqual({
      code: 0,
      lines: [
        'Valid: cf v1 (1 step)',
        "Not checked: 1 template reference(s), because Realm's own check failed on them: boom.display: x",
      ],
    });
  });

  it("check 9: `realm workflow run` on check 1's file runs and prints the finding as a warning", async () => {
    // The approve step's `when` is never true, so nothing past `review` is eligible and the run stalls
    // before any prompt (unit 1's check 17 pattern) once `review`, an agent step, is left waiting.
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
      warned: lines(warnSpy).includes(FINDING.replace('(line 21)', '(line 22)')),
      refused: lines(errSpy).join('\n').includes('Invalid workflow'),
    }).toEqual({ runs: 1, warned: true, refused: false });
  });
});

describe('fix 1, piece 3a-ii-a — the words the docs and the changelog carry (check 11)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const read = (rel: string): string => flat(readFileSync(join(ROOT, rel), 'utf8'));

  it('input-map-and-templates.md: the sentence 3a-i left now names the question and display paths', () => {
    const page = read('docs/reference/workflow/input-map-and-templates.md');
    // (1) red when the new ending is missing or the old one stays; (2) prints both checks.
    expect({
      now: page.includes(
        'a templated field that is not text; in an approval question and in `display`, a path that can never be found is refused, and so is a path in an approval question that may be missing, unless `| default` comes first in its filters and the filters after it take its value; in a prompt and in step instructions, a path that can never be found is refused too, and one that may be missing gets a warning. This was added after version 0.49.0.',
      ),
      old: page.includes('the paths in a template are not checked yet'),
    }).toEqual({ now: true, old: false });
  });

  it('loader-diagnostics.md: 36 codes, twelve of them errors, the errors list, the three rows and the not_checked row', () => {
    const raw = readFileSync(join(ROOT, 'docs/reference/workflow/loader-diagnostics.md'), 'utf8');
    const page = flat(raw);
    const rows = raw
      .split('\n')
      .filter((l) => /^\| `[A-Z][A-Z_]+` +\| (Error|Warning) /.test(l))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    const at = rows.findIndex((r) => r[0] === '`TEMPLATED_FIELD_NOT_TEXT`');
    // (1) red when a count, the list, a row or the not_checked row is missing or changed; (2) prints them.
    expect({
      lists: page.includes('lists all 36 warning codes'),
      count: page.includes('The loader has 36 warning codes. Twelve of them count as errors'),
      list: page.includes(
        'or leaves a required one unfilled; a template that uses a filter Realm does not have, gives a filter an argument no value accepts, or is not text; and a path in an approval question, `display`, a prompt or step instructions that can never be found, or one in an approval question that may be missing, unless `| default` comes first in its filters and the filters after it take its value. The others are advice',
      ),
      rows: rows.length,
      errors: rows.filter((r) => r[1] === 'Error').length,
      three: rows.slice(at + 1, at + 4),
      notChecked: page.includes(
        "The `input_map` paths, `when` conditions and template references (in `gate.message`, `display`, `prompt` and `instructions`) that read data the workflow declares no shape for, or a context entry only a file adds: `surface` (`input_map`, `when` or `template`), `step`, `key` (`when` for a condition, the field's name for a template), `path`, `why` (`producer_declares_no_shape`, `no_params_schema`, `added_from_file`, or `check_failed` when the check itself failed on that path).",
      ),
    }).toEqual({
      lists: true,
      count: true,
      list: true,
      rows: 36,
      errors: 12,
      three: [
        [
          '`TEMPLATE_PATH_UNRESOLVABLE`',
          'Error',
          "A path in an approval question, a step's `display`, a prompt or step instructions can never be found. Added after version 0.49.0.",
        ],
        [
          '`TEMPLATE_PATH_NO_DEFAULT`',
          'Error',
          'A path in an approval question may be missing, and no `default` filter fills it. Added after version 0.49.0.',
        ],
        [
          '`TEMPLATE_PATH_UNCERTAIN`',
          'Warning',
          "A path in a step's `display`, a prompt or step instructions may be missing. Added after version 0.49.0.",
        ],
      ],
      notChecked: true,
    });
  });

  it('CHANGELOG.md: the BREAKING line under Changed, and Upgrading item 12', () => {
    const log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const start = log.indexOf('## [Unreleased]');
    const unreleased = log.slice(start, log.indexOf('\n## [', start + 1));
    const section = (name: string): string => {
      const i = unreleased.indexOf(`### ${name}`);
      return unreleased.slice(i, unreleased.indexOf('\n### ', i + 1));
    };
    // (1) red when either is missing, moved or misnumbered; (2) prints the checks.
    expect({
      changed: section('Changed').includes(
        "- **BREAKING: `realm workflow validate`, `register` and `watch` refuse a path in an approval question or a step's `display` that can never be found, and a path in an approval question that may be missing, unless `| default` comes first in its filters and the filters after it take its value**, with the line and a did-you-mean. Without a value, such a question did not open, or showed the placeholder as written when it had a filter. A path in `display` that may be missing gets a warning. Running a workflow is not refused.",
      ),
      upgrading: section('Upgrading').includes(
        '**12. `register` and `watch` refuse an approval question or `display` path that can never be found, and an approval question path that may be missing unless `| default` fills it.** Run `realm workflow validate` on each file, or `realm workflow validate --registered <id>` on each stored workflow, and fix what the refusal names. A stored copy keeps running as it was until you register it again.',
      ),
    }).toEqual({ changed: true, upgrading: true });
  });
});
