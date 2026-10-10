// cleanup-owed-625.test.ts — issue #625 PR-2a, the last prompt's F11 (review G5-2) on `realm run
// respond`: an answer to a COMPLETED run whose ending left a cleanup step `pending` is refused with the
// cleanup step and the command that runs it, once — never "nothing is owed".
//
// In-process: the command's body (`respondToGate`) on a fresh store.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  advanceRun,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { respondToGate } from './respond.js';

const DEF: WorkflowDefinition = {
  id: 'f11-respond',
  name: 'f11-respond',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    s: { description: 'S.', execution: 'auto', depends_on: [] },
    tidy: {
      description: 'Tidy.',
      execution: 'finalizer',
      handler: 'tidy',
      on_outcome: 'always',
    } as StepDefinition,
  },
};

describe('#625 PR-2a, F11 — realm run respond on a completed run with a cleanup step pending', () => {
  it('the refusal names the pending cleanup step and its command, once — never "nothing is owed"', async () => {
    const home = mkdtempSync(join(tmpdir(), 'realm-f11-respond-'));
    try {
      const runs = new JsonFileStore(join(home, 'runs'));
      const workflows = new JsonWorkflowStore(join(home, 'wf'));
      await workflows.register(DEF);
      const { run } = await runs.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
      // the run completes; `tidy`'s handler is not registered here, so its ending leaves it pending
      await advanceRun(runs, DEF, { runId: run.id });
      const refused = await respondToGate(
        run.id,
        { gate: 'g-old', choice: 'yes' },
        runs,
        workflows,
        new ExtensionRegistry(),
      ).then(
        () => 'answered',
        (err: Error) => err.message,
      );
      const command = `'realm run drain ${run.id} --force'`;
      // (a) red when the refusal says "nothing is owed" with the cleanup step pending, or names its
      //     command twice; (b) prints the refusal.
      expect({
        refused,
        nothingOwed: refused.includes('nothing is owed'),
        times: refused.split(command).length - 1,
      }).toEqual({
        refused: `Run '${run.id}' is terminal (completed); cannot submit a gate response — it completed; cleanup step left pending: 'tidy' — ${command} runs it with code that has its handler.`,
        nothingOwed: false,
        times: 1,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
