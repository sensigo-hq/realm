// runner.ts — #790 (D1, rail 1): the one place in the separation check that starts a process. It
// runs only the read-only calls rail 1 names — sudo's version and listing modes, doas's config-check
// mode, polkit's check mode with no interaction, and the user and group lookups (#819 Unit A: with
// `id -G`, a user's groups as sudo reads them) — and refuses every other argv, which it never starts. A call runs with no stdin, a fixed PATH and no other variable
// of the caller's, so no tool can prompt, and none reads the agent's environment.
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute } from 'node:path';
import { RAIL_NAME as NAME, SYSTEM_DIRS } from './lookup.js';

/** What one call gave: its exit status and output; a refusal (not one of rail 1's argv); or why it
 *  could not run. */
export type RunResult =
  { exit: number; stdout: string; stderr: string } | { refused: string } | { error: string };

/** Runs one argv. `LC_ALL=C` as the first element sets that variable for the call (rail 1's
 *  `LC_ALL=C <sudo> -n -l`); the next element is the tool's absolute path. */
export type Runner = (argv: readonly string[]) => Promise<RunResult>;

const SUDO_NAMES = new Set(['sudo', 'sudo.ws', 'sudo-rs']);
const ACTION = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The tool at `path`, when it is a program named one of `names` in one of D2's folders (A §F13). */
const tool = (path: string | undefined, names: ReadonlySet<string>): boolean =>
  path !== undefined &&
  isAbsolute(path) &&
  (SYSTEM_DIRS as readonly string[]).includes(dirname(path)) &&
  names.has(basename(path));

/**
 * Whether `argv` is one of rail 1's calls, element by element:
 * `<sudo> -V` · `LC_ALL=C <sudo> -n -l` · `LC_ALL=C <sudo> -n -ll` ·
 * `<doas> -C <file> -u <target> <cmd> [args…]` · `<pkcheck> --action-id <A> --process <pid>` ·
 * `<getent> passwd|group|netgroup <name>` · `<id> -G <name>` (#819 Unit A, A3: the user's gids,
 * primary first, as `getgrouplist` gives them — what sudo compares a run-as group with) ·
 * `<dscl> . -read /Users/<name> UserShell`.
 */
export function railOne(argv: readonly string[]): boolean {
  const [a, b, c, d, e, f] = argv;
  if (a === 'LC_ALL=C') {
    return argv.length === 4 && tool(b, SUDO_NAMES) && c === '-n' && (d === '-l' || d === '-ll');
  }
  if (tool(a, SUDO_NAMES)) return argv.length === 2 && b === '-V';
  if (tool(a, new Set(['doas']))) {
    return (
      argv.length >= 6 &&
      b === '-C' &&
      c !== undefined &&
      isAbsolute(c) &&
      d === '-u' &&
      e !== undefined &&
      NAME.test(e) &&
      f !== undefined &&
      f !== '' &&
      !f.startsWith('-')
    );
  }
  if (tool(a, new Set(['pkcheck']))) {
    return (
      argv.length === 5 &&
      b === '--action-id' &&
      c !== undefined &&
      ACTION.test(c) &&
      d === '--process' &&
      e !== undefined &&
      /^\d+$/.test(e)
    );
  }
  if (tool(a, new Set(['getent']))) {
    return (
      argv.length === 3 &&
      (b === 'passwd' || b === 'group' || b === 'netgroup') &&
      c !== undefined &&
      NAME.test(c)
    );
  }
  if (tool(a, new Set(['id']))) {
    return argv.length === 3 && b === '-G' && c !== undefined && NAME.test(c);
  }
  if (tool(a, new Set(['dscl']))) {
    return (
      argv.length === 5 &&
      b === '.' &&
      c === '-read' &&
      d !== undefined &&
      d.startsWith('/Users/') &&
      NAME.test(d.slice('/Users/'.length)) &&
      e === 'UserShell'
    );
  }
  return false;
}

/** A call's time limit, and the most output it may give. */
const TIME_LIMIT_MS = 5000;
const OUTPUT_LIMIT = 1 << 20;
/** The only variable a call gets besides `LC_ALL=C`: the system folders. */
const SAFE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** The real runner: refuses any argv that is not one of rail 1's, never starting it. */
export const systemRunner: Runner = (argv) => {
  if (!railOne(argv)) return Promise.resolve({ refused: argv.join(' ') });
  const lcAllC = argv[0] === 'LC_ALL=C';
  const [file, ...args] = lcAllC ? argv.slice(1) : argv;
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const child = spawn(file!, args, {
      env: { PATH: SAFE_PATH, ...(lcAllC ? { LC_ALL: 'C' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ error: `${basename(file!)} gave no answer within ${TIME_LIMIT_MS / 1000} s` });
    }, TIME_LIMIT_MS);
    const take = (into: 'out' | 'err') => (chunk: Buffer) => {
      if (into === 'out') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
      if (stdout.length + stderr.length > OUTPUT_LIMIT) {
        child.kill('SIGKILL');
        finish({ error: `${basename(file!)} printed more than this check reads` });
      }
    };
    child.stdout.on('data', take('out'));
    child.stderr.on('data', take('err'));
    child.once('error', (err: NodeJS.ErrnoException) =>
      finish({ error: `${file!} could not be started (${err.code ?? 'error'})` }),
    );
    child.once('close', (code, signal) =>
      finish(
        code === null
          ? { error: `${basename(file!)} was ended by ${signal ?? 'a signal'}` }
          : { exit: code, stdout, stderr },
      ),
    );
  });
};
