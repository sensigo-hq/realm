// docs-pages-625-agent.test.ts — issue #625 PR-2a, decision C174 (round 22), pin lane C: every
// sentence on docs/reference/cli/realm-agent.md and docs/reference/cli/realm-listen.md about what #625
// PR-2a added or changed, quoted word for word (read from the repository) by a cell that drives the
// case and asserts what the sentence states — so neither the page nor the behaviour can change alone.
//
// `realm agent` is driven in-process with `runAgent` and a stand-in provider (the harness of
// chained-capability-625.test.ts); the cells that need another terminal (`realm run respond`,
// `realm run advance`) or the command's exit code run the built `realm` as a child with a fresh HOME;
// `realm listen`'s sweeper runs as the built `realm listen --sweep-expired-gates`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  abandonRun,
  createDefaultRegistry,
  executeChain,
  executeStep,
  JsonFileStore,
  JsonWorkflowStore,
  loadWorkflowFromString,
  submitHumanResponse,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type ExtensionRegistry,
  type PendingGate,
  type RunRecord,
  type RunStore,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { buildReattachFlags } from '../commands/agent.js';
import { lagless } from '../test-support/lag.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const AGENT_PAGE = 'docs/reference/cli/realm-agent.md';
const LISTEN_PAGE = 'docs/reference/cli/realm-listen.md';
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

const auto = (extra: Partial<StepDefinition> = {}, depends_on: string[] = []): StepDefinition =>
  ({ description: 'X', execution: 'auto', depends_on, ...extra }) as StepDefinition;
const agent = (extra: Partial<StepDefinition> = {}, depends_on: string[] = []): StepDefinition =>
  ({ description: 'An agent step.', execution: 'agent', depends_on, ...extra }) as StepDefinition;

function wf(
  steps: Record<string, StepDefinition>,
  extra: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
  return {
    id: 'c174-c',
    name: 'c174 c',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
    ...extra,
  } as WorkflowDefinition;
}

const HEADER = ['log: \nRealm Agent — c174 c v1', 'log: Run ID: <run>\n'];
const stopLine = (check: string, step: string): string =>
  `error: \n✗ The drive stops: nothing else can run, and '${step}' cannot run (${check}). Run <run> stays open (phase 'running'): ${
    // F15: a step refused for its input (in these fixtures, with `depends_on`) gets its own way out.
    check === 'input_schema'
      ? `for '${step}', the engine gives it no input, so correct its input_schema and register the workflow again; then, after a fix, realm run advance <run>`
      : 'correct the workflow, register it again, then realm run advance <run>'
  } — or end it: realm run abandon <run>`;

interface Drive {
  result: string;
  lines: string[];
  calls: number;
  runId: string;
  store: InMemoryStore;
}

interface DriveOptions {
  params?: Record<string, unknown>;
  registry?: ExtensionRegistry;
  reattachFlags?: string;
  answer?: Record<string, unknown>;
  /** Runs inside each model call — another process acting on the run while the model answers. */
  during?: (store: InMemoryStore, call: number) => Promise<void>;
  gateHandler?: (store: InMemoryStore, runId: string, gate: PendingGate) => Promise<void>;
  store?: InMemoryStore;
  existingRunId?: string;
}

/** One `realm agent` drive in-process; the run's id is written `<run>` in the lines. */
async function drive(def: WorkflowDefinition, o: DriveOptions = {}): Promise<Drive> {
  const store = o.store ?? new InMemoryStore();
  let calls = 0;
  const provider = new (class extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      calls += 1;
      if (o.during !== undefined) await o.during(store, calls);
      return o.answer ?? {};
    }
  })();
  const lines: string[] = [];
  for (const kind of ['log', 'error', 'warn'] as const) {
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
        registry: o.registry ?? createDefaultRegistry(),
        ...(o.reattachFlags !== undefined ? { reattachFlags: o.reattachFlags } : {}),
        ...(o.gateHandler !== undefined
          ? {
              gateHandler: (runId: string, gate: PendingGate) => o.gateHandler!(store, runId, gate),
            }
          : {}),
      },
      {
        definition: def,
        params: o.params ?? {},
        ...(o.existingRunId !== undefined ? { existingRunId: o.existingRunId } : {}),
        inFlightPollMs: 5,
        inFlightWatchMs: 20,
        pollIntervalMs: 20,
      },
    );
  } finally {
    vi.restoreAllMocks();
  }
  const runId = o.existingRunId ?? (await store.list())[0]!.id;
  return { result, lines: lines.map((l) => l.split(runId).join('<run>')), calls, runId, store };
}

/** The drive's line without its stream's leading blank line. */
const bare = (l: string | undefined): string => (l ?? '').replace(/^(log|error|warn): \n/, '$1: ');

afterEach(() => {
  vi.restoreAllMocks();
});

describe(
  "#625 PR-2a, round 30 — C211 (walk c14 W3-4): realm agent names the cleanup steps a drive's ending left pending",
  { timeout: 60_000 },
  () => {
    const tidy = {
      description: 'Tidy.',
      execution: 'finalizer',
      handler: 'missing_fin',
      on_outcome: 'always',
    } as unknown as StepDefinition;
    it('a completed run: `Run complete:`, then the command that runs the cleanup step on stdout; a failed run: after the stop lines, on stderr', async () => {
      claim(
        AGENT_PAGE,
        "When the run ended with cleanup steps left `pending` (the drive has no handler for them), one more line names the command that runs them, `Cleanup step left pending: '<name>' — to run it with code that has its handler: realm run drain <run-id> --force`: on stdout after `Run complete: <run-id>`, on stderr after the lines above (added after version 0.46.0).",
      );
      const line =
        "Cleanup step left pending: 'tidy' — to run it with code that has its handler: realm run drain <run> --force";
      const done = await drive(wf({ a: agent(), tidy }), { answer: {} });
      const registry = createDefaultRegistry();
      registry.register('handler', 'boom', {
        id: 'boom',
        execute: async () => {
          throw new Error('it broke');
        },
      });
      const failed = await drive(wf({ a: agent(), s: auto({ handler: 'boom' }, ['a']), tidy }), {
        answer: {},
        registry,
      });
      // (a) red when the command is missing or on the wrong stream; (b) prints the lines.
      expect({
        done: [done.result, done.lines[done.lines.indexOf('log: \nRun complete: <run>') + 1]],
        failed: [
          failed.result,
          failed.lines.filter((l) => l.includes('Cleanup step left pending')),
        ],
      }).toEqual({
        done: ['completed', `log: ${line}`],
        failed: ['failed', [`error: ${line}`]],
      });
    });
  },
);

describe('#625 PR-2a, C174 lane C — realm-agent.md, from the drive', { timeout: 60_000 }, () => {
  it('the table row `• Step … cannot run (<check>)`: an auto step that cannot run is named once per drive, and the drive goes on with the ready agent step', async () => {
    claim(
      AGENT_PAGE,
      "| `• Step '<step>' cannot run (<check>): <why>` | An `auto` step cannot run | Printed once per drive; the drive goes on with any agent step that is ready. See below. Added after version 0.46.0. |",
    );
    const d = await drive(
      wf({
        x: auto({
          input_schema: { type: 'object', properties: { n: { type: 'string' } } },
        }),
        review: agent(),
      }),
      { params: { n: 5 } },
    );
    const named = d.lines
      .map((l) => /^log: • Step '(\w+)' cannot run \((\w+)\): (.+)$/.exec(l))
      .filter((m) => m !== null)
      .map((m) => [m[1], m[2], m[3]]);
    // (a) red when the line's shape changes, it is printed twice, or the agent step beside it does
    //     not run; (b) prints the named lines, the model calls and the completed steps.
    expect({
      named,
      calls: d.calls,
      completed: (await d.store.get(d.runId)).completed_steps,
    }).toEqual({
      named: [['x', 'input_schema', "Invalid input for step 'x': 'n' must be string"]],
      calls: 1,
      completed: ['review'],
    });
    expect(d.lines.indexOf('log: \n→ [agent] review')).toBeGreaterThan(
      d.lines.findIndex((l) => l.startsWith("log: • Step 'x' cannot run")),
    );
  });

  describe('the paragraph: each check names the step once, the drive goes on, a step refused before its claim is never submitted', () => {
    type Member =
      | 'trust'
      | 'precondition'
      | 'input_type'
      | 'input_extra'
      | 'handler'
      | 'adapter'
      | 'handler_here';
    const member = (m: Member): { def: WorkflowDefinition; params: Record<string, unknown> } => {
      const review = agent();
      switch (m) {
        case 'trust':
          return {
            def: wf({ x: auto({ trust: 'bogus_value' } as never), review }),
            params: {},
          };
        case 'precondition':
          return {
            def: wf({ x: auto({ preconditions: ['nothing.ok == true'] }), review }),
            params: {},
          };
        case 'input_type':
          return {
            def: wf({
              x: auto({ input_schema: { type: 'object', properties: { n: { type: 'string' } } } }),
              review,
            }),
            params: { n: 5 },
          };
        case 'input_extra':
          return {
            def: wf({
              x: auto({
                input_schema: {
                  type: 'object',
                  properties: { n: { type: 'number' } },
                  additionalProperties: false,
                },
              }),
              review,
            }),
            params: { n: 5, e: 1 },
          };
        case 'handler':
        case 'handler_here':
          return { def: wf({ x: auto({ handler: 'missing_h' }), review }), params: {} };
        case 'adapter':
          return {
            def: wf(
              { x: auto({ uses_service: 'crm', service_method: 'create' } as never), review },
              { services: { crm: { adapter: 'salesforce', config: {} } } } as never,
            ),
            params: {},
          };
      }
    };
    const LINE: Record<Exclude<Member, 'handler_here'>, string> = {
      trust:
        "log: • Step 'x' cannot run (trust): 'trust: \"bogus_value\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.",
      precondition:
        "log: • Step 'x' cannot run (precondition): Precondition failed for step 'x'. Precondition failed: 'nothing.ok == true'. Resolved value: undefined.",
      input_type:
        "log: • Step 'x' cannot run (input_schema): Invalid input for step 'x': 'n' must be string",
      input_extra:
        "log: • Step 'x' cannot run (input_schema): Invalid input for step 'x': 'e' is not allowed",
      handler:
        "log: • Step 'x' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it",
      adapter:
        "log: • Step 'x' cannot run here (capability): adapter 'salesforce' is not registered here — load the missing extension, or run the step on a runner that has it",
    };
    const PRE_CLAIM: Member[] = ['trust', 'precondition', 'input_type', 'input_extra'];

    for (const m of [
      'trust',
      'precondition',
      'input_type',
      'input_extra',
      'handler',
      'adapter',
    ] as const) {
      it(`${m}: named once with its check, the ready agent step runs${PRE_CLAIM.includes(m) ? ', and the step is never submitted' : ''}`, async () => {
        claim(
          AGENT_PAGE,
          "An `auto` step that cannot run is named once per drive with the check that refused it: `• Step '<step>' cannot run (<check>): <why>` for an invalid `trust`, a failed precondition or an input its schema rejects (the refusal names the field and what it must be, or the property the schema does not allow), and `• Step '<step>' cannot run here (capability): <why>` for a handler or adapter this program has not registered — judged with this program's own extensions. The drive goes on with any agent step that is ready. A step refused before its claim is never submitted.",
        );
        const { def, params } = member(m);
        const d = await drive(def, { params });
        const run = await d.store.get(d.runId);
        // (a) red when the member's line changes (its check, the field and what it must be, the
        //     property not allowed), is printed other than once, or the ready agent step does not
        //     run; (b) prints the count, the model calls and the completed steps.
        expect({
          once: d.lines.filter((l) => l === LINE[m]).length,
          calls: d.calls,
          completed: run.completed_steps,
        }).toEqual({ once: 1, calls: 1, completed: ['review'] });
        if (PRE_CLAIM.includes(m)) {
          // (a) red when a step refused before its claim is attempted, claimed or recorded as run;
          //     (b) prints what the record holds for it.
          expect({
            attempted: d.lines.includes('log: → [auto] x'),
            claimed: run.claims?.['x'] !== undefined,
            in_progress: run.in_progress_steps.includes('x'),
            failed: run.failed_steps.includes('x'),
            evidence: run.evidence.filter((e) => e.step_id === 'x').length,
          }).toEqual({
            attempted: false,
            claimed: false,
            in_progress: false,
            failed: false,
            evidence: 0,
          });
        }
      });
    }

    it('judged with this program’s own extensions: with the handler in the drive’s registry the step is not named and runs', async () => {
      const { def } = member('handler_here');
      const registry = createDefaultRegistry();
      registry.register('handler', 'missing_h', {
        id: 'missing_h',
        execute: async () => ({ data: { ok: true } }),
      } as never);
      const d = await drive(def, { registry });
      // (a) red when the capability check reads anything but this program's registry; (b) prints
      //     the named lines and the completed steps.
      expect({
        named: d.lines.filter((l) => l.includes('cannot run')),
        completed: (await d.store.get(d.runId)).completed_steps.slice().sort(),
      }).toEqual({ named: [], completed: ['review', 'x'] });
    });
  });

  describe('right after an agent step: the agent step completes, the step is named once, the drive goes on, and the stop names that step', () => {
    for (const kind of ['input_schema', 'capability'] as const) {
      it(kind, async () => {
        claim(
          AGENT_PAGE,
          "When such a step comes right after an agent step, the agent step's call reaches it first: the agent step is said as completed (`✓ → running`), the step is named once, the drive goes on with any agent step that is ready, and its stop names that step and what it needs — never the agent step.",
        );
        const file =
          kind === 'input_schema'
            ? auto({ input_schema: { type: 'object', required: ['must'] } }, ['classify'])
            : auto({ handler: 'file_ticket' }, ['classify']);
        const d = await drive(wf({ classify: agent(), file, ask2: agent({}, ['classify']) }));
        const NAMED =
          kind === 'input_schema'
            ? "log: • Step 'file' cannot run (input_schema): Invalid input for step 'file': the input must have required property 'must'"
            : "log: • Step 'file' cannot run here (capability): handler 'file_ticket' is not registered here — load the missing extension, or run the step on a runner that has it";
        const STOP =
          kind === 'input_schema'
            ? stopLine('input_schema', 'file')
            : "error: \n⚠ Step 'file' is blocked: handler 'file_ticket' is not registered in this runner. The run is NOT failed — add handler 'file_ticket' and re-attach (`realm agent --run-id <run> --provider <provider> --model <model>`).";
        const at = d.lines.indexOf('log: \n→ [agent] classify');
        // (a) red when the agent step is not said as completed before the step is named, the step is
        //     named twice, the ready agent step does not run, or the stop names the agent step;
        //     (b) prints the screen after the agent step.
        expect(d.lines.slice(at + 2, at + 4)).toEqual(['log:   ✓ → running', NAMED]);
        expect(d.lines.filter((l) => l === NAMED)).toHaveLength(1);
        expect(d.lines.indexOf('log: \n→ [agent] ask2')).toBeGreaterThan(d.lines.indexOf(NAMED));
        expect({ result: d.result, stop: d.lines.at(-1) }).toEqual({
          result: 'failed',
          stop: STOP,
        });
        expect(d.lines.join('\n')).not.toContain("'classify' cannot run");
        expect(d.lines.join('\n')).not.toContain("Step 'classify' is blocked");
      });
    }
  });

  it("the publish example: the blocked step after an agent step is named once, the drive goes on, and its stop is the page’s `⚠ Step 'publish' is blocked` line", async () => {
    claim(
      AGENT_PAGE,
      "When the blocked step comes right after an agent step, the agent step is said as completed (`✓ → running`), the blocked step is named once (`• Step 'publish' cannot run here (capability): handler 'publish_answer' is not registered here — load the missing extension, or run the step on a runner that has it`), the drive goes on with any agent step that is ready, and its stop is the line above, naming `publish`.",
    );
    const above = block(AGENT_PAGE, "⚠ Step 'publish' is blocked").find((l) =>
      l.startsWith("⚠ Step 'publish' is blocked"),
    )!;
    // The drive was started with `--provider anthropic --model claude-sonnet-5-5 --extensions-module
    // ./ext.mjs`: the re-attach flags `realm agent` hands the drive for those flags.
    const d = await drive(
      wf({
        classify: agent(),
        publish: auto({ handler: 'publish_answer' }, ['classify']),
        ask2: agent({}, ['classify']),
      }),
      {
        reattachFlags: buildReattachFlags({
          provider: 'anthropic',
          model: 'claude-sonnet-5-5',
          extensionsModule: './ext.mjs',
        }),
      },
    );
    const NAMED =
      "log: • Step 'publish' cannot run here (capability): handler 'publish_answer' is not registered here — load the missing extension, or run the step on a runner that has it";
    const at = d.lines.indexOf('log: \n→ [agent] classify');
    // (a) red when the agent step is not said as completed, the blocked step is named other than
    //     once, the ready agent step does not run, or the stop differs from the page's line (run id
    //     put in place); (b) prints the screen after the agent step and the stop.
    expect(d.lines.slice(at + 2, at + 4)).toEqual(['log:   ✓ → running', NAMED]);
    expect(d.lines.filter((l) => l === NAMED)).toHaveLength(1);
    expect(d.lines.indexOf('log: \n→ [agent] ask2')).toBeGreaterThan(d.lines.indexOf(NAMED));
    expect(bare(d.lines.at(-1))).toBe(
      `error: ${above.split('d1a87150-33b5-4126-86c2-60350446794d').join('<run>')}`,
    );
  });

  describe('an agent step refused before its claim is named the same way, never sent to the model, and the drive stops on it', () => {
    it('a failed precondition', async () => {
      claim(
        AGENT_PAGE,
        "An agent step that is refused before its claim — a failed precondition, or an invalid `trust` in a registered copy the loader never checked — is named the same way, `• Step 'ask' cannot run (precondition): Precondition failed for step 'ask'. …`, and is never sent to the model; when nothing else can run the drive stops on it (see [When it stops](#when-it-stops)).",
      );
      const d = await drive(wf({ ask: agent({ preconditions: ['run.params.ok == true'] }) }));
      // (a) red when the model is asked, the line changes, or the drive does not stop on the step;
      //     (b) prints the result, the calls and the screen.
      expect({ result: d.result, calls: d.calls, lines: d.lines }).toEqual({
        result: 'failed',
        calls: 0,
        lines: [
          ...HEADER,
          "log: • Step 'ask' cannot run (precondition): Precondition failed for step 'ask'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.",
          stopLine('precondition', 'ask'),
        ],
      });
      expect(
        d.lines[2]!.startsWith(
          "log: • Step 'ask' cannot run (precondition): Precondition failed for step 'ask'. ",
        ),
      ).toBe(true);
    });

    it('an invalid trust in a copy the loader never checked (the loader refuses the same value)', async () => {
      // (a) red when the loader stops refusing the value (then no registered copy carries it);
      //     (b) prints the loader's error.
      expect(() =>
        loadWorkflowFromString(
          [
            'id: t',
            'name: t',
            'version: 1',
            'steps:',
            '  ask:',
            '    description: A.',
            '    execution: agent',
            '    trust: bogus_value',
            '',
          ].join('\n'),
        ),
      ).toThrow(/'trust: "bogus_value"' is not a recognized value — refused at load/);
      const d = await drive(wf({ ask: agent({ trust: 'bogus_value' } as never) }));
      // (a) red when the model is asked or the drive does not stop on the step; (b) prints the
      //     result, the calls and the screen.
      expect({ result: d.result, calls: d.calls, lines: d.lines }).toEqual({
        result: 'failed',
        calls: 0,
        lines: [
          ...HEADER,
          "log: • Step 'ask' cannot run (trust): 'trust: \"bogus_value\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.",
          stopLine('trust', 'ask'),
        ],
      });
    });
  });

  describe('a `blocked` reply is never followed by ✓', () => {
    const SENTENCE =
      "A `blocked` reply is never followed by `✓`: an `auto` step another process took between the drive's read and the engine's is said as taken (`• Step '<step>' was taken by …; not run here.`), and an agent step as below; when another process opened a gate or ended the run in that moment, the drive goes on as it does at any gate or end (it waits at the gate, or prints `Run ended in phase: <phase>`); any other `blocked` reply prints its own reason (`✗ Precondition failed for step 'ask'.`) and stops the drive with exit code 1.";

    it('taken: another process completed the step while the model answered — said as taken, no ✓', async () => {
      claim(AGENT_PAGE, SENTENCE);
      const def = wf({ ask: agent(), more: agent({}, ['ask']) });
      const d = await drive(def, {
        during: async (store, call) => {
          if (call !== 1) return;
          const runId = (await store.list())[0]!.id;
          const r = await executeStep(store, def, {
            runId,
            command: 'ask',
            input: {},
            dispatcher: async () => ({ by: 'other' }),
          });
          expect(r.status).toBe('ok');
        },
      });
      const after = d.lines.slice(d.lines.indexOf('log: \n→ [agent] ask') + 2);
      // (a) red when the taken step is followed by `✓` or the line's shape changes; (b) prints the
      //     line after the attempt.
      // decision C179: the agent step's line says its answer was not recorded.
      expect(after[0]).toMatch(
        /^log: • Step 'ask' was taken by .+, and completed; this drive's answer was not recorded\.$/,
      );
      expect(after[0]).not.toContain('✓');
      expect(after[1]).toBe('log: \n→ [agent] more');
    });

    it('a gate another process opened in that moment: the drive waits at the gate, no ✗, no ✓ for the refused step', async () => {
      claim(AGENT_PAGE, SENTENCE);
      const def = wf({ ask: agent(), review: agent({ trust: 'human_confirmed' } as never) });
      const d = await drive(def, {
        during: async (store, call) => {
          if (call !== 1) return;
          const runId = (await store.list())[0]!.id;
          const r = await executeStep(store, def, {
            runId,
            command: 'review',
            input: { verdict: 'fine' },
            dispatcher: async (_s, input) => ({ ...input }),
          });
          expect(r.status).toBe('confirm_required');
        },
        gateHandler: async (store, runId, gate) => {
          await submitHumanResponse(store, def, {
            runId,
            gateId: gate.gate_id,
            choice: gate.choices[0]!,
          });
        },
      });
      const firstAsk = d.lines.indexOf('log: \n→ [agent] ask');
      // (a) red when the refused attempt prints `✓` or `✗`, or the drive does not wait at the gate;
      //     (b) prints the line after the attempt and the result.
      expect({
        next: d.lines[firstAsk + 2]?.startsWith('log: \n⏸  Gate: review | ID: '),
        crosses: d.lines.filter((l) => l.includes('✗')),
        result: d.result,
      }).toEqual({ next: true, crosses: [], result: 'completed' });
    });

    it('the run another process ended in that moment: `Run ended in phase: <phase>`, no ✓', async () => {
      claim(AGENT_PAGE, SENTENCE);
      class WindowStore extends InMemoryStore {
        hook: ((runId: string) => Promise<void>) | undefined;
        override async get(runId: string): Promise<RunRecord> {
          const record = await super.get(runId);
          const h = this.hook;
          if (h !== undefined) {
            this.hook = undefined;
            await h(runId);
          }
          return record;
        }
      }
      const store = new WindowStore();
      const def = wf({ ask: agent(), more: agent({}, ['ask']) });
      const d = await drive(def, {
        store,
        during: async (_s, call) => {
          if (call !== 1) return;
          store.hook = async (runId) => {
            await abandonRun(store, runId, 'ended elsewhere');
          };
        },
      });
      // (a) red when the refused attempt prints `✓` or its own `✗` reason instead of the run-ended
      //     line; (b) prints the last three lines.
      expect({ tail: d.lines.slice(-3), ticks: d.lines.filter((l) => l.includes('✓')) }).toEqual({
        // decision C179: the answer the ended run did not record is said, before the run-ended line.
        tail: [
          "log: • Step 'ask' was not run: the run ended (abandoned) before this drive's answer reached it; the answer was not recorded.",
          'error: \nRun ended in phase: abandoned',
          // F2: the drive stops on a run an operator ended — the ending and its reason, never the undo.
          'error:   Ended:     An operator ended this run, with the reason "ended elsewhere"; to run the work again, start a new run.',
        ],
        ticks: [],
      });
    });

    it('any other blocked reply (a precondition failing on the engine’s own read): its reason, and the drive stops (failed)', async () => {
      claim(AGENT_PAGE, SENTENCE);
      const def = wf({ ask: agent() });
      const d = await drive(def, {
        during: async () => {
          def.steps['ask']!.preconditions = ['nothing.ok == true'];
        },
      });
      // (a) red when the reply prints `✓` or another reason, or the drive goes on; (b) prints the
      //     result, the calls and the last line.
      expect({
        result: d.result,
        calls: d.calls,
        last: d.lines.at(-1),
        ticks: d.lines.filter((l) => l.includes('✓')),
      }).toEqual({
        result: 'failed',
        calls: 1,
        last: "error: \n✗ Precondition failed for step 'ask'.",
        ticks: [],
      });
    });
  });

  it('the expired-question row: the expiry line in place of the gate’s lines, the question not shown', async () => {
    // F1: the CHANGELOG's entry quotes the line with its lag.
    claim(
      'CHANGELOG.md',
      "prints `⚠ gate '<g>' on '<s>' had expired <how long> before this call — this agent call first carried out its declared … (enacted_via: agent).`",
    );
    claim(
      AGENT_PAGE,
      "| `⚠ gate '<gate>' on '<step>' had expired <how long> before this call — this agent call first carried out its declared …` | The run reaches a question whose time is already up and whose `on_expiry` the engine carries out | The expiry it carried out, in place of the gate's lines: such a question is not shown, since an answer could no longer be recorded. Added after version 0.46.0. |",
    );
    const def = loadWorkflowFromString(
      [
        'id: c174-expired',
        'name: c174-expired',
        'version: 1',
        'steps:',
        '  review:',
        '    description: A person decides.',
        '    execution: auto',
        '    trust: human_confirmed',
        '    gate:',
        '      choices: [ship, hold]',
        '      timeout_seconds: 60',
        '      on_expiry: settle_default',
        '      default_choice: hold',
        '  file:',
        '    description: File.',
        '    execution: auto',
        '    depends_on: [review]',
        '',
      ].join('\n'),
    );
    const store = new InMemoryStore();
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeChain(store, def, {
      runId: run.id,
      command: 'review',
      input: {},
      dispatcher: async () => ({}),
      registry: createDefaultRegistry(),
    });
    const open = await store.get(run.id);
    const gate = open.pending_gate as PendingGate;
    await store.update({
      ...open,
      pending_gate: { ...gate, expires_at: new Date(Date.now() - 5_000).toISOString() },
    });
    const d = await drive(def, { store, existingRunId: run.id });
    // (a) red when the question is shown (the gate block, `Waiting for approval…`, a `--choice`
    //     command) or the expiry line is missing or reworded; (b) prints the screen.
    expect(
      d.lines.filter(
        (l) =>
          l.includes('⏸  Gate') || l.includes('Waiting for approval') || l.includes('--choice'),
      ),
    ).toEqual([]);
    // F1: the line says how long before the drive the question's time was up — `<lag>` in its place.
    expect(
      lagless(d.lines).filter((l) =>
        l.startsWith(
          `log: ⚠ gate '${gate.gate_id}' on 'review' had expired <lag> before this call — this agent call first carried out its declared `,
        ),
      ),
    ).toEqual([
      `log: ⚠ gate '${gate.gate_id}' on 'review' had expired <lag> before this call — this agent call first carried out its declared settle_default: the default choice 'hold' was recorded (enacted_via: agent).`,
    ]);
    expect(d.calls).toBe(0);
  });

  it('the `✗ Step …`, `✗ The drive stops: …`, `⚠ Step … is blocked …` row, and "the line that starts with ✗ (⚠ for a missing handler or adapter) gives the reason"', async () => {
    claim(
      AGENT_PAGE,
      "| `✗ Step '<step>' …`, `✗ The drive stops: …`, `⚠ Step '<step>' is blocked …` | The run cannot go on | The reason: a step that failed, a step refused before its claim with nothing else to run, or a handler or adapter this program has not registered. See [When it stops](#when-it-stops). |",
    );
    claim(
      AGENT_PAGE,
      'The line that starts with `✗` (`⚠` for a missing handler or adapter) gives the reason:',
    );
    const registry = createDefaultRegistry();
    registry.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error('down');
      },
    });
    const failed = await drive(wf({ x: auto({ handler: 'boom' }) }), { registry });
    const refused = await drive(wf({ x: auto({ preconditions: ['nothing.ok == true'] }) }));
    const handler = await drive(wf({ x: auto({ handler: 'missing_h' }) }));
    const adapter = await drive(
      wf({ x: auto({ uses_service: 'crm', service_method: 'create' } as never) }, {
        services: { crm: { adapter: 'salesforce', config: {} } },
      } as never),
    );
    // (a) red when a stop's reason line changes its opening (`✗ Step`, `✗ The drive stops`, `⚠ Step
    //     … is blocked`) or the drive does not stop; (b) prints each result and last line.
    //     Decision C205: the failed step's line is followed by the `Resume:` line (the run ended
    //     with a failed step `realm run resume` takes) — the reason is the line before it.
    expect([
      [failed.result, bare(failed.lines.at(-2)), bare(failed.lines.at(-1))],
      ...[refused, handler, adapter].map((d) => [d.result, bare(d.lines.at(-1))]),
    ]).toEqual([
      [
        'failed',
        "error: ✗ Step 'x' failed: Handler 'boom' threw: down",
        'error:   Resume:    realm run resume <run> --from x',
      ],
      ['failed', bare(stopLine('precondition', 'x'))],
      [
        'failed',
        "error: ⚠ Step 'x' is blocked: handler 'missing_h' is not registered in this runner. The run is NOT failed — add handler 'missing_h' and re-attach (`realm agent --run-id <run> --provider <provider> --model <model>`).",
      ],
      [
        'failed',
        "error: ⚠ Step 'x' is blocked: adapter 'salesforce' is not registered in this runner. The run is NOT failed — add adapter 'salesforce' and re-attach (`realm agent --run-id <run> --provider <provider> --model <model>`).",
      ],
    ]);
  });

  describe('the When it stops table: the rows #625 PR-2a added, and the eighth', () => {
    it('the eighth row, and "the line names it and adds (run by the engine after \'<step>\' finished)": the line and the run ended in failed', async () => {
      const LINE =
        "✗ Step 'file' (run by the engine after 'classify' finished) failed: Handler 'file_ticket' threw: the filing system is down";
      claim(
        AGENT_PAGE,
        `| An \`auto\` step the engine ran after it failed | \`${LINE}\` | Ended, in \`failed\`. |`,
      );
      claim(
        AGENT_PAGE,
        "When the step that stopped is one the engine ran after the step the drive called, the line names it and adds `(run by the engine after '<step>' finished)`, as in the eighth row.",
      );
      const registry = createDefaultRegistry();
      registry.register('handler', 'file_ticket', {
        id: 'file_ticket',
        execute: async () => {
          throw new Error('the filing system is down');
        },
      });
      const d = await drive(
        wf({ classify: agent(), file: auto({ handler: 'file_ticket' }, ['classify']) }),
        { registry },
      );
      claim(
        AGENT_PAGE,
        'When an engine failure ended the run with a failed step `realm run resume` takes, one more line gives the command that makes it runnable again, `  Resume:    realm run resume <run-id> --from <step>` (added after version 0.46.0)',
      );
      claim(
        AGENT_PAGE,
        'The lines that say why the drive stopped (`✗ Step …` and `⚠ Step … is blocked`) go to stderr, and so do the `Resume:` line after them',
      );
      const run = await d.store.get(d.runId);
      // (a) red when the line names the step the drive called, drops the suffix, or the run does
      //     not end in failed; or (decision C205) the `Resume:` line is missing, names another
      //     step or goes to stdout; (b) prints the result, the last two lines and the phase.
      expect({
        result: d.result,
        last: d.lines.slice(-2).map((l) => bare(l)),
        phase: run.run_phase,
      }).toEqual({
        result: 'failed',
        last: [`error: ${LINE}`, 'error:   Resume:    realm run resume <run> --from file'],
        phase: 'failed',
      });
    });

    it('the ninth row (an auto step refused before its claim, nothing else) and the ninth case: the schema refused the input the engine built; open, in running', async () => {
      const LINE =
        "✗ The drive stops: nothing else can run, and 'file' cannot run (input_schema). Run 50e31961-… stays open (phase 'running'): for 'file', the engine gives it no input, so correct its input_schema and register the workflow again; then, after a fix, realm run advance 50e31961-… — or end it: realm run abandon 50e31961-…";
      claim(
        AGENT_PAGE,
        `| Nothing else can run, and an \`auto\` step is refused before it is claimed | \`${LINE}\` | Open, in \`running\`. |`,
      );
      claim(
        AGENT_PAGE,
        "In the ninth case, when the check is `input_schema`, the step's schema refused the input the engine built for it.",
      );
      // `file` waits on `classify`: the engine builds it the input `{}` (pending.ts engineStepInput).
      const schemaOf = (required: string[]) =>
        wf({
          classify: agent(),
          file: auto({ input_schema: { type: 'object', required } }, ['classify']),
        });
      const d = await drive(schemaOf(['urgent']), { answer: { urgent: true } });
      const run = await d.store.get(d.runId);
      // (a) red when the stop line differs from the page's (run id put in place), the refusal is
      //     not of the built input, or the run does not stay open in running; (b) prints them.
      expect({
        last: bare(d.lines.at(-1)).split('<run>').join('50e31961-…'),
        named: d.lines.filter((l) => l.startsWith("log: • Step 'file'")),
        failures: (run.drive_failures?.entries ?? []).map((e) => [e.step, e.message]),
        phase: run.run_phase,
        terminal: run.terminal_state,
      }).toEqual({
        last: `error: ${LINE}`,
        named: [
          "log: • Step 'file' cannot run (input_schema): Invalid input for step 'file': the input must have required property 'urgent'",
        ],
        failures: [['file', "Invalid input for step 'file'"]],
        phase: 'running',
        terminal: false,
      });
      // Control: a schema the built input meets — the step runs and the run completes.
      const ok = await drive(schemaOf([]), { answer: { urgent: true } });
      expect(ok.result).toBe('completed');
    });

    it('the tenth row (an agent step refused before its claim, nothing else): the page’s line; open, in running', async () => {
      const LINE =
        "✗ The drive stops: nothing else can run, and 'ask' cannot run (precondition). Run f0fef02d-… stays open (phase 'running'): correct the workflow, register it again, then realm run advance f0fef02d-… — or end it: realm run abandon f0fef02d-…";
      claim(
        AGENT_PAGE,
        `| Nothing else can run, and an agent step is refused before it is claimed | \`${LINE}\` | Open, in \`running\`. |`,
      );
      const d = await drive(wf({ ask: agent({ preconditions: ['run.params.ok == true'] }) }));
      const run = await d.store.get(d.runId);
      // (a) red when the stop line differs from the page's (run id put in place) or the run does
      //     not stay open in running; (b) prints them.
      expect({
        last: bare(d.lines.at(-1)).split('<run>').join('f0fef02d-…'),
        phase: run.run_phase,
        terminal: run.terminal_state,
        calls: d.calls,
      }).toEqual({ last: `error: ${LINE}`, phase: 'running', terminal: false, calls: 0 });
    });

    it('the eleventh row (an auto step needs a handler this program lacks, nothing else): the page’s line with the drive’s flags; open, in running', async () => {
      const LINE =
        "⚠ Step 'file' is blocked: handler 'file_ticket' is not registered in this runner. The run is NOT failed — add handler 'file_ticket' and re-attach (`realm agent --run-id b179423b-… --provider anthropic --model claude-sonnet-5-5 --extensions-module ./ext.mjs`).";
      claim(
        AGENT_PAGE,
        `| Nothing else can run, and an \`auto\` step needs a handler this program lacks | \`\`${LINE}\`\` | Open, in \`running\`. |`,
      );
      const d = await drive(
        wf({ classify: agent(), file: auto({ handler: 'file_ticket' }, ['classify']) }),
        {
          reattachFlags: buildReattachFlags({
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            extensionsModule: './ext.mjs',
          }),
        },
      );
      const run = await d.store.get(d.runId);
      // (a) red when the stop line differs from the page's (run id put in place) or the run does
      //     not stay open in running; (b) prints them.
      expect({
        last: bare(d.lines.at(-1)).split('<run>').join('b179423b-…'),
        result: d.result,
        phase: run.run_phase,
        terminal: run.terminal_state,
      }).toEqual({ last: `error: ${LINE}`, result: 'failed', phase: 'running', terminal: false });
    });
  });
});

describe(
  '#625 PR-2a, C174 lane C — realm-agent.md and realm-listen.md, from the built realm',
  { timeout: 60_000 },
  () => {
    let home: string;
    afterEach(() => {
      if (home !== undefined) rmSync(home, { recursive: true, force: true });
    });

    function fresh(): { runStore: JsonFileStore; workflowStore: JsonWorkflowStore } {
      home = mkdtempSync(join(tmpdir(), 'realm-625-pin-c-'));
      mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
      return {
        runStore: new JsonFileStore(join(home, '.realm', 'runs')),
        workflowStore: new JsonWorkflowStore(join(home, '.realm', 'workflows')),
      };
    }

    function realm(args: string[], env: Record<string, string> = {}) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: home,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1', ...env },
        encoding: 'utf8',
        timeout: 30_000,
      });
      const lines = (t: string) => t.split('\n').filter((l) => l !== '');
      return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
    }

    it('at a gate the drive waits until `realm run respond` from another terminal answers it, then runs the auto step the answer left owed (the answer settled the guard), then the next agent step', async () => {
      claim(
        AGENT_PAGE,
        'At a gate, `realm agent` waits until the gate is answered, by `realm run respond` from another terminal or by any other means, and then carries on: it runs the guards and `auto` steps the answer leaves owed (each `auto` step as `→ [auto] <step>`), then the next agent step.',
      );
      const { runStore, workflowStore } = fresh();
      const def = loadWorkflowFromString(
        [
          'id: c174-gate',
          'name: c174-gate',
          'version: 1',
          'steps:',
          '  confirm:',
          '    description: Confirm.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    gate:',
          '      choices: [approve, reject]',
          '  check:',
          '    description: Check.',
          '    execution: guard',
          '    depends_on: [confirm]',
          '    abort_unless: ["confirm.choice == \'approve\'"]',
          '  after:',
          '    description: After.',
          '    execution: auto',
          '    depends_on: [check]',
          '  finish:',
          '    description: Finish.',
          '    execution: agent',
          '    depends_on: [after]',
          '',
        ].join('\n'),
      );
      await workflowStore.register(def);
      const lines: string[] = [];
      let calls = 0;
      let callsAtAnswer = -1;
      let respond: { code: number | null; out: string[]; err: string[] } | undefined;
      const provider = new (class extends LlmProvider {
        async callStep(): Promise<Record<string, unknown>> {
          calls += 1;
          return { done: true };
        }
      })();
      let command: string[] | undefined;
      const runIdOf = (args: string[]) => args[2]!;
      let completedAtAnswer: string[] = [];
      for (const kind of ['log', 'error', 'warn'] as const) {
        vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
          const line = a.join(' ');
          lines.push(`${kind}: ${line}`);
          const m = /^ {3}Approve: realm (run respond .+)$/.exec(line);
          if (m !== null) command = m[1]!.split(' ');
          if (line.includes('Waiting for approval...') && command !== undefined) {
            const args = command;
            setTimeout(() => {
              callsAtAnswer = calls;
              respond = realm(args);
              lines.push('ANSWERED');
              void runStore.get(runIdOf(args)).then((r) => {
                completedAtAnswer = r.completed_steps;
              });
            }, 150);
          }
        });
      }
      let result: string;
      try {
        result = await runAgent(
          { store: runStore, workflowStore, provider, registry: createDefaultRegistry() },
          {
            definition: def,
            params: {},
            pollIntervalMs: 25,
            inFlightPollMs: 5,
            inFlightWatchMs: 20,
          },
        );
      } finally {
        vi.restoreAllMocks();
      }
      const at = (l: string) => lines.indexOf(l);
      // (a) red when the drive goes on before the answer, does not run the owed guard and auto step
      //     after it, or does not then run the agent step; (b) prints the respond reply and the screen.
      // On this store the answer's own write settles the guard (`realm run respond` says so); what
      // it leaves owed is the auto step, which the drive runs.
      expect(
        { code: respond?.code, out: respond?.out.slice(0, 1), completedAtAnswer },
        JSON.stringify(respond),
      ).toEqual({
        code: 0,
        out: ["Guard step 'check' passed."],
        completedAtAnswer: ['confirm', 'check'],
      });
      expect(
        respond?.out.filter((l) =>
          l.startsWith("Owed to the engine: 'after' — realm run advance "),
        ),
      ).toHaveLength(1);
      expect({ result, callsAtAnswer, calls }).toEqual({
        result: 'completed',
        callsAtAnswer: 0,
        calls: 1,
      });
      const order = [
        at('log:    Waiting for approval...'),
        at('ANSWERED'),
        at('log: → [auto] after'),
        at('log: \n→ [agent] finish'),
      ];
      expect(
        order.every((i) => i >= 0),
        lines.join('\n'),
      ).toBe(true);
      expect(order.slice().sort((a, b) => a - b)).toEqual(order);
      expect(lines.slice(order[0]! + 1, order[1]!).filter((l) => l.includes('→'))).toEqual([]);
      expect((await runStore.list())[0]!.completed_steps).toEqual([
        'confirm',
        'check',
        'after',
        'finish',
      ]);
    });

    it('`stops the drive with exit code 1`: the built realm agent on a blocked reply (a precondition failing on the engine’s own read)', async () => {
      claim(
        AGENT_PAGE,
        "any other `blocked` reply prints its own reason (`✗ Precondition failed for step 'ask'.`) and stops the drive with exit code 1.",
      );
      fresh();
      // While the model answers `ask`, the provider module rewrites `first`'s recorded answer, so the
      // engine's own read refuses the step the drive's read let it pick.
      symlinkSync(join(ROOT, 'node_modules'), join(home, 'node_modules'), 'dir');
      writeFileSync(join(home, 'package.json'), JSON.stringify({ type: 'module' }));
      writeFileSync(
        join(home, 'p.mjs'),
        [
          "import { LlmProvider } from '@sensigo/realm-cli/agent';",
          "import { JsonFileStore } from '@sensigo/realm';",
          "import { join } from 'node:path';",
          'let calls = 0;',
          'class Flip extends LlmProvider {',
          '  async callStep() {',
          '    calls += 1;',
          '    if (calls === 1) return { ok: true };',
          "    const store = new JsonFileStore(join(process.env.HOME, '.realm', 'runs'));",
          '    const [run] = await store.list();',
          '    const fresh = await store.get(run.id);',
          '    const evidence = fresh.evidence.map((e) =>',
          "      e.step_id === 'first' ? { ...e, output_summary: { ...e.output_summary, ok: false } } : e,",
          '    );',
          '    await store.update({ ...fresh, evidence });',
          '    return {};',
          '  }',
          '}',
          'export default new Flip();',
          '',
        ].join('\n'),
      );
      writeFileSync(
        join(home, 'workflow.yaml'),
        [
          'id: c174-flip',
          'name: c174-flip',
          'version: 1',
          'steps:',
          '  first:',
          '    description: First.',
          '    execution: agent',
          '  ask:',
          '    description: Ask.',
          '    execution: agent',
          '    depends_on: [first]',
          "    preconditions: ['first.ok == true']",
          '',
        ].join('\n'),
      );
      const r = realm(['agent', '--workflow', 'workflow.yaml', '--provider-module', './p.mjs']);
      // (a) red when the reply prints `✓`, another reason, or the command exits other than 1; (b)
      //     prints the exit, stdout and stderr.
      const askAt = r.out.indexOf('→ [agent] ask');
      expect(
        {
          code: r.code,
          last: r.err.at(-1),
          ticks: r.out.slice(askAt).filter((l) => l.includes('✓')),
        },
        JSON.stringify(r),
      ).toEqual({
        code: 1,
        last: "✗ Precondition failed for step 'ask'.",
        ticks: [],
      });
      expect(askAt).toBeGreaterThan(-1);
    });

    it('realm-listen.md: the sweeper’s line adds `owed` (and `realm run advance` runs them) or `cannot_go_on` (each step, then the way out) — the page’s screen, from the built realm listen', async () => {
      claim(
        LISTEN_PAGE,
        'When the gate it carried out leaves steps owed to the engine, the line adds `owed`: their names (`realm run advance <run-id>` runs them until a step opens a question, fails or ends the run).',
      );
      claim(
        LISTEN_PAGE,
        'When it leaves the run with nothing that can run from here, the line adds `cannot_go_on`: each step that cannot run, then the way out.',
      );
      const shown = block(LISTEN_PAGE, '"cannot_go_on"').filter((l) => l !== '');
      const { runStore, workflowStore } = fresh();
      const gated = (id: string, next: string[]) =>
        loadWorkflowFromString(
          [
            `id: ${id}`,
            `name: ${id}`,
            'version: 1',
            'steps:',
            '  review:',
            '    description: A person decides.',
            '    execution: auto',
            '    trust: human_confirmed',
            '    gate:',
            '      choices: [ship, hold]',
            '      timeout_seconds: 60',
            '      on_expiry: settle_default',
            '      default_choice: hold',
            ...next,
            '',
          ].join('\n'),
        );
      const owedDef = gated('c174-owed', [
        '  file:',
        '    description: File.',
        '    execution: auto',
        '    depends_on: [review]',
      ]);
      const stuckDef = gated('c174-stuck', [
        '  compute:',
        '    description: Compute.',
        '    execution: auto',
        '    depends_on: [review]',
        '    input_schema:',
        '      type: object',
        '      required: [n]',
      ]);
      const atExpiredQuestion = async (def: WorkflowDefinition) => {
        await workflowStore.register(def);
        const { run } = await runStore.create({
          workflowId: def.id,
          workflowVersion: 1,
          params: {},
        });
        await executeChain(runStore as RunStore, def, {
          runId: run.id,
          command: 'review',
          input: {},
          dispatcher: async () => ({}),
          registry: createDefaultRegistry(),
        });
        const open = await runStore.get(run.id);
        const gate = open.pending_gate as PendingGate;
        await runStore.update({
          ...open,
          pending_gate: { ...gate, expires_at: new Date(Date.now() - 5_000).toISOString() },
        });
        return { runId: run.id, gateId: gate.gate_id };
      };
      const owed = await atExpiredQuestion(owedDef);
      const stuck = await atExpiredQuestion(stuckDef);
      // The workflow listen mounts (a trigger); the sweeper reaches every run in the store.
      mkdirSync(join(home, 'mount'));
      writeFileSync(
        join(home, 'mount', 'workflow.yaml'),
        [
          'id: c174-mount',
          'name: c174-mount',
          'version: 1',
          'trigger:',
          '  type: webhook',
          '  path: /c174',
          '  auth:',
          '    mode: shared_secret',
          '    header: X-Webhook-Token',
          '    secret_from: WH_SECRET',
          'steps:',
          '  a:',
          '    description: A.',
          '    execution: agent',
          '',
        ].join('\n'),
      );
      const port = String(40_000 + Math.floor(Math.random() * 20_000));
      const swept = await new Promise<string[]>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            CLI,
            'listen',
            'mount',
            '--model',
            'claude-sonnet-5-5',
            '--port',
            port,
            '--sweep-expired-gates',
            '1',
          ],
          {
            cwd: home,
            env: {
              PATH: process.env['PATH'] ?? '',
              HOME: home,
              NO_COLOR: '1',
              WH_SECRET: 's3cret',
            },
          },
        );
        const out: string[] = [];
        let buf = '';
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`no sweep lines in time:\n${out.join('\n')}`));
        }, 20_000);
        const take = (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          const parts = buf.split('\n');
          buf = parts.pop() ?? '';
          out.push(...parts);
          const enacted = out.filter((l) =>
            l.startsWith('listen: sweeper enacted an expired gate '),
          );
          if (enacted.length >= 2) {
            clearTimeout(timer);
            child.kill('SIGTERM');
            resolve(enacted);
          }
        };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
      });
      const byRun = (id: string) => swept.find((l) => l.includes(`"run_id":"${id}"`))!;
      // (a) red when the owed line drops `owed` or names other steps, or the stuck line differs from
      //     the page's screen (ids put in place); (b) prints the line.
      expect(
        JSON.parse(byRun(owed.runId).slice('listen: sweeper enacted an expired gate '.length)),
      ).toEqual({
        run_id: owed.runId,
        gate_id: owed.gateId,
        disposition: 'settle_default',
        owed: ['file'],
      });
      expect([
        byRun(stuck.runId)
          .split(stuck.runId)
          .join('f17eb4b7-7295-4dac-a6a9-1ab52e301a60')
          .split(stuck.gateId)
          .join('2ba6c94a-0ba7-4ba9-9b0c-da687a5bc744'),
      ]).toEqual(shown);
      // `realm run advance <run-id>` runs the owed steps.
      const adv = realm(['run', 'advance', owed.runId]);
      const after = await runStore.get(owed.runId);
      // (a) red when advance does not run the owed step; (b) prints its exit, output and the record.
      expect(
        { code: adv.code, completed: after.completed_steps, phase: after.run_phase },
        JSON.stringify(adv),
      ).toEqual({
        code: 0,
        completed: ['review', 'file'],
        phase: 'completed',
      });
    });
  },
);
