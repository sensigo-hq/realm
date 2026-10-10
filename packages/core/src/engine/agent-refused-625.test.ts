// agent-refused-625.test.ts — issue #625 PR-2a, decision C82: the agent member of C13's class. The
// run's view judges an eligible AGENT step by `checkPreClaim`'s members that read no input (trust,
// precondition — never the input schema: an agent step's input is the agent's own answer). A refused
// agent step leaves `agent_steps` / `agent_actions` and is listed in `agent_refused`; ONE accessor,
// `stepsThatCannotRun`, returns every step that cannot run (agent and engine, definition order), and
// every consumer reads it — so no surface says "Ready for the agent" of a step the engine refuses,
// and no driver picks it.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
// Whole-message pins (the per-member rule).
import { describe, it, expect } from 'vitest';
import { mkdtemp as mkdtempP, rm as rmP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { buildNextActions, executeChain, executeStep } from './execution-loop.js';
import {
  AGENT_PRE_CLAIM_REFUSALS,
  cannotGoOnHere,
  cannotGoOnLines,
  cannotRunWayOut,
  cannotRunWayOutApplies,
  cannotRunWayOutTools,
  describeNext,
  describePending,
  stepsThatCannotRun,
} from './pending.js';
import type { StepDispatcher } from './execution-loop.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';

const echo: StepDispatcher = async (_name, input) => ({ ...input });

async function withStore<T>(fn: (store: JsonFileStore) => Promise<T>): Promise<T> {
  const dir = await mkdtempP(join(tmpdir(), 'realm-agent-refused-625-'));
  try {
    return await fn(new JsonFileStore(dir));
  } finally {
    await rmP(dir, { recursive: true, force: true });
  }
}

function def(steps: Record<string, StepDefinition>): WorkflowDefinition {
  return { id: 'agent-refused-wf', name: 'AgentRefused', version: 1, steps } as WorkflowDefinition;
}

const agent = (extra: Partial<StepDefinition> = {}, depends_on: string[] = []): StepDefinition =>
  ({ description: 'An agent step.', execution: 'agent', depends_on, ...extra }) as StepDefinition;

const PRE: Partial<StepDefinition> = { preconditions: ['run.params.ok == true'] };
const TRUST = { trust: 'bogus_value' } as unknown as Partial<StepDefinition>;
const NEEDS_N: Partial<StepDefinition> = {
  input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
};

const PRE_REFUSAL = (step: string): string =>
  `Precondition failed for step '${step}'. Precondition failed: 'run.params.ok == true'. Resolved value: undefined.`;
// decision C49: the view's trust refusal is #508's read-time voice (`finding`).
const TRUST_REFUSAL =
  "'trust: \"bogus_value\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.";

async function freshRun(store: JsonFileStore, d: WorkflowDefinition) {
  const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  return run;
}

const commandsOf = (actions: ReturnType<typeof buildNextActions>): unknown[] =>
  actions.map((a) =>
    a.instruction === null ? null : [a.instruction.tool, a.instruction.call_with['command']],
  );

describe('#625 PR-2a, C82 — the view judges an agent step by its pre-claim checks', () => {
  it('head: a failing precondition and a refused trust are in agent_refused, never in agent_steps or agent_actions; a passing agent step is offered (control)', async () => {
    await withStore(async (store) => {
      const d = def({ pre: agent(PRE), tru: agent(TRUST), ok: agent() });
      const run = await freshRun(store, d);
      const view = describePending(d, run, undefined, new Date());
      // (a) red when the view drops its agent check, or either member; (b) prints the three lists.
      expect({
        agent_steps: view.agent_steps,
        offered: commandsOf(view.agent_actions),
        agent_refused: view.agent_refused,
      }).toEqual({
        agent_steps: ['ok'],
        offered: [['execute_step', 'ok']],
        agent_refused: [
          {
            step: 'pre',
            runnable_here: false,
            refused_by: 'precondition',
            refusal: PRE_REFUSAL('pre'),
          },
          { step: 'tru', runnable_here: false, refused_by: 'trust', refusal: TRUST_REFUSAL },
        ],
      });
    });
  });

  it('chained: an agent step after another step, its precondition reading that step’s output — refused when it fails, offered when it passes (control)', async () => {
    await withStore(async (store) => {
      const d = def({
        first: agent(),
        ask: agent({ preconditions: ['first.ok == true'] }, ['first']),
      });
      for (const ok of [false, true]) {
        const run = await freshRun(store, d);
        const r = await executeChain(store, d, {
          runId: run.id,
          command: 'first',
          input: { ok },
          dispatcher: echo,
        });
        expect(r.status).toBe('ok');
        const view = describePending(d, await store.get(run.id), undefined, new Date());
        // (a) red when the agent check is dropped (ok:false) or refuses a passing step (ok:true);
        // (b) prints the two lists.
        expect({
          agent_steps: view.agent_steps,
          refused: view.agent_refused.map((e) => [e.step, e.refused_by, e.refusal]),
        }).toEqual(
          ok
            ? { agent_steps: ['ask'], refused: [] }
            : {
                agent_steps: [],
                refused: [
                  [
                    'ask',
                    'precondition',
                    "Precondition failed for step 'ask'. Precondition failed: 'first.ok == true'. Resolved value: false.",
                  ],
                ],
              },
        );
      }
    });
  });

  it('CONTROL — an agent step’s input schema is never judged by the view (its input is the agent’s answer)', async () => {
    await withStore(async (store) => {
      const d = def({ ask: agent(NEEDS_N) });
      const view = describePending(d, await freshRun(store, d), undefined, new Date());
      // (a) red when the view also judges the input schema of an agent step; (b) prints both lists.
      expect({ agent_steps: view.agent_steps, agent_refused: view.agent_refused }).toEqual({
        agent_steps: ['ask'],
        agent_refused: [],
      });
      expect(AGENT_PRE_CLAIM_REFUSALS).toEqual(['trust', 'precondition']);
    });
  });

  it('stepsThatCannotRun: every step that cannot run, agent and engine, in definition order', async () => {
    await withStore(async (store) => {
      // `zeta` first and last by name, an engine step between two agent steps: neither name order nor
      // "agent first, then engine" passes for definition order.
      const d = def({
        zeta: agent(PRE),
        alpha: {
          description: 'A',
          execution: 'auto',
          depends_on: [],
          preconditions: ['nothing.ok == true'],
        },
        mid: agent(TRUST),
        ok: agent(),
      });
      const view = describePending(d, await freshRun(store, d), undefined, new Date());
      // (a) red when the accessor returns engine steps only, or one list after the other; (b) prints
      // the steps with their checks.
      expect(stepsThatCannotRun(view).map((e) => [e.step, e.refused_by])).toEqual([
        ['zeta', 'precondition'],
        ['alpha', 'precondition'],
        ['mid', 'trust'],
      ]);
    });
  });

  it('L9 for agent steps: executeStep refuses an agent step exactly when the view lists it in agent_refused, member by member', async () => {
    await withStore(async (store) => {
      for (const [name, extra] of [
        ['precondition', PRE],
        ['trust', TRUST],
        ['none', {}],
      ] as const) {
        const d = def({ ask: agent(extra) });
        const run = await freshRun(store, d);
        const refused = describePending(d, run, undefined, new Date()).agent_refused.map(
          (e) => e.refused_by,
        );
        const reply = await executeStep(store, d, {
          runId: run.id,
          command: 'ask',
          input: {},
          dispatcher: echo,
        });
        // (a) red when the view and the engine disagree on a member; (b) prints both verdicts.
        expect({ member: name, refused, status: reply.status }).toEqual({
          member: name,
          refused: name === 'none' ? [] : [name],
          status: name === 'none' ? 'ok' : name === 'trust' ? 'error' : 'blocked',
        });
      }
    });
  });
});

describe('#625 PR-2a, C82 — what every consumer reads', () => {
  it('buildNextActions offers no execute_step for a refused agent step; a passing one is offered (control)', async () => {
    await withStore(async (store) => {
      const d = def({ pre: agent(PRE), ok: agent() });
      // (a) red when buildNextActions offers the eligible agent steps unchecked; (b) prints the actions.
      expect(
        commandsOf(buildNextActions(d, await freshRun(store, d), undefined, new Date())),
      ).toEqual([['execute_step', 'ok']]);
      // Control: the same steps without the precondition are both offered.
      const open = def({ pre: agent(), ok: agent() });
      expect(
        commandsOf(buildNextActions(open, await freshRun(store, open), undefined, new Date())),
      ).toEqual([
        ['execute_step', 'pre'],
        ['execute_step', 'ok'],
      ]);
    });
  });

  it('a run whose only eligible step is a refused agent step cannot go on: the next sentence, the predicates and the lines', async () => {
    await withStore(async (store) => {
      const d = def({ ask: agent(PRE) });
      const run = await freshRun(store, d);
      const view = describePending(d, run, undefined, new Date());
      // (a) red when any consumer reads the engine steps alone (the agent member falls out) or the
      // sentence says "Ready for the agent"; (b) prints the sentence, both predicates and the lines.
      expect({
        next: describeNext(view, run, d),
        here: cannotGoOnHere(run, view),
        wayOut: cannotRunWayOutApplies(run, view),
        lines: cannotGoOnLines(run, view, d),
      }).toEqual({
        next: ` 'ask' cannot run (precondition): ${PRE_REFUSAL('ask')} ${cannotRunWayOutTools(run, d, view)}`,
        here: true,
        wayOut: true,
        lines: [
          `'ask' cannot run (precondition): ${PRE_REFUSAL('ask')}`,
          cannotRunWayOut(run, d, view),
        ],
      });
    });
  });

  it('CONTROL — the same step without the precondition: the agent step is ready, the run can go on', async () => {
    await withStore(async (store) => {
      // (`run.params.*` never resolves in a precondition — preconditions read step evidence only,
      // #482 — so the passing case is the step without one; the chained cells pass one on evidence.)
      const d = def({ ask: agent() });
      const run = await freshRun(store, d);
      const view = describePending(d, run, undefined, new Date());
      expect({
        next: describeNext(view, run, d),
        here: cannotGoOnHere(run, view),
        lines: cannotGoOnLines(run, view, d),
      }).toEqual({ next: " Ready for the agent: 'ask'.", here: false, lines: [] });
    });
  });

  it('chained: the reply of the step before names the refused agent step and the way out, never "Ready for the agent" (control: offered when it passes)', async () => {
    await withStore(async (store) => {
      const d = def({
        first: agent(),
        ask: agent({ preconditions: ['first.ok == true'] }, ['first']),
      });
      const replies: Record<string, string> = {};
      for (const ok of [false, true]) {
        const run = await freshRun(store, d);
        const r = await executeChain(store, d, {
          runId: run.id,
          command: 'first',
          input: { ok },
          dispatcher: echo,
        });
        replies[String(ok)] = `${r.context_hint} | ${JSON.stringify(commandsOf(r.next_actions))}`;
      }
      // (a) red when the reply's "something cannot run" test reads engine steps only (it would then
      // say "Waiting for other steps") or the view offers the step; (b) prints both replies.
      expect(replies).toEqual({
        false:
          "Step 'first' completed. 'ask' cannot run (precondition): Precondition failed for step 'ask'. Precondition failed: 'first.ok == true'. Resolved value: false. " +
          // F15: a precondition refusal — the one way out, its words unchanged
          'Correct the workflow and register it again, then call advance_run; or end the run with abandon_run. | []',
        true: `Step 'first' completed. Ready for the agent: 'ask'. | [["execute_step","ask"]]`,
      });
    });
  });

  it('a terminal run or a run with an open gate: agent_refused and cannot_run are empty', async () => {
    const run = {
      id: 'r',
      params: {},
      completed_steps: [],
      in_progress_steps: [],
      failed_steps: [],
      skipped_steps: [],
      evidence: [],
      terminal_state: true,
    } as unknown as RunRecord;
    const view = describePending(def({ ask: agent(PRE) }), run, undefined, new Date());
    expect({ agent_refused: view.agent_refused, cannot_run: view.cannot_run }).toEqual({
      agent_refused: [],
      cannot_run: [],
    });
  });
});
