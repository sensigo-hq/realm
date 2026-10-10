// guard-ending-625.test.ts — issue #625 PR-2a, the last prompt's F13 (review F-R4): when the advance
// loop's OWN guard decision ends the run — a guard pending after `realm run resume --from <guard>`,
// or one another writer made eligible after the call's step — the reply carries `guards` and
// `ended_by`, as a reply whose step's write ended the run does. Through `advance_run`, and through
// `execute_step`'s chain (the same loop).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  executeStep,
  applyResume,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { handleAdvanceRun } from './advance-run.js';
import { handleExecuteStep } from './execute-step.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** `p` (agent) and guard `gr` on its answer; `x` (agent) with no dependency. */
const DEF: WorkflowDefinition = {
  id: 'f13-guard',
  name: 'f13-guard',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    p: { description: 'P.', execution: 'agent', depends_on: [] },
    gr: {
      description: 'GR.',
      execution: 'guard',
      depends_on: ['p'],
      abort_unless: ['p.ok == true'],
    } as StepDefinition,
    x: { description: 'X.', execution: 'agent', depends_on: [] },
  },
};

const ENDED_BY = {
  arm: 'guard_resolution_error',
  step: 'gr',
  reason: "Guard resolution error: unresolvable path 'p.ok' (condition: p.ok == true)",
};

async function stores() {
  const dir = await mkdtemp(join(tmpdir(), 'f13-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(DEF);
  return { runStore, workflowStore };
}

describe('#625 PR-2a, F13 — the loop’s own guard ending carries guards and ended_by', () => {
  it('advance_run after `realm run resume --from <guard>`: the loop decides the pending guard, which fails the run — guards and ended_by', async () => {
    claim(
      'docs/reference/mcp/tools.md',
      '`chained_auto_steps` lists what ran, guards included, `guards` and `ended_by` what a guard that ended the run settled',
    );
    const { runStore, workflowStore } = await stores();
    const { run } = await runStore.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
    // `p` answered with nothing at `ok`: its write decides `gr` (a resolution error), the run fails
    await executeStep(runStore, DEF, {
      runId: run.id,
      command: 'p',
      input: {},
      dispatcher: async () => ({}),
    });
    // `realm run resume --from gr`: the guard is pending again, and no write decides it
    await runStore.update(applyResume(await runStore.get(run.id), 'gr', DEF).run);
    expect((await runStore.get(run.id)).run_phase, 'fixture: resumed').toBe('running');
    const reply = await handleAdvanceRun({ run_id: run.id }, { runStore, workflowStore });
    // (a) red when the loop's own guard ending leaves out `guards` or `ended_by` (F-R4); (b) prints
    //     the reply's fields.
    expect({
      run_phase: reply.run_phase,
      chained: (reply.chained_auto_steps ?? []).map((c) => c.step),
      guards: reply.guards,
      ended_by: reply.ended_by,
    }).toEqual({
      run_phase: 'failed',
      chained: ['gr'],
      guards: [{ step: 'gr', outcome: 'resolution_error' }],
      ended_by: ENDED_BY,
    });
  });

  it('execute_step’s chain (the same loop): another writer makes the guard eligible after the named step’s write — the chain decides it — guards and ended_by', async () => {
    const { runStore, workflowStore } = await stores();
    const { run } = await runStore.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
    let wroteP = false;
    // After `x`'s own write, another writer records `p` with a plain update (it decides no guard),
    // so the chain's loop meets `gr` and decides it itself.
    const racing = new Proxy(runStore, {
      get(target, prop) {
        if (prop === 'settleStep') {
          return async (...a: Parameters<NonNullable<JsonFileStore['settleStep']>>) => {
            const r = await target.settleStep!(...a);
            if (a[1].kind === 'settle_step' && a[1].step === 'x' && !wroteP) {
              wroteP = true;
              const cur = await target.get(a[0]);
              const now = new Date().toISOString();
              await target.update({
                ...cur,
                completed_steps: [...cur.completed_steps, 'p'],
                evidence: [
                  ...cur.evidence,
                  {
                    step_id: 'p',
                    started_at: now,
                    completed_at: now,
                    duration_ms: 0,
                    input_summary: {},
                    output_summary: {},
                    status: 'success',
                    evidence_hash: 'f13',
                  },
                ],
              });
            }
            return r;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const reply = await handleExecuteStep(
      { run_id: run.id, command: 'x', params: {} },
      { runStore: racing, workflowStore },
    );
    // (a) red when the chain's own guard ending leaves out `guards` or `ended_by`; (b) prints them.
    expect({
      wroteP,
      run_phase: reply.run_phase,
      guards: reply.guards,
      ended_by: reply.ended_by,
    }).toEqual({
      wroteP: true,
      run_phase: 'failed',
      guards: [{ step: 'gr', outcome: 'resolution_error' }],
      ended_by: ENDED_BY,
    });
  });
});
