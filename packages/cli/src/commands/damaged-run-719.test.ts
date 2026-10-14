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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileStore } from '@sensigo/realm';

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

const BAD = 'bad';
const badPath = () => join(runs, `${BAD}.json`);
const wayOut = (p: string, id: string) =>
  `Restore '${p}' from a backup or repair it; the run and its key are kept. Or move it out of ` +
  `'${runs}' together with every file there whose name contains '${id}' (its attempt log and ` +
  `trace files; moved alone, they become orphans that 'realm run gc --force' deletes). If it held ` +
  `an idempotency key, the next delivery with that key starts a new run.`;
const badLine = () => `⚠ The run file '${badPath()}' is not JSON. ${wayOut(badPath(), BAD)}`;

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
});

describe('issue #719 — the commands that act on runs act on the readable ones and name the rest', () => {
  const BATCH: Array<[string, string[], string, number]> = [
    ['cleanup', ['run', 'cleanup', '--older-than', '0m'], 'realm run cleanup', 0],
    ['purge', ['run', 'purge', '--older-than', '0m'], 'realm run purge', 0],
    ['reclaim --all', ['run', 'reclaim', '--all'], 'realm run reclaim --all', 0],
    ['drain --all', ['run', 'drain', '--all'], 'realm run drain --all', 0],
    [
      'migrate --stamp-seals --detailed-exitcode',
      ['run', 'migrate', '--stamp-seals', '--detailed-exitcode'],
      'realm run migrate',
      2,
    ],
  ];
  it.each(BATCH)('%s', async (_label, args, command, code) => {
    await readableRun();
    writeFileSync(badPath(), '{ not json');
    const r = realm(args);
    // (a) red when the command fails or crashes on the damaged file, acts on it, or does not name
    //     it; (b) prints the exit and stderr.
    expect({ code: r.code, err: r.err }).toEqual({
      code,
      err: [
        badLine(),
        `⚠ 1 run file(s) in '${runs}' could not be read; ${command} did not act on them.`,
      ],
    });
  });

  it('cleanup acts on the readable run; migrate counts the damaged file as unclassifiable', async () => {
    await readableRun();
    writeFileSync(badPath(), '{ not json');
    const cleaned = realm(['run', 'cleanup', '--older-than', '0m']);
    const migrated = realm(['run', 'migrate', '--stamp-seals']);
    // (b) prints the two stdout lines that say so.
    expect({
      marked: cleaned.out.includes('Marked 1 run(s) as abandoned.'),
      unclassifiable: migrated.out.includes(`  • ${BAD}: is not JSON`),
      migrateExit: migrated.code,
    }).toEqual({ marked: true, unclassifiable: true, migrateExit: 0 });
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
      wayOut: text.includes(wayOut(badPath(), BAD)),
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
      wayOut: text.includes(wayOut(badPath(), BAD)),
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
    `Repair, restore or move each one out ('realm run list' shows each file's way out), then run ${command} again.`;

  it('realm run reconcile: one error naming both, no pointer written', async () => {
    await readableRun();
    writeFileSync(badPath(), '{ not json');
    writeFileSync(join(runs, 'empty.json'), '');
    const r = realm(['run', 'reconcile']);
    // (a) red when it reconciles past them, or names only the first; (b) prints exit and stderr.
    expect({ code: r.code, err: r.err, keys: existsSync(join(runs, 'keys')) }).toEqual({
      code: 1,
      err: [
        `realm run reconcile did not run: 2 run file(s) in '${runs}' could not be read:`,
        `  ${badPath()}: is not JSON`,
        `  ${join(runs, 'empty.json')}: is empty`,
        tail('realm run reconcile'),
      ],
      keys: false,
    });
  });

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
          `realm run gc --heal did not run: 2 run file(s) in '${runs}' could not be read:`,
        ),
        text.includes(`  ${badPath()}: is not JSON`),
        text.includes(`  ${join(runs, 'empty.json')}: is empty`),
        text.includes(tail('realm run gc --heal')),
      ],
      unchanged: readFileSync(file, 'utf8') === before,
    }).toEqual({ code: 1, named: [true, true, true, true], unchanged: true });
  });
});
