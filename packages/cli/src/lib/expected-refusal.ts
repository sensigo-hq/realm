// expected-refusal.ts — #715 (a) correction 1 (C-6): the one place the CLI's entry prints an EXPECTED
// typed refusal that a command raised: one `Error: <message>` line on stderr, exit code 1, no stack
// trace. npm, pip and Cargo do this at one catch at their entry, and keep the stack for unexpected
// errors; so does this.
//
// The list has ONE member: a run store opened on a copy of a test location. Every other error keeps
// escaping loud, a `WorkflowError` included — "bugs stay loud" (`validate.ts`, #123); the writer's
// fatal handler prints those with their stack. The code is read from the error's fields, never by
// `instanceof`: the CLI and the library it loads can be separate copies.

/** The codes printed as one line. Each is a refusal an operator meets and can act on from its text. */
const EXPECTED_CODES: ReadonlySet<string> = new Set(['STATE_TEST_CLOCK_FOREIGN']);

/**
 * When `err` carries a code in the list: writes `Error: <message>` to stderr, sets the exit code to 1,
 * and returns `true`. Anything else: writes nothing and returns `false`, so the caller rethrows it.
 *
 * The line goes through `process.stderr`, which the CLI's writer masks for its audience; the process
 * is not exited here, so the stream is flushed before it ends.
 */
export function reportExpectedRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string' || !EXPECTED_CODES.has(code)) return false;
  const message = (err as { message?: unknown }).message;
  process.stderr.write(`Error: ${typeof message === 'string' ? message : code}\n`);
  process.exitCode = 1;
  return true;
}
