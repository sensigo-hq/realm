// inspect-callback-c3b1.test.ts — R1.3 callback C3b1: the BUILT `realm run inspect` prints
// `Callback: expired at attempt <n>, not delivered within its time limit` for a run whose callback row
// ended `expired`, on a real SQLite home (`createTestHome`), the row put in its state through the
// callback store's own sender calls (claim, mark). The pattern is `inspect-callback-c2.test.ts`.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
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
const START = '2026-11-21T12:00:00.000Z';
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('C3b1 — realm run inspect: an expired callback', { timeout: 120_000 }, () => {
  it('a row ended expired prints the expired line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'realm-c3b1-inspect-'));
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
    const { record } = await store.create({
      workflowId: W,
      workflowVersion: 1,
      params: {},
      callback: {
        url: 'https://hooks.example.com/cb/x',
        host: 'hooks.example.com:443',
        webhook_id: randomUUID(),
      },
    });
    await abandonRun(store, record.id);
    const view = await callbacks.read(record.id);
    const claim = await callbacks.claim(record.id, {
      expectedNextAttemptAt: view!.next_attempt_at,
      token: 'tok-expired',
    });
    if (!claim.applied) throw new Error(`claim refused: ${claim.reason}`);
    const mark = await callbacks.mark(record.id, 'tok-expired', {
      kind: 'failed',
      lastStatus: 'expired',
    });
    if (!mark.applied) throw new Error(`mark refused: ${mark.reason}`);
    await h.home.close();
    const r = spawnSync(process.execPath, [CLI, 'run', 'inspect', record.id], {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '', HOME: root, NO_COLOR: '1', REALM_NO_NUDGE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    // (1) red when an expired row prints the failed line, or the attempt count is not the row's;
    //     (2) prints the exit code and the Callback lines.
    expect({
      code: r.status,
      lines: (r.stdout + r.stderr).split('\n').filter((l) => l.startsWith('Callback:')),
    }).toEqual({
      code: 0,
      lines: ['Callback: expired at attempt 1, not delivered within its time limit'],
    });
  });
});
