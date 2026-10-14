// damaged-run-719.test.ts — issue #719 (B3, B5): one damaged run file never takes a `realm run`
// command down. Every cell runs the BUILT CLI with a scratch HOME, on a real JSON store in it.
// Failure output is exit codes and stderr/stdout lines of fixtures that hold no secret; the leak
// cell asserts a boolean.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileStore, abandonRun, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

let home: string;
let runs: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'realm-719-cli-'));
  runs = join(home, '.realm', 'runs');
  mkdirSync(runs, { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function realm(args: string[]): { code: number | null; out: string; err: string[] } {
  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: home,
    env: { PATH: process.env['PATH'] ?? '', HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    code: r.status,
    out: r.stdout,
    err: r.stderr.split('\n').filter((l) => l !== ''),
  };
}

/** One readable run, of workflow `w`. */
async function readableRun(): Promise<string> {
  const { run } = await new JsonFileStore(runs).create({
    workflowId: 'w',
    workflowVersion: 1,
    params: {},
  });
  return run.id;
}

/** A readable run of workflow `w`, with `over` written into its file. */
async function runWith(over: Record<string, unknown>): Promise<string> {
  const id = await readableRun();
  const file = join(runs, `${id}.json`);
  const rec = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...rec, ...over }, null, 2));
  return id;
}

/** A file's bytes, as a hash — a cell compares two hashes, never the bytes. */
const hashOf = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

const BAD = 'bad';
const badPath = () => join(runs, `${BAD}.json`);
/** issue #719 (C2, F4): the way out of a file that is empty, not JSON or not a run — the path said
 *  once (in the fault sentence). `bad` is not a run id of 36 characters, so no side file is named. */
const wayOut = (_id: string) =>
  `Restore it from a backup or repair it: the run keeps its record and its idempotency key. Or ` +
  `move it out of '${runs}'. If it held an idempotency key, the next delivery with that key ` +
  `starts a new run.`;
const badLine = () => `⚠ The run file '${badPath()}' is not JSON. ${wayOut(BAD)}`;

describe('issue #719 — realm run list: the readable runs on stdout, each damaged file on stderr, exit 0', () => {
  it.each([[[]], [['--workflow', 'w']], [['--status', 'running']], [['--stuck']]])(
    'list %j',
    async (flags) => {
      const id = await readableRun();
      writeFileSync(badPath(), '{ not json');
      const r = realm(['run', 'list', ...flags]);
      // (a) red when the damaged file fails or crashes the listing, hides the run, or is not named
      //     with its way out; (b) prints the exit, whether the run is listed, and stderr.
      expect({ code: r.code, listed: r.out.includes(id), err: r.err }).toEqual({
        code: 0,
        listed: true,
        err: [badLine(), `⚠ 1 run file(s) in '${runs}' could not be read and are not listed.`],
      });
    },
  );

  it('every file damaged: stdout says No readable runs found.', () => {
    writeFileSync(badPath(), '{ not json');
    const r = realm(['run', 'list']);
    expect({ code: r.code, out: r.out.trim(), lines: r.err.length }).toEqual({
      code: 0,
      out: 'No readable runs found.',
      lines: 2,
    });
  });

  it.each([
    [['--workflow', 'other'], "No readable runs found for workflow 'other'."],
    [['--status', 'completed'], "No readable runs found for status 'completed'."],
    [
      ['--workflow', 'w', '--status', 'completed'],
      "No readable runs found for workflow 'w' and status 'completed'.",
    ],
  ])(
    'a filter no readable run matches, with a damaged file present: %j says "readable" and the filter (C2)',
    async (flags, text) => {
      await readableRun();
      writeFileSync(badPath(), '{ not json');
      const r = realm(['run', 'list', ...flags]);
      // (a) red when stdout says no run matched while a damaged file may be one (walk M5), or
      //     drops the filter; (b) prints the exit and stdout.
      expect({ code: r.code, out: r.out.trim() }).toEqual({ code: 0, out: text });
    },
  );

  it('guard: no damaged file and a filter that matches nothing: the shipped text', async () => {
    await readableRun();
    const r = realm(['run', 'list', '--workflow', 'other']);
    expect({ code: r.code, out: r.out.trim() }).toEqual({
      code: 0,
      out: "No runs found for workflow 'other'.",
    });
  });
});

describe('issue #719 — the commands that act on runs act on the readable ones and name the rest', () => {
  /** A registered copy of workflow `w` whose step `s` is idempotent (for `reclaim --all`). */
  const registerW = () => {
    const dir = join(home, '.realm', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'w.json'),
      JSON.stringify({
        id: 'w',
        name: 'w',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: { s: { description: 'S.', execution: 'auto', idempotent: true } },
      }),
    );
  };
  const DONE = {
    terminal_state: true,
    run_phase: 'completed',
    terminal_reason: 'Workflow completed.',
  };
  /** Each command: a readable run it acts on, its args, the stdout line that says it acted, its
   *  name in the count line, and its exit. */
  const BATCH: Array<
    [string, () => Promise<unknown>, string[], (id: string) => string, string, number]
  > = [
    [
      'cleanup',
      () => runWith({}),
      ['run', 'cleanup', '--older-than', '0m'],
      () => 'Marked 1 run(s) as abandoned.',
      'realm run cleanup',
      0,
    ],
    [
      'purge --force',
      async () => {
        const id = await readableRun();
        await abandonRun(new JsonFileStore(runs), id, 'old');
        return id;
      },
      ['run', 'purge', '--older-than', '0m', '--force'],
      () => 'Purged 1/1 run(s)',
      'realm run purge',
      0,
    ],
    [
      'reclaim --all',
      async () => {
        registerW();
        return runWith({
          in_progress_steps: ['s'],
          claims: { s: { deadline: '2020-01-01T00:00:00.000Z' } },
        });
      },
      ['run', 'reclaim', '--all'],
      (id) => `  • ${id} / s  (deadline 2020-01-01T00:00:00.000Z,`,
      'realm run reclaim --all',
      0,
    ],
    [
      'drain --all',
      () =>
        runWith({
          ...DONE,
          sealed_by: { arm: 'complete' },
          finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
        }),
      ['run', 'drain', '--all'],
      (id) => `  • ${id}`,
      'realm run drain --all',
      0,
    ],
    [
      'migrate --stamp-seals --detailed-exitcode',
      () => runWith(DONE),
      ['run', 'migrate', '--stamp-seals', '--detailed-exitcode'],
      (id) => `  • ${id}: complete (phase completed)`,
      'realm run migrate',
      2,
    ],
  ];
  it.each(BATCH)('%s', async (_label, seed, args, actedLine, command, code) => {
    const id = (await seed()) as string;
    writeFileSync(badPath(), '{ not json');
    const before = hashOf(badPath());
    const r = realm(args);
    // (a) red when the command fails or crashes on the damaged file, stops acting on the readable
    //     run once a file is damaged, touches the damaged file, or does not name it; (b) prints the
    //     exit, whether stdout says it acted on the readable run, whether the damaged file's bytes
    //     are unchanged (hashes compared, never shown) and stderr.
    expect({
      code: r.code,
      acted: r.out.split('\n').some((l) => l.startsWith(actedLine(id))),
      untouched: hashOf(badPath()) === before,
      err: r.err,
    }).toEqual({
      code,
      acted: true,
      untouched: true,
      err: [
        badLine(),
        `⚠ 1 run file(s) in '${runs}' could not be read; ${command} did not act on them.`,
      ],
    });
  });

  it('migrate: the damaged file in its own group, and the residue counts no file as a terminal run (C2)', async () => {
    await runWith(DONE);
    writeFileSync(badPath(), '{ not json');
    const r = realm(['run', 'migrate', '--stamp-seals']);
    const lines = r.out.split('\n');
    // (a) red when a damaged file is counted as a terminal run without a seal arm, or listed as a
    //     run that could not be classified; (b) prints the exit and the three lines.
    expect({
      code: r.code,
      group: lines.includes('1 run file(s) could not be read and were left untouched:'),
      bullet: lines.includes(`  • ${BAD}: is not JSON`),
      notClassified: lines.some((l) => l.includes('could NOT be classified')),
      residue: lines.find((l) => l.startsWith('Residue:')),
    }).toEqual({
      code: 0,
      group: true,
      bullet: true,
      notClassified: false,
      residue:
        'Residue: 1 terminal run(s) still without a recorded seal arm; 1 run file(s) could not be read.',
    });
  });

  it('guard: migrate on a store with no damaged file keeps its residue line', async () => {
    await runWith(DONE);
    const r = realm(['run', 'migrate', '--stamp-seals']);
    expect(r.out.split('\n').find((l) => l.startsWith('Residue:'))).toBe(
      'Residue: 1 terminal run(s) still without a recorded seal arm.',
    );
  });
});

describe('issue #719 — a command that reads one run by its id: the message, exit 1', () => {
  const BY_ID: Array<[string, (id: string) => string[]]> = [
    ['inspect', (id) => ['run', 'inspect', id]],
    ['abandon', (id) => ['run', 'abandon', id]],
    ['respond', (id) => ['run', 'respond', id, '--gate', 'g', '--choice', 'approve']],
    ['advance', (id) => ['run', 'advance', id]],
    ['diff', (id) => ['run', 'diff', id, id]],
    ['replay', (id) => ['run', 'replay', id]],
    ['export', (id) => ['run', 'export', id]],
    ['drain <id>', (id) => ['run', 'drain', id]],
    ['drain --void', (id) => ['run', 'drain', id, '--void', 'f']],
    ['reclaim <id>', (id) => ['run', 'reclaim', id, '--step', 's']],
    ['resume', (id) => ['run', 'resume', id, '--from', 's']],
    ['purge <id> --force', (id) => ['run', 'purge', id, '--force']],
  ];
  // `realm workflow run` names no existing run: its read of a run by id is of the run it has just
  // created, so no operator can point it at a damaged file (stated, not a cell).
  it.each(BY_ID)('%s', (_label, args) => {
    writeFileSync(badPath(), '{ not json');
    const r = realm(args(BAD));
    const text = r.err.join('\n');
    // (a) red when the command prints the parser's text, rewords or swallows the message, or exits
    //     otherwise; (b) prints the exit and whether stderr carries the fault and the way out.
    expect({
      code: r.code,
      fault: text.includes(`The run file '${badPath()}' is not JSON.`),
      wayOut: text.includes(wayOut(BAD)),
    }).toEqual({ code: 1, fault: true, wayOut: true });
  });

  it('realm agent --run-id (a stub provider: the provider is built before the run is read)', () => {
    writeFileSync(badPath(), '{ not json');
    symlinkSync(join(ROOT, 'node_modules'), join(home, 'node_modules'), 'dir');
    writeFileSync(join(home, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(
      join(home, 'p.mjs'),
      [
        "import { LlmProvider } from '@sensigo/realm-cli/agent';",
        'class Stub extends LlmProvider { async callStep() { return {}; } }',
        'export default new Stub();',
        '',
      ].join('\n'),
    );
    const r = realm(['agent', '--run-id', BAD, '--provider-module', './p.mjs']);
    const text = r.err.join('\n');
    expect({
      code: r.code,
      fault: text.includes(`The run file '${badPath()}' is not JSON.`),
      wayOut: text.includes(wayOut(BAD)),
    }).toEqual({ code: 1, fault: true, wayOut: true });
  });

  // A guard: `purge <id> --force` already refused a damaged file before deleting (F719-CB-15);
  // green before #719 and after (red-first run: reports/fix-719.flips.log, F6).
  it('guard: purge <id> --force on a damaged file deletes nothing', () => {
    writeFileSync(badPath(), '{ not json');
    const r = realm(['run', 'purge', BAD, '--force']);
    expect({ code: r.code, kept: existsSync(badPath()) }).toEqual({ code: 1, kept: true });
  });

  it('the leak cell (CLI stderr): a fault AT a token never reaches the output', () => {
    writeFileSync(badPath(), '{"params":{"token": ghp_FAKE719}}');
    const r = realm(['run', 'inspect', BAD]);
    const leaked = `${r.out}\n${r.err.join('\n')}`.includes('ghp_FAKE7');
    // (a) red when the parser's text reaches the terminal; (b) prints a boolean only.
    expect(leaked).toBe(false);
  });
});

describe('issue #719 — a decision over every run fails closed, naming every damaged file, exit 1', () => {
  const tail = (command: string) =>
    `Repair, restore or move each one out ('realm run list' shows each file's way out), then run '${command}' again.`;

  it.each([
    [['run', 'reconcile'], 'realm run reconcile'],
    [['run', 'reconcile', '--dry-run'], 'realm run reconcile --dry-run'],
    [['run', 'reconcile', '--workflow', 'w'], 'realm run reconcile --workflow w'],
  ])(
    '%j: one error naming both, the exact command to run again, no pointer written',
    async (args, command) => {
      await readableRun();
      writeFileSync(badPath(), '{ not json');
      writeFileSync(join(runs, 'empty.json'), '');
      const r = realm(args);
      // (a) red when it reconciles past them, names only the first, or tells the operator to run
      //     a command other than the one they ran (flags dropped); (b) prints exit and stderr.
      expect({ code: r.code, err: r.err, keys: existsSync(join(runs, 'keys')) }).toEqual({
        code: 1,
        err: [
          `${command} did not run: 2 run file(s) in '${runs}' could not be read:`,
          `  ${badPath()}: is not JSON`,
          `  ${join(runs, 'empty.json')}: is empty`,
          tail(command),
        ],
        keys: false,
      });
    },
  );

  it('realm run gc --heal --force: one error naming both, nothing healed', async () => {
    const id = await readableRun();
    // A stale persisted phase: the heal would rewrite this record.
    const file = join(runs, `${id}.json`);
    const rec = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...rec, run_phase: 'completed' }));
    const before = readFileSync(file, 'utf8');
    writeFileSync(badPath(), '{ not json');
    writeFileSync(join(runs, 'empty.json'), '');
    const r = realm(['run', 'gc', '--heal', '--force']);
    const text = r.err.join('\n');
    expect({
      code: r.code,
      named: [
        text.includes(
          `realm run gc --heal --force did not run: 2 run file(s) in '${runs}' could not be read:`,
        ),
        text.includes(`  ${badPath()}: is not JSON`),
        text.includes(`  ${join(runs, 'empty.json')}: is empty`),
        text.includes(tail('realm run gc --heal --force')),
      ],
      unchanged: readFileSync(file, 'utf8') === before,
    }).toEqual({ code: 1, named: [true, true, true, true], unchanged: true });
  });
});

describe('issue #719 F5 — a copy of a run whose own file reads is not a damaged run', () => {
  /** A readable run of workflow `w` and a copy of its file (`<id>.bak.json`). */
  async function runAndCopy(
    over: Record<string, unknown> = {},
  ): Promise<{ id: string; copy: string }> {
    const id = await runWith(over);
    const copy = join(runs, `${id}.bak.json`);
    writeFileSync(copy, readFileSync(join(runs, `${id}.json`)));
    return { id, copy };
  }

  it('realm run list prints the copy with its way out and does not count it', async () => {
    const { id, copy } = await runAndCopy();
    const before = hashOf(copy);
    const r = realm(['run', 'list']);
    // (a) red when a copy is counted among the files that could not be read, or not named; (b)
    //     prints the exit, whether the run is listed, the stderr lines and the unchanged-bytes check.
    expect({
      code: r.code,
      listed: r.out.includes(id),
      err: r.err,
      untouched: hashOf(copy) === before,
    }).toEqual({
      code: 0,
      listed: true,
      err: [
        `⚠ The run file '${copy}' holds run '${id}', not '${id}.bak'. That run's own file is ` +
          `readable, so this is a copy: move it out of '${runs}' — nothing else changes.`,
      ],
      untouched: true,
    });
  });

  it.each([
    [['run', 'reconcile'], 'reconcile'],
    [['run', 'gc', '--heal'], 'gc --heal'],
  ])('%j runs past a copy, exit 0', async (args) => {
    const { copy } = await runAndCopy();
    const before = hashOf(copy);
    const r = realm(args);
    // (a) red when a copy makes a decision over every run fail closed; (b) prints the exit, whether
    //     stderr names the copy, and the unchanged-bytes check.
    expect({
      code: r.code,
      namesCopy: r.err.join('\n').includes(copy),
      untouched: hashOf(copy) === before,
    }).toEqual({ code: 0, namesCopy: false, untouched: true });
  });

  it('migrate --detailed-exitcode: a copy is not in the damaged group and does not set the exit code', async () => {
    const { copy } = await runAndCopy({
      terminal_state: true,
      run_phase: 'completed',
      terminal_reason: 'Workflow completed.',
      sealed_by: { arm: 'complete' },
    });
    const before = hashOf(copy);
    const r = realm(['run', 'migrate', '--stamp-seals', '--detailed-exitcode']);
    // (a) red when a copy is counted as an unreadable file (exit 2); (b) prints the exit, whether
    //     stdout has the damaged group, and the unchanged-bytes check.
    expect({
      code: r.code,
      damagedGroup: r.out.includes('could not be read and were left untouched'),
      untouched: hashOf(copy) === before,
    }).toEqual({ code: 0, damagedGroup: false, untouched: true });
  });

  it.each([
    ['absent', (id: string) => rmSync(join(runs, `${id}.json`))],
    ['damaged', (id: string) => writeFileSync(join(runs, `${id}.json`), '{not json')],
  ] as const)(
    'per-conjunct: a file holding a run whose own file is %s is still counted, and refuses reconcile',
    async (_label, held) => {
      const { id, copy } = await runAndCopy();
      held(id);
      const listed = realm(['run', 'list']);
      const reconciled = realm(['run', 'reconcile']);
      // (a) red when such a file is taken for a copy; (b) prints the exits and booleans.
      expect({
        counted: listed.err.some((l) => l.includes('could not be read and are not listed')),
        reconcileExit: reconciled.code,
        reconcileNamesIt: reconciled.err.join('\n').includes(copy),
      }).toEqual({ counted: true, reconcileExit: 1, reconcileNamesIt: true });
    },
  );
});
