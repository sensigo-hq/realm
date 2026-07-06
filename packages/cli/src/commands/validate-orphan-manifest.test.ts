// Command-level tests (#123 correction): the orphaned-manifest guard must fire on the
// EXTENSION-FREE `realm workflow validate` path — the from-string branch that #123's guard
// bypassed — and on every other workflow-loading command. These spawn the built dist CLI
// (NOT a loadProjectExtensions unit call): the #123 meta-lesson is that a unit call passed
// while the command path stayed blind, so coverage is asserted at the command boundary.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowCommands, topLevelCommands } from '../commands-registry.js';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_CLI = join(CLI_DIR, 'dist', 'index.js');

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, ...args], { timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err !== null && typeof err.code === 'number' ? err.code : err !== null ? 1 : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

// Repo-subdir topology: <base> is the trust root (package.json); the workflow lives in a
// nested dir with a STRAY realm.yaml in its own directory — the common misplacement.
let base: string;
let workflowDir: string;
let workflowPath: string;

const WORKFLOW_YAML = `id: orphan-wf
name: Orphan WF
version: 1
steps:
  s1:
    description: a step
    execution: agent
`;

const ORPHAN_MANIFEST = 'version: 1\nadapters:\n  fs2:\n    use: filesystem\n';

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'realm-validate-orphan-'));
  writeFileSync(join(base, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
  workflowDir = join(base, 'workflows', 'wf');
  mkdirSync(workflowDir, { recursive: true });
  workflowPath = join(workflowDir, 'workflow.yaml');
  writeFileSync(workflowPath, WORKFLOW_YAML, 'utf8');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('realm workflow validate — orphaned-manifest guard (extension-free from-string path)', () => {
  it('1. an orphaned realm.yaml in the workflow dir → Invalid: + non-zero exit', async () => {
    const orphan = join(workflowDir, 'realm.yaml');
    writeFileSync(orphan, ORPHAN_MANIFEST, 'utf8');
    const { code, stdout, stderr } = await runCli(['workflow', 'validate', workflowPath]);
    expect(code).toBe(1);
    expect(stdout).not.toContain('Valid:');
    const out = stdout + stderr;
    expect(out).toContain('Invalid:');
    expect(out).toContain(orphan);
    expect(out).toContain('will NOT be loaded');
    expect(out).toContain(join(base, 'realm.yaml')); // names the resolved trust root
  }, 25_000);

  it('2. byte-identical happy path: no orphan → exactly the Valid line, exit 0', async () => {
    const { code, stdout, stderr } = await runCli(['workflow', 'validate', workflowPath]);
    expect(stderr).toBe('');
    expect(stdout).toBe('Valid: orphan-wf v1 (1 steps)\n');
    expect(code).toBe(0);
  }, 25_000);
});

// #123's structural test was source-text string-matching — exactly the style that let the
// per-branch bypass through. This is BEHAVIORAL: every workflow-loading command in the
// `realm workflow` group that loads a definition for validation/execution is invoked against
// the orphan fixture and MUST reject it. The list is derived from commands-registry.ts's
// workflowCommands, minus the ones that do not load-a-workflow-to-run (init scaffolds,
// migrate rewrites, watch is a long-running watcher). ANY new step-executing / preflight
// command MUST either appear here or be justified — a silent per-branch bypass is the bug
// this test exists to prevent.
describe('every workflow-loading command rejects an orphaned manifest (behavioral enumeration)', () => {
  interface CommandCase {
    name: string;
    args: (wfPath: string, fixturesDir: string) => string[];
  }
  const cases: CommandCase[] = [
    { name: 'workflow validate', args: (wf) => ['workflow', 'validate', wf] },
    { name: 'workflow register', args: (wf) => ['workflow', 'register', wf] },
    { name: 'workflow run', args: (wf) => ['workflow', 'run', wf] },
    { name: 'workflow test', args: (wf, fx) => ['workflow', 'test', wf, '-f', fx] },
  ];

  it.each(cases)(
    '$name → non-zero exit + orphan message',
    async ({ args }) => {
      const orphan = join(workflowDir, 'realm.yaml');
      writeFileSync(orphan, ORPHAN_MANIFEST, 'utf8');
      // `test` needs an existing fixtures dir (checked before the load); its contents never
      // run because the guard throws first.
      const fixturesDir = join(workflowDir, 'fixtures');
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(
        join(fixturesDir, 'f.yaml'),
        'name: f\nexpected:\n  final_state: completed\n',
        'utf8',
      );

      // `run` reads stdin after loading — close it immediately so it can never hang; the guard
      // fires before the readline loop regardless.
      const { code, stdout, stderr } = await runCli(args(workflowPath, fixturesDir));
      const out = stdout + stderr;
      expect(code).not.toBe(0);
      expect(out).toContain('will NOT be loaded');
      expect(out).toContain(orphan);
    },
    25_000,
  );

  // ENFORCED enumeration (not comment-discipline): this feature was bitten twice by
  // coverage gaps (#123 missed validate; the coverage correction fixed it). Every command
  // group that can load a workflow — `workflowCommands` AND the top-level daemons
  // (`topLevelCommands`) — is partitioned into behaviorally-COVERED (derived from `cases`
  // above — never a second hand-list) or one of two EXCLUDED categories, and the test fails
  // if any command is unclassified. A newly-added loading command in EITHER array then
  // forces a conscious classification.
  //
  // The two exclusion categories mean DIFFERENT things — do not conflate them:
  //   GUARD_NOT_APPLICABLE — the command does not load a workflow-from-path to run, so the
  //     orphan guard genuinely never fires for it.
  //   GUARDED_VIA_CHOKEPOINT_NOT_SPAWN_TESTED — the command DOES load workflows and IS
  //     functionally guarded (it reaches loadProjectExtensions → loadManifestContext), but is
  //     not spawn-exercised here because it needs a daemon harness (provider keys / triggers /
  //     request drivers). Excluded from the BEHAVIORAL cases, NOT from the guard.
  const GUARD_NOT_APPLICABLE: Record<string, string> = {
    init: 'scaffolds a new workflow; loads no existing definition',
    migrate: 'rewrites a workflow file in place; does not load-to-run',
    webhook: "removed alias (use 'realm listen'); loads no workflow",
  };
  const GUARDED_VIA_CHOKEPOINT_NOT_SPAWN_TESTED: Record<string, string> = {
    watch: 'loads via register.ts (functionally guarded through register); not spawn-tested here',
    agent:
      'reaches the orphan guard via the loadProjectExtensions chokepoint (functionally guarded); not spawn-exercised here — needs a daemon harness',
    listen:
      'reaches the orphan guard via the loadProjectExtensions chokepoint (functionally guarded); not spawn-exercised here — needs a daemon harness',
    serve:
      'reaches the orphan guard via the loadProjectExtensions chokepoint (functionally guarded); not spawn-exercised here — needs a daemon harness',
    mcp: 'reaches the orphan guard via the loadProjectExtensions chokepoint (functionally guarded); not spawn-exercised here — needs a daemon harness',
  };

  it('every workflow-loading command (workflow + top-level) is behaviorally covered or explicitly excluded', () => {
    // COVERED is the subcommand encoded at args(...)[1] of each behavioral case — dummy
    // inputs are fine, we only read the subcommand slot (e.g. ['workflow','validate','x'][1]).
    const covered = new Set(cases.map((c) => c.args('x', 'y')[1]));
    const unclassified = [...workflowCommands, ...topLevelCommands]
      .map((c) => c.name())
      .filter(
        (n) =>
          !covered.has(n) &&
          !(n in GUARD_NOT_APPLICABLE) &&
          !(n in GUARDED_VIA_CHOKEPOINT_NOT_SPAWN_TESTED),
      );
    // A new command in either array MUST be added to `cases` (behaviorally exercised against
    // the orphan) or to one of the two exclusion maps (with a reason that states WHICH kind
    // of exclusion it is).
    expect(unclassified).toEqual([]);
  });
});
