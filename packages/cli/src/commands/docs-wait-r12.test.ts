// docs-wait-r12.test.ts — R1.2 (guardrail 7(f), 9): each sentence and row this unit adds to or
// changes on the webhook trigger page, the `realm listen` page, the webhooks guide, the page on who
// drives a run and the CHANGELOG is quoted here word for word and asserted to be there; the
// sentences it made false are asserted gone. The behaviour each states is executed in the cells
// named beside it: `commands/listen-wait-r12.test.ts` (C1–C12, in process),
// `commands/listen-wait-r12-cli.test.ts` (B1–B6, the built realm) and `source-canary-729.test.ts`
// (G4b, the wait's door). Every reply shown came from the built `realm listen` (the captures in the
// unit's records). Each assertion names (a) the change that turns it red and (b) what it prints.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadWorkflowFromString } from '@sensigo/realm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const TRIGGER = 'docs/reference/workflow/webhook-trigger.md';
const LISTEN = 'docs/reference/cli/realm-listen.md';
const GUIDE = 'docs/guides/webhooks.md';
const DRIVERS = 'docs/concepts/who-drives-a-run.md';
const WAITING =
  '[Waiting for the result](../reference/workflow/webhook-trigger.md#waiting-for-the-result)';
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
/** The section that holds this unit's entries: `[Unreleased]` until a release renames it. */
function claimChangelog(text: string): void {
  const all = read('CHANGELOG.md');
  const start = all.includes('## [Unreleased]')
    ? all.indexOf('## [Unreleased]')
    : all.indexOf('\n## [') + 1;
  const section = all.slice(start, all.indexOf('\n## [0.49.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${text}`).toContain(flat(text));
}

describe('R1.2 — webhook-trigger.md, "Waiting for the result"', () => {
  it('the section: what ends a wait, and the reply for each', () => {
    // C3 (each phase of a run that ended: the read's 200), C4 (a gate within one check), C5 (the
    // exit; N), C6 and B2 (the stop), C7 (the hang-up: nothing sent).
    claim(
      TRIGGER,
      'A caller that would rather not ask again can send `Prefer: wait=N` with the `POST` that starts the run, N a whole number of seconds from 1. `realm listen` then holds its reply until one of these happens, and answers once:',
    );
    claim(
      TRIGGER,
      '| The run ends: `completed`, `failed`, `aborted` or `abandoned` | `200` with what a `GET` of its `status_path` would answer: the phase and, for a completed run, the result, `result_masked` or `result_error`, as above |',
    );
    claim(
      TRIGGER,
      '| The run stops at a person\'s gate | The `202` above, with `"run_phase":"gate_waiting"`, within about 2 seconds of the gate |',
    );
    claim(
      TRIGGER,
      '| The process that drives the run exits and the run has not ended (for example it had no model key, or it crashed) | The `202`, with the phase the run is in |',
    );
    // C3 (a run that ends between the last check and N: 200 at N; just before the signal: 200).
    claim(
      TRIGGER,
      '| N seconds pass | The `200` if the run has ended by then; otherwise the `202`, with its phase |',
    );
    claim(
      TRIGGER,
      '| `realm listen` is stopped (Ctrl+C or `SIGTERM`) | At once: the `200` if the run has ended; otherwise the `202`, with its phase (with `--shutdown-grace 0` and no `--shutdown-drain` it is cut instead, as every request being answered is) |',
    );
    claim(TRIGGER, '| The caller hangs up | Nothing is sent |');
  });

  it('the cap, the header it sends, the failed read, and that the run goes on', () => {
    // C2 (applied N, the cap), B1 (the default cap of 25 on the built realm), C10 (a failed read:
    // the reply without Prefer), C4 and C7 (the run is not touched).
    claim(
      TRIGGER,
      'N is no more than `--max-wait` (25 seconds unless it is set; see [`realm listen`](../cli/realm-listen.md)). Each of these replies carries `Preference-Applied: wait=<N>`, the N that was applied: the one asked for, or `--max-wait` if that is lower. If the run cannot be read when the wait ends, the reply is the `202` the request would have had without `Prefer`, without `Preference-Applied`.',
    );
    claim(
      TRIGGER,
      'The wait never stops the run, and a caller that stops waiting does not stop it either: read the run later at its `status_path`.',
    );
  });

  it('when the header is ignored', () => {
    // C1 (no result_map), C9 (a repeat; a failed start), C6 (stopping), C8 (the budget), C2 (each
    // ignored spelling, first-wins, the name in any case, `respond-async`; the honoured `wait = 20`,
    // `wait=020` and `wait=20;`), C7 (a caller that half-closes after sending: hung up).
    claim(
      TRIGGER,
      'The header is ignored, and the request answered at once as if it had not asked, for a workflow without `result_map`, for a repeat of an event, for a run whose process could not be started, while `realm listen` is stopping, and when `--max-waiting` requests are already waiting. A value that is not a whole number of seconds from 1 is ignored too, never refused: `wait=0`, `wait=1.5`, `wait=20s` and `wait="20"` are, and so is a `wait` with a parameter (`wait=20; x=y`). Blanks around `=` (`wait = 20`), leading zeros (`wait=020`, read as 20) and a `;` with nothing after it (`wait=20;`) do not make it one: those are honoured. Only the first `wait` in the header counts, and the name is read in any case. Other preferences, such as `respond-async`, are ignored. A caller that closes its side of the connection as soon as it has sent the request, as `nc -N` does, counts as hung up, even if it still reads the reply: it gets nothing, and the run starts anyway.',
    );
    // C11 and B5 (`--max-wait 0`, `--max-concurrent 1`); 0.49.0 reads no `Prefer` (registry).
    claim(
      TRIGGER,
      'Version 0.49.0 and older ignore `Prefer`, and so does `realm listen` started with `--max-wait 0` or `--max-concurrent 1`. So handle the `202` always, and treat the wait as a way to save a read.',
    );
    // nginx's own page (registry R12-IA): `proxy_read_timeout`, default 60 s between two reads.
    claim(
      TRIGGER,
      'A request held this long passes through every proxy or gateway in front of `realm listen`, and each must allow it: nginx closes a proxied connection that sends nothing for 60 seconds by default (`proxy_read_timeout`), and a wait sends nothing until it ends.',
    );
    claim(TRIGGER, 'This section was added after version 0.49.0.');
  });

  it('the growth rule after the field table, and the reply sentence', () => {
    // Advice to a client, owed since #1141's review: what it does with what it does not know.
    claim(
      TRIGGER,
      'A later version of Realm may add fields to these replies and words to `run_phase` and `result_error`. A client written against this page ignores a field it does not know, reads a `run_phase` it does not know as a run that has not finished (it keeps asking until its own deadline), and reads a `result_error` it does not know as no result. It keeps the token as it came, and reads nothing into it.',
    );
    // C1 and C3.
    claim(
      TRIGGER,
      '`realm listen` does not wait for the run, unless the request asks it to wait: see [Waiting for the result](#waiting-for-the-result).',
    );
    gone(TRIGGER, '`realm listen` does not wait for the run. When');
  });

  it('the ride-along: what a prefix is, and the loader’s verdict on each name the sentence gives', () => {
    // The sentence itself is claimed in `docs-result-read-r11.test.ts`; here, the old one is gone.
    gone(TRIGGER, 'in any case and with a prefix (`my_token`, `x_secret`)');
    const verdict = (name: string): string => {
      try {
        loadWorkflowFromString(
          `id: w\nname: w\nversion: 1\ntrigger:\n  type: webhook\n  path: /w\n  auth:\n    mode: shared_secret\n    header: X-Token\n    secret_from: S\n  result_map:\n    ${JSON.stringify(name)}: context.resources.review.approved\nsteps:\n  review:\n    description: Review.\n    execution: auto\n`,
        );
        return 'loads';
      } catch (err) {
        return (err as Error).message.includes("reads as a credential's name")
          ? 'refused'
          : 'other';
      }
    };
    // (a) red when a name the page says is refused loads, or one it says is not is refused; (b)
    //     prints each name's verdict.
    expect(
      Object.fromEntries(
        [
          'my_token',
          'x-secret',
          'my.token',
          'my token',
          'myToken',
          'mytoken',
          'xsecret',
          'MYTOKEN',
        ].map((n) => [n, verdict(n)]),
      ),
    ).toEqual({
      my_token: 'refused',
      'x-secret': 'refused',
      'my.token': 'refused',
      'my token': 'refused',
      myToken: 'refused',
      mytoken: 'loads',
      xsecret: 'loads',
      MYTOKEN: 'loads',
    });
  });
});

describe('R1.2 — realm-listen.md', () => {
  it('the two flag rows', () => {
    // C11 (the ranges, 0, the defaults), B1 (the default 25), B5 (`--max-concurrent 1`), C8 (the
    // budget and the clamp).
    claim(
      LISTEN,
      '| `--max-wait <seconds>` | `25` | The longest a request that sends `Prefer: wait=N` is held before it is answered: a whole number of seconds from 0 to 300; 0 turns waiting off. A workflow without `result_map` ignores the header. See [Waiting for the result](../workflow/webhook-trigger.md#waiting-for-the-result). Added after version 0.49.0. |',
    );
    claim(
      LISTEN,
      '| `--max-waiting <n>` | `5`, or one less than `--max-concurrent` if that is smaller | How many requests may be held waiting at once: a whole number from 1 to one less than `--max-concurrent`. A waiting request keeps its place among `--max-concurrent`, so a place is always left for a new event, and with `--max-concurrent 1` no request waits. Added after version 0.49.0. |',
    );
  });

  it('the drain, the stop and the request sentences', () => {
    // C6 (a POST during the drain does not wait; a waiter is answered at the stop).
    claim(
      LISTEN,
      'During the drain, a request that asks to wait for its run (`Prefer: wait=N`) is answered at once, as if it had not asked; one that was already waiting is answered at the Ctrl+C or `SIGTERM` (see _How it stops_). This was added after version 0.49.0.',
    );
    // B2 (drain 5: answered within a second of the signal), C3 (200 at the signal), B3 (grace 0 and
    // no drain: cut, exit 1). With a drain the waiter is answered at the signal, before the cut.
    claim(
      LISTEN,
      'A request that is waiting for its run (`Prefer: wait=N`, see [Waiting for the result](../workflow/webhook-trigger.md#waiting-for-the-result)) is answered at the first Ctrl+C or `SIGTERM`, before any `--shutdown-drain`: the `200` if its run has ended, otherwise the `202` with its phase. With `--shutdown-grace 0` and no `--shutdown-drain`, it is cut like any other request being answered. This was added after version 0.49.0.',
    );
    gone(LISTEN, 'It does not wait for the run. The reply');
    gone(LISTEN, 'With `--shutdown-grace 0`, or at a second Ctrl+C or `SIGTERM`, it is cut like');
  });

  it('the log lines', () => {
    // C12 (one line, at info, three fields, nothing of the run's), each ending's word in C3–C10,
    // B3 (`signal` for a waiter the stop cut), C10 (`failed`, with `webhook: read failed`); C1, C2,
    // C8, C9, C11 (a request answered at once logs no `wait ended` line).
    claim(
      LISTEN,
      '| `info` | `webhook: wait ended {"run_id","ended_by","waited_ms"}` | A request that asked to wait for its run (`Prefer: wait=N`) was held waiting, and the wait has ended. A request that asked and was answered at once, for any of the reasons in [Waiting for the result](../workflow/webhook-trigger.md#waiting-for-the-result), logs nothing here. `ended_by` says why the wait ended: `terminal` (the run had ended), `gate` (a person\'s gate), `exit` (the process that drives the run exited with the run open), `cap` (N seconds passed), `signal` (Ctrl+C or `SIGTERM`, a waiter the stop cut included), `hangup` (the caller hung up; nothing was sent) or `failed` (the run could not be read: the reply was the one without `Prefer`, and `webhook: read failed` is logged too). `waited_ms` is how long it waited, in milliseconds. Nothing of the run is logged. Added after version 0.49.0. |',
    );
    // B5.
    claim(
      LISTEN,
      '| `warn` | `listen: --max-concurrent is 1, so a request that asks to wait is answered at once.` | At startup, with `--max-concurrent 1`, `--max-wait` above 0 and a workflow with `result_map`. Added after version 0.49.0. |',
    );
  });

  it('the four refusals', () => {
    // B4 (each line as the built realm prints it, before any workflow is read).
    claim(
      LISTEN,
      "| `--max-wait` is not a whole number from 0 to 300 (added after version 0.49.0) | `error: option '--max-wait <seconds>' argument '301' is invalid. --max-wait must be a whole number from 0 to 300.` |",
    );
    claim(
      LISTEN,
      "| `--max-waiting` is 0 or not a whole number (added after version 0.49.0) | `error: option '--max-waiting <n>' argument '0' is invalid. --max-waiting must be a whole number from 1 to one less than --max-concurrent.` |",
    );
    claim(
      LISTEN,
      '| `--max-waiting` is not below `--max-concurrent` (added after version 0.49.0) | `Error: --max-waiting 5 must be below --max-concurrent 5: a request that waits keeps one of its places, and this many waiting could leave none for a new event. Give --max-waiting a number from 1 to 4, or raise --max-concurrent.` |',
    );
    claim(
      LISTEN,
      '| `--max-concurrent` is 1 and `--max-waiting` is given (added after version 0.49.0) | `Error: --max-concurrent is 1, so no request can wait and still leave a place for a new event. Remove --max-waiting, or raise --max-concurrent.` |',
    );
  });
});

describe('R1.2 — the webhooks guide, who drives a run, and the CHANGELOG', () => {
  it('webhooks.md: the reply sentence and "Waiting for the answer"', () => {
    // C1 and C3.
    claim(
      GUIDE,
      `It replies as soon as the run exists, unless the request asks it to wait: see ${WAITING}.`,
    );
    gone(GUIDE, 'It replies as soon as the run exists.');
    // B1 and the capture (the built realm: a run that ended inside N, and one still going at N);
    // C1 (a workflow without result_map ignores the header), C4 (a gate ends the wait).
    claim(
      GUIDE,
      "A caller that would rather have the result in the reply itself sends `Prefer: wait=20` with the request that starts the run, to a workflow that has a `result_map` (the refunds workflow above; a workflow without one ignores the header). `realm listen` then holds the reply until the run ends or stops at a person's gate, for 20 seconds at most:",
    );
    gone(
      GUIDE,
      'sends `Prefer: wait=20`. `realm listen` then holds the reply until the run ends, for 20 seconds at most:',
    );
    claim(
      GUIDE,
      'curl -i http://127.0.0.1:3000/refunds \\ -H \'Content-Type: application/json\' \\ -H \'X-Webhook-Token: choose-a-long-secret\' \\ -H \'Prefer: wait=20\' \\ -d \'{"event_id":"evt-302","approved":true,"note":"refund to the original card"}\'',
    );
    claim(
      GUIDE,
      'HTTP/1.1 200 OK Content-Type: application/json Cache-Control: no-store Content-Length: 196 Preference-Applied: wait=20 {"run_id":"9db311b2-3159-4247-9370-83e6f2ab2ee6","run_phase":"completed","result":{"approved":true,"note":"refund to the original card"},"result_masked":{"declared":0,"environment":0,"pattern":0}}',
    );
    claim(
      GUIDE,
      'HTTP/1.1 202 Accepted Content-Type: application/json Content-Length: 240 Location: /refunds-review/runs/48da5dfe-1666-4b88-915d-180fc4eac78c Retry-After: 5 Preference-Applied: wait=5 {"run_id":"48da5dfe-1666-4b88-915d-180fc4eac78c","status":"accepted","run_phase":"running","status_path":"/refunds-review/runs/48da5dfe-1666-4b88-915d-180fc4eac78c","token":"843a235f3a349ecf96c3413302fa67222bcf768963575fa8baba4a69eeb4c3ce"}',
    );
    // The capture's second workflow (`ia4-r12/captures/capture.mjs`: the same `result_map`, an agent
    // step whose model never answered within 5 s).
    claim(
      GUIDE,
      'Here a second refunds workflow, at `/refunds-review`, with the same `result_map` and a step that asks a model, was asked with `Prefer: wait=5` while the model had not yet answered:',
    );
    gone(
      GUIDE,
      'Here a workflow at `/refunds-review`, whose step asks a model that had not answered,',
    );
    // C4, C7 (the run is not touched); the reference section and the command's page.
    claim(
      GUIDE,
      `The wait never stops the run: read it later at its \`status_path\`, as above. When the header is ignored is in ${WAITING}; what \`--max-wait\` and \`--max-waiting\` do is in [\`realm listen\`](../reference/cli/realm-listen.md). This was added after version 0.49.0.`,
    );
  });

  it('who-drives-a-run.md: the reply sentence', () => {
    // C1 and C3.
    claim(
      DRIVERS,
      `The request gets its reply as soon as the run exists, and does not wait for the run to finish, unless the request asks it to wait: see ${WAITING}.`,
    );
    gone(
      DRIVERS,
      'The request gets its reply as soon as the run exists; it does not wait for the run to finish.',
    );
  });

  it('the CHANGELOG: one Added entry, no Changed one', () => {
    // C3–C8 and B1–B3.
    claimChangelog(
      "- **A caller of `realm listen` can ask the reply to wait for the run**: a `POST` that starts a run of a workflow with `result_map` and sends `Prefer: wait=N` is answered `200` with the result once the run ends, or with the `202` and the phase reached when the run stops at a person's gate, its process exits, N seconds pass or `realm listen` is stopped; the wait never stops the run. `--max-wait <seconds>` caps N (25 by default; 0 turns waiting off), and `--max-waiting <n>` how many requests wait at once (5 by default, and always fewer than `--max-concurrent`). Waiting requests are answered at the first Ctrl+C or `SIGTERM`, before any `--shutdown-drain` (with `--shutdown-grace 0` and no drain they are cut, as every request being answered is).",
    );
  });
});
