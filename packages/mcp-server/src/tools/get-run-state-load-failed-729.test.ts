// get-run-state-load-failed-729.test.ts — issue #729 PR-0 (A-5, F-Y11; PR0-CONTRACT Amendment 16, Q19):
// a read on a server whose project code failed to load says so. Before PR-0 the provider's failure
// was swallowed and the run judged as if nothing had failed (an observer, every step offered). Now:
// nothing this server would run is offered (`enactor_load_failed`), one warning names the error —
// its catalogue code, or "(no error code)" for a throw that carries none (`uncoded`) — and the
// agent's word is the T-22 tail.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: tool
// names, codes and booleans — never the loader's message.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  WorkflowError,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleStartRun } from './start-run.js';
import { handleGetRunState } from './get-run-state.js';

/** `ask` (an agent step), and `h` (an engine step with a handler). */
const D: WorkflowDefinition = {
  id: 'load-failed-wf',
  name: 'load failed',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    ask: { description: 'Ask.', execution: 'agent', depends_on: [] },
    h: { description: 'H.', execution: 'auto', depends_on: [], handler: 'h1' },
  },
};

const tools = (actions: readonly { instruction: { tool: string } | null }[] | undefined) =>
  (actions ?? []).map((a) => a.instruction?.tool ?? null);

/** The load warning's shape, without its message: the code part and the closing clause. */
const loadWarnings = (warnings: readonly string[] | undefined) =>
  (warnings ?? [])
    .filter((w) => w.startsWith('this server could not load the project code'))
    .map((w) => ({
      coded: /\(VALIDATION_WORKFLOW_SCHEMA\)/.test(w),
      uncoded: w.includes('(no error code)'),
      closes: w.endsWith('no step can be run or advanced from this server until it loads.'),
    }));

describe('#729 PR-0 — A-5: get_run_state on a server whose project code failed to load', () => {
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let runId: string;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-load-failed-729-'));
    runStore = new JsonFileStore(join(dir, 'runs'));
    workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
    await workflowStore.register(D);
    runId = (await handleStartRun({ workflow_id: D.id }, { runStore, workflowStore })).run_id;
  });

  it('a coded failure: nothing callable, one warning with its code, report_to_user', async () => {
    const state = await handleGetRunState(
      { run_id: runId },
      {
        runStore,
        workflowStore,
        registryProvider: async () => {
          throw new WorkflowError('fixture: the manifest is misplaced', {
            code: 'VALIDATION_WORKFLOW_SCHEMA',
            category: 'VALIDATION',
            agentAction: 'report_to_user',
            retryable: false,
          });
        },
      },
    );
    // (a) red when the catch swallows the failure (the observer reading offers execute_step for
    //     'ask'), or the warning is dropped; (b) prints the tools offered, the warning's shape and
    //     the action word.
    expect({
      next: tools(state.next_actions as never),
      warnings: loadWarnings(state.warnings),
      agent_action: state.agent_action,
    }).toEqual({
      next: [],
      warnings: [{ coded: true, uncoded: false, closes: true }],
      agent_action: 'report_to_user',
    });
  });

  it('a codeless throw: the warning says "(no error code)" — never a code the catalogue does not have', async () => {
    const state = await handleGetRunState(
      { run_id: runId },
      {
        runStore,
        workflowStore,
        registryProvider: async () => {
          throw new Error('fixture: cannot resolve the handler module');
        },
      },
    );
    // (a) red when a codeless throw is given a minted code; (b) prints the warning's shape.
    expect({
      next: tools(state.next_actions as never),
      warnings: loadWarnings(state.warnings),
    }).toEqual({
      next: [],
      warnings: [{ coded: false, uncoded: true, closes: true }],
    });
  });

  it('CONTROL: a provider that loads — the agent step offered, no load warning', async () => {
    const state = await handleGetRunState(
      { run_id: runId },
      { runStore, workflowStore, registryProvider: async () => new ExtensionRegistry() },
    );
    expect({
      next: tools(state.next_actions as never),
      warnings: loadWarnings(state.warnings),
    }).toEqual({ next: ['execute_step'], warnings: [] });
  });
});
