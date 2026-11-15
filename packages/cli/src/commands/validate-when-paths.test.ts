// Fix 1, piece 2a — `when` conditions checked against what the workflow declares, on the built
// commands. A condition that can never find what it reads, or that compares a gate's answer with a
// choice the gate does not offer, is refused by `validate` and `register` (its codes' policy is
// 'error'); `realm workflow run` prints it as a warning and goes on. A condition on data the workflow
// declares no shape for is listed after unit 1's lines. In-process via commander's parseAsync, as
// validate-input-map-paths.test.ts; the loader-level cells are core's when-paths.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import { validateCommand } from './validate.js';
import { registerCommand } from './register.js';
import { runCommand } from './run.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';
// The built core's resolver, the very module `@sensigo/realm` loads: check 10 plants a throw in it.
import { PathIndex } from '../../../core/dist/workflow/path-resolver.js';

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

/** Check 1's file: a misspelt field of a closed answer, read by a `when`. */
const SLIP = `id: triage
name: Triage
version: 1
steps:
  classify:
    description: Classify the ticket
    execution: agent
    input_schema:
      type: object
      additionalProperties: false
      required: [category]
      properties:
        category: { type: string }
  escalate:
    description: Escalate a bug
    execution: auto
    handler: escalate
    depends_on: [classify]
    when: "classify.categry == 'bug'"
`;
const SLIP_FINDING =
  "⚠ Step 'escalate': when 'classify.categry == 'bug'' reads 'classify.categry', which can never " +
  "be found: step 'classify' has no field 'categry' there, and its schema allows no other fields. " +
  "This condition is never true, so the step is always skipped. Did you mean 'category'? (line 19)";
const SLIP_REFUSAL =
  "Invalid: 1 warning, 1 escalated to an error by policy: WHEN_PATH_UNRESOLVABLE 'when'";

/** A condition on a handler's output, beside an `input_map` read of it: both not checked. */
const HANDLER_READ = `id: orders
name: Orders
version: 1
steps:
  fetch:
    description: Fetch the order
    execution: auto
    handler: fetch_order
  refund:
    description: Refund it
    execution: auto
    handler: send_refund
    depends_on: [fetch]
    when: 'fetch.total > 10'
    input_map:
      amount: context.resources.fetch.total
`;

describe('validate and register — fix 1, piece 2a: `when` conditions', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'realm-validate-when-paths-'));
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

  it('check 1: `validate` exits 1 with the finding, its line and the fix, then the refusal', async () => {
    provide(dir, ['escalate']);
    await expect(validateCommand.parseAsync([write(SLIP)], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    // (1) red when `when` leaves are not judged (exit 0, "Valid"); (2) prints the calls.
    expect(exitSpy).toHaveBeenCalledWith(1);
    // (1) red when the message, its did-you-mean or its line change; (2) prints the warnings.
    expect(lines(warnSpy)).toEqual([SLIP_FINDING]);
    // (1) red when the code's policy is 'warn', or the finding carries another key; (2) prints them.
    expect(lines(errSpy)).toEqual([SLIP_REFUSAL]);
  });

  it('check 1: `register` exits 1 and stores nothing', async () => {
    provide(dir, ['escalate']);
    write(SLIP);
    await expect(registerCommand.parseAsync([dir], { from: 'user' })).rejects.toThrow(
      'process.exit',
    );
    // (1) red when the code's policy is 'warn' (register stores it); (2) prints the calls.
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The first error line is the refusal (the mocked exit's throw lands in register's own catch).
    expect(lines(errSpy)[0]).toBe(SLIP_REFUSAL);
    expect((await h.home.workflowStore.list()).map((d) => d.id)).toEqual([]);
  });

  it("check 8: a condition on a handler's output is listed on its own line, after unit 1's", async () => {
    await validateCommand.parseAsync([write(HANDLER_READ)], { from: 'user' });
    // (1) red when `when` leaves are not listed, or the lines change order; (2) prints them.
    expect(
      lines(logSpy).filter((l) => l.startsWith('Valid:') || l.startsWith('Not checked:')),
    ).toEqual([
      'Valid: orders v1 (2 steps)',
      'Not checked: 1 input_map path(s) into data the workflow declares no shape for: refund.amount',
      'Not checked: 1 when condition(s) on data the workflow declares no shape for: refund: fetch.total',
    ]);
  });

  it('check 8, --json: every `not_checked` entry carries `surface`', async () => {
    await validateCommand.parseAsync([write(HANDLER_READ), '--json'], { from: 'user' });
    const out = JSON.parse(lines(logSpy).join('\n')) as Record<string, unknown>;
    // (1) red when the `when` entry is missing or an entry has no surface; (2) prints them.
    expect(out['not_checked']).toEqual([
      {
        surface: 'input_map',
        step: 'refund',
        key: 'amount',
        path: 'context.resources.fetch.total',
        why: 'producer_declares_no_shape',
      },
      {
        surface: 'when',
        step: 'refund',
        key: 'when',
        path: 'fetch.total',
        why: 'producer_declares_no_shape',
      },
    ]);
  });

  it('check 10: a throw while judging a `when` leaf: Valid, and the failed-check line names it', async () => {
    // The injection: the built core's shared index throws for the step 'escalate' only.
    const original = PathIndex.prototype.stepCause;
    vi.spyOn(PathIndex.prototype, 'stepCause').mockImplementation(function (
      this: PathIndex,
      reader: string,
      s: string,
      settlement: boolean,
    ) {
      if (reader === 'escalate') throw new Error('planted: a bug in the when check');
      return original.call(this, reader, s, settlement);
    });
    await validateCommand.parseAsync(
      [write(SLIP.replace("classify.categry == 'bug'", "classify.category == 'bug'"))],
      { from: 'user' },
    );
    // (1) red when there is no catch around a `when` leaf (validate throws); (2) prints the lines.
    expect(
      lines(logSpy).filter((l) => l.startsWith('Valid:') || l.startsWith('Not checked:')),
    ).toEqual([
      'Valid: triage v1 (2 steps)',
      "Not checked: 1 when condition(s), because Realm's own check failed on them: escalate: classify.category",
    ]);
  });
  it('check 13, the Upgrading item: `validate --registered <id>` refuses a stored copy whose condition cannot work', async () => {
    // A copy stored before this release: the registry is written directly, past the loader that
    // would refuse it today (validate-registered.test.ts's seeding).
    await h.home.workflowStore.register({
      id: 'triage',
      name: 'Triage',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        classify: {
          description: 'Classify the ticket',
          execution: 'agent',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['category'],
            properties: { category: { type: 'string' } },
          },
        },
        escalate: {
          description: 'Escalate a bug',
          execution: 'auto',
          handler: 'escalate',
          depends_on: ['classify'],
          when: "classify.categry == 'bug'",
        },
      },
    } as never);
    await expect(
      validateCommand.parseAsync(['--registered', 'triage', '--json'], { from: 'user' }),
    ).rejects.toThrow('process.exit');
    const out = JSON.parse(lines(logSpy).join('\n')) as {
      valid: boolean;
      diagnostics: { code: string; key?: string }[];
    };
    // (1) red when a stored copy's conditions are not judged; (2) prints the verdict and the codes.
    expect({
      valid: out.valid,
      codes: out.diagnostics
        .filter((d) => d.code.startsWith('WHEN_'))
        .map((d) => `${d.code} ${d.key}`),
    }).toEqual({ valid: false, codes: ['WHEN_PATH_UNRESOLVABLE when'] });
  });
});

describe('run — fix 1, piece 2a: running a file stays lenient', () => {
  let h: TempHome & { readonly root: string };
  let originalHome: string | undefined;
  let dir: string;

  beforeEach(async () => {
    h = await makeTempHome();
    originalHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    dir = mkdtempSync(join(tmpdir(), 'realm-run-when-paths-'));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    vi.restoreAllMocks();
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it("check 11: `realm workflow run` on check 1's file runs and prints the finding as a warning", async () => {
    // The first step's own `when` is never true, so nothing is eligible and the loop stalls before
    // any prompt (unit 1's run cell); the terminal flag lets the dev guard through.
    const file = join(dir, 'workflow.yaml');
    writeFileSync(
      file,
      SLIP.replace(
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
    // (1) red when the escalation is applied at run: no run is created; (2) prints the run ids.
    expect(await runIds(h.home.runStore)).toHaveLength(1);
    // (1) red under the same break, or when run stops printing loader warnings; (2) prints them.
    expect(warnSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toContain(
      SLIP_FINDING.replace('(line 19)', '(line 20)'),
    );
    expect(errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).not.toContain(
      'Invalid workflow',
    );
  });
});

describe('fix 1, piece 2a — the words the docs and the changelog carry (check 13)', () => {
  const flat = (s: string): string => s.replace(/\s+/g, ' ');
  function claim(page: string, sentence: string): void {
    expect(
      flat(readFileSync(join(ROOT, page), 'utf8')).includes(flat(sentence)),
      `${page} no longer says: ${sentence}`,
    ).toBe(true);
  }

  it('loader-diagnostics.md: 29 codes, seven of them errors, the three `when` rows and `not_checked`', () => {
    // (1) red when a sentence or row is changed or lost; (2) prints it.
    claim('docs/reference/workflow/loader-diagnostics.md', 'lists all 29 warning codes');
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      "The loader has 29 warning codes. Seven of them count as errors and make `validate`, `register` and `watch` fail: an unknown key at the top of the file or on a step; an `input_map` path that can never be found; a `when` condition that reads a path that can never be found or compares a gate's answer with a choice it does not offer; and a webhook `params_map` that names a parameter a closed `params_schema` does not have, or leaves a required one unfilled.",
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `WHEN_PATH_UNRESOLVABLE` | Error | A `when` condition reads a path that can never be found. Added after version 0.49.0. |',
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      "| `WHEN_CHOICE_NOT_OFFERED` | Error | A `when` condition compares a gate's answer with a choice the gate does not offer. Added after version 0.49.0. |",
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `WHEN_PATH_UNCERTAIN` | Warning | A `when` condition reads a path that may be absent. Added after version 0.49.0. |',
    );
    claim(
      'docs/reference/workflow/loader-diagnostics.md',
      '| `not_checked` | The `input_map` paths and `when` conditions that read data the workflow declares no shape for: `surface` (`input_map` or `when`), `step`, `key` (`when` for a condition), `path`, `why` (`producer_declares_no_shape`, `no_params_schema`, or `check_failed` when the check itself failed on that path). Empty when the file could not be loaded. Added after version 0.49.0. |',
    );
  });

  it('loader-diagnostics.md: the table has one row per code, 29 (`DEFAULT_POLICY` in core)', () => {
    const page = readFileSync(join(ROOT, 'docs/reference/workflow/loader-diagnostics.md'), 'utf8');
    const rows = page.split('\n').filter((l) => /^\| `[A-Z][A-Z_]+` +\| (Error|Warning) /.test(l));
    // (1) red when a row is missing or doubled; (2) prints the count.
    expect(rows.length).toBe(29);
  });

  it('conditions.md: the new rule and the changed sentence', () => {
    claim(
      'docs/reference/workflow/conditions.md',
      "A `when` path is also checked against what the workflow declares: a field a closed schema does not have, a `$settlement` field other than its three, or a parameter a closed `params_schema` does not have is refused, and so is a comparison of a gate's `choice` with a choice the gate does not offer (for a gate that offers `refund` and `deny`, `approve.choice == 'refnd'` gets \"Did you mean 'refund'?\"). A path that may be absent gets a warning, unless the condition tests it with `== null` or `!= null`, or reads `$settlement`. Running a workflow does not refuse these. This was added after version 0.49.0.",
    );
    claim(
      'docs/reference/workflow/conditions.md',
      "A misspelt field of a handler's output is not checked, and one of a schema that allows other fields gets only a warning: when the workflow runs, each is a path that finds nothing.",
    );
    // (1) red when the old sentence is left beside the new one; (2) prints the check.
    expect(
      flat(readFileSync(join(ROOT, 'docs/reference/workflow/conditions.md'), 'utf8')).includes(
        'Field names are not checked. A misspelt field is a path that finds nothing.',
      ),
    ).toBe(false);
  });

  it('CHANGELOG.md: the line under Changed, and the Upgrading item numbered after the last', () => {
    claim(
      'CHANGELOG.md',
      "- **BREAKING: `realm workflow validate`, `register` and `watch` refuse a `when` condition that reads a path that can never be found, or that compares a gate's answer with a choice the gate does not offer**, with its line and a did-you-mean (for example `approve.choice == 'refnd'`: \"Did you mean 'refund'?\"). Such a condition never worked as written. A path that may be absent gets a warning, and `validate` lists a condition on data the workflow declares no shape for as not checked; `not_checked` entries in `--json` now carry `surface`. Running a workflow is not refused.",
    );
    claim(
      'CHANGELOG.md',
      '**5. `register` and `watch` refuse a `when` condition that cannot work as written, because of what it reads or compares.** Run `realm workflow validate` on each file, or `realm workflow validate --registered <id>` on each stored workflow, and fix the condition the refusal names. A stored copy keeps running as it was until you register it again.',
    );
    const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
    const unreleased = changelog.slice(
      changelog.indexOf('## [Unreleased]'),
      changelog.indexOf('\n## [', changelog.indexOf('## [Unreleased]') + 1),
    );
    const upgrading = unreleased.slice(
      unreleased.indexOf('### Upgrading'),
      unreleased.indexOf('\n### ', unreleased.indexOf('### Upgrading') + 1),
    );
    // (1) red when the item is misnumbered or lost; (2) prints the numbers.
    expect(upgrading.match(/^\*\*\d+\. /gm)).toEqual([
      '**1. ',
      '**2. ',
      '**3. ',
      '**4. ',
      '**5. ',
      '**6. ',
    ]);
  });
});
