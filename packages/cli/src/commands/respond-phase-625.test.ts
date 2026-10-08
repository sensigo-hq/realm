// respond-phase-625.test.ts — issue #625 PR-2a (decision C11): `realm run respond`'s last line names
// the DERIVED phase, never the persisted label (a store whose stored label is stale reads differently).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { respondToGate } from './respond.js';

const def: WorkflowDefinition = {
  id: 'respond-phase-wf',
  name: 'respond phase',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve'] },
    },
    finish: { description: 'Finish', execution: 'agent', depends_on: ['confirm'] },
  },
};

describe('#625 PR-2a — respond prints the derived phase', () => {
  it('a stored label that lags the record: the line says the derived phase', async () => {
    const home = mkdtempSync(join(tmpdir(), 'realm-respond-phase-625-'));
    try {
      const json = new JsonFileStore(join(home, 'runs'));
      const workflows = new JsonWorkflowStore(join(home, 'wf'));
      await workflows.register(def);
      const { run } = await json.create({ workflowId: def.id, workflowVersion: 1, params: {} });
      await executeStep(json, def, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: async () => ({}),
      });
      const gateId = (await json.get(run.id)).pending_gate!.gate_id;
      let answered = false;
      // Reads after the answer return a stale stored label ('gate_waiting') on an open run.
      const store = new Proxy(json, {
        get(target, prop, receiver) {
          if (prop === 'get') {
            return async (id: string) => {
              const r = await target.get(id);
              return answered ? { ...r, run_phase: 'gate_waiting' } : r;
            };
          }
          if (prop === 'settleStep') {
            return async (...a: Parameters<NonNullable<RunStore['settleStep']>>) => {
              const out = await target.settleStep!(...a);
              answered = true;
              return out;
            };
          }
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      }) as unknown as RunStore;
      const outcome = await respondToGate(
        run.id,
        { gate: gateId, choice: 'approve' },
        store,
        workflows,
        new ExtensionRegistry(),
      );
      expect(outcome.lastLine).toBe(
        `Responded: ${run.id} | choice 'approve' | new state 'running'\n` +
          `An agent step is ready: 'finish' — drive it with realm agent --run-id ${run.id} --provider <provider> --model <model>.\n` +
          // decision C164: the attending line after the command an answer leaves.
          'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
