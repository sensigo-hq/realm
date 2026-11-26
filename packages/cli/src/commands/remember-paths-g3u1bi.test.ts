// remember-paths-g3u1bi.test.ts — gap 3, unit 1b-i, checks 4 and 8 and Behaviour 8 (the commands'
// half): `remember:` paths at the doors. `validate`, `register` and `watch` refuse a path that can
// never be found (its code's policy is 'error'); a path that may be absent is a warning, which
// `--strict` fails on; a path on data with no declared shape is listed as not checked, in the text
// and in `--json`; `realm workflow run` prints the findings and runs; the key-names rule refuses at
// every door. In-process via commander's parseAsync. The loader-level cells (every cause, the
// own-output rules, the key-names words) are core's workflow/remember-paths-g3u1bi.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The built core's resolver, the very module `@sensigo/realm` loads: a cell plants a throw in it.
import { PathIndex } from '../../../core/dist/workflow/path-resolver.js';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { runCommand } from './run.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';

/**
 * An agent step with a closed answer, and a writer whose handler the project provides. With `idle`,
 * the agent step's `when` is never true, so a run stalls before any prompt.
 */
function file(key: string, value?: string, idle = false): string {
  return [
    'id: mem',
    'name: MEM',
    'version: 1',
    'steps:',
    '  rate:',
    '    description: Rate.',
    '    execution: agent',
    ...(idle ? ["    when: 'run.params.never_true == true'"] : []),
    '    output_schema:',
    '      type: object',
    '      additionalProperties: false',
    '      properties:',
    '        rung: { type: integer }',
    '        note: { type: string }',
    '      required: [rung]',
    '  w:',
    '    description: W.',
    '    execution: auto',
    '    handler: check_quotes',
    '    depends_on: [rate]',
    '    remember:',
    '      as: offers',
    `      key: ${key}`,
    ...(value !== undefined ? [`      value: ${value}`] : []),
    '      keep_days: 90',
    '',
  ].join('\n');
}

/** The 1-based line of the first line of `text` that holds `needle`. */
function lineOf(text: string, needle: string): number {
  return text.split('\n').findIndex((l) => l.includes(needle)) + 1;
}
const MISSPELT = '{ email: context.resources.rate.emial }';
const never = (text: string): string =>
  "⚠ Step 'w': remember 'offers' key 'email' reads 'context.resources.rate.emial', but step 'rate' has no field 'emial' there, and its schema allows no other fields. " +
  `(line ${lineOf(text, 'key:')})`;
const NEVER_REFUSAL =
  "Invalid: 1 warning, 1 escalated to an error by policy: REMEMBER_PATH_UNRESOLVABLE 'key.email'";

describe('validate, register and run — gap 3 (1b-i): remember paths at the doors', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'realm-remember-paths-'));
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
    const path = join(dir, 'workflow.yaml');
    writeFileSync(path, yaml, 'utf8');
    return path;
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
  const result = (): string[] =>
    lines(logSpy).filter((l) => l.startsWith('Valid:') || l.startsWith('Not checked:'));

  it('Behaviour 8: `validate` refuses a key part that can never be found, with its words and line', async () => {
    const text = file(MISSPELT);
    const code = await exitOf(() => validateCommand.parseAsync([write(text)], { from: 'user' }));
    // (a) red when the code's policy is 'warn' (exit 0), or remember paths are not judged; (b)
    //     prints validate's output.
    expect({ code, warnings: lines(warnSpy), errors: lines(errSpy) }).toEqual({
      code: 1,
      warnings: [never(text)],
      errors: [NEVER_REFUSAL],
    });
  });

  it('Behaviour 8: `register` refuses it and stores nothing; the right field registers', async () => {
    write(file(MISSPELT));
    const code = await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }));
    const refused = {
      code,
      first: lines(errSpy)[0],
      stored: (await h.home.workflowStore.list()).length,
    };
    exitSpy.mockClear();
    write(file('{ email: context.resources.rate.rung }'));
    const ok = await exitOf(() => registerCommand.parseAsync([dir], { from: 'user' }));
    // (a) red when the code's policy is 'warn' (stored), or a found path is refused; (b) prints them.
    expect({ refused, ok, stored: (await h.home.workflowStore.list()).map((d) => d.id) }).toEqual({
      refused: { code: 1, first: NEVER_REFUSAL, stored: 0 },
      ok: 0,
      stored: ['mem'],
    });
  });

  it('Behaviour 8: `realm workflow run` prints the finding and runs', async () => {
    const text = file(MISSPELT, undefined, true);
    write(text);
    const savedIsTTY = process.stdin.isTTY;
    try {
      process.stdin.isTTY = true;
      await exitOf(() => runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }));
    } finally {
      process.stdin.isTTY = savedIsTTY;
    }
    // (a) red when the escalation applies at run (refused, no run); (b) prints them.
    expect({
      runs: (await runIds(h.home.runStore)).length,
      warned: lines(warnSpy).includes(never(text)),
      refused: lines(errSpy).join('\n').includes('Invalid workflow'),
    }).toEqual({ runs: 1, warned: true, refused: false });
  });

  it('check 8: a path that may be absent leaves the file Valid with its warning; --strict fails on it', async () => {
    const text = file('{ email: run.params.email }', '{ n: context.resources.rate.note }').replace(
      'version: 1\n',
      'version: 1\nparams_schema:\n  type: object\n  additionalProperties: false\n  properties:\n    email: { type: string }\n  required: [email]\n',
    );
    const path = write(text);
    const code = await exitOf(() => validateCommand.parseAsync([path], { from: 'user' }));
    const lenient = { code, warnings: lines(warnSpy), result: result() };
    warnSpy.mockClear();
    logSpy.mockClear();
    exitSpy.mockClear();
    const strict = await exitOf(() =>
      validateCommand.parseAsync([path, '--strict'], { from: 'user' }),
    );
    // (a) red when the code's severity is 'error' (exit 1 without --strict), or it is left out of
    //     --strict; (b) prints validate's output.
    expect({ lenient, strict: { code: strict, result: result() } }).toEqual({
      lenient: {
        code: 0,
        warnings: [
          "⚠ Step 'w': remember 'offers' value 'n' reads 'context.resources.rate.note', which may be absent when this step remembers ('note' is optional in its schema); when it is absent, the remembered value has no 'n'. " +
            `(line ${lineOf(text, 'value:')})`,
        ],
        result: ['Valid: mem v1 (2 steps)'],
      },
      strict: { code: 1, result: ['Valid: mem v1 (2 steps) — 1 warning; failing due to --strict'] },
    });
  });

  it("check 4: a handler writer's own output is listed after a Valid result and in --json, with no warning", async () => {
    const path = write(file('{ email: context.resources.w.email }'));
    const code = await exitOf(() => validateCommand.parseAsync([path], { from: 'user' }));
    const human = { code, warnings: lines(warnSpy), result: result() };
    logSpy.mockClear();
    await exitOf(() => validateCommand.parseAsync([path, '--json'], { from: 'user' }));
    const out = JSON.parse(lines(logSpy).join('\n')) as {
      valid: boolean;
      diagnostics: Array<{ code: string }>;
      not_checked: unknown[];
    };
    // (a) red when the text renderer is left out (no line), the entry is lost from --json, or a
    //     warning is minted for the shape; (b) prints both outputs.
    expect({
      human,
      json: {
        valid: out.valid,
        remember: out.diagnostics.filter((d) => d.code.startsWith('REMEMBER_')),
        not_checked: out.not_checked,
      },
    }).toEqual({
      human: {
        code: 0,
        warnings: [],
        result: [
          'Valid: mem v1 (2 steps)',
          'Not checked: 1 remember path(s) on data the workflow declares no shape for: w.key.email: context.resources.w.email',
        ],
      },
      json: {
        valid: true,
        remember: [],
        not_checked: [
          {
            surface: 'remember',
            step: 'w',
            key: 'key.email',
            path: 'context.resources.w.email',
            why: 'producer_declares_no_shape',
          },
        ],
      },
    });
  });

  it('Words 5: past ten paths the line names the first ten and how many more; --json lists every one', async () => {
    const leaves = Array.from({ length: 11 }, (_, i) => `v${i}: context.resources.w.f${i}`);
    const path = write(file('{ email: context.resources.w.email }', `{ ${leaves.join(', ')} }`));
    await exitOf(() => validateCommand.parseAsync([path], { from: 'user' }));
    const human = result();
    logSpy.mockClear();
    await exitOf(() => validateCommand.parseAsync([path, '--json'], { from: 'user' }));
    const out = JSON.parse(lines(logSpy).join('\n')) as { not_checked: unknown[] };
    const named = [
      'w.key.email: context.resources.w.email',
      ...Array.from({ length: 9 }, (_, i) => `w.value.v${i}: context.resources.w.f${i}`),
    ];
    // (a) red when the count, the cap or the tail changes; (b) prints them.
    expect({ human, listed: out.not_checked.length }).toEqual({
      human: [
        'Valid: mem v1 (2 steps)',
        `Not checked: 12 remember path(s) on data the workflow declares no shape for: ${named.join(', ')}, and 2 more; --json lists every one`,
      ],
      listed: 12,
    });
  });

  it('Words 5: a throw while judging one path lists it on the failed-check line, and validate still ends', async () => {
    const original = PathIndex.prototype.shapeOf;
    vi.spyOn(PathIndex.prototype, 'shapeOf').mockImplementation(function (
      this: PathIndex,
      name: string,
    ) {
      if (name === 'rate') throw new Error('planted: a bug in the path check');
      return original.call(this, name);
    });
    const code = await exitOf(() =>
      validateCommand.parseAsync([write(file('{ email: context.resources.rate.rung }'))], {
        from: 'user',
      }),
    );
    // (a) red when there is no catch (validate throws) or no line; (b) prints validate's output.
    expect({ code, result: result() }).toEqual({
      code: 0,
      result: [
        'Valid: mem v1 (2 steps)',
        "Not checked: 1 remember path(s), because Realm's own check failed on them: w.key.email: context.resources.rate.rung",
      ],
    });
  });

  it('Behaviour 8: the key-names rule refuses at `validate` and at `realm workflow run` (no run)', async () => {
    const path = write(
      file('{ email: context.resources.rate.rung }') +
        [
          '  w2:',
          '    description: W2.',
          '    execution: auto',
          '    handler: h',
          '    depends_on: [rate]',
          '    remember:',
          '      as: offers',
          '      key: { customer_email: context.resources.rate.rung }',
          '      keep_days: 90',
          '',
        ].join('\n'),
    );
    const words =
      "Steps that remember 'offers' use different key names: 'w' (email), 'w2' (customer_email). Every step that remembers one memory must use the same key names.";
    const validated = await exitOf(() => validateCommand.parseAsync([path], { from: 'user' }));
    const atValidate = lines(errSpy).join('\n').includes(words);
    errSpy.mockClear();
    exitSpy.mockClear();
    const savedIsTTY = process.stdin.isTTY;
    let ran: number;
    try {
      process.stdin.isTTY = true;
      ran = await exitOf(() => runCommand.parseAsync([path], { from: 'user' }));
    } finally {
      process.stdin.isTTY = savedIsTTY;
    }
    // (a) red when the rule's refusal is a warning (validate exits 0, a run is made); (b) prints them.
    expect({
      validated,
      atValidate,
      ran,
      atRun: lines(errSpy).join('\n').includes(words),
      runs: (await runIds(h.home.runStore)).length,
    }).toEqual({ validated: 1, atValidate: true, ran: 1, atRun: true, runs: 0 });
  });
});
