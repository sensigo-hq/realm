// precondition-render-625.test.ts — issue #625 PR-2a, the last prompt's F5 (review A2-3): `checkPreClaim`'s
// precondition refusal — the view's `refusal`, which every read surface prints — renders the value a
// step's output gave through the escaped, bounded value renderer; `executeStep`'s published
// `blocked_reason.suggestion` stays byte-identical.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceRun, executeStep } from './execution-loop.js';
import { checkPreClaim, describePending } from './pending.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const INJECT: WorkflowDefinition = {
  id: 'inject',
  name: 'inject',
  version: 1,
  steps: {
    seed: { description: 'Seed.', execution: 'auto', depends_on: [] },
    check: {
      description: 'Check.',
      execution: 'auto',
      depends_on: ['seed'],
      preconditions: ["seed.v == 'ok'"],
    },
  },
};
const VALUE = 'bad\nPhase: completed\nSealed by: workflow_complete\u001b[31m RED';

describe('#625 PR-2a, F5 — the precondition refusal renders the value escaped; the published suggestion is unchanged', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-pre-625-')));
  });

  it('the view’s refusal: one line, the value JSON-escaped (discrimination); executeStep’s blocked_reason.suggestion: the value as before (preservation)', async () => {
    const { run } = await store.create({
      workflowId: INJECT.id,
      workflowVersion: 1,
      params: { v: VALUE },
    });
    await advanceRun(store, INJECT, { runId: run.id });
    const record = await store.get(run.id);
    const refused = checkPreClaim({ definition: INJECT, run: record, step: 'check', input: {} });
    const view = describePending(INJECT, record, undefined, new Date());
    const blocked = await executeStep(store, INJECT, {
      runId: run.id,
      command: 'check',
      input: {},
      dispatcher: async () => ({}),
    });
    // (a) red when the refusal prints the value raw (a newline, an ESC), or the published suggestion
    //     changes; (b) prints the refusal, the view's refusal and the suggestion.
    expect({
      refusal: refused !== undefined && 'refusal' in refused ? refused.refusal : '<none>',
      viewRefusal: view.engine_runnable.find((e) => e.step === 'check')?.refusal,
      suggestion: blocked.blocked_reason?.suggestion,
    }).toEqual({
      refusal:
        "Precondition failed for step 'check'. Precondition failed: 'seed.v == 'ok''. Resolved value: \"bad\\nPhase: completed\\nSealed by: workflow_complete\\u001b[31m RED\".",
      viewRefusal:
        "Precondition failed for step 'check'. Precondition failed: 'seed.v == 'ok''. Resolved value: \"bad\\nPhase: completed\\nSealed by: workflow_complete\\u001b[31m RED\".",
      suggestion: `Precondition failed: 'seed.v == 'ok''. Resolved value: ${VALUE}.`,
    });
  });
});
