// cannot-go-on-625.test.ts — issue #625 PR-2a, decisions C62 and C64: the one composer of what an
// operator surface prints when a run cannot go on from here (`cannotGoOnLines`), its state
// (`cannotGoOnHere`), and the capability marker's way out (`capabilityMarkerWayOut`). `realm run
// respond`, `realm run drain`, `realm run resume`, `realm listen`'s sweeper and `realm workflow run`
// print these lines; none composes its own. Whole-message pins for every branch, and a control for
// each condition of the state.
import { describe, it, expect } from 'vitest';
import { mkdtemp as mkdtempP, rm as rmP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import {
  cannotGoOnHere,
  cannotGoOnLines,
  cannotRunWayOutApplies,
  capabilityMarkerWayOut,
  describePending,
  type PendingView,
} from './pending.js';
import { ExtensionRegistry } from '../extensions/registry.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

async function withRun<T>(fn: (run: RunRecord) => Promise<T>): Promise<T> {
  const dir = await mkdtempP(join(tmpdir(), 'realm-cannot-go-on-625-'));
  try {
    const { run } = await new JsonFileStore(dir).create({
      workflowId: 'c64-wf',
      workflowVersion: 1,
      params: {},
    });
    return await fn(run);
  } finally {
    await rmP(dir, { recursive: true, force: true });
  }
}

const def = (steps: Record<string, StepDefinition>) =>
  ({ id: 'c64-wf', name: 'c64', version: 1, steps }) as WorkflowDefinition;

const needsN: StepDefinition = {
  description: 'X',
  execution: 'auto',
  depends_on: [],
  input_schema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } },
};
const missing: StepDefinition = {
  description: 'Y',
  execution: 'auto',
  depends_on: [],
  handler: 'missing_h',
};
const INPUT =
  "'x' cannot run (input_schema): Invalid input for step 'x': the input must have required property 'n'.";
// F15: `x` is refused for its input and has no `depends_on` (the engine gives it the run's params):
// its own way out, then the run's once. Before F15 the line said "correct the workflow" for it.
const wayOut = (id: string): string =>
  `Run ${id} stays open (phase 'running'): for 'x', start a run with params that fit, or correct its input_schema and register the workflow again; then, after a fix, realm run advance ${id} — or end it: realm run abandon ${id}`;
/** F15: the workflow the way out reads (`x`'s `depends_on`). */
const ALL = def({ x: needsN, y: missing });

describe('#625 PR-2a, C64 — cannotGoOnLines, the one composer', () => {
  it('a refusal before the claim: each step that cannot run, then the way out (correct the workflow)', async () => {
    await withRun(async (run) => {
      const view = describePending(def({ x: needsN }), run, new ExtensionRegistry(), new Date());
      expect(cannotGoOnHere(run, view)).toBe(true);
      expect(cannotGoOnLines(run, view, ALL)).toEqual([INPUT, wayOut(run.id)]);
    });
  });

  it('a capability refusal alone (judged with a registry): the step with its own way out, then the alternative (abandon)', async () => {
    await withRun(async (run) => {
      const view = describePending(def({ y: missing }), run, new ExtensionRegistry(), new Date());
      expect(cannotRunWayOutApplies(run, view)).toBe(false);
      expect(cannotGoOnLines(run, view, ALL)).toEqual([
        "'y' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it.",
        `To end the run instead: realm run abandon ${run.id}`,
      ]);
    });
  });

  it("a capability refusal judged from the run's marker (no registry): the past tense, the marker's way out, then the alternative", async () => {
    await withRun(async (run) => {
      const marked: RunRecord = {
        ...run,
        capability_blocks: {
          y: {
            requirement: { kind: 'handler', name: 'missing_h' },
            code: 'ENGINE_HANDLER_NOT_REGISTERED',
            at: '2026-10-05T00:00:00.000Z',
          },
        },
      };
      const view = describePending(def({ y: missing }), marked, undefined, new Date());
      expect(cannotGoOnLines(marked, view, ALL)).toEqual([
        `'y' could not run (capability): handler 'missing_h' was not registered in the runner that last attempted it — from a program that has it: realm run advance ${run.id}`,
        `To end the run instead: realm run abandon ${run.id}`,
      ]);
      expect(capabilityMarkerWayOut(run.id)).toBe(
        ` — from a program that has it: realm run advance ${run.id}`,
      );
    });
  });

  it('both: a refusal before the claim and a capability refusal — both steps, then the way out that corrects the workflow', async () => {
    await withRun(async (run) => {
      const view = describePending(
        def({ x: needsN, y: missing }),
        run,
        new ExtensionRegistry(),
        new Date(),
      );
      expect(cannotGoOnLines(run, view, ALL)).toEqual([
        INPUT,
        "'y' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it.",
        wayOut(run.id),
      ]);
    });
  });

  it('controls — the run can go on: an agent step ready, the act present, a step in flight, a question open, a terminal run: no lines', async () => {
    await withRun(async (run) => {
      const withAgent = describePending(
        def({ x: needsN, a: { description: 'A', execution: 'agent', depends_on: [] } }),
        run,
        new ExtensionRegistry(),
        new Date(),
      );
      expect(cannotGoOnLines(run, withAgent, ALL)).toEqual([]);
      const withAct = describePending(
        def({ x: needsN, b: { description: 'B', execution: 'auto', depends_on: [] } }),
        run,
        new ExtensionRegistry(),
        new Date(),
      );
      expect(withAct.act).toBeDefined();
      expect(cannotGoOnLines(run, withAct, ALL)).toEqual([]);
      const stuck: PendingView = describePending(
        def({ x: needsN }),
        run,
        new ExtensionRegistry(),
        new Date(),
      );
      expect(cannotGoOnLines({ ...run, in_progress_steps: ['z'] }, stuck, ALL)).toEqual([]);
      expect(
        cannotGoOnLines(
          { ...run, pending_gate: { gate_id: 'g' } } as unknown as RunRecord,
          stuck,
          ALL,
        ),
      ).toEqual([]);
      expect(cannotGoOnLines({ ...run, terminal_state: true } as RunRecord, stuck, ALL)).toEqual(
        [],
      );
      expect(cannotGoOnLines(run, stuck, ALL)).toEqual([INPUT, wayOut(run.id)]);
    });
  });

  it('C71 — a live run with no question, no act, no agent step ready, nothing in flight and no engine step that cannot run (#537’s structurally dead run): not this state, no lines', async () => {
    await withRun(async (run) => {
      // Hand-built: the view of a run where nothing is eligible and nothing is refused. Every other
      // conjunct of `cannotGoOnHere` holds here, so only "an engine step cannot run" decides it.
      const nothing: PendingView = {
        agent_actions: [],
        agent_steps: [],
        agent_refused: [],
        pending_guards: [],
        engine_runnable: [],
        cannot_run: [],
      };
      // (a) red when `cannotGoOnHere` drops its last conjunct (every surface would then print a
      //     bare "To end the run instead" with no reason); (b) prints the boolean and the lines.
      expect({
        here: cannotGoOnHere(run, nothing),
        lines: cannotGoOnLines(run, nothing, ALL),
      }).toEqual({
        here: false,
        lines: [],
      });
      // Not vacuous: the same run with one step that cannot run IS the state.
      const refusedX = {
        step: 'x',
        runnable_here: false as const,
        refused_by: 'precondition' as const,
        refusal: 'no',
      };
      const oneRefused: PendingView = {
        ...nothing,
        engine_runnable: [refusedX],
        cannot_run: [refusedX],
      };
      expect(cannotGoOnHere(run, oneRefused)).toBe(true);
    });
  });
});
