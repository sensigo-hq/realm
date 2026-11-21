// startup-failure-word-592c.test.ts — Q1 (#592) unit c, check 7 (prompt q1-c-startup-death-mark.md):
// `DriveFailureRecord['error_class']` gains `startup_failure`, and only Realm's two startup writers
// mint it. `ERROR_CLASSES` lists it (the both-ways compile check in run-record.ts holds the type and
// the list together); `CLAIMABLE_ERROR_CLASSES` is every word but it, the one list a program's
// `model_attempts` (here) and a provider's thrown payload (cli drive-failure.test.ts) close against.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import { CLAIMABLE_ERROR_CLASSES, ERROR_CLASSES, type ModelAttempt } from '../types/run-record.js';
import { closeModelAttempts } from './model-failure.js';
import { executeStep } from './execution-loop.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

/** The seven words a provider or a program may claim, in the type's order. */
const SEVEN = [
  'connection_timeout',
  'connection_error',
  'api_status',
  'sdk_missing',
  'validation_rejected',
  'aborted_by_budget',
  'other',
];

describe('Q1 (#592) unit c — check 7: the word, and who may claim it', () => {
  it('ERROR_CLASSES lists startup_failure, last before other; CLAIMABLE_ERROR_CLASSES is every word but it', () => {
    // (a) red when the word leaves the list or moves, or when the claimable list keeps it or drops
    //     another word; (b) prints both lists.
    expect({ all: [...ERROR_CLASSES], claimable: [...CLAIMABLE_ERROR_CLASSES] }).toEqual({
      all: [...SEVEN.slice(0, 6), 'startup_failure', 'other'],
      claimable: SEVEN,
    });
  });

  it('closeModelAttempts drops a claimed startup_failure (null, as made_up_class), and keeps the other seven words', () => {
    const passed = [...SEVEN, 'startup_failure', 'made_up_class'].map((error_class, request) => ({
      request,
      kind: 'transient',
      error_class,
      status: null,
      wait_ms: null,
      retry_after_ms: null,
    }));
    // (a) red when closeModelAttempts closes against ERROR_CLASSES (startup_failure kept) or drops
    //     one of the seven; (b) prints each try's request and its closed class.
    expect(closeModelAttempts(passed)?.map((a) => [a.request, a.error_class])).toEqual([
      ...SEVEN.map((c, i) => [i, c]),
      [7, null],
      [8, null],
    ]);
  });

  it("through the write: a program's model_attempts claiming startup_failure is stored with error_class null", async () => {
    const store = new InMemoryStore();
    const def: WorkflowDefinition = {
      id: 'q1c-word',
      name: 'Q1 c word',
      version: 1,
      steps: { draft: { description: 'Draft', execution: 'agent' } },
    };
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    const envelope = await executeStep(store, def, {
      runId: run.id,
      command: 'draft',
      input: { ok: true },
      dispatcher: async (_s, input) => ({ ...input }),
      stepMeta: {
        modelAttempts: [
          { request: 0, kind: 'setup', error_class: 'startup_failure' },
          { request: 1, kind: 'transient', error_class: 'api_status' },
        ] as unknown as ModelAttempt[],
      },
    });
    expect(envelope.status).toBe('ok');
    const entry = (await store.get(run.id)).record.evidence.find((e) => e.step_id === 'draft');
    // (a) red when the write's closure keeps startup_failure from a program; (b) prints the tries.
    expect(entry?.model_attempts?.map((a) => [a.request, a.error_class])).toEqual([
      [0, null],
      [1, 'api_status'],
    ]);
  });
});
