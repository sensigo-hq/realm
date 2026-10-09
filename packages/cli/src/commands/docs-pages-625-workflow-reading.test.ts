// docs-pages-625-workflow-reading.test.ts — issue #625 PR-2a, decision C174 (round 22), lane D: each
// sentence on docs/reference/cli/realm-workflow.md and docs/reference/cli/realm-run-reading.md about
// behaviour #625 PR-2a adds or changes, that no cell quoted yet, is quoted here word for word (read
// from the repository) by a cell that drives the case on the real code and asserts what the sentence
// states — so neither the page nor the behaviour can change alone. An example screen is compared
// line by line with the command's real output, its run and gate IDs and folders put in place.
//
// Two harnesses: the built `realm` as a child process (fresh HOME), and — for the prompts of `realm
// workflow run`, which needs a terminal — the real command in-process with `node:readline/promises`
// mocked (the #447 harness of run-prompt-625.test.ts): each prompt is answered by its own text.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  advanceRun,
  executeStep,
  loadWorkflowFromString,
} from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { runCommand, renderDetachMap } from './run.js';
import { attendingLine } from './run-advance.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const flat = (t: string) => t.replace(/\s+/g, ' ');
const WF_PAGE = 'docs/reference/cli/realm-workflow.md';
const RD_PAGE = 'docs/reference/cli/realm-run-reading.md';

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

/** A block's lines without its blank ones, each `from` replaced by its `to`. */
const put = (lines: string[], ids: Record<string, string>): string[] =>
  lines
    .filter((l) => l !== '')
    .map((l) => Object.entries(ids).reduce((t, [from, to]) => t.replaceAll(from, to), l));

const wf = (lines: string[]): WorkflowDefinition =>
  loadWorkflowFromString([...lines, ''].join('\n'));

/** The built `realm` as a child process, with HOME at `home` and no colour. */
function realm(
  home: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): { code: number | null; out: string[]; err: string[] } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? home,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1', ...opts.env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const lines = (t: string) => t.split('\n').filter((l) => l !== '');
  return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
}

const NEEDS_N = [
  '    input_schema:',
  '      type: object',
  '      required: [n]',
  '      properties:',
  '        n: { type: number }',
];

describe(
  '#625 PR-2a, C174 lane D — realm-run-reading.md, from the built realm',
  { timeout: 60_000 },
  () => {
    let home: string;
    let runStore: JsonFileStore;
    let workflowStore: JsonWorkflowStore;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'realm-625-pin-d-'));
      mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
      runStore = new JsonFileStore(join(home, '.realm', 'runs'));
      workflowStore = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    async function started(def: WorkflowDefinition, params: Record<string, unknown> = {}) {
      await workflowStore.register(def);
      const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params });
      return run.id;
    }
    const inspect = (id: string): string[] => realm(home, ['run', 'inspect', id]).out;

    it('line 5: the other eleven subcommands are on the acting page — --help lists 17, the acting table 11, this one 6', () => {
      claim(
        RD_PAGE,
        'The other eleven are in [`realm run`: commands that act](realm-run-acting.md).',
      );
      const help = realm(home, ['run', '--help']).out;
      const commands = help
        .slice(help.findIndex((l) => l === 'Commands:') + 1)
        .filter((l) => /^ {2}[a-z]/.test(l))
        .map((l) => l.trim().split(/[ |]/)[0]!)
        .filter((c) => c !== 'help');
      const rows = (page: string) =>
        [...readFileSync(join(ROOT, page), 'utf8').matchAll(/^\| \[`([a-z]+)`\]\(#/gm)].map(
          (m) => m[1]!,
        );
      const acting = rows('docs/reference/cli/realm-run-acting.md');
      const reading = rows(RD_PAGE);
      // (a) red when a subcommand is added, removed or moved without the pages saying so, or the
      //     acting page holds other than eleven; (b) prints both pages' tables and what --help lists.
      expect({
        acting: acting.length,
        reading: reading.length,
        all: [...acting, ...reading].sort(),
      }).toEqual({
        acting: 11,
        reading: 6,
        all: [...commands].sort(),
      });
    });

    it('lines 152, 174, 177–179: what the engine owes, and steps that cannot run, from three runs — inspect judges a missing handler by the record, and a program that has it runs the step', async () => {
      claim(
        RD_PAGE,
        "| `Owed to the engine` | When guards or `auto` steps are owed, or an expired question's `on_expiry` | The steps (or `the expired question on '<step>' (its declared <on_expiry>)`), and the `realm run advance` command that runs them. Added after version 0.46.0. |",
      );
      claim(
        RD_PAGE,
        'What the engine owes, and steps that cannot run, from three runs (these lines were added after version 0.46.0).',
      );
      claim(
        RD_PAGE,
        "`inspect` loads no extensions, so a missing handler or adapter is judged by the run's record of the last attempt and said in the past tense (`Could not run`), with the way out — a program that has it runs the step:",
      );
      const owes = wf([
        'id: owes',
        'name: owes',
        'version: 1',
        'steps:',
        '  process:',
        '    description: Process.',
        '    execution: auto',
        '    handler: stamp',
        '  notify:',
        '    description: Notify.',
        '    execution: auto',
      ]);
      const needsN = wf([
        'id: needs-n',
        'name: needs-n',
        'version: 1',
        'steps:',
        '  ask:',
        '    description: Ask.',
        '    execution: agent',
        '  compute:',
        '    description: Compute.',
        '    execution: auto',
        ...NEEDS_N,
      ]);
      // Run 1: nothing attempted yet — no runner's record says 'stamp' is missing, so inspect (which
      // loads no extension) names 'process' as owed, never as a step that cannot run.
      const a = await started(owes);
      const shownA = inspect(a);
      // Run 2: an input its schema refuses.
      const b = await started(needsN);
      const shownB = inspect(b);
      // Run 3: `realm run advance` from a program without 'stamp' — its record now says so.
      const c = await started(owes);
      const advanced = realm(home, ['run', 'advance', c]);
      // Fixture: (a) red when that advance never finished (killed at the timeout); (b) prints its
      //     stderr.
      expect(advanced.code, advanced.err.join('\n')).not.toBeNull();
      const shownC = inspect(c);
      const pick = (lines: string[], start: string) => lines.find((l) => l.startsWith(start));
      // (a) red when inspect's owed line, `Cannot run` line or past-tense `Could not run` line differs
      //     from the page's screen (ids aside) — or inspect judges 'stamp' by a registry of its own
      //     (run 1 would then read `cannot run here`); (b) prints the three lines beside the page's.
      expect([
        pick(shownA, 'Owed to the engine:'),
        pick(shownB, 'Cannot run '),
        pick(shownC, 'Could not run '),
      ]).toEqual(
        put(block(RD_PAGE, "Owed to the engine: 'process', 'notify'"), {
          'b178179a-998d-457e-85e6-6d38439d0585': a,
          '31ddb305-989b-42bf-8b63-fcb558ed1c23': c,
        }),
      );
      // (a) red when run 1 also says 'process' cannot run; (b) prints inspect's output.
      expect(
        shownA.filter((l) => /^Could not run|^Cannot run/.test(l)),
        shownA.join('\n'),
      ).toEqual([]);
      // The way out: a program that has the handler runs the step.
      const ext = join(home, 'stamp-ext.mjs');
      writeFileSync(
        ext,
        "export default { handlers: { stamp: { id: 'stamp', execute: async () => ({ data: { stamped: true } }) } } };\n",
        'utf8',
      );
      const withIt = realm(home, ['run', 'advance', c, '--extensions-module', ext]);
      const after = inspect(c);
      // (a) red when the way out does not run the step, or inspect still says it could not run;
      //     (b) prints advance's output and inspect's.
      expect(
        {
          code: withIt.code,
          phase: after.find((l) => l.startsWith('Phase:')),
          couldNot: after.filter((l) => l.startsWith('Could not run')),
        },
        [...withIt.out, ...withIt.err, '---', ...after].join('\n'),
      ).toEqual({ code: 0, phase: expect.stringContaining('completed'), couldNot: [] });
    });

    it('lines 154, 182, 185–186: when nothing else can run and a step is refused before its claim, the way out follows the Cannot run lines — and only then', async () => {
      claim(
        RD_PAGE,
        '| `Run <id> stays open` | When the run cannot go on until its workflow is corrected | The way out: correct the workflow, register it again, then `realm run advance`; or `realm run abandon`. Added after version 0.46.0. |',
      );
      claim(
        RD_PAGE,
        'When nothing else can run — no agent step ready, nothing owed that can run, nothing in flight — and a step is refused before its claim (an invalid `trust`, a failed precondition, an input its schema refuses), the run cannot go on until its workflow is corrected, and the way out follows the `Cannot run` lines:',
      );
      const STAYS = ' stays open (phase ';
      /** The `Cannot run` line and the line that follows it. */
      const head = (lines: string[]) => {
        const at = lines.findIndex((l) => l.startsWith('Cannot run '));
        return lines.slice(at, at + 2);
      };
      // Each workflow its own id: inspect reads the registered copy, so one id would share one copy.
      const needsN = (id: string, extra: string[] = []) =>
        wf([
          `id: ${id}`,
          `name: ${id}`,
          'version: 1',
          'steps:',
          '  ask:',
          '    description: Ask.',
          '    execution: agent',
          ...extra,
          '  compute:',
          '    description: Compute.',
          '    execution: auto',
          ...NEEDS_N,
        ]);
      // An agent step ready: something else can run.
      const ready = await started(needsN('n-ready'));
      // A step in flight: 'ask' taken and not finished.
      const flying = await started(needsN('n-flying'));
      const flyingRecord = await runStore.get(flying);
      await runStore.update({ ...flyingRecord, in_progress_steps: ['ask'] });
      // Something owed that can run: 'other', an `auto` step with nothing refusing it.
      const owedDef = needsN('n-owed', [
        '  other:',
        '    description: Other.',
        '    execution: auto',
      ]);
      const owed = await started(owedDef);
      await executeStep(runStore, owedDef, {
        runId: owed,
        command: 'ask',
        input: {},
        dispatcher: async () => ({}),
      });
      // Nothing else: 'ask' answered, only 'compute' left.
      const def = needsN('n-stuck');
      const stuck = await started(def);
      await executeStep(runStore, def, {
        runId: stuck,
        command: 'ask',
        input: {},
        dispatcher: async () => ({}),
      });
      const shown = {
        ready: inspect(ready),
        flying: inspect(flying),
        owed: inspect(owed),
        stuck: inspect(stuck),
      };
      // (a) red when the way out is printed while an agent step is ready, a step is in flight or
      //     something owed can run (each conjunct of `nothing else can run`) — or is not printed when
      //     nothing else can; (b) prints each run's `Cannot run` and way-out lines.
      expect(
        Object.fromEntries(
          Object.entries(shown).map(([k, lines]) => [
            k,
            lines.filter((l) => l.startsWith('Cannot run ') || l.includes(STAYS)).length,
          ]),
        ),
      ).toEqual({ ready: 1, flying: 1, owed: 1, stuck: 2 });
      // (a) red when the stuck run's lines differ from the page's screen (ids aside); (b) prints both.
      expect(head(shown.stuck)).toEqual(
        put(block(RD_PAGE, 'Run 573ff99d-44fc-42c9-98e8-c394fed45e6e stays open'), {
          '573ff99d-44fc-42c9-98e8-c394fed45e6e': stuck,
        }),
      );

      // The other two refusals before the claim the sentence names: a failed precondition and an
      // invalid `trust` (the loader refuses an invalid trust, so the registered copy is written with
      // it, as a copy stored before that check would hold it).
      const lone = (id: string, step: string[]) =>
        wf([
          `id: ${id}`,
          `name: ${id}`,
          'version: 1',
          'steps:',
          '  compute:',
          '    description: Compute.',
          '    execution: auto',
          ...step,
        ]);
      const preDef = lone('pre', ['    preconditions: ["run.params.ok == true"]']);
      const pre = await started(preDef);
      const trustDef = lone('bad-trust', []);
      (trustDef.steps['compute'] as { trust?: unknown }).trust = 'bogus_value';
      const bad = await started(trustDef);
      const wayOut = (id: string) =>
        `Run ${id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${id}; or end it: realm run abandon ${id}.`;
      const tail = (id: string) => head(inspect(id));
      const preLines = tail(pre);
      const trustLines = tail(bad);
      // (a) red when a failed precondition or an invalid trust does not end in the way out, or names
      //     another check; (b) prints the two lines of each.
      expect({
        pre: [preLines[0]!.slice(0, preLines[0]!.indexOf(':')), preLines[1]],
        trust: [trustLines[0]!.slice(0, trustLines[0]!.indexOf(':')), trustLines[1]],
      }).toEqual({
        pre: ["Cannot run 'compute' (precondition)", wayOut(pre)],
        trust: ["Cannot run 'compute' (trust)", wayOut(bad)],
      });

      // The way out, walked: correct the workflow, register it again, then advance — the step runs;
      // or abandon — the run ends.
      const project = mkdtempSync(join(tmpdir(), 'realm-625-pin-d-fix-'));
      writeFileSync(
        join(project, 'workflow.yaml'),
        [
          'id: pre',
          'name: pre',
          'version: 1',
          'steps:',
          '  compute:',
          '    description: Compute.',
          '    execution: auto',
          '',
        ].join('\n'),
      );
      const reg = realm(home, ['workflow', 'register', join(project, 'workflow.yaml')]);
      const adv = realm(home, ['run', 'advance', pre]);
      const ab = realm(home, ['run', 'abandon', stuck]);
      rmSync(project, { recursive: true, force: true });
      // (a) red when the corrected-and-registered workflow does not let advance run the step, or
      //     abandon does not end the run; (b) prints the exits and phases.
      expect(
        {
          reg: reg.code,
          adv: adv.code,
          pre: (await runStore.get(pre)).run_phase,
          ab: ab.code,
          stuck: (await runStore.get(stuck)).run_phase,
        },
        [...reg.err, ...adv.out, ...adv.err, ...ab.out, ...ab.err].join('\n'),
      ).toEqual({ reg: 0, adv: 0, pre: 'completed', ab: 0, stuck: 'abandoned' });
    });

    it("line 313: an answer the expiry wrote reads `settled by the gate's expiry (no answer in time)`, no answerer, no proof — whether no answer came, or one came late and was not recorded", async () => {
      claim(
        RD_PAGE,
        "An answer the gate's expiry wrote with its default choice reads `Answer: hold · settled by the gate's expiry (no answer in time)`, with no answerer and no proof part: no answer came before the time was up, or one came after it and was not recorded.",
      );
      const def = wf([
        'id: exp313',
        'name: exp313',
        'version: 1',
        'steps:',
        '  review:',
        '    description: Review.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [ship, hold]',
        '      timeout_seconds: 3600',
        '      on_expiry: settle_default',
        '      default_choice: hold',
      ]);
      async function opened(expired: boolean) {
        const id = await started(def);
        await executeStep(runStore, def, {
          runId: id,
          command: 'review',
          input: {},
          dispatcher: async () => ({}),
        });
        const record = await runStore.get(id);
        if (expired) {
          await runStore.update({
            ...record,
            pending_gate: {
              ...record.pending_gate!,
              opened_at: '2020-01-01T00:00:00.000Z',
              expires_at: '2020-01-01T01:00:00.000Z',
            },
          });
        }
        return { id, gateId: record.pending_gate!.gate_id };
      }
      const answerLine = (id: string) =>
        inspect(id)
          .map((l) => l.trim())
          .filter((l) => l.startsWith('Answer:'));
      // No answer came: `realm run advance` carries the expiry out.
      const none = await opened(true);
      const carried = realm(home, ['run', 'advance', none.id]);
      // Fixture: (a) red when advance does not carry the expiry out; (b) prints its stderr.
      expect(carried.code, carried.err.join('\n')).toBe(0);
      // One came after the time was up, and was not recorded.
      const late = await opened(true);
      const lateR = realm(home, [
        'run',
        'respond',
        late.id,
        '--gate',
        late.gateId,
        '--choice',
        'ship',
        '--by',
        'alice',
      ]);
      // Control: one came in time — it has an answerer and a proof part.
      const inTime = await opened(false);
      realm(home, [
        'run',
        'respond',
        inTime.id,
        '--gate',
        inTime.gateId,
        '--choice',
        'ship',
        '--by',
        'alice',
      ]);
      const WORDS = "Answer: hold · settled by the gate's expiry (no answer in time)";
      // (a) red when an expiry's answer names an answerer or a proof, or the late answer is recorded
      //     (its line would read `ship · answered by alice`); (b) prints each run's `Answer:` lines.
      expect({
        none: answerLine(none.id),
        late: answerLine(late.id),
        lateExit: lateR.code,
        inTime: answerLine(inTime.id),
      }).toEqual({
        none: [WORDS],
        late: [WORDS],
        lateExit: 1,
        inTime: [expect.stringMatching(/^Answer: ship · answered by alice .* · proof: /)],
      });
    });
  },
);

describe(
  '#625 PR-2a, C174 lane D — realm-workflow.md, from the real command',
  { timeout: 60_000 },
  () => {
    let home: string;
    let dir: string;
    let savedHome: string | undefined;
    let savedTTY: boolean | undefined;
    let logSpy: ReturnType<typeof vi.spyOn>;
    let errSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      clearProjectExtensionsCache();
      home = mkdtempSync(join(tmpdir(), 'realm-625-pin-d-home-'));
      dir = mkdtempSync(join(tmpdir(), 'realm-625-pin-d-wf-'));
      mkdirSync(join(home, '.realm'), { recursive: true });
      savedHome = process.env['HOME'];
      process.env['HOME'] = home;
      // Without this the non-TTY guard refuses before the loop.
      savedTTY = process.stdin.isTTY;
      process.stdin.isTTY = true;
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
        throw new Error('process.exit');
      }) as never);
    });

    afterEach(() => {
      if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else process.stdin.isTTY = savedTTY;
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
      mocks.question.mockReset();
      vi.restoreAllMocks();
    });

    const logged = (): string[] => logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const errored = (): string[] => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const asked = (): string[] => mocks.question.mock.calls.map((c: unknown[]) => String(c[0]));
    const runIds = (): string[] => {
      try {
        return readdirSync(join(home, '.realm', 'runs'))
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace('.json', ''));
      } catch {
        return [];
      }
    };
    async function readRecord(id: string) {
      return new JsonFileStore(join(home, '.realm', 'runs')).get(id);
    }

    /** Runs `realm workflow run <file>`; returns the exit code (0 for a natural return). */
    async function run(lines: string[]): Promise<number> {
      logSpy.mockClear();
      errSpy.mockClear();
      exitSpy.mockClear();
      mocks.question.mockClear();
      writeFileSync(join(dir, 'workflow.yaml'), [...lines, ''].join('\n'), 'utf8');
      try {
        await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });
        return 0;
      } catch (err) {
        if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
        return Number(exitSpy.mock.calls[0]?.[0]);
      }
    }

    it("lines 208, 211, 213: the gate's prompt closes on the expiry, prints the record's answer in inspect's words, and the run goes on", async () => {
      claim(
        WF_PAGE,
        "It then prints what the run's record holds, in the words of `realm run inspect`, and the run goes on:",
      );
      let choicePrompt: string | undefined;
      mocks.question.mockImplementation((prompt: string, opts?: { signal?: AbortSignal }) => {
        if (prompt.startsWith('  Choice ')) {
          choicePrompt = prompt;
          // Nothing is typed: the prompt waits until its question is settled elsewhere.
          return new Promise<string>((_resolve, reject) => {
            opts?.signal?.addEventListener(
              'abort',
              () =>
                reject(
                  Object.assign(new Error('The operation was aborted'), {
                    name: 'AbortError',
                    code: 'ABORT_ERR',
                  }),
                ),
              { once: true },
            );
          });
        }
        if (prompt.startsWith('  Mock output') || prompt.startsWith('  Agent output')) {
          return Promise.resolve('');
        }
        return Promise.reject(new Error(`fixture: an unexpected prompt: ${prompt}`));
      });
      const code = await run([
        'id: review-ship',
        'name: review-ship',
        'version: 1',
        'steps:',
        '  review:',
        '    description: Review.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [ship, hold]',
        '      timeout_seconds: 1',
        '      on_expiry: settle_default',
        '      default_choice: hold',
        '  publish:',
        '    description: Publish.',
        '    execution: agent',
        '    depends_on: [review]',
      ]);
      const id = runIds()[0]!;
      const out = logged();
      const gateLine = out.find((l) => l.startsWith('  ⏸  Gate: review | gate_id: '))!;
      const gateId = gateLine.replace('  ⏸  Gate: review | gate_id: ', '');
      const timer = out.find((l) => l.startsWith('⏰ '));
      const closed = out.find((l) => l.startsWith('  This prompt is closed:'));
      // The page's screen is the terminal's: the timer's line lands after the prompt's text, and the
      // blank line is readline's own end of the prompt's line (readline is mocked here).
      // (a) red when the timer's line or the close line differs from the page's (ids aside), or the
      //     prompt does not close; (b) prints both.
      expect([`${choicePrompt ?? ''}${timer ?? ''}`, closed]).toEqual(
        put(block(WF_PAGE, 'This prompt is closed: the question on'), {
          "'02ebe774-…'": `'${gateId}'`,
          "'81771ac5-…'": `'${id}'`,
        }),
      );
      // In the words of `realm run inspect`: its `Answer:` line, word for word.
      const inspected = realm(home, ['run', 'inspect', id]).out.map((l) => l.trim());
      // (a) red when the close line's answer is not inspect's `Answer:` line; (b) prints both.
      expect(closed!.slice(closed!.indexOf(' — ') + 3).replace(/\.$/, '')).toBe(
        inspected.find((l) => l.startsWith('Answer:')),
      );
      // And the run goes on: the next step is offered after the close, and the run completes.
      // (a) red when the run stops at the closed prompt; (b) prints stdout and the phase.
      expect(
        {
          next: out.indexOf('→ [agent] publish: Publish.') > out.indexOf(closed!),
          phase: (await readRecord(id)).run_phase,
          code,
        },
        out.join('\n'),
      ).toEqual({ next: true, phase: 'completed', code: 0 });
    }, 30_000);

    it("line 231: an `auto` step's answer is the one typed, so a step whose input its schema refuses is asked for again", async () => {
      claim(
        WF_PAGE,
        "An `auto` step's answer is the one you type, so a step whose input its schema refuses is asked for again.",
      );
      const typed = ['{}', '{"n": 1}'];
      mocks.question.mockImplementation(async (prompt: string) => {
        if (prompt.startsWith('  Mock output')) return typed.shift() ?? '';
        throw new Error(`fixture: an unexpected prompt: ${prompt}`);
      });
      const code = await run([
        'id: asked-again',
        'name: asked-again',
        'version: 1',
        'steps:',
        '  compute:',
        '    description: Compute.',
        '    execution: auto',
        ...NEEDS_N,
      ]);
      // (a) red when the refused answer is not asked for again (the step stalls or is skipped), or
      //     the second, valid answer does not run it; (b) prints the prompts, stderr and the exit.
      expect(
        {
          asked: asked(),
          refused: errored().some((l) => l.includes("Invalid input for step 'compute'")),
          phase: (await readRecord(runIds()[0]!)).run_phase,
          code,
        },
        errored().join('\n'),
      ).toEqual({
        asked: [
          '  Mock output (auto) — JSON (Enter for {}): ',
          '  Mock output (auto) — JSON (Enter for {}): ',
        ],
        refused: true,
        phase: 'completed',
        code: 0,
      });
    }, 30_000);

    it('lines 231, 234–236: a step no typed answer can unblock is not asked for; when nothing else can run the run stops, names each such step and the way out', async () => {
      claim(
        WF_PAGE,
        'A step that no typed answer can unblock — a failed precondition, an invalid `trust`, a handler or adapter this program lacks — is not asked for.',
      );
      claim(
        WF_PAGE,
        'When nothing else can run, the run stops there, names each such step and gives the way out.',
      );
      mocks.question.mockImplementation(async (prompt: string) => {
        throw new Error(`fixture: an unexpected prompt: ${prompt}`);
      });
      const lone = (id: string, step: string[]) => [
        `id: ${id}`,
        `name: ${id}`,
        'version: 1',
        'steps:',
        '  compute:',
        '    description: Compute.',
        '    execution: auto',
        ...step,
      ];
      // A failed precondition: the page's screen.
      const preCode = await run(
        lone('stall-pre', ['    preconditions: ["run.params.ok == true"]']),
      );
      const pre = runIds()[0]!;
      const preAsked = asked();
      const preErr = errored()
        .flatMap((l) => l.split('\n'))
        .filter((l) => l !== '');
      // (a) red when the step is asked for, the screen differs from the page's (the id aside), or
      //     the run does not stop with exit 1; (b) prints the prompts, stderr and the exit.
      expect({ asked: preAsked, err: preErr, code: preCode }).toEqual({
        asked: [],
        err: put(block(WF_PAGE, 'Workflow stalled: nothing else can run.'), {
          '2a319588-0843-41c4-b28b-44f88ecb0752': pre,
        }),
        code: 1,
      });
      rmSync(join(home, '.realm', 'runs'), { recursive: true, force: true });
      // A handler this program lacks.
      const capCode = await run(lone('stall-cap', ['    handler: missing_h']));
      const cap = runIds()[0]!;
      // (a) red when the step is asked for, or the stop does not name it and a way out; (b) prints
      //     the prompts, stderr and the exit.
      expect({
        asked: asked(),
        err: errored()
          .flatMap((l) => l.split('\n'))
          .filter((l) => l !== ''),
        code: capCode,
      }).toEqual({
        asked: [],
        err: [
          'Workflow stalled: nothing else can run.',
          "'compute' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it.",
          `To end the run instead: realm run abandon ${cap}.`,
        ],
        code: 1,
      });
      rmSync(join(home, '.realm', 'runs'), { recursive: true, force: true });
      // An invalid trust: the loader refuses the file before any run exists, so nothing is asked.
      const trustCode = await run(lone('stall-trust', ['    trust: bogus_value']));
      // (a) red when a step with an invalid trust is asked for, or a run is created for it; (b)
      //     prints the prompts, the runs and stderr.
      expect({ asked: asked(), runs: runIds(), code: trustCode }, errored().join('\n')).toEqual({
        asked: [],
        runs: [],
        code: 1,
      });
      // (a) red when the refusal does not name the step and its trust value; (b) prints stderr.
      expect(errored().join('\n')).toContain(
        "Step 'compute': 'trust: \"bogus_value\"' is not a recognized value",
      );
    }, 30_000);

    it('line 241: the exit code — 0 completed; 1 for any other ending, nothing else could run, a left prompt (Ctrl+C or Ctrl+D), no terminal', async () => {
      claim(
        WF_PAGE,
        // decision C188: the hand-back's exit is pinned by its own cell (run-prompt-625, round 24).
        '**Exit code:** 0 if the run completed; 1 if it ended in any other way, if nothing else could run, if it stopped waiting for a step another program holds, if you left a prompt with Ctrl+C or Ctrl+D, or if there was no terminal.',
      );
      const agentStep = [
        'id: exit-ok',
        'name: exit-ok',
        'version: 1',
        'steps:',
        '  note:',
        '    description: Note.',
        '    execution: agent',
      ];
      // Completed.
      mocks.question.mockImplementation(async () => '');
      const completed = await run(agentStep);
      const beforeAbort = runIds();
      // Another ending: the gate's answer makes the guard abort the run.
      mocks.question.mockImplementation(async (prompt: string) =>
        prompt.startsWith('  Choice ') ? 'hold' : '',
      );
      const aborted = await run([
        'id: exit-abort',
        'name: exit-abort',
        'version: 1',
        'steps:',
        '  review:',
        '    description: Review.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [ship, hold]',
        '  check:',
        '    description: Check.',
        '    execution: guard',
        '    depends_on: [review]',
        `    abort_unless: ["review.choice == 'ship'"]`,
        '    abort_message: Held.',
      ]);
      const abortedPhase = (await readRecord(runIds().find((i) => !beforeAbort.includes(i))!))
        .run_phase;
      // Nothing else could run.
      const stalled = await run([
        'id: exit-stall',
        'name: exit-stall',
        'version: 1',
        'steps:',
        '  compute:',
        '    description: Compute.',
        '    execution: auto',
        '    preconditions: ["run.params.ok == true"]',
      ]);
      // A left prompt: readline rejects with ABORT_ERR on Ctrl+C and on Ctrl+D.
      mocks.question.mockImplementation(async () => {
        throw Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        });
      });
      const left = await run(agentStep);
      const leftErr = errored().join('\n');
      // No terminal: the built `realm`, stdin a pipe.
      const project = mkdtempSync(join(tmpdir(), 'realm-625-pin-d-tty-'));
      writeFileSync(join(project, 'workflow.yaml'), [...agentStep, ''].join('\n'));
      const before = runIds().length;
      const noTty = realm(home, ['workflow', 'run', join(project, 'workflow.yaml')], {
        cwd: project,
      });
      rmSync(project, { recursive: true, force: true });
      // (a) red when any of the five endings exits otherwise than the page says, or the fixture's
      //     ending is not the one named; (b) prints each exit, the aborted phase and the cancel's line.
      expect({
        completed,
        aborted,
        abortedPhase,
        stalled,
        left,
        leftSaid: leftErr.includes('Prompt cancelled — detached from run'),
        noTty: noTty.code,
        noRun: runIds().length === before,
      }).toEqual({
        completed: 0,
        aborted: 1,
        abortedPhase: 'aborted',
        stalled: 1,
        left: 1,
        leftSaid: true,
        noTty: 1,
        noRun: true,
      });
    }, 60_000);

    it('lines 264–271: realm workflow test indents a fixture error’s later lines under its FAIL line — a fixture whose precondition fails, nothing else left to run', () => {
      claim(
        WF_PAGE,
        "When a fixture's error takes several lines, the second and later lines are indented under its `FAIL` line.",
      );
      claim(
        WF_PAGE,
        "A fixture whose step's precondition fails, with nothing else left to run ([what each failure prints](../testing-package.md)):",
      );
      const project = mkdtempSync(join(tmpdir(), 'realm-625-pin-d-test-'));
      mkdirSync(join(project, 'flow', 'fixtures'), { recursive: true });
      writeFileSync(
        join(project, 'flow', 'workflow.yaml'),
        [
          'id: flow',
          'name: flow',
          'version: 1',
          'steps:',
          '  compute:',
          '    description: Compute.',
          '    execution: auto',
          '    preconditions: ["run.params.ok == true"]',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(project, 'flow', 'fixtures', 'one.yaml'),
        ['name: one', 'params: {}', 'expected:', '  final_state: completed', ''].join('\n'),
      );
      const r = realm(home, ['workflow', 'test', 'flow', '-f', 'flow/fixtures'], { cwd: project });
      rmSync(project, { recursive: true, force: true });
      // (a) red when the later line of the error is not indented under FAIL, the fixture fails with
      //     another error (0.46.0's `exceeded maximum loop iterations`), or the screen differs from
      //     the page's; (b) prints stdout, stderr and the exit.
      expect({ code: r.code, out: r.out }, r.err.join('\n')).toEqual({
        code: 1,
        out: put(block(WF_PAGE, 'FAIL one: Workflow stalled'), {}),
      });
    });

    it('round 25, C196 (walk c10, W3-4): leaving the prompt — the map’s `Drive it:` line is followed by the line `realm run respond` and `realm run advance` print after theirs, from the same composer; the page’s screen', async () => {
      claim(
        WF_PAGE,
        'Leaving a prompt with Ctrl+D or Ctrl+C keeps the run and says how to carry on:',
      );
      mocks.question.mockImplementation(async () => {
        throw Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        });
      });
      const code = await run([
        'id: leave-note',
        'name: leave-note',
        'version: 1',
        'steps:',
        '  note:',
        '    description: Note.',
        '    execution: agent',
      ]);
      const id = runIds()[0]!;
      const map = errored()
        .join('\n')
        .split('\n')
        .filter((l) => l !== '');
      const at = map.findIndex((l) => l.startsWith('Prompt cancelled'));
      // (a) red when the line under `Drive it:` is missing, moved or reworded, or the screen differs
      //     from the page's; (b) prints stderr and the exit.
      expect({ code, map: map.slice(at) }).toEqual({
        code: 1,
        map: put(block(WF_PAGE, 'Prompt cancelled — detached from run'), {
          '00ac2e9c-6728-4fb4-8ba0-234617eff305': id,
        }),
      });
      // The same composer's words.
      expect(map[at + 2]!.trim()).toBe(attendingLine(1));
    });

    it('round 25, C196: wherever the map prints `Drive it:` (the stall route too) the line follows it; a map with no `Drive it:` line (a question open, the run ended) has none', async () => {
      const record = {
        id: 'r',
        params: {},
        completed_steps: [],
        in_progress_steps: [],
        failed_steps: [],
        skipped_steps: [],
        evidence: [],
        terminal_state: false,
        run_phase: 'running',
      } as never;
      // decision C202: the map offers `Drive it:` where the run's view has an agent step ready.
      const view = (agentSteps: string[]) => ({
        pending: {
          agent_actions: [],
          agent_steps: agentSteps,
          agent_refused: [],
          pending_guards: [],
          engine_runnable: [],
          cannot_run: [],
        },
        workflow: { steps: {} },
      });
      const stalled = renderDetachMap(record, 'x', view(['x']), {
        headline: 'Workflow stalled',
      }).split('\n');
      const gate = renderDetachMap(
        {
          ...(record as object),
          pending_gate: { gate_id: 'g', step_name: 'x', choices: ['a', 'b'] },
        } as never,
        'x',
        view([]),
      );
      const ended = renderDetachMap(
        {
          ...(record as object),
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          run_phase: 'completed',
        } as never,
        'x',
        view([]),
      );
      // (a) red when the stall route's map lacks the line under `Drive it:`, or a map with no
      //     `Drive it:` line gains it; (b) prints the maps.
      expect({
        stalled: stalled.slice(1, 3),
        others: [gate, ended].map((m) => m.includes('goes on by itself')),
      }).toEqual({
        stalled: [
          '  Drive it:  realm agent --run-id r --provider <provider> --model <model>',
          `             ${attendingLine(1)}`,
        ],
        others: [false, false],
      });
    });

    it('round 25, C198 (walk c10, W3-1): `realm workflow run` cannot join a run it did not start — it has no option that names a run, and each call starts a new run; the page says so beside C190’s sentence', async () => {
      claim(
        WF_PAGE,
        '`realm agent` holds nothing while its model works on a step, so on a run this command started (it cannot join a run it did not start), a prompt opened during that call takes the step with no word of the call:',
      );
      mocks.question.mockImplementation(async () => {
        throw Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        });
      });
      const lines = [
        'id: join-note',
        'name: join-note',
        'version: 1',
        'steps:',
        '  note:',
        '    description: Note.',
        '    execution: agent',
      ];
      await run(lines);
      await run(lines);
      // (a) red when the command gains an option that names a run, or a second call joins the first
      //     call's run; (b) prints the options and the runs.
      expect({
        options: runCommand.options.map((o) => o.long),
        runs: runIds().length,
      }).toEqual({
        options: ['--params', '--extensions-module', '--project', '--mint-writer-nonce'],
        runs: 2,
      });
    });

    describe("round 27 — C202 (walk c12, W2-1): the map gives the ways on that fit the run's state", () => {
      const leave = () =>
        Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
          code: 'ABORT_ERR',
        });
      /** The map's lines from its first line, the run id put as `<id>`. */
      const mapLines = (id: string): string[] => {
        const map = errored()
          .join('\n')
          .split('\n')
          .filter((l) => l !== '');
        const at = map.findIndex((l) => / — detached from run '/.test(l));
        return map.slice(at).map((l) => l.split(id).join('<id>'));
      };

      it("an `auto` step's prompt (W2-1): `Advance:` with the owed call, no `Drive it`; the page's screen; the call, once the workflow is registered, runs the step", async () => {
        claim(
          WF_PAGE,
          "The lines after the first are the ways on that fit the run as its record stands when you leave. `Drive it` is printed only when an agent step is ready. When the engine owes work, as when you leave an `auto` step's prompt, `Advance:` gives the call that runs it with no model, above `Drive it` when both hold (the line under them then ends `the lines above are for when none is.`):",
        );
        claim(
          WF_PAGE,
          '`realm run advance` reads the workflow from the registry, as `realm agent` does: register a workflow file never registered first.',
        );
        mocks.question.mockImplementation(async () => {
          throw leave();
        });
        const lines = [
          'id: leave-fetch',
          'name: leave-fetch',
          'version: 1',
          'steps:',
          '  fetch:',
          '    description: Fetch.',
          '    execution: auto',
        ];
        const code = await run(lines);
        const id = runIds()[0]!;
        const before = realm(home, ['run', 'advance', id]);
        const registered = realm(home, ['workflow', 'register', join(dir, 'workflow.yaml')]);
        const after = realm(home, ['run', 'advance', id]);
        // (a) red when the map offers `Drive it` (a model) for a step only the engine runs, or no
        //     owed call, or differs from the page's screen; or the call does not run the step once
        //     the workflow is registered; (b) prints them.
        expect({
          code,
          map: mapLines(id),
          before: [before.code, before.err.join(' ').startsWith('Workflow not found: leave-fetch')],
          registered: registered.code,
          after: [after.code, after.out.filter((l) => l.startsWith('→ ') || l.startsWith('Run '))],
        }).toEqual({
          code: 1,
          map: put(block(WF_PAGE, '  Advance:   realm run advance'), {
            '5b0c2f4e-8d1a-4e7b-9c63-2a7f1e9d4b80': '<id>',
          }),
          before: [1, true],
          registered: 0,
          after: [0, ['→ fetch', `Run ${id}: phase 'completed'`]],
        });
      });

      it('an agent step’s prompt with an `auto` step beside it: `Advance:` above `Drive it:`, and the line under them says `the lines above are`', async () => {
        mocks.question.mockImplementation(async () => {
          throw leave();
        });
        const code = await run([
          'id: leave-both',
          'name: leave-both',
          'version: 1',
          'steps:',
          '  ask:',
          '    description: Ask.',
          '    execution: agent',
          '  b:',
          '    description: B.',
          '    execution: auto',
        ]);
        const id = runIds()[0]!;
        // (a) red when the owed call or the drive is missing, their order changes, or the line under
        //     them counts one command; (b) prints the map.
        expect({ code, map: mapLines(id) }).toEqual({
          code: 1,
          map: [
            "Prompt cancelled — detached from run '<id>' at step 'ask' (phase: running). The run is saved.",
            "  Advance:   realm run advance <id> — for the step the engine owes ('b'), with no model",
            '  Drive it:  realm agent --run-id <id> --provider <provider> --model <model>',
            `             ${attendingLine(2)}`,
            '  Inspect:   realm run inspect <id>',
            '  Discard:   realm run abandon <id>',
          ],
        });
        expect(attendingLine(2)).toMatch(/the lines above are for when none is\.$/);
      });

      it('an `auto` step whose input its schema refuses, left at its prompt: each step that cannot run and the way out, then `Inspect`', async () => {
        claim(
          WF_PAGE,
          "When neither holds, a run that cannot go on from here (an `auto` step whose input its schema refuses, left at its prompt, for one) gets each step that cannot run and the way out, `'<step>' cannot run (<check>): <why>.` and `Run <id> stays open (phase 'running'): correct the workflow, register it again, then realm run advance <id>; or end it: realm run abandon <id>.`, then `Inspect`.",
        );
        mocks.question.mockImplementation(async () => {
          throw leave();
        });
        const code = await run([
          'id: leave-input',
          'name: leave-input',
          'version: 1',
          'steps:',
          '  c:',
          '    description: Needs n.',
          '    execution: auto',
          '    input_schema:',
          '      type: object',
          '      required: [n]',
          '      properties:',
          '        n: { type: number }',
        ]);
        const id = runIds()[0]!;
        // (a) red when the map offers a drive or an owed call for a step no command can run, or
        //     lacks the way out; (b) prints the map.
        expect({ code, map: mapLines(id) }).toEqual({
          code: 1,
          map: [
            "Prompt cancelled — detached from run '<id>' at step 'c' (phase: running). The run is saved.",
            "  'c' cannot run (input_schema): Invalid input for step 'c': the input must have required property 'n'.",
            "  Run <id> stays open (phase 'running'): correct the workflow, register it again, then realm run advance <id>; or end it: realm run abandon <id>.",
            '  Inspect:   realm run inspect <id>',
          ],
        });
      });

      it('another program took the step while its prompt waited (left before the prompt saw it): the `Go on:` line and `Inspect`, no `Drive it`, no `Discard`', async () => {
        claim(
          WF_PAGE,
          'A step in flight in another program gets the `Go on:` line shown above and `Inspect`.',
        );
        const def = loadWorkflowFromString(
          [
            'id: leave-taken',
            'name: leave-taken',
            'version: 1',
            'steps:',
            '  g:',
            '    description: G.',
            '    execution: auto',
            '',
          ].join('\n'),
        );
        mocks.question.mockImplementation(async () => {
          const store = new JsonFileStore(join(home, '.realm', 'runs'));
          await store.claimStep(runIds()[0]!, 'g', def, {
            by: 'other-b',
            by_source: 'ambient',
            channel: 'advance',
          });
          throw leave();
        });
        const code = await run([
          'id: leave-taken',
          'name: leave-taken',
          'version: 1',
          'steps:',
          '  g:',
          '    description: G.',
          '    execution: auto',
        ]);
        const id = runIds()[0]!;
        // (a) red when the map offers the drive or discard for a run in another program's hands, or
        //     no `Go on:` line; (b) prints the map.
        expect({ code, map: mapLines(id) }).toEqual({
          code: 1,
          map: [
            "Prompt cancelled — detached from run '<id>' at step 'g' (phase: running). The run is saved.",
            "  Go on:     once 'g' is no longer in flight, realm run advance <id>",
            '  Inspect:   realm run inspect <id>',
          ],
        });
      });

      it('the run ended with a failed step while the prompt waited (left before the prompt saw it): `Resume:` above `Inspect`; following it, once registered, makes the step runnable again', async () => {
        claim(
          WF_PAGE,
          'A run that has ended gets `Inspect`, after a `Resume:` line, `realm run resume <id> --from <step>`, when a step failed that `realm run resume` takes.',
        );
        const yaml = [
          'id: leave-failed',
          'name: leave-failed',
          'version: 1',
          'steps:',
          '  g:',
          '    description: G.',
          '    execution: auto',
          '  s:',
          '    description: S.',
          '    execution: auto',
          '    handler: boom',
        ];
        const def = loadWorkflowFromString([...yaml, ''].join('\n'));
        const other = new ExtensionRegistry();
        other.register('handler', 'boom', {
          id: 'boom',
          execute: async () => {
            throw new Error('it broke');
          },
        });
        mocks.question.mockImplementation(async () => {
          // Another program runs what the engine owes: `g`, then `s`, which fails and ends the run.
          const store = new JsonFileStore(join(home, '.realm', 'runs'));
          await advanceRun(store, def, {
            runId: runIds()[0]!,
            caller: 'advance',
            registry: other,
            driver: { by: 'other-b', by_source: 'ambient', channel: 'advance' },
          });
          throw leave();
        });
        const code = await run(yaml);
        const id = runIds()[0]!;
        const registered = realm(home, ['workflow', 'register', join(dir, 'workflow.yaml')]);
        const resumed = realm(home, ['run', 'resume', id, '--from', 's']);
        // (a) red when an ended run with a failed step resume takes gets no `Resume:` line, or the
        //     line's command is refused; (b) prints the map and the resume.
        expect({
          code,
          map: mapLines(id),
          registered: registered.code,
          resumed: [resumed.code, resumed.out[0]],
        }).toEqual({
          code: 1,
          map: [
            "Prompt cancelled — detached from run '<id>' at step 'g' (phase: failed). The run is saved.",
            '  Resume:    realm run resume <id> --from s',
            '  Inspect:   realm run inspect <id>',
          ],
          registered: 0,
          resumed: [0, `Resumed run '${id}': step 's' re-enabled and run reset to 'running'.`],
        });
      });

      it('the stall with nothing ready: `Inspect` and `Discard` alone, no `Drive it`', async () => {
        claim(
          WF_PAGE,
          'A run with nothing ready gets `Inspect` and `Discard` alone, as when the command stalls with nothing ready (`Workflow stalled — detached from run …`; a first step whose `when` is never true, for one).',
        );
        const code = await run([
          'id: stall-nothing',
          'name: stall-nothing',
          'version: 1',
          'steps:',
          '  a:',
          '    description: Never.',
          '    execution: agent',
          '    when:',
          "      - 'run.params.never_true == true'",
        ]);
        const id = runIds()[0]!;
        // (a) red when the stall map offers a command with nothing ready; (b) prints the map.
        expect({ code, map: mapLines(id) }).toEqual({
          code: 1,
          map: [
            "Workflow stalled — detached from run '<id>' at step '(step unknown)' (phase: running). The run is saved.",
            '  Inspect:   realm run inspect <id>',
            '  Discard:   realm run abandon <id>',
          ],
        });
      });
    });
  },
);
