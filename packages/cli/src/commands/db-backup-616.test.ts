// db-backup-616.test.ts — issue #616 PR-2c, unit c6: `realm db backup <path>` as a user runs it. The
// cells run the BUILT `realm` (tests run after the build) with PATH, HOME and REALM_NO_NUDGE only, in
// a scratch working folder; HOME is a scratch folder whose `.realm` the test first opens through the
// store package's own `openRealmHome` (the CLI's test helper opens the JSON store until unit c10a)
// and closes. The real cases: a backup that works and says so in one line; a user who types a path
// inside the home, or one where a file is; a home with no store yet; a store file that is not a
// database. Each refusal is one `Error:` line on stderr, exit code 1, nothing on stdout, and the home
// as it was. The quick check's failure line is not run here (it needs the store's quick-check seam
// inside the child): the store's cell (6) pins its words, and the CLI prints the store's message as
// it is.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRealmHome } from '@sensigo/realm-store-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');

let root = '';
let base = '';
let home = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-616-c6-home-'));
  base = mkdtempSync(join(tmpdir(), 'realm-616-c6-cwd-'));
  home = join(root, '.realm');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the built `realm` with HOME set to the scratch root; a run that hangs is killed (a red). */
function realm(args: string[]): Run {
  const r = spawnSync(process.execPath, [DIST_CLI, ...args], {
    cwd: base,
    env: { PATH: process.env['PATH'] ?? '', HOME: root, REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    killSignal: 'SIGKILL',
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * A path as the CLI prints it when its output is piped (a log): the scratch HOME's own path is masked
 * (`[REDACTED]`, #729 PR-3); the rest of the path is printed as it is.
 */
function shown(path: string): string {
  return path.replace(root, '[REDACTED]');
}

/** Makes the home's store through the store package's own open, with one run, and closes it. */
async function makeStore(): Promise<void> {
  const h = await openRealmHome({ home });
  await h.runStore.create({
    workflowId: 'triage',
    workflowVersion: 1,
    params: {},
    extensionIdentity: [],
  });
  h.close();
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

describe('#616 PR-2c c6 — realm db backup, on the built CLI', () => {
  it('a backup prints one line naming the store, its version, the bytes and the copy', async () => {
    await makeStore();
    const copy = join(base, 'copy.db');
    const r = realm(['db', 'backup', copy]);
    const bytes = statSync(copy).size;
    // (1) red when the line is minted with other words, another figure or another path, or when
    //     the command writes to stderr or exits non-zero; (2) prints the run.
    expect(r).toEqual({
      code: 0,
      stdout: `Backed up ${shown(join(home, 'realm.db'))} (schema version 1, ${bytes} bytes) to ${copy}; the copy passes SQLite's quick check.\n`,
      stderr: '',
    });
  });

  it('each refusal is one Error line, exit 1, nothing on stdout, the home as it was: inside the home, a path where a file is, no store, a store file that is not a database', async () => {
    // No store: a HOME whose .realm was never made.
    const none = realm(['db', 'backup', join(base, 'a.db')]);
    const noneHomeMade = readdirSync(root).includes('.realm');
    const noneFile = join(home, 'realm.db');

    await makeStore();
    const before = holds(home);
    const inside = join(home, 'x.db');
    const insideRun = realm(['db', 'backup', inside]);
    const insideAfter = holds(home);
    const taken = join(base, 'taken.db');
    writeFileSync(taken, 'the user keeps this');
    const takenRun = realm(['db', 'backup', taken]);
    const takenText = readFileSync(taken, 'utf8');

    // A store file that is not a database: the home made by the open (its fences in place), the
    // file then overwritten with text.
    writeFileSync(noneFile, 'not a database\n');
    const textBefore = holds(home);
    const textRun = realm(['db', 'backup', join(base, 'b.db')]);
    const textAfter = holds(home);
    // (1) red when a refusal's code is not in the CLI's set of expected refusals (the error then
    //     escapes with its stack trace), when the entry opens before it looks (the home made), when
    //     a refusal is printed with other words, or when the home or the user's file is changed;
    //     (2) prints each run and what the home held before and after.
    expect({
      none,
      noneHomeMade,
      inside: insideRun,
      insideHome: insideAfter,
      taken: takenRun,
      takenText,
      text: textRun,
      textHome: textAfter,
      made: readdirSync(base).sort(),
    }).toEqual({
      none: {
        code: 1,
        stdout: '',
        stderr: `Error: There is no store file at ${shown(noneFile)} to back up.\n`,
      },
      noneHomeMade: false,
      inside: {
        code: 1,
        stdout: '',
        stderr: `Error: Cannot back up the store to ${shown(inside)}: it is inside the Realm home ${shown(home)}. Write the copy outside the home.\n`,
      },
      insideHome: before,
      taken: {
        code: 1,
        stdout: '',
        stderr: `Error: Cannot back up the store to ${taken}: a file already exists there. Realm never replaces a file; name a path where nothing exists.\n`,
      },
      takenText: 'the user keeps this',
      text: {
        code: 1,
        stdout: '',
        stderr: `Error: The store file ${shown(noneFile)} is not a Realm store this Realm can use: it is not a SQLite database (SQLite: file is not a database). Realm does not change or replace a store file by itself.\n`,
      },
      textHome: textBefore,
      made: ['taken.db'],
    });
  });

  it('realm --help lists db, and realm db --help lists backup', () => {
    const top = realm(['--help']);
    const db = realm(['db', '--help']);
    // (1) red when the db group is not added to the program, or backup not to the group;
    //     (2) prints both help lines found (or none).
    const line = (text: string, start: RegExp): string =>
      (text.split('\n').find((l) => start.test(l)) ?? 'none').trim().replace(/\s+/g, ' ');
    expect({
      top: line(top.stdout, /^\s+db\s/),
      db: line(db.stdout, /^\s+backup\s/),
    }).toEqual({
      top: 'db Maintain the store file',
      db: 'backup <path> Copy the store file to a new file outside the Realm home, and',
    });
  });
});
