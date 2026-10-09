// owed-call-625.test.ts — issue #625 PR-2a, the CLI surfaces of the owed call, through the BUILT CLI
// with a scratch HOME each: `realm run advance` (preview, Stopped:, exit code), `realm run respond`
// (derived phase, answerer, owed line), `realm run inspect`, `realm run drain` (no-gate arm),
// `realm run resume`. Whole-message pins.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type RunRecord,
} from '@sensigo/realm';
import { printChildrenWhenATestFails } from '../test-support/child-output.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
if (!existsSync(CLI_ENTRY)) {
  throw new Error(`cli dist not built — run \`npm run build\` first (looked for: ${CLI_ENTRY})`);
}
const children = printChildrenWhenATestFails();

function realm(home: string, args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, HOME: home, REALM_OPERATOR: 'tester' },
    cwd: home,
    encoding: 'utf8',
  });
  children.record({ args: [CLI_ENTRY, ...args], ...r });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? -1 };
}

const gateThenAuto: WorkflowDefinition = {
  id: 'cli-owed-wf',
  name: 'cli owed',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    confirm: {
      description: 'Confirm.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'] },
    },
    after: { description: 'After.', execution: 'auto', depends_on: ['confirm'] },
    finish: { description: 'Finish.', execution: 'agent', depends_on: ['after'] },
  },
};

async function setup(): Promise<{
  home: string;
  runs: JsonFileStore;
  run: RunRecord;
  gateId: string;
}> {
  const home = mkdtempSync(join(tmpdir(), 'realm-owed-cli-625-'));
  const runs = new JsonFileStore(join(home, '.realm', 'runs'));
  await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(gateThenAuto);
  const { run } = await runs.create({
    workflowId: gateThenAuto.id,
    workflowVersion: 1,
    params: {},
  });
  await executeStep(runs, gateThenAuto, {
    runId: run.id,
    command: 'confirm',
    input: {},
    dispatcher: async () => ({}),
  });
  const gateId = (await runs.get(run.id)).pending_gate!.gate_id;
  return { home, runs, run, gateId };
}

describe('#625 PR-2a — the CLI names the owed call, and runs it', () => {
  it('respond: derived phase, the stated answerer, and the owed line; then advance runs it', async () => {
    const { home, run, gateId } = await setup();
    try {
      const responded = realm(home, [
        'run',
        'respond',
        run.id,
        '--gate',
        gateId,
        '--choice',
        'approve',
        '--by',
        'alice',
      ]);
      expect(responded.status).toBe(0);
      expect(responded.stdout.trim()).toBe(
        `Responded: ${run.id} | choice 'approve' | answered by alice (as stated) | new state 'running'\n` +
          // decision C98: where the code comes from (this definition has no trust_root: the folder
          // advance runs in) and that the environment is that shell's.
          `Owed to the engine: 'after' — realm run advance ${run.id} runs it, with the project code under the folder it runs in (or its --project), in the environment of the shell it runs in.\n` +
          // decision C164: the attending line after the command an answer leaves.
          'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
      );

      const inspected = realm(home, ['run', 'inspect', run.id]);
      expect(inspected.stdout).toContain(
        `Owed to the engine: 'after' — realm run advance ${run.id}`,
      );

      const drained = realm(home, ['run', 'drain', run.id]);
      expect(drained.stdout.trim()).toBe(
        `Run '${run.id}' is not terminal (phase: 'running') — nothing to drain. ` +
          `To run the step the engine owes ('after'): realm run advance ${run.id}\nTo end the run instead: realm run abandon ${run.id}`,
      );

      const advanced = realm(home, ['run', 'advance', run.id]);
      expect(advanced.status).toBe(0);
      const lines = advanced.stdout.trim().split('\n');
      expect(lines[0]).toBe(
        // decision C107: this folder holds no project code (no realm.yaml, no module) — said so.
        `Advancing run ${run.id} (workflow 'cli-owed-wf') with no project code (nothing to load under ${home}), in this shell's environment.`,
      );
      expect(lines[1]).toBe(
        'This program: tester (from REALM_OPERATOR) · project code: neither side records project code.',
      );
      expect(lines[2]).toBe('Last recorded driver: none recorded.');
      expect(lines[3]).toBe("Owed to the engine: 'after'.");
      expect(lines[4]).toBe('→ after');
      expect(lines[5]).toBe(
        `Stopped: an agent step is ready: 'finish' — drive it with realm agent --run-id ${run.id} --provider <provider> --model <model>`,
      );
      // decision C181: the waiting-process line `realm run respond` prints after its commands.
      expect(lines[6]).toBe(
        'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
      );
      expect(lines[7]).toBe(`Run ${run.id}: phase 'running'`);

      // A repeat with nothing owed: the preview's last line says why, exit 0.
      const again = realm(home, ['run', 'advance', run.id]);
      expect(again.status).toBe(0);
      expect(again.stdout.trim().split('\n').slice(2)).toEqual([
        "Last recorded driver: tester (from REALM_OPERATOR, via advance) at step 'after', " +
          (again.stdout.match(/at step 'after', (\S+)\./)?.[1] ?? '') +
          '.',
        `Nothing is owed to the engine: an agent step is ready: 'finish' — drive it with realm agent --run-id ${run.id} --provider <provider> --model <model>`,
        'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);

  it('advance: a refused step stops it with exit 1 and names the check', async () => {
    const home = mkdtempSync(join(tmpdir(), 'realm-owed-cli-625-'));
    try {
      const d: WorkflowDefinition = {
        id: 'cli-refused-wf',
        name: 'cli refused',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          a: {
            description: 'A.',
            execution: 'auto',
            depends_on: [],
            preconditions: ['nothing.ok == true'],
          },
          b: { description: 'B.', execution: 'auto', depends_on: [] },
        },
      };
      await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(d);
      const runs = new JsonFileStore(join(home, '.realm', 'runs'));
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      const advanced = realm(home, ['run', 'advance', run.id]);
      expect(advanced.status).toBe(1);
      expect(advanced.stdout).toContain('→ b');
      expect(advanced.stdout).toContain(
        "Stopped: 'a' cannot run (precondition): Precondition failed for step 'a'. Precondition failed: 'nothing.ok == true'. Resolved value: undefined.",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);

  it('advance: a malformed REALM_OPERATOR prints one line and exits 1 before any work', async () => {
    const { home, run } = await setup();
    try {
      const r = spawnSync(process.execPath, [CLI_ENTRY, 'run', 'advance', run.id], {
        env: { ...process.env, HOME: home, REALM_OPERATOR: 'bad\u0007name' },
        cwd: home,
        encoding: 'utf8',
      });
      children.record({ args: [CLI_ENTRY, 'run', 'advance', run.id], ...r });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim().split('\n')).toHaveLength(1);
      expect(r.stderr).toContain('REALM_OPERATOR');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);

  it('drain --expired --force that leaves the run open names the owed call after its line', async () => {
    const home = mkdtempSync(join(tmpdir(), 'realm-owed-cli-625-'));
    try {
      const d: WorkflowDefinition = {
        id: 'cli-expiry-owed-wf',
        name: 'cli expiry owed',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          confirm: {
            description: 'Confirm.',
            execution: 'auto',
            trust: 'human_confirmed',
            depends_on: [],
            gate: {
              choices: ['approve', 'reject'],
              timeout_seconds: 1,
              on_expiry: 'settle_default',
              default_choice: 'approve',
            },
          },
          after: { description: 'After.', execution: 'auto', depends_on: ['confirm'] },
          finish: { description: 'Finish.', execution: 'agent', depends_on: ['after'] },
        },
      };
      await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(d);
      const runs = new JsonFileStore(join(home, '.realm', 'runs'));
      const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await executeStep(runs, d, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      await new Promise((r) => setTimeout(r, 1300));
      const drained = realm(home, ['run', 'drain', run.id, '--expired', '--force']);
      expect(drained.status).toBe(0);
      expect(drained.stdout).toContain(
        `Run '${run.id}' is not terminal (phase: 'running') — nothing further to drain.\n` +
          `To run the step the engine owes ('after'): realm run advance ${run.id}`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60000);
});
