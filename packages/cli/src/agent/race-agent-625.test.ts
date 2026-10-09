// race-agent-625.test.ts — issue #625 PR-2a, the last prompt's F7 on `realm agent` (review G7-07,
// G7-12, A3-7): the drive reads core's classifier — no code list of its own. On its own agent step's
// call, a refused settle (rows 3–6) is said with C179's not-recorded line in the classifier's kind,
// and the drive goes on; a claim refused because the run ended, a question opened or the step stopped
// being eligible (rows 7–9) prints no `✗` — its own end and question checks speak; a precondition
// block (row 2d) still stops it. An engine step its chain ran meets the race inside core's loop, which
// goes on: the drive prints `realm run advance`'s line, never `✗ … failed`. The way out for a step
// that cannot run is said only of a run that is still open (G7-12).
//
// Round 24's cells (`answer-not-recorded-625.test.ts`: another process settled the step, or took it
// over) are the preservation cells for rows 3 and 4 on the agent step and stay unchanged.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  ExtensionRegistry,
  WorkflowError,
  abandonRun,
  advanceRun,
  executeStep,
  reclaimStep,
  submitHumanResponse,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type Attributed,
  type RunRecord,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AGENT_PAGE = 'docs/reference/cli/realm-agent.md';
const OTHER: Attributed = { by: 'other-prog', by_source: 'stated', channel: 'test' };
const OTHER_WORDS = 'other-prog (as stated, via test)';

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  const text = readFileSync(join(ROOT, page), 'utf8').replace(/\s+/g, ' ');
  expect(text, `${page} no longer says: ${sentence}`).toContain(sentence.replace(/\s+/g, ' '));
}

function wf(id: string, steps: Record<string, StepDefinition>): WorkflowDefinition {
  return { id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps };
}
const agent = (over: Partial<StepDefinition> = {}): StepDefinition =>
  ({
    description: 'An agent step.',
    execution: 'agent',
    depends_on: [],
    ...over,
  }) as StepDefinition;
const notEligible = (step: string) =>
  new WorkflowError(`Step '${step}' is not eligible for execution.`, {
    code: 'STATE_STEP_NOT_ELIGIBLE',
    category: 'STATE',
    agentAction: 'resolve_precondition',
    retryable: false,
  });

interface Hooks {
  /** Runs once, before the drive's own settle of `step` reaches the store. */
  settle?: { step: string; act: (store: InMemoryStore, runId: string) => Promise<void> };
  /** Runs once, at the first claim of `step` (`throw` makes the claim throw what it returns). */
  claim?: {
    step: string;
    act: (store: InMemoryStore, runId: string) => Promise<void | WorkflowError>;
  };
  /** Runs once, at the first store read after the drive prints a line that includes `marker`. */
  afterLine?: { marker: string; act: (store: InMemoryStore, runId: string) => Promise<void> };
  /** Runs once, inside the engine's handler `h` (an engine step's work), the first time it runs. */
  inHandler?: (store: InMemoryStore, runId: string) => Promise<void>;
  /** Another writer rewrites the record while the model answers the second step (a precondition the engine's read then refuses). */
  tamperAfterAnswer?: (record: RunRecord) => RunRecord;
  /** Runs once while the drive waits at a question. */
  atGate?: (store: InMemoryStore, runId: string) => Promise<void>;
  /** The run's params. */
  params?: Record<string, unknown>;
}

/** One `realm agent` drive on a fresh run of `def`, with the hooks' acts of another program. */
async function drive(def: WorkflowDefinition, h: Hooks = {}) {
  const store = new InMemoryStore();
  const { run } = await store.create({
    workflowId: def.id,
    workflowVersion: 1,
    params: h.params ?? {},
  });
  let calls = 0;
  const provider = new (class extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      calls += 1;
      // Another writer changes the record while the model answers the second step.
      if (h.tamperAfterAnswer !== undefined && calls === 2) {
        await store.update(h.tamperAfterAnswer(await realGet(run.id)));
      }
      return { go: true };
    }
  })();
  let armed = false;
  let fired = false;
  const once = async (act: () => Promise<unknown>) => {
    if (fired) return undefined;
    fired = true;
    return act();
  };
  const realGet = store.get.bind(store);
  store.get = async (id: string) => {
    if (armed && h.afterLine !== undefined) {
      armed = false;
      await once(() => h.afterLine!.act(store, id));
    }
    return realGet(id);
  };
  if (h.settle !== undefined) {
    const original = store.settleStep!.bind(store);
    store.settleStep = async (id, delta, d2, o) => {
      if (delta.kind === 'settle_step' && delta.step === h.settle!.step) {
        await once(() => h.settle!.act(store, id));
      }
      return original(id, delta, d2, o);
    };
  }
  if (h.claim !== undefined) {
    const original = store.claimStep.bind(store);
    store.claimStep = async (id, step, d, by) => {
      if (step === h.claim!.step && !fired) {
        const thrown = await once(() => h.claim!.act(store, id));
        if (thrown instanceof WorkflowError) throw thrown;
      }
      return original(id, step, d, by);
    };
  }
  let handlerRuns = 0;
  const registry = new ExtensionRegistry();
  registry.register('handler', 'h', {
    id: 'h',
    execute: async () => {
      handlerRuns += 1;
      if (handlerRuns === 1 && h.inHandler !== undefined)
        await once(() => h.inHandler!(store, run.id));
      return { data: { by: 'here' } };
    },
  });
  const lines: string[] = [];
  let gated = false;
  for (const kind of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
      const line = `${kind}: ${a.join(' ')}`;
      lines.push(line);
      if (h.afterLine !== undefined && !fired && line.includes(h.afterLine.marker)) armed = true;
      if (!gated && h.atGate !== undefined && line.includes('Waiting for approval...')) {
        gated = true;
        void h.atGate(store, run.id);
      }
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
        registry,
      },
      {
        definition: def,
        params: h.params ?? {},
        existingRunId: run.id,
        inFlightPollMs: 5,
        inFlightWatchMs: 300,
        pollIntervalMs: 20,
      },
    );
  } finally {
    vi.restoreAllMocks();
  }
  const after = await realGet(run.id);
  return {
    result,
    fired,
    calls,
    handlerRuns,
    after,
    lines: lines.map((l) =>
      l
        .split(run.id)
        .join('<run>')
        .replace(/ (at|since) \S+Z/g, ' $1 <t>'),
    ),
  };
}

/** The drive's lines from its first step line on, without the run's header. */
afterEach(() => {
  vi.restoreAllMocks();
});

describe(
  '#625 PR-2a, F7 — realm agent on its own agent step reads core’s classifier',
  { timeout: 30_000 },
  () => {
    const WRITE = wf('race-agent-write', { write: agent() });

    it('row 5: another process ends the run after the drive’s claim, before its settle (STATE_RUN_TERMINAL) — the run-ended line, never `✗ … failed`', async () => {
      claim(
        AGENT_PAGE,
        "`• Step '<step>' was not run: the run ended (<phase>) before this drive's answer reached it; the answer was not recorded.` when the run ended without it.",
      );
      const d = await drive(WRITE, {
        settle: {
          step: 'write',
          act: (store, id) => abandonRun(store, id, 'another program').then(() => undefined),
        },
      });
      // (a) red when the refused settle prints `✗ Step 'write' failed: Run … is terminal …`;
      //     (b) prints the lines and the drive's result.
      expect({
        fired: d.fired,
        calls: d.calls,
        ended: d.lines.filter((l) => l.includes('the run ended (abandoned) before')),
        failed: d.lines.filter((l) => l.includes('✗')),
        end: d.lines.filter((l) => l.includes('Run ended in phase')),
      }).toEqual({
        fired: true,
        calls: 1,
        ended: [
          "log: • Step 'write' was not run: the run ended (abandoned) before this drive's answer reached it; the answer was not recorded.",
        ],
        failed: [],
        end: ['error: \nRun ended in phase: abandoned'],
      });
    });

    it('row 6: another process removes the drive’s claim and nobody runs the step (STATE_CLAIM_LOST) — the claim-removed line; the model is asked again', async () => {
      claim(
        AGENT_PAGE,
        "The line is `• Step '<step>': another process removed the claim this drive held on it; this drive's answer was not recorded.` when another process removed the drive's claim and no one ran the step (the model is then asked for it again).",
      );
      const d = await drive(WRITE, {
        settle: {
          step: 'write',
          act: async (store, id) => {
            await reclaimStep(store, id, 'write');
          },
        },
      });
      // (a) red when the refused settle prints `✗ Step 'write' failed: … the claim was lost …` and
      //     stops the drive; (b) prints the lines.
      expect({
        fired: d.fired,
        calls: d.calls,
        result: d.result,
        removed: d.lines.filter((l) => l.includes('removed the claim')),
        failed: d.lines.filter((l) => l.includes('✗')),
      }).toEqual({
        fired: true,
        calls: 2,
        result: 'completed',
        removed: [
          "log: • Step 'write': another process removed the claim this drive held on it; this drive's answer was not recorded.",
        ],
        failed: [],
      });
    });

    it('row 7: another process ends the run at the drive’s claim (STATE_STEP_NOT_ELIGIBLE) — the run-ended line, no `✗`', async () => {
      const d = await drive(WRITE, {
        claim: {
          step: 'write',
          act: (store, id) => abandonRun(store, id, 'another program').then(() => undefined),
        },
      });
      // (a) red when the claim's refusal prints `✗ Step 'write' failed: … not eligible …`; (b) prints
      //     the lines.
      expect({
        fired: d.fired,
        ended: d.lines.filter((l) => l.includes('the run ended (abandoned) before')),
        failed: d.lines.filter((l) => l.includes('✗')),
        end: d.lines.filter((l) => l.includes('Run ended in phase')),
      }).toEqual({
        fired: true,
        ended: [
          "log: • Step 'write' was not run: the run ended (abandoned) before this drive's answer reached it; the answer was not recorded.",
        ],
        failed: [],
        end: ['error: \nRun ended in phase: abandoned'],
      });
    });

    it('row 8: another process opens a question at the drive’s claim — no `✗`; the drive waits at the question, then asks again', async () => {
      const def = wf('race-agent-q', {
        write: agent(),
        ask: agent({
          trust: 'human_confirmed',
          gate: { choices: ['ok', 'no'] },
        } as Partial<StepDefinition>),
      });
      const d = await drive(def, {
        claim: {
          step: 'write',
          act: async (store, id) => {
            const r = await executeStep(store, def, {
              runId: id,
              command: 'ask',
              input: { go: true },
              dispatcher: async (_n, input) => ({ ...input }),
              driver: OTHER,
            });
            expect(r.status, 'fixture: the other process opened the question').toBe(
              'confirm_required',
            );
          },
        },
        atGate: async (store, id) => {
          const gate = (await store.get(id)).pending_gate!;
          await submitHumanResponse(store, def, { runId: id, gateId: gate.gate_id, choice: 'ok' });
        },
      });
      // (a) red when the claim's refusal prints `✗ Step 'write' failed: …` and stops the drive;
      //     (b) prints the result, the model calls and any `✗` line.
      expect({
        fired: d.fired,
        result: d.result,
        calls: d.calls,
        failed: d.lines.filter((l) => l.includes('✗')),
        gate: d.lines.some((l) => l.includes('⏸  Gate: ask')),
      }).toEqual({ fired: true, result: 'completed', calls: 2, failed: [], gate: true });
    });

    it('row 9: the claim’s re-check refuses with nothing on the record to say why — no `✗`; the drive goes on and asks again', async () => {
      const d = await drive(WRITE, {
        claim: { step: 'write', act: async () => notEligible('write') },
      });
      // (a) red when the refusal prints `✗ Step 'write' failed: …` and stops the drive; (b) prints
      //     the result, the calls and any `✗` line.
      expect({
        fired: d.fired,
        result: d.result,
        calls: d.calls,
        failed: d.lines.filter((l) => l.includes('✗')),
      }).toEqual({ fired: true, result: 'completed', calls: 2, failed: [] });
    });

    it('row 2d: a precondition the engine’s own read refuses (preservation) — the reply’s reason, and the drive stops', async () => {
      const def = wf('race-agent-pre', {
        p: agent(),
        write: agent({ depends_on: ['p'], preconditions: ['p.go == true'] }),
      });
      let answered = 0;
      const d = await drive(def, {
        // the engine's read for `write`'s answer (the second model answer) sees `p` answered otherwise
        tamperAfterAnswer: (record) => {
          answered += 1;
          return {
            ...record,
            evidence: record.evidence.map((e) =>
              e.step_id === 'p' ? { ...e, output_summary: { go: false } } : e,
            ),
          };
        },
      });
      void answered;
      // (a) red when the precondition block is read as a race (the drive goes on) or loses its `✗`
      //     line; (b) prints the result and the `✗` lines.
      expect({
        result: d.result,
        failed: d.lines
          .filter((l) => l.includes('✗'))
          .map((l) => l.replace(/\. Resolved value: .*/, '.')),
      }).toEqual({
        result: 'failed',
        failed: [expect.stringContaining('✗ Precondition failed for step')],
      });
    });
  },
);

describe(
  '#625 PR-2a, F7 — realm agent on an engine step its chain ran: core’s loop goes on past the race',
  { timeout: 30_000 },
  () => {
    const ENGINE = wf('race-agent-engine', {
      s: { description: 'S.', execution: 'auto', handler: 'h', depends_on: [] } as StepDefinition,
      u: { description: 'U.', execution: 'auto', depends_on: ['s'] } as StepDefinition,
    });

    it.each([
      [
        '3: takes it over (reclaim --force, then holds it)',
        async (store: InMemoryStore, id: string) => {
          await reclaimStep(store, id, 's');
          await store.claimStep(id, 's', ENGINE, OTHER);
        },
        `log: • Step 's' was taken by ${OTHER_WORDS} at <t>; this program's outcome for it was not recorded.`,
      ],
      [
        '4: runs it (reclaim --force, then runs it and the rest)',
        async (store: InMemoryStore, id: string) => {
          await reclaimStep(store, id, 's');
          const other = new ExtensionRegistry();
          other.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) });
          await advanceRun(store, ENGINE, { runId: id, registry: other, driver: OTHER });
        },
        `log: • Step 's' was taken by ${OTHER_WORDS}, and completed; this program's outcome for it was not recorded.`,
      ],
      [
        '5: ends the run',
        async (store: InMemoryStore, id: string) => {
          await abandonRun(store, id, 'another program');
        },
        "log: • Step 's': the run ended (abandoned) before this program's outcome for it was recorded.",
      ],
      [
        '6: removes its claim (reclaim --force), nobody runs it',
        async (store: InMemoryStore, id: string) => {
          await reclaimStep(store, id, 's');
        },
        "log: • Step 's': another process removed the claim this program held on it; this program's outcome for it was not recorded.",
      ],
    ] as const)(
      'row %s — realm run advance’s line, never `✗ … failed`, and the drive goes on',
      async (_row, inHandler, line) => {
        claim(
          AGENT_PAGE,
          "An `auto` step the drive runs gets the line `realm run advance` prints when another process settles it, takes it over, removes its claim or ends the run while its handler runs — `• Step '<step>' was taken by <program>, and completed; this program's outcome for it was not recorded.`, for one — and the drive goes on with what is left; never `✗ Step '<step>' failed`.",
        );
        const d = await drive(ENGINE, { inHandler });
        const at = d.lines.indexOf('log: → [auto] s');
        // (a) red when the refused settle prints `✗ Step 's' failed: …` (the drive stopped), or the
        //     line is another kind's; (b) prints the lines after the step's start.
        expect({
          fired: d.fired,
          line: d.lines[at + 1],
          failed: d.lines.filter((l) => l.includes('✗')),
        }).toEqual({ fired: true, line, failed: [] });
      },
    );

    it('row 2b (G7-04’s r2 abandon): another process ends the run before the step’s own read — never the taken line (preservation)', async () => {
      const d = await drive(ENGINE, {
        afterLine: {
          marker: '→ [auto] s',
          act: (store, id) => abandonRun(store, id, 'another program').then(() => undefined),
        },
      });
      // (a) red when the race is said as taken, or as `✗ … failed`; (b) prints the lines.
      expect({
        fired: d.fired,
        taken: d.lines.filter((l) => l.includes('was taken by')),
        failed: d.lines.filter((l) => l.includes('✗')),
        end: d.lines.filter((l) => l.includes('Run ended in phase')),
      }).toEqual({
        fired: true,
        taken: [],
        failed: [],
        end: ['error: \nRun ended in phase: abandoned'],
      });
    });

    it('G7-12 (r6): another process ends the run between the drive’s view and its call for a step that cannot run — never “stays open”', async () => {
      const def = wf('race-agent-g712', {
        p: agent(),
        s: {
          description: 'S.',
          execution: 'auto',
          depends_on: ['p'],
          preconditions: ['p.go == false'],
        } as StepDefinition,
      });
      claim(
        AGENT_PAGE,
        'The two `✗ The drive stops` lines are printed only for a run that is still open: when another process ends the run in the moment the drive reads that refusal, the drive prints `Run ended in phase: <phase>` instead.',
      );
      const d = await drive(def, {
        afterLine: {
          marker: "• Step 's' cannot run (precondition)",
          act: (store, id) => abandonRun(store, id, 'another program').then(() => undefined),
        },
      });
      // (a) red when the drive says the ended run "stays open" with a way out whose commands do
      //     nothing; (b) prints the `✗` lines and the end line.
      expect({
        fired: d.fired,
        stays: d.lines.filter((l) => l.includes('stays open')),
        end: d.lines.filter((l) => l.includes('Run ended in phase')),
      }).toEqual({ fired: true, stays: [], end: ['error: \nRun ended in phase: abandoned'] });
    });
  },
);
