// project-code-where-625.test.ts — issue #625 PR-2a, on the built CLI:
// - decision C98 (the review walk's J2-a): `realm run respond`'s owed line and `realm run advance`'s
//   header say what comes from where — the folder the step's project code is loaded from (the
//   workflow's own project, whatever folder the shell is in) and that the environment is the
//   shell's. Executed from an UNRELATED folder: the project's code is the code that runs.
// - decision C95 (the walk's J3-a): `realm run advance` on a run whose open question's time is up
//   carries out its declared `on_expiry` (`settle_default`: the owed step runs; `abort`: the run ends).
// - decisions C105, C109 (round 15): the expiry line says what this call did, and it is printed by
//   the command from the reply's warnings — core prints nothing.
// - decisions C107, C108 (round 15): a workflow with no project code is said to have none; a
//   `--project` the workflow's own project overrides is said — both from an unrelated folder.
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
import {
  projectCodeWhere,
  laterAdvanceCodeWhere,
  projectNotUsedLine,
  projectWords,
  runAdvanceCommand,
  PROJECT_OPTION_HELP,
} from './run-advance.js';
import { respondCommand } from './respond.js';
import { printChildrenWhenATestFails } from '../test-support/child-output.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
if (!existsSync(CLI_ENTRY)) {
  throw new Error(`cli dist not built — run \`npm run build\` first (looked for: ${CLI_ENTRY})`);
}
const children = printChildrenWhenATestFails();
/** A load that found no project code and read no realm.yaml (decisions C107, C209). */
const NO_CODE = { hasCode: false, readsManifest: false };

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
    children.record({ args: [CLI_ENTRY, ...args], ...r });
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
        `Owed to the engine: 'after' — realm run advance ${runId} runs it, with the project code under ${proj}, in the environment of the shell it runs in.\n` +
        // decision C164: the attending line after the command an answer leaves.
        'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
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
    // decision C123: the expiry line is printed when the call carries the expiry out — before the
    // step it led to — and once.
    // (a) red when the view does not name the due expiry as owed (advance would print "Nothing is
    // owed" and stop), when the line comes after the step, says "before this call" or drops the
    // default choice; (b) prints the lines.
    expect(lines.slice(3, 6)).toEqual([
      "Owed to the engine: the expired question on 'confirm' (its declared settle_default); then it runs what that leaves owed until a step opens a question, fails or ends the run.",
      `⚠ gate '${gateId}' on 'confirm' had expired — this advance call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: advance).`,
      '→ after',
    ]);
    expect(lines.filter((l) => l.includes('had expired'))).toHaveLength(1);
    // (a) red when core prints the line itself (C109); (b) prints stderr.
    expect(advanced.stderr).not.toContain('had expired');
    const after = await runs.get(runId);
    // (a) red when the default is not settled, or the owed step does not run; (b) prints the record.
    expect({
      choice: after.settled?.['confirm']?.choice,
      resolved_by: after.settled?.['confirm']?.resolved_by,
      completed: after.completed_steps,
    }).toEqual({ choice: 'approve', resolved_by: 'timeout', completed: ['confirm', 'after'] });
  }, 60_000);

  it('C95: realm run advance carries out an expired abort — the run ends aborted, nothing after it runs', async () => {
    const { runs, runId, gateId } = await atGate('abort', true);
    const advanced = realm(proj, ['run', 'advance', runId]);
    expect(advanced.status).toBe(0);
    const lines = advanced.stdout.trim().split('\n');
    // (a) red when the abort is not carried out, or its line (C105) is not rendered; (b) prints the lines.
    expect(lines.slice(3)).toEqual([
      "Owed to the engine: the expired question on 'confirm' (its declared abort).",
      `⚠ gate '${gateId}' on 'confirm' had expired — this advance call first carried out its declared abort: the run ended (enacted_via: advance).`,
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
    // decision C209: the realm.yaml is named only when the load read one.
    expect(
      projectCodeWhere({ trust_root: '/p/proj' }, { extensionsModule: 'fix/mod.mjs' }, '/sh', {
        hasCode: true,
        readsManifest: false,
      }),
    ).toBe('the module /sh/fix/mod.mjs (--extensions-module)');
    expect(laterAdvanceCodeWhere({ trust_root: '/p/proj' })).toBe('the project code under /p/proj');
    expect(laterAdvanceCodeWhere({})).toBe(
      'the project code under the folder it runs in (or its --project)',
    );
    // decision C107: no project code — said, with the folder nothing was found under.
    expect(projectCodeWhere({ trust_root: '/p/proj' }, {}, '/sh', NO_CODE)).toBe(
      'no project code (nothing to load under /p/proj)',
    );
    expect(laterAdvanceCodeWhere({ trust_root: '/p/proj' }, false)).toBe(
      'no project code (nothing to load under /p/proj)',
    );
    // decision C108: the line for a --project not used; none when it was used or not given.
    expect(projectNotUsedLine({ id: 'w', trust_root: '/p/proj' }, { project: 'other' })).toBe(
      "--project other was not used: workflow 'w' has its own project, /p/proj, and its code is loaded from there.",
    );
    expect(projectNotUsedLine({ id: 'w' }, { project: 'other' })).toBe(undefined);
    expect(projectNotUsedLine({ id: 'w', trust_root: '/p/proj' }, {})).toBe(undefined);
  });

  it("C103: realm run advance at an open question prints the reply's line — the question's respond command", async () => {
    const { runId, gateId } = await atGate('none', false);
    const advanced = realm(elsewhere, ['run', 'advance', runId]);
    expect(advanced.status).toBe(0);
    // (a) red when the line is not printed, or names another gate or choices; (b) prints stdout.
    expect(advanced.stdout.trim().split('\n').at(-1)).toBe(
      `Nothing is owed to the engine: a question is open — realm run respond ${runId} --gate ${gateId} --choice <one of: approve, reject>`,
    );
  }, 60_000);

  it('C107: a workflow with no project code, from an unrelated folder — respond and advance say it has none', async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'realm-pcw-bare-')));
    try {
      mkdirSync(join(bare, 'wf'), { recursive: true });
      writeFileSync(
        join(bare, 'wf', 'workflow.yaml'),
        YAML('none')
          .replace('id: pcw-none', 'id: pcw-bare')
          .replace('extensions:\n  - ../../dist/registry.js\n', '')
          .replace('    handler: mark\n', ''),
        'utf8',
      );
      const registered = realm(bare, ['workflow', 'register', 'wf/workflow.yaml']);
      expect(registered.status).toBe(0);
      const definition = await new JsonWorkflowStore(join(home, '.realm', 'workflows')).get(
        'pcw-bare',
      );
      const root = definition.trust_root!;
      const runs = new JsonFileStore(join(home, '.realm', 'runs'));
      const { run } = await runs.create({ workflowId: 'pcw-bare', workflowVersion: 1, params: {} });
      await executeStep(runs, definition, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      const gateId = (await runs.get(run.id)).pending_gate!.gate_id;
      const responded = realm(elsewhere, [
        'run',
        'respond',
        run.id,
        '--gate',
        gateId,
        '--choice',
        'approve',
      ]);
      // (a) red when respond says "the project code under" a folder with none; (b) prints stdout.
      expect(responded.stdout).toContain(
        `realm run advance ${run.id} runs it, with no project code (nothing to load under ${root}), in the environment of the shell it runs in.`,
      );
      const advanced = realm(elsewhere, ['run', 'advance', run.id]);
      // (a) red when advance's header says "the project code under" a folder with none; (b) prints it.
      expect(advanced.stdout.split('\n')[0]).toBe(
        `Advancing run ${run.id} (workflow 'pcw-bare') with no project code (nothing to load under ${root}), in this shell's environment.`,
      );
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, 60_000);

  it('C108: --project on respond and advance, from an unrelated folder, for a workflow with its own project — a line says it was not used and names the project', async () => {
    const { runId, gateId } = await atGate('none', false);
    const line = `--project ${elsewhere} was not used: workflow 'pcw-none' has its own project, ${proj}, and its code is loaded from there.`;
    const responded = realm(elsewhere, [
      'run',
      'respond',
      runId,
      '--gate',
      gateId,
      '--choice',
      'approve',
      '--project',
      elsewhere,
    ]);
    expect(responded.status).toBe(0);
    // (a) red when respond ignores --project without a word; (b) prints stdout.
    expect(responded.stdout.split('\n')[0]).toBe(line);
    const advanced = realm(elsewhere, ['run', 'advance', runId, '--project', elsewhere]);
    // (a) red when advance ignores --project without a word; (b) prints stdout.
    expect(advanced.stdout.split('\n').slice(0, 2)).toEqual([
      `Advancing run ${runId} (workflow 'pcw-none') with the project code under ${proj}, in this shell's environment.`,
      line,
    ]);
  }, 60_000);

  it("C95: `realm run advance`'s help says it carries out an expired question's declared on_expiry", () => {
    // (a) red when the description drops the expiry; (b) prints it.
    expect(runAdvanceCommand.description()).toBe(
      "Run what a run owes the engine — an expired question's declared on_expiry, then its guards and automatic steps — from this shell, with no model provider and no key",
    );
  });
  it('C121: one composer for the project words — every member; the not-used line says (no project code there) when the project holds none', () => {
    // (a) red when a member's two halves disagree about code, or a clause is dropped; (b) prints it.
    expect(
      projectWords({ id: 'w', trust_root: '/p/proj' }, { project: 'other' }, '/sh', {
        hasCode: true,
        readsManifest: true,
      }),
    ).toEqual({
      where: 'the project code under /p/proj',
      notUsed:
        "--project other was not used: workflow 'w' has its own project, /p/proj, and its code is loaded from there.",
    });
    expect(
      projectWords({ id: 'w', trust_root: '/p/proj' }, { project: 'other' }, '/sh', NO_CODE),
    ).toEqual({
      where: 'no project code (nothing to load under /p/proj)',
      notUsed:
        "--project other was not used: workflow 'w' has its own project, /p/proj (no project code there).",
    });
    expect(projectWords({ id: 'w', trust_root: '/p/proj' }, {}, '/sh', NO_CODE)).toEqual({
      where: 'no project code (nothing to load under /p/proj)',
    });
    expect(projectWords({ id: 'w' }, { project: 'deploy' }, '/sh', NO_CODE)).toEqual({
      where: 'no project code (nothing to load under /sh/deploy)',
    });
    // (a) red when the two exported readers do not read the one composer; (b) prints them.
    expect(
      projectNotUsedLine({ id: 'w', trust_root: '/p/proj' }, { project: 'other' }, NO_CODE),
    ).toBe(
      "--project other was not used: workflow 'w' has its own project, /p/proj (no project code there).",
    );
    expect(projectCodeWhere({ trust_root: '/p/proj' }, {}, '/sh', NO_CODE)).toBe(
      'no project code (nothing to load under /p/proj)',
    );
  });

  it('C121, W4-R1: --project on a workflow whose own project holds no code — respond and advance say (no project code there), never that its code is loaded', async () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'realm-pcw-bare-')));
    try {
      mkdirSync(join(bare, 'wf'), { recursive: true });
      writeFileSync(
        join(bare, 'wf', 'workflow.yaml'),
        YAML('none')
          .replace('id: pcw-none', 'id: pcw-bare2')
          .replace('extensions:\n  - ../../dist/registry.js\n', '')
          .replace('    handler: mark\n', ''),
        'utf8',
      );
      expect(realm(bare, ['workflow', 'register', 'wf/workflow.yaml']).status).toBe(0);
      const definition = await new JsonWorkflowStore(join(home, '.realm', 'workflows')).get(
        'pcw-bare2',
      );
      const root = definition.trust_root!;
      const runs = new JsonFileStore(join(home, '.realm', 'runs'));
      const { run } = await runs.create({
        workflowId: 'pcw-bare2',
        workflowVersion: 1,
        params: {},
      });
      await executeStep(runs, definition, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      const gateId = (await runs.get(run.id)).pending_gate!.gate_id;
      const line = `--project ${elsewhere} was not used: workflow 'pcw-bare2' has its own project, ${root} (no project code there).`;
      const advanced = realm(elsewhere, ['run', 'advance', run.id, '--project', elsewhere]);
      // (a) red when the not-used line says "its code is loaded from there" beside "no project
      // code"; (b) prints stdout.
      expect(advanced.stdout.split('\n').slice(0, 2)).toEqual([
        `Advancing run ${run.id} (workflow 'pcw-bare2') with no project code (nothing to load under ${root}), in this shell's environment.`,
        line,
      ]);
      const responded = realm(elsewhere, [
        'run',
        'respond',
        run.id,
        '--gate',
        gateId,
        '--choice',
        'approve',
        '--project',
        elsewhere,
      ]);
      expect(responded.status).toBe(0);
      // (a) red when respond's line disagrees with its own later-advance words; (b) prints stdout.
      expect(responded.stdout.split('\n')[0]).toBe(line);
      expect(responded.stdout).not.toContain('its code is loaded from there');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, 60_000);

  it("C121, W4-Y1: respond's and advance's --project help says when it is used and that a workflow registered from a folder loads from there", () => {
    for (const command of [runAdvanceCommand, respondCommand]) {
      const help = command.options.find((o) => o.long === '--project')?.description;
      // (a) red when the help speaks of a config anchor and trust_root again, or the commands
      // disagree; (b) prints it.
      expect({ command: command.name(), help }).toEqual({
        command: command.name(),
        help: PROJECT_OPTION_HELP,
      });
    }
    expect(PROJECT_OPTION_HELP).toBe(
      'Used only for a workflow registered without a project folder (made by an agent or from a string): the folder whose realm.yaml and code it loads (default: current directory). A workflow registered from a folder loads its code from there, and --project is not used.',
    );
  });
});
