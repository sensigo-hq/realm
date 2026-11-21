// retry-notice-g2ib.test.ts — gap 2, unit (i-b), check 12: the loader no longer calls `retry` inert
// on an agent step (realm agent and realm listen read it), a guard step's texts are unchanged, and
// for one release `realm workflow validate` prints an `ℹ` line for each agent step whose `retry` asks
// for fewer than 3 tries (an absent `max_attempts` is 1) — not under `--json`, and not a warning, so
// `--strict` passes. The built `realm` runs as a child process (fresh options each run).
//
// Every cell carries (a) the break that turns it red and (b) what it prints.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowFromStringWithDiagnostics } from '@sensigo/realm';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'realm-g2ib-notice-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function realm(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', REALM_NO_NUDGE: '1' },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const WORKFLOW = `id: g2ib-notice
name: g2ib-notice
version: 1
steps:
  once:
    description: a step
    execution: agent
    prompt: Do it.
    retry: { max_attempts: 1 }
  twice:
    description: a step
    execution: agent
    prompt: Do it.
    retry: { max_attempts: 2, total_timeout_seconds: 60 }
  absent:
    description: a step
    execution: agent
    prompt: Do it.
    retry: { backoff: fixed, base_delay_ms: 10 }
  three:
    description: a step
    execution: agent
    prompt: Do it.
    retry: { max_attempts: 3 }
`;

describe('gap 2, unit (i-b) — check 12: the loader', () => {
  it('no RETRY_INERT_NON_AUTO and no TOTAL_TIMEOUT_NON_AUTO on an agent step', () => {
    const { warnings } = loadWorkflowFromStringWithDiagnostics(WORKFLOW);
    // (a) red when the agent cell is left inert; (b) prints the codes it gave.
    expect(warnings.map((w) => w.code)).toEqual([]);
  });

  it("a guard step's two texts are unchanged", () => {
    const guard = (retry: string) => `id: g2ib-guard
name: g2ib-guard
version: 1
steps:
  g:
    description: a guard
    execution: guard
    abort_unless: ["g.ok == true"]
    retry: ${retry}
`;
    const bare = loadWorkflowFromStringWithDiagnostics(guard('{ max_attempts: 3 }')).warnings;
    const cap = loadWorkflowFromStringWithDiagnostics(
      guard('{ max_attempts: 3, total_timeout_seconds: 60 }'),
    ).warnings;
    // (a) red when a guard's text changes; (b) prints both.
    expect({
      bare: bare.map((w) => [w.code, w.message]),
      cap: cap.map((w) => [w.code, w.message]),
    }).toEqual({
      bare: [
        [
          'RETRY_INERT_NON_AUTO',
          "Step 'g': 'retry' is inert on execution: 'guard' steps — a guard's evaluation never traverses the dispatch path (its conditions are evaluated inline, with no dispatcher and no retry read), so this block can never mint a second attempt here.",
        ],
      ],
      cap: [
        [
          'TOTAL_TIMEOUT_NON_AUTO',
          "Step 'g': 'retry.total_timeout_seconds' is inert on execution: 'guard' steps — the cap only bounds 'execution: auto' dispatch; no other kind's dispatch ever consumes it.",
        ],
      ],
    });
  });
});

describe('gap 2, unit (i-b) — check 12: realm workflow validate, for one release', () => {
  it('the ℹ line for max_attempts 1, 2 and absent, and none for 3', () => {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, WORKFLOW, 'utf8');
    const r = realm(['workflow', 'validate', file]);
    // (a) red when the line is missing, worded otherwise, or printed for 3; (b) prints the lines.
    expect({
      code: r.code,
      lines: r.stdout.split('\n').filter((l) => l.startsWith('ℹ')),
    }).toEqual({
      code: 0,
      lines: [
        "ℹ Step 'once': 'retry' now applies here under realm agent and realm listen: each model request is tried once, where the model client tried up to 3 times before. Write 'max_attempts: 3' to keep today's count.",
        "ℹ Step 'twice': 'retry' now applies here under realm agent and realm listen: each model request is tried 2 times, where the model client tried up to 3 times before. Write 'max_attempts: 3' to keep today's count.",
        "ℹ Step 'absent': 'retry' now applies here under realm agent and realm listen: each model request is tried once, where the model client tried up to 3 times before. Write 'max_attempts: 3' to keep today's count.",
      ],
    });
  }, 30_000);

  it('none under --json, and --strict passes: the line is no warning', () => {
    const file = join(dir, 'workflow.yaml');
    writeFileSync(file, WORKFLOW, 'utf8');
    const json = realm(['workflow', 'validate', file, '--json']);
    const strict = realm(['workflow', 'validate', file, '--strict']);
    // (a) red when the line is printed under --json, or counted as a warning; (b) prints both.
    expect({
      jsonHasLine: json.stdout.includes('now applies here'),
      jsonParses: (() => {
        try {
          JSON.parse(json.stdout);
          return true;
        } catch {
          return false;
        }
      })(),
      strictCode: strict.code,
    }).toEqual({ jsonHasLine: false, jsonParses: true, strictCode: 0 });
  }, 30_000);
});
