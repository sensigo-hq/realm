// callback-key-k2a2.test.ts — callback K2a-2 (R1.3): `realm callback key`, run as the BUILT `realm`
// (`dist/index.js`) with a temporary `HOME`, a workflow folder in the cell's own scratch folder, and
// the master key settings (`REALM_ENCRYPTION_KEY`, `REALM_ENCRYPTION_KEY_FILE`) given per cell, never
// inherited. Where a cell reads the store it opens the home through the library with the master key's
// own sealer. The streams are piped, so the writer masks the values at or under `HOME` (the home's
// path prints as `[REDACTED]/.realm/…`, as a person piping it sees); `shown()` writes that form.
// The last cell reads every stream a cell above captured: no master key in either case anywhere, and no
// callback key on stderr. The injected-collaborator cells are `callback-key-seams-k2a2.test.ts`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createCallbackKeySealer, openRealmHome } from '@sensigo/realm-store-sqlite';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const POSIX = process.platform !== 'win32';
const ROOT_USER = typeof process.getuid === 'function' && process.getuid() === 0;

const takes = (id: string): string =>
  `id: ${id}\nname: ${id}\nversion: 1\ntrigger:\n  type: webhook\n  path: /${id}\n  auth:\n    mode: shared_secret\n    header: X-Token\n    secret_from: K2A2_SECRET\n  params_map:\n    approved: body.approved\n  result_map:\n    approved: context.resources.record.approved\nsteps:\n  record:\n    description: Record.\n    execution: auto\n`;
const plain = (id: string): string =>
  `id: ${id}\nname: ${id}\nversion: 1\nsteps:\n  record:\n    description: Record.\n    execution: auto\n`;

const HOST = 'n8n.example.com';
const H = 'n8n.example.com:443';
const W = 'refunds';
const PAIR = `${W} → ${H}`;
const NOTHING = 'No key was changed.';
const MASTER_A = 'a1'.repeat(32);
const MASTER_B = 'b2'.repeat(32);
const KEY_FORM = /^[0-9a-f]{64}$/;

const fpOfKey = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
const fpOfMaster = (hex: string): string =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8);

/** Every stream every cell captured, and every master key a cell used: read by the last cell. */
const seen: { out: string; err: string }[] = [];
const masters = new Set<string>();
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // gone already
    }
    rmSync(d, { recursive: true, force: true });
  }
});

interface Run {
  code: number | null;
  out: string;
  err: string;
}

/** One cell's scratch: a `HOME`, a workflow folder `wf` (callbacks) and `plain` (none), and `run`. */
function bench() {
  const root = mkdtempSync(join(tmpdir(), 'realm-k2a2-'));
  dirs.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const realm = join(home, '.realm');
  const masterFile = join(realm, 'encryption.key');
  const folder = (name: string, yaml: string): string => {
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, 'workflow.yaml'), yaml);
    return name;
  };
  folder('wf', takes(W));
  folder('plain', plain('plain-flow'));
  const run = (args: readonly string[], env: Readonly<Record<string, string>> = {}): Run => {
    for (const [k, v] of Object.entries(env)) if (k === 'REALM_ENCRYPTION_KEY') masters.add(v);
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1', ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (existsSync(masterFile) && statSync(masterFile).isFile()) {
      try {
        masters.add(readFileSync(masterFile, 'utf8').trim());
      } catch {
        // unreadable on purpose in a cell
      }
    }
    const result = { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    seen.push(result);
    return result;
  };
  /** `realm callback key <args>` with the workflow folder `wf` and `--host n8n.example.com`. */
  const key = (extra: readonly string[] = [], env: Readonly<Record<string, string>> = {}): Run =>
    run(['callback', 'key', 'wf', '--host', HOST, ...extra], env);
  /** A path as the piped writer prints it: `HOME`'s value is personal, so it shows as `[REDACTED]`. */
  const shown = (path: string): string => path.split(home).join('[REDACTED]');
  /** The pair as the store holds it, read through the library with `master`'s sealer. */
  const stored = async (masterHex: string, w = W, h = H) => {
    const handle = await openRealmHome({
      home: realm,
      sealer: createCallbackKeySealer(Buffer.from(masterHex, 'hex')),
    });
    try {
      return await handle.runStore.keys.read(w, h);
    } finally {
      handle.close();
    }
  };
  return { root, home, realm, masterFile, folder, run, key, shown, stored };
}

/** The key a successful run printed: stdout is exactly the key and one newline. */
function printed(r: Run): string {
  expect({
    code: r.code,
    form: KEY_FORM.test(r.out.slice(0, -1)),
    newline: r.out.endsWith('\n'),
  }).toEqual({
    code: 0,
    form: true,
    newline: true,
  });
  return r.out.slice(0, -1);
}

const made = (k: string, m: string, pair = PAIR) =>
  `Made a key for ${pair} (key ${fpOfKey(k)}), sealed with encryption key ${m}.`;
const existing = (k: string, m: string, pair = PAIR) =>
  `Key for ${pair}: key ${fpOfKey(k)}, sealed with encryption key ${m}.`;
const masterMade = (path: string) =>
  `Made the master key file ${path}. Keep a copy of it somewhere safe: 'realm db backup' does not copy it, and a backup without it cannot read the stored keys.`;
const lines = (...l: string[]) => l.map((x) => `${x}\n`).join('');

describe.runIf(POSIX)(
  'callback K2a-2 — realm callback key, on the built CLI',
  { timeout: 120_000 },
  () => {
    it('print and make: the first run makes the master file and a key, the second prints the same key; --whsec', () => {
      const b = bench();
      const first = b.key();
      const k = printed(first);
      const master = readFileSync(b.masterFile, 'utf8');
      const m = fpOfMaster(master.trim());
      const again = b.key();
      const whsec = b.key(['--whsec']);
      // (1) red when the first run makes no master file or no key, prints another stream form, or a
      //     second run makes another key; when `--whsec` is the base64 of the 32 raw bytes, or stdout
      //     carries a second line; (2) prints every stream and the file's facts.
      expect({
        firstErr: first.err,
        master: { mode: (statSync(b.masterFile).mode & 0o777).toString(8), bytes: master.length },
        again: { out: again.out, err: again.err },
        whsec: { code: whsec.code, out: whsec.out, err: whsec.err },
        decoded: Buffer.from(whsec.out.slice('whsec_'.length, -1), 'base64').toString('utf8'),
      }).toEqual({
        firstErr: lines(masterMade(b.shown(b.masterFile)), made(k, m)),
        master: { mode: '600', bytes: 65 },
        again: { out: `${k}\n`, err: lines(existing(k, m)) },
        whsec: {
          code: 0,
          out: `whsec_${Buffer.from(k, 'utf8').toString('base64')}\n`,
          err: lines(existing(k, m)),
        },
        decoded: k,
      });
    });

    it('rotate: a new key, the old kept 24 h (168 with --keep 168), refused while it is live, --end-previous ends it', async () => {
      const b = bench();
      const k0 = printed(b.key());
      const m = readFileSync(b.masterFile, 'utf8').trim();
      const rot = b.key(['--rotate']);
      const k1 = printed(rot);
      const pair1 = await b.stored(m);
      const again = b.key(['--rotate']);
      const pairAgain = await b.stored(m);
      const forced = b.key(['--rotate', '--end-previous', '--keep', '168']);
      const k2 = printed(forced);
      const pair2 = await b.stored(m);
      const hours = (p: typeof pair1) =>
        (Date.parse(p.previous!.expires_at!) - Date.parse(p.current!.created_at)) / 3_600_000;
      const text = (s: (typeof pair1)['current']) => (s?.state === 'readable' ? s.key : s?.state);
      // (1) red when the rotate keeps no previous, keeps it for another span (seconds taken as
      //     hours), applies while the previous is live, ignores --end-previous, or prints another
      //     line; (2) prints the store's pairs and the streams.
      expect({
        rotated: {
          err: rot.err,
          newKey: k1 !== k0,
          current: text(pair1.current),
          previous: text(pair1.previous),
          hours: hours(pair1),
        },
        again: { code: again.code, out: again.out, err: again.err, unchanged: pairAgain },
        forced: {
          current: text(pair2.current),
          previous: text(pair2.previous),
          hours: hours(pair2),
        },
      }).toEqual({
        rotated: {
          err: lines(
            `Rotated the key for ${PAIR}: new key ${fpOfKey(k1)}, sealed with encryption key ${fpOfMaster(m)}. Receivers that still hold the old key (${fpOfKey(k0)}) keep working until ${pair1.previous!.expires_at} (UTC) if they check every signature in the header. To end that sooner, run: realm callback key wf --host ${HOST} --end-previous`,
          ),
          newKey: true,
          current: k1,
          previous: k0,
          hours: 24,
        },
        again: {
          code: 1,
          out: '',
          err: lines(
            `Error: the previous key for ${PAIR} is still valid until ${pair1.previous!.expires_at} (UTC); rotating now would end it. ${NOTHING} Wait for that, or add --end-previous to end it now.`,
          ),
          unchanged: pair1,
        },
        forced: { current: k2, previous: k1, hours: 168 },
      });
    });

    it('rotate refusals: --keep out of range when the command line is read; --keep without --rotate; no key; an unreadable key', () => {
      const b = bench();
      const keeps = ['0', '169', '1.5', 'abc'].map((v) => b.key(['--rotate', '--keep', v]));
      const homeMade = existsSync(b.realm);
      const keepAlone = b.key(['--keep', '24']);
      const noKey = b.key(['--rotate']);
      const madeA = printed(b.key([], { REALM_ENCRYPTION_KEY: MASTER_A }));
      const otherMaster = b.key(['--rotate'], { REALM_ENCRYPTION_KEY: MASTER_B });
      // (1) red when a bad --keep reaches the action (or creates the home), --keep is accepted
      //     alone (a Commander default does that to every call), a rotate with no key makes one, or
      //     an unreadable key is rotated; (2) prints each answer.
      expect({
        keeps: keeps.map((r) => ({ code: r.code, err: r.err })),
        homeMade,
        keepAlone: { code: keepAlone.code, err: keepAlone.err },
        noKey: { code: noKey.code, out: noKey.out, err: noKey.err },
        otherMaster: {
          code: otherMaster.code,
          out: otherMaster.out,
          err: otherMaster.err,
          k: madeA.length,
        },
      }).toEqual({
        keeps: ['0', '169', '1.5', 'abc'].map((v) => ({
          code: 1,
          err: `error: option '--keep <hours>' argument '${v}' is invalid. --keep must be a whole number of hours from 1 to 168.\n`,
        })),
        homeMade: false,
        keepAlone: { code: 1, err: lines('Error: --keep is used with --rotate only.') },
        noKey: {
          code: 1,
          out: '',
          err: lines(
            `Error: there is no key for ${PAIR} to rotate. ${NOTHING} Make one first with: realm callback key wf --host ${HOST}`,
          ),
        },
        otherMaster: {
          code: 1,
          out: '',
          err: lines(
            `Error: the key for ${PAIR} was sealed with encryption key ${fpOfMaster(MASTER_A)}; this process has ${fpOfMaster(MASTER_B)}. ${NOTHING} Set the master key it was sealed with, or run this command with --replace to make a new key (the receiver then needs the new key).`,
          ),
          k: 64,
        },
      });
    });

    it('end and delete: idempotent, need no master key (even a broken one), make no master file, ignore opt-in', async () => {
      const b = bench();
      printed(b.key([], { REALM_ENCRYPTION_KEY: MASTER_A }));
      printed(b.key(['--rotate'], { REALM_ENCRYPTION_KEY: MASTER_A }));
      const broken = { REALM_ENCRYPTION_KEY: 'nothex' };
      const end1 = b.key(['--end-previous'], broken);
      const afterEnd = await b.stored(MASTER_A);
      const end2 = b.key(['--end-previous']);
      const del1 = b.key(['--delete'], broken);
      const afterDelete = await b.stored(MASTER_A);
      const del2 = b.key(['--delete']);
      const plainEnd = b.run(['callback', 'key', 'plain', '--host', HOST, '--end-previous']);
      const plainDel = b.run(['callback', 'key', 'plain', '--host', HOST, '--delete']);
      // (1) red when either resolves the master key (the broken setting then refuses), makes the
      //     master file, tests the workflow for callbacks, or is not idempotent; (2) prints each.
      expect({
        answers: [end1, end2, del1, del2, plainEnd, plainDel].map((r) => ({
          code: r.code,
          out: r.out,
          err: r.err,
        })),
        afterEnd: afterEnd.previous === undefined && afterEnd.current !== undefined,
        afterDelete,
        masterFile: existsSync(b.masterFile),
      }).toEqual({
        answers: [
          { code: 0, out: '', err: lines(`Ended the previous key for ${PAIR}.`) },
          {
            code: 0,
            out: '',
            err: lines(`No previous key was in use for ${PAIR}; nothing changed.`),
          },
          { code: 0, out: '', err: lines(`Deleted the keys for ${PAIR}.`) },
          { code: 0, out: '', err: lines(`There were no keys for ${PAIR}; nothing changed.`) },
          {
            code: 0,
            out: '',
            err: lines(`No previous key was in use for plain-flow → ${H}; nothing changed.`),
          },
          {
            code: 0,
            out: '',
            err: lines(`There were no keys for plain-flow → ${H}; nothing changed.`),
          },
        ],
        afterEnd: true,
        afterDelete: {},
        masterFile: false,
      });
    });

    it('replace: refused on a readable key or none (no master file made); applied on a key of another master; with no master anywhere, makes the file first', async () => {
      const b = bench();
      const none = b.key(['--replace']);
      const noneMasterFile = existsSync(b.masterFile);
      const kA = printed(b.key([], { REALM_ENCRYPTION_KEY: MASTER_A }));
      printed(b.key(['--rotate'], { REALM_ENCRYPTION_KEY: MASTER_A }));
      const beforeReadable = await b.stored(MASTER_A);
      const readable = b.key(['--replace'], { REALM_ENCRYPTION_KEY: MASTER_A });
      const afterReadable = await b.stored(MASTER_A);
      const underB = b.key(['--replace'], { REALM_ENCRYPTION_KEY: MASTER_B });
      const kB = printed(underB);
      const pairB = await b.stored(MASTER_B);
      // The same, with no master anywhere: the file is made, then the key replaced.
      const c = bench();
      printed(c.key([], { REALM_ENCRYPTION_KEY: MASTER_A }));
      const fresh = c.key(['--replace']);
      const kC = printed(fresh);
      const mC = readFileSync(c.masterFile, 'utf8').trim();
      // (1) red when replace accepts a readable key, makes a master file for a pair with no key,
      //     touches the previous, or with no master anywhere replaces without making the file
      //     first; (2) prints each answer and the pairs.
      expect({
        none: { code: none.code, out: none.out, err: none.err, noneMasterFile },
        readable: {
          code: readable.code,
          out: readable.out,
          err: readable.err,
          unchanged: isDeepStrictEqual(afterReadable, beforeReadable),
        },
        underB: {
          err: underB.err,
          current: pairB.current?.state === 'readable' ? pairB.current.key : 'unreadable',
          previous: pairB.previous?.state,
          changed: kB !== kA,
        },
        fresh: fresh.err,
      }).toEqual({
        none: {
          code: 1,
          out: '',
          err: lines(
            `Error: there is no key for ${PAIR} to replace. ${NOTHING} Make one with: realm callback key wf --host ${HOST}`,
          ),
          noneMasterFile: false,
        },
        readable: {
          code: 1,
          out: '',
          err: lines(
            `Error: the key for ${PAIR} can be read, so it was not replaced (--replace is for a key that cannot be read). ${NOTHING} To change a working key, use --rotate.`,
          ),
          unchanged: true,
        },
        underB: {
          err: lines(
            `Replaced the key for ${PAIR}, which could not be read: new key ${fpOfKey(kB)}, sealed with encryption key ${fpOfMaster(MASTER_B)}. Paste the new key into the receiver.`,
          ),
          current: kB,
          previous: 'unreadable',
          changed: true,
        },
        fresh: lines(
          masterMade(c.shown(c.masterFile)),
          `Replaced the key for ${PAIR}, which could not be read: new key ${fpOfKey(kC)}, sealed with encryption key ${fpOfMaster(mC)}. Paste the new key into the receiver.`,
        ),
      });
    });

    it('print on an unreadable key: another master (6c), no master here (6d), damaged under this one', async () => {
      const b = bench();
      printed(b.key([], { REALM_ENCRYPTION_KEY: MASTER_A }));
      const other = b.key([], { REALM_ENCRYPTION_KEY: MASTER_B });
      const noMaster = b.key();
      const noMasterFile = existsSync(b.masterFile);
      // Damage the stored key: one byte of its sealed blob flipped on a foreign connection.
      const db = await openForeignConnection(b.realm);
      try {
        const row = db.prepare("SELECT sealed FROM callback_keys WHERE slot = 'current'").get() as {
          sealed: Uint8Array;
        };
        const blob = Buffer.from(row.sealed);
        blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
        db.prepare("UPDATE callback_keys SET sealed = ? WHERE slot = 'current'").run(blob);
      } finally {
        db.close();
      }
      const damaged = b.key([], { REALM_ENCRYPTION_KEY: MASTER_A });
      const mA = fpOfMaster(MASTER_A);
      // (1) red when an unreadable key prints nothing, is made over, or the three cases share one
      //     sentence; (2) prints each answer.
      expect({
        other: { code: other.code, out: other.out, err: other.err },
        noMaster: { code: noMaster.code, out: noMaster.out, err: noMaster.err, file: noMasterFile },
        damaged: { code: damaged.code, out: damaged.out, err: damaged.err },
      }).toEqual({
        other: {
          code: 1,
          out: '',
          err: lines(
            `Error: the key for ${PAIR} was sealed with encryption key ${mA}; this process has ${fpOfMaster(MASTER_B)}. ${NOTHING} Set the master key it was sealed with, or run this command with --replace to make a new key (the receiver then needs the new key).`,
          ),
        },
        noMaster: {
          code: 1,
          out: '',
          err: lines(
            `Error: the key for ${PAIR} was sealed with encryption key ${mA}; this shell has no master key. ${NOTHING} Set the master key it was sealed with, or run this command with --replace to make a new key and a new master key file ${b.shown(b.masterFile)} (the receiver then needs the new key).`,
          ),
          file: false,
        },
        damaged: {
          code: 1,
          out: '',
          err: lines(
            `Error: the key for ${PAIR} cannot be read although it was sealed with this encryption key (${mA}); it is damaged. ${NOTHING} Run this command with --replace to make a new key (the receiver then needs the new key).`,
          ),
        },
      });
    });

    it('opt-in: a workflow with no result_map is refused by print, --rotate and --replace; nothing is made', () => {
      const b = bench();
      const said = (extra: string[]) =>
        b.run(['callback', 'key', 'plain', '--host', HOST, ...extra], {
          REALM_ENCRYPTION_KEY: MASTER_A,
        });
      const answers = [said([]), said(['--rotate']), said(['--replace'])];
      const sentence = `Error: workflow 'plain-flow' does not take callbacks: its trigger has no result_map, and Realm answers a callback address only for a workflow that has one, so a key for it would never be used. ${NOTHING} Add a result_map to its trigger, then run this command again. A key made earlier is removed with: realm callback key plain --host ${HOST} --delete`;
      // (1) red when the opt-in test is missing (a key or a home is made), or words differ;
      //     (2) prints each answer and whether a home was made.
      expect({
        answers: answers.map((r) => ({ code: r.code, out: r.out, err: r.err })),
        home: existsSync(b.realm),
      }).toEqual({
        answers: [0, 1, 2].map(() => ({ code: 1, out: '', err: lines(sentence) })),
        home: false,
      });
    });

    it('flag checks in order, the first only; the nine entry words; --host missing; two spellings of one host', () => {
      const b = bench();
      const flag = (extra: string[]) => {
        const r = b.key(extra);
        return { code: r.code, err: r.err };
      };
      const entry = (host: string) => {
        const r = b.run(['callback', 'key', 'wf', '--host', host]);
        return { code: r.code, err: r.err };
      };
      const give =
        'Give a host name or address, with a port if it is not 443: n8n.example.com, or http://n8n.lan:5678 for a receiver on plain http.';
      const refused = (host: string | undefined, phrase: string) =>
        lines(
          `Error: --host${host === undefined ? '' : ` ${JSON.stringify(host)}`} is not a receiver address: ${phrase}. ${give}`,
        );
      const missing = b.run(['callback', 'key', 'wf']);
      const upper = printed(b.run(['callback', 'key', 'wf', '--host', 'N8N.Example.COM:8443']));
      const lower = printed(b.run(['callback', 'key', 'wf', '--host', 'n8n.example.com:8443']));
      // (1) red when a later check speaks first, the userinfo entry is echoed, a phrase differs, or
      //     the label is built from the typed text (two keys for one host); (2) prints each answer.
      expect({
        flags: [
          flag(['--rotate', '--replace']),
          flag(['--end-previous', '--delete']),
          flag(['--keep', '5']),
          flag(['--whsec', '--delete']),
          flag(['--replace', '--delete', '--keep', '5', '--whsec']),
        ],
        entries: [
          entry('n8n.example.com/hook'),
          entry('user:pw@n8n.example.com'),
          entry('*.example.com'),
          entry('[::1]:443'),
          entry('a:b:c'),
          entry('n8n.example.com:99999'),
          entry('https://n8n.example.com'),
          entry(''),
          entry('ex ample.com'),
        ],
        missing: { code: missing.code, err: missing.err },
        sameKey: upper === lower,
      }).toEqual({
        flags: [
          {
            code: 1,
            err: lines(
              'Error: --rotate, --replace and --delete cannot be used together; give one.',
            ),
          },
          {
            code: 1,
            err: lines(
              'Error: --end-previous goes with --rotate, or alone; it cannot be used with --replace or --delete.',
            ),
          },
          { code: 1, err: lines('Error: --keep is used with --rotate only.') },
          {
            code: 1,
            err: lines(
              'Error: --whsec chooses how a key is printed; --delete and --end-previous print no key.',
            ),
          },
          {
            code: 1,
            err: lines(
              'Error: --rotate, --replace and --delete cannot be used together; give one.',
            ),
          },
        ],
        entries: [
          { code: 1, err: refused('n8n.example.com', 'it has a path, query or fragment') },
          { code: 1, err: refused(undefined, 'it has a user name or password') },
          { code: 1, err: refused('*.example.com', 'it has a wildcard') },
          {
            code: 1,
            err: refused('[::1]:443', 'it has brackets (IPv6 addresses are not accepted)'),
          },
          { code: 1, err: refused('a:b:c', 'it has a stray colon') },
          {
            code: 1,
            err: refused('n8n.example.com:99999', 'its port is not a whole number from 1 to 65535'),
          },
          { code: 1, err: refused('https://n8n.example.com', 'only http:// may start it') },
          { code: 1, err: refused('', 'it has no host') },
          { code: 1, err: refused('ex ample.com', 'it is not a valid host name') },
        ],
        missing: { code: 1, err: "error: required option '--host <entry>' not specified\n" },
        sameKey: true,
      });
    });

    it('the master key: each invalid source with its reason; nothing is replaced', () => {
      const b = bench();
      writeFileSync(join(b.root, 'bad.key'), 'nothex\n');
      writeFileSync(join(b.root, 'empty.key'), '');
      writeFileSync(join(b.root, 'locked.key'), `${MASTER_A}\n`, { mode: 0o600 });
      chmodSync(join(b.root, 'locked.key'), 0o000);
      const tail = `${NOTHING} A master key is 64 hexadecimal characters. Make one with: openssl rand -hex 32`;
      const env = (what: string, reason: string) =>
        lines(`Error: ${what} is not a master key: ${reason}. ${tail}`);
      const FILE = 'the file REALM_ENCRYPTION_KEY_FILE names';
      const answer = (env: Record<string, string>) => {
        const r = b.key([], env);
        return { code: r.code, out: r.out, err: r.err };
      };
      const got = {
        malformed: answer({ REALM_ENCRYPTION_KEY: 'nothex' }),
        relative: answer({ REALM_ENCRYPTION_KEY_FILE: 'master.key' }),
        badContent: answer({ REALM_ENCRYPTION_KEY_FILE: join(b.root, 'bad.key') }),
        empty: answer({ REALM_ENCRYPTION_KEY_FILE: join(b.root, 'empty.key') }),
        ...(ROOT_USER
          ? {}
          : { unreadable: answer({ REALM_ENCRYPTION_KEY_FILE: join(b.root, 'locked.key') }) }),
      };
      chmodSync(join(b.root, 'locked.key'), 0o600);
      mkdirSync(b.realm, { recursive: true });
      symlinkSync(join(b.root, 'nowhere.key'), b.masterFile);
      const dangling = answer({});
      const danglingTargetMade = existsSync(join(b.root, 'nowhere.key'));
      rmSync(b.masterFile);
      mkdirSync(b.masterFile);
      const directory = answer({});
      const stillDirectory = statSync(b.masterFile).isDirectory();
      const path = b.shown(b.masterFile);
      // (1) red when a source's reason is another's (a relative path called malformed), a source
      //     falls through to the next, or an entry at the home path is replaced; (2) prints each.
      expect({ ...got, dangling, danglingTargetMade, directory, stillDirectory }).toEqual({
        malformed: {
          code: 1,
          out: '',
          err: env('REALM_ENCRYPTION_KEY', 'it is not 64 hexadecimal characters'),
        },
        relative: { code: 1, out: '', err: env(FILE, 'its path is not absolute') },
        badContent: { code: 1, out: '', err: env(FILE, 'it is not 64 hexadecimal characters') },
        empty: { code: 1, out: '', err: env(FILE, 'it is empty') },
        ...(ROOT_USER
          ? {}
          : { unreadable: { code: 1, out: '', err: env(FILE, 'it cannot be read') } }),
        dangling: { code: 1, out: '', err: env(path, 'it cannot be read') },
        danglingTargetMade: false,
        directory: { code: 1, out: '', err: env(path, 'it cannot be read') },
        stillDirectory: true,
      });
    });

    it('no master here and other keys stored: Words 4 (5 named, "and 1 more"), no file made; its advice works', () => {
      const b = bench();
      for (let i = 1; i <= 6; i += 1)
        printed(
          b.run(['callback', 'key', 'wf', '--host', `h${i}.example.com`], {
            REALM_ENCRYPTION_KEY: MASTER_A,
          }),
        );
      const refused = b.key();
      const fileAfter = existsSync(b.masterFile);
      const shownPairs = [1, 2, 3, 4, 5].map((i) => `${W} → h${i}.example.com:443`).join(', ');
      // Its advice: --replace for the first pair it names, its workflow file and its host.
      const advice = b.run(['callback', 'key', 'wf', '--host', 'h1.example.com:443', '--replace']);
      const k = printed(advice);
      const m = readFileSync(b.masterFile, 'utf8').trim();
      // (1) red when a second master key is made while keys exist, the list is not capped, or the
      //     advice fails; (2) prints each answer.
      expect({
        refused: { code: refused.code, out: refused.out, err: refused.err },
        fileAfter,
        advice: advice.err,
      }).toEqual({
        refused: {
          code: 1,
          out: '',
          err: lines(
            `Error: this shell has no master key, and this home holds keys sealed with encryption key ${fpOfMaster(MASTER_A)}: ${shownPairs} and 1 more. Set REALM_ENCRYPTION_KEY, REALM_ENCRYPTION_KEY_FILE or REALM_ENCRYPTION_KEY_COMMAND to the key they were sealed with, or restore ${b.shown(b.masterFile)}. If it is lost, make a new master key by running this command with --replace for one of them (the workflow file whose id is ${W}, if it still takes callbacks, with --host h1.example.com:443), or remove them with --delete; every key made under the old one then needs its own --replace. ${NOTHING}`,
          ),
        },
        fileAfter: false,
        advice: lines(
          masterMade(b.shown(b.masterFile)),
          `Replaced the key for ${W} → h1.example.com:443, which could not be read: new key ${fpOfKey(k)}, sealed with encryption key ${fpOfMaster(m)}. Paste the new key into the receiver.`,
        ),
      });
    });

    it('a setting and a different encryption.key: print warns (Words 9), make, rotate and replace refuse (Words 7)', () => {
      const b = bench();
      const env = { REALM_ENCRYPTION_KEY: MASTER_A };
      const kA = printed(b.key([], env));
      printed(
        b.run(['callback', 'key', 'wf', '--host', 'c.example.com'], {
          REALM_ENCRYPTION_KEY: MASTER_B,
        }),
      );
      writeFileSync(b.masterFile, `${MASTER_B}\n`, { mode: 0o600 });
      const print = b.key([], env);
      const make = b.run(['callback', 'key', 'wf', '--host', 'new.example.com'], env);
      const rotate = b.key(['--rotate'], env);
      const replace = b.run(['callback', 'key', 'wf', '--host', 'c.example.com', '--replace'], env);
      const clash = `REALM_ENCRYPTION_KEY gives encryption key ${fpOfMaster(MASTER_A)}, but ${b.shown(b.masterFile)} holds encryption key ${fpOfMaster(MASTER_B)}`;
      const refusal = lines(
        `Error: ${clash}. Keys written now would be unreadable to a process that uses the file. ${NOTHING} Unset the setting or make the file match, then run this command again.`,
      );
      // (1) red when a differing file is not refused for a write, or a print of a readable key is
      //     refused; (2) prints each answer.
      expect({
        print: { code: print.code, out: print.out, err: print.err },
        writes: [make, rotate, replace].map((r) => ({ code: r.code, out: r.out, err: r.err })),
      }).toEqual({
        print: {
          code: 0,
          out: `${kA}\n`,
          err: lines(`Warning: ${clash}.`, existing(kA, fpOfMaster(MASTER_A))),
        },
        writes: [0, 1, 2].map(() => ({ code: 1, out: '', err: refusal })),
      });
    });

    it('a master key file open to others: Words 8 on print, make, rotate and replace', () => {
      const b = bench();
      const named = join(b.root, 'wide master.key');
      writeFileSync(named, `${MASTER_A}\n`);
      chmodSync(named, 0o644);
      const env = { REALM_ENCRYPTION_KEY_FILE: named };
      printed(
        b.run(['callback', 'key', 'wf', '--host', 'c.example.com'], {
          REALM_ENCRYPTION_KEY: MASTER_B,
        }),
      );
      const make = b.key([], env);
      const k = printed(make);
      const print = b.key([], env);
      const rotate = b.key(['--rotate'], env);
      const replace = b.run(['callback', 'key', 'wf', '--host', 'c.example.com', '--replace'], env);
      const warning = `Warning: ${named} is open to other users (mode 0644). Fix that with: chmod 600 '${named}'`;
      const first = (r: Run) => r.err.split('\n')[0];
      // (1) red when the warning is said on print only, or names another mode or path; (2) prints
      //     each answer's first line.
      expect({
        codes: [make, print, rotate, replace].map((r) => r.code),
        first: [make, print, rotate, replace].map(first),
        key: k.length,
      }).toEqual({ codes: [0, 0, 0, 0], first: [warning, warning, warning, warning], key: 64 });
    });

    it('printed commands paste: 6a, 6e, 11 and the rotated line, run in bash, address the same pair; none ends in a full stop', () => {
      const b = bench();
      const bin = join(b.root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'realm'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`);
      chmodSync(join(bin, 'realm'), 0o755);
      b.folder('my flows', takes(W));
      b.folder('plain flows', plain('plain-flow'));
      const entry = 'N8N.Example.com.';
      const label = 'n8n.example.com.:443';
      const env = { REALM_ENCRYPTION_KEY: MASTER_A };
      const after = (text: string, marker: string): string =>
        text.slice(text.lastIndexOf(marker) + marker.length).trimEnd();
      const rotate6a = b.run(['callback', 'key', 'my flows', '--host', entry, '--rotate'], env);
      const replace6e = b.run(['callback', 'key', 'my flows', '--host', entry, '--replace'], env);
      const notTaking11 = b.run(['callback', 'key', 'plain flows', '--host', entry], env);
      const commands = {
        sixA: after(rotate6a.err, 'with: '),
        sixE: after(replace6e.err, 'with: '),
        eleven: after(notTaking11.err, 'with: '),
      };
      const bash = (line: string) => {
        const r = spawnSync('bash', ['-c', line], {
          cwd: b.root,
          env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: b.home, NO_COLOR: '1', ...env },
          encoding: 'utf8',
        });
        seen.push({ out: r.stdout, err: r.stderr });
        return { code: r.status, out: r.stdout, err: r.stderr };
      };
      const made6a = bash(commands.sixA);
      const k = made6a.out.trim();
      const again6e = bash(commands.sixE);
      const rotated = b.run(['callback', 'key', 'my flows', '--host', entry, '--rotate'], env);
      const runLine = after(rotated.err, 'run: ');
      const ended = bash(runLine);
      const deleted = bash(commands.eleven);
      // (1) red when a printed command ends in a full stop, carries a typed word bare that the shell
      //     splits (the space), or addresses another pair (the dot dropped); (2) prints each line.
      expect({
        lines: [commands.sixA, commands.sixE, commands.eleven, runLine].map((l) => ({
          l,
          dot: l.endsWith('.'),
        })),
        made: {
          code: made6a.code,
          form: KEY_FORM.test(k),
          pair: made6a.err.split('\n')[0]!.split(' (key')[0],
        },
        sixE: { code: again6e.code, sameKey: again6e.out.trim() === k },
        ended: { code: ended.code, err: ended.err },
        deleted: { code: deleted.code, err: deleted.err },
      }).toEqual({
        lines: [
          { l: `realm callback key 'my flows' --host 'N8N.Example.com.'`, dot: false },
          { l: `realm callback key 'my flows' --host 'N8N.Example.com.'`, dot: false },
          { l: `realm callback key 'plain flows' --host 'N8N.Example.com.' --delete`, dot: false },
          {
            l: `realm callback key 'my flows' --host 'N8N.Example.com.' --end-previous`,
            dot: false,
          },
        ],
        made: { code: 0, form: true, pair: `Made a key for ${W} → ${label}` },
        sixE: { code: 0, sameKey: true },
        ended: { code: 0, err: lines(`Ended the previous key for ${W} → ${label}.`) },
        deleted: {
          code: 0,
          err: lines(`There were no keys for plain-flow → ${label}; nothing changed.`),
        },
      });
    });

    it("Words 2's claim: realm db backup copies no encryption.key and no master key", () => {
      const b = bench();
      printed(b.key());
      const master = readFileSync(b.masterFile, 'utf8').trim();
      const target = join(b.root, 'backups', 'copy.db');
      mkdirSync(dirname(target));
      const backup = b.run(['db', 'backup', target]);
      const bytes = readFileSync(target);
      // (1) red when the backup takes the master key file, or its text or bytes reach the copy;
      //     (2) prints the backup's answer and the folder.
      expect({
        code: backup.code,
        folder: readdirSync(dirname(target)).filter((n) => n.endsWith('.key')),
        hex: bytes.includes(Buffer.from(master, 'utf8')),
        raw: bytes.includes(Buffer.from(master, 'hex')),
      }).toEqual({ code: 0, folder: [], hex: false, raw: false });
    });

    it('a workflow that cannot be loaded: Words 12, as realm listen says it; no home is made', () => {
      const b = bench();
      const r = b.run(['callback', 'key', 'missing', '--host', HOST]);
      // (1) red when a load failure escapes unworded, or the home is opened before the workflow is
      //     read; (2) prints the answer.
      expect({ code: r.code, out: r.out, err: r.err, home: existsSync(b.realm) }).toEqual({
        code: 1,
        out: '',
        err: lines(
          "Error: failed to load workflow 'missing/workflow.yaml': Failed to read workflow file: ENOENT: no such file or directory, open 'missing/workflow.yaml'",
        ),
        home: false,
      });
    });

    it('a --host value that begins -- is refused by the option-value guard, on the real command', () => {
      const b = bench();
      const r = b.run(['callback', 'key', 'wf', '--host', '--rotate']);
      // (1) red when the group is missing from attachOptionValueGuard (Commander takes --rotate as
      //     the host); (2) prints the answer.
      expect({
        code: r.code,
        out: r.out,
        home: existsSync(b.realm),
        says: r.err.split('\n')[0],
      }).toEqual({
        code: 1,
        out: '',
        home: false,
        says: "error: option '--host <entry>' argument is ambiguous: '--rotate' looks like a flag.",
      });
    });
  },
);

/** Starts `count` built `realm` runs at once behind a go-file barrier, each with its own arguments. */
async function together(
  b: ReturnType<typeof bench>,
  argsOf: (n: number) => string[],
  count: number,
): Promise<Run[]> {
  const barrier = join(b.root, `barrier-${randomBytes(3).toString('hex')}`);
  mkdirSync(barrier);
  // A file, not `node -e`: Commander reads an eval'd script's arguments from another position.
  const childFile = join(barrier, 'child.mjs');
  const child = [
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    'const [cli, barrier, n, ...args] = process.argv.slice(2);',
    "writeFileSync(join(barrier, 'ready-' + n), '');",
    'const nap = new Int32Array(new SharedArrayBuffer(4));',
    "while (!existsSync(join(barrier, 'go'))) Atomics.wait(nap, 0, 0, 1);",
    'process.argv = [process.argv[0], cli, ...args];',
    'await import(pathToFileURL(cli).href);',
  ].join('\n');
  writeFileSync(childFile, child);
  const runs = Array.from({ length: count }, (_, n) => {
    const p = spawn(process.execPath, [childFile, CLI, barrier, String(n), ...argsOf(n)], {
      cwd: b.root,
      env: { PATH: process.env['PATH'] ?? '', HOME: b.home, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (c: Buffer) => (out += c.toString()));
    p.stderr.on('data', (c: Buffer) => (err += c.toString()));
    return new Promise<Run>((done) =>
      p.on('close', (code) => {
        seen.push({ out, err });
        done({ code, out, err });
      }),
    );
  });
  const by = Date.now() + 30_000;
  const ready = () => readdirSync(barrier).filter((f) => f.startsWith('ready-')).length;
  while (ready() < count && Date.now() < by) await new Promise((t) => setTimeout(t, 5));
  writeFileSync(join(barrier, 'go'), '');
  const results = await Promise.all(runs);
  if (existsSync(b.masterFile)) masters.add(readFileSync(b.masterFile, 'utf8').trim());
  return results;
}

describe.runIf(POSIX)(
  'callback K2a-2 — first runs in parallel, on the built CLI',
  { timeout: 120_000 },
  () => {
    it('two processes on an empty home print the same key and leave one encryption.key', async () => {
      const b = bench();
      const [one, two] = await together(b, () => ['callback', 'key', 'wf', '--host', HOST], 2);
      // (1) red when the second process, finding the file another made, does not re-read it (it would
      //     refuse, or make a second master); (2) prints both answers and the folder.
      expect({
        codes: [one!.code, two!.code],
        same: one!.out === two!.out && KEY_FORM.test(one!.out.trim()),
        files: readdirSync(b.realm).filter(
          (n) => n.startsWith('encryption') || n.startsWith('.encryption'),
        ),
      }).toEqual({ codes: [0, 0], same: true, files: ['encryption.key'] });
    }, 60_000);

    it('eight processes, eight workflows: every one prints a key, none says "no master key", one file', async () => {
      const b = bench();
      for (let n = 0; n < 8; n += 1) b.folder(`wf${n}`, takes(`flow-${n}`));
      const results = await together(b, (n) => ['callback', 'key', `wf${n}`, '--host', HOST], 8);
      // (1) red when a process that sees another's pair in the listing does not read the master
      //     key again (it then says this shell has no master key); (2) prints every answer.
      expect({
        codes: results.map((r) => r.code),
        keys: results.filter((r) => KEY_FORM.test(r.out.trim())).length,
        saysNoMaster: results.filter((r) => r.err.includes('has no master key')).length,
        files: readdirSync(b.realm).filter(
          (n) => n.startsWith('encryption') || n.startsWith('.encryption'),
        ),
      }).toEqual({ codes: Array(8).fill(0), keys: 8, saysNoMaster: 0, files: ['encryption.key'] });
    }, 90_000);

    it('correction 1: four processes, one workflow and host, 20 rounds on fresh homes: one key each round, none says "no master key"', async () => {
      const rounds: unknown[] = [];
      for (let round = 0; round < 20; round += 1) {
        const b = bench();
        const results = await together(b, () => ['callback', 'key', 'wf', '--host', HOST], 4);
        const keys = new Set(results.map((r) => r.out));
        rounds.push({
          codes: results.map((r) => r.code),
          oneKey: keys.size === 1 && KEY_FORM.test([...keys][0]!.trim()),
          saysNoMaster: results.filter((r) => r.err.includes('has no master key')).length,
          files: readdirSync(b.realm).filter(
            (n) => n.startsWith('encryption') || n.startsWith('.encryption'),
          ),
        });
      }
      // (1) red when a process that reads no master key, then finds this pair's key made by another
      //     process (sealed, so unreadable to it), does not read the master key once more: it says
      //     "this shell has no master key" (14 of 40 rounds on 8a17a468); (2) prints every round.
      expect(rounds).toEqual(
        Array.from({ length: 20 }, () => ({
          codes: [0, 0, 0, 0],
          oneKey: true,
          saysNoMaster: 0,
          files: ['encryption.key'],
        })),
      );
    }, 300_000);
  },
);

describe.runIf(POSIX)(
  'callback K2a-2 — the key on a terminal, and the disclosure canary',
  { timeout: 120_000 },
  () => {
    it('the built command prints the key, not [REDACTED], piped and on a pseudo-terminal', () => {
      const b = bench();
      const piped = printed(b.key());
      const hasScript =
        spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0;
      if (!hasScript) {
        console.warn(
          'callback K2a-2: `script` is not installed, so the pseudo-terminal half is not run',
        );
        return;
      }
      const line = `"${process.execPath}" "${CLI}" callback key wf --host ${HOST}`;
      const tty = spawnSync('script', ['-qec', line, '/dev/null'], {
        cwd: b.root,
        env: { PATH: process.env['PATH'] ?? '', HOME: b.home, NO_COLOR: '1', TERM: 'dumb' },
        encoding: 'utf8',
      });
      seen.push({ out: tty.stdout, err: tty.stderr });
      // (1) red when the callback key is declared to the writer (it then prints as [REDACTED]);
      //     (2) prints the terminal's text.
      expect({
        code: tty.status,
        key: tty.stdout.split(/\r?\n/).includes(piped),
        redacted: tty.stdout.split('[REDACTED]').length - 1,
      }).toEqual({ code: 0, key: true, redacted: 0 });
    });

    it('over every cell above: no master key in either case on any stream; a callback key only on stdout', () => {
      const streams = seen.map((s) => `${s.out}\n${s.err}`).join('\n');
      const stderr = seen.map((s) => s.err).join('\n');
      const keys = new Set(
        seen.flatMap((s) => s.out.split(/\r?\n/).filter((l) => KEY_FORM.test(l))),
      );
      const found = [...masters].filter((m) => KEY_FORM.test(m.toLowerCase()));
      // (1) red when a master key reaches any stream, or a printed callback key reaches stderr;
      //     (2) prints the offending fingerprints only (never the text).
      expect({
        mastersChecked: found.length > 3,
        keysChecked: keys.size > 10,
        masterLeaks: found
          .filter(
            (m) =>
              streams.split(m.toLowerCase()).length > 1 ||
              streams.split(m.toUpperCase()).length > 1,
          )
          .map(fpOfMaster),
        keyOnStderr: [...keys].filter((k) => stderr.split(k).length > 1).map(fpOfKey),
      }).toEqual({ mastersChecked: true, keysChecked: true, masterLeaks: [], keyOnStderr: [] });
    });
  },
);
