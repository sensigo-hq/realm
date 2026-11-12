// docs-960.test.ts — issue #960 (guardrail 7(f), 9): each sentence and row this unit adds or
// rewrites on the `realm listen` and `realm serve` pages, in the deploy guide and in the CHANGELOG
// is quoted here word for word and asserted to be there; the old false texts are asserted gone.
// The behaviour each states is executed in the cells named beside it: `lib/graceful-stop.test.ts`
// (A1–A13, the tracker on a plain server), `listen-stop-960.test.ts` and `serve-stop-960.test.ts`
// (B1–B13, through the built realm). Each assertion names (a) the change that turns it red and
// (b) what it prints when it fails: the page and the text it looked for.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const LISTEN = 'docs/reference/cli/realm-listen.md';
const SERVE = 'docs/reference/cli/realm-mcp-and-serve.md';
const DEPLOY = 'docs/guides/deploy.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the text word for word; (b) prints the page and the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)), `${page} no longer says: ${text}`).toContain(flat(text));
}
/** (a) red when an old false text is back on the page; (b) prints the page and the text. */
function gone(page: string, text: string): void {
  expect(flat(read(page)), `${page} says again: ${text}`).not.toContain(flat(text));
}
/** The section that holds this unit's entry: `[Unreleased]` until a release renames it, then the
 *  first release section above `[0.49.0]` (#871's form). */
function claimChangelog(text: string): void {
  const all = read('CHANGELOG.md');
  const start = all.includes('## [Unreleased]')
    ? all.indexOf('## [Unreleased]')
    : all.indexOf('\n## [') + 1;
  const section = all.slice(start, all.indexOf('\n## [0.49.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${text}`).toContain(flat(text));
}

/** The supervisor sentence, the same on both pages but for the program's name. Docker's 10 s is
 *  registry row AUD-944r5-11 (executed); systemd's 90 s (`DefaultTimeoutStopSec`) is read from its
 *  documentation and was never run here: INFERRED. */
const SUPERVISOR = (program: string): string =>
  `A program that stops \`${program}\` on a shorter limit than this ends it first (\`docker stop\` waits 10 seconds by default, systemd 90): give it a limit longer than \`--shutdown-grace\`.`;
/** The stop paragraph's middle, the same on both pages. */
const STOPS =
  'A connection that is waiting between requests is closed at once. A connection that has not sent a request yet is given up to 5 seconds from the moment it connected, and a request that arrives on it in that time is answered. Requests being answered get `--shutdown-grace` seconds (30 by default) to finish; each answer written from then on says `Connection: close`, and a connection is closed once its answer is finished.';
const ROW_TEXT =
  'How long requests that are being answered get to finish after Ctrl+C or `SIGTERM`: a whole number of seconds from 0 to 2147483. When it runs out, the requests still open are cut and the exit code is 1. 0 cuts them at once.';
const CODES =
  '| 0 | It was stopped by Ctrl+C or `SIGTERM` and cut no request. | | 1 | It could not start, or it was stopped and had to cut requests that were still being answered. |';
const REFUSAL =
  "| `--shutdown-grace` is not a whole number from 0 to 2147483 (added after version 0.49.0) | `error: option '--shutdown-grace <seconds>' argument '-1' is invalid. --shutdown-grace must be a whole number from 0 to 2147483.` |";

describe('issue #960 — realm-listen.md', () => {
  it('the flag row and the `--shutdown-grace` section', () => {
    // Executed by listen B10 (the range), B11 and B7b (the default, 30), B6 (cut, exit 1), B9 (0
    // cuts at once); the section's line is B6's own output.
    claim(
      LISTEN,
      `| \`--shutdown-grace <seconds>\` | \`30\` | ${ROW_TEXT} Added after version 0.49.0. |`,
    );
    claim(
      LISTEN,
      'When it runs out while requests are still being answered, `realm listen` cuts them, logs one line at level `error` and exits with code 1. With `--shutdown-grace 1` and a request whose body never finished:',
    );
    claim(
      LISTEN,
      '```text\nlisten: shutdown cut requests {"cut":1,"because":"grace_ran_out","grace_seconds":1}\n```',
    );
    claim(LISTEN, SUPERVISOR('realm listen'));
  });

  it('"How it stops": the stop by state, the second signal, a cut delivery; the old promise gone', () => {
    // Executed by listen B1, B2 (the 5 s window), B3 (a late request answered, `connection:
    // close`), B4 (waiting between requests: closed at once), B5 (an answer after the signal,
    // `connection: close`, then the exit), B7b (30 by default), B7 (the second signal), B6 (a cut
    // delivery: no bytes, its connection closed).
    claim(
      LISTEN,
      'On Ctrl+C or a `SIGTERM`, `realm listen` logs `listen: shutting down {"reason":"SIGTERM"}` and stops accepting requests.',
    );
    claim(LISTEN, STOPS);
    claim(LISTEN, 'A second Ctrl+C or `SIGTERM` ends everything still open at once.');
    claim(
      LISTEN,
      'A delivery that is cut gets no answer: `realm listen` closes its connection without replying.',
    );
    gone(LISTEN, 'stops accepting requests, and exits with code 0.');
  });

  it('the exit codes, the log line and the refusal; the old rows gone', () => {
    // Executed by listen B1 (0, nothing cut), B6 and B7 (1 after a cut, the line at `error`, its
    // two causes), B10 (the refusal line).
    claim(LISTEN, CODES);
    claim(
      LISTEN,
      '| `error` | `listen: shutdown cut requests {"cut","because","grace_seconds"}` | `--shutdown-grace` ran out, or a second signal came, while requests were being answered; `because` is `grace_ran_out` or `second_signal` |',
    );
    claim(LISTEN, REFUSAL);
    gone(LISTEN, '| 0 | It was stopped by Ctrl+C or `SIGTERM`. |');
    gone(LISTEN, '| 1 | It could not start. |');
  });
});

describe('issue #960 — realm-mcp-and-serve.md', () => {
  it('the synopsis and the flag row', () => {
    // Executed by serve B10 (the range), B11 (the default, 30), B6 (cut, exit 1), B9 (0 cuts at
    // once).
    claim(
      SERVE,
      'realm serve [--port <number>] [--host <address>] [--shutdown-grace <seconds>] [--dev]',
    );
    claim(
      SERVE,
      `| \`--shutdown-grace <seconds>\` | \`30\` | ${ROW_TEXT} ${SUPERVISOR('realm serve')} Added after version 0.49.0. |`,
    );
  });

  it('"Stopping and exit codes": the stop by state, the held stream, the lines; the old promise gone', () => {
    // Executed by serve B1, B2, B3, B4, B5 (as for listen), B12 (a connected MCP client's GET
    // stream is closed at once: exit 0, no line), B7 (the second signal and its line), B6 (the
    // grace's line, exit 1).
    claim(SERVE, 'On Ctrl+C or a `SIGTERM`, `realm serve` stops accepting requests.');
    claim(SERVE, STOPS);
    claim(
      SERVE,
      "A stream that a client opened only to wait for the server's messages (an MCP client's `GET` stream) is closed at once; that is not a cut request. A second Ctrl+C or `SIGTERM` ends everything still open at once.",
    );
    claim(
      SERVE,
      'When it had to cut requests, `realm serve` prints one line to stderr and exits with code 1. With `--shutdown-grace 1` and a request whose body never finished:',
    );
    claim(SERVE, '```text\nrealm serve: --shutdown-grace 1 ran out. Requests cut: 1.\n```');
    claim(
      SERVE,
      'After a second signal the line is `realm serve: a second signal arrived. Requests cut: 1.`',
    );
    gone(SERVE, 'stops accepting connections and exits with code 0.');
  });

  it('after a cut: what the operator sees for the step and the reclaim that frees it', () => {
    // Executed by serve B13 (b): the step stays taken (`realm run inspect`), `--stuck` lists
    // nothing while the claim is healthy, `realm run reclaim` shows it healthy with its deadline,
    // `--step … --force` frees it with the side-effects warning, then the step is owed with
    // `realm run advance`.
    claim(
      SERVE,
      "A request cut while it ran an `auto` step leaves that step taken by `realm serve`: `realm run inspect <run>` shows it in progress, and `realm run list --stuck` does not list the run while that claim is healthy (`realm run reclaim <run>` shows it healthy, with its deadline). `realm run reclaim <run> --step <step> --force` frees it and warns that the step's side effects may repeat; `realm run inspect` then shows the step owed, with the `realm run advance <run>` that runs it again.",
    );
  });

  it('the exit codes and the refusal; the old rows gone', () => {
    // Executed by serve B1 and B12 (0, nothing cut), B6 and B7 (1 after a cut), B10 (the refusal).
    claim(SERVE, CODES);
    claim(SERVE, REFUSAL);
    gone(SERVE, '| 0 | It was stopped by Ctrl+C or `SIGTERM`. |');
    gone(SERVE, '| 1 | It could not start. |');
  });
});

describe('issue #960 — the deploy guide and the CHANGELOG', () => {
  it("the deploy guide's exit-code sentence under the systemd unit", () => {
    // The exit codes: serve B6 (1 after a cut) and B12 (0). The systemd half (no restart after
    // `systemctl stop`, a restart after exit 1 under `Restart=on-failure`) is read from systemd's
    // documentation (registry AUD-960-26) and was never run here: INFERRED.
    claim(
      DEPLOY,
      '`realm serve` exits 0 when it was stopped and cut no request, and 1 when it had to cut requests (see [its page](../reference/cli/realm-mcp-and-serve.md#stopping-and-exit-codes)). systemd does not restart a service you stop with `systemctl stop`, but it restarts one that exits 1 under `Restart=on-failure`, such as a `kill` that cut requests.',
    );
  });

  it('the three CHANGELOG bullets', () => {
    // 5 s by B1 and B2; 30 by B7b and B11; 0 to 2147483 by B10; the exit codes by B6 and B12; the
    // held stream by B12; the second signal by B7 (each on both commands where it applies).
    claimChangelog(
      '- **`--shutdown-grace <seconds>` on `realm serve` and `realm listen`**: how long requests being answered get to finish after Ctrl+C or `SIGTERM`; 30 by default; 0 to 2147483.',
    );
    claimChangelog(
      '- **`realm serve` and `realm listen` exit with code 1 when they had to cut requests that were still being answered**; 0 when none was cut.',
    );
    claimChangelog(
      "- **`realm serve` and `realm listen` stop when asked (issue #960).** Before, one connection that had sent nothing kept either program running after Ctrl+C or `SIGTERM` until it was killed. Now a connection waiting between requests is closed at once, a connection that has not sent a request yet gets up to 5 seconds, and requests being answered get time to finish before they are cut. A second signal cuts everything at once, and a connected MCP client's notification stream is closed at once; that is not a cut request.",
    );
  });
});
