// claim-lease-cw1.test.ts — issue #729, the claim window, unit CW-1: the SQLite store's own cells for
// its claim leases, beside the published contract (`contract-leases-cw1.test.ts`): what `hold()` and
// `probe()` answer when the file system or SQLite refuses a step, that a lease file already there is
// never taken over, and that a second `close()` does nothing. Every lease here is held by this process
// and probed only after it is closed, or never held, or asked for only by an id that is not a plain
// name: no cell needs another process.
//
// The failure cells reach `hold()`'s steps through the module's test seams (`createLeasePort(home,
// seams)`, package-internal). Their errors copy the shapes the platform gives: a SQLite error carries
// `code: 'ERR_SQLITE_ERROR'`, the EXTENDED result code as `errcode` and its text as `errstr`, and no
// errno (CW-AU1-01, CW-AU1R-01: a write into a read-only folder gives 1544); a file-system error carries
// its errno name as `code`, a negative `errno` and its `syscall`.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeaseFact, RunRecord } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAIM_LEASES_FOLDER, createLeasePort, leaseFile, type LeaseSeams } from './claim-lease.js';

const ROOT = process.getuid?.() === 0;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Put back what a cell took away, so the folder can be removed.
    try {
      chmodSync(join(root, CLAIM_LEASES_FOLDER), 0o700);
    } catch {
      // No lease folder in this home.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/** A home folder (only the lease module writes in it here) and its lease folder's path. */
function home(): { home: string; folder: string } {
  const root = mkdtempSync(join(tmpdir(), 'realm-cw1-store-'));
  roots.push(root);
  return { home: root, folder: join(root, CLAIM_LEASES_FOLDER) };
}

function listed(folder: string): string[] {
  try {
    return readdirSync(folder).sort();
  } catch {
    return [];
  }
}

function show(fact: LeaseFact): string {
  return fact.state === 'unknown' ? `unknown(${fact.reason})` : fact.state;
}

/** A record whose one claim names the lease `id`. */
function naming(id: string): RunRecord {
  return { claims: { work: { deadline: null, lease: { id } } } } as unknown as RunRecord;
}

/** A SQLite error as the platform builds one: its extended code, its text, no errno. */
function sqliteError(errcode: number, errstr: string): Error {
  return Object.assign(new Error(errstr), { code: 'ERR_SQLITE_ERROR', errcode, errstr });
}

/** A file-system error as Node builds one. */
function fsError(code: string, errno: number): Error {
  return Object.assign(new Error(`${code}: write`), { code, errno, syscall: 'write' });
}

describe('#729 CW-1 — the SQLite store’s claim leases: its own cells', () => {
  it('a lease folder this program cannot search: a probe answers unknown(permission), and does not throw', async () => {
    const { home: h, folder } = home();
    mkdirSync(folder, { mode: 0o700 });
    chmodSync(folder, 0o600);
    const fact = await createLeasePort(h).probe('a-lease-left-by-another-account');
    // (1) red when the probe's stat error is passed on raw (the promise then rejects) or read as
    //     another reason; (2) prints what the probe answered. As root the folder stays searchable:
    //     no lease by that id exists there, so it reads absent.
    expect(show(fact)).toBe(ROOT ? 'absent' : 'unknown(permission)');
  });

  it('hold() with the lease folder unwritable: { unavailable: permission }, and no file is made', async () => {
    const { home: h, folder } = home();
    mkdirSync(folder, { mode: 0o700 });
    chmodSync(folder, 0o500);
    const result = await createLeasePort(h).hold();
    if (ROOT && 'held' in result) result.held.close();
    // (1) red when the create's EACCES is passed on raw (the promise then rejects) or mapped to
    //     another reason, or a file is left behind; (2) prints the answer and the folder's names.
    expect({
      result: 'held' in result ? 'held' : result,
      files: ROOT ? [] : listed(folder),
    }).toEqual({ result: ROOT ? 'held' : { unavailable: 'permission' }, files: [] });
  });

  it.each<[string, Error, string]>([
    ['SQLite full (13)', sqliteError(13, 'database or disk is full'), 'no_space'],
    [
      'SQLite read-only folder (1544, primary 8)',
      sqliteError(1544, 'attempt to write a readonly database'),
      'permission',
    ],
    ['SQLite UNIQUE (2067, primary 19)', sqliteError(2067, 'UNIQUE constraint failed'), 'io_error'],
    ['the disk full (ENOSPC)', fsError('ENOSPC', -28), 'no_space'],
    ['too many open files (EMFILE)', fsError('EMFILE', -24), 'too_many_files'],
    ['an input/output error (EIO)', fsError('EIO', -5), 'io_error'],
  ])(
    'hold() whose initialising write fails after the file was made (%s): the mapped reason, and no file is left',
    async (_label, error, reason) => {
      const { home: h, folder } = home();
      const seams: LeaseSeams = {
        initialise: () => {
          throw error;
        },
      };
      const result = await createLeasePort(h, seams).hold();
      // (1) red when the error is passed on raw (the promise then rejects), mapped to another reason
      //     (an extended code compared whole, an errno not read), or the file `hold()` created is
      //     kept; (2) prints the answer and the folder's names.
      expect({ result, files: listed(folder) }).toEqual({
        result: { unavailable: reason },
        files: [],
      });
    },
  );

  it("an id whose file already exists is never reused: hold() mints another, and that file's bytes stay as they were", async () => {
    const { home: h, folder } = home();
    mkdirSync(folder, { mode: 0o700 });
    const taken = leaseFile(folder, 'taken');
    writeFileSync(taken, 'a file Realm did not make', { mode: 0o600 });
    const ids = ['taken', 'fresh'];
    const result = await createLeasePort(h, { mintId: () => ids.shift()! }).hold();
    const id = 'held' in result ? result.held.id : `unavailable: ${result.unavailable}`;
    if ('held' in result) result.held.close();
    // (1) red when `hold()` takes over a file that exists (a create that is not exclusive writes
    //     over its bytes; a reuse hands out its id); (2) prints the id handed out and the file's text.
    expect({ id, bytes: readFileSync(taken, 'utf8') }).toEqual({
      id: 'fresh',
      bytes: 'a file Realm did not make',
    });
  });

  it('when every id it mints is taken, hold() answers io_error and changes no file', async () => {
    const { home: h, folder } = home();
    mkdirSync(folder, { mode: 0o700 });
    for (const id of ['a', 'b', 'c']) writeFileSync(leaseFile(folder, id), id, { mode: 0o600 });
    const ids = ['a', 'b', 'c'];
    const result = await createLeasePort(h, { mintId: () => ids.shift() ?? 'none-left' }).hold();
    // (1) red when `hold()` writes over one of the files, or answers otherwise than io_error once its
    //     ids run out; (2) prints the answer and each file's text.
    expect({
      result,
      files: ['a', 'b', 'c'].map((id) => readFileSync(leaseFile(folder, id), 'utf8')),
      names: listed(folder),
    }).toEqual({
      result: { unavailable: 'io_error' },
      files: ['a', 'b', 'c'],
      names: ['a.lease', 'b.lease', 'c.lease'],
    });
  });

  it("an id that is not a plain name reads unknown(not_a_lease), even an id whose `..` leads to a lease held outside this home's claim-leases/", async () => {
    const { home: root } = home();
    // Two homes side by side: `other` holds a lease; `prober` asks with ids that are not plain
    // names, the first leading out of its own lease folder to that held file.
    mkdirSync(join(root, 'other'));
    const result = await createLeasePort(join(root, 'other')).hold();
    if (!('held' in result)) throw new Error(`no lease: ${result.unavailable}`);
    const { held } = result;
    try {
      const prober = createLeasePort(join(root, 'prober'));
      const ids = [
        `../../other/${CLAIM_LEASES_FOLDER}/${held.id}`,
        '',
        '.',
        '..',
        `..\\${held.id}`,
        `${held.id}\0`,
      ];
      const read: Record<string, string> = {};
      for (const id of ids) read[JSON.stringify(id)] = show(await prober.probe(id));
      // (1) red without the check: the `..` id reads `held` (the path is the other home's held
      //     lease), and each other id reads what its path gives (`absent` for the empty id, `.`,
      //     `..` and the `\` one on Linux, `unknown(io_error)` for the NUL one) — and when one member
      //     of the check is dropped, that id alone; (2) prints each id and what it read.
      expect(read).toEqual(
        Object.fromEntries(ids.map((id) => [JSON.stringify(id), 'unknown(not_a_lease)'])),
      );
      // (1) red when the probe made the prober's lease folder; (2) prints the homes' names.
      expect(listed(root)).toEqual(['other']);
    } finally {
      held.close();
    }
  });

  it('a second close() does nothing: the file a first close() kept stays, and reads not_held', async () => {
    const { home: h, folder } = home();
    const port = createLeasePort(h);
    const result = await port.hold();
    if (!('held' in result)) throw new Error(`no lease: ${result.unavailable}`);
    const { held } = result;
    held.close();
    // A record that names no lease: a first close() with it would delete the file.
    held.close(naming('another-lease'));
    const fact = await port.probe(held.id);
    // (1) red when a second close() acts (it then deletes the file the first one kept, and the lease
    //     reads absent); (2) prints the folder's names and what the probe read.
    expect({ files: listed(folder), fact: show(fact) }).toEqual({
      files: [`${held.id}.lease`],
      fact: 'not_held',
    });
  });
});
