// Fix 1, unit 1 (data paths) — on the built commands. An `input_map` path that can never be found
// is refused by `validate`, `register` and `watch` (the #170 boundary: its warning code's policy
// is 'error'); `realm workflow run` prints it as a warning and goes on. A path into data the
// workflow declares no shape for is listed after the result line, and in `--json` `not_checked`.
// In-process via commander's parseAsync, the pattern of validate-gate-dead-block.test.ts. The
// loader-level cells (every row, every `<why>`) are core's input-map-paths.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowRegistrar, WorkflowDefinition } from '@sensigo/realm';
// The built core's resolver, the very module `@sensigo/realm` loads: check 5 plants a throw in it.
import { PathIndex } from '../../../core/dist/workflow/path-resolver.js';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { runCommand } from './run.js';
import { watchWorkflow } from './watch.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';
import { changelogPart, changelogSectionsAbove } from '../test-support/changelog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Fix 1, piece 4: the project in `folder` provides each handler in `names` (a `realm.yaml` entry each,
 * built from a module beside it), so `validate`, `register` and `watch` do not warn that the file's
 * handlers are not ones the project provides.
 */
function provide(folder: string, names: readonly string[]): void {
  writeFileSync(
    join(folder, 'handlers.mjs'),
    'export function makeHandler({ id }) { return { id, execute: async () => ({ data: {} }) }; }\n',
    'utf8',
  );
  writeFileSync(
    join(folder, 'realm.yaml'),
    [
      'version: 1',
      'handlers:',
      ...names.flatMap((n) => [`  ${n}:`, '    use: ./handlers.mjs#makeHandler']),
    ].join('\n') + '\n',
    'utf8',
  );
}

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
    provide(dir, ['send_refund']);
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
    provide(dir, ['send_refund']);
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
    provide(dir, ['fetch_order', 'send_refund']);
    await validateCommand.parseAsync([write(HANDLER_OUTPUT)], { from: 'user' });
    // (1) red when the handler's input_schema is read as its output (a refusal: exit 1);
    //     (2) prints the calls.
    expect(exitSpy).not.toHaveBeenCalled();
    expect(lines(warnSpy)).toEqual([]);
    // (1) red when the line is not printed, or its words change; (2) prints validate's output.
    expect(lines(logSpy)).toContain(
      'Not checked: 1 input_map path(s) into data the workflow declares no shape for: refund.amount',
    );
    // (1) red when the line comes before the result line, or the result line is missing
    //     (correction 1, check 9); (2) prints validate's output.
    expect(
      lines(logSpy).filter((l) => l.startsWith('Valid: orders v1') || l.startsWith('Not checked:')),
    ).toEqual([
      'Valid: orders v1 (2 steps)',
      'Not checked: 1 input_map path(s) into data the workflow declares no shape for: refund.amount',
    ]);
  });

  it('check 11, --json: `not_checked` names the step, key, path and why', async () => {
    await validateCommand.parseAsync([write(HANDLER_OUTPUT), '--json'], { from: 'user' });
    const out = JSON.parse(lines(logSpy).join('\n')) as Record<string, unknown>;
    // (1) red when not_checked is left off the --json or a field of it changes; (2) prints it.
    expect({ valid: out['valid'], not_checked: out['not_checked'] }).toEqual({
      valid: true,
      not_checked: [
        {
          surface: 'input_map',
          step: 'refund',
          key: 'amount',
          path: 'context.resources.fetch.total',
          why: 'producer_declares_no_shape',
        },
      ],
    });
  });

  it('a path that may be absent leaves the file Valid, with its warning; --strict fails on it', async () => {
    provide(dir, ['send_refund']);
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
    provide(dir, ['send_refund']);
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
    provide(dir, ['send_refund']);
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
    provide(dir, ['send_refund']);
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
      "A path that may be absent when the step runs gets a warning. Examples: an optional field, a list position, a step that is not a dependency, or a step the trigger rule may let this one run without. `validate` lists a path into data the workflow declares no shape for, such as a handler's output, as not checked. Running a workflow does not refuse these: `realm workflow run`, `realm agent` and `realm listen` print them as warnings. This was added after version 0.49.0.",
    );
  });

  it('loader-diagnostics.md: 21 codes, 3 of them errors, the two new rows and `not_checked`', () => {
    // (1) red when the page's counts or rows part from DEFAULT_POLICY (core's diagnostics.test.ts
    //     counts the codes); (2) prints the sentence.
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      "The loader has 36 warning codes. Twelve of them count as errors and make `validate`, `register` and `watch` fail: an unknown key at the top of the file or on a step; an `input_map` path that can never be found; a `when` condition that reads a path that can never be found or compares a gate's answer with a choice it does not offer; a webhook `params_map` that names a parameter a closed `params_schema` does not have, or leaves a required one unfilled; a template that uses a filter Realm does not have, gives a filter an argument no value accepts, or is not text; and a path in an approval question, `display`, a prompt or step instructions that can never be found, or one in an approval question that may be missing, unless `| default` comes first in its filters and the filters after it take its value.",
    );
    claim('docs/reference/workflow/loader-diagnostics.md', 'lists all 36 warning codes');
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
      "| `not_checked` | The `input_map` paths, `when` conditions and template references (in `gate.message`, `display`, `prompt` and `instructions`) that read data the workflow declares no shape for, or a context entry only a file adds: `surface` (`input_map`, `when` or `template`), `step`, `key` (`when` for a condition, the field's name for a template), `path`, `why` (`producer_declares_no_shape`, `no_params_schema`, `added_from_file`, or `check_failed` when the check itself failed on that path). Empty when the file could not be loaded. Added after version 0.49.0. |",
    );
  });

  it('CHANGELOG.md carries the line and both Upgrading items', () => {
    // (1) red when the changelog line or an Upgrading item is changed or lost; (2) prints the
    //     sentence.
    claim(
      'CHANGELOG.md',
      "- **BREAKING: `realm workflow validate`, `register` and `watch` refuse an `input_map` path that can never be found**, with its line and the right spelling (for example `steps.propose.output.amount_cents`, written as `context.resources.propose.amount_cents`). Such a path never found a value: the step received nothing for that key. A path that may be absent gets a warning, and `validate` lists a path into data the workflow declares no shape for, such as a handler's output, as not checked (`not_checked` in `--json`). Running a workflow is not refused; `realm workflow run`, `realm agent` and `realm listen` print these as warnings. Upgrading: `realm workflow validate --registered <id>` reports a copy registered before this release; that copy keeps running as it was, and registering it again needs the fix.",
    );
    claim(
      'CHANGELOG.md',
      '**2. `register` and `watch` refuse an `input_map` path that can never be found.** Run `realm workflow validate` on each file, or `realm workflow validate --registered <id>` on each stored workflow, and write the path the refusal names. Such a path never found a value. A stored copy keeps running as it was until you register it again.',
    );
    claim(
      'CHANGELOG.md',
      '**3. A `gate:` block on a step that declares no gate trust is refused when the file is loaded.** Set `trust: human_confirmed` on the step, or remove the block, as its refusal says; `realm workflow validate --registered <id>` reports a stored copy.',
    );
    // The two items sit in [Unreleased]'s Upgrading section, as its items 2 and 3.
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    // Each section above [0.49.0] (`[Unreleased]` while a cycle is open, then 0.50.0's) numbers
    // its own Upgrading list.
    const lists = changelogSectionsAbove(changelog, '0.49.0')
      .map((s) =>
        [...changelogPart(s, 'Upgrading').matchAll(/^\*\*(\d+)\. /gm)].map((m) => Number(m[1])),
      )
      .filter((numbers) => numbers.length > 0);
    // (1) red when an item is lost from the middle, two items share a number, or no list reaches
    // this file's own item 3; (2) prints the lists found. Each item's own text is pinned by the
    // file that added it, so a new item moves no pin here.
    expect({
      lists,
      runs: lists.every((numbers) => numbers.every((n, i) => n === i + 1)),
      reaches3: lists.some((numbers) => numbers.length >= 3),
    }).toEqual({ lists, runs: true, reaches3: true });
  });
});

/** Waits until `cond()` holds, polling (watch.test.ts's helper). */
async function until(cond: () => boolean, capMs = 5000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ── Fix 1, unit 1, correction 1 (prompts/ai-authoring-fix1-u1-correction-1.md) ──────────────────

const CLI = join(ROOT, 'packages/cli/dist/index.js');

/** The built `realm workflow validate` on `yaml`, in a fresh HOME, bounded by `timeoutMs`. */
function validateBuilt(
  yaml: string,
  timeoutMs: number,
): { out: string; code: number | null; ms: number } {
  const folder = mkdtempSync(join(tmpdir(), 'realm-c1-built-'));
  try {
    const file = join(folder, 'workflow.yaml');
    writeFileSync(file, yaml, 'utf8');
    const started = Date.now();
    const r = spawnSync(process.execPath, [CLI, 'workflow', 'validate', file], {
      env: { ...process.env, HOME: folder, REALM_NO_NUDGE: '1' },
      encoding: 'utf8',
      timeout: timeoutMs,
      // SIGKILL: the CLI handles SIGTERM, which a walk that never ends would never get to run.
      killSignal: 'SIGKILL',
    });
    return { out: `${r.stdout}${r.stderr}`, code: r.status, ms: Date.now() - started };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** A file refused by policy (one path that can never be found) that also reads a handler's output. */
const REFUSED_WITH_HANDLER_READ = `id: refused
name: Refused
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
  fetch:
    description: Fetch
    execution: auto
    handler: fetch_order
  refund:
    description: Refund
    execution: auto
    handler: send_refund
    depends_on: [propose, fetch]
    input_map:
      amount_cents: steps.propose.output.amount_cents
      total: context.resources.fetch.total
`;
const HANDLER_READ = {
  surface: 'input_map',
  step: 'refund',
  key: 'total',
  path: 'context.resources.fetch.total',
  why: 'producer_declares_no_shape',
};

describe('validate — fix 1, unit 1, correction 1: `not_checked` on a refused file (check 3, N2)', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-c1-n2-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((): never => {
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

  const json = (): Record<string, unknown> =>
    JSON.parse(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')) as Record<
      string,
      unknown
    >;

  it('file mode: `--json` on a file refused by policy lists the path it could not check', async () => {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, REFUSED_WITH_HANDLER_READ, 'utf8');
    await expect(validateCommand.parseAsync([file, '--json'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    const out = json();
    // (1) red when the escalation arm passes `[]`; (2) prints the verdict and the list.
    expect({ valid: out['valid'], not_checked: out['not_checked'] }).toEqual({
      valid: false,
      not_checked: [HANDLER_READ],
    });
  });

  it('`--registered --json` on a stored copy refused by policy does the same', async () => {
    const steps = {
      propose: {
        description: 'Propose',
        execution: 'agent',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          required: ['amount_cents'],
          properties: { amount_cents: { type: 'integer' } },
        },
      },
      fetch: { description: 'Fetch', execution: 'auto', handler: 'fetch_order' },
      refund: {
        description: 'Refund',
        execution: 'auto',
        handler: 'send_refund',
        depends_on: ['propose', 'fetch'],
        input_map: {
          amount_cents: 'steps.propose.output.amount_cents',
          total: 'context.resources.fetch.total',
        },
      },
    };
    // A copy stored before this release: the registry is written directly, past the loader that
    // would refuse it today (validate-registered.test.ts's seeding).
    await h.home.workflowStore.register({
      id: 'refused',
      name: 'Refused',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps,
    } as never);
    await expect(
      validateCommand.parseAsync(['--registered', 'refused', '--json'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    const out = json();
    // (1) red when the registered escalation arm passes `[]`; (2) prints the verdict and the list.
    expect({ valid: out['valid'], not_checked: out['not_checked'] }).toEqual({
      valid: false,
      not_checked: [HANDLER_READ],
    });
  });

  it("twin: a file refused through the loader's errors (an unknown `depends_on`) gives `not_checked: []`", async () => {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(
      file,
      REFUSED_WITH_HANDLER_READ.replace(
        'depends_on: [propose, fetch]',
        'depends_on: [propose, fetch, nowhere]',
      ),
      'utf8',
    );
    await expect(validateCommand.parseAsync([file, '--json'], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    const out = json();
    // (1) red when a load that threw reports a list; (2) prints the verdict and the list.
    expect({ valid: out['valid'], not_checked: out['not_checked'] }).toEqual({
      valid: false,
      not_checked: [],
    });
  });
});

describe('validate (built) — fix 1, unit 1, correction 1: N3, cycles and a long chain', () => {
  it("check 4c: a cycle a ↔ b with a reader: the cycle refusal and the reader's findings, in time", () => {
    // The audit's wf/cycle (AA-AUC1U-05).
    const r = validateBuilt(
      `id: cyc
name: Cycle
version: 1
steps:
  a:
    description: a
    execution: auto
    depends_on: [b]
  b:
    description: b
    execution: auto
    depends_on: [a]
  r:
    description: r
    execution: auto
    handler: h
    depends_on: [a]
    trigger_rule: none_failed
    input_map:
      x: context.resources.a.f
      y: context.resources.b.g
`,
      20_000,
    );
    // (1) red when the shape walk's guard against revisiting a step is removed (the walk never
    //     ends, so the bound kills it: no output, no exit code); (2) prints the output.
    expect({ code: r.code, lines: r.out.trim().split('\n') }).toEqual({
      code: 1,
      lines: [
        "⚠ Step 'r': input_map 'x' reads 'context.resources.a.f', which may be absent when this step runs (this step's trigger_rule lets it run when 'a' did not complete); the step then receives no value for 'x'. (line 20)",
        "⚠ Step 'r': input_map 'y' reads 'context.resources.b.g', which may be absent when this step runs (this step's trigger_rule lets it run when 'b' did not complete); the step then receives no value for 'y'. (line 21)",
        'Invalid workflow: Workflow has a dependency cycle: a → b → a',
      ],
    });
  }, 60_000);

  it("check 4c, second file: no safe path through the cycle; the warning names step 'd''s, in time", () => {
    // The audit's r2/cycle-safe (AA-AUC1U-26).
    const r = validateBuilt(
      `id: cyc2
name: Cycle through the safe-path search
version: 1
steps:
  c:
    description: c
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [f]
      properties:
        f: { type: string }
  d:
    description: d
    execution: auto
    trigger_rule: none_failed
    depends_on: [c]
  a:
    description: a
    execution: auto
    depends_on: [b]
  b:
    description: b
    execution: auto
    depends_on: [a, d]
  r2:
    description: r2
    execution: auto
    handler: h
    depends_on: [a]
    input_map:
      v: context.resources.c.f
`,
      20_000,
    );
    // (1) red when the search of the steps that reach 'c' loses its guard against revisiting a
    //     step (it never ends: no output, no exit code); (2) prints the output.
    expect({ code: r.code, lines: r.out.trim().split('\n') }).toEqual({
      code: 1,
      lines: [
        "⚠ Step 'r2': input_map 'v' reads 'context.resources.c.f', which may be absent when this step runs (step 'd''s trigger_rule lets it run when 'c' did not complete); the step then receives no value for 'v'. (line 33)",
        'Invalid workflow: Workflow has a dependency cycle: a → b → a',
      ],
    });
  }, 60_000);

  it('a cycle inside the safe set: a step reached safely twice is entered once, in time', () => {
    // `x` and `y` depend on each other, both `all_success`, and `x` on `p`: the walk out from `p`
    // reaches `x`, then `y`, then `x` again. The optional `note` is warned only once that walk has
    // ended and found `r` safe, so the warning shows the leaf was judged (a leaf the check failed
    // on would show nothing here, the file being refused for its cycle).
    const r = validateBuilt(
      `id: cyc3
name: A cycle the safe walk meets
version: 1
steps:
  p:
    description: p
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [f]
      properties:
        f: { type: string }
        note: { type: string }
  x:
    description: x
    execution: auto
    depends_on: [p, y]
  y:
    description: y
    execution: auto
    depends_on: [x]
  r:
    description: r
    execution: auto
    handler: h
    depends_on: [y]
    input_map:
      v: context.resources.p.f
      w: context.resources.p.note
`,
      20_000,
    );
    // (1) red when the safe walk's guard against entering a step twice is removed (its queue grows
    //     until it throws, and the leaf turns `check_failed`: no warning); (2) prints the output.
    expect({ code: r.code, lines: r.out.trim().split('\n') }).toEqual({
      code: 1,
      lines: [
        "⚠ Step 'r': input_map 'w' reads 'context.resources.p.note', which may be absent when this step runs ('note' is optional in its schema); the step then receives no value for 'w'. (line 30)",
        'Invalid workflow: Workflow has a dependency cycle: x → y → x',
      ],
    });
  }, 60_000);

  it("check 4d: the walk's 1,000-step chain, every step reading s0, validates within 30 seconds", () => {
    // perf/gen.py's `chain 1000` (65 s on 30d9d718, AA-WU1-15).
    const out = [
      'id: big',
      'name: Big',
      'version: 1',
      'steps:',
      '  s0:',
      '    description: s0',
      '    execution: agent',
      '    input_schema:',
      '      type: object',
      '      additionalProperties: false',
      '      required: [f]',
      '      properties:',
      '        f: { type: string }',
    ];
    for (let i = 1; i < 1000; i++) {
      out.push(
        `  s${i}:`,
        `    description: s${i}`,
        '    execution: auto',
        '    handler: h',
        `    depends_on: [s${i - 1}]`,
        '    input_map:',
        '      v: context.resources.s0.f',
      );
    }
    const r = validateBuilt(out.join('\n') + '\n', 30_000);
    // (1) red when the per-leaf work grows with the chain (the bound kills the run), or a leaf is
    //     left not checked; (2) prints the exit code, the first line, any not-checked line and the
    //     time.
    expect({
      code: r.code,
      first: r.out.split('\n')[0],
      notChecked: r.out.split('\n').filter((l) => l.startsWith('Not checked:')),
    }).toEqual({ code: 0, first: 'Valid: big v1 (1000 steps)', notChecked: [] });
    expect(r.ms).toBeLessThan(30_000);
  }, 60_000);
});

describe('validate — fix 1, unit 1, correction 1: the path check failed on a leaf (check 5)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'realm-c1-check-failed-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
    // The injection: the built core's shared index throws for the step 'bad' only (the class is
    // the one `@sensigo/realm` loads, so the spy reaches the loader `validate` calls).
    const original = PathIndex.prototype.stepCause;
    vi.spyOn(PathIndex.prototype, 'stepCause').mockImplementation(function (
      this: PathIndex,
      reader: string,
      s: string,
      settlement: boolean,
    ) {
      if (reader === 'bad') throw new Error('planted: a bug in the path check');
      return original.call(this, reader, s, settlement);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** propose (an agent step), fetch (a handler), `bad` reading propose, `good` reading it unsafely. */
  const fixture = (goodReadsHandler: boolean): string => `id: planted
name: Planted
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
  fetch:
    description: Fetch
    execution: auto
    handler: fetch_order
  bad:
    description: Bad
    execution: auto
    handler: h
    depends_on: [propose]
    input_map:
      x: context.resources.propose.amount_cents
  good:
    description: Good
    execution: auto
    handler: h
    depends_on: [fetch]
    input_map:
      y: context.resources.propose.amount_cents
${goodReadsHandler ? '      z: context.resources.fetch.total\n' : ''}`;

  async function validate(yaml: string): Promise<string[]> {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, yaml, 'utf8');
    await validateCommand.parseAsync([file], { from: 'user' });
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  }

  it('the load succeeds, the new line names the leaf, and the shape line is absent with no shape-reason path', async () => {
    const out = await validate(fixture(false));
    // (1) red when there is no catch (the load fails and validate throws); (2) prints the lines.
    expect(out.filter((l) => l.startsWith('Valid:') || l.startsWith('Not checked:'))).toEqual([
      'Valid: planted v1 (4 steps)',
      "Not checked: 1 input_map path(s), because Realm's own check failed on them: bad.x",
    ]);
  });

  it('beside a shape-reason path: the shape line counts and names only that one', async () => {
    const out = await validate(fixture(true));
    // (1) red when the shape line counts every `not_checked` entry; (2) prints the lines.
    expect(out.filter((l) => l.startsWith('Not checked:'))).toEqual([
      'Not checked: 1 input_map path(s) into data the workflow declares no shape for: good.z',
      "Not checked: 1 input_map path(s), because Realm's own check failed on them: bad.x",
    ]);
  });
});
