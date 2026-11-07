// removed-commands-616.test.ts — issue #616 PR-2c (c2): `realm run gc`, `realm run reconcile` and
// `realm workflow migrate` are removed with the JSON run and workflow folders they worked on. The real
// case: a script written before the removal still calls one of them, and must stop instead of doing
// something else. The cells run the BUILT `realm` (tests run after the build) in a scratch HOME and
// working folder, with PATH, HOME and REALM_NO_NUDGE only. Each assertion names (a) what turns it red
// and (b) what it prints: the exit code and both streams of a scratch home, which hold no secret.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const DIST_CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.js');

let base = '';
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'realm-616-c2-'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('#616 PR-2c c2 — the three commands of the JSON folders are gone', () => {
  it.each([
    ['run', 'gc'],
    ['run', 'reconcile'],
    ['workflow', 'migrate'],
  ])(
    "realm %s %s: commander's own unknown-command line, exit 1, nothing on standard output",
    (group, name) => {
      const r = spawnSync(process.execPath, [DIST_CLI, group, name], {
        cwd: base,
        env: { PATH: process.env['PATH'] ?? '', HOME: base, REALM_NO_NUDGE: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
        killSignal: 'SIGKILL',
      });
      // (a) red while the command exists (it runs and prints its own output) or when Realm answers
      //     it with words of its own; (b) prints the exit code and both streams.
      expect(
        {
          code: r.status,
          stdout: r.stdout,
          unknown: r.stderr.includes(`error: unknown command '${name}'`),
        },
        `realm ${group} ${name}: exit ${String(r.status)}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      ).toEqual({ code: 1, stdout: '', unknown: true });
    },
    30_000,
  );
});
