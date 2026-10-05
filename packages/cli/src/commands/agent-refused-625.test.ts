// agent-refused-625.test.ts — issue #625 PR-2a, decision C82 on the CLI commands: an agent step the
// run refuses before its claim (a failed precondition, or a `trust` value the engine refuses) is
// named by `realm run inspect` (`Cannot run`) and `realm run advance` (a Stopped reason, exit 1), and
// `realm workflow run` (dev mode) never prompts for it — before C82 the prompt re-asked for the step
// forever. Head and chained, each with a control.
//
// `realm workflow run` in-process through the real command, `node:readline/promises` mocked (the
// #447 harness, as `run-cannot-go-on-625.test.ts`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand } from './run.js';
import { inspectRun } from './inspect.js';
import { advanceRunFromShell } from './run-advance.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const agent = (extra: Partial<StepDefinition> = {}, depends_on: string[] = []): StepDefinition =>
  ({ description: 'Ask.', execution: 'agent', depends_on, ...extra }) as StepDefinition;
const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});
const PRE: Partial<StepDefinition> = { preconditions: ['run.params.ok == true'] };
const PRE_REFUSAL =
  "Precondition failed for step 'ask'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.";
const wayOut = (id: string): string =>
  `Run ${id} stays open (phase 'running'): correct the workflow, register it again, then realm run advance ${id}; or end it: realm run abandon ${id}.`;

function stores(): { home: string; runs: JsonFileStore; workflows: JsonWorkflowStore } {
  const home = mkdtempSync(join(tmpdir(), 'realm-c82-cmd-'));
  return {
    home,
    runs: new JsonFileStore(join(home, '.realm', 'runs')),
    workflows: new JsonWorkflowStore(join(home, '.realm', 'workflows')),
  };
}

describe('#625 PR-2a, C82 — realm run inspect and realm run advance name a refused agent step', () => {
  it('inspect: `Cannot run` for the agent step, then the way out; CONTROL: a ready agent step beside it — named, no way out', async () => {
    const { home, runs, workflows } = stores();
    try {
      const stuck = wf('c82-inspect', { ask: agent(PRE) });
      const ready = wf('c82-inspect-ctl', { ask: agent(PRE), ok: agent() });
      await workflows.register(stuck);
      await workflows.register(ready);
      const { run } = await runs.create({ workflowId: stuck.id, workflowVersion: 1, params: {} });
      const lines = (await inspectRun(run.id, runs, workflows)).split('\n');
      const at = lines.indexOf(`Cannot run 'ask' (precondition): ${PRE_REFUSAL}`);
      // (a) red when inspect reads the engine steps alone; (b) prints the index and the next line.
      expect({ found: at > -1, next: lines[at + 1] }).toEqual({
        found: true,
        next: wayOut(run.id),
      });
      const { run: c } = await runs.create({
        workflowId: ready.id,
        workflowVersion: 1,
        params: {},
      });
      const ctl = (await inspectRun(c.id, runs, workflows)).split('\n');
      expect(ctl).toContain(`Cannot run 'ask' (precondition): ${PRE_REFUSAL}`);
      expect(ctl.filter((l) => l.includes('stays open'))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('advance: the refused agent step is a Stopped reason, then the way out; exit 1. CONTROL: a passing agent step — drive it, exit 0', async () => {
    const { home, runs, workflows } = stores();
    try {
      const stuck = wf('c82-advance', { ask: agent(PRE) });
      const ready = wf('c82-advance-ctl', { ask: agent() });
      await workflows.register(stuck);
      await workflows.register(ready);
      for (const [d, expected] of [
        [
          stuck,
          (id: string) => ({
            code: 1,
            lines: [
              `Nothing is owed to the engine: 'ask' cannot run (precondition): ${PRE_REFUSAL}`,
              wayOut(id),
            ],
          }),
        ],
        [
          ready,
          (id: string) => ({
            code: 0,
            lines: [
              `Nothing is owed to the engine: an agent step is ready: 'ask' — drive it with realm agent --run-id ${id}.`,
            ],
          }),
        ],
      ] as const) {
        const { run } = await runs.create({ workflowId: d.id, workflowVersion: 1, params: {} });
        const lines: string[] = [];
        const code = await advanceRunFromShell(
          run.id,
          { project: home },
          runs,
          workflows,
          undefined,
          (l) => lines.push(l),
          new ExtensionRegistry(),
        );
        // (a) red when advance's reasons or exit code read engine steps only; (b) prints both.
        expect({ code, lines: lines.slice(3) }).toEqual(expected(run.id));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

const yaml = (id: string, steps: string[]): string =>
  [`id: ${id}`, `name: ${id}`, 'version: 1', 'steps:', ...steps, ''].join('\n');
const ASK = (deps: string, pre: string): string[] => [
  '  ask:',
  '    description: Ask.',
  '    execution: agent',
  `    depends_on: [${deps}]`,
  `    preconditions: ["${pre}"]`,
];
const FIRST = ['  first:', '    description: First.', '    execution: agent', '    depends_on: []'];

describe('#625 PR-2a, C82 — realm workflow run never prompts for a refused agent step', () => {
  let home: string;
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-c82-run-home-'));
    dir = mkdtempSync(join(tmpdir(), 'realm-c82-run-wf-'));
    mkdirSync(join(home, '.realm'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    vi.spyOn(console, 'log').mockImplementation(() => {});
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

  const errored = (): string[] => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  const asked = (): string[] => mocks.question.mock.calls.map((c: unknown[]) => String(c[0]));
  const runId = (): string =>
    readdirSync(join(home, '.realm', 'runs'))
      .filter((f) => f.endsWith('.json'))[0]!
      .replace('.json', '');

  async function run(text: string): Promise<number> {
    writeFileSync(join(dir, 'workflow.yaml'), text, 'utf8');
    try {
      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });
      return 0;
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
      return Number(exitSpy.mock.calls[0]?.[0]);
    }
  }

  it('head: no prompt for the step; the stall names it and the way out, exit 1', async () => {
    mocks.question.mockResolvedValue('');
    const code = await run(yaml('c82-run-head', ASK('', 'run.params.ok == true')));
    // (a) red when dev-run's prompt set reads engine steps only (it would prompt for `ask` forever);
    // (b) prints the code, the prompts and the screen.
    expect({ code, asked: asked(), errored: errored() }).toEqual({
      code: 1,
      asked: [],
      errored: [
        '\nWorkflow stalled: nothing else can run.',
        `'ask' cannot run (precondition): ${PRE_REFUSAL}`,
        wayOut(runId()),
      ],
    });
  });

  it('chained: the step before is prompted once, the refused agent step after it never', async () => {
    mocks.question.mockResolvedValue('{"ok": false}');
    const code = await run(
      yaml('c82-run-chained', [...FIRST, ...ASK('first', 'first.ok == true')]),
    );
    expect({ code, asked: asked(), errored: errored() }).toEqual({
      code: 1,
      asked: ['  Agent output JSON (Enter for {}): '],
      errored: [
        '\nWorkflow stalled: nothing else can run.',
        "'ask' cannot run (precondition): Precondition failed for step 'ask'. Precondition failed: 'first.ok == true'. Resolved value: false.",
        wayOut(runId()),
      ],
    });
  });

  it('CONTROL — chained, the precondition passes: both steps prompted, the run completes', async () => {
    mocks.question.mockResolvedValue('{"ok": true}');
    const code = await run(yaml('c82-run-ok', [...FIRST, ...ASK('first', 'first.ok == true')]));
    expect({ code, prompts: asked().length }).toEqual({ code: 0, prompts: 2 });
  });
});
