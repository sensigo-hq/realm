// race-625.test.ts — issue #625 PR-2a, the last prompt's F7 (b)–(d) (review G7-01, G7-04 = F-R7,
// G5-9): MCP `advance_run` and `execute_step`'s chain meet a race — another program acts on the same
// store at the moment a row of core's classifier names — and reply from the run's record as the call
// ends. The run another program ended gets `agent_action: "stop"` and the ending's own sentence; a
// question another program opened gets its answer; never `resolve_precondition` with nothing to do.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  abandonRun,
  advanceRun,
  executeStep,
  type Attributed,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleAdvanceRun } from './advance-run.js';
import { handleExecuteStep } from './execute-step.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const RACER: Attributed = { by: 'racer-b', by_source: 'stated', channel: 'test' };

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** `s` (auto), then `u` (auto, after `s`); `x` a question another program can open at any time. */
const DEF: WorkflowDefinition = {
  id: 'race-mcp-625',
  name: 'race-mcp-625',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    s: { description: 'S.', execution: 'auto', depends_on: [] },
    u: { description: 'U.', execution: 'auto', depends_on: ['s'] },
    x: {
      description: 'X.',
      execution: 'auto',
      depends_on: [],
      trust: 'human_confirmed',
      gate: { choices: ['yes', 'no'] },
    } as StepDefinition,
  },
};
/** Without `x`: another program that runs every step completes the run. */
const DEF_NO_X: WorkflowDefinition = {
  ...DEF,
  id: 'race-mcp-625-no-x',
  steps: { s: DEF.steps['s']!, u: DEF.steps['u']! },
};

describe('#625 PR-2a, F7 — MCP advance_run and execute_step reply from the record after a race', () => {
  let store: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'race-mcp-625-'));
    store = new JsonFileStore(join(dir, 'runs'));
    workflowStore = new JsonWorkflowStore(join(dir, 'workflows'));
    await workflowStore.register(DEF);
    await workflowStore.register(DEF_NO_X);
  });

  /**
   * One `advance_run` call on a fresh run of `def`, with the other program's act at `moment`:
   * `read` — the step's own read, after the call's loop picked `s`; `claim` — `s`'s claim.
   */
  async function advanceWithRace(
    def: WorkflowDefinition,
    moment: 'read' | 'claim',
    act: (runId: string) => Promise<void>,
  ) {
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    // `advance_run` reads the run (1), `advanceRun` reads it (2), and `s`'s call reads it (3).
    let gets = 0;
    let fired = false;
    const racing = new Proxy(store, {
      get(target, prop) {
        if (prop === 'get' && moment === 'read') {
          return async (id: string) => {
            if (++gets === 3 && !fired) {
              fired = true;
              await act(id);
            }
            return target.get(id);
          };
        }
        if (prop === 'claimStep' && moment === 'claim') {
          return async (...a: Parameters<JsonFileStore['claimStep']>) => {
            if (a[1] === 's' && !fired) {
              fired = true;
              await act(a[0]);
            }
            return target.claimStep(...a);
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const reply = await handleAdvanceRun(
      { run_id: run.id },
      { runStore: racing, workflowStore, registry: new ExtensionRegistry() },
    );
    const after = await store.get(run.id);
    return { reply, after, fired, runId: run.id };
  }
  const otherRunsIt = (def: WorkflowDefinition) => async (runId: string) => {
    await advanceRun(store, def, { runId, driver: RACER });
  };
  const otherAbandons = async (runId: string) => {
    await abandonRun(store, runId, 'another program');
  };
  const otherOpensX = async (runId: string) => {
    await executeStep(store, DEF, {
      runId,
      command: 'x',
      input: {},
      dispatcher: async () => ({}),
      driver: RACER,
    });
  };

  it('G7-01: another program runs the step to the run’s end first — the reply describes the completed run (its version, phase, no next action, the ending’s sentence)', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      "the call goes on with what is left, and its reply is composed from the run's record as the call ends: `run_version`, `run_phase`, `next_actions` and `context_hint` are that record's, never the record the call first read.",
    );
    const r = await advanceWithRace(DEF_NO_X, 'read', otherRunsIt(DEF_NO_X));
    // (a) red when the reply keeps the version, phase or next actions the call first read;
    //     (b) prints the reply's fields and the hint.
    expect({
      fired: r.fired,
      status: r.reply.status,
      run_phase: r.reply.run_phase,
      fresh: r.reply.run_version === r.after.version,
      next: r.reply.next_actions.length,
      hint: r.reply.context_hint.split(r.runId).join('<run>'),
    }).toEqual({
      fired: true,
      status: 'ok',
      run_phase: 'completed',
      fresh: true,
      next: 0,
      hint: "Run '<run>' is already terminal (completed); nothing ran. 's' was claimed by another process, so it did not run here.",
    });
  });

  it.each([
    ['before the step’s read (G7-04’s r2 abandon)', 'read'],
    ['at the step’s claim (F-R7, r3 abandon)', 'claim'],
  ] as const)(
    'another program ends the run %s — ok, agent_action stop, the operator’s ending said; never resolve_precondition with nothing to do',
    async (_name, moment) => {
      claim(
        'docs/reference/mcp/tools.md',
        'When the run ended that way, the reply carries `agent_action: "stop"`.',
      );
      const r = await advanceWithRace(DEF, moment, otherAbandons);
      // (a) red when the race's refusal is returned (`STATE_STEP_NOT_ELIGIBLE`, `blocked`), the
      //     reply names no `stop`, or keeps what the call first read; (b) prints the reply's fields.
      expect({
        fired: r.fired,
        status: r.reply.status,
        error_code: r.reply.error_code,
        agent_action: r.reply.agent_action,
        run_phase: r.reply.run_phase,
        next: r.reply.next_actions.length,
        operator: r.reply.context_hint.includes(
          'An operator ended this run, with the reason "another program"; to run the work again, start a new run.',
        ),
      }).toEqual({
        fired: true,
        status: 'ok',
        error_code: undefined,
        agent_action: 'stop',
        run_phase: 'abandoned',
        next: 0,
        operator: true,
      });
    },
  );

  it('G5-9: another program opens a question at the step’s claim — the reply holds the answer; never an error naming a step that did not fail', async () => {
    const r = await advanceWithRace(DEF, 'claim', otherOpensX);
    // (a) red when the claim's refusal is returned as an error; (b) prints the reply's fields.
    expect({
      fired: r.fired,
      status: r.reply.status,
      error_code: r.reply.error_code,
      agent_action: r.reply.agent_action,
      run_phase: r.reply.run_phase,
      next: r.reply.next_actions.map((a) => a.instruction?.tool),
    }).toEqual({
      fired: true,
      status: 'ok',
      error_code: undefined,
      agent_action: undefined,
      run_phase: 'gate_waiting',
      next: ['submit_human_response'],
    });
  });

  it('execute_step: the chain after the named step meets the race — the reply is the run’s as the call ends', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      'The chain an `execute_step` call runs after its step does the same.',
    );
    const def: WorkflowDefinition = {
      id: 'race-mcp-625-chain',
      name: 'race-mcp-625-chain',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        a: { description: 'A.', execution: 'agent', depends_on: [] },
        s: { description: 'S.', execution: 'auto', depends_on: ['a'] },
      },
    };
    await workflowStore.register(def);
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    let settledA = false;
    let fired = false;
    const racing = new Proxy(store, {
      get(target, prop) {
        if (prop === 'claimStep') {
          return async (...a: Parameters<JsonFileStore['claimStep']>) => {
            if (a[1] === 's' && settledA && !fired) {
              fired = true;
              // another program ends the run at the chained step's claim
              await abandonRun(store, a[0], 'another program');
            }
            return target.claimStep(...a);
          };
        }
        if (prop === 'settleStep') {
          return async (...a: Parameters<NonNullable<JsonFileStore['settleStep']>>) => {
            const res = await target.settleStep!(...a);
            if (a[1].kind === 'settle_step' && a[1].step === 'a') settledA = true;
            return res;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const reply = await handleExecuteStep(
      { run_id: run.id, command: 'a', params: { ok: true } },
      { runStore: racing, workflowStore, registry: new ExtensionRegistry() },
    );
    // (a) red when the chain returns the claim's refusal (`STATE_STEP_NOT_ELIGIBLE`) or the named
    //     step's reply as first composed; (b) prints the reply's fields.
    expect({
      fired,
      status: reply.status,
      error_code: reply.error_code,
      agent_action: reply.agent_action,
      run_phase: reply.run_phase,
      next: reply.next_actions.length,
      head: reply.context_hint.startsWith("Step 'a' completed. The run ended (abandoned)."),
    }).toEqual({
      fired: true,
      status: 'ok',
      error_code: undefined,
      agent_action: 'stop',
      run_phase: 'abandoned',
      next: 0,
      head: true,
    });
  });
});
