// inspect-callback-c2.test.ts — R1.3 callback C2: the one `Callback:` line the BUILT `realm run
// inspect` prints for a run that has a callback row, in each of its five states, and no line for a run
// without one. The home is a real SQLite home on a test clock (`createTestHome`, the clock file the
// child reads too), so every instant is known and each line is written out whole. The rows are put in
// their states through the callback store's own sender calls (claim, freezeBody, mark). The address,
// the webhook id and the body carry canaries: no `inspect` output and no exported bundle may hold one.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { abandonRun } from '@sensigo/realm';
import { createTestHome } from '@sensigo/realm-testing';
import { makeTempHome } from '../test-support/temp-home.js';
import { sharedSecretTrigger, workflow } from '../test-support/listen-read-r11.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'dist', 'index.js');
const W = 'refunds';
const LABEL = 'hooks.example.com:443';
const URL_ = 'https://hooks.example.com/cb/CANARYc2inspect?q=CANARYc2q';
const BODY = '{"run":"CANARYc2body"}';
const START = '2026-11-21T12:00:00.000Z';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('C2 — realm run inspect: the Callback line', { timeout: 120_000 }, () => {
  it('the five states, as the instant formatter prints them; no line without a row; no address, webhook id or body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realm-c2-inspect-'));
    dirs.push(root);
    const testHome = await createTestHome({ start: START, root: join(root, '.realm') });
    const h = await makeTempHome({ home: testHome.root });
    const store = h.home.runStore;
    const callbacks = store.callbacks!;
    await h.home.workflowStore.register(
      workflow(
        W,
        sharedSecretTrigger('/refunds', { approved: 'context.resources.review.approved' }),
      ),
    );
    const ids: string[] = [];
    const run = async (withCallback: boolean): Promise<string> => {
      const webhook = randomUUID();
      ids.push(webhook);
      const { record } = await store.create({
        workflowId: W,
        workflowVersion: 1,
        params: {},
        ...(withCallback ? { callback: { url: URL_, host: LABEL, webhook_id: webhook } } : {}),
      });
      return record.id;
    };
    /** Finishes the run and claims its row: the token. */
    const claimed = async (runId: string, token: string): Promise<string> => {
      await abandonRun(store, runId);
      const view = await callbacks.read(runId);
      const c = await callbacks.claim(runId, {
        expectedNextAttemptAt: view!.next_attempt_at,
        token,
      });
      if (!c.applied) throw new Error(`claim refused: ${c.reason}`);
      return token;
    };
    const waiting = await run(true);
    const pending = await run(true);
    await callbacks.mark(pending, await claimed(pending, 'tok-pending'), {
      kind: 'retry',
      afterSeconds: 300,
      lastStatus: 503,
    });
    const due = await run(true);
    await abandonRun(store, due);
    const delivered = await run(true);
    const token = await claimed(delivered, 'tok-delivered');
    await callbacks.freezeBody(delivered, token, BODY);
    await callbacks.mark(delivered, token, { kind: 'delivered', lastStatus: 200 });
    const failed = await run(true);
    await callbacks.mark(failed, await claimed(failed, 'tok-failed'), {
      kind: 'failed',
      lastStatus: 410,
    });
    const none = await run(false);
    await h.home.close();
    // Two minutes on: the child reads the same clock file.
    await testHome.clock.advance(120_000);
    const inspect = (runId: string) =>
      spawnSync(process.execPath, [CLI, 'run', 'inspect', runId], {
        cwd: root,
        env: { PATH: process.env['PATH'] ?? '', HOME: root, NO_COLOR: '1', REALM_NO_NUDGE: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      });
    const outs = { waiting, pending, due, delivered, failed, none };
    const seen = Object.fromEntries(
      Object.entries(outs).map(([name, id]) => {
        const r = inspect(id);
        return [name, { code: r.status, out: r.stdout + r.stderr }];
      }),
    );
    const line = (name: string) =>
      seen[name]!.out.split('\n').filter((l) => l.startsWith('Callback:'));
    const exported = join(root, 'delivered.realm.json');
    const ex = spawnSync(
      process.execPath,
      [CLI, 'run', 'export', delivered, '--out', exported, '--accept-partial-disclosure'],
      {
        cwd: root,
        env: { PATH: process.env['PATH'] ?? '', HOME: root, NO_COLOR: '1', REALM_NO_NUDGE: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    if (ex.status !== 0) throw new Error(`export: ${ex.status} ${ex.stdout} ${ex.stderr}`);
    const all =
      Object.values(seen)
        .map((s) => s.out)
        .join('\n') + readFileSync(exported, 'utf8');
    const canaries = ['CANARYc2inspect', 'CANARYc2q', 'CANARYc2body', ...ids];
    // (1) red when a state's line is another's, the formatter's words are doubled ("ago ago", "in
    //     in"), a run without a row gets a line, or a line, an output or the export shows the
    //     address, a webhook id or the body; (2) prints each line, the codes and what leaked.
    expect({
      codes: Object.values(seen).map((s) => s.code),
      exportCode: ex.status,
      lines: Object.fromEntries(Object.keys(outs).map((name) => [name, line(name)])),
      leaked: canaries.filter((c) => all.includes(c)),
      instrument: canaries.slice(0, 2).every((c) => URL_.includes(c)),
    }).toEqual({
      codes: [0, 0, 0, 0, 0, 0],
      exportCode: 0,
      lines: {
        waiting: ['Callback: waiting for the run to finish'],
        pending: [
          'Callback: pending, attempt 1, last answer 503, next try in 3m (2026-11-21T12:05:00Z)',
        ],
        due: [
          'Callback: due since 2m ago (2026-11-21T12:00:00Z); it waits for the next pass of a realm listen that can send it',
        ],
        delivered: [
          'Callback: delivered to hooks.example.com:443 2m ago (2026-11-21T12:00:00Z), attempt 1',
        ],
        failed: ['Callback: failed after 1 attempt, last answer 410'],
        none: [],
      },
      leaked: [],
      instrument: true,
    });
  });
});
