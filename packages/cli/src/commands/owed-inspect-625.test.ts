// owed-inspect-625.test.ts — issue #625 PR-2a, law L6 (Ownership) on `realm run inspect` AND
// `get_run_state`: on every state fixture, a pending guard or a runnable `auto` step means the act is
// present — and the two read surfaces agree. A refused step is named, never owed.
import { describe, it, expect } from 'vitest';
import type { RunStore, WorkflowDefinition, StepDefinition } from '@sensigo/realm';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  advanceRun,
  executeStep,
  submitHumanResponse,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { handleGetRunState } from '@sensigo/realm-mcp/dist/tools/get-run-state.js';
import { declared } from '../test-support/declared.js';
import { inspectRun } from './inspect.js';

const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition =>
  ({
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  }) as WorkflowDefinition;

const gate: StepDefinition = {
  description: 'Confirm',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on: [],
  gate: { choices: ['approve', 'reject'] },
};
const echo = async (_s: string, i: Record<string, unknown>) => i;

/** A store with no `settleStep`: an answer settles no guard in its own write. */
function legacyStore(): RunStore {
  const store = new InMemoryStore();
  (store as unknown as { settleStep?: unknown }).settleStep = undefined;
  return store;
}

async function answered(store: RunStore, d: WorkflowDefinition): Promise<string> {
  const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
  await executeStep(store, d, { runId: run.id, command: 'confirm', input: {}, dispatcher: echo });
  const g = (await store.get(run.id)).pending_gate!;
  await submitHumanResponse(store, d, { runId: run.id, gateId: g.gate_id, choice: 'approve' });
  return run.id;
}

interface Fixture {
  name: string;
  build: () => Promise<{ store: RunStore; d: WorkflowDefinition; runId: string }>;
  owed?: string;
  cannot?: string[];
  /** get_run_state's `next_actions_status`, when the fixture pins it. */
  status?: string;
}

const fixtures: Fixture[] = [
  {
    name: 'gate→auto, answered: the auto step is owed',
    build: async () => {
      const d = wf('l6-auto', {
        confirm: gate,
        after: { description: 'A', execution: 'auto', depends_on: ['confirm'] },
      });
      const store = new InMemoryStore();
      return { store, d, runId: await answered(store, d) };
    },
    owed: "'after'",
  },
  {
    name: 'gate→guard on a store without settleStep, answered: the guard is owed',
    build: async () => {
      const d = wf('l6-guard', {
        confirm: gate,
        check: {
          description: 'G',
          execution: 'guard',
          depends_on: ['confirm'],
          abort_unless: ["confirm.choice == 'approve'"],
        },
        finish: { description: 'F', execution: 'agent', depends_on: ['check'] },
      });
      const store = legacyStore();
      return { store, d, runId: await answered(store, d) };
    },
    owed: "'check'",
  },
  {
    name: 'a head auto step at creation: owed',
    build: async () => {
      const d = wf('l6-head', { a: { description: 'A', execution: 'auto', depends_on: [] } });
      const store = new InMemoryStore();
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      return { store, d, runId: run.id };
    },
    owed: "'a'",
  },
  {
    name: 'a refused auto step only: no act, the step named',
    build: async () => {
      const d = wf('l6-refused', {
        x: {
          description: 'X',
          execution: 'auto',
          depends_on: [],
          preconditions: ['nope.ok == true'],
        },
      });
      const store = new InMemoryStore();
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      return { store, d, runId: run.id };
    },
    cannot: [
      "Cannot run 'x' (precondition): Precondition failed for step 'x'. Precondition failed: 'nope.ok == true'. Resolved value: undefined.",
    ],
  },
  {
    // decision C33: with no registry the run's own marker is the freshest fact — the step is named
    // with what the runner that last attempted it lacked, and no act is offered (an `advance` from
    // here would find nothing it may run — the walk's J9b dead end).
    name: 'a capability-blocked auto step (marker), no registry: no act, the step named in the past tense',
    build: async () => {
      const d = wf('l6-capability', {
        x: { description: 'X', execution: 'auto', depends_on: [], handler: 'missing_h' },
      });
      const store = new InMemoryStore();
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await advanceRun(store, d, { runId: run.id, registry: new ExtensionRegistry() });
      return { store, d, runId: run.id };
    },
    cannot: [
      "Cannot run 'x' (capability): handler 'missing_h' was not registered in the runner that last attempted it",
    ],
    status: 'blocked_on_capability',
  },
  {
    name: 'an agent step only: nothing owed to the engine',
    build: async () => {
      const d = wf('l6-agent', { a: { description: 'A', execution: 'agent', depends_on: [] } });
      const store = new InMemoryStore();
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      return { store, d, runId: run.id };
    },
  },
  {
    name: 'an open gate: nothing owed',
    build: async () => {
      const d = wf('l6-open', {
        confirm: gate,
        after: { description: 'A', execution: 'auto', depends_on: ['confirm'] },
      });
      const store = new InMemoryStore();
      const { run } = await store.create({ workflowId: d.id, workflowVersion: 1, params: {} });
      await executeStep(store, d, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: echo,
      });
      return { store, d, runId: run.id };
    },
  },
];

describe('#625 PR-2a — L6 Ownership on inspect and get_run_state', () => {
  for (const f of fixtures) {
    it(f.name, async () => {
      const { store, d, runId } = await f.build();
      const workflowStore = declared({
        register: async () => {},
        get: async () => d,
        list: async () => [d],
      } as never);
      const screen = await inspectRun(runId, store, workflowStore);
      const lines = screen.split('\n');
      const owedLines = lines.filter((l) => l.startsWith('Owed to the engine:'));
      const summary = await handleGetRunState(
        { run_id: runId },
        { runStore: store, workflowStore },
      );
      const actOffered = (summary.next_actions ?? []).some(
        (a) => a.instruction?.tool === 'advance_run',
      );
      if (f.owed !== undefined) {
        expect(owedLines).toEqual([`Owed to the engine: ${f.owed} — realm run advance ${runId}`]);
        expect(actOffered).toBe(true);
      } else {
        expect(owedLines).toEqual([]);
        expect(actOffered).toBe(false);
      }
      expect(lines.filter((l) => l.startsWith('Cannot run'))).toEqual(f.cannot ?? []);
      if (f.status !== undefined) expect(summary.next_actions_status).toBe(f.status);
    });
  }
});
