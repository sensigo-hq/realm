// docs-callback-c3c1.test.ts — R1.3 callback C3c-1: the guide section "Receive a callback"
// (docs/guides/webhooks.md), the webhook trigger's callback row and reply sentence, the `Callback:`
// lines on realm-run-reading.md and the CHANGELOG bullet. Five cells:
//   1. every paragraph and table row the unit wrote, held to its page word for word (spaces folded,
//      as a table's padding moves), each with the cell or record that executes what it says;
//   2. the guide's own verify recipe (its `js` block, saved as verify.mjs) run against a REAL
//      callback made by C3a's pass over a store, a key and a loopback receiver;
//   3. the example blocks against the BUILT `realm listen` and `realm run inspect` (shapes, not random
//      values), and the guide's example callback checked with its own recipe and its own key;
//   4. "Realm does not use HTTP_PROXY or HTTPS_PROXY", through the built `realm listen`, with a control
//      that shows the same environment does send a plain `http.get` to the proxy;
//   5. the version marker of each addition, and every link into and out of the new section.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeStep, type CallbackView } from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { afterAll, describe, expect, it, onTestFinished } from 'vitest';
import { parseCallbackEntry } from '../lib/callback/allow-list.js';
import { makeCallbackPass } from '../lib/callback/delivery-pass.js';
import { callbackLine } from '../lib/callback/inspect-line.js';
import { deriveReadKey, type ReadEntry } from '../lib/run-read-address.js';
import {
  capturingLogger,
  emptySet,
  ENV,
  sharedSecretTrigger,
  workflow,
} from '../test-support/listen-read-r11.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const GUIDE = 'docs/guides/webhooks.md';
const TRIGGER = 'docs/reference/workflow/webhook-trigger.md';
const READING = 'docs/reference/cli/realm-run-reading.md';
const CHANGELOG = 'CHANGELOG.md';
const MARK = 'Added after version 0.50.0.';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (1) red when the page no longer holds the text word for word; (2) prints the text. */
function claim(page: string, text: string): void {
  expect(flat(read(page)), `${page} no longer says: ${text}`).toContain(flat(text));
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs)
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** The guide's section, from its heading to the next `## `. */
function section(): string {
  const text = read(GUIDE);
  const start = text.indexOf('### Receive a callback\n');
  if (start < 0) throw new Error(`${GUIDE} has no "### Receive a callback"`);
  return text.slice(start, text.indexOf('\n## ', start));
}
/** The fenced blocks of `text`, each with its language. */
function blocks(text: string): { lang: string; body: string }[] {
  return [...text.matchAll(/^```([a-z]*)\n([\s\S]*?)\n```$/gm)].map((m) => ({
    lang: m[1]!,
    body: m[2]!,
  }));
}
/** The section's one `text` block that starts with `head` (red, with the heads seen, when not one). */
function blockStarting(text: string, head: string | RegExp): string {
  const found = blocks(text).filter((b) =>
    typeof head === 'string' ? b.body.startsWith(head) : head.test(b.body),
  );
  if (found.length !== 1)
    throw new Error(`expected one block starting ${String(head)}, found ${found.length}`);
  return found[0]!.body;
}

/** The guide's example blocks, read from the page. */
function guideBlocks() {
  const s = section();
  const key = blockStarting(s, /^[0-9a-f]{64}\n/).split('\n')[0]!;
  const accepted = blockStarting(s, 'HTTP/1.1 202 ');
  const request = blockStarting(s, 'POST ');
  const [head, body] = request.split('\n\n') as [string, string];
  const headers: Record<string, string> = {};
  for (const line of head.split('\n').slice(1)) {
    const at = line.indexOf(': ');
    headers[line.slice(0, at).toLowerCase()] = line.slice(at + 2);
  }
  const reads = blocks(s)
    .filter((b) => b.lang === 'text' && b.body.startsWith('{"run_id"'))
    .map((b) => JSON.parse(b.body) as Record<string, unknown>);
  const lines = blockStarting(s, 'Callback: ').split('\n');
  const js = blocks(s).filter((b) => b.lang === 'js');
  if (js.length !== 1) throw new Error(`expected one js block, found ${js.length}`);
  return {
    key,
    accepted: JSON.parse(accepted.split('\n\n')[1]!) as Record<string, unknown>,
    acceptedStatus: accepted.split('\n')[0]!,
    headers,
    body,
    reads,
    lines,
    recipe: js[0]!.body,
  };
}

type Verify = (
  key: unknown,
  headers: Record<string, string | undefined>,
  body: string,
  now?: number,
) => boolean;
/** The guide's recipe, saved as verify.mjs, as the guide says, and imported. */
async function recipe(): Promise<Verify> {
  const dir = mkdtempSync(join(tmpdir(), 'realm-c3c1-verify-'));
  dirs.push(dir);
  const file = join(dir, 'verify.mjs');
  writeFileSync(file, `${guideBlocks().recipe}\n`);
  const mod = (await import(pathToFileURL(file).href)) as { verify: Verify };
  return mod.verify;
}

/** A value's shape: its keys, nested, and the type of each leaf. */
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, shapeOf((value as Record<string, unknown>)[k])]),
    );
  }
  return value === null ? 'null' : typeof value;
}
const SPAN = String.raw`\d+[smhd](?: \d+[smhd])?`;
const INSTANT = String.raw`\(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\)`;
/** An inspect line's form: its instants, durations, hosts and numbers as placeholders. */
const lineShape = (line: string): string =>
  line
    .replace(new RegExp(`${SPAN} ago ${INSTANT}`, 'g'), '<ago>')
    .replace(new RegExp(`in ${SPAN} ${INSTANT}`, 'g'), '<in>')
    .replace(/127\.0\.0\.1:\d+/g, '<host>')
    .replace(/\d+/g, '<n>');

interface Post {
  readonly path: string;
  readonly names: string[];
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}
type Answer = { status: number; headers?: Record<string, string> };
/** A loopback receiver answering `answer(path)`; every request kept as it arrived; closed after the cell. */
async function receiver(answer: (path: string) => Answer = () => ({ status: 200 })) {
  const posts: Post[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      posts.push({
        path: req.url ?? '',
        names: req.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()),
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const a = answer(req.url ?? '');
      res.writeHead(a.status, a.headers ?? {});
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  onTestFinished(
    () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  return { port: (server.address() as AddressInfo).port, posts };
}

/** Waits, on the real clock, until `cond` holds; the message names what never happened. */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const by = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > by) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** One HTTP request to 127.0.0.1:`port`: its status, headers and body. */
function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((ok, fail) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          ok({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

const REFUNDS = `id: refunds
name: Refunds
version: 1

trigger:
  type: webhook
  path: /refunds
  auth:
    mode: shared_secret
    header: X-Webhook-Token
    secret_from: WH_SECRET
  dedup:
    id_from: body.event_id
  params_map:
    approved: body.approved
    note: body.note
  result_map:
    approved: context.resources.review.approved
    note: context.resources.review.note
steps:
  review:
    description: Record the decision.
    execution: auto
`;
const SECRET = 'c3c1-secret-0123456789';
const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** A scratch home with the guide's refunds workflow, and the built CLI on it. */
function bench() {
  const root = mkdtempSync(join(tmpdir(), 'realm-c3c1-'));
  dirs.push(root);
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, 'refunds'));
  writeFileSync(join(root, 'refunds', 'workflow.yaml'), REFUNDS);
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    NO_COLOR: '1',
    REALM_NO_NUDGE: '1',
    WH_SECRET: SECRET,
    ANTHROPIC_API_KEY: 'sk-ant-c3c1-not-a-key',
    REALM_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  };
  /** A built-CLI command run to its end. */
  const realm = (args: readonly string[]) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
  /** `realm callback key ./refunds --host <host>`: the key it printed. */
  const key = (host: string): string => {
    const r = realm(['callback', 'key', './refunds', '--host', host]);
    if (r.status !== 0) throw new Error(`callback key failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  /** The `Callback:` line of the built `realm run inspect <id>`. */
  const inspectLine = (runId: string): string | undefined =>
    realm(['run', 'inspect', runId])
      .stdout.split('\n')
      .find((l) => l.startsWith('Callback:'));
  /** The built `realm listen ./refunds --port 0 … <args>`, both streams merged, up once it says so. */
  const listen = (args: readonly string[], extra: Record<string, string> = {}) =>
    new Promise<{ port: number; stop: () => Promise<void>; text: () => string }>((ok, fail) => {
      const command = `exec ${shq(process.execPath)} ${shq(CLI)} listen ./refunds --port 0 --provider anthropic --model m ${args.map(shq).join(' ')} 2>&1`;
      const child = spawn('sh', ['-c', command], { cwd: root, env: { ...env, ...extra } });
      let text = '';
      let up = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      const exited = new Promise<void>((r) => child.on('exit', () => r()));
      child.on('exit', () => {
        clearTimeout(timer);
        if (!up) fail(new Error(`realm listen exited before it was up:\n${text}`));
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        text += d;
        const m = /realm listen on 127\.0\.0\.1:(\d+)/.exec(text);
        if (m !== null && !up) {
          up = true;
          ok({
            port: Number(m[1]),
            stop: () => {
              child.kill('SIGTERM');
              return exited;
            },
            text: () => text,
          });
        }
      });
    });
  return { root, env, realm, key, inspectLine, listen };
}
const start = (url: string, event: string, extra: Record<string, string> = {}) => ({
  headers: {
    'content-type': 'application/json',
    'x-webhook-token': SECRET,
    'realm-callback-url': url,
    ...extra,
  },
  body: JSON.stringify({ event_id: event, approved: true, note: 'refund to the original card' }),
});

describe('C3c-1 — cell 1: the words, each held to its page', () => {
  it('1. A caller that would rather not hold a connection open, or ask again, c', () => {
    // Pinned by: cell 3 (a real `realm listen` sends the run's result to the address, signed; the guide's recipe checks it); n8n: LANE-WEB-C1 Q4/Q6 (read, not run).
    claim(
      GUIDE,
      "A caller that would rather not hold a connection open, or ask again, can give `realm listen` an address. When the run ends, `realm listen` sends the run's result there, signed so that the receiver can check who sent it. n8n's Wait node is the usual case: a flow starts the run, waits at its resume address, and carries on when the result arrives. Added after version 0.50.0.",
    );
  });
  it('2. Four things make it work.', () => {
    // Pinned by: nothing to execute: it counts the four parts below.
    claim(GUIDE, 'Four things make it work.');
  });
  it('3. 1. The workflow takes callbacks. Its trigger has a result_map and auth', () => {
    // Pinned by: listen-callback-c2.test and door-words-c2.test (callback_not_enabled); CB-C3C1-AU (executed on the build). The example workflow: CB-C3C1-RV-13 (the result_map page's workflow, with `id`, `name` and `version: 1` added, validates and runs; `WH_SECRET` is needed); cell 5 (the link).
    claim(
      GUIDE,
      '**1. The workflow takes callbacks.** Its `trigger` has a `result_map` and `auth.mode: shared_secret`, as in [Getting the result back](#getting-the-result-back). The examples use the `refunds` workflow of that page: save the workflow of [`result_map`](../reference/workflow/webhook-trigger.md#result_map) (add `id: refunds`, a `name` and `version: 1` above its `trigger:`) as `refunds/workflow.yaml`, and set `WH_SECRET=choose-a-long-secret` in the environment of `realm listen`: it is the variable that workflow\'s `secret_from` names. A request that names a callback address to a workflow without them is answered `400` `{"error":"callback_not_enabled"}`.',
    );
  });
  it('4. 2. The receiver has a key. realm callback key ./refunds --host n8n.exa', () => {
    // Pinned by: cell 3 (the built `realm callback key` prints 64 hexadecimal characters); the example run (plans/r1-result-back/c3c1-ia2/examples, registry CB-C3C1-IA-01).
    claim(
      GUIDE,
      '**2. The receiver has a key.** `realm callback key ./refunds --host n8n.example.com` prints the key for this workflow and this receiver: 64 hexadecimal characters. The example on this page has its receiver on this machine, at `127.0.0.1:5678`, and its key is a scratch one that protects nothing:',
    );
  });
  it("5. Give it to the receiver, which checks every callback's signature with", () => {
    // Pinned by: cell 2 (a receiver checks the signature with that key, as text); cell 5 (the link).
    claim(
      GUIDE,
      "Give it to the receiver, which checks every callback's signature with it. Realm keeps the key sealed in its database; [`realm callback`](../reference/cli/realm-callback.md) says how to change it, and where the master key that seals it comes from.",
    );
  });
  it('6. The example was made with REALM_ENCRYPTION_KEY set. In a fresh home wi', () => {
    // Pinned by: CB-C3C1-RV-14 (in a fresh home without it, the built `realm callback key` makes `encryption.key` and prints the keep-a-copy line); the example run (REALM_ENCRYPTION_KEY set, CB-C3C1-IA-01).
    claim(
      GUIDE,
      'The example was made with `REALM_ENCRYPTION_KEY` set. In a fresh home without it, `realm callback key` also makes the master key file `encryption.key` and prints a line telling you to keep a copy of it somewhere safe, because `realm db backup` does not copy it.',
    );
  });
  it('7. 3. realm listen is told which receivers it may call. --callback-allow', () => {
    // Pinned by: allow-list.test (an entry with http:// allows http and https; one without, https only); listen-switch-c2c (no flag: every address refused callback_not_enabled); the example run (--callback-allow-private http://127.0.0.1:5678); cell 5 (the link). cell 5 (the link to 2. Start the server).
    claim(
      GUIDE,
      "**3. `realm listen` is told which receivers it may call.** `--callback-allow n8n.example.com` for a receiver on a public address, `--callback-allow-private http://n8n.lan:5678` for one on this machine or your own network (an entry written with `http://` allows plain `http` as well as `https`; one without it allows `https` only). Without either flag every callback address is refused. See [`realm listen`](../reference/cli/realm-listen.md#--callback-allow). The example's receiver is on plain `http` on this machine, so its `realm listen` was started as in [2. Start the server](#2-start-the-server), with the flag added: `--callback-allow-private http://127.0.0.1:5678`.",
    );
  });
  it('8. 4. The request names the address, in the header realm-callback-url of', () => {
    // Pinned by: cell 3 (the header, on the built `realm listen`).
    claim(
      GUIDE,
      '**4. The request names the address,** in the header `realm-callback-url` of the request that starts the run:',
    );
  });
  it('9. The 202 says the address was taken:', () => {
    // Pinned by: cell 3 (the `202` carries "callback":"registered").
    claim(GUIDE, 'The `202` says the address was taken:');
  });
  it('10. When the run ends, realm listen sends one POST to the address: a momen', () => {
    // Pinned by: listen-callback-c3b2.test (the pass woken when an agent it started exits, and every 30 s); CB-C3B2-RV-01/-02; cell 3. The pass and its two wake-ups: listen-callback-c3b2.test.
    claim(
      GUIDE,
      'When the run ends, `realm listen` sends one `POST` to the address: a moment after the agent that was driving the run exits, and otherwise within 30 seconds: `realm listen` looks for callbacks that are due, a pass, when an agent it started exits and every 30 seconds. The body is JSON:',
    );
  });
  it("11. timestamp is when the run ended. data holds what a GET of the run's st", () => {
    // Pinned by: cell 3 (the body's keys: a GET's without `callback`, plus `status_path`; no token); the example run (`timestamp` = the run's `Updated:`, CB-C3C1-IA-02); CB-C3C1-AU (a failed, aborted or abandoned run's body).
    claim(
      GUIDE,
      "`timestamp` is when the run ended. `data` holds what a `GET` of the run's `status_path` answers, without its `callback` member (the run's id and phase and, once it has completed, `result`, `result_masked` or `result_error`: see [Getting the result back](#getting-the-result-back)), and `status_path`. A run that failed, was aborted or was abandoned sends its id, its phase and `status_path` only. The read token is never sent.",
    );
  });
  it('12. Header What it holds', () => {
    // Pinned by: cell 3 (the header names, on the built `realm listen`).
    claim(GUIDE, '| Header | What it holds |');
  });
  it('13. webhook-id An id for this callback, the same on every try', () => {
    // Pinned by: cell 3 (the name); CB-C3A-RV-02 and CB-C3B2-RV-08 (the same id on every try).
    claim(GUIDE, '| `webhook-id` | An id for this callback, the same on every try |');
  });
  it('14. webhook-timestamp When this try was sent, in whole seconds since 1 Jan', () => {
    // Pinned by: cell 3 (the name); CB-C3A-RV-02 (seconds since the epoch, a new one each try).
    claim(
      GUIDE,
      '| `webhook-timestamp` | When this try was sent, in whole seconds since 1 January 1970 (UTC) |',
    );
  });
  it('15. webhook-signature v1, and the signature below; while the key that was', () => {
    // Pinned by: cell 2 (two tokens during an overlap, the current first; both keys verify); CB-C3A-RV-04.
    claim(
      GUIDE,
      "| `webhook-signature` | `v1,` and the signature below; while the key that was replaced is still kept (see [`realm callback`](../reference/cli/realm-callback.md)), two of them, separated by a space, the current key's first |",
    );
  });
  it('16. content-type application/json', () => {
    // Pinned by: cell 3 (the name and its value).
    claim(GUIDE, '| `content-type` | `application/json` |');
  });
  it('17. user-agent realm/ and the version', () => {
    // Pinned by: cell 3 (the name); delivery-pass-sqlite-c3a.test (`realm/` and VERSION).
    claim(GUIDE, '| `user-agent` | `realm/` and the version |');
  });
  it("18. realm-run-id The run's id", () => {
    // Pinned by: cell 3 (the name and the run id).
    claim(GUIDE, "| `realm-run-id` | The run's id |");
  });
  it('19. The first three are those of the Standard Webhooks specification, so a', () => {
    // Pinned by: CB-C3A-RV-03 and CB-C3B2-RV-01 (standardwebhooks verifies with whsec_ and the base64 of the text; not under the decoded bytes); cell 2 (the 32 decoded bytes do not verify).
    claim(
      GUIDE,
      'The first three are those of the [Standard Webhooks](https://www.standardwebhooks.com/) specification, so a library for it can check them: `realm callback key ./refunds --host n8n.example.com --whsec` prints the key in the `whsec_` form such libraries take. The signature is `v1,` and the base64 of the HMAC-SHA-256 of `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the key as it was printed: its 64 characters as text, not decoded.',
    );
  });
  it('20. Check the signature of the body exactly as it arrived, before it is pa', () => {
    // Pinned by: cell 2 (the guide's own `js` block, saved as verify.mjs and run against a real callback).
    claim(
      GUIDE,
      'Check the signature of the body exactly as it arrived, before it is parsed. In Node, save this as `verify.mjs`, since it uses `import`:',
    );
  });
  it('21. Check every token in webhook-signature, and reject a request whose tim', () => {
    // Pinned by: cell 2 (every token: the previous key verifies; a timestamp six minutes old is refused).
    claim(
      GUIDE,
      'Check every token in `webhook-signature`, and reject a request whose timestamp is more than five minutes from your clock.',
    );
  });
  it('22. A 2xx answer ends the callback: it is delivered. A 410 ends it too: th', () => {
    // Pinned by: CB-C3A-RV-07/-08/-09 and retry-wait-c3a.test (what ends a callback, the schedule, Retry-After up to 1 h); CB-C3B2-RV-08 (served at the next pass); CB-C3C1-AU (a 409 tried again at 26.8 s with the same id and bytes; a hang ends at 10.1 s; a 301 not followed; Retry-After 120 and 99999; given up 1 h after the first try); the example run (503 with Retry-After: 120: next try 2 min later).
    claim(
      GUIDE,
      'A `2xx` answer ends the callback: it is delivered. A `410` ends it too: the receiver has said to stop. Any other answer (a redirect is one: Realm does not follow it), no answer within 10 seconds, or no connection, is tried again, with the same body and the same `webhook-id` and a new timestamp and signature. The wait before a try is 1 second after the first failure and doubles each time up to 1 hour, with 20 % either way; a `Retry-After` of whole seconds raises it, to at most 1 hour. A wait is served at the next pass, so a retry can come up to 30 seconds after its wait has ended. It is given up 1 hour after the first try when the last answer was a `4xx` other than `408`, `425` and `429`, and otherwise 3 days after the run ended.',
    );
  });
  it('23. A callback waits while no realm listen runs that has --callback-allow', () => {
    // Pinned by: CB-C3C1-AU (no flag after a restart: it waits; a flag with another entry: failed, not_allowed, at the next try); CB-C3A-RV-07; CB-C3B2-RV-06 (a try cut by the stop: exit 0, made again after the restart with the same id); the example run (due while `realm listen` was stopped, tried after its restart). The cut try about a minute later: CB-C3C1-RV-08, CB-C3C1-AU-14 (62 to 73 s after the restart).
    claim(
      GUIDE,
      'A callback waits while no `realm listen` runs that has `--callback-allow` or `--callback-allow-private`, the workflow and a key it can read. A `realm listen` that has a flag but no entry for the receiver ends the callback at its next try and does not send it: the entry is checked again at every try. If `realm listen` is stopped while a try is in flight and the grace (`--shutdown-grace`) ends first, the exit code is still 0 and the try is made again after the next start (about a minute later: the cut try holds the callback that long), with the same `webhook-id`: ignore an id you have already handled.',
    );
  });
  it('24. Realm connects only to an address it has checked: a host name on --cal', () => {
    // Pinned by: CB-C3A-RV-11; CB-C3C1-AU (localhost on --callback-allow: refused_address, tried again; a self-signed certificate: connection, also with NODE_TLS_REJECT_UNAUTHORIZED=0); cell 4 (the proxy variables, through the built `realm listen`, with a control).
    claim(
      GUIDE,
      "Realm connects only to an address it has checked: a host name on `--callback-allow` whose address is private, local or shared is not called (the try fails and is made again later), and the receiver's certificate is always checked. Realm does not use `HTTP_PROXY` or `HTTPS_PROXY` for callbacks.",
    );
  });
  it('25. The reply Why', () => {
    // Pinned by: the table of the words below.
    claim(GUIDE, '| The reply | Why |');
  });
  it('26. 400 {"error":"callback_not_enabled"} The workflow has no result_map wi', () => {
    // Pinned by: listen-callback-c2.test and door-words-c2.test (callback_not_enabled, both causes); CB-C3C1-AU.
    claim(
      GUIDE,
      '| `400` `{"error":"callback_not_enabled"}` | The workflow has no `result_map` with `shared_secret`, or `realm listen` was started with neither flag |',
    );
  });
  it('27. 400 {"error":"callback_refused","reason":"malformed"} The header is em', () => {
    // Pinned by: door-words-c2.test (the malformed inputs); CB-C3C1-AU (empty, repeated, a space or #, no host, port 0; executed).
    claim(
      GUIDE,
      '| `400` `{"error":"callback_refused","reason":"malformed"}` | The header is empty, repeated, or not an address (it has a space or `#`, no host, or port 0) |',
    );
  });
  it('28. …"reason":"too_long" The address is longer than 2,048 characters', () => {
    // Pinned by: door-words-c2.test; CB-C3C1-AU (2,049 characters refused); allow-list.ts CALLBACK_URL_MAX_LENGTH.
    claim(GUIDE, '| `…"reason":"too_long"` | The address is longer than 2,048 characters |');
  });
  it('29. …"reason":"scheme" The scheme is not http or https, or it is http:// t', () => {
    // Pinned by: door-words-c2.test; CB-C3C1-AU (http:// to a host and port listed without it: scheme; to another port: not_allowed).
    claim(
      GUIDE,
      '| `…"reason":"scheme"` | The scheme is not `http` or `https`, or it is `http://` to a host and port that are listed without `http://` |',
    );
  });
  it('30. …"reason":"userinfo" The address holds a user name or a password', () => {
    // Pinned by: door-words-c2.test (userinfo).
    claim(GUIDE, '| `…"reason":"userinfo"` | The address holds a user name or a password |');
  });
  it('31. …"reason":"not_allowed" No entry of --callback-allow or --callback-all', () => {
    // Pinned by: door-words-c2.test and allow-list.test (not_allowed).
    claim(
      GUIDE,
      '| `…"reason":"not_allowed"` | No entry of `--callback-allow` or `--callback-allow-private` has the address\'s host and port |',
    );
  });
  it('32. …"reason":"no_key" There is no key Realm can read for this workflow an', () => {
    // Pinned by: door-words-c2.test (no_key); listen-switch-c2c (realm listen's start line names the command).
    claim(
      GUIDE,
      '| `…"reason":"no_key"` | There is no key Realm can read for this workflow and this host: `realm listen` says which command makes one |',
    );
  });
  it('33. 503 {"error":"callback_backlog"} 1,000 callbacks are waiting to be sen', () => {
    // Pinned by: listen-callback-c3b1.test (the cap, both sides); CB-C3B1-RV-02/-03.
    claim(
      GUIDE,
      '| `503` `{"error":"callback_backlog"}` | 1,000 callbacks are waiting to be sent |',
    );
  });
  it('34. A request is refused before a run is made. A repeat of an event inside', () => {
    // Pinned by: CB-C2-RV-* (the duplicate words); CB-C3C1-AU (inside the window and after it, executed). cell 5 (the link to dedup).
    claim(
      GUIDE,
      'A request is refused before a run is made. A repeat of an event inside the [duplicate window](../reference/workflow/webhook-trigger.md#dedup) is answered before this check, `200` `deduplicated`; when that repeat also names an address, the reply carries `"callback":"ignored_duplicate"` if the first request registered one and `"callback":"none"` if not (a repeat that names none has no `callback`). After the window the check comes first, and a refused address gets its refusal.',
    );
  });
  it('35. realm run inspect <run id> has a Callback: line:', () => {
    // Pinned by: cell 3 (the lines of the built `realm run inspect`; every form).
    claim(GUIDE, '`realm run inspect <run id>` has a `Callback:` line:');
  });
  it('36. pending means the next try is still to come; due means a try is due no', () => {
    // Pinned by: CB-C3C1-RV-11 (the due line is the same whichever of the four is missing); inspect-line-c3b1.test (pending and due); cell 1b (the same words about due on both pages).
    claim(
      GUIDE,
      '`pending` means the next try is still to come; `due` means a try is due now and waits for the next pass of a `realm listen` that can send it: one with `--callback-allow` or `--callback-allow-private`, the workflow, a key it can read and an entry for the receiver.',
    );
  });
  it("37. A GET of the run's status_path carries callback once the run is no lon", () => {
    // Pinned by: cell 3 (the GET's `callback` members, on the built `realm listen`); CB-C3B1-RV-07/-08/-10; listen-callback-c3b1.test.
    claim(
      GUIDE,
      "A `GET` of the run's `status_path` carries `callback` once the run is no longer running or waiting at a question: `state` (`pending`, `delivered` or `failed`), `attempts` and, when they apply, `last_status` (an HTTP status, or `timeout`, `connection`, `redirect`, `refused_address`, `not_allowed` or `expired`) and `next_try`. After the example's callback was delivered:",
    );
  });
  it('38. The same read of a run whose receiver had answered 503 with Retry-Afte', () => {
    // Pinned by: cell 3 (a 503 with Retry-After: 120, on the built `realm listen`).
    claim(
      GUIDE,
      'The same read of a run whose receiver had answered `503` with `Retry-After: 120`:',
    );
  });
  it('39. next_try can be in the past: the callback is due and waits for the nex', () => {
    // Pinned by: inspect-line-c3b1.test (the due form); CB-C3B1-RV-14.
    claim(GUIDE, '`next_try` can be in the past: the callback is due and waits for the next pass.');
  });
  it("40. This part is read from n8n's documentation and source (version 2.47.7)", () => {
    // Pinned by: LANE-WEB-C1 Q4 and Q6 (n8n's documentation and source read 2026-11-16, version 2.47.7); nothing was run in n8n.
    claim(
      GUIDE,
      "This part is read from n8n's documentation and source (version 2.47.7); we did not run n8n for it. A flow that starts a run and waits for its callback has an **HTTP Request** node that posts to `realm listen` with the header `realm-callback-url` set to `{{ $execution.resumeUrl }}`, followed in the same execution by a **Wait** node with Resume `On Webhook Call` and HTTP Method `POST` (its default is `GET`). n8n's Wait node is read, from its source, to answer `409` (or `404`) until the flow has reached it; Realm tries a `4xx` again for an hour, so a run that ends before the flow gets there can still be delivered. Checking the signature in n8n is not settled by its documentation: the Crypto node takes its secret as text, as Realm's key is, but we could not confirm how to give it the body exactly as received. Until you have a way that works, check it in a **Code** node: the function above with `require('crypto')` in place of its `import` and no `export`. It needs the body exactly as received, and we do not know how the Wait node hands that over. On self-hosted n8n the Code node needs `NODE_FUNCTION_ALLOW_BUILTIN=crypto` set on its task runner (`crypto` and `node:crypto` are separate entries), and n8n Cloud has `crypto`.",
    );
  });
  it('41. A callback address, if the request names one (the header realm-callbac', () => {
    // Pinned by: listen-callback-c2.test (the check and its replies); CB-C3C1-AU (the row's place in the order); cell 5 (the link).
    claim(
      TRIGGER,
      '| A callback address, if the request names one (the header `realm-callback-url`), is accepted | `400` `{"error":"callback_not_enabled"}`, `400` `{"error":"callback_refused","reason":"<word>"}` or `503` `{"error":"callback_backlog"}`. The words and what each means are in [Receive a callback](../../guides/webhooks.md#what-a-refused-request-says). Added after version 0.50.0. |',
    );
  });
  it('42. For a workflow with result_map, the 202 also carries run_phase, status', () => {
    // Pinned by: cell 3 (the `202` carries "callback":"registered").
    claim(
      TRIGGER,
      'For a workflow with `result_map`, the `202` also carries `run_phase`, `status_path` and `token`, with the headers `Location: <status_path>` and `Retry-After: 5` (the example is under [`result_map`](#result_map)). Added after version 0.49.0. A request that named an accepted callback address also gets `"callback":"registered"`. Added after version 0.50.0.',
    );
  });
  it('43. After those two lines, or where they would be, a run whose request nam', () => {
    // Pinned by: inspect.ts (the line is pushed after the Reminders and Escalation lines: read from the code); cell 3 (the forms).
    claim(
      READING,
      'After those two lines, or where they would be, a run whose request named a callback address has one `Callback:` line, which says how its callback stands (added after version 0.50.0). One line per state:',
    );
  });
  it('44. A callback that was sent shows its host and when. For one that is wait', () => {
    // Pinned by: cell 3 (the forms, from the built `realm run inspect` and `callbackLine`). CB-C3C1-RV-11; cell 1b (the same words about due on both pages).
    claim(
      READING,
      'A callback that was sent shows its host and when. For one that is waiting, `pending` means the next try is still to come, and `due` means a try is due now and waits for the next pass of a `realm listen` that can send it (one with `--callback-allow` or `--callback-allow-private`, the workflow, a key it can read and an entry for the receiver); `waiting for the run to finish` means the run has not ended.',
    );
  });
  it("45. - realm listen sends a run's result to the callback address a request", () => {
    // Pinned by: cell 3 (the headers and the body's type, on the built `realm listen`); CB-C3A-RV-07/-08 (3 days; 1 hour after the first try for a 4xx but 408, 425, 429); CB-C3C1-AU (expired with the first try set 2 h back). The inspect line: cell 3.
    claim(
      CHANGELOG,
      '- **`realm listen` sends a run\'s result to the callback address a request named.** The `POST` carries `webhook-id`, `webhook-timestamp` and `webhook-signature` (Standard Webhooks, `v1`), the body `{"type":"run.finished",…}`; a receiver that answers with anything but `2xx` or `410` is tried again for up to 3 days (1 hour after the first try when its last answer was a `4xx` other than `408`, `425` or `429`). See [Receive a callback](docs/guides/webhooks.md#receive-a-callback). `realm run inspect` shows how a run\'s callback stands on a `Callback:` line.',
    );
  });
});

describe('C3c-1 — cell 1b: the two pages say the same about a callback that is due', () => {
  it('1b. the guide and realm-run-reading.md give due the same meaning and the same four things a realm listen needs to send it', () => {
    const due =
      '`due` means a try is due now and waits for the next pass of a `realm listen` that can send it';
    const needs =
      'one with `--callback-allow` or `--callback-allow-private`, the workflow, a key it can read and an entry for the receiver';
    // Pinned by: CB-C3C1-RV-11 (the due line is the same whichever of the four is missing).
    // (1) red when either page words due, or what a realm listen needs to send it, differently;
    //     (2) prints which page holds which.
    expect({
      guide: [flat(section()).includes(due), flat(section()).includes(needs)],
      reading: [flat(read(READING)).includes(due), flat(read(READING)).includes(needs)],
    }).toEqual({ guide: [true, true], reading: [true, true] });
  });
});

// ---------------------------------------------------------------------------------------------
// Cell 2: the guide's recipe against a real callback.
// ---------------------------------------------------------------------------------------------

const W = 'refunds';
const KEY_A = '1a'.repeat(32);
const KEY_B = '2b'.repeat(32);
const live = (): boolean => true;

/** C3a's pass over an in-memory store (the contract suite's), the workflow mounted, a receiver. */
async function world() {
  const store = new InMemoryStore({ clock: settableClock('2026-11-20T12:00:00.000Z') });
  const callbacks = store.callbacks!;
  const definition = workflow(
    W,
    sharedSecretTrigger('/refunds', { approved: 'context.resources.review.approved' }),
  );
  const mounted: ReadEntry = {
    path: '/refunds',
    definition,
    readKey: await deriveReadKey(ENV['READ_SECRET']!, W),
  };
  const r = await receiver();
  const host = `127.0.0.1:${r.port}`;
  const entry = parseCallbackEntry(`http://${host}`);
  if (!entry.ok) throw new Error(`fixture: ${host} refused ${entry.word}`);
  const pass = makeCallbackPass({
    callbacks,
    getRun: async (id) => {
      try {
        return (await store.get(id)).record;
      } catch {
        return undefined;
      }
    },
    entryOf: (id) => (id === W ? mounted : undefined),
    disclosureProvider: async () => emptySet(),
    lists: { public: [], private: [entry.entry] },
    ownPort: 1,
    logger: capturingLogger(),
    random: () => 0.5,
  });
  /** A completed run with a callback to the receiver, then one pass: the POST it sent. */
  const delivered = async (): Promise<Post> => {
    const { record } = await store.create({
      workflowId: W,
      workflowVersion: 1,
      params: {},
      callback: { url: `http://${host}/cb`, host, webhook_id: randomUUID() },
    });
    await executeStep(store, definition, {
      runId: record.id,
      command: 'review',
      input: { approved: true },
      dispatcher: async (_c, input) => input,
    });
    const before = r.posts.length;
    await pass(live);
    if (r.posts.length !== before + 1) throw new Error('fixture: the pass sent nothing');
    return r.posts[before]!;
  };
  return { callbacks, host, delivered };
}

describe('C3c-1 — cell 2: the recipe, executed', { timeout: 60_000 }, () => {
  it("2. the guide's verify.mjs: true on a real callback; false on each tampered input; both keys during an overlap", async () => {
    const verify = await recipe();
    const w = await world();
    await w.callbacks.keys.make(W, w.host, KEY_A);
    const post = await w.delivered();
    const h = post.headers as Record<string, string>;
    const ts = Number(h['webhook-timestamp']);
    const wrong = (patch: Record<string, string | undefined>) => ({ ...h, ...patch });
    const results = {
      real: verify(KEY_A, h, post.body, ts),
      exactlyFiveMinutes: verify(KEY_A, h, post.body, ts + 300),
      oneByteChanged: verify(KEY_A, h, `${post.body.slice(0, -1)}]`, ts),
      wrongKey: verify(KEY_B, h, post.body, ts),
      decodedBytes: verify(Buffer.from(KEY_A, 'hex'), h, post.body, ts),
      sixMinutesOld: verify(KEY_A, h, post.body, ts + 360),
      noId: verify(KEY_A, wrong({ 'webhook-id': undefined }), post.body, ts),
      noTimestamp: verify(KEY_A, wrong({ 'webhook-timestamp': undefined }), post.body, ts),
      noSignature: verify(KEY_A, wrong({ 'webhook-signature': undefined }), post.body, ts),
      notANumber: verify(KEY_A, wrong({ 'webhook-timestamp': 'soon' }), post.body, ts),
      shortToken: ((): boolean | string => {
        try {
          return verify(KEY_A, wrong({ 'webhook-signature': 'v1,AAAA' }), post.body, ts);
        } catch (err) {
          return `threw ${(err as { code?: string }).code ?? String(err)}`;
        }
      })(),
    };
    await w.callbacks.keys.rotate(W, w.host, { candidate: KEY_B, keepSeconds: 3600 });
    const overlap = await w.delivered();
    const o = overlap.headers as Record<string, string>;
    const ots = Number(o['webhook-timestamp']);
    // (1) red when the recipe decodes the key (real and the overlap turn false, decodedBytes true),
    //     drops timingSafeEqual's length check (shortToken throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH),
    //     loosens the five-minute window or the header checks, or looks at the first token only
    //     (previous turns false); (2) prints every input's answer.
    expect({
      ...results,
      tokens: String(o['webhook-signature']).split(' ').length,
      current: verify(KEY_B, o, overlap.body, ots),
      previous: verify(KEY_A, o, overlap.body, ots),
    }).toEqual({
      real: true,
      exactlyFiveMinutes: true,
      oneByteChanged: false,
      wrongKey: false,
      decodedBytes: false,
      sixMinutesOld: false,
      noId: false,
      noTimestamp: false,
      noSignature: false,
      notANumber: false,
      shortToken: false,
      tokens: 2,
      current: true,
      previous: true,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Cell 3: the example blocks against the built realm listen and realm run inspect.
// ---------------------------------------------------------------------------------------------

describe('C3c-1 — cell 3: the blocks are real', { timeout: 180_000 }, () => {
  it("3. the 202, the callback, the reads and the inspect lines have the built program's shapes; the guide's callback verifies with its own key", async () => {
    const g = guideBlocks();
    const verify = await recipe();
    const b = bench();
    const r = await receiver((path) =>
      path === '/busy' ? { status: 503, headers: { 'Retry-After': '120' } } : { status: 200 },
    );
    const host = `127.0.0.1:${r.port}`;
    const key = b.key(host);
    const l = await b.listen(['--callback-allow-private', `http://${host}`]);
    const token = (j: Record<string, unknown>) => ({
      authorization: `Bearer ${String(j['token'])}`,
    });
    const readRun = async (j: Record<string, unknown>) =>
      JSON.parse((await call(l.port, 'GET', String(j['status_path']), token(j))).body) as Record<
        string,
        Record<string, unknown>
      >;
    let s1: Awaited<ReturnType<typeof call>>;
    let j1: Record<string, unknown>;
    let j2: Record<string, unknown>;
    let g1: Record<string, Record<string, unknown>> = {};
    let g2: Record<string, Record<string, unknown>> = {};
    let held: Awaited<ReturnType<typeof call>>;
    let heldRead: Record<string, unknown>;
    let lines: (string | undefined)[];
    try {
      const a = start(`http://${host}/ok`, 'evt-1');
      s1 = await call(l.port, 'POST', '/refunds', a.headers, a.body);
      j1 = JSON.parse(s1.body) as Record<string, unknown>;
      await until(
        async () => (g1 = await readRun(j1))['callback']?.['state'] === 'delivered',
        'the delivered callback',
      );
      const c = start(`http://${host}/busy`, 'evt-2');
      j2 = JSON.parse((await call(l.port, 'POST', '/refunds', c.headers, c.body)).body) as Record<
        string,
        unknown
      >;
      await until(
        async () => (g2 = await readRun(j2))['callback']?.['last_status'] === 503,
        'the 503',
      );
      const w = start(`http://${host}/held`, 'evt-3', { prefer: 'wait=20' });
      held = await call(l.port, 'POST', '/refunds', w.headers, w.body);
      // The wait's 200 carries no status_path or token; a repeat of the event hands them out again.
      const repeat = await call(
        l.port,
        'POST',
        '/refunds',
        { 'content-type': 'application/json', 'x-webhook-token': SECRET },
        w.body,
      );
      heldRead = await readRun(JSON.parse(repeat.body) as Record<string, unknown>);
      lines = [b.inspectLine(String(j1['run_id'])), b.inspectLine(String(j2['run_id']))];
    } finally {
      await l.stop();
    }
    const real = r.posts.find((p) => p.path === '/ok')!;
    const at = new Date('2026-11-22T12:00:00.000Z');
    const view = (over: Partial<CallbackView>): CallbackView => ({
      workflow_id: W,
      host,
      status: 'pending',
      attempts: 0,
      created_at: '2026-11-22T11:00:00.000Z',
      next_attempt_at: '2026-11-22T11:59:58.000Z',
      ...over,
    });
    // (1) red when a block is edited to a field, header or line form the program does not produce, or
    //     the program changes one; when the guide's E2 does not verify with its own key (a hand edit to
    //     the id, timestamp, body or signature), or the real callback does not verify with the real
    //     key; when the reading page's lines differ from the guide's; or when the wait's 200 carries
    //     `callback` (webhook-trigger.md's B3 clause); (2) prints each pair side by side.
    expect({
      acceptedStatus: g.acceptedStatus,
      accepted: Object.keys(g.accepted).sort(),
      registered: g.accepted['callback'],
      keyIs64Hex: /^[0-9a-f]{64}$/.test(g.key),
      names: Object.keys(g.headers).sort(),
      body: shapeOf(JSON.parse(g.body)),
      guideVerifies: verify(g.key, g.headers, g.body, Number(g.headers['webhook-timestamp'])),
      deliveredRead: shapeOf(g.reads[0]),
      deliveredState: g.reads[0]?.['callback'],
      pendingRead: shapeOf(g.reads[1]),
      pendingState: (g.reads[1]?.['callback'] as Record<string, unknown>)['state'],
      lines: g.lines.map(lineShape),
      reading: blockStarting(read(READING), 'Callback: ').split('\n'),
    }).toEqual({
      acceptedStatus: `HTTP/1.1 ${s1.status} Accepted`,
      accepted: Object.keys(j1).sort(),
      registered: j1['callback'],
      keyIs64Hex: /^[0-9a-f]{64}$/.test(key),
      names: [...new Set(real.names)].sort(),
      body: shapeOf(JSON.parse(real.body)),
      guideVerifies: verify(
        key,
        real.headers as Record<string, string>,
        real.body,
        Number(real.headers['webhook-timestamp']),
      ),
      deliveredRead: shapeOf(g1),
      deliveredState: { state: 'delivered', attempts: 1, last_status: 200 },
      pendingRead: shapeOf(g2),
      pendingState: g2['callback']?.['state'],
      lines: [
        lines[0],
        lines[1],
        callbackLine(view({ attempts: 1, last_status: 500 }), true, at),
        callbackLine(view({ status: 'failed', attempts: 2, last_status: 410 }), true, at),
        callbackLine(view({ status: 'failed', attempts: 2, last_status: 'expired' }), true, at),
        callbackLine(view({}), false, at),
      ].map((x) => lineShape(x ?? '(no Callback: line)')),
      reading: g.lines,
    });
    // (1) red when the wait's 200 carries `callback`, or a read of that run stops carrying it;
    //     (2) prints both.
    expect({
      status: held.status,
      inTheWait: 'callback' in (JSON.parse(held.body) as object),
      inTheRead: 'callback' in heldRead,
    }).toEqual({ status: 200, inTheWait: false, inTheRead: true });
  });
});

// ---------------------------------------------------------------------------------------------
// Cell 4: the proxy variables, through the built realm listen, with a control.
// ---------------------------------------------------------------------------------------------

describe('C3c-1 — cell 4: no proxy for callbacks', { timeout: 120_000 }, () => {
  it('4. with NODE_USE_ENV_PROXY=1 and HTTP_PROXY / HTTPS_PROXY set, the callback reaches the receiver and the proxy sees nothing; a plain http.get in the same environment does reach the proxy', async () => {
    const seen: string[] = [];
    const proxy = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(502);
      res.end();
    });
    await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', () => ok()));
    onTestFinished(
      () =>
        new Promise<void>((ok) => {
          proxy.closeAllConnections();
          proxy.close(() => ok());
        }),
    );
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const proxied = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl };
    const b = bench();
    const r = await receiver();
    const host = `127.0.0.1:${r.port}`;
    b.key(host);
    const l = await b.listen(['--callback-allow-private', `http://${host}`], proxied);
    try {
      const a = start(`http://${host}/cb`, 'evt-proxy');
      await call(l.port, 'POST', '/refunds', a.headers, a.body);
      await until(() => r.posts.length === 1, 'the callback at the receiver');
    } finally {
      await l.stop();
    }
    const fromSender = [...seen];
    // Started without blocking: the proxy that must answer it runs in this process.
    const control = await new Promise<{ stdout: string }>((ok) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `require('http').get('http://${host}/control', (res) => { console.log('status', res.statusCode); res.resume(); }).on('error', (e) => console.log('error', e.code));`,
        ],
        { env: { ...b.env, ...proxied } },
      );
      let stdout = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => (stdout += d));
      child.on('exit', () => {
        clearTimeout(timer);
        ok({ stdout });
      });
    });
    // (1) red when the sender goes through the environment's proxy (the proxy sees the callback and
    //     the receiver may not), or when the control does not reach the proxy (this Node ignores the
    //     variables, so the first half would prove nothing); (2) prints what the proxy saw, the
    //     receiver's count and the control's own output (its standard output only: Node 22 prints a
    //     warning on standard error).
    expect({
      receiver: r.posts.length,
      proxySawTheCallback: fromSender,
      controlReachedTheProxy: seen.slice(fromSender.length),
      control: control.stdout.trim(),
    }).toEqual({
      receiver: 1,
      proxySawTheCallback: [],
      controlReachedTheProxy: [`GET http://${host}/control`],
      control: 'status 502',
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Cell 5: the version marker, and every link into and out of the new section.
// ---------------------------------------------------------------------------------------------

/** The anchor a heading gets: lower case, its marks dropped (underscores kept, as GitHub keeps them), its spaces as hyphens. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/ /g, '-');
}
/** The anchors of a page's headings, code blocks skipped. */
function anchorsOf(page: string): Set<string> {
  const out = new Set<string>();
  let fence = false;
  for (const line of read(page).split('\n')) {
    if (line.startsWith('```')) fence = !fence;
    else if (!fence && /^#{1,6} /.test(line)) out.add(slug(line.replace(/^#+ /, '')));
  }
  return out;
}
/** The markdown links of a text, outside code blocks, as `target` strings. */
function linksIn(text: string): string[] {
  return [
    ...text
      .split(/^```[^\n]*\n[\s\S]*?^```$/m)
      .join('')
      .matchAll(/\]\(([^)\s]+)\)/g),
  ].map((m) => m[1]!);
}

describe('C3c-1 — cell 5: the marker and the links', () => {
  it('5a. each addition says "Added after version 0.50.0." once: the section, the Replies row, the 202 sentence; the reading page and the wait row in their own form', () => {
    const trigger = read(TRIGGER).split('\n');
    const row = trigger.find((l) => l.startsWith('| A callback address, if the request names one'));
    const reply = trigger.find((l) =>
      l.includes('A request that named an accepted callback address'),
    );
    const lead = read(READING)
      .split('\n')
      .find((l) => l.startsWith('After those two lines, or where they would be'));
    const waitRow = trigger.find((l) => l.startsWith('| The run ends: `completed`'));
    const count = (t: string | undefined) => (t ?? '').split(MARK).length - 1;
    // (1) red when a marker is dropped or said twice; (2) prints the counts.
    expect({
      section: count(section()),
      row: count(row),
      reply: count(reply?.slice(reply.indexOf('A request that named'))),
      reading: (lead ?? '').includes('(added after version 0.50.0)'),
      waitRow: (waitRow ?? '').includes('which this `200` does not; added after version 0.50.0)'),
    }).toEqual({ section: 1, row: 1, reply: 1, reading: true, waitRow: true });
  });

  it("5b. the two anchors are the guide's headings', and every link out of the section, and into it from the trigger page and the CHANGELOG, resolves", () => {
    const broken: string[] = [];
    const check = (from: string, target: string): void => {
      if (/^[a-z]+:/.test(target)) return;
      const [path, anchor] = target.split('#') as [string, string | undefined];
      const file = path === '' ? from : normalize(join(dirname(from), path));
      if (!existsSync(join(ROOT, file))) broken.push(`${from} → ${target}: no file`);
      else if (anchor !== undefined && !anchorsOf(file).has(anchor))
        broken.push(`${from} → ${target}: no heading`);
    };
    const out = linksIn(section());
    for (const target of out) check(GUIDE, target);
    const inbound = [TRIGGER, CHANGELOG].flatMap((from) =>
      linksIn(read(from))
        .filter((t) => /webhooks\.md#(receive-a-callback|what-a-refused-request-says)$/.test(t))
        .map((t) => [from, t] as const),
    );
    for (const [from, target] of inbound) check(from, target);
    const own = anchorsOf(GUIDE);
    // (1) red when a heading is renamed (its anchor goes), a link points at a file that moved or a
    //     heading it does not have, or an inbound link is dropped; (2) prints each broken link.
    expect({
      anchors: ['receive-a-callback', 'what-a-refused-request-says'].filter((a) => !own.has(a)),
      out: out.filter((t) => !/^[a-z]+:/.test(t)).length,
      inbound: inbound.map(([from, t]) => `${from} → ${t}`),
      broken,
    }).toEqual({
      anchors: [],
      out: 8,
      inbound: [
        `${TRIGGER} → ../../guides/webhooks.md#what-a-refused-request-says`,
        `${CHANGELOG} → docs/guides/webhooks.md#receive-a-callback`,
        `${CHANGELOG} → docs/guides/webhooks.md#receive-a-callback`,
      ],
      broken: [],
    });
  });
});
