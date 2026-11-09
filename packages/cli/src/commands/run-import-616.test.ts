// run-import-616.test.ts — issue #616 PR-2c, unit c11b: `realm run import <path…>`, the command around
// c11a's core. The real cases: an operator who gives files and folders (names in mixed case, a link, a
// README beside the runs, a folder named like a run file, a sub-folder, a path twice); who mistypes a
// path, points at a pipe, a folder they may not read or one with no runs, or at a good folder and a
// missing one; whose home still holds the old store's folders; whose store fails during the import (busy,
// or an error nothing expects); and whose output goes to a slow pipe or a log. The in-process cells call
// `runImport` (the command's logic, which returns the exit code and touches no `process` field); the
// others run the BUILT `realm` with PATH, HOME and REALM_NO_NUDGE only, in a scratch folder. The crown on
// the built CLI and the page's sentences are in `docs-pages-625-acting.test.ts`, beside the page's law.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails: the
// command's lines and exit code, never a record's content.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowError, type ErrorCode, type RunRecord } from '@sensigo/realm';
import { openRealmHome, type RealmHome } from '@sensigo/realm-store-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ImportHome } from './run-import-core.js';
import { runImport } from './run-import.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');
const AS_ROOT = process.getuid?.() === 0;
if (AS_ROOT) {
  console.warn(
    '#616 PR-2c c11b: the cell of a folder that cannot be listed is skipped: root lists any folder.',
  );
}

const CREATED = '2026-11-01T10:00:00.000Z';
const UPDATED = '2026-11-01T10:10:00.000Z';

/** A live run another store exported, in the record's own shape. */
function record(id: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    workflow_id: 'wf-import',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 3,
    params: { ticket: 'T-1' },
    evidence: [],
    created_at: CREATED,
    updated_at: UPDATED,
    terminal_state: false,
    ...extra,
  };
}

let root = '';
const homes: RealmHome[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-616-c11b-'));
});
afterEach(() => {
  for (const h of homes.splice(0)) h.close();
  try {
    chmodSync(join(root, 'locked'), 0o700);
  } catch {
    // no locked folder
  }
  rmSync(root, { recursive: true, force: true });
});

/** Writes `content` (text as it is, anything else as JSON) at `<root>/<rel>`, making its folders. */
function put(rel: string, content: unknown): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

/** `runImport` over `paths` into a real scratch SQLite home; its lines, the opens and the code. */
async function imported(paths: string[]): Promise<{
  out: string[];
  err: string[];
  opens: number;
  code: number;
}> {
  const out: string[] = [];
  const err: string[] = [];
  let opens = 0;
  const code = await runImport(paths, {
    openHome: async () => {
      opens += 1;
      const h = await openRealmHome({ home: join(root, 'home', '.realm') });
      homes.push(h);
      return h;
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { out, err, opens, code };
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the built `realm` with HOME = `home`, in `cwd`; a run that hangs is killed (a red). */
function realm(args: string[], home: string, cwd: string): Run {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Runs the built `realm` with HOME = `home`, in `cwd`, its stdout a pipe this process does not read
 * for `pauseMs` (a slow reader: a pager, a log shipper), then reads to the end; a run that hangs is
 * killed.
 */
function slowlyRead(args: string[], home: string, cwd: string, pauseMs: number): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [DIST_CLI, ...args], {
      cwd,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NO_NUDGE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.stdout.pause();
    setTimeout(() => {
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stdout.resume();
    }, pauseMs);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

/** What a folder holds: each name with its bytes' hash, so any change to it shows. */
function holds(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    out[name] = statSync(path).isFile()
      ? createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
      : 'folder';
  }
  return out;
}

describe('#616 PR-2c c11b — discovery (in-process)', () => {
  it('a folder gives its .json files in default string order, a link followed, the others counted, nothing below it; paths in the order given, one given twice', async () => {
    const dir = join(root, 'runs');
    put('runs/a.json', record('run-a'));
    put('runs/B.json', record('run-b'));
    put('runs/README.md', '# not a run');
    mkdirSync(join(root, 'runs', 'folder.json'));
    put('runs/below/c.json', record('run-c'));
    put('elsewhere/linked.json', record('run-l'));
    symlinkSync(join(root, 'elsewhere', 'linked.json'), join(dir, 'l.json'));
    const single = put('single.json', record('run-s'));
    const r = await imported([single, `${dir}/`, single]);
    // (1) red when the names are sorted by `localeCompare` (a.json before B.json), when a link is
    //     not followed, when a folder below is read, when the entries not read are not counted, or
    //     when a path given twice is imported once; (2) prints the lines and the code.
    expect(r).toEqual({
      out: [
        `imported  ${single}`,
        `imported  ${dir}/B.json`,
        `imported  ${dir}/a.json`,
        `not_a_run  ${dir}/folder.json: cannot be read: illegal operation on a directory`,
        `imported  ${dir}/l.json`,
        `unchanged  ${single}`,
        '6 files: 4 imported, 1 unchanged, 1 not a run.',
        'Ignored 2 entries that are not .json files.',
      ],
      err: [],
      opens: 1,
      code: 1,
    });
  });
});

/** Every file under `folder` with its size, modification time, inode and bytes' hash, and the listing itself. */
function fingerprint(folder: string): string {
  const names = readdirSync(folder, { recursive: true, encoding: 'utf8' }).sort();
  return JSON.stringify(
    names.map((name) => {
      const path = join(folder, name);
      const s = statSync(path);
      return s.isFile()
        ? [
            name,
            s.size,
            s.mtimeMs,
            s.ino,
            createHash('sha256').update(readFileSync(path)).digest('hex'),
          ]
        : [name, 'folder'];
    }),
  );
}

// What the page says of the command, each claim with the cell that fails when it stops being true
// (added in the review of #1067: the first cells did not pin these, and their comments said they did).
describe('#616 PR-2c c11b — what the page promises about what is read, in what order, and what is left alone', () => {
  it('the files you give are never moved, changed or deleted: every file, its size, modification time, inode and bytes, and the folders’ listings, are the same after', async () => {
    put('fixtures/runs/a.json', record('run-keep-a'));
    put('fixtures/runs/notes.txt', 'keep me');
    put('fixtures/runs/old.attempts.jsonl', '{"a":1}\n');
    put('fixtures/single.json', record('run-keep-s'));
    put('fixtures/bad.json', '[]');
    const before = fingerprint(join(root, 'fixtures'));
    const r = await imported([
      join(root, 'fixtures', 'single.json'),
      join(root, 'fixtures', 'runs'),
      join(root, 'fixtures', 'bad.json'),
    ]);
    // (1) red when the command deletes, renames, rewrites or touches a file it was given (or leaves a
    //     file beside it); (2) prints the code and both fingerprints.
    expect({ code: r.code, same: fingerprint(join(root, 'fixtures')) === before }).toEqual({
      code: 1,
      same: true,
    });
  });

  it('only names ending in exactly .json are read: .attempts.jsonl, .jsonl, .json.bak and .JSON are counted, not read', async () => {
    const dir = join(root, 'runs');
    put('runs/a.json', record('run-n-a'));
    for (const name of ['old.attempts.jsonl', 'c.jsonl', 'b.json.bak', 'D.JSON']) {
      put(`runs/${name}`, record(`run-n-${name}`));
    }
    const r = await imported([dir]);
    // (1) red when the name test is a match anywhere in the name (`.attempts.jsonl`, `.jsonl` and
    //     `.json.bak` are read) or ignores case (`D.JSON` is read); (2) prints the lines and the code.
    expect(r).toEqual({
      out: [
        `imported  ${dir}/a.json`,
        '1 file: 1 imported.',
        'Ignored 4 entries that are not .json files.',
      ],
      err: [],
      opens: 1,
      code: 0,
    });
  });

  it('a folder’s files come in the order of their names by character code (10.json before 2.json, B.json before a.json, é.json last), not by a locale', async () => {
    const dir = join(root, 'runs');
    for (const name of ['2.json', 'é.json', 'a.json', '10.json', 'z.json', 'B.json']) {
      put(`runs/${name}`, record(`run-s-${name}`));
    }
    const r = await imported([dir]);
    // (1) red when the names are sorted by a locale comparison (`a.json` before `B.json`, `é.json`
    //     before `z.json`) or taken in the order the system lists them; (2) prints the lines.
    expect(r.out.map((line) => line.replace(`${dir}/`, ''))).toEqual([
      'imported  10.json',
      'imported  2.json',
      'imported  B.json',
      'imported  a.json',
      'imported  z.json',
      'imported  é.json',
      '6 files: 6 imported.',
    ]);
  });

  it('paths are imported in the order given, not sorted and not reversed', async () => {
    const c = put('args/c.json', record('run-o-c'));
    const a = put('args/a.json', record('run-o-a'));
    const b = put('args/b.json', record('run-o-b'));
    const r = await imported([c, a, b]);
    // (1) red when the arguments are sorted or reversed (a palindrome of arguments could not tell);
    //     (2) prints the lines.
    expect(r.out).toEqual([
      `imported  ${c}`,
      `imported  ${a}`,
      `imported  ${b}`,
      '3 files: 3 imported.',
    ]);
  });

  it('a link given as an argument counts as what it points at: a link to a file is imported, a link to a folder is read', async () => {
    const real = put('elsewhere/real.json', record('run-k-r'));
    put('elsewhere/dir/x.json', record('run-k-x'));
    const fileLink = join(root, 'file-link.json');
    symlinkSync(real, fileLink);
    const folderLink = join(root, 'folder-link');
    symlinkSync(join(root, 'elsewhere', 'dir'), folderLink);
    const r = await imported([fileLink, folderLink]);
    // (1) red when the arguments are looked at without following a link (`lstat`: both refused as
    //     "neither a file nor a folder"); (2) prints the lines, the opens and the code.
    expect(r).toEqual({
      out: [`imported  ${fileLink}`, `imported  ${folderLink}/x.json`, '2 files: 2 imported.'],
      err: [],
      opens: 1,
      code: 0,
    });
  });

  it('a folder given with trailing slashes names its files with one slash', async () => {
    const dir = join(root, 'runs');
    put('runs/a.json', record('run-t-a'));
    const r = await imported([`${dir}///`]);
    // (1) red when one trailing slash is taken off (the file is named `dir///a.json`) or none; (2)
    //     prints the lines.
    expect(r.out).toEqual([`imported  ${dir}/a.json`, '1 file: 1 imported.']);
  });

  it('a path holding a newline and an escape sequence is one escaped line in a refusal and in a stop', async () => {
    const odd = join(root, 'a\nb\u001b[31m');
    mkdirSync(odd);
    const refused = await imported([odd]);
    const file = put('x\ny.json', record('run-ctl'));
    const out: string[] = [];
    const err: string[] = [];
    const code = await runImport([file], {
      openHome: async () =>
        stubbedHome({
          'run-ctl': () =>
            typed(
              'STATE_RUN_BUSY',
              'The store was busy for 5 s: another writer held it. Nothing was written. Try again.',
            ),
        }),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    // (1) red when a path is printed raw in the refusal or in the stop line (a second line, a raw
    //     escape character); (2) prints both runs' lines.
    expect({ refused: refused.err, stop: { out, err, code } }).toEqual({
      refused: [
        `Error: ${root}/a\\nb\\u001b[31m: no .json files (a folder is read for .json files directly in it, not below it)`,
      ],
      stop: {
        out: [],
        err: [
          `Error: stopped at ${root}/x\\ny.json: The store was busy for 5 s: another writer held it. Nothing was written. Try again.`,
          'Run the same command again: runs already imported read unchanged.',
        ],
        code: 1,
      },
    });
  });

  it('an unexpected error whose message is empty never has its stack printed raw: one line, with no line break in it', async () => {
    const dir = join(root, 'runs');
    put('runs/a.json', record('run-empty'));
    const err: string[] = [];
    const code = await runImport([dir], {
      openHome: async () => stubbedHome({ 'run-empty': () => new Error('') }),
      out: () => undefined,
      err: (line) => err.push(line),
    });
    // The stack does not hold the (empty) message, so it is shown escaped and bounded as ONE line
    // (here `‹<n> characters, not kept›`: a stack is longer than the bound). Each `err` call is one
    // line the command writes: a raw stack in one call would print as several lines.
    // (1) red when the stack that does not hold the message is printed as it is (a call whose text
    //     holds line breaks and frame lines); (2) prints the code, the first and last lines, the
    //     number of lines and how many hold a line break.
    expect({
      code,
      first: err[0],
      lines: err.length,
      withLineBreak: err.filter((line) => line.includes('\n')).length,
      last: err[err.length - 1],
    }).toEqual({
      code: 1,
      first: `Error: stopped at ${dir}/a.json: `,
      lines: 3,
      withLineBreak: 0,
      last: 'Fix or move that file, then run the command again.',
    });
  });
});

describe('#616 PR-2c c11b — the refusals come before anything is opened or read', () => {
  it.each([
    ['a missing path', () => join(root, 'nope'), 'no such file or folder'],
    [
      'a path that is neither a file nor a folder (a FIFO)',
      () => {
        const fifo = join(root, 'pipe.json');
        spawnSync('mkfifo', [fifo]);
        return fifo;
      },
      'neither a file nor a folder',
    ],
    [
      'a folder with no .json file',
      () => {
        put('empty-ish/notes.txt', 'x');
        mkdirSync(join(root, 'empty-ish', 'sub.d'));
        return join(root, 'empty-ish');
      },
      'no .json files (a folder is read for .json files directly in it, not below it)',
    ],
    // A stat failure that is not "absent" is refused in the system's words (the page: `Error: <path>:
    // <the system's reason>`). Red when every stat failure says "no such file or folder", or when the
    // error's own text is printed.
    [
      'a path through a file (a stat failure that is not "absent")',
      () => `${put('plain.json', record('run-pf'))}/`,
      'not a directory',
    ],
    [
      'a link that points at itself (a second stat failure)',
      () => {
        const loop = join(root, 'loop.json');
        symlinkSync(loop, loop);
        return loop;
      },
      'too many symbolic links encountered',
    ],
  ] as const)('%s', async (_, make, reason) => {
    const good = put('good.json', record('run-g'));
    const bad = make();
    const r = await imported([good, bad]);
    // (1) red when the arguments are checked lazily (the good file is imported first, the home is
    //     opened), or when the reason is another; (2) prints the lines, the opens and the code.
    expect(r).toEqual({ out: [], err: [`Error: ${bad}: ${reason}`], opens: 0, code: 1 });
  });

  it.skipIf(AS_ROOT)(
    'a folder that cannot be listed is refused in the system’s words, not its error’s (skipped as root: root lists any folder)',
    async () => {
      const locked = join(root, 'locked');
      put('locked/a.json', record('run-x'));
      chmodSync(locked, 0o000);
      const r = await imported([locked]);
      // (1) red when the error's own text is printed (`EACCES: permission denied, scandir '…'`), or
      //     the home is opened; (2) prints the lines, the opens and the code.
      expect(r).toEqual({
        out: [],
        err: [`Error: ${locked}: permission denied`],
        opens: 0,
        code: 1,
      });
    },
  );
});

/** A home whose `save` answers each record id as `answers` says; nothing is stored. */
function stubbedHome(answers: Record<string, () => unknown>): ImportHome {
  return {
    runStore: {
      save: async (r: RunRecord) => {
        const answer = answers[r.id]?.();
        if (answer instanceof Error || typeof answer === 'string') throw answer;
        return answer as { outcome: 'imported' | 'unchanged' };
      },
    },
  } as unknown as ImportHome;
}

const typed = (code: ErrorCode, message: string, details?: Record<string, unknown>): Error =>
  new WorkflowError(message, {
    code,
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    ...(details === undefined ? {} : { details }),
  });
const IMPORTED = (): unknown => ({ outcome: 'imported' });
const UNCHANGED = (): unknown => ({ outcome: 'unchanged' });
const BUSY = (): unknown =>
  typed(
    'STATE_RUN_BUSY',
    'The store was busy for 5 s: another writer held it. Nothing was written. Try again.',
  );
const UNEXPECTED = (): unknown => new TypeError('The "data" argument must be of type string.');

/** One row of the table: the files (name → what save() answers, `[]` for a file that is not a run). */
interface Row {
  readonly files: ReadonlyArray<readonly [string, (() => unknown) | 'not a run']>;
  readonly out: readonly string[];
  readonly err: readonly string[];
  readonly code: number;
}

const STORE_AGAIN = 'run the same command again: runs already imported read unchanged.';
const FIX_AGAIN = 'fix or move that file, then run the command again.';
const BUSY_LINE =
  'The store was busy for 5 s: another writer held it. Nothing was written. Try again.';
const STOPPED_AT_C = (p: string, m: string): string => `Error: stopped at ${p}/c.json: ${m}`;

describe('#616 PR-2c c11b — the stop, the summary and the exit code', () => {
  const six = (third: () => unknown): Row['files'] => [
    ['a.json', IMPORTED],
    ['b.json', IMPORTED],
    ['c.json', third],
    ['d.json', IMPORTED],
    ['e.json', IMPORTED],
    ['f.json', IMPORTED],
  ];
  /**
   * One failing word beside one imported file, each word on its own: the exit code is judged word by
   * word, so an exit rule that forgets one word (a folder whose only bad file is `diverged` exits 0)
   * is red here, not only when all four words are present (the page: "1 when any file was not").
   */
  const alone = (
    word: string,
    answer: (() => unknown) | 'not a run',
    line: string,
    named: string,
  ): readonly [string, (dir: string) => Row] => [
    `a ${word} file beside an imported one: exit 1`,
    (d) => ({
      files: [
        ['a.json', IMPORTED],
        ['b.json', answer],
      ],
      out: [
        `imported  ${d}/a.json`,
        `${word}  ${d}/b.json: ${line}`,
        `2 files: 1 imported, 1 ${named}.`,
      ],
      err: [],
      code: 1,
    }),
  ];
  const rows: ReadonlyArray<readonly [string, (dir: string) => Row]> = [
    [
      'every file imported',
      (d) => ({
        files: [
          ['a.json', IMPORTED],
          ['b.json', IMPORTED],
        ],
        out: [`imported  ${d}/a.json`, `imported  ${d}/b.json`, '2 files: 2 imported.'],
        err: [],
        code: 0,
      }),
    ],
    [
      'every file unchanged (a re-run): exit 0',
      (d) => ({
        files: [
          ['a.json', UNCHANGED],
          ['b.json', UNCHANGED],
        ],
        out: [`unchanged  ${d}/a.json`, `unchanged  ${d}/b.json`, '2 files: 2 unchanged.'],
        err: [],
        code: 0,
      }),
    ],
    [
      'one file: "1 file"',
      (d) => ({
        files: [['a.json', IMPORTED]],
        out: [`imported  ${d}/a.json`, '1 file: 1 imported.'],
        err: [],
        code: 0,
      }),
    ],
    [
      'one each of diverged, purged, legacy and not a run: the zero counts left out, exit 1',
      (d) => ({
        files: [
          [
            'a.json',
            () => typed('STATE_RUN_DIVERGED', 'diverged', { localVersion: 3, incomingVersion: 4 }),
          ],
          [
            'b.json',
            () => typed('STATE_RUN_PURGED', 'purged', { purged_at: '2026-10-30T09:15:00.000Z' }),
          ],
          ['c.json', () => typed('STATE_LEGACY_FORMAT', 'legacy')],
          ['d.json', 'not a run'],
        ],
        out: [
          `diverged  ${d}/a.json: the stored run is at version 3; the file is at version 4`,
          `purged  ${d}/b.json: this run was deleted on 2026-10-30`,
          `legacy  ${d}/c.json: not in the current run format`,
          `not_a_run  ${d}/d.json: not a run: it is not an object`,
          '4 files: 1 diverged, 1 purged, 1 legacy, 1 not a run.',
        ],
        err: [],
        code: 1,
      }),
    ],
    alone(
      'diverged',
      () => typed('STATE_RUN_DIVERGED', 'diverged', { localVersion: 3, incomingVersion: 4 }),
      'the stored run is at version 3; the file is at version 4',
      'diverged',
    ),
    alone(
      'purged',
      () => typed('STATE_RUN_PURGED', 'purged', { purged_at: '2026-10-30T09:15:00.000Z' }),
      'this run was deleted on 2026-10-30',
      'purged',
    ),
    alone(
      'legacy',
      () => typed('STATE_LEGACY_FORMAT', 'legacy'),
      'not in the current run format',
      'legacy',
    ),
    alone('not_a_run', 'not a run', 'not a run: it is not an object', 'not a run'),
    [
      'a store STOP after two files, three left',
      (d) => ({
        files: six(BUSY),
        out: [`imported  ${d}/a.json`, `imported  ${d}/b.json`],
        err: [STOPPED_AT_C(d, BUSY_LINE), `3 files were not started; ${STORE_AGAIN}`],
        code: 1,
      }),
    ],
    [
      'a store STOP with one file left',
      (d) => ({
        files: six(BUSY).slice(0, 4),
        out: [`imported  ${d}/a.json`, `imported  ${d}/b.json`],
        err: [STOPPED_AT_C(d, BUSY_LINE), `1 file was not started; ${STORE_AGAIN}`],
        code: 1,
      }),
    ],
    [
      'a store STOP at the last file',
      (d) => ({
        files: six(BUSY).slice(0, 3),
        out: [`imported  ${d}/a.json`, `imported  ${d}/b.json`],
        err: [
          STOPPED_AT_C(d, BUSY_LINE),
          'Run the same command again: runs already imported read unchanged.',
        ],
        code: 1,
      }),
    ],
    [
      'an unexpected STOP after two files, three left: the stack after the message',
      (d) => ({
        files: six(UNEXPECTED),
        out: [`imported  ${d}/a.json`, `imported  ${d}/b.json`],
        err: [
          STOPPED_AT_C(d, 'The \\"data\\" argument must be of type string.'),
          '<frames>',
          `3 files were not started; ${FIX_AGAIN}`,
        ],
        code: 1,
      }),
    ],
    [
      'an unexpected STOP with one file left',
      (d) => ({
        files: six(UNEXPECTED).slice(0, 4),
        out: [`imported  ${d}/a.json`, `imported  ${d}/b.json`],
        err: [
          STOPPED_AT_C(d, 'The \\"data\\" argument must be of type string.'),
          '<frames>',
          `1 file was not started; ${FIX_AGAIN}`,
        ],
        code: 1,
      }),
    ],
    [
      'an unexpected STOP at the last file',
      (d) => ({
        files: six(UNEXPECTED).slice(0, 3),
        out: [`imported  ${d}/a.json`, `imported  ${d}/b.json`],
        err: [
          STOPPED_AT_C(d, 'The \\"data\\" argument must be of type string.'),
          '<frames>',
          'Fix or move that file, then run the command again.',
        ],
        code: 1,
      }),
    ],
    [
      'a thrown value that is not an Error: its text, no stack',
      (d) => ({
        files: six(() => 'boom').slice(0, 3),
        out: [`imported  ${d}/a.json`, `imported  ${d}/b.json`],
        err: [STOPPED_AT_C(d, 'boom'), 'Fix or move that file, then run the command again.'],
        code: 1,
      }),
    ],
    [
      'a store message holding a newline is one escaped line',
      (d) => ({
        files: six(() => typed('STATE_STORE_FULL', 'full\nimported  /v/ok.json')).slice(0, 3),
        out: [`imported  ${d}/a.json`, `imported  ${d}/b.json`],
        err: [
          STOPPED_AT_C(d, 'full\\nimported  /v/ok.json'),
          'Run the same command again: runs already imported read unchanged.',
        ],
        code: 1,
      }),
    ],
    [
      'an unexpected message holding a forged frame: the frame is not printed (MA 3)',
      (d) => ({
        files: six(() => new Error('bad\n    at forged (x.js:1:1)')).slice(0, 3),
        out: [`imported  ${d}/a.json`, `imported  ${d}/b.json`],
        err: [
          STOPPED_AT_C(d, 'bad\\n    at forged (x.js:1:1)'),
          '<frames>',
          'Fix or move that file, then run the command again.',
        ],
        code: 1,
      }),
    ],
  ];

  it.each(rows)('%s', async (_, make) => {
    const dir = join(root, 'runs');
    const row = make(dir);
    const answers: Record<string, () => unknown> = {};
    for (const [name, answer] of row.files) {
      if (answer === 'not a run') {
        put(`runs/${name}`, '[]');
      } else {
        const id = `run-${name}`;
        answers[id] = answer;
        put(`runs/${name}`, record(id));
      }
    }
    const out: string[] = [];
    const err: string[] = [];
    const code = await runImport([dir], {
      openHome: async () => stubbedHome(answers),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    // The stack's frames, as one marker (their number and text are the runtime's).
    const errShown = err.reduce<string[]>((acc, line) => {
      if (/^\s+at /.test(line)) {
        if (acc[acc.length - 1] !== '<frames>') acc.push('<frames>');
      } else acc.push(line);
      return acc;
    }, []);
    // (1) red when the next file is started after a STOP, a zero count is printed, `unchanged` is
    //     counted as a failure, the stop's message is printed raw (a second line, or a forged frame
    //     printed), the not-started sentence is another, the summary follows a STOP, or the exit rule
    //     forgets one failing word (one row for each of the four, alone beside an imported file);
    //     (2) prints the two streams and the code.
    expect({ out, err: errShown, code, forged: err.includes('    at forged (x.js:1:1)') }).toEqual({
      out: row.out,
      err: row.err,
      code: row.code,
      forged: false,
    });
  });
});

describe('#616 PR-2c c11b — on the built CLI', { timeout: 120_000 }, () => {
  // GROUNDING (MA 3's ruling, 2026-11-08): this cell pins that a slow reader gets every line with the
  // summary last. It is not the acceptance check of a `process.exit(code)` break: on the built CLI here
  // that break does not turn it red (measured: a shell pipe to `(sleep 1; cat)` and a reader that
  // pauses 1-5 s, 3,000 and 15,000 files; why is not explained). The action sets `process.exitCode`.
  it('GROUNDING, not the acceptance check of a `process.exit` break: a slow reader still gets every line, the summary last', async () => {
    const files = 1_000;
    const name = 'x'.repeat(180);
    mkdirSync(join(root, 'many'));
    for (let i = 0; i < files; i++) writeFileSync(join(root, 'many', `${name}-${i}.json`), '');
    const r = await slowlyRead(['run', 'import', join(root, 'many')], root, root, 1_000);
    const lines = r.stdout.trimEnd().split('\n');
    // (1) can fail only if a later change cuts output on this reader kind (a pipe this process does
    //     not read for 1 s); (2) prints the count of lines received and the last line.
    expect({ lines: lines.length, last: lines[lines.length - 1] }).toEqual({
      lines: files + 1,
      last: `${files} files: ${files} not a run.`,
    });
  });

  it('piped paths: a path under the home folder has its name hidden; a relative path is printed as given', () => {
    put('fixtures/a.json', record('run-pa'));
    const absolute = realm(['run', 'import', join(root, 'fixtures')], root, root);
    const relative = realm(['run', 'import', 'fixtures'], root, root);
    // (1) red when the lines bypass the CLI's writer (the home folder's name printed), or a relative
    //     path is rewritten; (2) prints both runs.
    expect({ absolute, relative }).toEqual({
      absolute: {
        code: 0,
        stdout: 'imported  [REDACTED]/fixtures/a.json\n1 file: 1 imported.\n',
        stderr: '',
      },
      relative: {
        code: 0,
        stdout: 'unchanged  fixtures/a.json\n1 file: 1 unchanged.\n',
        stderr: '',
      },
    });
  });

  it('a good path and a missing one: nothing is imported and no store is made, exit 1, the path named', () => {
    const good = put('good/a.json', record('run-g2'));
    const r = realm(['run', 'import', good, 'missing'], root, root);
    // (1) red when the store is opened before every path is checked (`realm.db` made); (2) prints the
    //     run and whether the store file exists.
    expect({ r, store: existsSync(join(root, '.realm', 'realm.db')) }).toEqual({
      r: { code: 1, stdout: '', stderr: 'Error: missing: no such file or folder\n' },
      store: false,
    });
  });

  it("a home that still holds the old store's folders: the open's refusal, which names realm run import; exit 1, nothing on stdout, the home as it was", async () => {
    const home = join(root, '.realm');
    mkdirSync(join(home, 'runs'), { recursive: true });
    writeFileSync(join(home, 'runs', 'r.json'), '{}');
    const before = holds(home);
    put('fixtures/a.json', record('run-o'));
    const r = realm(['run', 'import', 'fixtures'], root, root);
    // (1) red when the legacy guard is bypassed (the file imported), or its refusal is not one line;
    //     (2) prints the run and what the home holds after.
    expect({
      code: r.code,
      stdout: r.stdout,
      oneErrorLine: /^Error: [^\n]*realm run import[^\n]*\n$/.test(r.stderr) ? 'yes' : r.stderr,
      home: holds(home),
    }).toEqual({ code: 1, stdout: '', oneErrorLine: 'yes', home: before });
  });
});
