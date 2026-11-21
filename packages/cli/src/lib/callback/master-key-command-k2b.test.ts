// master-key-command-k2b.test.ts — callback K2b (R1.3; the owner's yes eaa442b9): the master key's
// command source, `REALM_ENCRYPTION_KEY_COMMAND`, through `resolveMasterKey`, on real scripts in a
// scratch folder; its splitter; and the words a command source that gave no key is told. Every cell
// that starts a real script is skipped on win32 (the scripts are POSIX shell; the command source on
// Windows is not examined), and its describe carries a time budget.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
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
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMAND_TIMEOUT_SECONDS, splitKeyCommand } from './master-key-command.js';
import { MASTER_KEY_FILE, MASTER_KEY_INVALID_REASONS, resolveMasterKey } from './master-key.js';
import { commandSourceWords } from './master-key-words.js';

const POSIX = process.platform !== 'win32';
const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const C = 'c3'.repeat(32);
/** `printf <hex> | xxd -r -p | sha256sum | cut -c1-8`, run for each key. */
const FP_A = '52fe6094';
const FP_B = 'f14dfc87';
const FP_C = '4b80290f';
const TOKEN = 'FAKE-TOKEN-0001';

/** A path as one word of a command value (a scratch folder's path may hold a space). */
const q = (path: string): string => `"${path}"`;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch home, and `script(name, body)` writing a shell script beside it: its path as a command
 *  value's first word (quoted). */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'realm-k2b-cmd-'));
  dirs.push(root);
  const home = join(root, '.realm');
  mkdirSync(home);
  const script = (name: string, body: string, mode = 0o755): string => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, mode);
    return q(path);
  };
  return { root, home, script };
}

type Resolution = ReturnType<typeof resolveMasterKey>;
/** The result as a log would print it, the key's bytes shown as hex when present. */
const shown = (r: Resolution) =>
  r.state === 'found' ? { ...r, key: Buffer.from(r.key).toString('hex') } : r;
/** The command source alone, in a scratch home that has no file. */
const viaCommand = (value: string, home: string, extra: Record<string, string> = {}, ms?: number) =>
  resolveMasterKey({
    env: { PATH: process.env['PATH'] ?? '', REALM_ENCRYPTION_KEY_COMMAND: value, ...extra },
    homeDir: home,
    ...(ms === undefined ? {} : { commandTimeoutMs: ms }),
  });

describe('callback K2b — the command line is split into words, never given to a shell', () => {
  it('spaces, tabs, CR and LF separate; a double quote keeps a run together; no escapes', () => {
    // (1) red when a quote is kept in a word, a single quote groups, CR or LF is part of a word, an
    //     empty quoted word is dropped, or an unclosed quote is accepted; (2) prints every split.
    expect({
      security: splitKeyCommand('security find-generic-password -s realm -w'),
      op: splitKeyCommand('op read "op://My Vault/realm key"'),
      padded: splitKeyCommand('  cmd \t a  '),
      lineEnd: splitKeyCommand('cmd a\r\n'),
      emptyArg: splitKeyCommand('cmd ""'),
      emptyProgram: splitKeyCommand('""'),
      inside: splitKeyCommand('a"b c"d e'),
      single: splitKeyCommand("cmd 'a b'"),
      backslash: splitKeyCommand('cmd a\\ b'),
      unclosed: splitKeyCommand('cmd "a b'),
    }).toEqual({
      security: ['security', 'find-generic-password', '-s', 'realm', '-w'],
      op: ['op', 'read', 'op://My Vault/realm key'],
      padded: ['cmd', 'a'],
      lineEnd: ['cmd', 'a'],
      emptyArg: ['cmd', ''],
      emptyProgram: [''],
      inside: ['ab cd', 'e'],
      single: ['cmd', "'a", "b'"],
      backslash: ['cmd', 'a\\', 'b'],
      unclosed: undefined,
    });
  });
});

describe('callback K2b — the words a command source that gave no key is told', () => {
  it('one reason per closed word; the limit is the one constant; the reasons are one list', () => {
    const words = (reason: (typeof MASTER_KEY_INVALID_REASONS)[number], extra = {}) =>
      commandSourceWords({ state: 'invalid', source: 'command', reason, ...extra });
    // (1) red when the limit is written twice and drifts, a reason gets another's tail, or a reason is
    //     added or dropped from the list; (2) prints every reason and tail.
    expect({
      limit: COMMAND_TIMEOUT_SECONDS,
      reasons: MASTER_KEY_INVALID_REASONS,
      timeout: words('command_timeout'),
      status: words('command_failed', { status: 3 }),
      signal: words('command_failed', { signal: 'SIGKILL' }),
      notStarted: words('command_not_started', { code: 'ENOENT' }),
      noCode: words('command_not_started'),
      quote: words('command_unclosed_quote'),
      noProgram: words('command_no_program'),
      empty: words('empty'),
      malformed: words('malformed'),
    }).toEqual({
      limit: 30,
      reasons: [
        'malformed',
        'empty',
        'unreadable_file',
        'command_no_program',
        'command_unclosed_quote',
        'command_timeout',
        'command_not_started',
        'command_failed',
      ],
      timeout: {
        reason: 'its command took longer than 30 seconds',
        tail: 'Run the command by hand to see why.',
      },
      status: {
        reason: 'its command exited with status 3',
        tail: 'Run the command by hand to see why.',
      },
      signal: {
        reason: 'its command was ended by SIGKILL',
        tail: 'Run the command by hand to see why.',
      },
      notStarted: {
        reason: 'its command could not be started (ENOENT)',
        tail: 'Run the command by hand to see why.',
      },
      noCode: {
        reason: 'its command could not be started (unknown error)',
        tail: 'Run the command by hand to see why.',
      },
      quote: {
        reason: 'its value has an unclosed quote',
        tail: 'Check the value of REALM_ENCRYPTION_KEY_COMMAND.',
      },
      noProgram: {
        reason: 'its value names no program',
        tail: 'Check the value of REALM_ENCRYPTION_KEY_COMMAND.',
      },
      empty: {
        reason: 'its output is empty',
        tail: 'The command must print the master key, 64 hexadecimal characters, and nothing else.',
      },
      malformed: {
        reason: 'its output is not 64 hexadecimal characters',
        tail: 'The command must print the master key, 64 hexadecimal characters, and nothing else.',
      },
    });
  });
});

describe.runIf(POSIX)('callback K2b — the command source’s outcomes', { timeout: 60_000 }, () => {
  it('a key printed and exit 0 is found; CRLF too; 63 characters, nothing, or 10 KB is not', () => {
    const { home, script } = scratch();
    const r = {
      lf: shown(viaCommand(script('lf', `printf '%s\\n' ${A}`), home)),
      crlf: shown(viaCommand(script('crlf', `printf '%s\\r\\n' ${A}`), home)),
      short: viaCommand(script('short', `printf '%s\\n' ${A.slice(1)}`), home),
      nothing: viaCommand(script('nothing', 'exit 0'), home),
      big: viaCommand(script('big', `yes ${A} | head -c 10240`), home),
    };
    // (1) red when the output's key is not the key, the fingerprint is another's, a CRLF is refused,
    //     a short or empty output is taken, or output past 4096 bytes is cut and read; (2) prints each.
    expect(r).toEqual({
      lf: { state: 'found', source: 'command', fp: FP_A, key: A },
      crlf: { state: 'found', source: 'command', fp: FP_A, key: A },
      short: { state: 'invalid', source: 'command', reason: 'malformed' },
      nothing: { state: 'invalid', source: 'command', reason: 'empty' },
      big: { state: 'invalid', source: 'command', reason: 'malformed' },
    });
    // (1) red when any of the 10 KB reaches a field; (2) prints the fields.
    expect(JSON.stringify(r.big).includes(A.slice(0, 16))).toBe(false);
  });

  it('a failed command is invalid, even one that printed the right key; a signal, a missing or a non-executable program', () => {
    const { root, home, script } = scratch();
    const r = {
      exit3: viaCommand(script('exit3', 'exit 3'), home),
      keyThenExit1: viaCommand(script('key1', `printf '%s\\n' ${A}\nexit 1`), home),
      killed: viaCommand(script('killed', 'kill -9 $$'), home),
      missing: viaCommand(q(join(root, 'no-such-program')), home),
      notExecutable: viaCommand(script('plain', `printf '%s\\n' ${A}`, 0o644), home),
      noProgram: viaCommand('"" a b', home),
      unclosed: viaCommand(`${script('x', 'exit 0')} "a`, home),
    };
    // (1) red when a result is accepted on exit 1 (stdout read on a failure), a signal is reported as
    //     a status, or a spawn error is another reason; (2) prints each result.
    expect(r).toEqual({
      exit3: { state: 'invalid', source: 'command', reason: 'command_failed', status: 3 },
      keyThenExit1: { state: 'invalid', source: 'command', reason: 'command_failed', status: 1 },
      killed: { state: 'invalid', source: 'command', reason: 'command_failed', signal: 'SIGKILL' },
      missing: {
        state: 'invalid',
        source: 'command',
        reason: 'command_not_started',
        code: 'ENOENT',
      },
      notExecutable: {
        state: 'invalid',
        source: 'command',
        reason: 'command_not_started',
        code: 'EACCES',
      },
      noProgram: { state: 'invalid', source: 'command', reason: 'command_no_program' },
      unclosed: { state: 'invalid', source: 'command', reason: 'command_unclosed_quote' },
    });
  });

  it('a command past the limit is a timeout: one that sleeps, one that ignores the polite stop, one that leaves a process holding its output', () => {
    const { home, script } = scratch();
    const timed = (path: string, ms: number) => {
      const start = process.hrtime.bigint();
      const result = viaCommand(path, home, {}, ms);
      return { result, ms: Number((process.hrtime.bigint() - start) / 1_000_000n) };
    };
    const sleeps = timed(script('sleeps', 'exec sleep 30'), 500);
    const trapped = timed(
      script(
        'trapped',
        "trap '' TERM\nfor i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do sleep 1; done",
      ),
      500,
    );
    const holder = timed(script('holder', `sleep 5 &\nprintf '%s\\n' ${A}\nexit 0`), 1500);
    const timeout = { state: 'invalid', source: 'command', reason: 'command_timeout' };
    // (1) red when `killSignal` is left at its default (the trapping script runs on and returns status
    //     0 with ETIMEDOUT), or ETIMEDOUT with status 0 is taken as success (the holder printed the
    //     key); (2) prints each result and how long it took.
    expect({
      sleeps: sleeps.result,
      trapped: trapped.result,
      holder: holder.result,
      fast: [sleeps.ms, trapped.ms, holder.ms].every((ms) => ms < 10_000),
    }).toEqual({ sleeps: timeout, trapped: timeout, holder: timeout, fast: true });
  });

  it('a value the call itself refuses never throws: a token in a missing program’s words, and a NUL byte', () => {
    const { home } = scratch();
    const withToken = viaCommand(`/nonexistent/op read x --token ${TOKEN}`, home);
    let nul: Resolution | string;
    try {
      nul = viaCommand('printf\u0000x', home);
    } catch (err) {
      nul = `threw: ${err instanceof Error ? err.message : String(err)}`;
    }
    // (1) red when the error's fields (its path, its arguments) are kept, or a NUL byte throws;
    //     (2) prints both results.
    expect({
      withToken,
      tokenShown: JSON.stringify(withToken).includes(TOKEN),
      nul,
    }).toEqual({
      withToken: {
        state: 'invalid',
        source: 'command',
        reason: 'command_not_started',
        code: 'ENOENT',
      },
      tokenShown: false,
      nul: {
        state: 'invalid',
        source: 'command',
        reason: 'command_not_started',
        code: 'ERR_INVALID_ARG_VALUE',
      },
    });
  });

  it('a command’s output and error text are never kept: the key on stderr, or on stdout with exit 2', () => {
    const { home, script } = scratch();
    const forms = [A, Buffer.from(A, 'utf8').toString('base64')];
    const results = [
      viaCommand(script('stderr', `printf '%s\\n' ${A} >&2\nexit 2`), home),
      viaCommand(script('stdout', `printf '%s\\n' ${A}\nexit 2`), home),
    ];
    // Every own property, an unenumerable one included.
    const text = results
      .map((r) => Reflect.ownKeys(r).map((k) => String((r as Record<PropertyKey, unknown>)[k])))
      .join(' ');
    // (1) red when a result carries the output (stdout or stderr); (2) prints the results.
    expect({
      results,
      leaked: forms.filter((f) => text.includes(f)),
    }).toEqual({
      results: [0, 1].map(() => ({
        state: 'invalid',
        source: 'command',
        reason: 'command_failed',
        status: 2,
      })),
      leaked: [],
    });
  });
});

describe.runIf(POSIX)('callback K2b — the order, and no fall-through', { timeout: 60_000 }, () => {
  it('each adjacent pair: the setting over the file, the file over the command, the command over the home file', () => {
    const { root, home, script } = scratch();
    const named = join(root, 'named.key');
    writeFileSync(named, `${B}\n`, { mode: 0o600 });
    writeFileSync(join(home, MASTER_KEY_FILE), `${C}\n`, { mode: 0o600 });
    const command = script('a', `printf '%s\\n' ${A}`);
    const at = (env: Record<string, string>) => resolveMasterKey({ env, homeDir: home });
    const of = (r: Resolution) => (r.state === 'found' ? `${r.source} ${r.fp}` : r.state);
    // (1) red when a later source wins over an earlier one, or a blank command value is run;
    //     (2) prints each winner.
    expect({
      envOverFile: of(at({ REALM_ENCRYPTION_KEY: B, REALM_ENCRYPTION_KEY_FILE: named })),
      fileOverCommand: of(
        at({ REALM_ENCRYPTION_KEY_FILE: named, REALM_ENCRYPTION_KEY_COMMAND: command }),
      ),
      commandOverHome: of(at({ REALM_ENCRYPTION_KEY_COMMAND: command })),
      blankCommand: of(at({ REALM_ENCRYPTION_KEY_COMMAND: ' \t\r\n' })),
    }).toEqual({
      envOverFile: `env ${FP_B}`,
      fileOverCommand: `env_file ${FP_B}`,
      commandOverHome: `command ${FP_A}`,
      blankCommand: `home_file ${FP_C}`,
    });
  });

  it('a failing command with a valid home file is invalid, never found; a command key and another home file differ', () => {
    const { home, script } = scratch();
    writeFileSync(join(home, MASTER_KEY_FILE), `${C}\n`, { mode: 0o644 });
    const failing = resolveMasterKey({
      env: { REALM_ENCRYPTION_KEY_COMMAND: script('fail', 'exit 4') },
      homeDir: home,
    });
    const differs = shown(
      resolveMasterKey({
        env: { REALM_ENCRYPTION_KEY_COMMAND: script('a', `printf '%s\\n' ${A}`) },
        homeDir: home,
      }),
    );
    // (1) red when an invalid command falls through to the home file, the differing home file is not
    //     said, or a command source carries `mode_wider_than_owner` (the home file is 0644);
    //     (2) prints both results.
    expect({ failing, differs }).toEqual({
      failing: { state: 'invalid', source: 'command', reason: 'command_failed', status: 4 },
      differs: {
        state: 'found',
        source: 'command',
        fp: FP_A,
        differs_from_home_file: true,
        key: A,
      },
    });
  });
});

describe.runIf(POSIX)(
  'callback K2b — the environment and the words the command gets',
  { timeout: 60_000 },
  () => {
    it('the command sees the environment handed to the resolver; a quoted word with a space is one argument', () => {
      const { root, home, script } = scratch();
      const marked = script('marked', `[ "$K2B_MARK" = yes ] && printf '%s\\n' ${A}\nexit 0`);
      const argv = join(root, 'argv.txt');
      const args = script('args', `printf '%s\\n' "$#" "$@" > '${argv}'\nprintf '%s\\n' ${A}`);
      const withMark = viaCommand(marked, home, { K2B_MARK: 'yes' });
      const withoutMark = viaCommand(marked, home);
      const quoted = viaCommand(`${args} "a b" c`, home);
      // (1) red when the child gets another environment than the one handed in, or a quoted word is
      //     split; (2) prints each result and the arguments the script saw.
      expect({
        withMark: withMark.state,
        withoutMark,
        quoted: quoted.state,
        argv: readFileSync(argv, 'utf8'),
      }).toEqual({
        withMark: 'found',
        withoutMark: { state: 'invalid', source: 'command', reason: 'empty' },
        quoted: 'found',
        argv: '2\na b\nc\n',
      });
    });

    it('no shell: a ; and a $HOME are words the program gets, never a second command or an expansion', () => {
      const { root, home, script } = scratch();
      const argv = join(root, 'argv.txt');
      const touched = join(root, 'X');
      const args = script('args', `printf '%s\\n' "$#" "$@" > '${argv}'\nprintf '%s\\n' ${A}`);
      const semicolon = viaCommand(`${args} ; touch ${q(touched)}`, home);
      const semicolonArgv = readFileSync(argv, 'utf8');
      const dollar = viaCommand(`${args} $HOME`, home, { HOME: root });
      // (1) red when the value goes through a shell (`shell: true`): X is made, or $HOME expands;
      //     (2) prints what the script saw.
      expect({
        semicolon: semicolon.state,
        semicolonArgv,
        touched: existsSync(touched),
        dollar: dollar.state,
        dollarArgv: readFileSync(argv, 'utf8'),
      }).toEqual({
        semicolon: 'found',
        semicolonArgv: `3\n;\ntouch\n${touched}\n`,
        touched: false,
        dollar: 'found',
        dollarArgv: '1\n$HOME\n',
      });
    });
  },
);
