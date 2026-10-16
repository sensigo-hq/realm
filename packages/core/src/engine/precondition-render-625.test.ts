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

describe('#625 PR-2a, F5 — the precondition refusal renders the value escaped; #729 PR-0 (E1 (b)): the refusal’s facts carry it escaped too', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-pre-625-')));
  });

  it('the view’s refusal: one line, the value JSON-escaped (discrimination); executeStep’s refusal facts: the same escaped value (E1 (b): the one escaped, bounded value renderer — the byte-identical suggestion rule ends)', async () => {
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
    // (a) red when the refusal prints the value raw (a newline, an ESC), or the reply's facts carry it
    //     raw; (b) prints the refusal, the view's refusal and the facts' value.
    expect({
      refusal: refused !== undefined && 'refusal' in refused ? refused.refusal : '<none>',
      viewRefusal: view.engine_runnable.find((e) => e.step === 'check')?.refusal,
      value:
        blocked.refusal?.code === 'refused_before_claim'
          ? blocked.refusal.facts.precondition?.value
          : '<no refusal>',
    }).toEqual({
      refusal:
        "Precondition failed for step 'check'. Precondition failed: 'seed.v == 'ok''. Resolved value: \"bad\\nPhase: completed\\nSealed by: workflow_complete\\u001b[31m RED\".",
      viewRefusal:
        "Precondition failed for step 'check'. Precondition failed: 'seed.v == 'ok''. Resolved value: \"bad\\nPhase: completed\\nSealed by: workflow_complete\\u001b[31m RED\".",
      value: '"bad\\nPhase: completed\\nSealed by: workflow_complete\\u001b[31m RED"',
    });
  });

  it('E1 (b), Table row 54: a value that ends in a full stop keeps it inside its quotes, and the sentence still ends with its own', async () => {
    const { run } = await store.create({
      workflowId: INJECT.id,
      workflowVersion: 1,
      params: { v: 'ends.' },
    });
    await advanceRun(store, INJECT, { runId: run.id });
    const record = await store.get(run.id);
    const refused = checkPreClaim({ definition: INJECT, run: record, step: 'check', input: {} });
    // (a) red when the value is printed raw (its stop then reads as the sentence's) or the
    //     sentence's stop is dropped because the value ends in one; (b) prints the refusal's tail.
    expect(
      refused !== undefined && 'refusal' in refused
        ? refused.refusal.endsWith(
            `Precondition failed: 'seed.v == 'ok''. Resolved value: "ends.".`,
          )
        : '<none>',
    ).toBe(true);
  });
});
