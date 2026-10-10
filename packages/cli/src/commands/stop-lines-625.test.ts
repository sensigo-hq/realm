// stop-lines-625.test.ts — issue #625 PR-2a, the last prompt's F16 (review G1-R1, G1-R3): two stop lines
// say what is true. `realm workflow run` never says `No eligible steps … Workflow stalled.` when the
// engine owes work it does not run (a guard: the command runs only the steps it prompts) — it says the
// engine owes it, and its map names the call that runs it. `realm agent` never says `Run ended in
// phase: running` of a run that has not ended — it says nothing is ready, in `realm run advance`'s
// words, with inspect and abandon.
//
// In-process: `realm workflow run` through the real command with `node:readline/promises` mocked (the
// #447 harness); `realm agent` through `runAgent`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { InMemoryStore } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runCommand } from './run.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import { runAgent } from '../agent/run-agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  const text = readFileSync(join(ROOT, page), 'utf8').replace(/\s+/g, ' ');
  expect(text, `${page} no longer says: ${sentence}`).toContain(sentence.replace(/\s+/g, ' '));
}

describe('#625 PR-2a, F16 — realm workflow run: engine work owed is not a stall (G1-R1)', () => {
  let home: string;
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-f16-home-'));
    dir = mkdtempSync(join(tmpdir(), 'realm-f16-wf-'));
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

  async function run(yaml: string[]): Promise<{ code: number; err: string[]; id: string }> {
    writeFileSync(join(dir, 'workflow.yaml'), yaml.join('\n') + '\n', 'utf8');
    let code = 0;
    try {
      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
      code = Number(exitSpy.mock.calls[0]?.[0]);
    }
    const id = readdirSync(join(home, '.realm', 'runs'))
      .filter((f) => f.endsWith('.json'))[0]!
      .replace('.json', '');
    const err = errSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .join('\n')
      .split(id)
      .join('<id>')
      .split('\n');
    return { code, err, id };
  }

  it('a guard the engine owes first: `The engine owes …, which this command does not run.` and the map’s `Engine work owed` with the Advance line — never `Workflow stalled`', async () => {
    claim(
      'docs/reference/cli/realm-workflow.md',
      "When the engine owes work this command does not run — a guard, for one: the command runs only the steps it prompts — it is not stalled: it says `The engine owes '<step>', which this command does not run.`, and the map starts `Engine work owed — detached from run …` and gives the `Advance:` line (added after version 0.46.0).",
    );
    mocks.question.mockImplementation(async () => '');
    const r = await run([
      'id: f16-guard-first',
      'name: f16-guard-first',
      'version: 1',
      'steps:',
      '  g:',
      '    description: Decide first.',
      '    execution: guard',
      '    abort_unless: ["run.params.ok == true"]',
      '  s:',
      '    description: After the guard.',
      '    execution: agent',
      '    depends_on: [g]',
    ]);
    // (a) red when the command says the run is stalled while the engine owes the guard (G1-R1);
    //     (b) prints stderr and the exit code.
    expect({ code: r.code, err: r.err.filter((l) => l !== '').slice(0, 3) }).toEqual({
      code: 1,
      err: [
        "The engine owes 'g', which this command does not run.",
        "Engine work owed — detached from run '<id>' at step '(step unknown)' (phase: running). The run is saved.",
        "  Advance:   realm run advance <id> — for what the engine owes ('g'), with no model",
      ],
    });
    expect(r.err.filter((l) => l.includes('stalled'))).toEqual([]);
  });
});

describe('#625 PR-2a, F16 — realm agent: a run that has not ended is never said to have ended (G1-R3)', () => {
  const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  });

  async function drive(def: WorkflowDefinition, answer: Record<string, unknown>) {
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const provider = new (class extends LlmProvider {
      async callStep(): Promise<Record<string, unknown>> {
        return answer;
      }
    })();
    const lines: string[] = [];
    for (const kind of ['log', 'error'] as const) {
      vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
        lines.push(`${kind}: ${a.join(' ')}`);
      });
    }
    let result: string;
    try {
      result = await runAgent(
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
          registry: createDefaultRegistry(),
        },
        {
          definition: def,
          existingRunId: run.id,
          params: {},
          inFlightPollMs: 5,
          inFlightWatchMs: 200,
        },
      );
    } finally {
      vi.restoreAllMocks();
    }
    return {
      result,
      phase: (await store.get(run.id)).run_phase,
      last: lines.at(-1)!.split(run.id).join('<run>'),
    };
  }

  it('a first step whose `when` is never true: the drive stops with nothing ready, in realm run advance’s words, with inspect and abandon', async () => {
    claim(
      'docs/reference/cli/realm-agent.md',
      "A run that has not ended is never said to have ended: when the drive stops with nothing ready, it prints `✗ The drive stops: <why>. Run <id> stays open (phase '<phase>'): see realm run inspect <id> — or end it: realm run abandon <id>`, its reason in `realm run advance`'s words (`nothing is ready to run now` when a first step's `when` is never true, for one).",
    );
    const d = await drive(
      wf('f16-when', {
        first: {
          description: 'First.',
          execution: 'agent',
          depends_on: [],
          when: 'run.params.go == true',
        } as StepDefinition,
      }),
      {},
    );
    // (a) red when the drive says `Run ended in phase: running` of a run that has not ended (G1-R3);
    //     (b) prints the last line, the result and the phase.
    expect(d).toEqual({
      result: 'failed',
      phase: 'running',
      last: "error: \n✗ The drive stops: nothing is ready to run now. Run <run> stays open (phase 'running'): see realm run inspect <run> — or end it: realm run abandon <run>",
    });
  });

  it('a run that ended without completing (preservation): `Run ended in phase: aborted`', async () => {
    const d = await drive(
      wf('f16-aborted', {
        p: { description: 'P.', execution: 'agent', depends_on: [] },
        g: {
          description: 'G.',
          execution: 'guard',
          depends_on: ['p'],
          abort_unless: ['p.ok == true'],
        } as StepDefinition,
      }),
      { ok: false },
    );
    // (a) red when a run that ended is no longer said to have ended; (b) prints the last line.
    expect({ phase: d.phase, ended: d.last }).toEqual({
      phase: 'aborted',
      ended: 'error: \nRun ended in phase: aborted',
    });
  });
});
