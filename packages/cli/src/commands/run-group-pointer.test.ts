// issue #427 — `realm run ./my-workflow` is the discoverability trap: `realm run` manages run
// INSTANCES, and the dev-mode runner is `realm workflow run`.
//
// SPAWN-based, because index.ts parses argv at import — there is nothing to drive in-process.
// The intercept lives before `program.parse()` rather than in a `command:*` listener: attaching
// that listener suppresses commander's own unknown-command handling entirely (silence, exit 0),
// and replacing it by hand would lose the near-miss suggestion commander already gives. G2b is
// the cell that holds that no-regression property down.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_CLI = join(CLI_DIR, 'dist', 'index.js');
const run = promisify(execFile);

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, ...args], { timeout: 15_000 }, (err, stdout, stderr) => {
      const code = err !== null && typeof err.code === 'number' ? err.code : err !== null ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  // The intercept lives in index.ts, which these cells reach only through the built dist (#440).
  // INCREMENTAL, never --force: a forced build rewrites core's shared dist too and races other
  // workers' spawned children mid-read — the #371 flake shape. Incremental still picks up edits.
  await run('npx', ['tsc', '--build', CLI_DIR], { cwd: join(CLI_DIR, '..', '..') });
  expect(existsSync(DIST_CLI)).toBe(true);
}, 120_000);

describe('realm run <path> — the did-you-mean pointer (issue #427)', () => {
  it('G1 a path-shaped token gets the pointer at the right command', async () => {
    const { code, stderr } = await runCli(['run', './my-workflow']);
    expect(code).toBe(1);
    expect(stderr).toContain("error: unknown command './my-workflow'");
    expect(stderr).toContain("Did you mean 'realm workflow run ./my-workflow'?");
    expect(stderr).toContain("'realm run' manages run instances");
  }, 30_000);

  it('G2 a non-path unknown token falls through to commander untouched', async () => {
    const { code, stderr } = await runCli(['run', 'frobnicate']);
    expect(code).toBe(1);
    expect(stderr).toContain("error: unknown command 'frobnicate'");
    // NOT ours: the intercept must not swallow the general unknown-command case.
    expect(stderr).not.toContain('Did you mean');
  }, 30_000);

  it("G2b a near-miss keeps commander's own suggestion", async () => {
    // The property the pre-parse design exists to preserve. A `command:*` listener, or a
    // hand-rolled replacement, would have printed our text here and lost this.
    const { code, stderr } = await runCli(['run', 'inspct']);
    expect(code).toBe(1);
    expect(stderr).toContain("error: unknown command 'inspct'");
    expect(stderr).toContain('(Did you mean inspect?)');
    expect(stderr).not.toContain('realm workflow run');
  }, 30_000);

  it('G3 a real subcommand is unaffected', async () => {
    const { code, stdout } = await runCli(['run', 'list', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('realm run list');
  }, 30_000);
});
