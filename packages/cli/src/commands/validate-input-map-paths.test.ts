// Fix 1, unit 1 (data paths) — on the built commands. An `input_map` path that can never be found
// is refused by `validate`, `register` and `watch` (the #170 boundary: its warning code's policy
// is 'error'); `realm workflow run` prints it as a warning and goes on. A path into data the
// workflow declares no shape for is listed after the result line, and in `--json` `not_checked`.
// In-process via commander's parseAsync, the pattern of validate-gate-dead-block.test.ts. The
// loader-level cells (every row, every `<why>`) are core's input-map-paths.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowRegistrar, WorkflowDefinition } from '@sensigo/realm';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { runCommand } from './run.js';
import { watchWorkflow } from './watch.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Check 1's file: the trial's refund (W49-R4 q8). The docs page quotes what validate prints for it. */
const TRIAL = `id: refund
name: Refund
version: 1
steps:
  propose:
    description: Propose a refund
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [amount_cents]
      properties:
        amount_cents: { type: integer }
  refund:
    description: Send the refund
    execution: auto
    handler: send_refund
    depends_on: [propose]
    input_map:
      amount_cents: steps.propose.output.amount_cents
`;
/** What validate prints for TRIAL: the finding, then the refusal. */
const TRIAL_FINDING =
  "⚠ Step 'refund': input_map 'amount_cents' reads 'steps.propose.output.amount_cents', which can " +
  "never be found: a path starts with 'run.params.' or 'context.resources.<step>.'. Write it as " +
  "'context.resources.propose.amount_cents'. (line 20)";
const TRIAL_REFUSAL =
  "Invalid: 1 warning, 1 escalated to an error by policy: INPUT_MAP_PATH_UNRESOLVABLE 'amount_cents'";

/** A handler step reading a field of another handler step's output, which declares no shape. */
const HANDLER_OUTPUT = `id: orders
name: Orders
version: 1
steps:
  fetch:
    description: Fetch the order
    execution: auto
    handler: fetch_order
    input_schema:
      type: object
      additionalProperties: false
      properties:
        order_id: { type: string }
  refund:
    description: Refund it
    execution: auto
    handler: send_refund
    depends_on: [fetch]
    input_map:
      amount: context.resources.fetch.total
`;

/** A step reading a step it does not depend on: a warning only (row 8). */
const NOT_A_DEPENDENCY = `id: two
name: Two
version: 1
steps:
  propose:
    description: Propose
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [amount_cents]
      properties:
        amount_cents: { type: integer }
  refund:
    description: Refund
    execution: auto
    handler: send_refund
    input_map:
      amount_cents: context.resources.propose.amount_cents
`;

describe('validate — fix 1, unit 1: input_map paths', () => {
  let dir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-input-map-paths-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function write(yaml: string): string {
    const wfPath = join(dir, 'workflow.yaml');
    writeFileSync(wfPath, yaml, 'utf8');
    return wfPath;
  }
  const lines = (spy: ReturnType<typeof vi.spyOn>): string[] =>
    spy.mock.calls.map((c: unknown[]) => String(c[0]));

  it("check 1, the trial's case: exit 1, the row 1 message with its line and the fix, then the refusal", async () => {
    await expect(validateCommand.parseAsync([write(TRIAL)], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    // (1) red when the resolver's start check is removed: the file validates (exit 0, "Valid"),
    //     so parseAsync resolves and the line above fails first; (2) prints the rejection.
    expect(exitSpy).toHaveBeenCalledWith(1);
    // (1) red when the message, its fix or its line change; (2) prints every warning line.
    expect(lines(warnSpy)).toEqual([TRIAL_FINDING]);
    // (1) red when the code's policy is 'warn' (no refusal line); (2) prints the error output.
    expect(lines(errSpy)).toEqual([TRIAL_REFUSAL]);
  });

  it('check 1, --json: valid false, the finding with its code, line, column and key; not_checked empty', async () => {
    await expect(
      validateCommand.parseAsync([write(TRIAL), '--json'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    const out = JSON.parse(lines(logSpy).join('\n')) as Record<string, unknown>;
    const d = (out['diagnostics'] as Record<string, unknown>[])[0]!;
    // (1) red when a field is missing from the machine channel; (2) prints the parts.
    expect({
      valid: out['valid'],
      errors: out['errors'],
      not_checked: out['not_checked'],
      code: d['code'],
      severity: d['severity'],
      step: d['step'],
      key: d['key'],
      line: d['line'],
      column: d['column'],
    }).toEqual({
      valid: false,
      errors: [TRIAL_REFUSAL],
      not_checked: [],
      code: 'INPUT_MAP_PATH_UNRESOLVABLE',
      severity: 'error',
      step: 'refund',
      key: 'amount_cents',
      line: 20,
      column: 7,
    });
  });

  it('check 11: a path into a handler\'s output: Valid, no warning, and the "Not checked" line', async () => {
    await validateCommand.parseAsync([write(HANDLER_OUTPUT)], { from: 'user' });
    // (1) red when the handler's input_schema is read as its output (a refusal: exit 1);
    //     (2) prints the calls.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(lines(warnSpy)).toEqual([]);
    // (1) red when the line is not printed, or its words change; (2) prints validate's output.
    expect(lines(logSpy)).toContain(
      'Not checked: 1 input_map path(s) into data the workflow declares no shape for: refund.amount',
    );
    // (1) red when the line comes before the result line; (2) prints validate's output.
    expect(lines(logSpy).findIndex((l) => l.startsWith('Valid: orders v1'))).toBeLessThan(
      lines(logSpy).findIndex((l) => l.startsWith('Not checked:')),
    );
  });

  it('check 11, --json: `not_checked` names the step, key, path and why', async () => {
    await validateCommand.parseAsync([write(HANDLER_OUTPUT), '--json'], { from: 'user' });
    const out = JSON.parse(lines(logSpy).join('\n')) as Record<string, unknown>;
    // (1) red when not_checked is left off the --json or a field of it changes; (2) prints it.
    expect({ valid: out['valid'], not_checked: out['not_checked'] }).toEqual({
      valid: true,
      not_checked: [
        {
          step: 'refund',
          key: 'amount',
          path: 'context.resources.fetch.total',
          why: 'producer_declares_no_shape',
        },
      ],
    });
  });

  it('a path that may be absent leaves the file Valid, with its warning; --strict fails on it', async () => {
    await validateCommand.parseAsync([write(NOT_A_DEPENDENCY)], { from: 'user' });
    // (1) red when a may-be-absent path refuses; (2) prints the calls.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(lines(warnSpy)).toEqual([
      "⚠ Step 'refund': input_map 'amount_cents' reads step 'propose', which this step does not " +
        "depend on, so it may not have run yet; add 'propose' to depends_on if this step needs it. " +
        '(line 19)',
    ]);
    expect(lines(logSpy)).toContain('Valid: two v1 (2 steps)');

    logSpy.mockClear();
    await expect(
      validateCommand.parseAsync([write(NOT_A_DEPENDENCY), '--strict'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    // (1) red when the warning code is left out of --strict; (2) prints validate's output.
    expect(lines(logSpy)).toContain('Valid: two v1 (2 steps) — 1 warning; failing due to --strict');
  });

  it('check 16 on the command: three findings on three leaves are all printed, then one refusal', async () => {
    const yaml = TRIAL.replace(
      '      amount_cents: steps.propose.output.amount_cents\n',
      '      a: steps.propose.output.amount_cents\n' +
        '      b: context.resources.propsal.amount_cents\n' +
        '      c: run.paramz.order_id\n',
    );
    await expect(validateCommand.parseAsync([write(yaml)], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    // (1) red when the check stops at the first finding; (2) prints validate's error output.
    expect(lines(errSpy)).toEqual([
      "Invalid: 3 warnings, 3 escalated to an error by policy: INPUT_MAP_PATH_UNRESOLVABLE 'a', " +
        "INPUT_MAP_PATH_UNRESOLVABLE 'b', INPUT_MAP_PATH_UNRESOLVABLE 'c'",
    ]);
  });
});

describe('register and watch — fix 1, unit 1: a path that can never be found is refused', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-register-input-map-paths-'));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('check 18: `realm workflow register` on the trial file exits 1 and registers nothing', async () => {
    writeFileSync(join(dir, 'workflow.yaml'), TRIAL, 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);

    await expect(registerCommand.parseAsync([dir], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    // (1) red when the code's policy is 'warn': register prints `Registered`; (2) prints the calls.
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The first error line is the refusal (the mocked exit's throw lands in register's own catch,
    // which prints a second line that is this harness's, not the command's).
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0]))[0]).toBe(TRIAL_REFUSAL);
    expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain(
      'Registered:',
    );
    // (1) red under the same break: the store holds the workflow; (2) prints its ids.
    expect((await h.home.workflowStore.list()).map((d) => d.id)).toEqual([]);
  });

  it('check 18: `realm workflow watch` reports the same refusal on a save, and registers nothing', async () => {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(
      file,
      TRIAL.replace('steps.propose.output.amount_cents', 'context.resources.propose.amount_cents'),
      'utf8',
    );
    const registered: WorkflowDefinition[] = [];
    const store: WorkflowRegistrar = {
      async register(def) {
        registered.push(def);
      },
      async get(id) {
        const found = registered.find((d) => d.id === id);
        if (!found) throw new Error(`Not found: ${id}`);
        return found;
      },
      async list() {
        return registered;
      },
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = new AbortController();
    const watching = watchWorkflow(file, store, controller.signal);
    const errored = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    try {
      await until(() => registered.length === 1);
      // The correct file registers; the save of the trial's file is refused.
      expect(registered).toHaveLength(1);
      writeFileSync(file, TRIAL, 'utf8');
      await until(() => errored().includes('refusing to register'));
      // (1) red when the code's policy is 'warn': the save registers again; (2) prints the line.
      expect(errored()).toMatch(
        /^\[[^\]]+\] Invalid: 1 warning, 1 escalated to an error by policy: INPUT_MAP_PATH_UNRESOLVABLE 'amount_cents' — refusing to register\.$/m,
      );
      expect(registered).toHaveLength(1);
    } finally {
      controller.abort();
      await watching;
    }
  }, 20_000);
});

describe('run — fix 1, unit 1: running a file stays lenient', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-run-input-map-paths-'));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('check 17: `realm workflow run` loads the trial file, prints the finding as a warning, and creates the run', async () => {
    // The first step's `when` is never true, so nothing is eligible and the loop stalls before any
    // prompt (the run-loader-voice.test.ts pattern); the terminal flag lets the dev guard through.
    const file = join(dir, 'workflow.yaml');
    writeFileSync(
      file,
      TRIAL.replace(
        '    execution: agent\n',
        "    execution: agent\n    when: 'run.params.never_true == true'\n",
      ),
      'utf8',
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
    const savedIsTTY = process.stdin.isTTY;
    try {
      process.stdin.isTTY = true;
      await expect(runCommand.parseAsync([file], { from: 'user' })).rejects.toThrow('process.exit');
    } finally {
      process.stdin.isTTY = savedIsTTY;
    }
    // (1) red when the finding is pushed to the loader's errors: the run refuses and no run is
    //     created; (2) prints the run ids.
    expect(await runIds(h.home.runStore)).toHaveLength(1);
    // (1) red under the same break, or when run stops printing loader warnings; (2) prints them.
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(
      TRIAL_FINDING.replace('(line 20)', '(line 21)'),
    );
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain(
      'Invalid workflow',
    );
  });
});

describe('fix 1, unit 1 — the words the docs and the changelog carry (check 20)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  function claim(page: string, sentence: string): void {
    expect(
      flat(readFileSync(join(ROOT, page), 'utf8')).includes(flat(sentence)),
      `${page} no longer says: ${sentence}`,
    ).toBe(true);
  }

  it("input-map-and-templates.md quotes what validate prints for the trial's file (check 1's lines)", () => {
    // (1) red when the docs block and the build part ways; (2) prints the missing text. The lines
    //     themselves are executed by check 1 above.
    const page = readFileSync(
      join(ROOT, 'docs/reference/workflow/input-map-and-templates.md'),
      'utf8',
    );
    expect(page).toContain(`\`\`\`text\n${TRIAL_FINDING}\n${TRIAL_REFUSAL}\n\`\`\``);
  });

  it('input-map-and-templates.md: the Rules bullet and the new section say what validate checks', () => {
    // (1) red when a page no longer says it; (2) prints the sentence. Each claim is executed by a
    //     cell here or in core's input-map-paths.test.ts.
    claim(
      'docs/reference/workflow/input-map-and-templates.md',
      "When the step runs there is no error and no warning — unless the step's `input_schema` requires the key",
    );
    claim(
      'docs/reference/workflow/input-map-and-templates.md',
      'When the file is checked, a path that can never be found is refused and one that may be absent is warned (see [What `validate` checks in `input_map`](#what-validate-checks-in-input_map)). A path without one of the roots above, such as `order.id`, finds nothing, and `validate` refuses it.',
    );
    claim(
      'docs/reference/workflow/input-map-and-templates.md',
      "A path that may be absent when the step runs gets a warning. Examples: an optional field, a list position, a step that is not a dependency, or a step the trigger rule may let this one run without. A path into data the workflow declares no shape for, such as a handler's output, is listed as not checked. Running a workflow does not refuse these: `realm workflow run`, `realm agent` and `realm listen` print them as warnings. This was added after version 0.49.0.",
    );
  });

  it('loader-diagnostics.md: 21 codes, 3 of them errors, the two new rows and `not_checked`', () => {
    // (1) red when the page's counts or rows part from DEFAULT_POLICY (core's diagnostics.test.ts
    //     counts the codes); (2) prints the sentence.
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      'The loader has 21 warning codes. 3 of them count as errors: an unknown key at the top of the file or on a step, and an `input_map` path that can never be found, make `validate` and `register` fail.',
    );
    claim('docs/reference/workflow/loader-diagnostics.md', 'lists all 21 warning codes');
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `INPUT_MAP_PATH_UNRESOLVABLE` | Error | An `input_map` path can never be found. Added after version 0.49.0. |',
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `INPUT_MAP_PATH_UNCERTAIN` | Warning | An `input_map` path may be absent when the step runs. Added after version 0.49.0. |',
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `not_checked` | The `input_map` paths into data the workflow declares no shape for: `step`, `key`, `path`, `why`. Added after version 0.49.0. |',
    );
  });

  it('CHANGELOG.md carries the line', () => {
    // (1) red when the changelog line is changed or lost; (2) prints the sentence.
    claim(
      'CHANGELOG.md',
      "- **`realm workflow validate`, `register` and `watch` refuse an `input_map` path that can never be found**, with its line and the right spelling (for example `steps.propose.output.amount_cents`, written as `context.resources.propose.amount_cents`). A path that may be absent gets a warning, and a path into data the workflow declares no shape for, such as a handler's output, is listed as not checked (`not_checked` in `--json`). Running a workflow is not refused; `realm workflow run`, `realm agent` and `realm listen` print these as warnings.",
    );
  });
});

/** Waits until `cond()` holds, polling (watch.test.ts's helper). */
async function until(cond: () => boolean, capMs = 5000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
