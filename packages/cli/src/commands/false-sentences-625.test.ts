// false-sentences-625.test.ts — issue #625 PR-2a, the last prompt's F17 on the CLI (review G6-R1,
// G6-R2, G6-R3): sentences of the CHANGELOG and `step-kinds.md` made true as the build behaves. The
// CHANGELOG quotes two lines as the build prints them — with no full stop after a command (decision
// C212). After the workflow is corrected, `realm run advance` runs a refused `auto` step, and for an
// agent step names the drive.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  executeStep,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { advanceRunFromShell } from './run-advance.js';
import { respondToGate } from './respond.js';
import { runAgent } from '../agent/run-agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#625 PR-2a, F17 — the CHANGELOG and step-kinds.md quote what the CLI prints', () => {
  it('G6-R1: realm agent stopped on an agent step refused for a precondition — the CHANGELOG’s closing line is the one printed', async () => {
    const line =
      "✗ The drive stops: nothing else can run, and '<s>' cannot run (<check>). Run <id> stays open (phase '<phase>'): correct the workflow, register it again, then realm run advance <id> — or end it: realm run abandon <id>";
    claim('CHANGELOG.md', `ONE line closes the drive, exit 1: \`${line}\``);
    const def = wf('f17-pre', {
      ask: {
        description: 'Ask.',
        execution: 'agent',
        depends_on: [],
        preconditions: ['run.params.ok == true'],
      } as StepDefinition,
    });
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const lines: string[] = [];
    for (const kind of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
        lines.push(a.join(' '));
      });
    }
    const result = await runAgent(
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
        provider: new (class extends LlmProvider {
          async callStep(): Promise<Record<string, unknown>> {
            return {};
          }
        })(),
        registry: new ExtensionRegistry(),
      },
      {
        definition: def,
        existingRunId: run.id,
        params: {},
        inFlightPollMs: 5,
        inFlightWatchMs: 100,
      },
    );
    vi.restoreAllMocks();
    // (a) red when the CHANGELOG quotes a line the drive does not print (G6-R1: `; or end it:` and
    //     a full stop); (b) prints the printed line and the one the CHANGELOG quotes.
    expect({ result, last: lines.at(-1)!.trim() }).toEqual({
      result: 'failed',
      last: line
        .replace('<s>', 'ask')
        .replace('<check>', 'precondition')
        .replace('<phase>', 'running')
        .split('<id>')
        .join(run.id),
    });
  });

  it('G6-R2: realm run respond, an owed step this program lacks the handler for — the last line is the CHANGELOG’s, with no full stop', async () => {
    const line = 'To end the run instead: realm run abandon <id>';
    claim(
      'CHANGELOG.md',
      `When no step is refused before its claim, the last of those lines is \`${line}\` (a step this program lacks the handler or adapter for names its own way out).`,
    );
    const home = mkdtempSync(join(tmpdir(), 'realm-f17-cli-'));
    try {
      const runs = new JsonFileStore(join(home, 'runs'));
      const workflows = new JsonWorkflowStore(join(home, 'wf'));
      const def = wf('f17-capgate', {
        decide: {
          description: 'Decide.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          gate: { choices: ['approve', 'reject'] },
        } as StepDefinition,
        compute: {
          description: 'Compute.',
          execution: 'auto',
          depends_on: ['decide'],
          handler: 'missing_here',
        },
      });
      await workflows.register(def);
      const { run } = await runs.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeStep(runs, def, {
        runId: run.id,
        command: 'decide',
        input: {},
        dispatcher: async () => ({}),
      });
      const gate = (await runs.get(run.id)).pending_gate!.gate_id;
      const out = await respondToGate(
        run.id,
        { gate, choice: 'approve' },
        runs,
        workflows,
        new ExtensionRegistry(),
      );
      // (a) red when the CHANGELOG quotes the line with a full stop the build does not print
      //     (G6-R2), or the line is not the last; (b) prints the last two lines.
      expect(out.lastLine.split('\n').slice(-2)).toEqual([
        "'compute' cannot run here (capability): handler 'missing_here' is not registered here — load the missing extension, or run the step on a runner that has it.",
        line.replace('<id>', run.id),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each(['agent', 'auto'] as const)(
    'G6-R3: a %s step refused for a precondition; the workflow corrected and registered again; then realm run advance',
    async (kind) => {
      claim(
        'docs/concepts/step-kinds.md',
        "Correcting the workflow and registering it again is the fix: the run picks up the corrected definition, and `realm run advance` then runs the step when it is an `auto` step; for an agent step it names the drive (`Nothing is owed to the engine: an agent step is ready: '<step>' — drive it with realm agent --run-id <id> --provider <provider> --model <model>`).",
      );
      const home = mkdtempSync(join(tmpdir(), 'realm-f17-cli-'));
      try {
        const runs = new JsonFileStore(join(home, 'runs'));
        const workflows = new JsonWorkflowStore(join(home, 'wf'));
        const step = (pre: boolean): StepDefinition =>
          ({
            description: 'Ask.',
            execution: kind,
            depends_on: [],
            ...(pre ? { preconditions: ['run.params.ok == true'] } : {}),
          }) as StepDefinition;
        await workflows.register(wf(`f17-fix-${kind}`, { ask: step(true) }));
        const { run } = await runs.create({
          workflowId: `f17-fix-${kind}`,
          workflowVersion: 1,
          params: {},
        });
        const advance = async () => {
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
          return { code, lines: lines.slice(3).map((l) => l.split(run.id).join('<id>')) };
        };
        const refused = await advance();
        await workflows.register(wf(`f17-fix-${kind}`, { ask: step(false) }));
        const fixed = await advance();
        // (a) red when the page says realm run advance runs a corrected agent step (G6-R3), or when
        //     advance stops running a corrected auto step; (b) prints the exit and lines of each call.
        expect({
          refused: refused.code,
          fixed,
          done: (await runs.get(run.id)).completed_steps,
        }).toEqual(
          kind === 'agent'
            ? {
                refused: 1,
                fixed: {
                  code: 0,
                  lines: [
                    "Nothing is owed to the engine: an agent step is ready: 'ask' — drive it with realm agent --run-id <id> --provider <provider> --model <model>",
                    'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
                  ],
                },
                done: [],
              }
            : {
                refused: 1,
                fixed: {
                  code: 0,
                  lines: ["Owed to the engine: 'ask'.", '→ ask', "Run <id>: phase 'completed'"],
                },
                done: ['ask'],
              },
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
