// answer-not-recorded-625.test.ts — issue #625 PR-2a, round 23 (decisions C179, C182): `realm agent`
// and an agent step another process answered. The walk (c8, W1-1) found the drive asking its model
// while `realm workflow run` waited at the same step's prompt, and, when the typed answer reached the
// engine first, printing `✓ → completed` and the other answer as its `Result`. Now:
//  - a step another process holds (as `realm workflow run`'s prompt holds an agent step) is waited
//    for, said once (`• Step '<s>' is in flight, …: waiting up to <n>s …`), and no model is asked;
//  - an answer the engine did not record is said, never `✓`: the holder while it holds the step, the
//    program that ran it once it settled (the run's end included), the run's end without it;
//  - the `Result` line names the program that gave an answer this drive did not;
//  - the drive that stops on a step still held says so, and not that the run ended.
// Each order the walk's race can take has its cell; the page's sentences are quoted (C163's rule).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  abandonRun,
  createDefaultRegistry,
  executeChain,
  executeStep,
  submitHumanResponse,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type Attributed,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent, answerRecordedByCall } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AGENT_PAGE = 'docs/reference/cli/realm-agent.md';
const WORKFLOW_PAGE = 'docs/reference/cli/realm-workflow.md';

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  const text = readFileSync(join(ROOT, page), 'utf8').replace(/\s+/g, ' ');
  expect(text, `${page} no longer says: ${sentence}`).toContain(sentence.replace(/\s+/g, ' '));
}

const agent = (depends_on: string[] = []): StepDefinition =>
  ({ description: 'An agent step.', execution: 'agent', depends_on }) as StepDefinition;

function wf(steps: Record<string, StepDefinition>): WorkflowDefinition {
  return {
    id: 'c179-wf',
    name: 'c179',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  };
}

/** The program `realm workflow run` writes on the claim its prompt holds (C179). */
const PROMPT: Attributed = { by: 'person-at-t1', by_source: 'stated', channel: 'run' };
const PROMPT_WORDS = 'person-at-t1 (as stated, via run)';

interface Drive {
  result: string;
  lines: string[];
  calls: number;
  runId: string;
  store: InMemoryStore;
}

/**
 * One `realm agent` drive. `before` acts on the new run before the drive starts (the drive attaches
 * to it); `during` runs inside each model call; `watching` runs once while the drive watches a step
 * another process holds (after its waiting line).
 */
async function drive(
  def: WorkflowDefinition,
  o: {
    before?: (store: InMemoryStore, runId: string) => Promise<void>;
    during?: (store: InMemoryStore, runId: string, call: number) => Promise<void>;
    watching?: (store: InMemoryStore, runId: string) => Promise<void>;
    /** decision C189: runs once while the drive waits at a question (after `Waiting for approval...`). */
    atGate?: (store: InMemoryStore, runId: string) => Promise<void>;
    watchMs?: number;
  } = {},
): Promise<Drive> {
  const store = new InMemoryStore();
  const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  await o.before?.(store, run.id);
  let calls = 0;
  const provider = new (class extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      calls += 1;
      await o.during?.(store, run.id, calls);
      return { from: 'model' };
    }
  })();
  const lines: string[] = [];
  let watched = false;
  let gated = false;
  for (const kind of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
      const line = `${kind}: ${a.join(' ')}`;
      lines.push(line);
      if (!watched && o.watching !== undefined && line.includes(': waiting up to ')) {
        watched = true;
        void o.watching(store, run.id);
      }
      if (!gated && o.atGate !== undefined && line.includes('Waiting for approval...')) {
        gated = true;
        void o.atGate(store, run.id);
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
        registry: createDefaultRegistry(),
      },
      {
        definition: def,
        params: {},
        existingRunId: run.id,
        inFlightPollMs: 5,
        inFlightWatchMs: o.watchMs ?? 2_000,
        pollIntervalMs: 20,
      },
    );
  } finally {
    vi.restoreAllMocks();
  }
  return {
    result,
    lines: lines.map((l) =>
      l
        .split(run.id)
        .join('<run>')
        .replace(/ (at|since) \S+Z/g, ' $1 <t>'),
    ),
    calls,
    runId: run.id,
    store,
  };
}

/** Another process (the prompt's answer) completes `step`, naming the prompt's program. */
async function promptAnswers(
  store: InMemoryStore,
  def: WorkflowDefinition,
  runId: string,
  step: string,
): Promise<void> {
  const r = await executeStep(store, def, {
    runId,
    command: step,
    input: { from: 'person' },
    dispatcher: async () => ({ from: 'person' }),
    driver: PROMPT,
  });
  expect(r.status, JSON.stringify(r)).toBe('ok');
}

afterEach(() => {
  vi.restoreAllMocks();
});

const NOT_RECORDED_SENTENCE =
  "When another process's answer to an agent step reaches the engine before the drive's own, the drive never prints `✓` for it: the line says the drive's answer was not recorded — `• Step '<step>' was taken by <program> at <time>; this drive's answer was not recorded.` while the other process holds the step, `• Step '<step>' was taken by <program>, and completed; this drive's answer was not recorded.` (or `and failed`) once it ran the step, also when that ended the run, and `• Step '<step>' was not run: the run ended (<phase>) before this drive's answer reached it; the answer was not recorded.` when the run ended without it.";

describe(
  '#625 PR-2a, C179 — realm agent and an agent step another process answered',
  { timeout: 30_000 },
  () => {
    it('the walk’s order: the step is held at the prompt when the drive starts — no model call, the waiting line, then the run goes on; the Result names who gave it', async () => {
      claim(
        AGENT_PAGE,
        "While `realm workflow run` waits at an agent step's prompt, it holds that step: the drive waits for it and asks no model.",
      );
      claim(
        AGENT_PAGE,
        "When nothing else is ready and another process holds a step, the drive says so — `• Step '<step>' is in flight, taken by <program> since <time>: waiting up to 60s for the run's record to change.` — and goes on when the record changes;",
      );
      claim(
        AGENT_PAGE,
        'When the run completes, its `Result` line names the program that gave an answer this drive did not: `Result (<step>) — given by <program>, not by this drive:`.',
      );
      const def = wf({ write: agent() });
      const d = await drive(def, {
        before: async (store, runId) => {
          await store.claimStep(runId, 'write', def, PROMPT);
        },
        watching: async (store, runId) => {
          // The person answers at the prompt: the prompt lets its claim go, the engine takes it.
          const held = await store.get(runId);
          await store.settleStep!(
            runId,
            { kind: 'release_step', step: 'write', claimToken: held.claims!['write']!.token! },
            def,
          );
          await promptAnswers(store, def, runId, 'write');
        },
      });
      // (a) red when the drive asks its model for a step the prompt holds, says nothing while it waits,
      //     prints `✓`, or shows the person's answer as its own `Result`; (b) prints the screen.
      expect({ calls: d.calls, result: d.result, lines: d.lines.slice(2) }).toEqual({
        calls: 0,
        result: 'completed',
        lines: [
          `log: • Step 'write' is in flight, taken by ${PROMPT_WORDS} since <t>: waiting up to 2s for the run's record to change.`,
          'log: \nRun complete: <run>',
          `log: \nResult (write) — given by ${PROMPT_WORDS}, not by this drive:`,
          'log: {\n  "from": "person"\n}',
        ],
      });
    });

    it('the model call began first and the person’s answer reached the engine first (the run then ended): taken, and completed; not recorded — never ✓', async () => {
      claim(AGENT_PAGE, NOT_RECORDED_SENTENCE);
      const def = wf({ write: agent() });
      const d = await drive(def, {
        during: async (store, runId, call) => {
          if (call === 1) await promptAnswers(store, def, runId, 'write');
        },
      });
      const at = d.lines.indexOf('log: \n→ [agent] write');
      // (a) red when the drive prints `✓ → completed` for the person's answer, or the line names no
      //     program; (b) prints the lines after the attempt.
      expect({ result: d.result, after: d.lines.slice(at + 2) }).toEqual({
        result: 'completed',
        after: [
          `log: • Step 'write' was taken by ${PROMPT_WORDS}, and completed; this drive's answer was not recorded.`,
          'log: \nRun complete: <run>',
          `log: \nResult (write) — given by ${PROMPT_WORDS}, not by this drive:`,
          'log: {\n  "from": "person"\n}',
        ],
      });
      expect(d.lines.filter((l) => l.includes('✓'))).toEqual([]);
    });

    it('the model call began first and the person’s answer reached the engine first (the run goes on): the same line, then the next step', async () => {
      claim(AGENT_PAGE, NOT_RECORDED_SENTENCE);
      const def = wf({ write: agent(), more: agent(['write']) });
      const d = await drive(def, {
        during: async (store, runId, call) => {
          if (call === 1) await promptAnswers(store, def, runId, 'write');
        },
      });
      const at = d.lines.indexOf('log: \n→ [agent] write');
      // (a) red when the not-eligible reply of a step the person ran prints `✓` or `not run here`
      //     without saying the answer was not recorded; (b) prints the two lines after the attempt.
      expect(d.lines.slice(at + 2, at + 4)).toEqual([
        `log: • Step 'write' was taken by ${PROMPT_WORDS}, and completed; this drive's answer was not recorded.`,
        'log: \n→ [agent] more',
      ]);
      // The drive's own answer for `more` is its own: no provenance on its Result.
      expect(d.lines.filter((l) => l.startsWith('log: \nResult ('))).toEqual([
        'log: \nResult (more):',
      ]);
    });

    it('the model’s answer came back while the prompt held the step: taken (with the time); not recorded; then the waiting line', async () => {
      claim(AGENT_PAGE, NOT_RECORDED_SENTENCE);
      const def = wf({ write: agent() });
      const d = await drive(def, {
        during: async (store, runId, call) => {
          if (call === 1) await store.claimStep(runId, 'write', def, PROMPT);
        },
        watching: async (store, runId) => {
          const held = await store.get(runId);
          await store.settleStep!(
            runId,
            { kind: 'release_step', step: 'write', claimToken: held.claims!['write']!.token! },
            def,
          );
          await promptAnswers(store, def, runId, 'write');
        },
      });
      const at = d.lines.indexOf('log: \n→ [agent] write');
      // (a) red when the refused answer prints `✓`, or the drive does not wait for the holder; (b)
      //     prints the lines after the attempt.
      expect({ result: d.result, after: d.lines.slice(at + 2, at + 4) }).toEqual({
        result: 'completed',
        after: [
          `log: • Step 'write' was taken by ${PROMPT_WORDS} at <t>; this drive's answer was not recorded.`,
          `log: • Step 'write' is in flight, taken by ${PROMPT_WORDS} since <t>: waiting up to 2s for the run's record to change.`,
        ],
      });
    });

    it('the run ended without the step while the model answered: not run, the run ended; not recorded — never ✓', async () => {
      claim(AGENT_PAGE, NOT_RECORDED_SENTENCE);
      const def = wf({ write: agent() });
      const d = await drive(def, {
        during: async (store, runId, call) => {
          if (call === 1) await abandonRun(store, runId, 'ended elsewhere');
        },
      });
      const at = d.lines.indexOf('log: \n→ [agent] write');
      // (a) red when the drive prints `✓` or nothing for its dropped answer; (b) prints the lines.
      expect({ result: d.result, after: d.lines.slice(at + 2) }).toEqual({
        result: 'failed',
        after: [
          "log: • Step 'write' was not run: the run ended (abandoned) before this drive's answer reached it; the answer was not recorded.",
          'error: \nRun ended in phase: abandoned',
        ],
      });
    });

    it('a step still held when the watch ends: the in-flight line, the drive stops (failed) — and no `Run ended in phase` line: the run did not end', async () => {
      claim(
        AGENT_PAGE,
        "after 60 seconds with no change it prints `• Step '<step>' has been in flight since <time>, taken by <program>; the record has not changed for 60s. If the program that took it is gone: realm run reclaim <run> --step <step> --force` and stops with exit code 1, the run still open.",
      );
      claim(
        AGENT_PAGE,
        'which the drive prints instead when it ends with neither line and the run not completed (for example, a guard aborted it) — except when it stops on a step another process holds, whose in-flight line (above) is the last.',
      );
      const def = wf({ write: agent() });
      const d = await drive(def, {
        before: async (store, runId) => {
          await store.claimStep(runId, 'write', def, PROMPT);
        },
        watchMs: 50,
      });
      // (a) red when the drive asks the model, or says the run ended; (b) prints the screen.
      expect({ calls: d.calls, result: d.result, lines: d.lines.slice(2) }).toEqual({
        calls: 0,
        result: 'failed',
        lines: [
          `log: • Step 'write' is in flight, taken by ${PROMPT_WORDS} since <t>: waiting up to 0s for the run's record to change.`,
          `log: • Step 'write' has been in flight since <t>, taken by ${PROMPT_WORDS}; the record has not changed for 0s. If the program that took it is gone: realm run reclaim <run> --step write --force`,
        ],
      });
      expect((await d.store.get(d.runId)).run_phase).toBe('running');
    });
  },
);

/** decision C189: a step that asks a person (`trust: human_confirmed`, choices send/discard). */
const asks = (step: StepDefinition): StepDefinition =>
  ({
    ...step,
    trust: 'human_confirmed',
    gate: { choices: ['send', 'discard'] },
  }) as StepDefinition;
const auto = (depends_on: string[]): StepDefinition =>
  ({ description: 'An auto step.', execution: 'auto', depends_on }) as StepDefinition;

/** Another process (`realm run respond`) answers the open question with `send`. */
async function answerElsewhere(
  store: InMemoryStore,
  def: WorkflowDefinition,
  runId: string,
): Promise<void> {
  const open = (await store.get(runId)).pending_gate!;
  const r = await submitHumanResponse(store, def, {
    runId,
    gateId: open.gate_id,
    choice: 'send',
    caller: 'respond',
  });
  expect(r.status, JSON.stringify(r)).toBe('ok');
}

describe(
  '#625 PR-2a, C189 — the answers this drive gave are read off its own engine calls, on every reply branch',
  { timeout: 30_000 },
  () => {
    it('the question on the agent step itself, answered from another process: `Result (<step>):` with no suffix — realm-agent.md’s example holds', async () => {
      // The page's example: the gate on `classify`, then `file`, then the drive's own Result.
      claim(
        AGENT_PAGE,
        'Waiting for approval... → [auto] file ✓ → completed Run complete: 50e31961-baec-4e4e-ae6a-ef0af3754761 Result (classify): {',
      );
      const def = wf({ classify: asks(agent()), file: auto(['classify']) });
      const d = await drive(def, { atGate: (store, runId) => answerElsewhere(store, def, runId) });
      const at = d.lines.findIndex((l) => l.includes('Waiting for approval...'));
      // (a) red when the drive says its own answer was given by another program (the `✓` branch was
      //     the only one that counted), or the run does not go on; (b) prints the lines after the wait.
      expect({ calls: d.calls, result: d.result, after: d.lines.slice(at) }).toEqual({
        calls: 1,
        result: 'completed',
        after: [
          'log:    Waiting for approval...',
          'log: → [auto] file',
          'log:   ✓ → completed',
          'log: \nRun complete: <run>',
          'log: \nResult (classify):',
          'log: {\n  "from": "model"\n}',
        ],
      });
    });

    it('the question on the next step, answered from another process: `Result (<step>):` with no suffix', async () => {
      const def = wf({ draft: agent(), review: asks(auto(['draft'])), send: auto(['review']) });
      const d = await drive(def, { atGate: (store, runId) => answerElsewhere(store, def, runId) });
      // (a) red when the answer whose reply opened the next step's question is counted as another
      //     program's; (b) prints the Result line.
      expect({
        calls: d.calls,
        result: d.result,
        results: d.lines.filter((l) => l.startsWith('log: \nResult (')),
      }).toEqual({ calls: 1, result: 'completed', results: ['log: \nResult (draft):'] });
    });

    it('both drivers at one question (the walk’s late extra): the other program gave the answer, so the suffix stays', async () => {
      const def = wf({ draft: agent(), review: asks(auto(['draft'])), send: auto(['review']) });
      const d = await drive(def, {
        // `realm workflow run`'s prompt answered `draft`; its chain opened `review`'s question.
        before: async (store, runId) => {
          const r = await executeChain(store, def, {
            runId,
            command: 'draft',
            input: { from: 'person' },
            dispatcher: async () => ({ from: 'person' }),
            driver: PROMPT,
          });
          expect(r.status, JSON.stringify(r)).toBe('confirm_required');
        },
        atGate: (store, runId) => answerElsewhere(store, def, runId),
      });
      // (a) red when the drive takes the other program's answer for its own; (b) prints the Result.
      expect({
        calls: d.calls,
        result: d.result,
        results: d.lines.filter((l) => l.startsWith('log: \nResult (')),
      }).toEqual({
        calls: 0,
        result: 'completed',
        results: [`log: \nResult (draft) — given by ${PROMPT_WORDS}, not by this drive:`],
      });
    });

    it('no question (control): the `✓` branch — `Result (<step>):` with no suffix', async () => {
      const def = wf({ draft: agent(), send: auto(['draft']) });
      const d = await drive(def);
      // (a) red when the plain `✓` branch stops counting the drive's own answer; (b) prints it.
      expect({
        calls: d.calls,
        result: d.result,
        results: d.lines.filter((l) => l.startsWith('log: \nResult (')),
      }).toEqual({ calls: 1, result: 'completed', results: ['log: \nResult (draft):'] });
    });

    it('answerRecordedByCall, each conjunct on its own reply: a later step’s reply; the question on the step itself (with and without the answer’s evidence); an ok reply (with and without evidence); a refusal of the step itself', () => {
      const e = [{ step_id: 'x' }] as never[];
      // (a) red when one reply branch is read wrongly — each row is one conjunct of the predicate
      //     on its own; (b) prints every row's verdict.
      expect(
        [
          // a step the engine ran after it stopped the call: `x` settled first
          { status: 'confirm_required', evidence: [], stopped_step: 'y' },
          { status: 'blocked', evidence: [], stopped_step: 'y' },
          { status: 'error', evidence: [], stopped_step: 'y' },
          // the question the answer opened on `x`, its evidence written; another call's open question
          { status: 'confirm_required', evidence: e, stopped_step: 'x' },
          { status: 'confirm_required', evidence: [], stopped_step: 'x' },
          // an ok reply: the call settled `x`; the run had ended or `x` was already settled
          { status: 'ok', evidence: e },
          { status: 'ok', evidence: [] },
          // a refusal or failure of `x` itself; an error of the chain that names no step
          { status: 'blocked', evidence: [], stopped_step: 'x' },
          { status: 'error', evidence: e, stopped_step: 'x' },
          { status: 'error', evidence: [] },
        ].map((reply) => answerRecordedByCall(reply as never, 'x')),
      ).toEqual([true, true, true, true, false, true, false, false, false, false]);
    });
  },
);

describe(
  '#625 PR-2a, C190 — realm agent holds nothing while its model works',
  { timeout: 30_000 },
  () => {
    it('a prompt opened during the model call takes the step: the answer is not recorded, the drive waits, and when the prompt lets the step go unanswered the model is asked again', async () => {
      claim(
        AGENT_PAGE,
        "The drive itself holds nothing while its model works on a step: a `realm workflow run` prompt opened during the model call takes the step, the model's answer is not recorded (`• Step '<step>' was taken by <program> at <time>; this drive's answer was not recorded.`), and the drive then waits for the step as for any step another process holds — when the prompt lets it go unanswered, the model is asked for it again.",
      );
      claim(
        WORKFLOW_PAGE,
        "`realm agent` holds nothing while its model works on a step, so a prompt opened during that call takes the step with no word of the call: the model's answer is then not recorded, and if you leave the prompt while that drive still waits for the step, its model is asked again.",
      );
      const def = wf({ write: agent() });
      const during: Array<{ claimed: boolean; inFlight: boolean }> = [];
      const d = await drive(def, {
        during: async (store, runId, call) => {
          // What the record shows while the model works: nothing — no claim, no step in flight.
          const r = await store.get(runId);
          during.push({
            claimed: r.claims?.['write'] !== undefined,
            inFlight: r.in_progress_steps.includes('write'),
          });
          // The prompt opens during the first call and takes the step.
          if (call === 1) await store.claimStep(runId, 'write', def, PROMPT);
        },
        watching: async (store, runId) => {
          // The prompt is left (Ctrl+D): it lets its claim go, unanswered.
          const held = await store.get(runId);
          await store.settleStep!(
            runId,
            { kind: 'release_step', step: 'write', claimToken: held.claims!['write']!.token! },
            def,
          );
        },
      });
      // (a) red when the drive holds the step during its model call, prints `✓` for the dropped answer,
      //     does not wait, or does not ask again once the prompt lets the step go; (b) prints the screen.
      expect({ during, calls: d.calls, result: d.result, lines: d.lines.slice(2) }).toEqual({
        during: [
          { claimed: false, inFlight: false },
          { claimed: false, inFlight: false },
        ],
        calls: 2,
        result: 'completed',
        lines: [
          'log: \n→ [agent] write',
          'log:   An agent step.',
          `log: • Step 'write' was taken by ${PROMPT_WORDS} at <t>; this drive's answer was not recorded.`,
          `log: • Step 'write' is in flight, taken by ${PROMPT_WORDS} since <t>: waiting up to 2s for the run's record to change.`,
          'log: \n→ [agent] write',
          'log:   An agent step.',
          'log:   ✓ → completed',
          'log: \nRun complete: <run>',
          'log: \nResult (write):',
          'log: {\n  "from": "model"\n}',
        ],
      });
    });
  },
);
