// project-code-where-625.test.ts — issue #625 PR-2a, on the built CLI:
// - decision C98 (the review walk's J2-a): `realm run respond`'s owed line and `realm run advance`'s
//   header say what comes from where — the folder the step's project code is loaded from (the
//   workflow's own project, whatever folder the shell is in) and that the environment is the
//   shell's. Executed from an UNRELATED folder: the project's code is the code that runs.
// - decision C95 (the walk's J3-a): `realm run advance` on a run whose open question's time is up
//   carries out its declared `on_expiry` (`settle_default`: the owed step runs; `abort`: the run ends).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  executeStep,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { projectCodeWhere, laterAdvanceCodeWhere, runAdvanceCommand } from './run-advance.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
if (!existsSync(CLI_ENTRY)) {
  throw new Error(`cli dist not built — run \`npm run build\` first (looked for: ${CLI_ENTRY})`);
}

const YAML = (onExpiry: string) => `id: pcw-${onExpiry}
name: project code where
version: 1
extensions:
  - ../../dist/registry.js
steps:
  confirm:
    description: Confirm.
    execution: auto
    trust: human_confirmed
    gate:
      choices: [approve, reject]
      timeout_seconds: 60
${onExpiry === 'none' ? '' : `      on_expiry: ${onExpiry}\n`}${onExpiry === 'settle_default' ? '      default_choice: approve\n' : ''}  after:
    description: After.
    execution: auto
    handler: mark
    depends_on: [confirm]
  finish:
    description: Finish.
    execution: agent
    depends_on: [after]
`;

describe('#625 PR-2a, C98 and C95 — where the code comes from; advance carries out a due expiry', () => {
  let home: string;
  let proj: string;
  let elsewhere: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-pcw-home-'));
    proj = realpathSync(mkdtempSync(join(tmpdir(), 'realm-pcw-proj-')));
    elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'realm-pcw-elsewhere-')));
  });
  afterEach(() => {
    for (const d of [home, proj, elsewhere]) rmSync(d, { recursive: true, force: true });
  });

  function realm(cwd: string, args: string[]) {
    const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, HOME: home, REALM_OPERATOR: 'tester' },
      cwd,
      encoding: 'utf8',
    });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? -1 };
  }

  /** The project (a handler that marks its output), registered from its own folder; a run at the gate. */
  async function atGate(onExpiry: 'settle_default' | 'abort' | 'none', expired: boolean) {
    mkdirSync(join(proj, 'dist'), { recursive: true });
    mkdirSync(join(proj, 'workflows', 'wf'), { recursive: true });
    writeFileSync(join(proj, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
    writeFileSync(
      join(proj, 'dist', 'registry.js'),
      `export default { handlers: { mark: { id: 'mark', execute: async () => ({ data: { from: 'the project' } }) } } };`,
      'utf8',
    );
    writeFileSync(join(proj, 'workflows', 'wf', 'workflow.yaml'), YAML(onExpiry), 'utf8');
    const registered = realm(proj, ['workflow', 'register', 'workflows/wf/workflow.yaml']);
    if (registered.status !== 0) throw new Error(`fixture: register failed: ${registered.stderr}`);
    const definition: WorkflowDefinition = await new JsonWorkflowStore(
      join(home, '.realm', 'workflows'),
    ).get(`pcw-${onExpiry}`);
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const { run } = await runs.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(runs, definition, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    let r = await runs.get(run.id);
    if (expired) {
      r = await runs.update({
        ...r,
        pending_gate: {
          ...r.pending_gate!,
          expires_at: new Date(Date.now() - 60_000).toISOString(),
        },
      });
    }
    return { runs, runId: run.id, gateId: r.pending_gate!.gate_id, definition };
  }

  it('C98: from an unrelated folder, respond names the project folder for advance, advance names it in its header, and the project code is what runs', async () => {
    const { runs, runId, gateId, definition } = await atGate('none', false);
    // The workflow's own project is its trust root, not the shell's folder.
    expect(definition.trust_root).toBe(proj);
    const responded = realm(elsewhere, [
      'run',
      'respond',
      runId,
      '--gate',
      gateId,
      '--choice',
      'approve',
    ]);
    expect(responded.status).toBe(0);
    // (a) red when the owed line says the shell's folder is used, or drops where the code comes
    // from; (b) prints the whole stdout.
    expect(responded.stdout.trim()).toBe(
      `Responded: ${runId} | choice 'approve' | new state 'running'\n` +
        `Owed to the engine: 'after' — realm run advance ${runId} runs it, with the project code under ${proj}, in the environment of the shell it runs in.`,
    );
    const advanced = realm(elsewhere, ['run', 'advance', runId]);
    expect(advanced.status).toBe(0);
    // (a) red when the header names the shell's folder (`elsewhere`) — decision C98's falsity —
    // or drops the environment clause; (b) prints the header.
    expect(advanced.stdout.split('\n')[0]).toBe(
      `Advancing run ${runId} (workflow 'pcw-none') with the project code under ${proj}, in this shell's environment.`,
    );
    expect(advanced.stdout).not.toContain(elsewhere);
    // (a) red when another program's code ran the step; (b) prints the recorded output.
    const entry = (await runs.get(runId)).evidence.find((e) => e.step_id === 'after');
    expect(entry?.output_summary).toEqual({ from: 'the project' });
  }, 60_000);

  it('C95: realm run advance carries out an expired settle_default — the owed step runs; the expiry is said', async () => {
    const { runs, runId, gateId } = await atGate('settle_default', true);
    const advanced = realm(proj, ['run', 'advance', runId]);
    expect(advanced.status).toBe(0);
    const lines = advanced.stdout.trim().split('\n');
    // (a) red when the view does not name the due expiry as owed (advance would print "Nothing is
    // owed" and stop); (b) prints the lines.
    expect(lines.slice(3, 5)).toEqual([
      "Owed to the engine: the expired question on 'confirm' (its declared settle_default).",
      '→ after',
    ]);
    // (a) red when the disclosure is not printed; (b) prints stderr.
    expect(advanced.stderr).toContain(
      `⚠ gate '${gateId}' on 'confirm' had expired — enacted declared settle_default before this advance call (enacted_via: advance).`,
    );
    const after = await runs.get(runId);
    // (a) red when the default is not settled, or the owed step does not run; (b) prints the record.
    expect({
      choice: after.settled?.['confirm']?.choice,
      resolved_by: after.settled?.['confirm']?.resolved_by,
      completed: after.completed_steps,
    }).toEqual({ choice: 'approve', resolved_by: 'timeout', completed: ['confirm', 'after'] });
  }, 60_000);

  it('C95: realm run advance carries out an expired abort — the run ends aborted, nothing after it runs', async () => {
    const { runs, runId } = await atGate('abort', true);
    const advanced = realm(proj, ['run', 'advance', runId]);
    expect(advanced.status).toBe(0);
    const lines = advanced.stdout.trim().split('\n');
    // (a) red when the abort is not carried out; (b) prints the lines.
    expect(lines.slice(3)).toEqual([
      "Owed to the engine: the expired question on 'confirm' (its declared abort).",
      'Stopped: the run has ended (aborted)',
      `Run ${runId}: phase 'aborted'`,
    ]);
    expect((await runs.get(runId)).completed_steps).toEqual([]);
  }, 60_000);

  it('C98, every member of the words: trust_root wins over the shell and --project; no trust_root: --project, else the shell; --extensions-module names its module and the root', () => {
    // (a) red when a member names the wrong folder or drops a clause; (b) prints the words.
    expect(projectCodeWhere({ trust_root: '/p/proj' }, { project: 'other' }, '/sh')).toBe(
      'the project code under /p/proj',
    );
    expect(projectCodeWhere({}, { project: 'deploy' }, '/sh')).toBe(
      'the project code under /sh/deploy',
    );
    expect(projectCodeWhere({}, {}, '/sh')).toBe('the project code under /sh');
    expect(
      projectCodeWhere({ trust_root: '/p/proj' }, { extensionsModule: 'fix/mod.mjs' }, '/sh'),
    ).toBe('the module /sh/fix/mod.mjs (--extensions-module) and the realm.yaml of /p/proj');
    expect(laterAdvanceCodeWhere({ trust_root: '/p/proj' })).toBe('the project code under /p/proj');
    expect(laterAdvanceCodeWhere({})).toBe(
      'the project code under the folder it runs in (or its --project)',
    );
  });

  it("C95: `realm run advance`'s help says it carries out an expired question's declared on_expiry", () => {
    // (a) red when the description drops the expiry; (b) prints it.
    expect(runAdvanceCommand.description()).toBe(
      "Run what a run owes the engine — an expired question's declared on_expiry, then its guards and automatic steps — from this shell, with no model provider and no key",
    );
  });
});
