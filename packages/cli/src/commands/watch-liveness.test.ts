// issue #449 — the guardrail-8 journey for `realm workflow watch`, made permanent.
//
// WHY THIS MUST BE A SPAWN CELL. `persistent: false` decides only one thing: whether a watcher
// holds the event loop open. Under vitest the runner's own loop is already holding the process
// alive, so a non-persistent watcher behaves identically to a persistent one and every
// in-process cell passes — 15/15 under the persistent-revert mutant. The flag matters exactly
// when the watchers are the last thing alive, which is exactly the real CLI and nowhere else.
// On main the child exited ~0.6s after printing its first `Registered:` line while still
// claiming, on the line above, to be watching until Ctrl+C.
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');

function yamlAt(version: number): string {
  return `id: watch-liveness
name: Watch Liveness
version: ${version}
steps:
  step-one:
    description: First step
    execution: agent
`;
}

/**
 * A live child whose stdout is watched for `Registered:` lines.
 *
 * The listeners are attached ONCE and feed a single mutable waiter, never re-attached per wait.
 * Node's 'exit' fires once: a per-wait listener would miss a child that dies BETWEEN waits —
 * which is precisely the red-first case, the child exiting during the settle gap — and the
 * informative reject-on-exit would silently degrade into a bare timeout.
 */
class WatchChild {
  // stdin is `ignore`d — the child needs no input and this keeps the type honest about it.
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private stdout = '';
  private registeredCount = 0;
  private exited: { code: number | null } | undefined;
  private waiter: { need: number; resolve: () => void; reject: (e: Error) => void } | undefined;
  private exitWaiter: { resolve: (r: { code: number | null }) => void } | undefined;

  constructor(args: string[], home: string, cwd: string) {
    this.child = spawn(process.execPath, [DIST_CLI, ...args], {
      cwd,
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.stdout += chunk.toString();
      // COUNT the occurrences rather than matching text: a profiles touch re-registers the SAME
      // version, so its line is byte-identical to the one before it and an `includes()` wait
      // would pass vacuously on the previous line.
      this.registeredCount = this.stdout.split('Registered:').length - 1;
      this.settleIfReady();
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stdout += chunk.toString();
    });
    this.child.on('exit', (code) => {
      this.exited = { code };
      this.settleIfReady();
      // issue #453 — the SAME once-attached handler also feeds waitForExit's waiter, for the
      // identical reason the registration waiter is fed this way (file head comment): a
      // per-wait listener attached inside waitForExit could lose the race against an 'exit'
      // that already fired between the `this.exited !== undefined` check and the attach.
      if (this.exitWaiter !== undefined) {
        const w = this.exitWaiter;
        this.exitWaiter = undefined;
        w.resolve({ code });
      }
    });
  }

  private settleIfReady(): void {
    const w = this.waiter;
    if (w === undefined) return;
    if (this.registeredCount >= w.need) {
      this.waiter = undefined;
      w.resolve();
      return;
    }
    if (this.exited !== undefined) {
      this.waiter = undefined;
      w.reject(
        new Error(
          `watch child EXITED (code ${String(this.exited.code)}) before registration #${String(
            w.need,
          )} — it was supposed to keep watching. Output so far:\n${this.stdout}`,
        ),
      );
    }
  }

  /** Resolves once at least `need` `Registered:` lines have been seen; rejects if the child dies. */
  waitForRegistrations(need: number, capMs = 15_000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(
          new Error(
            `timed out waiting for registration #${String(need)}. Output so far:\n${this.stdout}`,
          ),
        );
      }, capMs);
      const done = (fn: () => void): void => {
        clearTimeout(timer);
        fn();
      };
      this.waiter = {
        need,
        resolve: () => done(resolve),
        reject: (e) => done(() => reject(e)),
      };
      this.settleIfReady();
    });
  }

  /**
   * Resolves once the child has exited; rejects on timeout, carrying stdout so a hung-alive
   * failure (the pre-#453 zombie shape) is diagnosable from the assertion message.
   */
  waitForExit(capMs = 15_000): Promise<{ code: number | null }> {
    if (this.exited !== undefined) return Promise.resolve(this.exited);
    return new Promise<{ code: number | null }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.exitWaiter = undefined;
        reject(new Error(`timed out waiting for exit. Output so far:\n${this.stdout}`));
      }, capMs);
      this.exitWaiter = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
    });
  }

  get isRunning(): boolean {
    return this.exited === undefined;
  }

  get output(): string {
    return this.stdout;
  }

  kill(): void {
    this.child.kill();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('realm workflow watch — stays alive and keeps seeing edits (issue #449)', () => {
  it('survives two consecutive atomic saves and a profiles touch, and is still running after', async () => {
    const home = mkdtempSync(join(tmpdir(), 'realm-watch-live-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'realm-watch-live-'));
    const filePath = join(proj, 'workflow.yaml');
    const profilesDir = join(proj, 'profiles');
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(join(profilesDir, 'reviewer.md'), 'a profile', 'utf8');
    writeFileSync(filePath, yamlAt(1), 'utf8');

    const w = new WatchChild(['workflow', 'watch', proj], home, proj);
    try {
      await w.waitForRegistrations(1);

      // The watchers are established AFTER the v1 line is printed, and nothing on stdout signals
      // that moment — so this is the one place a fixed settle is the only option.
      await sleep(250);

      // Save 1, vim-style. On main this one still registered (the dying inode's last event) —
      // the watch was already dead, which only the NEXT save reveals.
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, yamlAt(2), 'utf8');
      renameSync(tmp, filePath);
      await w.waitForRegistrations(2);

      // Save 2 — the inode-death case. On main: nothing, ever again.
      writeFileSync(tmp, yamlAt(3), 'utf8');
      renameSync(tmp, filePath);
      await w.waitForRegistrations(3);

      // A profiles touch re-registers the same version, hence the counting waiter.
      writeFileSync(join(profilesDir, 'reviewer.md'), 'an edited profile', 'utf8');
      await w.waitForRegistrations(4);

      expect(w.output).toContain('Registered: watch-liveness v3');
      // The liveness claim itself: it did not exit on its own at any point above.
      expect(w.isRunning).toBe(true);
    } finally {
      w.kill();
      rmSync(proj, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
});

describe('realm workflow watch — dies honestly when the directory is gone (issue #453)', () => {
  it('D9 the watched directory deleted mid-session → honest exit 1, not a silent zombie', async () => {
    const home = mkdtempSync(join(tmpdir(), 'realm-watch-live-home-'));
    // `cwd` is a SEPARATE surviving temp dir, deliberately never the project dir: deleting a
    // spawned child's own cwd is its own confound, unrelated to what this cell pins.
    const cwd = mkdtempSync(join(tmpdir(), 'realm-watch-live-cwd-'));
    const proj = mkdtempSync(join(tmpdir(), 'realm-watch-live-proj-'));
    const filePath = join(proj, 'workflow.yaml');
    writeFileSync(filePath, yamlAt(1), 'utf8');

    // ABSOLUTE yaml path — the CLI-prefix + exit-code members of this contract are pinned ONLY
    // here; an in-process watchWorkflow cell cannot see either.
    const w = new WatchChild(['workflow', 'watch', filePath], home, cwd);
    try {
      await w.waitForRegistrations(1);
      // The watchers are established AFTER the v1 line prints, and nothing on stdout signals
      // that moment — the same fixed-settle idiom as the sibling cell above.
      await sleep(250);

      rmSync(proj, { recursive: true, force: true });

      const exit = await w.waitForExit(15_000);
      expect(exit.code).toBe(1);
      // stderr folds into the merged `output` buffer (:62-64) — that is where this must look.
      expect(w.output).toContain('Error: The watched directory no longer exists');
      expect(w.output).toContain("restart 'realm workflow watch'");
    } finally {
      w.kill();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      // proj is already gone by the cell's own action; a second removal is a harmless no-op.
      rmSync(proj, { recursive: true, force: true });
    }
  }, 40_000);
});
