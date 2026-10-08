// docs-pages-625-acting.test.ts — issue #625 PR-2a, decision C174 (round 22), lane A: every sentence
// of `docs/reference/cli/realm-run-acting.md` about behaviour #625 PR-2a adds or changes, quoted here
// word for word (read from the repository) and driven on the built `realm` (a child process, a fresh
// HOME; the library from '@sensigo/realm' only sets runs up), so neither the page nor the command can
// change alone. An example block is compared line by line with the command's real output, its run,
// gate IDs, folders and times put in place.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  executeStep,
  loadWorkflowFromString,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const PAGE = 'docs/reference/cli/realm-run-acting.md';
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

/** The page's block, with each page value put in place by the run's own. */
const put = (lines: string[], values: Record<string, string>): string[] =>
  lines
    .filter((l) => l !== '')
    .map((l) => Object.entries(values).reduce((t, [from, to]) => t.replaceAll(from, to), l));

/** A workflow's YAML: `steps` is the steps' YAML block (indented two spaces). */
const yamlOf = (id: string, steps: string, extensions = false): string =>
  [
    `id: ${id}`,
    `name: ${id}`,
    'version: 1',
    ...(extensions ? ['extensions:', '  - ../../dist/registry.js'] : []),
    'steps:',
    steps,
    '',
  ].join('\n');

/** `confirm`, a question (approve/reject), with `on_expiry` when given (default `approve`). */
const CONFIRM = (onExpiry?: 'settle_default' | 'abort'): string =>
  [
    '  confirm:',
    '    description: Confirm.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    gate:',
    '      choices: [approve, reject]',
    '      timeout_seconds: 3600',
    ...(onExpiry !== undefined ? [`      on_expiry: ${onExpiry}`] : []),
    ...(onExpiry === 'settle_default' ? ['      default_choice: approve'] : []),
  ].join('\n');

const autoStep = (name: string, deps: string[], extra: string[] = []): string =>
  [
    `  ${name}:`,
    `    description: ${name}.`,
    '    execution: auto',
    `    depends_on: [${deps.join(', ')}]`,
    ...extra.map((l) => `    ${l}`),
  ].join('\n');

const agentStep = (name: string, deps: string[]): string =>
  [
    `  ${name}:`,
    `    description: ${name}.`,
    '    execution: agent',
    `    depends_on: [${deps.join(', ')}]`,
  ].join('\n');

/** An `auto` step the engine refuses before its claim: it gives `{}`, the schema needs `n`. */
const needsN = (name: string, deps: string[]): string =>
  autoStep(name, deps, [
    'input_schema:',
    '  type: object',
    '  required: [n]',
    '  properties:',
    '    n: { type: number }',
  ]);

const wayOut = (id: string): string =>
  `Run ${id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${id}; or end it: realm run abandon ${id}.`;

// Each cell runs the built `realm` several times as a child process: 60 s, not vitest's default 5 s.
describe(
  '#625 PR-2a, C174 lane A — realm-run-acting.md, sentence by sentence, from the built realm',
  { timeout: 60_000 },
  () => {
    let home: string;
    let elsewhere: string;
    let runStore: JsonFileStore;
    let workflowStore: JsonWorkflowStore;
    const folders: string[] = [];

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'realm-625-acting-'));
      elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'realm-625-acting-elsewhere-')));
      mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
      runStore = new JsonFileStore(join(home, '.realm', 'runs'));
      workflowStore = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    });
    afterEach(() => {
      for (const d of [home, elsewhere, ...folders.splice(0)]) {
        rmSync(d, { recursive: true, force: true });
      }
    });

    /** Runs the built `realm` with this HOME (from `elsewhere` unless `cwd` is given). */
    function realm(
      args: string[],
      opts: { cwd?: string; env?: Record<string, string> } = {},
    ): { code: number | null; out: string[]; err: string[] } {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: opts.cwd ?? elsewhere,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: home,
          NO_COLOR: '1',
          REALM_OPERATOR: 'tester',
          ...opts.env,
        },
        encoding: 'utf8',
        timeout: 60_000,
      });
      const lines = (t: string) => t.split('\n').filter((l) => l !== '');
      return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
    }

    /**
     * A project folder holding the workflow (`workflows/wf/workflow.yaml`), registered from that
     * folder by the built `realm`; `code` gives it an extension module (`dist/registry.js`: handler
     * `mark` outputs `{ from: <marker> }`, `env` outputs `{ secret: $SECRET_625 }`, `boom` throws).
     * Returns the folder, the workflow's project folder (`trust_root`) and the registered definition.
     */
    async function project(
      id: string,
      steps: string,
      code: boolean,
      marker = 'the project',
    ): Promise<{ dir: string; root: string; def: WorkflowDefinition }> {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'realm-625-acting-proj-')));
      folders.push(dir);
      mkdirSync(join(dir, 'workflows', 'wf'), { recursive: true });
      if (code) {
        mkdirSync(join(dir, 'dist'), { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
        writeFileSync(
          join(dir, 'dist', 'registry.js'),
          [
            'export default { handlers: {',
            `  mark: { id: 'mark', execute: async () => ({ data: { from: ${JSON.stringify(marker)} } }) },`,
            "  env: { id: 'env', execute: async () => ({ data: { secret: process.env.SECRET_625 ?? 'unset' } }) },",
            "  boom: { id: 'boom', execute: async () => { throw new Error('boom'); } },",
            '} };',
            '',
          ].join('\n'),
          'utf8',
        );
      }
      writeFileSync(join(dir, 'workflows', 'wf', 'workflow.yaml'), yamlOf(id, steps, code), 'utf8');
      const reg = realm(['workflow', 'register', 'workflows/wf/workflow.yaml'], { cwd: dir });
      if (reg.code !== 0) throw new Error(`fixture: register failed: ${reg.err.join('\n')}`);
      const def = await workflowStore.get(id);
      return { dir, root: def.trust_root!, def };
    }

    /** A workflow registered from a string (no project folder), through the library. */
    async function fromString(id: string, steps: string): Promise<WorkflowDefinition> {
      const def = loadWorkflowFromString(yamlOf(id, steps));
      await workflowStore.register(def);
      return def;
    }

    async function started(def: WorkflowDefinition): Promise<string> {
      const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      return run.id;
    }

    /** A run at its open question `confirm`; `expired` moves the question's time into the past. */
    async function atQuestion(
      def: WorkflowDefinition,
      expired = false,
    ): Promise<{ id: string; gateId: string }> {
      const id = await started(def);
      const opened = await executeStep(runStore, def, {
        runId: id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
      if (expired) {
        const record = await runStore.get(id);
        await runStore.update({
          ...record,
          pending_gate: {
            ...record.pending_gate!,
            opened_at: '2020-01-01T00:00:00.000Z',
            expires_at: '2020-01-01T01:00:00.000Z',
          },
        });
      }
      return { id, gateId: opened.gate!.gate_id };
    }

    const respond = (
      q: { id: string; gateId: string },
      choice: string,
      opts: { cwd?: string; extra?: string[] } = {},
    ) =>
      realm(
        ['run', 'respond', q.id, '--gate', q.gateId, '--choice', choice, ...(opts.extra ?? [])],
        opts.cwd !== undefined ? { cwd: opts.cwd } : {},
      );

    it('respond, L51 + block: an answer that leaves `auto` steps names them, the advance command (runs it / runs them), the project folder and the shell’s environment — the page’s screen', async () => {
      claim(
        PAGE,
        "When the answer leaves `auto` steps that only the engine can run, one more line names them and the command that runs them (`runs it` for one step, `runs them` for more), where that command loads the steps' project code from (the workflow's own project folder, whatever folder the shell is in; for a workflow made without one, the folder it runs in or its `--project`), and that the environment is that shell's.",
      );
      const two = await project(
        'acting-owed-two',
        [CONFIRM(), autoStep('process', ['confirm']), autoStep('notify', ['confirm'])].join('\n'),
        true,
      );
      const q = await atQuestion(two.def);
      const r = respond(q, 'approve');
      const shown = put(block(PAGE, 'Responded: b178179a'), {
        'b178179a-998d-457e-85e6-6d38439d0585': q.id,
        '/home/me/project': two.root,
      });
      // (a) red when respond prints other lines than the page's screen (from an unrelated folder:
      //     the project folder, not the shell's, is named); (b) prints both.
      expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: shown });
      // One step: `runs it`.
      const one = await project(
        'acting-owed-one',
        [CONFIRM(), autoStep('process', ['confirm'])].join('\n'),
        true,
      );
      const q1 = await atQuestion(one.def);
      // (a) red when one step is said `runs them`; (b) prints the stdout.
      expect(respond(q1, 'approve').out[1]).toBe(
        `Owed to the engine: 'process' — realm run advance ${q1.id} runs it, with the project code under ${one.root}, in the environment of the shell it runs in.`,
      );
      // A workflow made without a project folder: the folder advance runs in, or its --project.
      const bare = await fromString(
        'acting-owed-string',
        [CONFIRM(), autoStep('process', ['confirm'])].join('\n'),
      );
      const qs = await atQuestion(bare);
      // (a) red when the line names a folder for a workflow that has none; (b) prints the line.
      expect(respond(qs, 'approve').out[1]).toMatch(
        new RegExp(
          `^Owed to the engine: 'process' — realm run advance ${qs.id} runs it, with .*the folder it runs in \\(or its --project\\), in the environment of the shell it runs in\\.$`,
        ),
      );
    });

    it('respond, L38 + L59: --project is used only for a workflow made without a project folder; a workflow registered from a folder loads from there and the command says --project was not used; no project code is said', async () => {
      claim(
        PAGE,
        '| `--project <dir>` | No | Used only for a workflow registered without a project folder (made by an agent or from a string): the folder whose `realm.yaml` and code it loads. Default: the current folder. A workflow registered from a folder loads its code from there, and `--project` is not used (the command says so). |',
      );
      claim(
        PAGE,
        "When the workflow's own project folder holds no project code (no `realm.yaml`, no extension module), the line says `with no project code (nothing to load under <folder>)` instead.",
      );
      claim(
        PAGE,
        "When `--project` is given for a workflow that has its own project folder, the first line says it was not used: `--project <dir> was not used: workflow '<id>' has its own project, <folder>, and its code is loaded from there.`, or, when that folder holds no project code, `… has its own project, <folder> (no project code there).` Both added after version 0.46.0.",
      );
      const steps = [CONFIRM(), autoStep('process', ['confirm'])].join('\n');
      // A folder whose realm.yaml is invalid: loading it fails, so a refusal shows it was read.
      const bad = realpathSync(mkdtempSync(join(tmpdir(), 'realm-625-acting-p-')));
      folders.push(bad);
      writeFileSync(join(bad, 'realm.yaml'), 'extensions:\n  - ./ext.mjs\n', 'utf8');
      const loadFailed = `Error loading extensions: Deployment manifest '${bad}/realm.yaml' is invalid:`;
      // A workflow made from a string: its realm.yaml and code come from --project, by default the
      // current folder.
      const made = await fromString('acting-proj-string', steps);
      const viaFlag = respond(await atQuestion(made), 'approve', { extra: ['--project', bad] });
      const viaCwd = respond(await atQuestion(made), 'approve', { cwd: bad });
      const neither = respond(await atQuestion(made), 'approve');
      // (a) red when --project (or the current folder) is not where it loads from; (b) prints both.
      expect([viaFlag.code, viaFlag.err[0], viaCwd.code, viaCwd.err[0], neither.code]).toEqual([
        1,
        loadFailed,
        1,
        loadFailed,
        0,
      ]);
      // A workflow registered from a folder that holds code: --project is not used, and said.
      const own = await project('acting-proj-own', steps, true);
      const q = await atQuestion(own.def);
      const r = respond(q, 'approve', { extra: ['--project', bad] });
      // (a) red when --project is used (the answer would fail on its realm.yaml), or not said;
      //     (b) prints stdout.
      expect({ code: r.code, first: r.out.slice(0, 3) }).toEqual({
        code: 0,
        first: [
          `--project ${bad} was not used: workflow 'acting-proj-own' has its own project, ${own.root}, and its code is loaded from there.`,
          `Responded: ${q.id} | choice 'approve' | new state 'running'`,
          `Owed to the engine: 'process' — realm run advance ${q.id} runs it, with the project code under ${own.root}, in the environment of the shell it runs in.`,
        ],
      });
      // Its own folder holds no project code.
      const empty = await project('acting-proj-empty', steps, false);
      const qe = await atQuestion(empty.def);
      const re = respond(qe, 'approve', { extra: ['--project', bad] });
      // (a) red when a folder with no code is said to have code; (b) prints stdout.
      expect({ code: re.code, first: re.out.slice(0, 3) }).toEqual({
        code: 0,
        first: [
          `--project ${bad} was not used: workflow 'acting-proj-empty' has its own project, ${empty.root} (no project code there).`,
          `Responded: ${qe.id} | choice 'approve' | new state 'running'`,
          `Owed to the engine: 'process' — realm run advance ${qe.id} runs it, with no project code (nothing to load under ${empty.root}), in the environment of the shell it runs in.`,
        ],
      });
    });

    it('respond, L61 + block: an answer that leaves an agent step ready says so in advance’s words, with the command that drives it — the page’s screen', async () => {
      claim(
        PAGE,
        'When the answer leaves an agent step ready, the line says so in the words `realm run advance` uses, with the command that drives it.',
      );
      const { def } = await project(
        'acting-agent-ready',
        [CONFIRM(), agentStep('finish', ['confirm'])].join('\n'),
        false,
      );
      const q = await atQuestion(def);
      const r = respond(q, 'approve');
      // (a) red when respond prints other lines than the page's screen; (b) prints both.
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: put(block(PAGE, 'Responded: 4168cf62'), {
          '4168cf62-7ae2-4ed9-a688-e149ccbe06a6': q.id,
        }),
      });
      // The words advance uses for the same state: its Stopped: reason.
      const a = realm(['run', 'advance', q.id]);
      // (a) red when advance's words for a ready agent step differ from respond's; (b) prints it.
      expect(a.out.at(-1)).toBe(
        `Nothing is owed to the engine: an agent step is ready: 'finish' — drive it with realm agent --run-id ${q.id} --provider <provider> --model <model>.`,
      );
    });

    it('respond, L71 + block, L79: an answer that leaves nothing that can run names each step that cannot run, then the way out; a missing handler ends with its own way out and the abandon line', async () => {
      claim(
        PAGE,
        'When the answer leaves nothing that can run from here — no agent step ready, no owed step that can run, only `auto` steps that cannot run — each such step is named, then the way out.',
      );
      claim(
        PAGE,
        'A step that needs a handler or adapter this program lacks ends with its own way out (`— load the missing extension, or run the step on a runner that has it.`), and when no step is refused before its claim the last line is `To end the run instead: realm run abandon <id>.`',
      );
      const { def } = await project(
        'acting-stuck',
        [CONFIRM(), needsN('compute', ['confirm'])].join('\n'),
        false,
      );
      const q = await atQuestion(def);
      const r = respond(q, 'approve');
      // (a) red when respond prints other lines than the page's screen; (b) prints both.
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: put(block(PAGE, 'Responded: 77772f0c'), {
          '77772f0c-a80d-49d3-b665-4ac186186fd1': q.id,
        }),
      });
      const cap = await project(
        'acting-capability',
        [CONFIRM(), autoStep('x', ['confirm'], ['handler: missing_h'])].join('\n'),
        false,
      );
      const qc = await atQuestion(cap.def);
      const rc = respond(qc, 'approve');
      // (a) red when the capability step's way out or the abandon line changes; (b) prints stdout.
      expect(rc.out).toEqual([
        `Responded: ${qc.id} | choice 'approve' | new state 'running'`,
        "'x' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it.",
        `To end the run instead: realm run abandon ${qc.id}.`,
      ]);
    });

    it('respond, L116 + L127: a late answer is not recorded — the ⚠ line when this call carried the expiry out, `Not recorded:` in place of `Responded:`, then what the run owes; another choice is told it was settled by timeout', async () => {
      claim(
        PAGE,
        "An answer that arrives after the gate's time is up is not recorded, and for a gate that was settled with its default choice `Not recorded:` takes the place of `Responded:`. The lines after it are the ones above: what the run owes (added after version 0.46.0).",
      );
      claim(
        PAGE,
        "When this answer is the call that carried out the expiry, its first line says so, as `realm run advance`'s does (where the expiry's choice made a guard ready, `respond` prints the guard's line on its own, after the first line; `realm run advance` adds the guard's sentence to the end of its first line): `⚠ gate '<gate>' on '<step>' had expired — this respond call first carried out its declared settle_default: the default choice '<choice>' was recorded (enacted_via: respond).`, or `… its declared abort: the run ended (enacted_via: respond).` (added after version 0.46.0).",
      );
      claim(
        PAGE,
        "| The gate's time was up, and it was settled with another choice | `Gate '80e024ee-…' was settled by timeout with choice 'hold' — your choice 'ship' was not recorded.`, after the `⚠` line when this answer carried out the expiry. Then what the guard did, if this answer carried out the expiry, the `Not recorded:` line, and what the run owes. |",
      );
      const steps = (e: 'settle_default' | 'abort') =>
        [CONFIRM(e), autoStep('after', ['confirm'])].join('\n');
      const settle = await project('acting-late', steps('settle_default'), false);
      const same = await atQuestion(settle.def, true);
      const r1 = respond(same, 'approve');
      const owed = (id: string) =>
        `Owed to the engine: 'after' — realm run advance ${id} runs it, with no project code (nothing to load under ${settle.root}), in the environment of the shell it runs in.`;
      // (a) red when the late answer is recorded, the ⚠ line is not first, or the owed line is
      //     dropped; (b) prints stdout and the exit.
      expect({ code: r1.code, out: r1.out }).toEqual({
        code: 0,
        out: [
          `⚠ gate '${same.gateId}' on 'confirm' had expired — this respond call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: respond).`,
          'the outcome matches your choice, but it was settled by timeout; your response was not recorded.',
          `Not recorded: ${same.id} | gate settled by timeout with choice 'approve' | state 'running'`,
          owed(same.id),
          'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
        ],
      });
      const other = await atQuestion(settle.def, true);
      const r2 = respond(other, 'reject');
      // (a) red when another choice is not told it was settled by timeout after the ⚠ line, or the
      //     Not recorded: line and what the run owes do not follow, in that order on stderr;
      //     (b) prints stdout, stderr and the exit.
      expect({ code: r2.code, out: r2.out, err: r2.err }).toEqual({
        code: 1,
        out: [],
        err: [
          `⚠ gate '${other.gateId}' on 'confirm' had expired — this respond call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: respond).`,
          `Gate '${other.gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
          `Not recorded: ${other.id} | gate settled by timeout with choice 'approve' | state 'running'`,
          owed(other.id),
          'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
        ],
      });
      // What the guard did: the default ('approve') makes a guard ready that ends the run.
      const guarded = await project(
        'acting-late-guard',
        [
          CONFIRM('settle_default'),
          '  only_if_rejected:',
          '    description: Go on only when rejected.',
          '    execution: guard',
          '    depends_on: [confirm]',
          `    abort_unless: ["confirm.choice == 'reject'"]`,
          '    abort_message: The default was taken.',
          autoStep('after', ['only_if_rejected']),
        ].join('\n'),
        false,
      );
      const g = await atQuestion(guarded.def, true);
      const r4 = respond(g, 'reject');
      // (a) red when what the guard did is not said between the refusal and `Not recorded:`;
      //     (b) prints stdout, stderr and the exit.
      expect({ code: r4.code, out: r4.out, err: r4.err }).toEqual({
        code: 1,
        out: [],
        err: [
          `⚠ gate '${g.gateId}' on 'confirm' had expired — this respond call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: respond).`,
          `Gate '${g.gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
          "Guard step 'only_if_rejected' aborted the run.",
          'Reason: The default was taken.',
          `Not recorded: ${g.id} | gate settled by timeout with choice 'approve' | state 'aborted'`,
        ],
      });
      const abort = await project('acting-late-abort', steps('abort'), false);
      const ab = await atQuestion(abort.def, true);
      const r3 = respond(ab, 'approve');
      // (a) red when the abort's line changes or is not first; (b) prints stdout and stderr.
      expect([...r3.out, ...r3.err][0]).toBe(
        `⚠ gate '${ab.gateId}' on 'confirm' had expired — this respond call first carried out its declared abort: the run ended (enacted_via: respond).`,
      );
    });

    it('advance, L10 + L133 + L136 + block: the table row, the synopsis, and the preview printed before anything runs — the page’s screen, with REALM_OPERATOR naming the program', async () => {
      claim(
        PAGE,
        '| [`advance`](#advance) | Runs what a run owes the engine, with no model. | Always |',
      );
      claim(
        PAGE,
        'names this program with `REALM_OPERATOR` or the OS user (a `REALM_OPERATOR` that cannot be used prints one line and exits 1 before any work), and prints what it is about to do before it runs anything:',
      );
      // (a) red when `realm run advance` leaves `realm run`, or its usage drifts from the page's
      //     synopsis; (b) prints the help.
      const help = realm(['run', '--help']).out.join('\n');
      expect(help).toMatch(/^ {2}advance \[options\] <run-id>/m);
      expect(block(PAGE, 'realm run advance <run-id>')[0]).toBe(
        'realm run advance <run-id> [--project <dir>] [--extensions-module <path>]',
      );
      const usage = realm(['run', 'advance', '--help']).out.join('\n');
      expect([
        usage.split('\n')[0],
        usage.includes('--project <dir>'),
        usage.includes('--extensions-module <path>'),
      ]).toEqual(['Usage: realm run advance [options] <run-id>', true, true]);
      const { root, def } = await project(
        'cli-owed-wf',
        [autoStep('after', []), agentStep('finish', ['after'])].join('\n'),
        false,
      );
      const id = await started(def);
      // No PATH to a model and no key: the env holds only PATH, HOME, NO_COLOR and REALM_OPERATOR.
      const r = realm(['run', 'advance', id]);
      // (a) red when advance prints other lines than the page's screen, or exits non-zero; (b)
      //     prints both.
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: put(block(PAGE, "Advancing run <id> (workflow 'cli-owed-wf')"), {
          '<id>': id,
          '/home/me/project': root,
        }),
      });
      // (a) red when the step did not run; (b) prints the completed steps.
      expect((await runStore.get(id)).completed_steps).toEqual(['after']);
      // The OS user names the program when REALM_OPERATOR is not set.
      const os = realm(['run', 'advance', await started(def)], { env: { REALM_OPERATOR: '' } });
      // (a) red when an unset REALM_OPERATOR is not replaced by the OS user; (b) prints the line.
      expect(os.out[1]).toMatch(/^This program: .+ \(from the OS user\) · project code: /);
      // A REALM_OPERATOR that cannot be used: one line, exit 1, nothing run.
      const fresh = await started(def);
      const bad = realm(['run', 'advance', fresh], { env: { REALM_OPERATOR: 'a\u0007b' } });
      // (a) red when a bad name prints more than one line, exits 0 or runs a step; (b) prints all.
      expect({
        code: bad.code,
        lines: [...bad.out, ...bad.err].length,
        completed: (await runStore.get(fresh)).completed_steps,
      }).toEqual({ code: 1, lines: 1, completed: [] });
    });

    it('advance, L136: an expired question’s declared on_expiry first — named in the preview, its ⚠ line printed before the steps it runs; then the guards and auto steps; abort ends the run', async () => {
      claim(
        PAGE,
        "Runs what a run owes the engine, from this shell — no model provider, no key: first, when the open question's time is up and it declares `on_expiry`, that default or abort (the preview names it as `the expired question on '<step>' (its declared <on_expiry>)`, and the command prints the line from its reply before the steps it runs: `⚠ gate '<gate>' on '<step>' had expired — this advance call first carried out its declared settle_default: the default choice '<choice>' was recorded (enacted_via: advance).`, or `… its declared abort: the run ended …`; when the default's choice made a guard ready, the guard's sentence follows on the same line: `… (enacted_via: advance). Guard step '<guard>' passed.`); then the guards and `auto` steps that are ready.",
      );
      // The guard follows an auto step, so the expiry's own write makes no guard ready (see the
      // report: when it does, the ⚠ line carries the guard's sentence).
      const steps = (e: 'settle_default' | 'abort') =>
        [
          CONFIRM(e),
          autoStep('after', ['confirm']),
          '  only_if_approved:',
          '    description: Go on only when approved.',
          '    execution: guard',
          '    depends_on: [after]',
          `    abort_unless: ["confirm.choice == 'approve'"]`,
          agentStep('finish', ['only_if_approved']),
        ].join('\n');
      const settle = await project('acting-adv-expiry', steps('settle_default'), false);
      const q = await atQuestion(settle.def, true);
      const r = realm(['run', 'advance', q.id]);
      // (a) red when the expiry is not named first, its line is not before the steps, or the guard
      //     and the auto step do not follow; (b) prints stdout.
      expect({ code: r.code, tail: r.out.slice(3) }).toEqual({
        code: 0,
        tail: [
          "Owed to the engine: the expired question on 'confirm' (its declared settle_default).",
          `⚠ gate '${q.gateId}' on 'confirm' had expired — this advance call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: advance).`,
          '→ after',
          "Guard step 'only_if_approved' passed.",
          `Stopped: an agent step is ready: 'finish' — drive it with realm agent --run-id ${q.id} --provider <provider> --model <model>`,
          `Run ${q.id}: phase 'running'`,
        ],
      });
      const abort = await project('acting-adv-abort', steps('abort'), false);
      const qa = await atQuestion(abort.def, true);
      const ra = realm(['run', 'advance', qa.id]);
      // (a) red when abort is not carried out or its line changes; (b) prints stdout.
      expect(ra.out.slice(3)).toEqual([
        "Owed to the engine: the expired question on 'confirm' (its declared abort).",
        `⚠ gate '${qa.gateId}' on 'confirm' had expired — this advance call first carried out its declared abort: the run ended (enacted_via: advance).`,
        'Stopped: the run has ended (aborted)',
        `Run ${qa.id}: phase 'aborted'`,
      ]);
    });

    it('advance, L136 + L148: it loads the project’s code as respond does — the workflow’s own folder from anywhere, --extensions-module, or for a workflow made without one --project or the folder it runs in; the first lines say from where, and a --project not used', async () => {
      claim(
        PAGE,
        "It loads the project's extensions exactly as `respond` does (`--project`, `--extensions-module`) — from the workflow's own project folder, whatever folder the shell is in, or, for a workflow made without one, from `--project` or the folder it runs in —",
      );
      claim(
        PAGE,
        "The first line names the folder the project code is loaded from, or says `with no project code (nothing to load under <folder>)` when that folder holds none (no `realm.yaml`, no extension module); a `--project` the workflow's own project folder overrides is said on the next line, `--project <dir> was not used: workflow '<id>' has its own project, <folder>, and its code is loaded from there.`, or `… <folder> (no project code there).` when it holds none (both added after version 0.46.0).",
      );
      claim(
        PAGE,
        '`--project` is used only for a workflow registered without a project folder (`realm run advance --help` says so).',
      );
      // (a) red when the help no longer says when --project is used; (b) prints the help.
      expect(flat(realm(['run', 'advance', '--help']).out.join(' '))).toContain(
        'Used only for a workflow registered without a project folder (made by an agent or from a string): the folder whose realm.yaml and code it loads (default: current directory). A workflow registered from a folder loads its code from there, and --project is not used.',
      );
      const bad = realpathSync(mkdtempSync(join(tmpdir(), 'realm-625-acting-p-')));
      folders.push(bad);
      writeFileSync(join(bad, 'realm.yaml'), 'extensions:\n  - ./ext.mjs\n', 'utf8');
      const steps = autoStep('a', [], ['handler: mark']);
      // The workflow's own folder, from an unrelated folder, with --project naming another: the
      // project's handler runs, and the lines say so.
      const own = await project('acting-adv-own', steps, true, 'own project');
      const id = await started(own.def);
      const r = realm(['run', 'advance', id, '--project', bad]);
      // (a) red when the first lines name another folder, or --project is used or not said; (b)
      //     prints stdout.
      expect({ code: r.code, head: r.out.slice(0, 2) }).toEqual({
        code: 0,
        head: [
          `Advancing run ${id} (workflow 'acting-adv-own') with the project code under ${own.root}, in this shell's environment.`,
          `--project ${bad} was not used: workflow 'acting-adv-own' has its own project, ${own.root}, and its code is loaded from there.`,
        ],
      });
      const output = async (runId: string) =>
        (await runStore.get(runId)).evidence.find((e) => e.step_id === 'a')?.output_summary;
      // (a) red when other code ran the step; (b) prints the recorded output.
      expect(await output(id)).toEqual({ from: 'own project' });
      // The workflow's own folder holds no code: said, on both lines.
      const empty = await project('acting-adv-empty', autoStep('a', []), false);
      const ide = await started(empty.def);
      const re = realm(['run', 'advance', ide, '--project', bad]);
      // (a) red when a folder with no code is said to have code; (b) prints stdout.
      expect(re.out.slice(0, 2)).toEqual([
        `Advancing run ${ide} (workflow 'acting-adv-empty') with no project code (nothing to load under ${empty.root}), in this shell's environment.`,
        `--project ${bad} was not used: workflow 'acting-adv-empty' has its own project, ${empty.root} (no project code there).`,
      ]);
      // --extensions-module: its module's handler runs.
      const mod = join(bad, 'override.mjs');
      writeFileSync(
        mod,
        "export default { handlers: { mark: { id: 'mark', execute: async () => ({ data: { from: 'the override' } }) } } };\n",
        'utf8',
      );
      const ido = await started(own.def);
      const ro = realm(['run', 'advance', ido, '--extensions-module', mod]);
      // (a) red when --extensions-module is not loaded; (b) prints stdout and the record.
      expect({ code: ro.code, out: await output(ido) }).toEqual({
        code: 0,
        out: { from: 'the override' },
      });
      // A workflow made without a project folder: --project, or the folder it runs in.
      const made = await fromString('acting-adv-string', autoStep('a', []));
      const viaFlag = realm(['run', 'advance', await started(made), '--project', bad]);
      const viaCwd = realm(['run', 'advance', await started(made)], { cwd: bad });
      const loadFailed = `Deployment manifest '${bad}/realm.yaml' is invalid:`;
      // (a) red when --project or the shell's folder is not where its realm.yaml is read from;
      //     (b) prints both.
      expect([viaFlag.code, viaFlag.err[0], viaCwd.code, viaCwd.err[0]]).toEqual([
        1,
        loadFailed,
        1,
        loadFailed,
      ]);
    });

    /** `a` (auto, handler `mark`) → `confirm` (a question) → `b` (auto, no handler). */
    const A_THEN_QUESTION = [
      autoStep('a', [], ['handler: mark']),
      CONFIRM().replace('    gate:', '    depends_on: [a]\n    gate:'),
      autoStep('b', ['confirm']),
    ].join('\n');

    /** Answers the run's open question through the built `realm`. */
    async function answer(id: string): Promise<void> {
      const gateId = (await runStore.get(id)).pending_gate!.gate_id;
      const r = realm(['run', 'respond', id, '--gate', gateId, '--choice', 'approve']);
      if (r.code !== 0) throw new Error(`fixture: respond failed: ${r.err.join('\n')}`);
    }

    it('advance, L148: the expiry line before the steps it led to; every other warning of the reply as `⚠ <line>` after the steps that ran', async () => {
      claim(
        PAGE,
        "The expiry line is printed when the call carries the expiry out, before the steps it led to; every other line in the reply's `warnings` is printed as `⚠ <line>` after the steps that ran (added after version 0.46.0, which printed only the expiry line, on stderr, after the steps).",
      );
      const { def } = await project(
        'acting-adv-warnings',
        [
          CONFIRM('settle_default'),
          autoStep('a', ['confirm'], ['handler: mark']),
          '  tidy:',
          '    description: Tidy.',
          '    execution: finalizer',
          '    handler: missing_fin',
          '    on_outcome: always',
        ].join('\n'),
        true,
      );
      const q = await atQuestion(def, true);
      const r = realm(['run', 'advance', q.id]);
      // (a) red when the expiry line moves after the step, a reply warning is not printed after
      //     the steps, or anything goes to stderr; (b) prints stdout and stderr.
      expect({ tail: r.out.slice(3), err: r.err }).toEqual({
        tail: [
          "Owed to the engine: the expired question on 'confirm' (its declared settle_default).",
          `⚠ gate '${q.gateId}' on 'confirm' had expired — this advance call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: advance).`,
          '→ a',
          "⚠ finalizer 'tidy' left pending — handler not available on this surface",
          `Run ${q.id}: phase 'completed'`,
        ],
        err: [],
      });
    });

    it('advance, L150–L158: the preview’s project code words, each row on its case', async () => {
      claim(
        PAGE,
        "The preview's `project code` words compare the code this program loaded with what the run last recorded:",
      );
      claim(PAGE, "| `same as the run's last record` | The same files with the same hashes. |");
      claim(
        PAGE,
        "| `differs from the run's last record` | Comparable, and different: a code file, an entry module, the `realm.yaml` or the `--extensions-module` override changed. |",
      );
      claim(
        PAGE,
        "| `not comparable with the run's last record` | The run records project code and this program loaded none, the two fingerprints were taken under different rules, one was cut short at its size limit, or one side's load failed. |",
      );
      claim(
        PAGE,
        '| `not comparable — the run has recorded no project code yet` | This program loaded project code, and the run has recorded none: no program with project code has run a step of it yet, as on a run just created. It is not a mismatch. |',
      );
      claim(
        PAGE,
        '| `neither side records project code` | Neither the run nor this program loaded project code. |',
      );
      const words = (out: string[]) => out[1]?.replace(/^This program: .* · project code: /, '');
      const coded = await project('acting-words', A_THEN_QUESTION, true);
      // A run just created: no program with project code has run a step of it yet.
      const id = await started(coded.def);
      const first = realm(['run', 'advance', id]);
      // (a) red when a fresh run is called a mismatch or refused; (b) prints the words and the run.
      expect({
        code: first.code,
        words: words(first.out),
        ran: (await runStore.get(id)).completed_steps,
      }).toEqual({
        code: 0,
        words: 'not comparable — the run has recorded no project code yet.',
        ran: ['a'],
      });
      await answer(id);
      // The same files.
      // (a) red when the same code is not said the same; (b) prints the words.
      expect(words(realm(['run', 'advance', id]).out)).toBe("same as the run's last record.");
      // A code file changed.
      const id2 = await started(coded.def);
      realm(['run', 'advance', id2]);
      await answer(id2);
      writeFileSync(
        join(coded.dir, 'dist', 'registry.js'),
        "export default { handlers: { mark: { id: 'mark', execute: async () => ({ data: { from: 'changed' } }) } } };\n",
        'utf8',
      );
      // (a) red when a changed code file is not said to differ; (b) prints the words.
      expect(words(realm(['run', 'advance', id2]).out)).toBe("differs from the run's last record.");
      // The run records project code and this program loaded none.
      const made = await fromString('acting-words-string', A_THEN_QUESTION);
      const mod = join(coded.dir, 'dist', 'registry.js');
      const id3 = await started(made);
      realm(['run', 'advance', id3, '--extensions-module', mod]);
      await answer(id3);
      // (a) red when loading nothing against a recorded fingerprint is not "not comparable"; (b)
      //     prints the words.
      expect(words(realm(['run', 'advance', id3]).out)).toBe(
        "not comparable with the run's last record.",
      );
      // Neither side.
      const bare = await project('acting-words-bare', autoStep('a', []), false);
      // (a) red when no code on either side is said otherwise; (b) prints the words.
      expect(words(realm(['run', 'advance', await started(bare.def)]).out)).toBe(
        'neither side records project code.',
      );
    });

    it('advance, L160 + L169 + L176 + blocks: when the engine can run nothing the last preview line says why and nothing runs; the way out after a refused step; a step another program holds', async () => {
      claim(
        PAGE,
        "When another program holds an owed step, the preview says so before anything runs, once, with the program and the time: `In flight: '<step>' is in flight, taken by <program> since <time>.`",
      );
      claim(
        PAGE,
        'When the engine can run nothing, the last preview line says why and nothing runs. It opens `Nothing is owed to the engine: <reasons>.` when nothing is owed (the run ended, a question is open, only agent steps are ready), and `The engine can run nothing now: <reasons>.` when steps are still owed to the engine but none can run here now (a step that cannot run, or a step in flight in another program).',
      );
      claim(
        PAGE,
        'When the run stops on a step refused before its claim (an invalid `trust`, a failed precondition, an input its schema refuses) and nothing else is ready, the last line gives the one way out — correcting the workflow and registering it again is the fix, since the run picks up the corrected definition:',
      );
      claim(
        PAGE,
        "After a call that ran other steps, the same way out takes the place of the `Run <id>: phase '<phase>'` line. A step another program holds:",
      );
      // A step that cannot run: the page's screen.
      const stuck = await project('acting-nothing-refused', needsN('compute', []), false);
      const id = await started(stuck.def);
      const r = realm(['run', 'advance', id]);
      // (a) red when the last lines differ from the page's screen, exit 0, or a step ran; (b)
      //     prints both.
      expect({
        code: r.code,
        tail: r.out.slice(3),
        ran: (await runStore.get(id)).evidence.length,
      }).toEqual({
        code: 1,
        tail: put(block(PAGE, "The engine can run nothing now: 'compute' cannot run"), {
          '507090b5-3b5b-4a6c-a814-3faa03404f95': id,
        }),
        ran: 0,
      });
      // ...and the run picks up the corrected definition once registered again.
      writeFileSync(
        join(stuck.dir, 'workflows', 'wf', 'workflow.yaml'),
        yamlOf('acting-nothing-refused', autoStep('compute', [])),
        'utf8',
      );
      // (a) red when registering the corrected workflow again fails; (b) prints the exit.
      expect(
        realm(['workflow', 'register', 'workflows/wf/workflow.yaml'], { cwd: stuck.dir }).code,
      ).toBe(0);
      const fixed = realm(['run', 'advance', id]);
      // (a) red when the corrected definition is not the one the run uses; (b) prints stdout.
      expect(fixed.out.slice(-2)).toEqual(['→ compute', `Run ${id}: phase 'completed'`]);
      // A step another program holds: the page's screen.
      const held = await project('acting-nothing-held', autoStep('process', []), false);
      const idh = await started(held.def);
      await runStore.claimStep(idh, 'process', held.def, {
        by: 'crown',
        by_source: 'ambient',
        channel: 'advance',
      });
      const since = (await runStore.get(idh)).claims!['process']!.since;
      const h = realm(['run', 'advance', idh]);
      // (a) red when the lines differ from the page's screen, or In flight is said twice; (b)
      //     prints both.
      expect({ code: h.code, tail: h.out.slice(3) }).toEqual({
        code: 0,
        tail: put(block(PAGE, "In flight: 'process' is in flight, taken by crown"), {
          '2026-10-04T22:26:13.994Z': since!,
          '65d2afc8-2cb3-4401-808c-1d83a40bf989': idh,
        }),
      });
      // Nothing owed: the run ended; only agent steps are ready; a question is open.
      const ended = await started(held.def);
      // (a) red when the run cannot be ended (fixture); (b) prints the exit.
      expect(realm(['run', 'abandon', ended]).code).toBe(0);
      const agentOnly = await project('acting-nothing-agent', agentStep('finish', []), false);
      const ida = await started(agentOnly.def);
      const asked = await project('acting-nothing-question', CONFIRM(), false);
      const q = await atQuestion(asked.def);
      const before = await runStore.get(q.id);
      const last = (runId: string) => realm(['run', 'advance', runId]).out.at(-1);
      // (a) red when a reason or its opening words change; (b) prints the three lines.
      expect([last(ended), last(ida), last(q.id)]).toEqual([
        'Nothing is owed to the engine: the run has ended (abandoned).',
        `Nothing is owed to the engine: an agent step is ready: 'finish' — drive it with realm agent --run-id ${ida} --provider <provider> --model <model>.`,
        `Nothing is owed to the engine: a question is open — realm run respond ${q.id} --gate ${q.gateId} --choice <one of: approve, reject>.`,
      ]);
      // (a) red when advance at an open question changes the run; (b) prints both records' steps.
      const afterQ = await runStore.get(q.id);
      expect([afterQ.completed_steps, afterQ.pending_gate?.gate_id]).toEqual([
        before.completed_steps,
        q.gateId,
      ]);
      // After a call that ran other steps: the way out in place of the phase line.
      const ranFirst = await project(
        'acting-nothing-after',
        [autoStep('a', []), needsN('compute', ['a'])].join('\n'),
        false,
      );
      const idr = await started(ranFirst.def);
      const rr = realm(['run', 'advance', idr]);
      // (a) red when the phase line comes back after steps ran, or exit 0; (b) prints stdout.
      expect({ code: rr.code, tail: rr.out.slice(-3) }).toEqual({
        code: 1,
        tail: [
          '→ a',
          "Stopped: 'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'",
          wayOut(idr),
        ],
      });
    });

    it('advance, L148 (open question): at an open question advance runs nothing, and its line is the reply’s respond command', async () => {
      claim(
        PAGE,
        "At an open question the command runs nothing, and its `Nothing is owed to the engine: a question is open — realm run respond …` line is rendered from the reply's answer.",
      );
      const { def } = await project('acting-open-q', A_THEN_QUESTION, true);
      const id = await started(def);
      realm(['run', 'advance', id]);
      const gateId = (await runStore.get(id)).pending_gate!.gate_id;
      const again = realm(['run', 'advance', id]);
      // (a) red when the line names another gate or choices, or a step runs; (b) prints stdout.
      expect({ last: again.out.at(-1), done: (await runStore.get(id)).completed_steps }).toEqual({
        last: `Nothing is owed to the engine: a question is open — realm run respond ${id} --gate ${gateId} --choice <one of: approve, reject>.`,
        done: ['a'],
      });
    });

    it('advance, L162 + L183: one `Stopped:` line per reason, in the page’s order; a completed run gets none; exit 1 when a step failed or cannot run, else 0', async () => {
      claim(
        PAGE,
        "`Stopped:` lines say why it stopped, one line for each reason that holds, in this order: a step that failed (`'<step>' failed: <error>`), the run ended (`the run has ended (<phase>)`), a question opened (with the `realm run respond` command), each step that cannot run (`'<step>' cannot run (<check>): <why>`, or `cannot run here (capability)` for a handler or adapter this program lacks, ending with its way out: `— load the missing extension, or run the step on a runner that has it`), agent steps ready (`an agent step is ready: '<step>' — drive it with realm agent --run-id <id> --provider <provider> --model <model>` for one, `agent steps are ready: '<a>', '<b>' — drive them with …` for several; put the provider and model you drive the run with in place of the two placeholders), each step another program holds (`'<step>' is in flight in another program — wait for it, or see realm run inspect <id>`), and otherwise `nothing is ready to run now`.",
      );
      claim(PAGE, 'A run the command completes gets no `Stopped:` line: the phase line says it.');
      claim(PAGE, 'Exit code 1 when a step failed or cannot run, else 0.');
      const go = async (id: string, steps: string) => {
        const { def } = await project(id, steps, true);
        const runId = await started(def);
        const r = realm(['run', 'advance', runId]);
        return {
          id: runId,
          code: r.code,
          stopped: r.out.filter((l) => l.startsWith('Stopped:')),
          last: r.out.at(-1),
        };
      };
      const failed = await go('acting-stop-failed', autoStep('a', [], ['handler: boom']));
      const question = await go(
        'acting-stop-question',
        [autoStep('a', []), CONFIRM().replace('    gate:', '    depends_on: [a]\n    gate:')].join(
          '\n',
        ),
      );
      const gateId = (await runStore.get(question.id)).pending_gate!.gate_id;
      const both = await go(
        'acting-stop-both',
        [autoStep('a', []), needsN('compute', ['a']), agentStep('finish', ['a'])].join('\n'),
      );
      const capability = await go(
        'acting-stop-capability',
        [autoStep('a', []), autoStep('x', ['a'], ['handler: missing_h'])].join('\n'),
      );
      const two = await go(
        'acting-stop-two',
        [autoStep('a', []), agentStep('f1', ['a']), agentStep('f2', ['a'])].join('\n'),
      );
      const completes = await go('acting-stop-completes', autoStep('a', []));
      // (a) red when a reason's words, their order, or the exit code changes; (b) prints them all.
      expect(
        [failed, question, both, capability, two, completes].map((s) => [s.code, s.stopped]),
      ).toEqual([
        [
          1,
          [
            "Stopped: 'a' failed: Handler 'boom' threw: boom",
            'Stopped: the run has ended (failed)',
          ],
        ],
        [
          0,
          [
            `Stopped: a question is open — realm run respond ${question.id} --gate ${gateId} --choice <one of: approve, reject>`,
          ],
        ],
        [
          1,
          [
            "Stopped: 'compute' cannot run (input_schema): Invalid input for step 'compute': the input must have required property 'n'",
            `Stopped: an agent step is ready: 'finish' — drive it with realm agent --run-id ${both.id} --provider <provider> --model <model>`,
          ],
        ],
        [
          1,
          [
            "Stopped: 'x' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it",
          ],
        ],
        [
          0,
          [
            `Stopped: agent steps are ready: 'f1', 'f2' — drive them with realm agent --run-id ${two.id} --provider <provider> --model <model>`,
          ],
        ],
        [0, []],
      ]);
      // (a) red when a completed run gets no phase line; (b) prints it.
      expect(completes.last).toBe(`Run ${completes.id}: phase 'completed'`);
      // The run ended: an expired abort.
      const { def } = await project('acting-stop-ended', CONFIRM('abort'), false);
      const q = await atQuestion(def, true);
      const ended = realm(['run', 'advance', q.id]);
      // (a) red when the ending's reason changes; (b) prints stdout.
      expect(ended.out.filter((l) => l.startsWith('Stopped:'))).toEqual([
        'Stopped: the run has ended (aborted)',
      ]);
    });

    it('advance, L162 + block: a step another process took between the pick and the claim — `→ <step>` then the fact, and the command goes on with what is left', async () => {
      claim(
        PAGE,
        'A step another process took while this one was about to run it is said as a fact, and the command goes on with what is left. The command prints `→ <step>` as it starts a step, before it claims it, so the losing program prints both lines, in this order — the second says another program took the step first, so it did not run here:',
      );
      const { def } = await project(
        'acting-race',
        [autoStep('process', []), autoStep('notify', [])].join('\n'),
        false,
      );
      const id = await started(def);
      // The other program's claim lands in the window between this program's pick and its claim:
      // a module this `realm` loads (--extensions-module) claims `process` as racer-a first.
      const core = pathToFileURL(realpathSync(join(ROOT, 'packages/core/dist/index.js'))).href;
      const racer = join(elsewhere, 'racer.mjs');
      writeFileSync(
        racer,
        [
          `import { JsonFileStore } from ${JSON.stringify(core)};`,
          'const claim = JsonFileStore.prototype.claimStep;',
          'let raced = false;',
          'JsonFileStore.prototype.claimStep = async function (runId, step, definition, claimant) {',
          "  if (!raced && step === 'process') {",
          '    raced = true;',
          "    await claim.call(this, runId, step, definition, { by: 'racer-a', by_source: 'ambient', channel: 'advance' });",
          '  }',
          '  return claim.call(this, runId, step, definition, claimant);',
          '};',
          'export default { handlers: {} };',
          '',
        ].join('\n'),
        'utf8',
      );
      const r = realm(['run', 'advance', id, '--extensions-module', racer]);
      const since = (await runStore.get(id)).claims!['process']!.since!;
      const at = r.out.indexOf('→ process');
      // (a) red when the lines differ from the page's screen (or are not adjacent), the command
      //     stops instead of going on, or the run's `process` was run here; (b) prints stdout.
      expect({
        code: r.code,
        pair: r.out.slice(at, at + 2),
        rest: r.out.slice(at + 2),
        ran: (await runStore.get(id)).completed_steps,
      }).toEqual({
        code: 0,
        pair: put(block(PAGE, "• Step 'process' was taken by racer-a"), {
          '2026-10-05T00:02:25.302Z': since,
        }),
        rest: [
          '→ notify',
          `Stopped: 'process' is in flight in another program — wait for it, or see realm run inspect ${id}`,
          `Run ${id}: phase 'running'`,
        ],
        ran: ['notify'],
      });
    });

    it('advance, L183: the steps run in this shell’s environment (its secrets, its .env); two programs with the same code and different secrets look the same to the preview', async () => {
      claim(
        PAGE,
        "The steps run in this shell's environment (its secrets, its `.env`); two programs with the same code and different secrets look the same to the preview (#592).",
      );
      const { def } = await project(
        'acting-env',
        [
          autoStep('a', [], ['handler: env']),
          CONFIRM().replace('    gate:', '    depends_on: [a]\n    gate:'),
          autoStep('b', ['confirm'], ['handler: env']),
        ].join('\n'),
        true,
      );
      const id = await started(def);
      // (a) red when the first program's call fails (fixture); (b) prints the exit.
      expect(realm(['run', 'advance', id], { env: { SECRET_625: 'from the shell' } }).code).toBe(0);
      await answer(id);
      // Another shell: no SECRET_625 set, a .env in its folder that holds another value.
      const other = realpathSync(mkdtempSync(join(tmpdir(), 'realm-625-acting-dotenv-')));
      folders.push(other);
      writeFileSync(join(other, '.env'), 'SECRET_625=from the dotenv\n', 'utf8');
      const second = realm(['run', 'advance', id], { cwd: other });
      const outputs = (await runStore.get(id)).evidence
        .filter((e) => e.step_id === 'a' || e.step_id === 'b')
        .map((e) => [e.step_id, e.output_summary]);
      // (a) red when a step does not see its shell's environment or .env, or the preview tells the
      //     two secrets apart; (b) prints the outputs and the preview's words.
      expect({ words: second.out[1], outputs }).toEqual({
        words:
          "This program: tester (from REALM_OPERATOR) · project code: same as the run's last record.",
        outputs: [
          ['a', { secret: 'from the shell' }],
          ['b', { secret: 'from the dotenv' }],
        ],
      });
    });

    it('resume, L210 + L219 + blocks: a step only the engine runs gets the advance line; a step that cannot run gets the step and the way out in place of the Drive it with: lines', async () => {
      claim(
        PAGE,
        'When the step that is ready again is one only the engine runs, one more line names it (`the step` / `the steps`).',
      );
      claim(
        PAGE,
        'When the step that is ready again cannot run — the workflow was registered again with a check the step fails — and nothing else can run, driving the run would only stop on that step: the step and the way out take the place of the `Drive it with:` lines.',
      );
      const failing = autoStep('a', [], ['handler: boom']);
      const proj = await project('acting-resume', failing, true);
      const id = await started(proj.def);
      const failedOnce = async (runId: string) => {
        realm(['run', 'advance', runId]);
        // (a) red when advance does not fail `a` (fixture); (b) prints the failed steps.
        expect((await runStore.get(runId)).failed_steps, 'fixture').toEqual(['a']);
      };
      await failedOnce(id);
      const r = realm(['run', 'resume', id, '--from', 'a']);
      // (a) red when resume prints other lines than the page's screen; (b) prints both.
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: put(block(PAGE, "Resumed run '8bc06d55"), {
          '8bc06d55-77fb-43f4-937f-8d166fad20cf': id,
        }),
      });
      // Registered again with a check `a` fails: the step and the way out.
      const id2 = await started(proj.def);
      await failedOnce(id2);
      writeFileSync(
        join(proj.dir, 'workflows', 'wf', 'workflow.yaml'),
        yamlOf(
          'acting-resume',
          needsN('a', []).replace('    depends_on: []', '    depends_on: []\n    handler: boom'),
          true,
        ),
        'utf8',
      );
      // (a) red when registering the corrected workflow again fails; (b) prints the exit.
      expect(
        realm(['workflow', 'register', 'workflows/wf/workflow.yaml'], { cwd: proj.dir }).code,
      ).toBe(0);
      const r2 = realm(['run', 'resume', id2, '--from', 'a']);
      // (a) red when resume prints the Drive it with: lines for a step that cannot run, or other
      //     lines than the page's screen; (b) prints both.
      expect({ code: r2.code, out: r2.out }).toEqual({
        code: 0,
        out: put(block(PAGE, "Resumed run '729eaab3"), {
          '729eaab3-6203-46cb-9c5c-3714070723a8': id2,
        }),
      });
    });

    it('drain, L474 + L482 + blocks: --expired --force on a gate whose default leaves an engine step names it; when it leaves nothing that can run, the step and the way out follow', async () => {
      claim(
        PAGE,
        'When the enacted gate leaves `auto` steps only the engine runs, one more line names them.',
      );
      claim(
        PAGE,
        'When it leaves nothing that can run from here, the steps that cannot run and the way out follow instead.',
      );
      const owes = await project(
        'acting-drain-owes',
        [CONFIRM('settle_default'), autoStep('after', ['confirm'])].join('\n'),
        false,
      );
      const q = await atQuestion(owes.def, true);
      const r = realm(['run', 'drain', q.id, '--expired', '--force']);
      // (a) red when drain prints other lines than the page's screen; (b) prints both.
      expect({ code: r.code, out: r.out }).toEqual({
        code: 0,
        out: put(
          block(
            PAGE,
            "Run 'daeede5e-c0dd-4b88-9caf-6efa089902dd' is not terminal (phase: 'running') — nothing further",
          ),
          {
            'daeede5e-c0dd-4b88-9caf-6efa089902dd': q.id,
          },
        ),
      });
      const stuck = await project(
        'acting-drain-stuck',
        [CONFIRM('settle_default'), needsN('compute', ['confirm'])].join('\n'),
        false,
      );
      const qs = await atQuestion(stuck.def, true);
      const rs = realm(['run', 'drain', qs.id, '--expired', '--force']);
      // (a) red when drain prints other lines than the page's screen; (b) prints both.
      expect({ out: rs.out }).toEqual({
        out: put(block(PAGE, "Run '1d703406"), {
          '1d703406-777f-4bc6-a6bc-6058b4d8f490': qs.id,
        }),
      });
    });

    it('drain, L515 + L516: nothing to drain on a run in `running` — the step the engine owes and both ways out; a step that cannot run and its way out', async () => {
      const shown = block(PAGE, 'No runs with an actionable pending finalizer.');
      const owes = await project('acting-drain-nothing', autoStep('after', []), false);
      const id = await started(owes.def);
      const stuck = await project('acting-drain-nothing-stuck', needsN('compute', []), false);
      const ids = await started(stuck.def);
      const line = (runId: string) => {
        const r = realm(['run', 'drain', runId]);
        return { code: r.code, lines: [...r.out, ...r.err] };
      };
      // (a) red when either line differs from the page's (its run ID put in place); (b) prints both.
      expect([line(id), line(ids)]).toEqual([
        {
          code: 0,
          lines: [shown[2]!.replaceAll('daeede5e-c0dd-4b88-9caf-6efa089902dd', id)],
        },
        {
          code: 0,
          lines: [shown[3]!.replaceAll('573ff99d-44fc-42c9-98e8-c394fed45e6e', ids)],
        },
      ]);
    });
  },
);
