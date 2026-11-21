// master-key-command-cli-k2b.test.ts — callback K2b (R1.3; the owner's yes eaa442b9): the master key's
// command source, `REALM_ENCRYPTION_KEY_COMMAND`, through the BUILT `realm` (`dist/index.js`):
// `realm callback key` (B1, B2, B5; the command runs once per invocation and never for a drop) and
// `realm db check`'s callback key counts (B3). Each cell has a temporary `HOME` and its own scripts;
// a counter file the scripts append to says how often Realm ran them. The streams are piped, so the
// writer masks the values at or under `HOME` (`[REDACTED]/.realm/…`). Skipped on win32 (the scripts
// are POSIX shell); every describe carries a time budget.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCallbackKeySealer, openRealmHome } from '@sensigo/realm-store-sqlite';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const POSIX = process.platform !== 'win32';

const takes = (id: string): string =>
  `id: ${id}\nname: ${id}\nversion: 1\ntrigger:\n  type: webhook\n  path: /${id}\n  auth:\n    mode: shared_secret\n    header: X-Token\n    secret_from: K2B_SECRET\n  params_map:\n    approved: body.approved\n  result_map:\n    approved: context.resources.record.approved\nsteps:\n  record:\n    description: Record.\n    execution: auto\n`;

const HOST = 'n8n.example.com';
const H = 'n8n.example.com:443';
const W = 'refunds';
const PAIR = `${W} → ${H}`;
const NOTHING = 'No key was changed.';
const MASTER_A = 'a1'.repeat(32);
const MASTER_B = 'b2'.repeat(32);
const MASTER_C = 'c3'.repeat(32);
const TOKEN = 'FAKE-TOKEN-0001';
const KEY_FORM = /^[0-9a-f]{64}$/;
const RULE =
  'Never delete, move or replace realm.db or its side files while a Realm process is running.';

const fpOfKey = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
const fpOfMaster = (hex: string): string =>
  createHash('sha256').update(Buffer.from(hex, 'hex')).digest('hex').slice(0, 8);
const lines = (...l: string[]) => l.map((x) => `${x}\n`).join('');
const b1 = (reason: string, tail: string) =>
  lines(
    `Error: REALM_ENCRYPTION_KEY_COMMAND did not give a master key: ${reason}. ${NOTHING} ${tail}`,
  );
const BY_HAND = 'Run the command by hand to see why.';
const VALUE = 'Check the value of REALM_ENCRYPTION_KEY_COMMAND.';
const OUTPUT =
  'The command must print the master key, 64 hexadecimal characters, and nothing else.';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  out: string;
  err: string;
}

/** One cell's scratch: a `HOME`, a workflow folder `wf`, scripts and their counter, and `run`. */
function bench() {
  const root = mkdtempSync(join(tmpdir(), 'realm-k2b-cli-'));
  dirs.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  const realm = join(home, '.realm');
  const masterFile = join(realm, 'encryption.key');
  const counter = join(root, 'counter');
  mkdirSync(join(root, 'wf'));
  writeFileSync(join(root, 'wf', 'workflow.yaml'), takes(W));
  /** A shell script that adds a line to the counter first: its path as a command value (quoted). */
  const script = (name: string, body: string, mode = 0o755): string => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\nprintf 'x\\n' >> '${counter}'\n${body}\n`);
    chmodSync(path, mode);
    return `"${path}"`;
  };
  /** A command source that prints `hex`. */
  const printing = (hex: string): Record<string, string> => ({
    REALM_ENCRYPTION_KEY_COMMAND: script(`print-${hex.slice(0, 4)}`, `printf '%s\\n' ${hex}`),
  });
  const runs = (): number =>
    existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').length - 1 : 0;
  const run = (args: readonly string[], env: Readonly<Record<string, string>> = {}): Run => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: home,
        NO_COLOR: '1',
        REALM_NO_NUDGE: '1',
        ...env,
      },
      encoding: 'utf8',
      timeout: 60_000,
      killSignal: 'SIGKILL',
    });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  const key = (extra: readonly string[] = [], env: Readonly<Record<string, string>> = {}): Run =>
    run(['callback', 'key', 'wf', '--host', HOST, ...extra], env);
  const shown = (path: string): string => path.split(home).join('[REDACTED]');
  /** The pair's current slot as the store holds it, read with `masterHex`'s sealer. */
  const stored = async (masterHex: string, w = W, h = H) => {
    const handle = await openRealmHome({
      home: realm,
      sealer: createCallbackKeySealer(Buffer.from(masterHex, 'hex')),
    });
    try {
      return (await handle.runStore.keys.read(w, h)).current;
    } finally {
      handle.close();
    }
  };
  /** Makes a key for each `[workflow, host]` under `masterHex`, through the library. */
  const seed = async (masterHex: string, pairs: readonly [string, string][], rotate = false) => {
    const handle = await openRealmHome({
      home: realm,
      sealer: createCallbackKeySealer(Buffer.from(masterHex, 'hex')),
    });
    try {
      for (const [w, h] of pairs) {
        await handle.runStore.keys.make(w, h, 'd4'.repeat(32));
        if (rotate)
          await handle.runStore.keys.rotate(w, h, { candidate: 'e5'.repeat(32), keepSeconds: 60 });
      }
    } finally {
      handle.close();
    }
  };
  return { root, home, realm, masterFile, script, printing, runs, run, key, shown, stored, seed };
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

describe.runIf(POSIX)(
  'callback K2b — realm callback key with a command source',
  { timeout: 120_000 },
  () => {
    it('print makes a key sealed under the command’s master and prints it again; the command runs once per invocation; no encryption.key', async () => {
      const b = bench();
      const env = b.printing(MASTER_C);
      const first = b.key([], env);
      const k = printed(first);
      const again = b.key([], env);
      const current = await b.stored(MASTER_C);
      const runsAfterTwo = b.runs();
      const rotated = b.key(['--rotate'], env);
      // (1) red when the command runs more than once per invocation (a re-resolve that runs it again),
      //     the key is sealed under another master, a master key file is made beside a command source,
      //     or a rotate fails; (2) prints each answer, the store's slot and the counts.
      expect({
        first: first.err,
        again: { out: again.out, err: again.err },
        current: current?.state === 'readable' ? current.key : current?.state,
        runsAfterTwo,
        rotated: rotated.code,
        runs: b.runs(),
        masterFile: existsSync(b.masterFile),
      }).toEqual({
        first: lines(made(k, fpOfMaster(MASTER_C))),
        again: { out: `${k}\n`, err: lines(existing(k, fpOfMaster(MASTER_C))) },
        current: k,
        runsAfterTwo: 2,
        rotated: 0,
        runs: 3,
        masterFile: false,
      });
    });

    it('seven of B1’s eight reasons, sentence for sentence: exit 1, nothing made, the token never printed', () => {
      const b = bench();
      const answer = (value: string) => {
        const r = b.key([], { REALM_ENCRYPTION_KEY_COMMAND: value });
        return { code: r.code, out: r.out, err: r.err };
      };
      const got = {
        status: answer(b.script('exit3', 'exit 3')),
        signal: answer(b.script('killed', 'kill -9 $$')),
        notStarted: answer(`/nonexistent/op read x --token ${TOKEN}`),
        notExecutable: answer(b.script('plain', `printf '%s\\n' ${MASTER_A}`, 0o644)),
        unclosed: answer(`${b.script('quote', 'exit 0')} "a`),
        noProgram: answer('"" read x'),
        empty: answer(b.script('empty', 'exit 0')),
        malformed: answer(b.script('short', `printf '%s\\n' ${MASTER_A.slice(1)}`)),
      };
      const fail = (err: string) => ({ code: 1, out: '', err });
      // (1) red when a reason is another's, a tail is another's (the openssl advice), a failure falls
      //     through to make a master key file or a home, or the token is printed; (2) prints each answer.
      expect({
        ...got,
        tokenPrinted: JSON.stringify(got).includes(TOKEN),
        homeMade: existsSync(b.realm),
      }).toEqual({
        status: fail(b1('its command exited with status 3', BY_HAND)),
        signal: fail(b1('its command was ended by SIGKILL', BY_HAND)),
        notStarted: fail(b1('its command could not be started (ENOENT)', BY_HAND)),
        notExecutable: fail(b1('its command could not be started (EACCES)', BY_HAND)),
        unclosed: fail(b1('its value has an unclosed quote', VALUE)),
        noProgram: fail(b1('its value names no program', VALUE)),
        empty: fail(b1('its output is empty', OUTPUT)),
        malformed: fail(b1('its output is not 64 hexadecimal characters', OUTPUT)),
        tokenPrinted: false,
        homeMade: false,
      });
    });

    it('a failing command never lets a key or a master key file be made: print, --rotate and --replace, with keys stored', async () => {
      const b = bench();
      await b.seed(MASTER_A, [[W, H]]);
      const env = { REALM_ENCRYPTION_KEY_COMMAND: b.script('fail', 'exit 5') };
      const answers = [b.key([], env), b.key(['--rotate'], env), b.key(['--replace'], env)];
      const other = b.run(['callback', 'key', 'wf', '--host', 'new.example.com'], env);
      const current = await b.stored(MASTER_A);
      const fresh = await b.stored(MASTER_A, W, 'new.example.com:443');
      // (1) red when an invalid command falls through to the home (a master key file made, a key made
      //     or replaced); (2) prints each answer and the store's slots.
      expect({
        answers: [...answers, other].map((r) => ({ code: r.code, out: r.out, err: r.err })),
        masterFile: existsSync(b.masterFile),
        current: current?.state === 'readable' ? current.key : current?.state,
        fresh: fresh ?? 'none',
      }).toEqual({
        answers: [0, 1, 2, 3].map(() => ({
          code: 1,
          out: '',
          err: b1('its command exited with status 5', BY_HAND),
        })),
        masterFile: false,
        current: 'd4'.repeat(32),
        fresh: 'none',
      });
    });

    it('a command key and a different encryption.key: print warns (Words 9), make, rotate and replace refuse (Words 7), naming the command', async () => {
      const b = bench();
      const env = b.printing(MASTER_A);
      const kA = printed(b.key([], env));
      await b.seed(MASTER_B, [[W, 'c.example.com:443']]);
      writeFileSync(b.masterFile, `${MASTER_B}\n`, { mode: 0o600 });
      const print = b.key([], env);
      const make = b.run(['callback', 'key', 'wf', '--host', 'new.example.com'], env);
      const rotate = b.key(['--rotate'], env);
      const replace = b.run(['callback', 'key', 'wf', '--host', 'c.example.com', '--replace'], env);
      const clash = `REALM_ENCRYPTION_KEY_COMMAND gives encryption key ${fpOfMaster(MASTER_A)}, but ${b.shown(b.masterFile)} holds encryption key ${fpOfMaster(MASTER_B)}`;
      const refusal = lines(
        `Error: ${clash}. Keys written now would be unreadable to a process that uses the file. ${NOTHING} Unset the setting or make the file match, then run this command again.`,
      );
      // (1) red when the clash names another source (the file REALM_ENCRYPTION_KEY_FILE names), a
      //     differing file is not refused for a write, or a readable key's print is refused; (2) prints
      //     each answer.
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

    it('--end-previous and --delete never run the command', async () => {
      const b = bench();
      await b.seed(MASTER_A, [[W, H]], true);
      const env = b.printing(MASTER_A);
      const ended = b.key(['--end-previous'], env);
      const deleted = b.key(['--delete'], env);
      // (1) red when a drop resolves the master key (the command runs); (2) prints both answers and
      //     the count.
      expect({
        ended: { code: ended.code, err: ended.err },
        deleted: { code: deleted.code, err: deleted.err },
        runs: b.runs(),
      }).toEqual({
        ended: { code: 0, err: lines(`Ended the previous key for ${PAIR}.`) },
        deleted: { code: 0, err: lines(`Deleted the keys for ${PAIR}.`) },
        runs: 0,
      });
    });

    it('never shown: a command that writes the master key to stderr, or to stdout, and exits 2 (callback key and db check)', async () => {
      const b = bench();
      await b.seed(MASTER_B, [[W, H]]);
      const forms = [
        MASTER_A,
        MASTER_A.toUpperCase(),
        Buffer.from(MASTER_A, 'utf8').toString('base64'),
      ];
      const toStderr = {
        REALM_ENCRYPTION_KEY_COMMAND: b.script('err', `printf '%s\\n' ${MASTER_A} >&2\nexit 2`),
      };
      const toStdout = {
        REALM_ENCRYPTION_KEY_COMMAND: b.script('out', `printf '%s\\n' ${MASTER_A}\nexit 2`),
      };
      const all = [
        b.key([], toStderr),
        b.key([], toStdout),
        b.run(['db', 'check'], toStderr),
        b.run(['db', 'check', '--json'], toStdout),
      ];
      const text = all.map((r) => r.out + r.err).join('\n');
      // (1) red when the command's stdout or stderr reaches a line; (2) prints the codes and the forms
      //     found.
      expect({
        codes: all.map((r) => r.code),
        leaked: forms.filter((f) => text.includes(f)),
      }).toEqual({
        codes: [1, 1, 0, 0],
        leaked: [],
      });
    });
  },
);

describe.runIf(POSIX)(
  'callback K2b — realm db check counts the callback keys',
  { timeout: 120_000 },
  () => {
    /** db check's text lines, and its JSON facts. */
    const dbCheck = (b: ReturnType<typeof bench>, env: Readonly<Record<string, string>> = {}) => {
      const text = b.run(['db', 'check'], env);
      const json = b.run(['db', 'check', '--json'], env);
      const facts = (JSON.parse(json.out) as { facts: Record<string, unknown> }).facts;
      const ls = text.out.trimEnd().split('\n');
      return {
        code: text.code,
        jsonCode: json.code,
        last: ls.slice(-2),
        keyLines: ls.filter((l) => l.startsWith('Callback keys')).length,
        err: text.err + json.err,
        keys: facts['callback_keys'] ?? 'absent',
        other: facts['callback_keys_other_master'] ?? 'absent',
      };
    };

    it('no keys: no line, and the JSON says 0', async () => {
      const b = bench();
      (await openRealmHome({ home: b.realm })).close();
      // (1) red when a line is printed for 0 keys, or 0 is left out of the JSON; (2) prints both.
      expect({
        none: dbCheck(b),
        withMaster: dbCheck(b, { REALM_ENCRYPTION_KEY: MASTER_A }),
      }).toEqual({
        none: {
          code: 0,
          jsonCode: 0,
          last: [expect.any(String), RULE],
          keyLines: 0,
          err: '',
          keys: 0,
          other: 'absent',
        },
        withMaster: {
          code: 0,
          jsonCode: 0,
          last: [expect.any(String), RULE],
          keyLines: 0,
          err: '',
          keys: 0,
          other: 0,
        },
      });
    });

    it('every stored slot counts; all under the shell’s master (B3a), some under another (B3b), the line last before the rule', async () => {
      const b = bench();
      await b.seed(MASTER_A, [[W, 'one.example:443']], true);
      await b.seed(MASTER_A, [[W, 'two.example:443']]);
      const allA = dbCheck(b, { REALM_ENCRYPTION_KEY: MASTER_A });
      await b.seed(MASTER_B, [[W, 'three.example:443']]);
      const underA = dbCheck(b, { REALM_ENCRYPTION_KEY: MASTER_A });
      const underB = dbCheck(b, { REALM_ENCRYPTION_KEY: MASTER_B });
      // (1) red when a rotated pair counts once, a column other than the recorded fingerprint is
      //     compared, or the line sits elsewhere; (2) prints each answer.
      expect({ allA, underA, underB }).toEqual({
        allA: {
          code: 0,
          jsonCode: 0,
          last: [
            "Callback keys: 3 stored, all recorded as sealed under this shell's master key.",
            RULE,
          ],
          keyLines: 1,
          err: '',
          keys: 3,
          other: 0,
        },
        underA: {
          code: 0,
          jsonCode: 0,
          last: [
            "Callback keys: 4 stored, 1 sealed under another master key than this shell's.",
            RULE,
          ],
          keyLines: 1,
          err: '',
          keys: 4,
          other: 1,
        },
        underB: {
          code: 0,
          jsonCode: 0,
          last: [
            "Callback keys: 4 stored, 3 sealed under another master key than this shell's.",
            RULE,
          ],
          keyLines: 1,
          err: '',
          keys: 4,
          other: 3,
        },
      });
    });

    it('no master key in the shell, or a setting that gives none: B3c, exit 0, no master key error', async () => {
      const b = bench();
      await b.seed(MASTER_A, [[W, H]]);
      const c3 = (n: number) => [
        `Callback keys: ${n} stored; this shell has no usable master key, so none were compared.`,
        RULE,
      ];
      const expected = {
        code: 0,
        jsonCode: 0,
        last: c3(1),
        keyLines: 1,
        err: '',
        keys: 1,
        other: 'absent',
      };
      // (1) red when a broken setting fails the check or prints its error, or a comparison is made with
      //     no key; (2) prints each answer.
      expect({
        none: dbCheck(b),
        malformed: dbCheck(b, { REALM_ENCRYPTION_KEY: 'nothex' }),
        relative: dbCheck(b, { REALM_ENCRYPTION_KEY_FILE: 'master.key' }),
      }).toEqual({ none: expected, malformed: expected, relative: expected });
    });

    it('the command source: run once per check, B3a or B3b; a failing command prints B3c and exits 0', async () => {
      const b = bench();
      await b.seed(MASTER_A, [[W, H]]);
      await b.seed(MASTER_B, [[W, 'other.example:443']]);
      const before = b.runs();
      const text = b.run(['db', 'check'], b.printing(MASTER_A));
      const oneRun = b.runs() - before;
      const failing = b.run(['db', 'check'], {
        REALM_ENCRYPTION_KEY_COMMAND: b.script('fail', 'exit 6'),
      });
      const tail = (r: Run) => r.out.trimEnd().split('\n').slice(-2);
      // (1) red when db check fails on a broken setting, or runs the command more than once; (2) prints
      //     each answer and the count.
      expect({
        text: { code: text.code, last: tail(text), err: text.err },
        oneRun,
        failing: { code: failing.code, last: tail(failing), err: failing.err },
      }).toEqual({
        text: {
          code: 0,
          last: [
            "Callback keys: 2 stored, 1 sealed under another master key than this shell's.",
            RULE,
          ],
          err: '',
        },
        oneRun: 1,
        failing: {
          code: 0,
          last: [
            'Callback keys: 2 stored; this shell has no usable master key, so none were compared.',
            RULE,
          ],
          err: '',
        },
      });
    });

    it('a store at schema version 2: exit 1, older_version, no count fact (unchanged)', async () => {
      const b = bench();
      await b.seed(MASTER_A, [[W, H]]);
      const migrated = b.run(['db', 'migrate', '--to', '2']);
      const json = b.run(['db', 'check', '--json'], { REALM_ENCRYPTION_KEY: MASTER_A });
      const report = JSON.parse(json.out) as {
        facts: Record<string, unknown>;
        findings: { code: string }[];
      };
      // (1) red when the count is taken outside the data pass (a version-2 file has no callback_keys);
      //     (2) prints the codes, the findings and the facts' names.
      expect({
        migrated: migrated.code,
        code: json.code,
        findings: report.findings.map((f) => f.code),
        counted: ['callback_keys', 'callback_keys_other_master'].filter((k) => k in report.facts),
      }).toEqual({ migrated: 0, code: 1, findings: ['older_version'], counted: [] });
    });
  },
);
