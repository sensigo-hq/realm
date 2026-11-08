// home.ts — issue #616 PR-1a unit 7a (design d4-frozen-r3 §2 "The one open", steps 3-4, and §4):
// prepares a Realm home for its database, before any connection to it exists in the process. In
// this order:
//   1. the home folder: made when it is missing (with any missing folders above it); a home that
//      cannot be made, or that exists and cannot be written, is refused with
//      `STATE_STORE_READONLY`, naming the path and the operating system's reason;
//   2. the old-store guard: each of the four names the JSON store used is `lstat`-ed. A directory,
//      or a symbolic link to one, is an old store; anything else that is not Realm's fence file is
//      "something else". Either is refused with `STATE_HOME_HOLDS_LEGACY_STORE`, naming every such
//      entry at once, and nothing is written;
//   3. the fences: a fence file is placed at each absent name, by a temporary file `link`ed to the
//      name, so the name exists only with its full content. An older Realm that tries to write a
//      run, a workflow, a replay or a dedup marker there then fails at its own `mkdir`;
//   4. the file: `realm.db` absent → created EMPTY and owner-only (0600) by the one exclusive
//      create; SQLite gives its `-wal` and `-shm` the file's mode. A `realm.db` that exists is left
//      for the open (unit 7b), which checks it.
// Only Realm's own names are touched: `realm.db` (here only by that create), the four fence names,
// and each fence's temporary file, which only the opener that made it removes. Every other entry in
// the home is never read, moved or deleted. Nothing here renames, copies or deletes the database
// file, and no error replaces it.
import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getSystemErrorMap } from 'node:util';
import { WorkflowError } from '@sensigo/realm';
import { readOnlyError } from './connection.js';
import { VERSION } from './version.js';

/**
 * The operating system's text for `errno` (`permission denied`), in Node's words. It reads
 * `getSystemErrorMap` (Node 16), never `getSystemErrorMessage` (Node 22.12): the package must load
 * on every Node the CLI allows, so that its own loader can refuse a Node without SQLite in one line
 * instead of the CLI dying at start. An errno Node does not know reads as Node's own text for it.
 */
export function systemErrorText(errno: number): string {
  return getSystemErrorMap().get(errno)?.[1] ?? `Unknown system error ${errno}`;
}

/** The database file's name in the home. */
export const DATABASE_FILE = 'realm.db';

/** The four names the JSON store used, in the order a refusal names them. */
export const LEGACY_STORE_NAMES = ['runs', 'workflows', 'replays', 'dedup'] as const;

/** A fence file's first line: how every Realm, this one and later ones, recognises a fence. */
export const FENCE_MARKER = 'realm store fence 1';

/** The most a fence check reads of a file at an old name. */
const FENCE_READ_BYTES = 4096;

/** The text of the fence placed at `name`: the marker line, then what happened, for a person. */
export function fenceText(name: string): string {
  return (
    `${FENCE_MARKER}\n` +
    `Realm ${VERSION} placed this file. Realm keeps its store in realm.db in this folder. ` +
    `Versions before the SQLite store kept a folder named ${name} here; this file stops them from ` +
    'writing here, so they fail at once instead of starting a second store. Do not delete it ' +
    'while Realm uses this folder.\n'
  );
}

/** What the guard found at one old name. */
type Found = 'absent' | 'fence' | 'legacy' | 'other';

/** An error the operating system gave a filesystem call (`errno`, `code`, `syscall`). */
function isSystemError(err: unknown): err is NodeJS.ErrnoException & { errno: number } {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).errno === 'number' &&
    typeof (err as NodeJS.ErrnoException).code === 'string'
  );
}

/** Runs a filesystem write of the preparation; a failure is refused as `path` not writable. */
function writing<T>(path: string, op: () => T): T {
  try {
    return op();
  } catch (err) {
    if (isSystemError(err)) throw readOnlyError(path, systemErrorText(err.errno));
    throw err;
  }
}

/**
 * Whether the regular file at `path` is a fence: its first line is exactly the marker. The file is
 * opened without following a link and without blocking, and read only after `fstat` confirms it is
 * a regular file, at most {@link FENCE_READ_BYTES}.
 */
function isFence(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    // It changed between the `lstat` and this open (now a link, or gone): not a fence.
    return false;
  }
  try {
    if (!fstatSync(fd).isFile()) return false;
    const buffer = Buffer.alloc(FENCE_READ_BYTES);
    const read = readSync(fd, buffer, 0, FENCE_READ_BYTES, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const end = text.indexOf('\n');
    return end !== -1 && text.slice(0, end) === FENCE_MARKER;
  } finally {
    closeSync(fd);
  }
}

/**
 * What is at an old name, by `lstat`. A name that is not a regular file is never opened; a symbolic
 * link is followed only by `stat`, to see whether it leads to a directory. An `lstat` failure other
 * than "no such file" passes up unchanged, with its operating-system code.
 */
function inspect(path: string): Found {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw err;
  }
  if (entry.isDirectory()) return 'legacy';
  if (entry.isSymbolicLink()) {
    try {
      return statSync(path).isDirectory() ? 'legacy' : 'other';
    } catch {
      return 'other'; // a link that leads nowhere, or round in a loop
    }
  }
  if (entry.isFile()) return isFence(path) ? 'fence' : 'other';
  return 'other'; // a socket, a pipe, a device
}

/** The guard's refusal: the old store directories first, then each other entry, in name order. */
function guardRefusal(
  home: string,
  found: ReadonlyArray<{ name: string; is: Found }>,
): WorkflowError {
  const legacy = found.filter((f) => f.is === 'legacy').map((f) => f.name);
  const other = found.filter((f) => f.is === 'other').map((f) => f.name);
  const sentences: string[] = [];
  if (legacy.length > 0) {
    sentences.push(
      `This Realm keeps its store in realm.db and does not read the old JSON directories (${legacy.join(', ')}) in ${home}. Move them out of the home, then import what you want to keep with \`save()\` or \`realm run import\`.`,
    );
  }
  for (const name of other) {
    sentences.push(
      `${join(home, name)} exists and is neither a Realm fence file nor an old store directory. Realm will not touch it. Move or remove it, then open the store again.`,
    );
  }
  return new WorkflowError(sentences.join(' '), {
    code: 'STATE_HOME_HOLDS_LEGACY_STORE',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    details: { home, legacy, other },
  });
}

/**
 * Places the fence at `name`: writes it under a temporary name of its own (exclusive, mode 0444,
 * synced), then `link`s it to the name, so the name exists only with its full content. `EEXIST`
 * means another opener placed something there first: a fence is fine, anything else is refused as
 * the guard would. The temporary file is removed on every path; a `link` the filesystem does not
 * support is refused as the name not writable.
 */
function placeFence(home: string, name: string): void {
  const target = join(home, name);
  const temp = join(
    home,
    `.realm-fence-${name}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = writing(temp, () => openSync(temp, 'wx', 0o444));
  try {
    try {
      writing(temp, () => {
        fchmodSync(fd, 0o444); // whatever the umask
        writeSync(fd, fenceText(name));
        fsyncSync(fd);
      });
    } finally {
      closeSync(fd);
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        linkSync(temp, target);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw isSystemError(err) ? readOnlyError(target, systemErrorText(err.errno)) : err;
        }
      }
      const is = inspect(target);
      if (is === 'fence') return;
      // Gone again before it could be looked at: link once more; a second time, it is refused.
      if (is !== 'absent' || attempt === 2) {
        throw guardRefusal(home, [{ name, is: is === 'absent' ? 'other' : is }]);
      }
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Only this opener made the temporary file; if it cannot be removed, it is left behind.
    }
  }
}

/** Creates the database file EMPTY and owner-only, exclusively; false when one already exists. */
function createDatabaseFile(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  closeSync(fd);
  return true;
}

/**
 * Prepares the Realm home at `home` for its database (see the module comment) and returns the
 * database file's path. The open (unit 7b) continues from there: it checks the file, sets it up and
 * opens the connection. With `check` (the maintenance entry opened for `'check'`, #616 PR-2c c8a1) it
 * only looks: the folder's writability and the old-store guard, with their refusals unchanged; it
 * makes no folder, no fence and no file.
 */
export function prepareHome(home: string, check = false): string {
  writing(home, () => {
    if (!check) mkdirSync(home, { recursive: true });
    accessSync(home, constants.W_OK | constants.X_OK);
  });
  const found = LEGACY_STORE_NAMES.map((name) => ({ name, is: inspect(join(home, name)) }));
  if (found.some((f) => f.is === 'legacy' || f.is === 'other')) throw guardRefusal(home, found);
  const database = join(home, DATABASE_FILE);
  // #616 PR-2c c8a1: the check looks and makes nothing — no folder, no fence, no file.
  if (check) return database;
  for (const f of found) if (f.is === 'absent') placeFence(home, f.name);
  writing(database, () => createDatabaseFile(database));
  return database;
}
