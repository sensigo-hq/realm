// #729 PR-3 correction 5 (J-2): the lines only a race or an interactive prompt reaches — their
// composer is called in this process with the CLI writer installed, a variable (or a declared value)
// holding the phase word, and the cell reads what the writer would show of the line on stdout. Each
// cell's break is the span removed at its line (the red-first log names it).
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  abandonRun,
  createDefaultRegistry,
  executeStep,
  type WebhookTrigger,
  type ExtensionRegistry,
  type PendingView,
  type RunRecord,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { runAgent } from '../agent/run-agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';
import { addDeclaredValues, installWriter, writerCtx, writerTestSeams } from '../output/writer.js';
import { answerNotRecordedLine, outcomeNotRecordedLine } from '../lib/holder-render.js';
import { cannotRunWayOut, stopReasons } from './ways-renderer.js';
import {
  questionClosedLine,
  renderDetachMap,
  renderInFlightHandBack,
  runCommand,
  stepClosedLine,
} from './run.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import { buildRouteTable, makeListenHandler, sweepExpiredGates } from './listen.js';

afterEach(() => {
  writerTestSeams.reset();
  vi.unstubAllEnvs();
});

/** The writer installed, `env` set first (the environment route) and `declared` joined (the
 *  declared route); returns what stdout would show of `compose()`'s line. */
function shown(
  compose: () => string,
  route: { env?: Record<string, string>; declared?: Record<string, string> },
): string {
  for (const [name, value] of Object.entries(route.env ?? {})) vi.stubEnv(name, value);
  installWriter('default');
  if (route.declared !== undefined) addDeclaredValues(route.declared);
  return writerTestSeams.visible(compose());
}

const AT = '2026-09-01T00:00:00.000Z';

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_c5',
    workflow_id: 'wf',
    workflow_version: 1,
    version: 1,
    run_phase: 'running',
    terminal_state: false,
    params: {},
    completed_steps: [],
    failed_steps: [],
    in_progress_steps: [],
    skipped_steps: [],
    evidence: [],
    created_at: AT,
    updated_at: AT,
    ...over,
  } as RunRecord;
}

const COMPLETED: Partial<RunRecord> = {
  run_phase: 'completed',
  terminal_state: true,
  completed_steps: ['a'],
  terminal_reason: 'Workflow completed.',
  sealed_by: { arm: 'complete' },
} as Partial<RunRecord>;

const ABANDONED: Partial<RunRecord> = {
  run_phase: 'abandoned',
  terminal_state: true,
  terminal_reason: 'Held.',
  abandoned_at: AT,
  sealed_by: { arm: 'abandon_requested' },
} as Partial<RunRecord>;

function ways(): { pending: PendingView; workflow: WorkflowDefinition } {
  return {
    pending: {
      owed: [],
      agent_steps: [],
      agent_refused: [],
      pending_guards: [],
      engine_runnable: [],
      cannot_run: [],
    } as unknown as PendingView,
    workflow: { id: 'wf', name: 'wf', version: 1, steps: {} } as unknown as WorkflowDefinition,
  };
}

describe('#729 PR-3 correction 5 (J-2) — the race and prompt lines print the phase whole', () => {
  it('holder-render.ts — `the run ended (…) before this drive’s answer reached it`', () => {
    const line = shown(
      () => answerNotRecordedLine(record(COMPLETED), 'a', true, 'run_ended', writerCtx()) ?? '',
      { env: { STATUS_X: 'completed' } },
    );
    // (a) red when the phase prints as plain text (`([REDACTED])`); (b) prints the line.
    expect(line).toBe(
      "• Step 'a' was not run: the run ended (completed) before this drive's answer reached it; the answer was not recorded.",
    );
  });

  it('holder-render.ts — `the run ended (…) before this program’s outcome for it was recorded`', () => {
    const line = shown(
      () => outcomeNotRecordedLine('run_ended', record(COMPLETED), 'a', true, writerCtx()),
      { env: { STATUS_X: 'completed' } },
    );
    // (a) red when the phase prints as plain text; (b) prints the line.
    expect(line).toBe(
      "• Step 'a': the run ended (completed) before this program's outcome for it was recorded.",
    );
  });

  it("ways-renderer.ts — `stays open (phase '…')` (the declared route: `running`)", () => {
    const line = shown(
      () => cannotRunWayOut({ ways: [], unavailable: [] }, 'run_c5', 'running', writerCtx()),
      { declared: { C5_PIN: 'running' } },
    );
    // (a) red when the phase prints as plain text; (b) prints the line's head.
    expect(line.slice(0, line.indexOf(': ') + 1)).toBe("Run run_c5 stays open (phase 'running'):");
  });

  it('ways-renderer.ts — `the run has ended (…)`', () => {
    const line = shown(
      () =>
        stopReasons(
          { ways: [], unavailable: [{ code: 'run_ended' }] } as never,
          'run_c5',
          'abandoned',
          writerCtx(),
        )[0] ?? '',
      { env: { STATUS_X: 'abandoned' } },
    );
    // (a) red when the phase prints as plain text; (b) prints the reason.
    expect(line).toBe('the run has ended (abandoned)');
  });

  it("run.ts — the detach map's `(phase: …)`", () => {
    const line = shown(
      () =>
        renderDetachMap(
          record({
            run_phase: 'gate_waiting',
            pending_gate: {
              gate_id: 'g-1',
              step_name: 'a',
              choices: ['yes', 'no'],
              preview: {},
              opened_at: AT,
            },
          } as Partial<RunRecord>),
          'a',
          ways(),
        ).split('\n')[0]!,
      { env: { STATUS_X: 'gate_waiting' } },
    );
    // (a) red when the phase prints as plain text; (b) prints the first line.
    expect(line).toBe(
      "Prompt cancelled — detached from run 'run_c5' at step 'a' (phase: gate_waiting). The run is saved.",
    );
  });

  it("run.ts — the in-flight hand-back's `(phase: …)` (the declared route: `running`)", () => {
    const line = shown(() => renderInFlightHandBack(record(), ['a']).split('\n')[0]!, {
      declared: { C5_PIN: 'running' },
    });
    // (a) red when the phase prints as plain text; (b) prints the first line.
    expect(line).toBe(
      "Stopped waiting — detached from run 'run_c5' at step 'a' (phase: running). The run is saved.",
    );
  });

  it("run.ts — a closed question's `the run is '…'`", () => {
    const line = shown(() => questionClosedLine(record(ABANDONED), 'a', writerCtx()), {
      env: { STATUS_X: 'abandoned' },
    });
    // (a) red when the phase prints as plain text; (b) prints the line.
    expect(line).toBe(
      "This prompt is closed: the question on 'a' is no longer open — no answer was recorded; the run is 'abandoned'.",
    );
  });

  it("run.ts — a closed step's `the run is '…'`", () => {
    // A step the run never ran (`b`): a step it ran says who ran it instead.
    const line = shown(() => stepClosedLine(record(COMPLETED), 'b', true, undefined, writerCtx()), {
      env: { STATUS_X: 'completed' },
    });
    // (a) red when the phase prints as plain text; (b) prints the line.
    expect(line).toBe(
      "This prompt is closed: step 'b' no longer waits for an answer — the run is 'completed'.",
    );
  });

  it("#729 PR-3 correction 6 (C6-7): holder-render.ts — the step's status in `…, and completed; not run here.`", () => {
    // Step `a` the run completed, with no claim left: the line says who ran it and how it ended.
    const line = shown(() => stepClosedLine(record(COMPLETED), 'a', true, undefined, writerCtx()), {
      env: { STATUS_X: 'completed' },
    });
    // (a) red when the status prints as plain text (`, and [REDACTED]; not run here.`); (b)
    //     prints the line's end.
    expect(line.slice(line.indexOf(', and '))).toBe(', and completed; not run here.');
  });
});

/** A workflow of `steps`. */
function wf(id: string, steps: Record<string, Partial<StepDefinition>>): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  } as WorkflowDefinition;
}

/** `realm agent`'s drive in this process (a model that answers `{}`), the writer installed and the
 *  route set first; every console line as stdout would show it. */
async function drive(
  def: WorkflowDefinition,
  route: { env?: Record<string, string>; declared?: Record<string, string> },
  registry: ExtensionRegistry = createDefaultRegistry(),
): Promise<string[]> {
  for (const [name, value] of Object.entries(route.env ?? {})) vi.stubEnv(name, value);
  installWriter('default');
  if (route.declared !== undefined) addDeclaredValues(route.declared);
  const store = new InMemoryStore();
  const provider = new (class extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      return {};
    }
  })();
  const lines: string[] = [];
  for (const kind of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
      lines.push(a.join(' '));
    });
  }
  try {
    await runAgent(
      {
        store,
        workflowStore: {
          async register() {},
          async get() {
            return def;
          },
          async list() {
            return [def];
          },
        },
        provider,
        registry,
      },
      { definition: def, params: {}, inFlightPollMs: 5, inFlightWatchMs: 20 },
    );
  } finally {
    vi.restoreAllMocks();
  }
  return lines.flatMap((l) => writerTestSeams.visible(l).split('\n'));
}

describe("#729 PR-3 correction 5 (J-2) — `realm agent`'s drive prints the phase whole", () => {
  it('run-agent.ts — `✓ → …` after an agent step (the agent path)', async () => {
    const lines = await drive(
      wf('c5-agent', { ask: { description: 'Ask.', execution: 'agent', depends_on: [] } }),
      { env: { STATUS_X: 'completed' } },
    );
    // (a) red when the phase prints as plain text (`✓ → [REDACTED]`); (b) prints the ✓ lines.
    expect(lines.filter((l) => l.includes('✓ →'))).toEqual(['  ✓ → completed']);
  });

  it('run-agent.ts — `✓ → …` after an engine step the loop top ran', async () => {
    const registry = createDefaultRegistry();
    registry.register('handler', 'c5_h', { id: 'c5_h', execute: async () => ({ data: {} }) });
    const lines = await drive(
      wf('c5-auto', {
        h: { description: 'H.', execution: 'auto', depends_on: [], handler: 'c5_h' },
      }),
      { env: { STATUS_X: 'completed' } },
      registry,
    );
    // (a) red when the phase prints as plain text; (b) prints the ✓ lines.
    expect(lines.filter((l) => l.includes('✓ →'))).toEqual(['  ✓ → completed']);
  });

  /** An agent step whose chain reaches a step this runner lacks the handler for. */
  const CHAINED = wf('c5-chain-cap', {
    ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
    compute: {
      description: 'Compute.',
      execution: 'auto',
      depends_on: ['ask'],
      handler: 'missing_h',
    },
  });

  it('run-agent.ts — `✓ → …` when the chain stops at another step (the declared route: `running`)', async () => {
    const lines = await drive(CHAINED, { declared: { C5_PIN: 'running' } });
    // (a) red when the phase prints as plain text; (b) prints the ✓ lines.
    expect(lines.filter((l) => l.includes('✓ →'))).toEqual(['  ✓ → running']);
  });

  it('run-agent.ts — the verb in `The run is NOT failed` (the declared route: `failed`)', async () => {
    const lines = await drive(CHAINED, { declared: { C5_PIN: 'failed' } });
    const line = lines.find((l) => l.includes('is blocked:')) ?? '';
    // (a) red when the verb prints as plain text (`The run is NOT [REDACTED]`); (b) prints the
    //     sentence up to its way out.
    expect(line.slice(line.indexOf('The run is'), line.indexOf(' — add'))).toBe(
      'The run is NOT failed',
    );
  });

  it("run-agent.ts — `stays open (phase '…')` when the drive stops (the declared route: `running`)", async () => {
    const lines = await drive(
      wf('c5-stops', {
        first: {
          description: 'First.',
          execution: 'agent',
          depends_on: [],
          when: 'run.params.go == true',
        },
      }),
      { declared: { C5_PIN: 'running' } },
    );
    const line = lines.find((l) => l.includes('The drive stops')) ?? '';
    // (a) red when the phase prints as plain text; (b) prints the line's end.
    expect(line.slice(line.indexOf('stays open'))).toBe("stays open (phase 'running'):");
  });

  it('#729 PR-3 correction 6 (C6-2): run-agent.ts — `✓ → running` between two engine steps (the declared route: `running`)', async () => {
    const registry = createDefaultRegistry();
    registry.register('handler', 'c6_h', { id: 'c6_h', execute: async () => ({ data: {} }) });
    const lines = await drive(
      wf('c6-two-auto', {
        h1: { description: 'H1.', execution: 'auto', depends_on: [], handler: 'c6_h' },
        h2: { description: 'H2.', execution: 'auto', depends_on: ['h1'], handler: 'c6_h' },
      }),
      { declared: { C5_PIN: 'running' } },
      registry,
    );
    // (a) red when the word between the two steps prints as plain text (`✓ → [REDACTED]`), or the
    //     declared value hides nothing (the route is not live: the control line shows `running`);
    //     (b) prints the ✓ lines and the control line.
    expect({
      checks: lines.filter((l) => l.includes('✓ →')),
      control: writerTestSeams.visible('reason: the word running is here'),
    }).toEqual({
      checks: ['  ✓ → running', '  ✓ → completed'],
      control: 'reason: the word [REDACTED] is here',
    });
  });
});

describe('#729 PR-3 correction 5 (J-2) — `realm workflow run` prints the phase whole', () => {
  /** `confirm` (a question; `expiry` its declared on_expiry with a one-second timeout), then the
   *  guard `check` (aborts unless approved), then — `finish` — an agent step `finish`. */
  function gateYaml(
    id: string,
    opts: { expiry?: 'settle_default' | 'abort'; finish?: boolean } = {},
  ): string {
    return [
      `id: ${id}`,
      `name: ${id}`,
      'version: 1',
      'steps:',
      '  confirm:',
      '    description: Confirm',
      '    execution: auto',
      '    trust: human_confirmed',
      '    depends_on: []',
      '    gate:',
      '      choices: [approve, reject]',
      ...(opts.expiry === 'settle_default'
        ? [
            '      timeout_seconds: 1',
            '      on_expiry: settle_default',
            '      default_choice: approve',
          ]
        : opts.expiry === 'abort'
          ? ['      timeout_seconds: 1', '      on_expiry: abort']
          : []),
      '  check:',
      '    description: Check',
      '    execution: guard',
      '    depends_on: [confirm]',
      `    abort_unless: ["confirm.choice == 'approve'"]`,
      '    abort_message: "Not approved."',
      ...(opts.finish === true
        ? [
            '  finish:',
            '    description: Finish',
            '    execution: agent',
            '    depends_on: [check]',
          ]
        : []),
      '',
    ].join('\n');
  }

  const agentYaml = (id: string, steps: string[]): string =>
    [`id: ${id}`, `name: ${id}`, 'version: 1', 'steps:', ...steps, ''].join('\n');

  /**
   * `realm workflow run <file>` in this process (a TTY prompt answered by `answer`), the writer
   * installed with the route set first; with `declared`, the workflow's folder holds a realm.yaml
   * declaring it (the declared route). Returns every stdout and stderr line as the writer shows it,
   * the exit code, and each run's identity entries.
   */
  async function workflowRun(
    yaml: string,
    answer: (prompt: string) => Promise<string>,
    route: { env?: Record<string, string>; declared?: string },
  ): Promise<{ code: number; out: string[]; err: string[]; entries: string[][] }> {
    clearProjectExtensionsCache();
    const scratch = mkdtempSync(join(tmpdir(), 'realm-c5-run-'));
    const home = join(scratch, 'home');
    mkdirSync(join(home, '.realm'), { recursive: true });
    // The workflow's folder is its project root (no package.json above it): its realm.yaml is the
    // one the run loads.
    const project = scratch;
    if (route.declared !== undefined) {
      writeFileSync(
        join(project, 'realm.yaml'),
        'version: 1\nadapters:\n  svc:\n    use: github\n    config: { token: "${secret:C5_PIN}" }\n',
      );
      writeFileSync(join(project, '.env'), `C5_PIN=${route.declared}\n`);
    }
    writeFileSync(join(scratch, 'workflow.yaml'), yaml);
    vi.stubEnv('HOME', home);
    for (const [name, value] of Object.entries(route.env ?? {})) vi.stubEnv(name, value);
    const savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    mocks.question.mockImplementation(answer);
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
    installWriter('default');
    let code = 0;
    let entries: string[][];
    try {
      await runCommand.parseAsync([join(scratch, 'workflow.yaml')], { from: 'user' });
    } catch (e) {
      if (!(e instanceof Error) || e.message !== 'process.exit') throw e;
      code = Number(exit.mock.calls[0]?.[0]);
    } finally {
      // J-5: each run's identity entries, `<origin>:<manifest file name or none>`, read before
      // the scratch folder goes.
      const runsDir = join(home, '.realm', 'runs');
      entries = existsSync(runsDir)
        ? readdirSync(runsDir)
            .filter((f) => f.endsWith('.json'))
            .map((f) =>
              (
                (JSON.parse(readFileSync(join(runsDir, f), 'utf8')) as RunRecord)
                  .extension_identity ?? []
              ).map(
                (e) => `${e.origin ?? 'execution'}:${e.manifest?.path.split('/').at(-1) ?? 'none'}`,
              ),
            )
        : [];
      vi.restoreAllMocks();
      mocks.question.mockReset();
      if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else process.stdin.isTTY = savedTTY;
      rmSync(scratch, { recursive: true, force: true });
    }
    const shownLines = (lines: string[]): string[] =>
      lines.flatMap((l) => writerTestSeams.visible(l).split('\n'));
    return { code, out: shownLines(out), err: shownLines(err), entries };
  }

  /** Answers the gate's prompt with `choice` — first waiting past its deadline when `late` — and
   *  every output prompt with nothing. */
  const answering =
    (choice: string, late = false) =>
    async (prompt: string): Promise<string> => {
      if (prompt.startsWith('  Choice ')) {
        if (late) {
          const until = Date.now() + 1100;
          while (Date.now() <= until) {
            // A busy wait: this process's own expiry timer must not fire first.
          }
        }
        return choice;
      }
      if (prompt.startsWith('  Mock output') || prompt.startsWith('  Agent output')) return '';
      throw new Error(`fixture: an unexpected prompt: ${prompt}`);
    };

  it('run.ts — `✓ → …` after a gate answer', async () => {
    const r = await workflowRun(gateYaml('c5-run-gate'), answering('approve'), {
      env: { STATUS_X: 'completed' },
    });
    // (a) red when the phase prints as plain text; (b) prints the ✓ lines.
    expect(r.out.filter((l) => l.includes('✓ →'))).toEqual(['  ✓ → completed']);
  }, 30_000);

  it('run.ts — `Run complete. Phase: …` (a completed run)', async () => {
    const r = await workflowRun(gateYaml('c5-run-complete'), answering('approve'), {
      env: { STATUS_X: 'completed' },
    });
    // (a) red when the phase prints as plain text; (b) prints the exit code and the line.
    expect([r.code, r.out.find((l) => l.startsWith('Run complete.'))]).toEqual([
      0,
      'Run complete. Phase: completed',
    ]);
  }, 30_000);

  it('run.ts — `Run complete. Phase: …` (a run that did not complete; the declared route: `aborted`)', async () => {
    const r = await workflowRun(gateYaml('c5-run-aborted'), answering('reject'), {
      declared: 'aborted',
    });
    // (a) red when the phase prints as plain text; (b) prints the exit code and the line.
    expect([r.code, r.out.find((l) => l.startsWith('Run complete.'))]).toEqual([
      1,
      'Run complete. Phase: aborted',
    ]);
  }, 30_000);

  it('run.ts — a late answer, the same choice: `✗ not recorded — … → …` on stdout', async () => {
    const r = await workflowRun(
      gateYaml('c5-run-late-same', { expiry: 'settle_default' }),
      answering('approve', true),
      { env: { STATUS_X: 'completed' } },
    );
    // (a) red when the phase prints as plain text; (b) prints the not-recorded lines.
    expect(r.out.filter((l) => l.includes('✗ not recorded'))).toEqual([
      "  ✗ not recorded — gate settled by timeout with choice 'approve' → completed",
    ]);
  }, 30_000);

  it('run.ts — a late answer, another choice: `✗ not recorded — … → …` on stderr', async () => {
    const r = await workflowRun(
      gateYaml('c5-run-late-diff', { expiry: 'settle_default' }),
      answering('reject', true),
      { env: { STATUS_X: 'completed' } },
    );
    // (a) red when the phase prints as plain text; (b) prints the not-recorded lines.
    expect(r.err.filter((l) => l.includes('✗ not recorded'))).toEqual([
      "  ✗ not recorded — gate settled by timeout with choice 'approve' → completed",
    ]);
  }, 30_000);

  it('run.ts — a late answer the expiry aborted: `✗ not recorded → …` (the declared route: `aborted`)', async () => {
    const r = await workflowRun(
      gateYaml('c5-run-late-abort', { expiry: 'abort' }),
      answering('approve', true),
      { declared: 'aborted' },
    );
    // (a) red when the phase prints as plain text; (b) prints the not-recorded lines.
    expect(r.err.filter((l) => l.includes('✗ not recorded'))).toEqual([
      '  ✗ not recorded → aborted',
    ]);
  }, 30_000);

  it('run.ts — `No eligible steps in phase …` (the declared route: `running`)', async () => {
    const r = await workflowRun(
      agentYaml('c5-run-stall', [
        '  first:',
        '    description: First',
        '    execution: agent',
        '    depends_on: []',
        "    when: 'run.params.go == true'",
      ]),
      answering('approve'),
      { declared: 'running' },
    );
    // (a) red when the phase prints as plain text; (b) prints the line.
    expect(r.err.find((l) => l.startsWith('No eligible steps'))).toBe(
      "No eligible steps in phase 'running'. Workflow stalled.",
    );
  }, 30_000);

  it('run.ts — `✓ → … | hash: …` after a step this prompt answered', async () => {
    const r = await workflowRun(
      agentYaml('c5-run-agent', [
        '  ask:',
        '    description: Ask',
        '    execution: agent',
        '    depends_on: []',
      ]),
      answering('approve'),
      { env: { STATUS_X: 'completed' } },
    );
    const line = r.out.find((l) => l.includes('✓ →')) ?? '';
    // (a) red when the phase prints as plain text; (b) prints the line up to its hash.
    expect(line.slice(0, line.indexOf(' | hash'))).toBe('  ✓ → completed');
  }, 30_000);

  it('run.ts — `✓ → … | hash: …` when the chain stops at another step (the declared route: `running`)', async () => {
    const r = await workflowRun(
      agentYaml('c5-run-chain', [
        '  ask:',
        '    description: Ask',
        '    execution: agent',
        '    depends_on: []',
        '  compute:',
        '    description: Compute',
        '    execution: auto',
        '    depends_on: [ask]',
        '    handler: missing_h',
      ]),
      answering('approve'),
      { declared: 'running' },
    );
    const line = r.out.find((l) => l.includes('✓ →')) ?? '';
    // (a) red when the phase prints as plain text; (b) prints the line up to its hash.
    expect(line.slice(0, line.indexOf(' | hash'))).toBe('  ✓ → running');
  }, 30_000);
  it("J-5: `realm workflow run` — the run is born with the project's start entry (a project with a manifest)", async () => {
    const r = await workflowRun(
      agentYaml('c5-run-start', [
        '  first:',
        '    description: First',
        '    execution: agent',
        '    depends_on: []',
        "    when: 'run.params.go == true'",
      ]),
      answering('approve'),
      { declared: 'FAKE-C5-J5-RUN-0001' },
    );
    // (a) red when `startIdentityEntry` gives nothing (no entry); (b) prints each run's entries.
    expect(r.entries).toEqual([['start:realm.yaml']]);
  }, 30_000);
});

describe("#729 PR-3 correction 5 (J-2) — `realm listen`'s log lines carry the phase whole, as JSON", () => {
  /** The line `realm listen`'s logger prints (`<msg> <JSON>`), as the broadcast writer shows it,
   *  and its JSON read back. */
  const logged: string[] = [];
  const logger = {
    debug() {},
    info: (m: string, d?: unknown) => void logged.push(`${m} ${JSON.stringify(d)}`),
    warn: (m: string, d?: unknown) => void logged.push(`${m} ${JSON.stringify(d)}`),
    error() {},
  };
  const fieldsOf = (msg: string): Record<string, unknown> | undefined => {
    const line = logged.map((l) => writerTestSeams.visible(l)).find((l) => l.startsWith(`${msg} `));
    return line === undefined
      ? undefined
      : (JSON.parse(line.slice(msg.length + 1)) as Record<string, unknown>);
  };
  afterEach(() => {
    logged.length = 0;
  });

  const TRIGGER: WebhookTrigger = {
    type: 'webhook',
    path: '/wf',
    auth: { mode: 'shared_secret', header: 'Authorization', secret_from: 'C5_HOOK_TOKEN' },
    dedup: { id_from: 'body.id' },
  };
  const def = {
    id: 'c5-listen',
    name: 'c5-listen',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: { handle: { execution: 'agent', description: 'handle' } },
    trigger: TRIGGER,
  } as unknown as WorkflowDefinition;

  /** One webhook delivery of `evt-c5` to `handler`. */
  async function deliver(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
    const req = new EventEmitter() as unknown as IncomingMessage;
    req.method = 'POST';
    req.url = '/wf';
    req.headers = { 'content-type': 'application/json', authorization: 'fake-c5-hook-token' };
    (req as unknown as { destroy: () => void }).destroy = () => req.emit('close');
    (req as unknown as { resume: () => IncomingMessage }).resume = () => req;
    setImmediate(() => {
      req.emit('data', Buffer.from(JSON.stringify({ id: 'evt-c5' })));
      req.emit('end');
    });
    let body = '';
    const res = {
      headersSent: false,
      statusCode: 0,
      writeHead(status: number) {
        this.statusCode = status;
        this.headersSent = true;
        return this;
      },
      end(chunk?: string) {
        if (chunk !== undefined) body = chunk;
      },
    };
    await handler(req, res as unknown as ServerResponse);
    return JSON.parse(body === '' ? '{}' : body) as Record<string, unknown>;
  }

  /** A handler whose dedup store never matches, so a redelivery reaches the run store. */
  function handlerWith(spawnAgent: () => Promise<{ pid: number }>, runStore: InMemoryStore) {
    const routes = buildRouteTable([{ definition: def, workflowDir: '/tmp/wf' }], {
      env: { C5_HOOK_TOKEN: 'fake-c5-hook-token' },
      logger,
    });
    return makeListenHandler(routes, {
      workflowStore: { register: async () => {} },
      runStore,
      dedupStoreFor: () => ({ check: () => false, record: () => {}, cleanup: () => {} }),
      spawnAgent,
      clock: () => 1_700_000_000_000,
      logger,
    } as never);
  }

  it('listen.ts — `webhook: deduplicated` (a run the store matched) — `run_phase` whole, the line JSON', async () => {
    vi.stubEnv('STATUS_X', 'abandoned');
    installWriter('broadcast');
    const runStore = new InMemoryStore();
    const handler = handlerWith(async () => ({ pid: 4242 }), runStore);
    const first = await deliver(handler);
    await abandonRun(runStore, first['run_id'] as string, 'Held.');
    await deliver(handler);
    // (a) red when the phase prints as plain text (`[REDACTED]`), or the line is no longer JSON;
    //     (b) prints the field.
    expect(fieldsOf('webhook: deduplicated')?.['run_phase']).toBe('abandoned');
  });

  it('listen.ts — `webhook: deduplicated` (a run its failed start sealed; the declared route: `failed`)', async () => {
    installWriter('broadcast');
    addDeclaredValues({ C5_PIN: 'failed' });
    const runStore = new InMemoryStore();
    const handler = handlerWith(async () => {
      throw new Error('fake spawn failure');
    }, runStore);
    await deliver(handler);
    await deliver(handler);
    // (a) red when the phase prints as plain text, or the line is no longer JSON; (b) prints the
    //     field.
    expect(fieldsOf('webhook: deduplicated')?.['run_phase']).toBe('failed');
  });

  it("listen.ts — the sweeper's `cannot_go_on`: `stays open (phase '…')` whole (the declared route: `running`)", async () => {
    installWriter('broadcast');
    addDeclaredValues({ C5_PIN: 'running' });
    const scratch = mkdtempSync(join(tmpdir(), 'realm-c5-sweep-'));
    try {
      const runs = new JsonFileStore(join(scratch, 'runs'));
      const workflows = new JsonWorkflowStore(join(scratch, 'workflows'));
      const stuck = {
        id: 'c5-sweep',
        name: 'c5-sweep',
        version: 1,
        schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
        steps: {
          decide: {
            description: 'Decide.',
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
          compute: {
            description: 'Compute.',
            execution: 'auto',
            depends_on: ['decide'],
            input_schema: {
              type: 'object',
              required: ['n'],
              properties: { n: { type: 'number' } },
            },
          },
        },
      } as unknown as WorkflowDefinition;
      await workflows.register(stuck);
      const { run } = await runs.create({ workflowId: stuck.id, workflowVersion: 1, params: {} });
      await executeStep(runs, stuck, {
        runId: run.id,
        command: 'decide',
        input: {},
        dispatcher: async () => ({}),
      });
      await sweepExpiredGates(
        { runStore: runs, workflowStore: workflows, logger } as never,
        new Date(Date.now() + 3_600_000),
      );
      const lines = fieldsOf('listen: sweeper enacted an expired gate')?.['cannot_go_on'] as
        string[] | undefined;
      const way = lines?.at(-1) ?? '';
      // (a) red when the phase prints as plain text, or the line is no longer JSON; (b) prints the
      //     way out's head.
      expect(way.slice(0, way.indexOf(': '))).toBe(`Run ${run.id} stays open (phase 'running')`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
