// child-output.ts — test support: every program a test starts says what it printed when that
// test fails (issue #625 PR-2a, fold round 18).
//
// TWO COPIES, one per package that needs it (no test imports across packages, as `declared.ts`):
// this one and `packages/cli/src/test-support/child-output.ts`. They are identical apart
// from this header; a change to one is made to both.
//
// `printChildrenWhenATestFails()`, called once at a test file's top level, registers a
// `beforeEach` that clears the file's list of programs and, through the test context's
// `onTestFailed`, writes to stderr every program that test started, in order: the arguments it was
// started with, its exit code or signal, its stdout and its stderr, each under a plain heading. It
// prints the programs' own output only, never their environment. It returns the recorder the
// file's spawn helpers report to:
// - `record({ args, status, signal, stdout, stderr })` for a finished program (a `spawnSync` or
//   `execFile` result, or the streams an async `spawn` collected by its `close`);
// - `watch(label, transport)` for an MCP `StdioClientTransport` created with `stderr: 'pipe'`:
//   its stderr is read from the moment it is watched, whether or not the test fails (a pipe
//   nobody reads fills and then stalls the server). Watch it before `connect()`: SDK 1.31.0
//   creates the stream in the transport's constructor (`client/stdio.js:53-55`), hands it out
//   before `start()` (`:108-120`), and `start()` pipes the child's stderr into it (`:103-105`).
//
// One program's text is `describeChild`: the layout `describeSpawn` prints (`exit N`,
// `--- stdout ---`, `--- stderr ---`; `packages/cli/src/multi-copy/layout.ts`), with the
// arguments, a signal, a start error and the cap added. With no arguments, no signal, no error and
// streams under the cap the two texts are equal, so `describeSpawn` can become `describeChild`
// (and `runNode` a `record` call) with no cell changing.
//
// The list is the file's and is cleared before each test, so a file's tests must run one at a
// time (vitest's default within a file); a `describe.concurrent` file would mix their programs.
import { StringDecoder } from 'node:string_decoder';
import { beforeEach } from 'vitest';
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Each stream is cut to this many characters: the first half and the last half are kept. */
export const STREAM_CAP = 20_000;

/** What a finished program left: a `spawnSync` result, an `execFile` error, collected streams. */
export interface ProgramResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string | Buffer;
  stderr: string | Buffer;
  /** Set when the program could not start, or a timeout killed it (`spawnSync`'s `error`). */
  error?: Error;
}

/** A finished program and the arguments it was started with (after the executable). */
export interface FinishedProgram extends ProgramResult {
  args: readonly string[];
}

export interface ChildRecorder {
  /** A program that has finished. */
  record(program: FinishedProgram): void;
  /** An MCP server's stdio transport, created with `stderr: 'pipe'`; returns the transport. */
  watch<T extends StdioClientTransport>(label: string, transport: T): T;
}

interface Watched {
  label: string;
  args: string;
  stderr: () => string;
}

type Entry = { kind: 'finished'; program: FinishedProgram } | { kind: 'watched'; watched: Watched };

/** A stream's text, cut to `STREAM_CAP` characters: its head, how much was cut, its tail. */
export function capStream(text: string): string {
  if (text.length <= STREAM_CAP) return text;
  const half = STREAM_CAP / 2;
  const cut = `[… ${text.length - STREAM_CAP} characters cut …]`;
  return `${text.slice(0, half)}\n${cut}\n${text.slice(-half)}`;
}

/** The arguments as one line a reader can copy: a word with a space or a quote is quoted. */
export function formatArgs(args: readonly string[]): string {
  return args
    .map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : JSON.stringify(word)))
    .join(' ');
}

function streamText(stream: string | Buffer): string {
  return typeof stream === 'string' ? stream : stream.toString('utf8');
}

/**
 * One finished program's whole story: `--- args ---` (when given), `exit N` (with its signal, and
 * the error that kept it from starting or ended it), `--- stdout ---`, `--- stderr ---`.
 */
export function describeChild(program: ProgramResult & { args?: readonly string[] }): string {
  const args = program.args === undefined ? '' : `--- args ---\n${formatArgs(program.args)}\n`;
  const signal =
    program.signal === undefined || program.signal === null ? '' : ` (signal ${program.signal})`;
  const error = program.error === undefined ? '' : `\nerror: ${program.error.message}`;
  return (
    `${args}exit ${String(program.status)}${signal}${error}\n` +
    `--- stdout ---\n${capStream(streamText(program.stdout))}\n` +
    `--- stderr ---\n${capStream(streamText(program.stderr))}`
  );
}

function describeWatched(watched: Watched): string {
  return (
    `--- args ---\n${watched.args}\n` +
    `exit: not reported (the SDK's stdio transport does not expose its server's exit code)\n` +
    `--- stdout ---\n(the MCP protocol channel: the client read it)\n` +
    `--- stderr ---\n${capStream(watched.stderr())}`
  );
}

/**
 * The command line a transport was created with. The SDK keeps its parameters in `_serverParams`
 * (1.31.0 `client/stdio.js:51`) and has no public reader; only `command` and `args` are read,
 * never `env`. An SDK that moves them prints that the arguments are not known.
 */
function transportArgs(transport: StdioClientTransport): string {
  const held = transport as unknown as { _serverParams?: { command?: unknown; args?: unknown } };
  const command = held._serverParams?.command;
  const args = held._serverParams?.args ?? [];
  if (typeof command !== 'string' || !Array.isArray(args)) {
    return '(not known: this SDK does not keep them where 1.31.0 did)';
  }
  return formatArgs([command, ...args.map(String)]);
}

/** Registers the per-test print; returns the recorder the file's spawn helpers report to. */
export function printChildrenWhenATestFails(): ChildRecorder {
  const entries: Entry[] = [];
  beforeEach(({ task, onTestFailed }) => {
    entries.length = 0;
    onTestFailed(() => {
      if (entries.length === 0) return;
      const total = entries.length;
      const parts = entries.map((entry, i) => {
        const heading = `=== program ${i + 1} of ${total}`;
        return entry.kind === 'finished'
          ? `${heading} ===\n${describeChild(entry.program)}`
          : `${heading}: ${entry.watched.label} ===\n${describeWatched(entry.watched)}`;
      });
      process.stderr.write(
        `\n[child-output] test "${task.name}" failed; the ${total} program(s) it started:\n` +
          `${parts.join('\n')}\n` +
          `=== end of the programs test "${task.name}" started ===\n`,
      );
    });
  });
  return {
    record(program) {
      entries.push({ kind: 'finished', program });
    },
    watch(label, transport) {
      const stream = transport.stderr;
      if (stream === null) {
        throw new Error(`child-output: watch('${label}') needs a transport with stderr: 'pipe'`);
      }
      const decoder = new StringDecoder('utf8');
      let text = '';
      stream.on('data', (chunk: Buffer | string) => {
        text += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      });
      entries.push({
        kind: 'watched',
        watched: { label, args: transportArgs(transport), stderr: () => text },
      });
      return transport;
    },
  };
}
