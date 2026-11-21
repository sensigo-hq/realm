// master-key-command.ts — callback K2b (R1.3; the owner's yes eaa442b9): the master key's third
// source, `REALM_ENCRYPTION_KEY_COMMAND`, run. Its own file, so the resolver's file never starts a
// process itself.
//
// The value is split into words, never given to a shell: words are separated by spaces, tabs, CR and
// LF; a double quote starts and ends a run in which those are kept; quotes may sit inside a word; `""`
// alone is an empty word; there are no escapes, and a single quote is an ordinary character. The first
// word is the program, looked up on the PATH of the environment handed in; the rest are its arguments.
//
// The program runs with no stdin, its stderr discarded, at most 4096 bytes of stdout, and is killed
// at the limit. Nothing it printed leaves this file except the text of a run that exited 0; a failure
// carries only closed words, the exit status, the signal's name or the error's code, never the error
// itself (it holds every argument, a token included).
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import type { MasterKeyInvalidReason } from './master-key.js';

/** How long the command may run. One constant: the option and the words that state it read it. */
export const COMMAND_TIMEOUT_SECONDS = 30;
const MAX_OUTPUT_BYTES = 4096;

/** Why the command gave no key text; nothing else from the run is kept. */
export interface KeyCommandFailure {
  readonly reason: MasterKeyInvalidReason;
  readonly status?: number;
  readonly signal?: string;
  readonly code?: string;
}

/** The value's words (see the module comment), or `undefined` when a quote is not closed. */
export function splitKeyCommand(value: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quoted = false;
  for (const ch of value) {
    if (ch === '"') {
      quoted = !quoted;
      inWord = true;
    } else if (!quoted && (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n')) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (quoted) return undefined;
  if (inWord) words.push(word);
  return words;
}

/**
 * Runs the command a value names: the text it printed when it exited 0, or why there is none. Never
 * throws for a bad value; `timeoutMs` is the limit (a test may shorten it).
 */
export function runKeyCommand(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): { readonly text: string } | KeyCommandFailure {
  const words = splitKeyCommand(value);
  if (words === undefined) return { reason: 'command_unclosed_quote' };
  const [program, ...args] = words;
  // An empty program name makes the call itself throw: refused before it.
  if (program === undefined || program === '') return { reason: 'command_no_program' };
  const childEnv: Record<string, string> = {};
  for (const [name, v] of Object.entries(env)) if (typeof v === 'string') childEnv[name] = v;
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(program, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: false,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (err) {
    // A NUL byte in a word, for one: the error's message quotes the text, so only its code is kept.
    return notStarted((err as NodeJS.ErrnoException | undefined)?.code);
  }
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  // A command that leaves a process holding its output ends with ETIMEDOUT and status 0: a timeout.
  if (code === 'ETIMEDOUT') return { reason: 'command_timeout' };
  if (code === 'ENOBUFS') return { reason: 'malformed' };
  if (result.error !== undefined) return notStarted(code);
  if (result.signal !== null) return { reason: 'command_failed', signal: result.signal };
  // A status with no signal and no error is Node's contract; without one, the run is not known to
  // have happened.
  if (result.status === null) return notStarted(undefined);
  if (result.status !== 0) return { reason: 'command_failed', status: result.status };
  return { text: result.stdout ?? '' };
}

function notStarted(code: unknown): KeyCommandFailure {
  return typeof code === 'string'
    ? { reason: 'command_not_started', code }
    : { reason: 'command_not_started' };
}
