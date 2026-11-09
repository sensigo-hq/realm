// reading-command-busy-616.test.ts — issue #616 PR-2c c10a-3b-ii: a READING `realm` command that
// meets the store busy beyond its budget prints the store's one busy line and exits 1, as an operator
// runs it: the BUILT `realm`, with PATH, HOME and REALM_NO_NUDGE only, in a scratch working folder.
//
// In WAL mode a held write lock blocks no reader (AUD-2C7-24), so the holder here is a second
// connection in SQLite's exclusive locking mode, which shuts every other connection out of the
// write-ahead log (AUD-2C10A3BII-05). It opens through `openForeignConnection` of the store package's
// `./test-support`, the one lawful route: no CLI source names the built-in SQLite (the one-loader law).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openForeignConnection } from '@sensigo/realm-store-sqlite/test-support';
import { describe, expect, it } from 'vitest';
import { makeTempHome } from '../test-support/temp-home.js';

const DIST_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');
const BUDGET_MS = 5_000;
const KILLED_AFTER_MS = 60_000;

describe('#616 PR-2c c10a-3b-ii — a reading command on a busy store', { timeout: 120_000 }, () => {
  it('`realm run list` while another connection holds the store exclusively: one Error line, exit 1, no stack, after the 5 s budget', async () => {
    const temp = await makeTempHome();
    const cwd = mkdtempSync(join(tmpdir(), 'realm-616-busy-cwd-'));
    // The holder takes its lock on its first read, and fails itself if any other connection is open
    // on the file then: this process's own handle is closed first.
    temp.home.close();
    const holder = await openForeignConnection(temp.path);
    try {
      holder.exec('PRAGMA locking_mode = EXCLUSIVE');
      holder.exec('BEGIN');
      holder.prepare('SELECT count(*) AS n FROM runs').get();
      const started = performance.now();
      const run = spawnSync(process.execPath, [DIST_CLI, 'run', 'list'], {
        cwd,
        env: { PATH: process.env['PATH'] ?? '', HOME: temp.root, REALM_NO_NUDGE: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: KILLED_AFTER_MS,
        killSignal: 'SIGKILL',
      });
      const wallMs = performance.now() - started;
      // (1) red when STATE_RUN_BUSY leaves the expected refusals (the entry rethrows it: a stack and
      //     another exit code), the budget is not waited out, or the child hangs to its kill;
      //     (2) prints the exit code, the whole stderr and the wall time.
      expect(
        {
          code: run.status,
          stderr: run.stderr,
          budgetWaitedOut: wallMs >= BUDGET_MS,
          beforeTheKill: wallMs < KILLED_AFTER_MS,
        },
        `wall time ${Math.round(wallMs)} ms`,
      ).toEqual({
        code: 1,
        stderr:
          'Error: The store was busy for 5 s: another writer held it. Nothing was written. Try again.\n',
        budgetWaitedOut: true,
        beforeTheKill: true,
      });
    } finally {
      // The lock outlives a COMMIT and ends at close.
      holder.close();
      await temp.cleanup();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
