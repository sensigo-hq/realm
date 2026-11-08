// run-import-pipeline-616.test.ts — issue #616 PR-2c, unit c11c: `realm run import`'s bounded pipeline
// (`runImport` in `run-import.ts`) and the core's split (`prepareFile` / `commitFile` in
// `run-import-core.ts`). The real cases: a folder of many files whose reads finish out of order (a
// slow disk, a large file before small ones); two files naming the same run; a store that stops
// partway with files already read ahead; a long import that must show it is going on, and must not
// hold every file it has read; an object with no id, which only the save can name.
//
// In-process: `prepare` and `commit` are the `RunImportIo` members, wrapped or stubbed per cell; the
// instruments record file NUMBERS, never the `ready` objects (a kept object would make the correct loop
// fail the memory cell). Each assertion carries (1) the break that turns it red and (2) what it prints
// on failure: the order of the calls and the lines, never a record's content.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { RunRecord } from '@sensigo/realm';
import { openRealmHome, type RealmHome } from '@sensigo/realm-store-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { runImport, type RunImportIo } from './run-import.js';
import {
  commitFile,
  prepareFile,
  type ImportHome,
  type ImportOutcome,
  type ImportResult,
  type PreparedFile,
  type ReadyFile,
} from './run-import-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const PAGE = 'docs/reference/cli/realm-run-acting.md';

const roots: string[] = [];
const homes: RealmHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A scratch folder. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'realm-616-c11c-'));
  roots.push(root);
  return root;
}

/** A real store home in a scratch folder. */
async function storeHome(): Promise<RealmHome> {
  const home = await openRealmHome({ home: join(scratch(), '.realm') });
  homes.push(home);
  return home;
}

/** `n` files `001.json` … in a scratch folder, each `content(i)` (1-based); their paths in order. */
function files(n: number, content: (i: number) => string = () => ''): string[] {
  const dir = scratch();
  const paths: string[] = [];
  for (let i = 1; i <= n; i++) {
    const path = join(dir, `${String(i).padStart(3, '0')}.json`);
    writeFileSync(path, content(i));
    paths.push(path);
  }
  return paths;
}

/** A file's number, from its name `NNN.json`. */
const numberOf = (path: string): number => Number(/(\d{3})\.json$/.exec(path)![1]);

/** One turn of the event loop. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const ticks = async (n: number): Promise<void> => {
  for (let k = 0; k < n; k++) await tick();
};

/** A live run another store exported, in the record's own shape. */
function record(id: string): RunRecord {
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
    created_at: '2026-11-01T10:00:00.000Z',
    updated_at: '2026-11-01T10:10:00.000Z',
    terminal_state: false,
  };
}

/** A file's outcome as a stub gives it. */
const word = (path: string, w: ImportOutcome['word'] = 'imported'): ImportOutcome => ({
  kind: 'word',
  path,
  word: w,
  reason: undefined,
  notes: [],
});

/** A ready file as a stub gives it: no text, an empty record. */
const ready = (path: string): ReadyFile => ({ kind: 'ready', path, record: {}, bundle: undefined });

/** The io of a cell: stdout and stderr into one ordered log, a home no stub uses. */
function io(
  over: Partial<RunImportIo>,
  home: ImportHome = { runStore: undefined as never },
): { io: RunImportIo; log: Array<['out' | 'err', string]> } {
  const log: Array<['out' | 'err', string]> = [];
  return {
    log,
    io: {
      openHome: async () => home,
      out: (line) => void log.push(['out', line]),
      err: (line) => void log.push(['err', line]),
      ...over,
    },
  };
}

/** The file number a file's stdout line names (`<word>  <path>…`); any other line as it is. */
const lineNumber = (line: string): number | string => {
  const found = /^\S+ {2}\S*?(\d{3})\.json/.exec(line);
  return found === null ? line : Number(found[1]);
};

/** (1) red when the page no longer holds the sentence word for word; (2) prints the sentence. */
function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

describe('#616 PR-2c c11c — realm run import reads ahead and saves in path order', () => {
  it('check 1: reads that finish out of order still give the lines, and the saves, in path order; one save at a time', async () => {
    const paths = files(120, (i) =>
      i === 5 || i === 50
        ? '{ not json'
        : JSON.stringify(record(i === 3 || i === 7 ? 'run-same' : `run-${i}`)),
    );
    const home = await storeHome();
    const commits: number[] = [];
    let saving = false;
    const { io: cellIo, log } = io(
      {
        // File i is held 120 − i ticks: file 7 is ready before file 3.
        prepare: async (path) => {
          await ticks(120 - numberOf(path));
          return prepareFile(path);
        },
        commit: async (file, h) => {
          if (saving) throw new Error(`a second save began at file ${numberOf(file.path)}`);
          saving = true;
          commits.push(numberOf(file.path));
          try {
            await ticks(2);
            return await commitFile(file, h);
          } finally {
            saving = false;
          }
        },
      },
      home,
    );
    const code = await runImport(paths, cellIo);
    const lines = log.filter(([s]) => s === 'out').map(([, l]) => l);
    const fileLines = lines.slice(0, 120);
    const at = (n: number): string => fileLines[n - 1]!.split('  ')[0]!;
    // (1) red when a file is saved as soon as its read is done (file 7 then reads `imported` and
    //     file 3 `unchanged`, the lines and saves leave path order), when two saves overlap (the
    //     instrument throws), or when a finished outcome is given to `commit`; (2) prints the file
    //     numbers in line order, the words of files 3, 5, 7 and 50, the order of the saves and the
    //     files never saved.
    expect({
      lineOrder: fileLines.map(lineNumber),
      words: [at(3), at(5), at(7), at(50)],
      commits,
      summary: lines[120],
      code,
    }).toEqual({
      lineOrder: [...Array(120).keys()].map((k) => k + 1),
      words: ['imported', 'not_a_run', 'unchanged', 'not_a_run'],
      commits: [...Array(120).keys()].map((k) => k + 1).filter((n) => n !== 5 && n !== 50),
      summary: '120 files: 117 imported, 1 unchanged, 2 not a run.',
      code: 1,
    });
  }, 60_000);

  it('check 2: at most 32 files are in flight — started and not yet printed — and the window fills to 32', async () => {
    const paths = files(100);
    let prepared = 0;
    let printed = 0;
    let most = 0;
    const note = (): void => {
      most = Math.max(most, prepared - printed);
    };
    const { io: cellIo } = io({
      out: () => {
        printed += 1;
        note();
      },
      prepare: async (path) => {
        prepared += 1;
        note();
        await tick();
        return ready(path);
      },
      // The head's save is held, so prepared files wait in the window.
      commit: async (file) => {
        await ticks(5);
        return word(file.path);
      },
    });
    await runImport(paths, cellIo);
    // (1) red when the window is 33 (33 in flight), when it is 1 (1), or when the loop counts only
    //     the reads still running, so prepared files waiting for their save are not counted (more
    //     than 32); (2) prints the most in flight at once and the counts of reads and lines.
    expect({ most, prepared, printed }).toEqual({ most: 32, prepared: 100, printed: 101 });
  }, 60_000);

  it('check 2b: a printed file’s text and record are dropped — the loop keeps no reference to them', async () => {
    const paths = files(150);
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const refs: Array<WeakRef<object> | undefined> = [];
    let live = -1;
    const { io: cellIo } = io({
      prepare: async (path) => {
        const record = { lines: new Array<number>(2_000).fill(numberOf(path)) };
        refs[numberOf(path)] = new WeakRef(record);
        return { kind: 'ready', path, record, bundle: undefined };
      },
      commit: async (file) => {
        const n = numberOf(file.path);
        if (n === 120) {
          // Two turns of the event loop: a WeakRef's target is kept to the end of the turn it was made in.
          await tick();
          await tick();
          gc();
          live = refs.slice(1, 119).filter((r) => r?.deref() !== undefined).length;
        }
        return word(file.path);
      },
    });
    await runImport(paths, cellIo);
    // (1) red when the loop keeps every file's promise (or its prepared file) after its line, so the
    //     records of files 1–118 are still held at file 120's save (118 of them live); (2) prints how
    //     many of those records were still live.
    expect(live).toBe(0);
  }, 60_000);

  it('check 3: for more than 100 files, `<done> of <total> files` on stderr after every 100th line, never after the last', async () => {
    const paths = files(300);
    const progress = async (total: number) => {
      const { io: cellIo, log } = io({
        prepare: async (path) => ready(path),
        commit: async (file) => word(file.path),
      });
      await runImport(paths.slice(0, total), cellIo);
      return log;
    };
    const rows: Record<number, string[]> = {};
    const onStdout: string[] = [];
    let at250: Array<number | string> = [];
    for (const total of [99, 100, 101, 200, 250, 300]) {
      const log = await progress(total);
      rows[total] = log.filter(([s]) => s === 'err').map(([, l]) => l);
      onStdout.push(
        ...log.filter(([s, l]) => s === 'out' && / of \d+ files$/.test(l)).map(([, l]) => l),
      );
      if (total === 250) {
        const i = log.findIndex(([s, l]) => s === 'err' && l === '100 of 250 files');
        const near = (k: number): number | string =>
          log[k] === undefined ? '(no line)' : lineNumber(log[k]![1]);
        at250 = i < 0 ? ['no `100 of 250 files` on stderr'] : [near(i - 1), near(i + 1)];
      }
    }
    // (1) red when a line goes out per file, when the last-file guard is dropped (the 200 and 300 rows
    //     gain `200 of 200 files` and `300 of 300 files`), when the line goes to stdout, or when the
    //     count is taken when a file is read rather than printed (the line lands before the 100th
    //     file's line); (2) prints each total's stderr lines, any progress line on stdout and the
    //     files on each side of `100 of 250 files`.
    expect({ rows, onStdout, at250 }).toEqual({
      rows: {
        99: [],
        100: [],
        101: ['100 of 101 files'],
        200: ['100 of 200 files'],
        250: ['100 of 250 files', '200 of 250 files'],
        300: ['100 of 300 files', '200 of 300 files'],
      },
      onStdout: [],
      at250: [100, 101],
    });
  }, 60_000);

  it('check 4: a STOP with files read ahead saves nothing after it; the not-started count and the lines are as before', async () => {
    const stopAt = async (total: number, at: number) => {
      const paths = files(total);
      let commits = 0;
      const { io: cellIo, log } = io({
        prepare: async (path) => ready(path),
        commit: async (file): Promise<ImportResult> => {
          commits += 1;
          await tick();
          if (numberOf(file.path) === at) {
            return {
              kind: 'stop',
              path: file.path,
              stop: 'store',
              error: Object.assign(new Error('the store stayed busy'), { code: 'STATE_RUN_BUSY' }),
            };
          }
          return word(file.path);
        },
      });
      const code = await runImport(paths, cellIo);
      return {
        code,
        commits,
        stdout: log.filter(([s]) => s === 'out').map(([, l]) => lineNumber(l)),
        stderr: log
          .filter(([s]) => s === 'err')
          .map(([, l]) => l.replace(/^Error: stopped at \S+:/, 'Error: stopped at <file>:')),
      };
    };
    const five = await stopAt(200, 5);
    const hundred = await stopAt(250, 100);
    // (1) red when a file after the STOP is saved (more saves than the file it stopped at), when the
    //     not-started count is not the files after it, or when a progress line is printed for a file
    //     whose line never was; (2) prints the exit, the saves, the stdout files and the stderr lines.
    expect({ five, hundredStderr: hundred.stderr, hundredCommits: hundred.commits }).toEqual({
      five: {
        code: 1,
        commits: 5,
        stdout: [1, 2, 3, 4],
        stderr: [
          'Error: stopped at <file>: the store stayed busy',
          '195 files were not started; run the same command again: runs already imported read unchanged.',
        ],
      },
      hundredStderr: [
        'Error: stopped at <file>: the store stayed busy',
        '150 files were not started; run the same command again: runs already imported read unchanged.',
      ],
      hundredCommits: 100,
    });
  }, 60_000);
});

describe('#616 PR-2c c11c — the core in two halves', () => {
  it('check 5: prepareFile reads and classifies; an object with no id is ready, and only its save names it', async () => {
    const run = record('run-split');
    const [bare, bundled, array, empty] = files(4, (i) =>
      JSON.stringify(
        [run, { realm_export_version: 5, run, disclosure: {} }, [], {}][i - 1] as unknown,
      ),
    );
    const pieces = async (path: string) => {
      const p: PreparedFile = await prepareFile(path);
      return p.kind === 'ready'
        ? { kind: p.kind, record: p.record, bundle: p.bundle !== undefined }
        : { kind: p.kind, word: p.word, reason: p.reason };
    };
    const home = await storeHome();
    const emptyReady = await prepareFile(empty!);
    const emptyCommitted =
      emptyReady.kind === 'ready' ? await commitFile(emptyReady, home) : emptyReady;
    // (1) red when the id check moves into `prepareFile` (`{}` is then a finished `not_a_run`, not
    //     ready), when a bundle's record or bundle is lost, or when `[]` reaches the save; (2) prints
    //     each file's kind with its word and reason, whether a bundle came with the record, and the
    //     word and reason of `{}` after its save.
    expect({
      bare: await pieces(bare!),
      bundled: await pieces(bundled!),
      array: await pieces(array!),
      empty: await pieces(empty!),
      emptyCommitted:
        emptyCommitted.kind === 'word'
          ? [emptyCommitted.word, emptyCommitted.reason]
          : ['stop', emptyCommitted.stop],
    }).toEqual({
      bare: { kind: 'ready', record: JSON.parse(JSON.stringify(run)), bundle: false },
      bundled: { kind: 'ready', record: JSON.parse(JSON.stringify(run)), bundle: true },
      array: { kind: 'word', word: 'not_a_run', reason: 'not a run: it is not an object' },
      empty: { kind: 'ready', record: {}, bundle: false },
      emptyCommitted: ['not_a_run', 'neither a run record nor an export (it has no id)'],
    });
  }, 60_000);

  it('check 6: the page says the progress line (check 3 executes it)', () => {
    claim(
      PAGE,
      'For more than 100 files, a line on the error output (stderr) every 100 files says how many are done (`100 of 250 files`), so a long import shows it is going on.',
    );
  });
});
