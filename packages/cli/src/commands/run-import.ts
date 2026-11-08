// run-import.ts — issue #616 PR-2c, unit c11b (design d4-frozen-r3 §5 "Importing runs";
// `plans/issue-616/pr2c/c11/DESIGN-c11.md`): `realm run import <path…>`, the command around c11a's core
// (`run-import-core.ts`). It brings Realm's own JSON documents — bare run records and export bundles —
// from files and folders into the SQLite store, one file after another, in order, each through the
// core's `importFile`, with one line per file, one summary line and the exit code the kubectl rule
// gives: 0 only when every file was `imported` or `unchanged`.
//
// Every argument is looked at FIRST, before the store is opened and before any file is read: a path
// that does not exist, that is neither a file nor a folder, a folder that cannot be listed, or one with
// no `.json` entry is refused, naming the first such path, and nothing is imported. A folder is read
// for its `*.json` entries directly in it (sorted by the default string comparison, not below it); the
// other entries are counted and said, never read. A store-wide failure, or an error nothing expects, is
// a STOP: no further file is started, and the command says where it stopped and what to do.
//
// The logic is `runImport`, which returns the exit code and touches no `process` field; the command is
// a thin wrapper that sets `process.exitCode` and returns — never `process.exit`, which cuts the piped
// output whose last lines are the summary and the stop's explanation. Every string from a file or an
// error goes through the core's `shown`, so no file can make a second line.
import { readdir, stat } from 'node:fs/promises';
import { Command } from 'commander';
import { openRealmHome, type RealmHome } from '@sensigo/realm-store-sqlite';
import {
  counted,
  importFile,
  importLine,
  shown,
  systemWords,
  type ImportHome,
  type ImportWord,
} from './run-import-core.js';

/** Where `runImport` gets its home and writes its lines. */
export interface RunImportIo {
  /** Opens the home: called once, and only after every argument passed its check. */
  readonly openHome: () => Promise<ImportHome>;
  /** One line on standard output. */
  readonly out: (line: string) => void;
  /** One line on standard error. */
  readonly err: (line: string) => void;
}

/** The refusal of a folder with no `.json` entry directly in it. */
const NO_JSON = 'no .json files (a folder is read for .json files directly in it, not below it)';

/** The words in the summary's order, each with how the summary names it. */
const SUMMARY_WORDS: ReadonlyArray<readonly [ImportWord, string]> = [
  ['imported', 'imported'],
  ['unchanged', 'unchanged'],
  ['diverged', 'diverged'],
  ['purged', 'purged'],
  ['legacy', 'legacy'],
  ['not_a_run', 'not a run'],
];

/** The files to import, in order, and how many folder entries are not `.json` files. */
interface Plan {
  readonly files: readonly string[];
  readonly ignored: number;
}

/**
 * Looks at every argument, in order: a file is taken as given; a folder gives its `*.json` entries,
 * sorted by the default string comparison, each named `<the folder as given, its trailing slashes
 * removed>/<name>`. Returns the refusal of the first path that cannot be imported from, or the plan.
 */
async function planOf(paths: readonly string[]): Promise<{ readonly refusal: string } | Plan> {
  const files: string[] = [];
  let ignored = 0;
  for (const given of paths) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      // `stat` follows a link: a link to a file or a folder counts as it.
      info = await stat(given);
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      return {
        refusal: `${shown(given)}: ${missing ? 'no such file or folder' : shown(systemWords(err))}`,
      };
    }
    if (info.isFile()) {
      files.push(given);
      continue;
    }
    if (!info.isDirectory()) return { refusal: `${shown(given)}: neither a file nor a folder` };
    let names: string[];
    try {
      names = await readdir(given);
    } catch (err) {
      return { refusal: `${shown(given)}: ${shown(systemWords(err))}` };
    }
    const json = names.filter((name) => name.endsWith('.json')).sort();
    if (json.length === 0) return { refusal: `${shown(given)}: ${NO_JSON}` };
    ignored += names.length - json.length;
    const folder = given.replace(/\/+$/, '');
    for (const name of json) files.push(`${folder}/${name}`);
  }
  return { files, ignored };
}

/** What the stop says of the files after the one it stopped at, and what to do. */
function notStarted(left: number, stop: 'store' | 'unexpected'): string {
  const next =
    stop === 'store'
      ? 'run the same command again: runs already imported read unchanged.'
      : 'fix or move that file, then run the command again.';
  if (left === 0) return next.charAt(0).toUpperCase() + next.slice(1);
  return `${left === 1 ? '1 file was' : `${left} files were`} not started; ${next}`;
}

/** The summary line: the total, then each word's count in order, a zero count left out. */
function summaryOf(total: number, counts: ReadonlyMap<ImportWord, number>): string {
  const parts = SUMMARY_WORDS.filter(([word]) => (counts.get(word) ?? 0) > 0).map(
    ([word, named]) => `${counts.get(word)} ${named}`,
  );
  return `${counted(total, 'file')}: ${parts.join(', ')}.`;
}

/** The line for the folder entries that were not read. */
function ignoredOf(entries: number): string {
  return entries === 1
    ? 'Ignored 1 entry that is not a .json file.'
    : `Ignored ${entries} entries that are not .json files.`;
}

/**
 * `realm run import <path…>` (see the module comment): checks every argument, then opens the home,
 * imports each file in order, writes its line, and returns the exit code. A refusal of the store's open
 * is thrown as it is (the CLI's entry prints a typed refusal as one `Error:` line).
 */
export async function runImport(paths: readonly string[], io: RunImportIo): Promise<number> {
  const plan = await planOf(paths);
  if ('refusal' in plan) {
    io.err(`Error: ${plan.refusal}`);
    return 1;
  }
  const home = await io.openHome();
  const counts = new Map<ImportWord, number>();
  for (let i = 0; i < plan.files.length; i++) {
    const path = plan.files[i]!;
    const result = await importFile(path, home);
    if (result.kind === 'stop') {
      const error = result.error;
      const message = error instanceof Error ? error.message : String(error);
      io.err(`Error: stopped at ${shown(path)}: ${shown(message)}`);
      if (result.stop === 'unexpected') {
        // The stack AFTER the message (MA 3's rule): the message can hold a file's text, even lines
        // that look like frames, so the stack is cut where the message ends and only the code
        // locations after it are printed; a stack that does not hold the message is printed escaped.
        const stack = String((error as { stack?: unknown } | null)?.stack ?? '');
        const at = stack.indexOf(message);
        if (message !== '' && at >= 0) {
          for (const frame of stack.slice(at + message.length).split('\n')) {
            if (frame !== '') io.err(frame);
          }
        } else if (stack !== '') {
          io.err(shown(stack));
        }
      }
      io.err(notStarted(plan.files.length - i - 1, result.stop));
      return 1;
    }
    counts.set(result.word, (counts.get(result.word) ?? 0) + 1);
    io.out(importLine(result));
  }
  io.out(summaryOf(plan.files.length, counts));
  if (plan.ignored > 0) io.out(ignoredOf(plan.ignored));
  const failed = [...counts.keys()].some((word) => word !== 'imported' && word !== 'unchanged');
  return failed ? 1 : 0;
}

export const runImportCommand = new Command('import')
  .description('Import run records and exports from JSON files into the store')
  .argument('<path...>', 'run record or export files, or folders of them')
  .action(async (paths: string[]) => {
    const opened: { home?: RealmHome } = {};
    try {
      // `process.exitCode`, never `process.exit`: the summary and the stop's lines are the last
      // ones, and `process.exit` cuts output a pipe has not taken yet.
      process.exitCode = await runImport(paths, {
        openHome: async () => (opened.home = await openRealmHome()),
        out: (line) => console.log(line),
        err: (line) => console.error(line),
      });
    } finally {
      opened.home?.close();
    }
  });
