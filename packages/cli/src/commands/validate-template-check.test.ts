// Fix 1, piece 3a-i — a template's filters, their arguments and a templated field's type, on the
// commands. `validate`, `register` and `watch` refuse them (their codes' policy is 'error'); `validate`
// no longer crashes in its cache lines on an agent step whose prompt cannot be rendered, in file mode
// and in `--registered`; `realm workflow run` prints them as warnings and runs. In-process via
// commander's parseAsync. The loader-level cells (every field, cause and type) are core's
// template-check.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowDefinition } from '@sensigo/realm';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { runCommand } from './run.js';
import { buildCacheabilityReport, renderCacheabilityLines } from '../lib/cacheability.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Check 1's `prompt` file: an unknown filter in an agent step's prompt. */
const PROMPT_FILE = `id: tpl
name: Tpl
version: 1
steps:
  write:
    description: Write.
    execution: agent
    prompt: 'Write {{ run.params.s | bulets }}'
`;
const PROMPT_FINDING =
  "⚠ Step 'write': prompt uses the filter 'bulets' in '{{ run.params.s | bulets }}', which Realm " +
  "does not have, so the placeholder is passed on as written. Did you mean 'bullets'? (line 8)";
const PROMPT_REFUSAL =
  "Invalid: 1 warning, 1 escalated to an error by policy: TEMPLATE_FILTER_UNKNOWN 'prompt'";

/** An agent step whose prompt reads a workflow context file, `glossary.md`, beside it. */
const contextFile = (prompt: string): string => `id: ctx
name: Ctx
version: 1
workflow_context:
  glossary:
    source:
      path: ./glossary.md
    description: Terms.
steps:
  a:
    description: A.
    execution: agent
    prompt: ${prompt}
`;

/** Check 3's three agent prompts that the cache lines rendered before the refusal. */
const CRASHERS: Array<{ name: string; prompt: string; stored: unknown; refusal: string }> = [
  {
    name: 'prompt: [a, b]',
    prompt: '[a, b]',
    stored: ['a', 'b'],
    refusal:
      "Invalid: 1 warning, 1 escalated to an error by policy: TEMPLATED_FIELD_NOT_TEXT 'prompt'",
  },
  {
    name: 'prompt: (empty)',
    prompt: '',
    stored: null,
    refusal:
      "Invalid: 1 warning, 1 escalated to an error by policy: TEMPLATED_FIELD_NOT_TEXT 'prompt'",
  },
  {
    name: 'prompt: "{{ workflow.context.glossary | indent: -1 }}"',
    prompt: '"{{ workflow.context.glossary | indent: -1 }}"',
    stored: '{{ workflow.context.glossary | indent: -1 }}',
    refusal:
      "Invalid: 1 warning, 1 escalated to an error by policy: TEMPLATE_FILTER_ARGUMENT 'prompt'",
  },
];

describe('validate, register and run — fix 1, piece 3a-i: template filters and field types', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-template-check-'));
    writeFileSync(join(dir, 'glossary.md'), 'Terms.\n', 'utf8');
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
  const everything = (): string =>
    [...lines(warnSpy), ...lines(errSpy), ...lines(logSpy)].join('\n');
  /** Runs a command; its exit code (0 when it returned without one), and whatever it threw. */
  async function exitOf(run: () => Promise<unknown>): Promise<{ code: number; threw?: string }> {
    let threw: string | undefined;
    try {
      await run();
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') threw = String(err);
    }
    const call = exitSpy.mock.calls.at(-1);
    return {
      code: call === undefined ? 0 : Number(call[0] ?? 0),
      ...(threw !== undefined ? { threw } : {}),
    };
  }
  const clear = (): void => {
    for (const s of [warnSpy, logSpy, errSpy, exitSpy]) s.mockClear();
  };

  it('check 1: `validate` refuses an unknown filter in an agent step’s prompt, with its line and did-you-mean', async () => {
    const r = await exitOf(() =>
      validateCommand.parseAsync([write(PROMPT_FILE)], { from: 'user' }),
    );
    // (1) red when filters are not judged (exit 0) or the code's policy is 'warn'; (2) prints them.
    expect({ ...r, warnings: lines(warnSpy), errors: lines(errSpy) }).toEqual({
      code: 1,
      warnings: [PROMPT_FINDING],
      errors: [PROMPT_REFUSAL],
    });
  });

  it('check 1: `register` refuses it and stores nothing', async () => {
    write(PROMPT_FILE);
    const r = await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }));
    // (1) red when the code's policy is 'warn' (register stores it); (2) prints the calls.
    expect({
      code: r.code,
      first: lines(errSpy)[0],
      stored: (await h.home.workflowStore.list()).map((d) => d.id),
    }).toEqual({ code: 1, first: PROMPT_REFUSAL, stored: [] });
  });

  for (const c of CRASHERS) {
    it(`check 3: \`validate\` on an agent step with ${c.name}: the refusal, exit 1, no stack, and \`--json\` is one JSON object`, async () => {
      const file = write(contextFile(c.prompt));
      const plain = await exitOf(() => validateCommand.parseAsync([file], { from: 'user' }));
      const plainOut = everything();
      const plainErrors = lines(errSpy);
      clear();
      const json = await exitOf(() =>
        validateCommand.parseAsync([file, '--json'], { from: 'user' }),
      );
      const out = JSON.parse(lines(logSpy).join('\n')) as {
        valid: boolean;
        cacheability: { steps: Array<{ layouts: Array<{ not_judged_cause?: string }> }> };
      };
      // (1) red when the cache lines render the prompt unguarded: a TypeError or RangeError and its
      // stack, before or instead of the refusal; (2) prints what each arm gave.
      expect({
        plain,
        refusal: plainErrors.includes(c.refusal),
        stack: /TypeError|RangeError|\n\s+at /.test(plainOut + everything()),
        json,
        valid: out.valid,
        causes: out.cacheability.steps.map((s) => s.layouts.map((l) => l.not_judged_cause)),
      }).toEqual({
        plain: { code: 1 },
        refusal: true,
        stack: false,
        json: { code: 1 },
        valid: false,
        causes: [['prompt_unrenderable', 'prompt_unrenderable']],
      });
    });

    it(`check 3: \`validate --registered\` on a stored agent step with ${c.name}: the refusal, exit 1, no stack`, async () => {
      write(contextFile('"Read {{ workflow.context.glossary }}"'));
      expect((await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }))).code).toBe(
        0,
      );
      // The copy as a Realm before this change stored it: edited past the loader that refuses it now.
      const copy = (await h.home.workflowStore.get('ctx')) as unknown as {
        steps: Record<string, Record<string, unknown>>;
      };
      copy.steps['a']!['prompt'] = c.stored;
      await h.home.workflowStore.register(copy as never);
      clear();
      const plain = await exitOf(() =>
        validateCommand.parseAsync(['--registered', 'ctx'], { from: 'user' }),
      );
      const plainOut = everything();
      const plainErrors = lines(errSpy);
      clear();
      const json = await exitOf(() =>
        validateCommand.parseAsync(['--registered', 'ctx', '--json'], { from: 'user' }),
      );
      const out = JSON.parse(lines(logSpy).join('\n')) as { valid: boolean };
      // (1) red when the cache lines render the stored prompt unguarded; (2) prints each arm.
      expect({
        plain,
        refusal: plainErrors.includes(c.refusal.replace(' (line 13)', '')),
        stack: /TypeError|RangeError|\n\s+at /.test(plainOut + everything()),
        json,
        valid: out.valid,
      }).toEqual({
        plain: { code: 1 },
        refusal: true,
        stack: false,
        json: { code: 1 },
        valid: false,
      });
    });
  }

  it("check 3: the cache lines' own line for a step whose prompt cannot be rendered — never sized without it", async () => {
    const definition = {
      id: 'x',
      name: 'x',
      version: 1,
      steps: { a: { description: 'A.', execution: 'agent', depends_on: [], prompt: ['a', 'b'] } },
    } as unknown as WorkflowDefinition;
    const report = await buildCacheabilityReport(definition, {});
    // (1) red when the step is sized without its prompt, or the guard is removed (the TypeError);
    // (2) prints the step line and its layouts.
    expect({
      line: renderCacheabilityLines(report).steps,
      layouts: report.steps[0]!.layouts.map((l) => [l.verdict, l.cause, l.sized !== undefined]),
    }).toEqual({
      line: [
        'cache: a — its prompt cannot be rendered when the file is checked: sizes not computed',
      ],
      layouts: [
        ['not_judged', 'prompt_unrenderable', false],
        ['not_judged', 'prompt_unrenderable', false],
      ],
    });
  });

  it("check 4: `realm workflow run` on check 1's prompt file runs, printing the finding as a warning", async () => {
    // The step's `when` is never true, so nothing is eligible and the loop stalls before any prompt
    // (unit 1's check 17 pattern); the terminal flag lets the dev guard through.
    write(
      PROMPT_FILE.replace(
        '    execution: agent\n',
        "    execution: agent\n    when: 'run.params.never_true == true'\n",
      ),
    );
    const savedIsTTY = process.stdin.isTTY;
    let r: { code: number; threw?: string };
    try {
      process.stdin.isTTY = true;
      r = await exitOf(() => runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }));
    } finally {
      process.stdin.isTTY = savedIsTTY;
    }
    // (1) red when the escalation applies at run: the run is refused and no run is created; (2)
    // prints the run ids, the finding and the error output.
    expect({
      runs: (await runIds(h.home.runStore)).length,
      warned: lines(warnSpy).includes(PROMPT_FINDING.replace('(line 8)', '(line 9)')),
      refused: lines(errSpy).join('\n').includes('Invalid workflow'),
      threw: r.threw,
    }).toEqual({ runs: 1, warned: true, refused: false, threw: undefined });
  });
});

describe('fix 1, piece 3a-i — the words the docs and the changelog carry (check 6)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  const read = (rel: string): string => flat(readFileSync(join(ROOT, rel), 'utf8'));

  it('input-map-and-templates.md: the two sentences, and the old ones gone', () => {
    const page = read('docs/reference/workflow/input-map-and-templates.md');
    // (1) red when a new sentence is missing or an old one stays; (2) prints the four checks.
    expect({
      refuse: page.includes(
        '`realm workflow validate`, `register` and `watch` refuse a filter Realm does not have, an argument no value accepts, and a templated field that is not text; the paths in a template are not checked yet. This was added after version 0.49.0.',
      ),
      instructions: page.includes(
        '`instructions` are read for expressions only on a step with a gate, when the gate opens; on other steps they, and `description` always, are passed on as written.',
      ),
      oldRefuse: page.includes('does not check the paths or filter names in a template'),
      oldInstructions: page.includes(
        '`instructions` and `description` are not read for expressions.',
      ),
    }).toEqual({ refuse: true, instructions: true, oldRefuse: false, oldInstructions: false });
  });

  it('loader-diagnostics.md: 32 codes, ten of them errors, the errors list and the three rows', () => {
    const page = readFileSync(join(ROOT, 'docs/reference/workflow/loader-diagnostics.md'), 'utf8');
    const rows = page
      .split('\n')
      .filter((l) => /^\| `[A-Z][A-Z_]+` +\| (Error|Warning) /.test(l))
      .map((l) =>
        l
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim()),
      );
    const at = rows.findIndex((r) => r[0] === '`ADAPTER_NOT_PROVIDED`');
    // (1) red when a count, the list or a row is missing or changed; (2) prints them.
    expect({
      lists: flat(page).includes('lists all 32 warning codes'),
      count: flat(page).includes('The loader has 32 warning codes. Ten of them count as errors'),
      list: flat(page).includes(
        'or leaves a required one unfilled; and a template that uses a filter Realm does not have, gives a filter an argument no value accepts, or is not text. The others are advice',
      ),
      rows: rows.length,
      errors: rows.filter((r) => r[1] === 'Error').length,
      three: rows.slice(at + 1, at + 4),
    }).toEqual({
      lists: true,
      count: true,
      list: true,
      rows: 32,
      errors: 10,
      three: [
        [
          '`TEMPLATE_FILTER_UNKNOWN`',
          'Error',
          'A template uses a filter Realm does not have. Added after version 0.49.0.',
        ],
        [
          '`TEMPLATE_FILTER_ARGUMENT`',
          'Error',
          'A template gives a filter an argument no value accepts. Added after version 0.49.0.',
        ],
        [
          '`TEMPLATED_FIELD_NOT_TEXT`',
          'Error',
          'A field Realm reads as a template (`prompt`, `gate.message`, `display`, or `instructions` on a step with a gate) is not text. Added after version 0.49.0.',
        ],
      ],
    });
  });

  it('CHANGELOG.md: the BREAKING line under Changed, and Upgrading item 8', () => {
    const log = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const start = log.indexOf('## [Unreleased]');
    const unreleased = log.slice(start, log.indexOf('\n## [', start + 1));
    const section = (name: string): string =>
      unreleased.slice(
        unreleased.indexOf(`### ${name}`),
        unreleased.indexOf('\n### ', unreleased.indexOf(`### ${name}`) + 1),
      );
    // (1) red when either is missing or moved, an item is lost from the middle, two items share a
    // number, or the list stops before item 8; (2) prints the checks and the numbers found beside
    // the run 1..N expected. A later item moves no pin here: it pins its own text in its own file.
    const numbers = [...section('Upgrading').matchAll(/^\*\*(\d+)\./gm)].map((m) => Number(m[1]));
    expect({
      changed: section('Changed').includes(
        '- **BREAKING: `realm workflow validate`, `register` and `watch` refuse a template filter Realm does not have, a filter argument no value accepts, and a templated field that is not text**, with the line and, when one is close, a did-you-mean. Such a template failed or misrendered when the step ran; `validate` crashed on an agent step whose prompt was not text, or whose filter argument made its render throw. Running a workflow is not refused.',
      ),
      upgrading: section('Upgrading').includes(
        '**8. `register` and `watch` refuse a template filter Realm does not have, an argument no value accepts, or a templated field that is not text.** Run `realm workflow validate` on each file, or `realm workflow validate --registered <id>` on each stored workflow, and fix what the refusal names. A stored copy keeps running as it was until you register it again.',
      ),
      numbers,
    }).toEqual({
      changed: true,
      upgrading: true,
      numbers: Array.from({ length: Math.max(numbers.length, 8) }, (_, i) => i + 1),
    });
  });
});
