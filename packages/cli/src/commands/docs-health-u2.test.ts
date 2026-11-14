// docs-health-u2.test.ts — #960 U2 (guardrail 7(f), 9): each sentence and row this unit adds to the
// `realm listen` and `realm serve` pages, the webhook trigger page and the CHANGELOG is quoted here
// word for word and asserted to be there; the texts it makes false are asserted gone. The behaviour
// each states is executed in the cells named beside it: `lib/health-address.test.ts` (HA1–HA3),
// `lib/graceful-stop.test.ts` (A14), and `listen-health-u2.test.ts` and `serve-health-u2.test.ts`
// (H1–H11, through the built realm). The sentences U2 changes in U1's own pins (the supervisor
// sentence, "stops accepting", the synopsis, the deploy guide) are in `docs-960.test.ts`. Each
// assertion names (a) the change that turns it red and (b) what it prints when it fails: the page and
// the text it looked for.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const LISTEN = 'docs/reference/cli/realm-listen.md';
const SERVE = 'docs/reference/cli/realm-mcp-and-serve.md';
const TRIGGER = 'docs/reference/workflow/webhook-trigger.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the text word for word; (b) prints the page and the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)), `${page} no longer says: ${text}`).toContain(flat(text));
}
/** (a) red when a text this unit made false is back on the page; (b) prints the page and the text. */
function gone(page: string, text: string): void {
  expect(flat(read(page)), `${page} says again: ${text}`).not.toContain(flat(text));
}
/** The section that holds this unit's entries: `[Unreleased]` until a release renames it, then the
 *  first release section above `[0.49.0]` (#871's form). */
function claimChangelog(text: string): void {
  const all = read('CHANGELOG.md');
  const start = all.includes('## [Unreleased]')
    ? all.indexOf('## [Unreleased]')
    : all.indexOf('\n## [') + 1;
  const section = all.slice(start, all.indexOf('\n## [0.49.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${text}`).toContain(flat(text));
}

/** "The health address", the same on both pages. Executed: H1 (200 and the body, `GET`, `HEAD`),
 *  H2 (no token on serve, no signature on listen), H5 (503, the body, `Connection: close`; with no
 *  drain a new connection is refused at the signal), H6 (with a drain the 503 is seen), HA2 (the
 *  body holds the status only). "It does not look at the store": the address is answered by
 *  `lib/health-address.ts`, which reads no store (HA2 answers it on a plain server). */
const HEALTH =
  '`GET` and `HEAD` requests to `/health` are answered without a token or a signature, so a load balancer or a monitor can ask whether the program is accepting connections: `200` with `{"status":"ok"}`. From the moment it is asked to stop (Ctrl+C or `SIGTERM`) it answers `503` with `{"status":"shutting_down"}` and `Connection: close`. The body says nothing else. With the default `--shutdown-drain 0` the program stops accepting connections at once, so a poller usually sees a refused connection, not the `503`; set `--shutdown-drain` for the `503` to be seen. The address tells you the program is running and not stopping; it does not look at the store, so it does not tell you that a request would succeed. Do not use it as a check that restarts the program: it fails on purpose while the program stops.';
/** The drain paragraph, the same on both pages but for the program's name and where the stop is
 *  described. Executed: H6 (503 at 0.5 s; a new connection at 1 s answered as usual; none accepted
 *  at 4 s; the exit after the drain), H8 (a second signal ends the drain and the grace), H9 (the
 *  stop ends by N plus `--shutdown-grace`). The balancer arithmetic is advice. Kubernetes: its
 *  pod-lifecycle page, "Pod Termination Flow" step 3 (registry MA3-U2-01, MA3-U2-03); that "a few
 *  seconds of drain can also cover the time that takes to reach every router" is INFERRED (not
 *  measured here). */
const DRAIN = (program: string, where: string): string =>
  `After Ctrl+C or \`SIGTERM\`, \`/health\` answers \`503\` at once. With \`--shutdown-drain N\` the program then goes on accepting connections and answering every other request as usual for N seconds, so that a load balancer that checks \`/health\` sees the \`503\` and stops sending requests before the program stops accepting them. When N seconds have passed, the stop described ${where} begins. Set N to at least the time the balancer needs to notice: its check interval times the number of failed checks it needs (a balancer that checks every 30 seconds and needs 2 failures: 60). Kubernetes starts taking a stopping pod out of a Service's list at the same moment it starts the pod's shutdown, so a few seconds of drain can also cover the time that takes to reach every router. A second Ctrl+C or \`SIGTERM\` during the drain ends the drain and the grace at once. The program that stops \`${program}\` must wait longer than N plus \`--shutdown-grace\` seconds.`;
/** The option's row, the same on both pages. Executed: H10 (the range; 0 begins the stop at once),
 *  H6 (the drain keeps accepting and answering while `/health` answers 503). */
const ROW =
  '| `--shutdown-drain <seconds>` | `0` | How long, after Ctrl+C or `SIGTERM`, the program keeps accepting connections and answering requests while `/health` answers 503, before the stop described below begins: a whole number of seconds from 0 to 2147483. 0, the default, begins it at once. Added after version 0.49.0. |';
/** The sentence added at the start of each page's stop paragraph. Executed: H5 and H6. */
const FROM_SIGNAL =
  'From Ctrl+C or `SIGTERM`, `/health` answers `503`; the program keeps accepting connections until `--shutdown-drain` has ended, and the stop below begins then.';
/** The refusal row, the same on both pages. Executed: H10. */
const REFUSAL =
  "| `--shutdown-drain` is not a whole number from 0 to 2147483 (added after version 0.49.0) | `error: option '--shutdown-drain <seconds>' argument '-1' is invalid. --shutdown-drain must be a whole number from 0 to 2147483.` |";

describe('#960 U2 — realm-listen.md', () => {
  it('the flag row, its count, and the `--shutdown-drain` section', () => {
    // Executed by listen H10, H6, H8 and H9 (see ROW and DRAIN); the count is the table's 17 rows
    // (R1.2 added `--max-wait` and `--max-waiting`).
    claim(LISTEN, ROW);
    claim(LISTEN, 'This page lists its argument and 17 flags (13 in version 0.49.0),');
    claim(
      LISTEN,
      `### \`--shutdown-drain\` ${DRAIN('realm listen', 'under _How it stops_')} This flag was added after version 0.49.0.`,
    );
  });

  it('"The health address", the reserved path, and its place after "What it does when it starts"', () => {
    // Executed by listen H1, H2, H5, H6 (see HEALTH); H11 (a workflow at `/health` or with the id
    // `health` and no path stops the start); H3 (not counted toward `--max-concurrent`, not
    // logged at `debug`).
    claim(
      LISTEN,
      `## The health address ${HEALTH} This section was added after version 0.49.0. The path \`/health\` belongs to it: a workflow whose \`trigger.path\` is \`/health\`, or whose \`id\` is \`health\` with no \`trigger.path\`, stops \`realm listen\` from starting (see [Exit codes](#exit-codes)). The health request does not count toward \`--max-concurrent\` and is not logged. ## The read address`,
    );
  });

  it('the stop paragraph, the drain log line, and the two refusal rows', () => {
    // Executed by listen H5 and H6 (the stop paragraph's first sentence), H6 (`listen: draining
    // {"seconds":3}` once, after `listen: shutting down`), H11 (the reserved line, as the CLI
    // prints it, for the id `health`) and H10 (the option's refusal).
    claim(LISTEN, `## How it stops ${FROM_SIGNAL}`);
    claim(
      LISTEN,
      '| `info` | `listen: draining {"seconds"}` | `--shutdown-drain` is above 0: printed at the first signal, before the drain. Added after version 0.49.0. |',
    );
    claim(
      LISTEN,
      "| A workflow's path is `/health`: its `trigger.path`, or its `id` is `health` and it has no `trigger.path` (added after version 0.49.0) | `Error: listen: path '/health' is reserved for the health address — workflow 'health' cannot use it; give it another trigger.path` |",
    );
    claim(LISTEN, REFUSAL);
  });
});

describe('#960 U2 — realm-mcp-and-serve.md', () => {
  it('the flag row and "The health address" before "Stopping and exit codes"', () => {
    // Executed by serve H10, H6 (ROW); H1, H2, H5, H6 (HEALTH); H1 and H4 (a `GET` or `HEAD` of
    // `/health` is answered by the address, no longer by the MCP endpoint).
    claim(SERVE, ROW);
    claim(
      SERVE,
      `### The health address ${HEALTH} This section was added after version 0.49.0. After version 0.49.0, \`GET\` and \`HEAD\` requests to \`/health\` no longer reach the MCP endpoint; a client that used that path as its address must use another. ### Stopping and exit codes`,
    );
  });

  it('"Requests": the path and the token sentences, with the old ones gone', () => {
    // Executed by serve H4 (every other path, `POST /health` included, reaches the MCP endpoint)
    // and H2 (the address takes no token; `POST /` without one is 401).
    claim(
      SERVE,
      'Apart from `GET` and `HEAD` to `/health` (added after version 0.49.0; see [The health address](#the-health-address)), the path is not checked: every path reaches the server.',
    );
    claim(
      SERVE,
      'The token is checked before anything else except the health address (added after version 0.49.0), so a caller without it learns nothing about the request.',
    );
    gone(
      SERVE,
      'requests with the header `Authorization: Bearer <token>`. The path is not checked',
    );
    gone(SERVE, 'The token is checked before anything else, so');
  });

  it('"Stopping and exit codes": the first sentence, the drain paragraph, its line, and the refusal row', () => {
    // Executed by serve H5 and H6 (FROM_SIGNAL); H6, H8, H9 (DRAIN); H6 (the line, printed once on
    // standard error at the first signal) and H10 (none with 0; the refusal).
    claim(
      SERVE,
      `### Stopping and exit codes ${FROM_SIGNAL} When the stop begins, \`realm serve\` stops accepting requests.`,
    );
    claim(SERVE, DRAIN('realm serve', 'above'));
    claim(
      SERVE,
      'With `--shutdown-drain` above 0, `realm serve` prints one line to stderr at the first signal. With `--shutdown-drain 3`:',
    );
    claim(
      SERVE,
      '```text\nrealm serve: --shutdown-drain 3 started. /health answers 503 now; connections are accepted until the drain ends. A second Ctrl+C ends it at once.\n```',
    );
    claim(SERVE, REFUSAL);
  });
});

describe('#960 U2 — the webhook trigger page and the CHANGELOG', () => {
  it('webhook-trigger.md: the `path` sentence and the reply before the checks', () => {
    // Executed by listen H11 (a workflow cannot have `/health`), H4 (a `GET` of `/health` is
    // answered before the method check: 200, not 405), H5 (503 once stopping).
    claim(
      TRIGGER,
      '`/health` is taken by the health address; a workflow cannot have it. Added after version 0.49.0.',
    );
    claim(
      TRIGGER,
      '`realm listen` checks a request in this order, and stops at the first check that fails. Before the method check, `realm listen` answers a `GET` or `HEAD` of `/health` itself: `200` `{"status":"ok"}`, or `503` `{"status":"shutting_down"}` once it is stopping. It is not one of the checks below, and a workflow cannot have that path. Added after version 0.49.0.',
    );
  });

  it('the three CHANGELOG bullets', () => {
    // H1 and H2 (the address, no token), H5 (503 once stopping), H10 (0 by default), H6 (serving
    // with 503 before the stop), H11 and serve H1/H4 (`/health` is taken on both).
    claimChangelog(
      '- **A health address on `realm serve` and `realm listen`**: `GET` and `HEAD` `/health`, without a token, `200` `{"status":"ok"}`, and `503` `{"status":"shutting_down"}` once the program is asked to stop.',
    );
    claimChangelog(
      '- **`--shutdown-drain <seconds>` on `realm serve` and `realm listen`**: how long the program keeps serving, with `/health` answering 503, after Ctrl+C or `SIGTERM` before it stops accepting connections; 0 by default.',
    );
    claimChangelog(
      '- **`/health` is taken.** `realm listen` now refuses to start a workflow whose path is `/health` (its `trigger.path`, or the default path of a workflow with the id `health`), and on `realm serve` a `GET` or `HEAD` to `/health` no longer reaches the MCP endpoint.',
    );
  });
});
