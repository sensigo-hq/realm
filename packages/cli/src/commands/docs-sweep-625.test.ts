// docs-sweep-625.test.ts — issue #625 PR-2a, decision C174 (round 22): the falsified-statement sweep
// over every doc page that describes a surface #625 PR-2a changes. Each sentence or screen the sweep
// corrected that says what a `realm` command prints is quoted here (read from the repository) and the
// case is run on the built `realm` (fresh HOME), so neither the page nor the command can change
// alone. A screen is compared line by line, with its run, gate IDs and folders put in place.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceRunFromShell, runAdvanceCommand } from './run-advance.js';
import {
  ExtensionRegistry,
  JsonFileStore,
  JsonWorkflowStore,
  advanceRun,
  executeChain,
  executeStep,
  loadWorkflowFromString,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const flat = (t: string) => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** The lines of the page's first fenced block that holds `marker`. */
function block(page: string, marker: string): string[] {
  const text = readFileSync(join(ROOT, page), 'utf8');
  const blocks = text.split(/^```[a-z]*\n/m).filter((_, i) => i % 2 === 1);
  const found = blocks.find((b) => b.includes(marker));
  if (found === undefined) throw new Error(`${page} has no block with: ${marker}`);
  return found.replace(/\n```[\s\S]*$/, '').split('\n');
}

const wf = (yaml: string): WorkflowDefinition => loadWorkflowFromString(yaml);

describe(
  '#625 PR-2a, C174 — the sweep’s corrected screens and sentences, from the built realm',
  { timeout: 60_000 },
  () => {
    let home: string;
    let runStore: JsonFileStore;
    let workflowStore: JsonWorkflowStore;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'realm-625-sweep-cli-'));
      mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
      runStore = new JsonFileStore(join(home, '.realm', 'runs'));
      workflowStore = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    function realm(
      args: string[],
      env: Record<string, string> = {},
    ): { code: number | null; out: string[]; err: string[] } {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: home,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1', ...env },
        encoding: 'utf8',
        timeout: 60_000,
      });
      const lines = (t: string) => t.split('\n').filter((l) => l !== '');
      return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
    }

    async function started(def: WorkflowDefinition, params: Record<string, unknown> = {}) {
      await workflowStore.register(def);
      const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params });
      return run.id;
    }

    it('realm-run-acting.md, realm-run-reading.md: realm run has seventeen subcommands, eleven that act, each in the table; advance has its synopsis', () => {
      claim(
        'docs/reference/cli/realm-run-acting.md',
        '`realm run` has seventeen subcommands. This page covers the eleven that change a run or the store.',
      );
      claim(
        'docs/reference/cli/realm-run-reading.md',
        '`realm run` has seventeen subcommands. This page covers the six that only read: they change no run. The other eleven are in',
      );
      const help = realm(['run', '--help']).out;
      const commands = help
        .slice(help.findIndex((l) => l === 'Commands:') + 1)
        .filter((l) => /^ {2}[a-z]/.test(l))
        .map((l) => l.trim().split(' ')[0]!)
        .filter((c) => c !== 'help');
      const acting = readFileSync(join(ROOT, 'docs/reference/cli/realm-run-acting.md'), 'utf8');
      const rows = [...acting.matchAll(/^\| \[`([a-z]+)`\]\(#/gm)].map((m) => m[1]!);
      const usage = realm(['run', 'advance', '--help']).out[0]!;
      // (a) red when a subcommand is added or removed without the pages, or advance's synopsis
      //     drifts from its usage; (b) prints what --help lists.
      expect([commands.length, rows.length, rows.every((r) => commands.includes(r))]).toEqual([
        17,
        11,
        true,
      ]);
      expect(usage).toBe('Usage: realm run advance [options] <run-id>');
      expect(block('docs/reference/cli/realm-run-acting.md', 'realm run advance <run-id>')[0]).toBe(
        'realm run advance <run-id> [--project <dir>] [--extensions-module <path>]',
      );
      for (const flag of ['--project <dir>', '--extensions-module <path>']) {
        expect(realm(['run', 'advance', '--help']).out.join('\n')).toContain(flag);
      }
    });

    it('realm-run-acting.md: drain names seven `is not terminal … nothing to drain` lines (decision C205: an agent step ready, a step in flight), and --force exits 1 on one (a run that owes an engine step)', async () => {
      claim(
        'docs/reference/cli/realm-run-acting.md',
        'if `--force` prints one of the seven `is not terminal … nothing to drain` lines above,',
      );
      const shown = block(
        'docs/reference/cli/realm-run-acting.md',
        'nothing to drain. To end the run:',
      );
      expect(
        shown.filter((l) => l.includes('is not terminal') && l.includes('nothing to drain')),
      ).toHaveLength(7);
      const id = await started(
        wf(
          [
            'id: owes',
            'name: owes',
            'version: 1',
            'steps:',
            '  after:',
            '    description: After.',
            '    execution: auto',
            '',
          ].join('\n'),
        ),
      );
      const r = realm(['run', 'drain', id, '--force']);
      // (a) red when the line changes or --force exits 0 on it; (b) prints stdout, stderr and the exit.
      expect([r.code, [...r.out, ...r.err].join('\n')]).toEqual([
        1,
        expect.stringContaining(
          `Run '${id}' is not terminal (phase: 'running') — nothing to drain. To run the step the engine owes ('after'): realm run advance ${id}.`,
        ),
      ]);
    });

    it('realm-run-reading.md: inspect names an expired question as what the run owes, and the door `advance` on a step it took', async () => {
      claim(
        'docs/reference/cli/realm-run-reading.md',
        "| `Owed to the engine` | When guards or `auto` steps are owed, or an expired question's `on_expiry` | The steps (or `the expired question on '<step>' (its declared <on_expiry>)`), and the `realm run advance` command that runs them. Added after version 0.46.0. |",
      );
      claim(
        'docs/reference/cli/realm-run-reading.md',
        '`via` names the door the program came through: `agent`, `run`, `advance`, `mcp-stdio`, `mcp-http`.',
      );
      claim(
        'docs/reference/glossary.md',
        'Whatever calls Realm to move a run forward: an AI assistant over MCP, `realm agent`, `realm listen`, `realm workflow run` or `realm run advance`.',
      );
      const def = wf(
        [
          'id: exp',
          'name: exp',
          'version: 1',
          'steps:',
          '  confirm:',
          '    description: Confirm.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [approve, reject]',
          '      timeout_seconds: 3600',
          '      on_expiry: settle_default',
          '      default_choice: approve',
          '  after:',
          '    description: After.',
          '    execution: auto',
          '    depends_on: [confirm]',
          '',
        ].join('\n'),
      );
      const id = await started(def);
      await executeStep(runStore, def, {
        runId: id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      const record = await runStore.get(id);
      await runStore.update({
        ...record,
        pending_gate: {
          ...record.pending_gate!,
          opened_at: '2020-01-01T00:00:00.000Z',
          expires_at: '2020-01-01T01:00:00.000Z',
        },
      });
      const owed = realm(['run', 'inspect', id]).out.find((l) =>
        l.startsWith('Owed to the engine:'),
      );
      // (a) red when inspect does not name the expired question as owed; (b) prints the line.
      expect(owed).toBe(
        `Owed to the engine: the expired question on 'confirm' (its declared settle_default) — realm run advance ${id}`,
      );
      const adv = realm(['run', 'advance', id], { REALM_OPERATOR: 'racer-a' });
      expect(adv.code, adv.err.join('\n')).toBe(0);
      const inspected = realm(['run', 'inspect', id]).out.join('\n');
      // (a) red when the step `realm run advance` ran is not shown taken through the door `advance`;
      //     (b) prints inspect's output.
      expect(inspected).toContain('racer-a (from REALM_OPERATOR, via advance)');
    });

    it('human-gates.md: realm run respond prints the answer, what the run owes the engine, and the waiting line', async () => {
      claim(
        'docs/guides/human-gates.md',
        'The second line names the step the answer leaves to the engine and the command that runs it; the third is printed with it. Both were added after version 0.46.0.',
      );
      const page = readFileSync(join(ROOT, 'docs/guides/human-gates.md'), 'utf8');
      const yaml = page.slice(
        page.indexOf('```yaml\n') + 8,
        page.indexOf('\n```', page.indexOf('```yaml\n')),
      );
      const def = wf(yaml);
      // Registered from its folder, as the guide does (`realm workflow register ./`).
      const project = mkdtempSync(join(tmpdir(), 'realm-625-announce-'));
      writeFileSync(join(project, 'workflow.yaml'), yaml);
      const reg = spawnSync(process.execPath, [CLI, 'workflow', 'register', './'], {
        cwd: project,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
        encoding: 'utf8',
      });
      expect(reg.status, reg.stderr).toBe(0);
      const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const id = run.id;
      // The answer to `draft` chains into `review`, whose gate opens.
      const chained = await executeChain(runStore, def, {
        runId: id,
        command: 'draft',
        input: { subject: 'Closed', body: 'The office is closed.' },
        dispatcher: async () => ({ subject: 'Closed', body: 'The office is closed.' }),
      });
      expect(chained.status, 'fixture').toBe('confirm_required');
      const gateId = (await runStore.get(id)).pending_gate!.gate_id;
      const r = spawnSync(
        process.execPath,
        [CLI, 'run', 'respond', id, '--gate', gateId, '--choice', 'send'],
        {
          cwd: project,
          env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
          encoding: 'utf8',
        },
      );
      const shown = block('docs/guides/human-gates.md', 'Responded: 64993bb2')
        .filter((l) => l !== '')
        .map((l) =>
          l
            .replaceAll('64993bb2-6f65-47d9-801c-d008e9291a00', id)
            .replaceAll('/home/me/announce', project),
        );
      rmSync(project, { recursive: true, force: true });
      // (a) red when respond prints other lines than the guide's; (b) prints both.
      expect(r.stdout.split('\n').filter((l) => l !== '')).toEqual(shown);
    });

    it('operate-runs.md: realm run resume on a failed auto step prints the guide’s two lines (decision C205: no Drive it lines for a step only the engine runs); on an agent step, the Drive it lines', async () => {
      claim(
        'docs/guides/operate-runs.md',
        '`fetch` is a step only the engine runs, so the second line names the call that runs it, with no model. When the step that is ready again is an agent step, the second line is `Drive it with: realm agent --run-id <run-id> --provider <provider> --model <model>` instead, with `<provider>` and `<model>` to fill in as above, and a third line names the other flags to add. The `realm run advance` line was added after version 0.46.0, which prints the `Drive it with:` lines for every step.',
      );
      const def = wf(
        [
          'id: fetchwf',
          'name: fetchwf',
          'version: 1',
          'services:',
          '  files:',
          '    adapter: filesystem',
          '    trust: engine_delivered',
          'steps:',
          '  fetch:',
          '    description: Fetch.',
          '    execution: auto',
          '    uses_service: files',
          '    operation: read',
          '    input_map:',
          '      path: run.params.path',
          '',
        ].join('\n'),
      );
      const id = await started(def, { path: '/no/such/file-625' });
      await advanceRun(runStore, def, { runId: id });
      expect((await runStore.get(id)).failed_steps, 'fixture').toEqual(['fetch']);
      const r = realm(['run', 'resume', id, '--from', 'fetch']);
      const shown = block('docs/guides/operate-runs.md', 'Resumed run ').map((l) =>
        l.replaceAll('4a0eafe2-afff-40ca-8b89-ad0e92db1a9c', id),
      );
      // (a) red when resume prints other lines than the guide's; (b) prints both.
      expect(r.out).toEqual(shown.filter((l) => l !== ''));
      // An agent step made runnable again: the `Drive it with:` line and the flags line.
      const agentDef = wf(
        [
          'id: askwf',
          'name: askwf',
          'version: 1',
          'steps:',
          '  ask:',
          '    description: Ask.',
          '    execution: agent',
          '',
        ].join('\n'),
      );
      const askId = await started(agentDef);
      const failedAsk = await runStore.get(askId);
      await runStore.update({
        ...failedAsk,
        run_phase: 'failed',
        failed_steps: ['ask'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        terminal_reason: "Step 'ask' failed.",
      });
      const ra = realm(['run', 'resume', askId, '--from', 'ask']);
      // (a) red when an agent step loses its drive, or gets the owed call; (b) prints the lines.
      expect(ra.out.filter((l) => l !== '')).toEqual([
        `Resumed run '${askId}': step 'ask' re-enabled and run reset to 'running'.`,
        `Drive it with: realm agent --run-id ${askId} --provider <provider> --model <model>`,
        `Add the other flags the run was driven with, such as --extensions-module or --project (realm run inspect ${askId} shows the extension module the run loaded).`,
      ]);
    });

    it('realm-run-reading.md (decision C205): inspect names an agent step that is ready, and, on an ended run, the failed steps `realm run resume` takes — never a cleanup step', async () => {
      const PAGE = 'docs/reference/cli/realm-run-reading.md';
      claim(
        PAGE,
        '| `Resumable` | When the run ended with a failed step `realm run resume` takes | Those steps (never a cleanup step, which `realm run resume --from` refuses), and the `realm run resume` command that makes one runnable again. Added after version 0.46.0. |',
      );
      claim(
        PAGE,
        '| `An agent step is ready`, `Agent steps are ready` | When an agent step is ready on a run with no open question | The steps, and the `realm agent` command that drives them, in the words `realm run advance` uses. Added after version 0.46.0. |',
      );
      claim(
        PAGE,
        'An agent step that is ready, and a run that ended with a step `realm run resume` takes, from two runs (added after version 0.46.0):',
      );
      const shown = block(PAGE, 'Resumable: ');
      const ready = await started(
        wf(
          [
            'id: inspready',
            'name: inspready',
            'version: 1',
            'steps:',
            '  write:',
            '    description: Write.',
            '    execution: agent',
            '',
          ].join('\n'),
        ),
      );
      const endedDef = wf(
        [
          'id: inspended',
          'name: inspended',
          'version: 1',
          'steps:',
          '  fetch:',
          '    description: Fetch.',
          '    execution: auto',
          '  clean:',
          '    description: Clean up.',
          '    execution: finalizer',
          '    handler: tidy',
          '    on_outcome: fail',
          '',
        ].join('\n'),
      );
      const ended = await started(endedDef);
      const rec = await runStore.get(ended);
      // `fetch` failed and the run's cleanup step failed too: both are listed as failed.
      await runStore.update({
        ...rec,
        run_phase: 'failed',
        failed_steps: ['fetch', 'clean'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        terminal_reason: "Step 'fetch' failed: it broke",
      });
      // Two steps `realm run resume` takes failed (and the cleanup step): both named, `<one of: …>`.
      const twoDef = wf(
        [
          'id: inspended2',
          'name: inspended2',
          'version: 1',
          'steps:',
          '  fetch:',
          '    description: Fetch.',
          '    execution: auto',
          '  send:',
          '    description: Send.',
          '    execution: auto',
          '  clean:',
          '    description: Clean up.',
          '    execution: finalizer',
          '    handler: tidy',
          '    on_outcome: fail',
          '',
        ].join('\n'),
      );
      const two = await started(twoDef);
      const rec2 = await runStore.get(two);
      await runStore.update({
        ...rec2,
        run_phase: 'failed',
        failed_steps: ['fetch', 'send', 'clean'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        terminal_reason: "Step 'fetch' failed: it broke",
      });
      const lineOf = (runId: string, start: string) =>
        realm(['run', 'inspect', runId]).out.find((l) => l.startsWith(start));
      // (a) red when the ready line or the Resumable line is missing or differs from the page's
      //     (its run ID put in place), the cleanup step is offered, or several steps are not each
      //     named; (b) prints them.
      expect([
        lineOf(ready, 'An agent step is ready'),
        lineOf(ended, 'Resumable:'),
        lineOf(two, 'Resumable:'),
      ]).toEqual([
        shown[0]!.replaceAll('3c9f1e27-8b4d-4a60-9d15-e2f7a0c4b839', ready),
        shown[1]!.replaceAll('6a1d5b03-c2e8-4f97-a41b-0d9e3c7f2a56', ended),
        `Resumable: 'fetch', 'send' — realm run resume ${two} --from <one of: fetch, send>`,
      ]);
    });

    it('gates.md: the four late-answer screens of realm run respond, line by line', async () => {
      claim(
        'docs/reference/workflow/gates.md',
        "In the examples below the gate's step, `approve`, is followed by a guard, `only_if_shipping`, which stops the run unless the choice is `ship`, and then by an agent step, `ship`.",
      );
      const def = (dflt: 'ship' | 'hold') =>
        wf(
          [
            `id: late-${dflt}`,
            `name: late-${dflt}`,
            'version: 1',
            'steps:',
            '  approve:',
            '    description: Approve.',
            '    execution: auto',
            '    trust: human_confirmed',
            '    gate:',
            '      choices: [ship, hold]',
            '      timeout_seconds: 3600',
            '      on_expiry: settle_default',
            `      default_choice: ${dflt}`,
            '  only_if_shipping:',
            '    description: Ship only when approved.',
            '    execution: guard',
            '    depends_on: [approve]',
            `    abort_unless: ["approve.choice == 'ship'"]`,
            '    abort_message: The order was held.',
            '  ship:',
            '    description: Ship.',
            '    execution: agent',
            '    depends_on: [only_if_shipping]',
            '',
          ].join('\n'),
        );
      async function expiredAt(d: WorkflowDefinition) {
        const id = await started(d);
        await executeStep(runStore, d, {
          runId: id,
          command: 'approve',
          input: {},
          dispatcher: async () => ({}),
        });
        const record = await runStore.get(id);
        await runStore.update({
          ...record,
          pending_gate: {
            ...record.pending_gate!,
            opened_at: '2020-01-01T00:00:00.000Z',
            expires_at: '2020-01-01T01:00:00.000Z',
          },
        });
        return { id, gateId: record.pending_gate!.gate_id };
      }
      const put = (lines: string[], ids: Record<string, string>) =>
        lines
          .filter((l) => l !== '')
          .map((l) => Object.entries(ids).reduce((t, [from, to]) => t.replaceAll(from, to), l));
      const G = 'docs/reference/workflow/gates.md';
      // 1: this answer carries out the expiry, the same choice (stdout, exit 0).
      const a = await expiredAt(def('ship'));
      const r1 = realm(['run', 'respond', a.id, '--gate', a.gateId, '--choice', 'ship']);
      // 2: this answer carries it out, another choice, the guard ends the run (stderr, exit 1).
      const b = await expiredAt(def('hold'));
      const r2 = realm(['run', 'respond', b.id, '--gate', b.gateId, '--choice', 'ship']);
      // 3 and 4: an earlier call carried it out; the same choice, then another one.
      const c = await expiredAt(def('ship'));
      await advanceRun(runStore, def('ship'), { runId: c.id });
      const r3 = realm(['run', 'respond', c.id, '--gate', c.gateId, '--choice', 'ship']);
      const d = await expiredAt(def('ship'));
      await advanceRun(runStore, def('ship'), { runId: d.id });
      const r4 = realm(['run', 'respond', d.id, '--gate', d.gateId, '--choice', 'hold']);
      // (a) red when any screen differs from the page's (ids aside), or goes to the other stream;
      //     (b) prints both.
      expect({ code: r1.code, out: r1.out }).toEqual({
        code: 0,
        out: put(
          block(
            G,
            "this respond call first carried out its declared settle_default: the default choice 'ship'",
          ),
          {
            '1a42b4b0-1fa1-42c9-b9ca-099c040b43f2': a.gateId,
            'e428e60c-a362-410f-8819-008e40456639': a.id,
          },
        ),
      });
      expect({ code: r2.code, err: r2.err }).toEqual({
        code: 1,
        err: put(block(G, "the default choice 'hold' was recorded (enacted_via: respond)"), {
          '80e024ee-2fd7-415e-8d38-a2fb8faf0cbb': b.gateId,
          '71f47780-06a7-421c-87d0-c74d2c8998de': b.id,
        }),
      });
      expect({ code: r3.code, out: r3.out }).toEqual({
        code: 0,
        out: put(block(G, 'Not recorded: 96727c7c'), {
          '96727c7c-cdf5-495c-92ed-28cd478b19d6': c.id,
        }),
      });
      expect({ code: r4.code, err: r4.err }).toEqual({
        code: 1,
        err: put(block(G, 'Not recorded: efe0a7c8'), {
          '5f71e609-cf61-40ef-8397-2d46f5dd1a54': d.gateId,
          'efe0a7c8-65f7-4be4-9fd9-447f5badd0ed': d.id,
        }),
      });
    });

    it('C184 (walk c8, W3-b, W3-c): the CLI README lists `advance` with its own description; operate-runs.md’s “Open, with no driver” names realm run advance for owed engine work', async () => {
      // (a) red when the CLI README's `realm run` table drops `advance` or words it otherwise than
      //     the command's own description; (b) prints both.
      const readme = flat(readFileSync(join(ROOT, 'packages/cli/README.md'), 'utf8'));
      expect(readme).toContain(`| \`advance\` | ${runAdvanceCommand.description()} |`);
      claim(
        'docs/guides/operate-runs.md',
        'If the driver has stopped, start one on the same run. When the run owes the engine work — an `auto` step or a guard, as the `Owed to the engine:` line of `realm run inspect` says — run it from your shell, with no model and no key:',
      );
      claim(
        'docs/guides/operate-runs.md',
        'It stops where the run next needs something else, such as an agent step or a question, and says which. An agent step needs a driver with a model:',
      );
      const def = wf(
        [
          'id: c184-owed',
          'name: c184-owed',
          'version: 1',
          'steps:',
          '  a:',
          '    description: A.',
          '    execution: auto',
          '  b:',
          '    description: B.',
          '    execution: agent',
          '    depends_on: [a]',
          '',
        ].join('\n'),
      );
      const id = await started(def);
      const inspect = realm(['run', 'inspect', id]);
      const r = realm(['run', 'advance', id]);
      // (a) red when inspect does not say the run owes the engine `a`, or advance does not run it and
      //     say it stopped at the agent step; (b) prints both outputs.
      expect({
        owed: inspect.out.some((l) => l.includes('Owed to the engine') && l.includes("'a'")),
        ran: r.out.includes('→ a'),
        stopped: r.out.filter((l) => l.startsWith('Stopped: ')),
        code: r.code,
      }).toEqual({
        owed: true,
        ran: true,
        stopped: [
          `Stopped: an agent step is ready: 'b' — drive it with realm agent --run-id ${id} --provider <provider> --model <model>`,
        ],
        code: 0,
      });
    });

    it('C187 (walk c8, W5-1): a guard decided before a step another process takes prints before that step’s taken line', async () => {
      claim(
        'docs/reference/cli/realm-run-acting.md',
        "Each guard it decides prints `Guard step '<guard>' passed.`, also when a later step completes the run, in the order the steps ran: a guard decided before a later step is printed before that step's line.",
      );
      // `a` (a handler that returns ok) → guard `g` → `fin`; another process takes `fin` in the
      // moment before this call's own claim.
      const def = wf(
        [
          'id: c187-taken',
          'name: c187-taken',
          'version: 1',
          'steps:',
          '  a:',
          '    description: A.',
          '    execution: auto',
          '    handler: ok',
          '  g:',
          '    description: G.',
          '    execution: guard',
          '    depends_on: [a]',
          '    abort_unless: ["a.ok == true"]',
          '  fin:',
          '    description: Fin.',
          '    execution: auto',
          '    depends_on: [g]',
          '',
        ].join('\n'),
      );
      class RacingStore extends JsonFileStore {
        raced = false;
        override async claimStep(
          ...args: Parameters<JsonFileStore['claimStep']>
        ): ReturnType<JsonFileStore['claimStep']> {
          const [id, step, d, claimant] = args;
          if (!this.raced && step === 'fin') {
            this.raced = true;
            await super.claimStep(id, step, d, {
              by: 'other-terminal',
              by_source: 'stated',
              channel: 'agent',
            });
          }
          return super.claimStep(id, step, d, claimant);
        }
      }
      const racing = new RacingStore(join(home, '.realm', 'runs'));
      await workflowStore.register(def);
      const { run } = await racing.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      const registry = new ExtensionRegistry();
      registry.register('handler', 'ok', {
        id: 'ok',
        execute: async () => ({ data: { ok: true } }),
      } as never);
      const lines: string[] = [];
      await advanceRunFromShell(
        run.id,
        { project: home },
        racing,
        workflowStore,
        undefined,
        (l) => lines.push(l),
        registry,
      );
      // (a) red when the guard's line is printed after the taken line of the step it let through;
      //     (b) prints the lines.
      expect(
        lines
          .filter((l) => l.startsWith('→ ') || l.startsWith('Guard step') || l.startsWith('• Step'))
          .map((l) => l.replace(/ at \S+Z;/, ' at <t>;')),
        lines.join('\n'),
      ).toEqual([
        '→ a',
        "Guard step 'g' passed.",
        // `→ <step>` is printed as the step starts, before its claim (realm-run-acting.md).
        '→ fin',
        "• Step 'fin' was taken by other-terminal (as stated, via agent) at <t>; not run here.",
      ]);
    });

    it.each([
      ['after a step it ran', true],
      ['in the preview, when only an agent step is ready', false],
    ] as const)(
      'C181 (walk c8, W1-a): realm run advance — the ready line for an agent step is followed by the waiting-process line `realm run respond` prints (%s)',
      async (_case, ranStep) => {
        claim(
          'docs/reference/cli/realm-run-acting.md',
          'the next line is the one `respond` prints after its commands, `If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.`, also after a preview line that names agent steps ready',
        );
        const def = wf(
          [
            `id: adv-c181-${ranStep ? 'ran' : 'preview'}`,
            'name: adv-c181',
            'version: 1',
            'steps:',
            ...(ranStep ? ['  after:', '    description: After.', '    execution: auto'] : []),
            '  finish:',
            '    description: Finish.',
            '    execution: agent',
            ...(ranStep ? ['    depends_on: [after]'] : []),
            '',
          ].join('\n'),
        );
        const id = await started(def);
        const r = realm(['run', 'advance', id]);
        const ready = `an agent step is ready: 'finish' — drive it with realm agent --run-id ${id} --provider <provider> --model <model>`;
        const attending =
          'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.';
        // (a) red when the waiting-process line is missing, not right after the ready line, or
        //     printed twice; (b) prints stdout from the ready line on.
        const at = r.out.findIndex((l) => l.includes(ready));
        expect({ code: r.code, tail: r.out.slice(at) }).toEqual({
          code: 0,
          tail: ranStep
            ? [`Stopped: ${ready}`, attending, `Run ${id}: phase 'running'`]
            : [`Nothing is owed to the engine: ${ready}.`, attending],
        });
      },
    );

    it.each([
      ['the expiry’s choice makes a guard ready (F1)', false],
      ['a guard passes, then a later step completes the run (F2)', true],
    ] as const)('realm-run-acting.md: realm run advance — %s', async (_case, guardLater) => {
      claim(
        'docs/reference/cli/realm-run-acting.md',
        "when the default's choice made a guard ready, the guard's sentence follows on the same line: `… (enacted_via: advance). Guard step '<guard>' passed.`); then the guards and `auto` steps that are ready.",
      );
      claim(
        'docs/reference/cli/realm-run-acting.md',
        "Each guard it decides prints `Guard step '<guard>' passed.`, also when a later step completes the run, in the order the steps ran: a guard decided before a later step is printed before that step's line. The guard that ended the run prints its sentence (`Guard step '<guard>' aborted the run.`) and `Reason:` when it has one.",
      );
      const def = wf(
        [
          `id: adv-guard-${guardLater ? 'later' : 'first'}`,
          `name: adv-guard-${guardLater ? 'later' : 'first'}`,
          'version: 1',
          'steps:',
          '  confirm:',
          '    description: Confirm.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [approve, reject]',
          '      timeout_seconds: 3600',
          '      on_expiry: settle_default',
          '      default_choice: approve',
          ...(guardLater
            ? [
                '  after:',
                '    description: After.',
                '    execution: auto',
                '    depends_on: [confirm]',
                '  only_if_approved:',
                '    description: Only if approved.',
                '    execution: guard',
                '    depends_on: [after]',
                `    abort_unless: ["confirm.choice == 'approve'"]`,
                '  finish:',
                '    description: Finish.',
                '    execution: auto',
                '    depends_on: [only_if_approved]',
              ]
            : [
                '  only_if_approved:',
                '    description: Only if approved.',
                '    execution: guard',
                '    depends_on: [confirm]',
                `    abort_unless: ["confirm.choice == 'approve'"]`,
                '  after:',
                '    description: After.',
                '    execution: auto',
                '    depends_on: [only_if_approved]',
              ]),
          '',
        ].join('\n'),
      );
      const id = await started(def);
      await executeStep(runStore, def, {
        runId: id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      const record = await runStore.get(id);
      await runStore.update({
        ...record,
        pending_gate: {
          ...record.pending_gate!,
          opened_at: '2020-01-01T00:00:00.000Z',
          expires_at: '2020-01-01T01:00:00.000Z',
        },
      });
      const gateId = record.pending_gate!.gate_id;
      const r = realm(['run', 'advance', id]);
      const lines = [...r.out, ...r.err];
      const expiry = `⚠ gate '${gateId}' on 'confirm' had expired — this advance call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: advance).`;
      // (a) red when the guard's line is lost, printed twice, replaced by the reply's MCP words, or
      //     the run does not complete; (b) prints the output and the exit.
      expect({
        code: r.code,
        expiry: lines.filter((l) => l.startsWith('⚠ gate ')),
        passed: lines.filter((l) => l === "Guard step 'only_if_approved' passed."),
        mcpWords: lines.filter((l) => l.includes('get_run_state')),
        phase: (await runStore.get(id)).run_phase,
        // decision C187 (walk c8, W5-1): the guard decided between `after` and `finish` prints
        // between their lines — (a) red when it prints after the later step's arrow.
        order: r.out.filter(
          (l) => l.startsWith('→ ') || l === "Guard step 'only_if_approved' passed.",
        ),
      }).toEqual({
        code: 0,
        expiry: guardLater ? [expiry] : [`${expiry} Guard step 'only_if_approved' passed.`],
        passed: guardLater ? ["Guard step 'only_if_approved' passed."] : [],
        mcpWords: [],
        phase: 'completed',
        order: guardLater
          ? ['→ after', "Guard step 'only_if_approved' passed.", '→ finish']
          : ['→ after'],
      });
    });
  },
);
