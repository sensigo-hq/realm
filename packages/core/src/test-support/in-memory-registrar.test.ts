// issue #616 PR-2c, c1a — the in-memory workflow registrar core's engine tests read a definition
// through, in place of a JSON registry on a temporary folder.
//
// Every assertion carries (1) the change that turns it red and (2) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { InMemoryWorkflowRegistrar } from './in-memory-registrar.js';
import { getWorkflowForRun } from '../workflow/registrar.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';
import type { WorkflowError } from '../types/workflow-error.js';

const DEF: WorkflowDefinition = {
  id: 'reg-wf',
  name: 'registered',
  version: 1,
  steps: { only: { description: 'Only.', execution: 'auto', depends_on: [] } },
};

/** A run of `workflowId`: the one field `getWorkflowForRun` resolves from. */
function runOf(workflowId: string): RunRecord {
  return {
    id: 'run-1',
    workflow_id: workflowId,
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 0,
    params: {},
    evidence: [],
    created_at: '2026-11-07T00:00:00.000Z',
    updated_at: '2026-11-07T00:00:00.000Z',
    terminal_state: false,
  };
}

describe('#616 PR-2c c1a — InMemoryWorkflowRegistrar', () => {
  it('a registered definition is what get returns', async () => {
    // (1) red when `get` reads another key than the id `register` stored under; (2) prints the
    //     definition returned.
    const registrar = new InMemoryWorkflowRegistrar();
    await registrar.register(DEF);
    expect(await registrar.get('reg-wf')).toEqual(DEF);
  });

  it('list lists every registered definition', async () => {
    // (1) red when `list` returns nothing or a stale copy; (2) prints the ids listed.
    const registrar = new InMemoryWorkflowRegistrar();
    await registrar.register(DEF);
    await registrar.register({ ...DEF, id: 'reg-wf-2' });
    expect((await registrar.list()).map((d) => d.id)).toEqual(['reg-wf', 'reg-wf-2']);
  });

  it('get of an unknown id throws the registry’s own refusal: STATE_WORKFLOW_NOT_FOUND, "Workflow not found: <id>"', async () => {
    // (1) red when the double mints its own refusal (another message, code or agentAction) instead
    //     of `workflowNotFoundError`'s; (2) prints the code, message, agentAction and retryable.
    const registrar = new InMemoryWorkflowRegistrar();
    const e = (await registrar.get('nope').catch((err: unknown) => err)) as WorkflowError;
    expect({
      code: e.code,
      message: e.message,
      agentAction: e.agentAction,
      retryable: e.retryable,
    }).toEqual({
      code: 'STATE_WORKFLOW_NOT_FOUND',
      message: 'Workflow not found: nope',
      agentAction: 'report_to_user',
      retryable: false,
    });
  });

  it('getWorkflowForRun admits it as a workflow store and returns the run’s definition', async () => {
    // (1) red when the class does not declare this realm's release line (the admission refuses the
    //     store before any read); (2) prints the definition returned, or the refusal's code and
    //     message.
    const registrar = new InMemoryWorkflowRegistrar();
    await registrar.register(DEF);
    const got = await getWorkflowForRun(registrar, runOf('reg-wf'), {
      retryVerb: 'retry',
      verb: 'start',
    }).catch((err: WorkflowError) => ({ refused: err.code, message: err.message }));
    expect(got).toEqual(DEF);
  });
});
