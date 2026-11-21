// delivery-pass-sqlite-c3a.test.ts — callback C3a (R1.3): the signed delivery pass on real SQLite
// homes. End to end: a key made by the BUILT `realm callback key` (its text read from its own
// stdout), a completed run with a registered callback, a real loopback receiver, and a signature
// checked apart with node:crypto. Then what needs a second store handle: a rotation made by another
// process, a claim another process made first (a foreign connection), and keys this process cannot
// read (another master key; no master key).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abandonRun, executeStep, type CallbackStore, type RunStore } from '@sensigo/realm';
import { createCallbackKeySealer } from '@sensigo/realm-store-sqlite';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { afterAll, describe, expect, it, onTestFinished } from 'vitest';
import { makeTempHome } from '../../test-support/temp-home.js';
import {
  capturingLogger,
  emptySet,
  ENV,
  sharedSecretTrigger,
  workflow,
} from '../../test-support/listen-read-r11.js';
import { VERSION } from '../../version.js';
import { deriveReadKey, readCode, type ReadEntry } from '../run-read-address.js';
import { parseCallbackEntry } from './allow-list.js';
import { makeCallbackPass } from './delivery-pass.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', '..', 'dist', 'index.js');
const W = 'refunds';
const MASTER_A = '5c'.repeat(32);
const MASTER_B = '6d'.repeat(32);
const KEY = '7e'.repeat(32);
const live = (): boolean => true;
const YAML = `id: ${W}\nname: ${W}\nversion: 1\ntrigger:\n  type: webhook\n  path: /${W}\n  auth:\n    mode: shared_secret\n    header: X-Token\n    secret_from: READ_SECRET\n  result_map:\n    approved: context.resources.review.approved\nsteps:\n  review:\n    description: Review.\n    execution: agent\n`;

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs)
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const fpOf = (masterHex: string): string =>
  createHash('sha256').update(Buffer.from(masterHex, 'hex')).digest('hex').slice(0, 8);
const sealerOf = (masterHex: string) => createCallbackKeySealer(Buffer.from(masterHex, 'hex'));

interface Post {
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}
/** A loopback http receiver answering 200, closed after the cell. */
async function receiver(): Promise<{ port: number; posts: Post[] }> {
  const posts: Post[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      posts.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200);
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

const signedBy = (key: string, post: Post): string =>
  `v1,${createHmac('sha256', Buffer.from(key, 'utf8'))
    .update(`${post.headers['webhook-id']}.${post.headers['webhook-timestamp']}.${post.body}`)
    .digest('base64')}`;
const tokens = (post: Post): string[] => String(post.headers['webhook-signature']).split(' ');

/** A scratch HOME with the workflow folder `wf`, and the built `realm` run in it with master key A. */
function bench() {
  const root = mkdtempSync(join(tmpdir(), 'realm-c3a-'));
  dirs.push(root);
  mkdirSync(join(root, 'wf'));
  writeFileSync(join(root, 'wf', 'workflow.yaml'), YAML);
  const realm = (args: readonly string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: root,
        NO_COLOR: '1',
        REALM_NO_NUDGE: '1',
        REALM_ENCRYPTION_KEY: MASTER_A,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (r.status !== 0 || !/^[0-9a-f]{64}\n$/.test(r.stdout)) {
      throw new Error(`realm ${args.join(' ')}: exit ${r.status}: ${r.stderr}`);
    }
    return r.stdout.slice(0, -1);
  };
  return { root, home: join(root, '.realm'), realm };
}

/** The library's door on `home` (with `master`'s sealer, or none), the workflow mounted, a pass maker. */
async function opened(home: string, master: string | undefined) {
  const h = await makeTempHome({
    home,
    ...(master !== undefined ? { sealer: sealerOf(master) } : {}),
  });
  onTestFinished(() => h.cleanup());
  const store: RunStore = h.home.runStore;
  const definition = workflow(
    W,
    sharedSecretTrigger('/refunds', { approved: 'context.resources.review.approved' }),
  );
  const mounted: ReadEntry = {
    path: '/refunds',
    definition,
    readKey: await deriveReadKey(ENV['READ_SECRET']!, W),
  };
  const logger = capturingLogger();
  const run = async (url: string, host: string, complete = true): Promise<string> => {
    const { record } = await store.create({
      workflowId: W,
      workflowVersion: 1,
      params: {},
      callback: { url, host, webhook_id: randomUUID() },
    });
    if (!complete) await abandonRun(store, record.id);
    else {
      await executeStep(store, definition, {
        runId: record.id,
        command: 'review',
        input: { approved: true },
        dispatcher: async (_c, input) => input,
      });
    }
    return record.id;
  };
  const pass = (host: string, callbacks: CallbackStore = store.callbacks!) => {
    const allowed = parseCallbackEntry(`http://${host}`);
    if (!allowed.ok) throw new Error('fixture: entry');
    return makeCallbackPass({
      callbacks,
      getRun: async (id) => (await store.get(id)).record,
      entryOf: (id) => (id === W ? mounted : undefined),
      disclosureProvider: async () => emptySet(),
      lists: { public: [], private: [allowed.entry] },
      ownPort: 1,
      logger,
    });
  };
  return { h, store, mounted, logger, run, pass };
}

describe('callback C3a — the pass on real SQLite homes', { timeout: 120_000 }, () => {
  it('end to end: one POST, the wire’s headers, the envelope, a signature that checks with the key `realm callback key` printed; the row delivered, its address and body gone', async () => {
    const b = bench();
    const r = await receiver();
    const host = `127.0.0.1:${r.port}`;
    const printed = b.realm(['callback', 'key', 'wf', '--host', `http://${host}`]);
    const o = await opened(b.home, MASTER_A);
    const id = await o.run(`http://${host}/cb`, host);
    const cut = await o.pass(host)(live);
    const post = r.posts[0]!;
    const record = (await o.store.get(id)).record;
    const c = await openForeignConnection(b.home);
    let stored: { status: string; url: string | null; body: string | null; webhook_id: string };
    try {
      stored = c
        .prepare('SELECT status, url, body, webhook_id FROM callbacks WHERE run_id = ?')
        .get(id) as typeof stored;
    } finally {
      c.close();
    }
    const readToken = readCode(o.mounted.readKey!, id);
    const headers = Object.entries(post.headers)
      .filter(([k]) => k !== 'webhook-signature')
      .map(([, v]) => String(v))
      .join('\n');
    // (1) red when the HMAC is keyed with the 32 decoded bytes (the signature does not check with
    //     the printed text), the read code is kept in `data`, a header is renamed or left out, the
    //     envelope's timestamp is not the run's finish, or the row keeps its address or body;
    //     (2) prints the POST's parts, the row and what leaked (the read code, the key text).
    expect({
      cut,
      posts: r.posts.length,
      headers: {
        id: post.headers['webhook-id'],
        timestamp: /^\d{10}$/.test(String(post.headers['webhook-timestamp'])),
        type: post.headers['content-type'],
        agent: post.headers['user-agent'],
        run: post.headers['realm-run-id'],
      },
      checks: tokens(post)[0] === signedBy(printed, post),
      tokenCount: tokens(post).length,
      envelope: JSON.parse(post.body),
      row: { status: stored.status, url: stored.url, body: stored.body },
      leaked: [readToken, printed].filter((s) => headers.includes(s) || post.body.includes(s)),
      lines: o.logger.lines.map((l) => l.msg),
    }).toEqual({
      cut: false,
      posts: 1,
      headers: {
        id: stored.webhook_id,
        timestamp: true,
        type: 'application/json',
        agent: `realm/${VERSION}`,
        run: id,
      },
      checks: true,
      tokenCount: 1,
      envelope: {
        type: 'run.finished',
        timestamp: record.updated_at,
        data: {
          run_id: id,
          run_phase: 'completed',
          result: { approved: true },
          result_masked: { declared: 0, environment: 0, pattern: 0 },
          status_path: `/refunds/runs/${id}`,
        },
      },
      row: { status: 'delivered', url: null, body: null },
      leaked: [],
      lines: [`callbacks: ${W} → ${host}: delivered (attempt 1)`],
    });
  });

  it('a rotation made by another process (`realm callback key --rotate`) is seen by the next try of the same pass function, with no restart', async () => {
    const b = bench();
    const r = await receiver();
    const host = `127.0.0.1:${r.port}`;
    const first = b.realm(['callback', 'key', 'wf', '--host', `http://${host}`]);
    const o = await opened(b.home, MASTER_A);
    const pass = o.pass(host);
    await o.run(`http://${host}/cb`, host);
    await pass(live);
    const second = b.realm(['callback', 'key', 'wf', '--host', `http://${host}`, '--rotate']);
    await o.run(`http://${host}/cb`, host);
    await pass(live);
    // (1) red when the keys are cached for the life of the pass function (the second try carries the
    //     old key alone); (2) prints both POSTs' tokens against the ones computed apart.
    expect({
      before: tokens(r.posts[0]!),
      after: tokens(r.posts[1]!),
    }).toEqual({
      before: [signedBy(first, r.posts[0]!)],
      after: [signedBy(second, r.posts[1]!), signedBy(first, r.posts[1]!)],
    });
  });

  it('keys this process cannot read — sealed under another master key, or a home opened with no master key — and a pair with none: nothing claimed, nothing sent, one line per pair and master key however many passes', async () => {
    const b = bench();
    const r = await receiver();
    const host = `127.0.0.1:${r.port}`;
    const bare = '127.0.0.1:2';
    const first = await opened(b.home, MASTER_A);
    await first.store.callbacks!.keys.make(W, host, KEY);
    const ids = [
      await first.run(`http://${host}/cb`, host, false),
      await first.run(`http://${bare}/cb`, bare, false),
    ];
    await first.h.cleanup();
    const outcome = async (master: string | undefined) => {
      const o = await opened(b.home, master);
      const pass = o.pass(host);
      for (let i = 0; i < 3; i += 1) await pass(live);
      const attempts = await Promise.all(
        ids.map(async (id) => (await o.store.callbacks!.read(id))?.attempts),
      );
      const lines = o.logger.lines.map((l) => l.msg).sort();
      await o.h.cleanup();
      return { attempts, lines };
    };
    const otherMaster = await outcome(MASTER_B);
    const noMaster = await outcome(undefined);
    const sealed = `callbacks: ${W} → ${host}: no signing key this process can read (sealed with encryption key ${fpOf(MASTER_A)}), so its callbacks wait`;
    const none = `callbacks: ${W} → ${bare}: no signing key this process can read (none), so its callbacks wait`;
    // (1) red when a row is claimed before its key is checked (attempts 1 or more), or the line is
    //     said per pass; (2) prints the rows' attempts, the POSTs and the lines.
    expect({ otherMaster, noMaster, posts: r.posts.length }).toEqual({
      otherMaster: { attempts: [0, 0], lines: [sealed, none].sort() },
      noMaster: { attempts: [0, 0], lines: [sealed, none].sort() },
      posts: 0,
    });
  });

  it('a claim another process made first: this pass’s claim is stale, so it sends and writes nothing', async () => {
    const b = bench();
    const r = await receiver();
    const host = `127.0.0.1:${r.port}`;
    b.realm(['callback', 'key', 'wf', '--host', `http://${host}`]);
    const o = await opened(b.home, MASTER_A);
    const id = await o.run(`http://${host}/cb`, host);
    const c = await openForeignConnection(b.home);
    onTestFinished(() => c.close());
    const callbacks = o.store.callbacks!;
    // Between this pass's listing and its claim, another process claims the row (a second handle).
    const raced = new Proxy(callbacks, {
      get(target, prop) {
        if (prop === 'due') {
          return async (limit: number) => {
            const rows = await target.due(limit);
            for (const row of rows) {
              c.prepare(
                "UPDATE callbacks SET next_attempt_at = '2099-01-01T00:00:00.000Z', attempts = attempts + 1, claim_token = 'another process' WHERE run_id = ?",
              ).run(row.run_id);
            }
            return rows;
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    await o.pass(host, raced)(live);
    const row = c
      .prepare('SELECT status, attempts, claim_token, body FROM callbacks WHERE run_id = ?')
      .get(id);
    // (1) red when a stale claim is taken for a win (the row is sent, its body frozen or marked);
    //     (2) prints the POSTs, the row and the lines.
    expect({ posts: r.posts.length, row, lines: o.logger.lines }).toEqual({
      posts: 0,
      row: { status: 'pending', attempts: 1, claim_token: 'another process', body: null },
      lines: [],
    });
  });
});
