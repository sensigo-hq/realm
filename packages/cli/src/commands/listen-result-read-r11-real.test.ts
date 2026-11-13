// listen-result-read-r11-real.test.ts — R1.1 through the built `realm`: an automation posts an
// event to `realm listen`, the agent `realm listen` starts drives the run to its end, and the
// automation reads the run's declared result back at the address and with the code the `202` gave.
// The workflow's one step is a bare `auto` step (no handler, no service, no `depends_on`), which
// records the run's parameters as its output, so the run completes with no model call. Each cell
// starts `realm listen` (`--port 0`, a fresh HOME, a fake key) in its own project folder and reads
// what the caller sees. A failing cell prints the statuses, the bodies (a code only by its shape)
// and listen's lines; the environment it prints is none (the child gets PATH, HOME, a fake key and
// the test's own secret).
import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');
const SECRET = 'r11-real-secret-0123456789';

const WORKFLOW = `id: refunds
name: refunds
version: 1
trigger:
  type: webhook
  path: /refunds
  auth:
    mode: shared_secret
    header: X-Token
    secret_from: WH_SECRET
  dedup:
    id_from: body.id
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

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-r11-real-'));
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'project'));
  writeFileSync(join(root, 'project', 'workflow.yaml'), WORKFLOW, 'utf8');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Starts the built `realm listen` in the project folder; returns its port and its output so far. */
async function startListen(): Promise<{ port: number; output: () => string }> {
  const proc: ChildProcess = spawn(
    process.execPath,
    [CLI, 'listen', '--model', 'm', '--provider', 'anthropic', '--port', '0'],
    {
      cwd: join(root, 'project'),
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: join(root, 'home'),
        ANTHROPIC_API_KEY: 'k-fake-r11',
        WH_SECRET: SECRET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  onTestFinished(() => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  });
  let out = '';
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  proc.stderr!.on('data', (d: Buffer) => (out += d.toString()));
  const deadline = performance.now() + 30_000;
  for (;;) {
    const m = /realm listen on 127\.0\.0\.1:(\d+)/.exec(out);
    if (m !== null) return { port: Number(m[1]), output: () => out };
    if (proc.exitCode !== null || performance.now() > deadline) {
      throw new Error(`realm listen did not start: ${out.slice(0, 2000)}`);
    }
    await sleep(50);
  }
}

interface Seen {
  status: number;
  headers: Record<string, string>;
  body: string;
}
/** One request with Node's own client (`fetch` sends `Connection: close` on every HEAD). */
function call(
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: init.headers ?? {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d: string) => (body += d));
        res.on('end', () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers))
            if (k !== 'date') headers[k] = String(v);
          resolve({ status: res.statusCode ?? 0, headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

/** Posts the event; returns the 202's run id, read address and code. */
async function postEvent(
  port: number,
  event: Record<string, unknown>,
): Promise<{ status: number; runId: string; statusPath: string; token: string }> {
  const r = await call(port, '/refunds', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-token': SECRET },
    body: JSON.stringify(event),
  });
  const b = JSON.parse(r.body) as Record<string, string>;
  return {
    status: r.status,
    runId: b['run_id']!,
    statusPath: b['status_path']!,
    token: b['token']!,
  };
}

/** Reads the address until the run is no longer running (the agent takes about a second). */
async function readUntilDone(port: number, statusPath: string, token: string): Promise<Seen> {
  const deadline = performance.now() + 60_000;
  for (;;) {
    const r = await call(port, statusPath, { headers: { authorization: `Bearer ${token}` } });
    if (!r.body.includes('"run_phase":"running"') || performance.now() > deadline) return r;
    await sleep(250);
  }
}

describe('R1.1 — the journey through the built realm', () => {
  it('G1: POST, the run completes, GET with the code gives the declared result; HEAD the same without a body', async () => {
    const listen = await startListen();
    const posted = await postEvent(listen.port, { id: 'evt-1', approved: true, note: 'gift card' });
    const done = await readUntilDone(listen.port, posted.statusPath, posted.token);
    const head = await call(listen.port, posted.statusPath, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${posted.token}` },
    });
    // (a) red when the result is not handed out (no `result`, or another value), the reply can be
    //     cached, or HEAD differs from GET but for its body; (b) prints the statuses, the bodies,
    //     the headers and listen's output when the run did not complete.
    expect({
      posted: posted.status,
      status: done.status,
      body: JSON.parse(done.body),
      cacheControl: done.headers['cache-control'],
      head: { ...head, body: head.body.length },
      output: done.body.includes('"completed"') ? '' : listen.output(),
    }).toEqual({
      posted: 202,
      status: 200,
      body: {
        run_id: posted.runId,
        run_phase: 'completed',
        result: { approved: true, note: 'gift card' },
        result_masked: { declared: 0, environment: 0, pattern: 0 },
      },
      cacheControl: 'no-store',
      head: { status: 200, headers: done.headers, body: 0 },
      output: '',
    });
  }, 120_000);

  it("G6: after the project's secrets: changes, and with its realm.yaml unreadable, the result is withheld and says why", async () => {
    const project = join(root, 'project');
    writeFileSync(
      join(project, 'realm.yaml'),
      'version: 1\nadapters:\n  svc:\n    use: github\n    config:\n      token: "${secret:R11_DECLARED}"\n',
      'utf8',
    );
    writeFileSync(
      join(project, '.env'),
      'R11_DECLARED=fake-declared-r11-0729\nR11_OTHER=fake-other-r11-0729\n',
    );
    const listen = await startListen();
    const posted = await postEvent(listen.port, {
      id: 'evt-1',
      approved: true,
      note: 'FAKECANR11G6NOTE0729',
    });
    const done = await readUntilDone(listen.port, posted.statusPath, posted.token);
    // The project's secrets change: the run's recorded secret is no longer the one referenced.
    writeFileSync(
      join(project, 'realm.yaml'),
      'version: 1\nadapters:\n  svc:\n    use: github\n    config:\n      token: "${secret:R11_OTHER}"\n',
      'utf8',
    );
    const changed = await call(listen.port, posted.statusPath, {
      headers: { authorization: `Bearer ${posted.token}` },
    });
    // The manifest cannot be read: a folder stands where the file was.
    rmSync(join(project, 'realm.yaml'));
    mkdirSync(join(project, 'realm.yaml'));
    const unreadable = await call(listen.port, posted.statusPath, {
      headers: { authorization: `Bearer ${posted.token}` },
    });
    const withValue = (r: Seen) => r.body.includes('FAKECANR11G6NOTE0729');
    // (a) red when values are walked and shown while the declared values are withheld, or the reason
    //     is not the walk's words; (b) prints the completed read's phase, both bodies without the
    //     value (its presence as a boolean), and listen's output when the run did not complete.
    expect({
      completed: done.body.includes('"run_phase":"completed"') ? true : listen.output(),
      changed: [
        changed.status,
        JSON.parse(changed.body.replace('FAKECANR11G6NOTE0729', '<value>')),
      ],
      unreadable: [
        unreadable.status,
        JSON.parse(unreadable.body.replace('FAKECANR11G6NOTE0729', '<value>')),
      ],
      leaked: [withValue(changed), withValue(unreadable)],
    }).toEqual({
      completed: true,
      changed: [
        200,
        {
          run_id: posted.runId,
          run_phase: 'completed',
          result_error: 'values_withheld',
          because: 'declared values changed',
        },
      ],
      unreadable: [
        200,
        {
          run_id: posted.runId,
          run_phase: 'completed',
          result_error: 'values_withheld',
          because: 'declared values could not be read',
        },
      ],
      leaked: [false, false],
    });
  }, 120_000);
});
