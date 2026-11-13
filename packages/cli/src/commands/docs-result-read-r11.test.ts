// docs-result-read-r11.test.ts — R1.1 (guardrail 7(f), 9): each sentence and row this unit adds to or
// changes on the webhook trigger page, the `realm listen` page, the webhooks guide and the CHANGELOG
// is quoted here word for word and asserted to be there; the sentences it made false are asserted
// gone. The behaviour each states is executed in the cells named beside it: `lib/run-read-address.test.ts`
// (G2, G3, G5, G7–G14, the read address in process), `commands/listen-result-read-r11.test.ts` (R1,
// S1, S2, P1, P2: the start and the replies), `commands/listen-result-read-r11-real.test.ts` (G1,
// G6, through the built realm), `source-canary-729.test.ts` (G4), `commands/result-map-cli-r11.test.ts`
// (L1 on the CLI) and core's `workflow/result-map-r11.test.ts` (L1–L4 at load). Every reply shown
// came from the built `realm listen` (the captures in the unit's records). Each assertion names
// (a) the change that turns it red and (b) what it prints when it fails: the page and the text.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const TRIGGER = 'docs/reference/workflow/webhook-trigger.md';
const LISTEN = 'docs/reference/cli/realm-listen.md';
const GUIDE = 'docs/guides/webhooks.md';
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

/** The captured run every reply on the pages shows (the built `realm listen`, a fake secret). */
const RUN = 'd5135829-125d-4f31-9ba7-84cf1ac5b333';
const TOKEN = 'a138b12da78072298d9b77e1ba0a4e5d510e1f5982f4908fc415a983b6ac846b';
const COMPLETED = `200 {"run_id":"${RUN}","run_phase":"completed","result":{"approved":true,"note":"refund to the original card"},"result_masked":{"declared":0,"environment":0,"pattern":0}}`;
const ACCEPTED = `202 {"run_id":"${RUN}","status":"accepted","run_phase":"running","status_path":"/refunds/runs/${RUN}","token":"${TOKEN}"}`;

describe('R1.1 — webhook-trigger.md', () => {
  it('the block table, and the dedup sentences the in-window repeat made false', () => {
    // The row: L4 (the table equals the schema's keys), L1 (shared_secret only).
    claim(
      TRIGGER,
      '| [`result_map`](#result_map) | map | No | What a caller can read of a finished run. Only with `auth.mode: shared_secret`. Added after version 0.49.0. |',
    );
    // P2 (the in-window repeat names the run; a purged run gets the bare reply).
    claim(
      TRIGGER,
      'inside the window the reply names the run, `200` `{"status":"deduplicated","run_id":"<run-id>","run_phase":"<phase>"}` (the bare `{"status":"deduplicated"}` when the run is gone), and nothing says the values differed (changed after version 0.49.0).',
    );
    gone(
      TRIGGER,
      'inside the window the reply is the bare `200` `{"status":"deduplicated"}`, and nothing says the values differed.',
    );
    // P2 (in the window and after it the same named reply); the 500 part is #735's.
    claim(
      TRIGGER,
      'With the block at the top of this page, event `evt-201` delivered again, within five minutes or later while its run exists, gets `200` `{"status":"deduplicated","run_id":"<the run\'s id>","run_phase":"running"}` (or the phase the run has reached), and no run or agent starts — unless its agent failed to start: then it gets its `500` again (the two-copy case above aside). Within the five minutes, this reply was the bare `{"status":"deduplicated"}` until version 0.49.0 (changed after version 0.49.0).',
    );
    gone(
      TRIGGER,
      'event `evt-201` delivered again within five minutes gets `200` `{"status":"deduplicated"}`',
    );
    // P2's failed-start cell: a run a failed start sealed keeps the bare reply in the window, so
    // this sentence, about the two-copy race, stays true (MA 3's reading of C).
    claim(
      TRIGGER,
      'Its retries then get the bare `200` `{"status":"deduplicated"}` until the duplicate window has passed',
    );
  });

  it('`result_map`: what it is, the example, and what a caller reads', () => {
    // L3 (paths), L4 (the definition carries the map), G1 (the example's replies), G3 (left out,
    // null, `{}`), the bare auto step's parameters (G1's own workflow records them).
    claim(
      TRIGGER,
      '## `result_map` By default the caller of `realm listen` learns only that its request was accepted. With `result_map`, it can also ask later what happened to the run it started, and read the values you choose. This section was added after version 0.49.0.',
    );
    claim(
      TRIGGER,
      '  result_map:\n    approved: context.resources.review.approved\n    note: context.resources.review.note\nsteps:\n  review:\n    description: Record the decision.\n    execution: auto',
    );
    claim(
      TRIGGER,
      "Each name becomes a key of the `result` in the reply. Each value is `context.resources.<step>.<field>`: a field of that step's recorded output. A field the run did not produce is left out; a field the run set to `null` is sent as `null`. `result_map: {}` hands out the run's phase only.",
    );
    claim(
      TRIGGER,
      "A step with no handler and no service, and no `depends_on`, records the run's parameters as its output, so a path that names it hands those parameters out. The step `review` above is one: its output is the run's `approved` and `note`.",
    );
    // P1 (the 202's fields and headers), G1 (GET with the token; HEAD), G12 (a query string still
    // reads; the path is put after the caller's own base address).
    claim(
      TRIGGER,
      'For a workflow with `result_map`, the `202` carries `status_path` and `token`. Send `GET` or `HEAD` to `status_path`, with your own base address in front, and `Authorization: Bearer <token>`.',
    );
    claim(TRIGGER, `${ACCEPTED}\nLocation: /refunds/runs/${RUN}\nRetry-After: 5`);
    claim(TRIGGER, `200 {"run_id":"${RUN}","run_phase":"running"}`);
    claim(TRIGGER, COMPLETED);
  });

  it('`result_map`: the reply table and the rules a caller lives by', () => {
    // G2 (each phase, and nothing more for a failed run), G3, G4 (the counts), G5 (40,000),
    // G6 (withheld, its two reasons), G7 (the version flag).
    claim(
      TRIGGER,
      "| `run_phase` | `running`, `gate_waiting`, `completed`, `failed`, `aborted` or `abandoned`: Realm's own words, and for a run that failed, nothing more. The phase is the record's, not whether an agent is working on it: a run whose agent stopped still reads `running`. |",
    );
    claim(
      TRIGGER,
      '| `result_masked` | How many values Realm hid in the result: declared secrets, environment values, and values under names that read as credentials. |',
    );
    claim(
      TRIGGER,
      "| `result_error` | In place of `result`. `too_large`: the declared values are longer than 40,000 characters; none is sent. `values_withheld`, with `because`: Realm could not tell which values are secret, after the project's `secrets:` changed or became unreadable; none is sent. `realm run inspect` shows the run. |",
    );
    claim(
      TRIGGER,
      '| `workflow_version_differs` | `true`: the workflow file changed after the run started; the result is still given. |',
    );
    // G8 (one run of one workflow), G10 (a secret change ends the code; a restart keeps it).
    claim(
      TRIGGER,
      "The token belongs to that run of that workflow and opens nothing else. It is worked out from the workflow's secret, so it stops working when the secret changes, and it sits wherever the caller logs the reply it came in: anyone who can read it can read that run's phase and declared values, and no more.",
    );
    // G9 (every refusal the same 403).
    claim(
      TRIGGER,
      'A wrong or missing token, a run that does not exist or was purged, and a run of another workflow all get the same `403` `{"error":"forbidden"}`.',
    );
    // G4 (declared, environment, `Bearer`, `token` whole and by path), the in-process G4.
    claim(
      TRIGGER,
      "Realm hides a value equal to one of the project's declared secrets, or to an environment value of 8 or more characters, wherever it appears in a result, even if it is not a secret; and it hides a text or a number kept under a name like `token` or `password` in the run's output, whichever way `result_map` reaches it.",
    );
    // L1 (the four modes refused).
    claim(
      TRIGGER,
      '`result_map` is refused for `hmac`, `stripe`, `github` and `none`: a sender who replays a captured signed request would be handed the token, and `none` has no secret to work it out from.',
    );
    // P2 (in the window, after it, purged).
    claim(
      TRIGGER,
      'A repeat of an event within `ttl_minutes` gets `200` `{"status":"deduplicated","run_id","run_phase"}`; if the run is gone, the bare `{"status":"deduplicated"}`. For a workflow with `result_map`, a repeat, inside the window or after it, also carries `status_path` and `token` again.',
    );
    // G9 (no header, `Basic`: the 403). That a proxy replaces the header is the proxy's doing: not
    // run here.
    claim(
      TRIGGER,
      'A proxy or gateway that sets or removes the `Authorization` header itself keeps the token from reaching `realm listen`: the read then gets the `403`.',
    );
  });

  it('Replies and the loader: the read request before the method check, the 202, the four refusals', () => {
    // G11 (no slot), G12 (only the read shape), G9 (the 403 without a valid code).
    claim(
      TRIGGER,
      'Also before the method check, a `GET` or `HEAD` whose path ends in `/runs/<run id>` is a read request (see [`result_map`](#result_map)): it is answered there, takes no signature and no `--max-concurrent` slot, and gets the one `403` unless it carries a valid code. Added after version 0.49.0.',
    );
    claim(
      TRIGGER,
      '| The method is `POST`, or the request is a read request, above (added after version 0.49.0) | `405` `{"error":"method_not_allowed"}` |',
    );
    // P2 (in the window: named; purged: bare).
    claim(
      TRIGGER,
      '| The event has not been seen within `ttl_minutes` | `200` with the run\'s `run_id` and `run_phase`, as in the row for a run with the event\'s ID below, or the bare `200` `{"status":"deduplicated"}` when that run is gone (changed after version 0.49.0) |',
    );
    // P1.
    claim(
      TRIGGER,
      'For a workflow with `result_map`, the `202` also carries `run_phase`, `status_path` and `token`, with the headers `Location: <status_path>` and `Retry-After: 5` (the example is under [`result_map`](#result_map)). Added after version 0.49.0.',
    );
    // L1, L2, L3 (each exactly as the loader prints it).
    claim(
      TRIGGER,
      "| `result_map` on a mode other than `shared_secret` (added after version 0.49.0) | `trigger.result_map is allowed only with auth.mode 'shared_secret'; this trigger uses 'hmac'. A caller reads a run with a code worked out from the shared secret, and only a request that carries the secret in a header is handed it: with a signed body the code would go to anyone who replays a captured signed request, and 'none' has no secret. Remove result_map, or use shared_secret.` |",
    );
    claim(
      TRIGGER,
      "| A `result_map` name that reads as a credential's (added after version 0.49.0) | `trigger.result_map: 'token' reads as a credential's name, so Realm may hide its value in the reply. Rename it.` |",
    );
    claim(
      TRIGGER,
      "| A `result_map` value that does not start with `context.resources.` and a step (added after version 0.49.0) | `trigger.result_map.approved: 'review.approved' must start with 'context.resources.' and a step of this workflow, as in context.resources.review.approved.` |",
    );
    claim(
      TRIGGER,
      "| A `result_map` step that is not this workflow's (added after version 0.49.0) | `trigger.result_map.approved: 'reveiw' is not a step of this workflow. Did you mean 'review'? Name a step of this workflow.` |",
    );
  });
});

describe('R1.1 — realm-listen.md', () => {
  it('"The read address" and what it does at startup', () => {
    // G1 (phase and values), G11 (no slot), G9 (one 403 on every path), G13 (503 and the line),
    // G14 (one second from memory); the "not logged" half: G13's lines hold only the failures.
    claim(
      LISTEN,
      '## The read address For a workflow with `result_map` (see [the webhook trigger](../workflow/webhook-trigger.md#result_map)), `GET` and `HEAD` of `<its path>/runs/<run id>` with `Authorization: Bearer <token>` answer the run\'s phase and, once the run has completed, the values the workflow declares; the `202` gives the path and the token. The read is answered before the method, address and capacity checks, as the health address is: it takes no `--max-concurrent` slot, keeps the connection, and is not logged. A refused read gets `403` `{"error":"forbidden"}`, the same on every path that ends in `/runs/<run id>`, whatever the reason. When the store cannot be read, or the values cannot be checked for secrets, the read gets `503` `{"error":"unavailable"}`, and `webhook: read failed` is logged at `error`. A run that is running or waiting for a person is answered from memory for one second after it was read, so a caller that asks many times a second reads the store once a second. This section was added after version 0.49.0.',
    );
    // S1 (the warning), R1 (the refusal).
    claim(
      LISTEN,
      'At startup, a workflow with `result_map` whose secret has fewer than 16 characters is warned about (see [Log lines](#log-lines)), and two such workflows whose paths differ only by a trailing slash stop `realm listen` from starting (see [Exit codes](#exit-codes)).',
    );
  });

  it('the 202, the in-window repeat, the two log lines and the start refusal', () => {
    // P1.
    claim(
      LISTEN,
      'It does not wait for the run. The reply for a workflow with `result_map` also carries `status_path` and `token` (see [The read address](#the-read-address); added after version 0.49.0).',
    );
    // P2 (no `params_differ` in the window; purged: bare).
    claim(
      LISTEN,
      'A repeat of an event inside the duplicate window gets the same reply without `params_differ`, and the bare `200` `{"status":"deduplicated"}` when its run is gone (changed after version 0.49.0: inside the window the reply was always the bare one).',
    );
    // G13 (the line, its fields).
    claim(
      LISTEN,
      '| `error` | `webhook: read failed {"path","run_id","error"}` | A read request could not be answered: the store could not be read, or the values could not be checked for secrets. Added after version 0.49.0. |',
    );
    // S1.
    claim(
      LISTEN,
      "| `warn` | `listen: the secret for workflow '<id>' has fewer than 16 characters; …` | At startup: a workflow with `result_map` has a short secret, so a read code made from it can be guessed offline. Added after version 0.49.0. |",
    );
    // R1 (the refusal as the CLI prints it, from the capture).
    claim(
      LISTEN,
      "| Two workflows with `result_map` have the same path but for a trailing slash (added after version 0.49.0) | `Error: listen: the read address '/refunds/runs/<run id>' is taken twice — workflow 'twin' conflicts with 'refunds'; give each workflow with a result_map its own trigger.path` |",
    );
    // R1.1 adds no flag: the count stays.
    claim(LISTEN, 'This page lists its argument and 15 flags (13 in version 0.49.0),');
  });
});

describe('R1.1 — the webhooks guide and the CHANGELOG', () => {
  it('webhooks.md: the repeat names its run; "Getting the result back"', () => {
    // P2 (in the window and after it; purged: bare).
    claim(
      GUIDE,
      "**The same event again** starts nothing. The reply names the run that event started and its phase: within the duplicate window (`ttl_minutes`, 60 minutes by default), later while that run exists (a sender's redelivery, for one), and when two copies of one delivery arrive together.",
    );
    claim(
      GUIDE,
      'Within the duplicate window, a run that is gone (purged) gets the bare `{"status":"deduplicated"}`; until version 0.49.0 every reply within the window was that bare one (changed after version 0.49.0).',
    );
    gone(GUIDE, 'Within the duplicate window (`ttl_minutes`, 60 minutes by default) the reply is:');
    // G1 (the 202, the read, the completed reply), L1 (shared_secret).
    claim(
      GUIDE,
      '### Getting the result back The caller can also read what happened to the run, and values the workflow chooses to hand back, when the workflow declares them in `result_map` under `trigger` (with `auth.mode: shared_secret`; see [`result_map`](../reference/workflow/webhook-trigger.md#result_map)).',
    );
    claim(GUIDE, ACCEPTED);
    claim(GUIDE, `-H 'Authorization: Bearer ${TOKEN}'`);
    claim(GUIDE, COMPLETED);
  });

  it('the CHANGELOG entries', () => {
    // G1, P1, P2 (Added); P2 and G12 (Changed).
    claimChangelog(
      "- **A caller of `realm listen` can read a finished run's declared result**: `result_map` in the `trigger:` block (`shared_secret` workflows only), `status_path` and `token` in the `202` and in a repeated event's reply, and `GET`/`HEAD` `<path>/runs/<run id>` with `Authorization: Bearer <token>`.",
    );
    claimChangelog(
      '- **A repeat of an event inside the duplicate window now names the run** (`run_id` and `run_phase`) instead of answering the bare `{"status":"deduplicated"}`; a `GET` or `HEAD` that ends in `/runs/<run id>` no longer gets `405`: it is a read request and answers `403` unless it carries a valid code.',
    );
  });
});
