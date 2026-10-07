// child-output.ts — test support: every program a test starts says what it printed when that
// test fails (issue #625 PR-2a, fold round 18).
//
// TWO COPIES, one per package that needs it (no test imports across packages, as `declared.ts`):
// this one and `packages/cli/src/test-support/child-output.ts`. They are identical apart
// from this header; a change to one is made to both.
//
// `printChildrenWhenATestFails()`, called once at a test file's top level, registers an
// `aroundEach` that gives each test its own list of programs and, through the test context's
// `onTestFailed`, writes to stderr every program on that list, in order: the arguments it was
// started with, its exit code or signal, its stdout and its stderr, each under a plain heading. It
// prints the programs' own output only, never their environment. It returns the recorder the
// file's spawn helpers report to:
// - `record({ args, status, signal, stdout, stderr })` for a finished program (a `spawnSync` or
//   `execFile` result);
// - `track(args, child)` for a program started with `spawn`: listed at once, its stdout and stderr
//   read as they arrive (always, whether or not the test fails), its exit filled in on `close`. A
//   program that has not closed when the test fails prints as still running, with its output so
//   far — the case of a cell that timed out waiting for it;
// - `watch(label, transport)` for an MCP `StdioClientTransport` created with `stderr: 'pipe'`:
//   its stderr is read from the moment it is watched, whether or not the test fails (a pipe
//   nobody reads fills and then stalls the server). Watch it before `connect()`: SDK 1.31.0
//   creates the stream in the transport's constructor (`client/stdio.js:53-55`), hands it out
//   before `start()` (`:108-120`), and `start()` pipes the child's stderr into it (`:103-105`).
//
// Which test a program belongs to: the test whose body started it, found through an
// `AsyncLocalStorage` each test runs in (set by the `aroundEach`, so it follows the body's every
// `await`). A body that outlives its test (vitest does not stop a timed-out body) keeps listing to
// that test, so a program it starts, or one still running when the next test begins, is never
// printed under another test. A call from outside a test (a `beforeAll`) is listed nowhere; its
// streams are still read.
//
// One finished program's text is `describeChild`: the layout `describeSpawn` prints (`exit N`,
// `--- stdout ---`, `--- stderr ---`; `packages/cli/src/multi-copy/layout.ts`), with the
// arguments, a signal, a start error and the cap added. With no arguments, no signal, no error and
// streams under the cap the two texts are equal, so `describeSpawn` can become `describeChild`
// (and `runNode` a `record` call) with no cell changing.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';
import type { Stream } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { aroundEach } from 'vitest';
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
  /** A program started with `spawn`, with its arguments (after the executable); returns it. */
  track<T extends ChildProcess>(args: readonly string[], child: T): T;
  /** An MCP server's stdio transport, created with `stderr: 'pipe'`; returns the transport. */
  watch<T extends StdioClientTransport>(label: string, transport: T): T;
}

interface Tracked {
  args: readonly string[];
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  closed?: { status: number | null; signal: NodeJS.Signals | null };
}

interface Watched {
  label: string;
  args: string;
  stderr: () => string;
}

type Entry =
  | { kind: 'finished'; program: FinishedProgram }
  | { kind: 'tracked'; tracked: Tracked }
  | { kind: 'watched'; watched: Watched };

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

/** Reads a stream from now on, always; returns what it has said so far. */
function collect(stream: Stream | null): () => string {
  if (stream === null) return () => '(not piped to this process)';
  const decoder = new StringDecoder('utf8');
  let text = '';
  stream.on('data', (chunk: Buffer | string) => {
    text += typeof chunk === 'string' ? chunk : decoder.write(chunk);
  });
  return () => text;
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

function describeTracked(tracked: Tracked): string {
  const { args, closed } = tracked;
  if (closed !== undefined) {
    return describeChild({ args, ...closed, stdout: tracked.stdout(), stderr: tracked.stderr() });
  }
  const state =
    tracked.child.pid === undefined
      ? 'exit: the program did not start (no process id)'
      : 'exit: still running when the test failed';
  return (
    `--- args ---\n${formatArgs(args)}\n${state}\n` +
    `--- stdout ---\n${capStream(tracked.stdout())}\n` +
    `--- stderr ---\n${capStream(tracked.stderr())}`
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

function describeEntry(entry: Entry, heading: string): string {
  switch (entry.kind) {
    case 'finished':
      return `${heading} ===\n${describeChild(entry.program)}`;
    case 'tracked':
      return `${heading} ===\n${describeTracked(entry.tracked)}`;
    case 'watched':
      return `${heading}: ${entry.watched.label} ===\n${describeWatched(entry.watched)}`;
  }
}

/**
 * The arguments a transport was created with (after its command, as `record`'s are). The SDK keeps
 * its parameters in `_serverParams` (1.31.0 `client/stdio.js:51`) and has no public reader; only
 * `args` is read, never `env`. An SDK that moves them prints that the arguments are not known.
 */
function transportArgs(transport: StdioClientTransport): string {
  const params = (transport as unknown as { _serverParams?: { args?: unknown } })._serverParams;
  const args = params === undefined ? undefined : (params.args ?? []);
  if (!Array.isArray(args)) return '(not known: this SDK does not keep them where 1.31.0 did)';
  return formatArgs(args.map(String));
}

/** Registers the per-test list and print; returns the recorder the file's spawn helpers use. */
export function printChildrenWhenATestFails(): ChildRecorder {
  const testOf = new AsyncLocalStorage<Entry[]>();
  aroundEach(async (runTest, { task, onTestFailed }) => {
    const entries: Entry[] = [];
    onTestFailed(() => {
      if (entries.length === 0) return;
      const total = entries.length;
      const parts = entries.map((entry, i) =>
        describeEntry(entry, `=== program ${i + 1} of ${total}`),
      );
      process.stderr.write(
        `\n[child-output] test "${task.name}" failed; the ${total} program(s) it started:\n` +
          `${parts.join('\n')}\n` +
          `=== end of the programs test "${task.name}" started ===\n`,
      );
    });
    await testOf.run(entries, runTest);
  });
  const list = (entry: Entry): void => {
    testOf.getStore()?.push(entry);
  };
  return {
    record(program) {
      list({ kind: 'finished', program });
    },
    track(args, child) {
      const tracked: Tracked = {
        args,
        child,
        stdout: collect(child.stdout),
        stderr: collect(child.stderr),
      };
      child.on('close', (status: number | null, signal: NodeJS.Signals | null) => {
        tracked.closed = { status, signal };
      });
      list({ kind: 'tracked', tracked });
      return child;
    },
    watch(label, transport) {
      const stream = transport.stderr;
      if (stream === null) {
        throw new Error(`child-output: watch('${label}') needs a transport with stderr: 'pipe'`);
      }
      list({
        kind: 'watched',
        watched: { label, args: transportArgs(transport), stderr: collect(stream) },
      });
      return transport;
    },
  };
}
