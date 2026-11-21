// model-attempts-g2ia.test.ts — gap 2, unit (i-a): `StepMeta.modelAttempts` reaches the entries
// `modelText` reaches (the attempt's entry, the default entry and #220's fail entry) as
// `model_attempts`, and the write closes each try to its eight members: numbers, closed words and
// `null` only, so the stored entry holds no text whatever a program passed. Realm itself passes none
// yet (unit i-b does).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { executeStep, DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD } from './execution-loop.js';
import { InMemoryStore } from '@sensigo/realm-testing';
import type { StepDispatcher } from './execution-loop.js';
import type { WorkflowDefinition, StepDefinition } from '../types/workflow-definition.js';
import type { ModelAttempt } from '../types/run-record.js';

const echoDispatcher: StepDispatcher = async (_step, input) => ({ ...input });
const OUTPUT_SCHEMA = {
  type: 'object',
  required: ['category'],
  properties: { category: { type: 'string' } },
};

function def(stepOverrides: Partial<StepDefinition> = {}): WorkflowDefinition {
  return {
    id: 'g2ia-attempts-wf',
    name: 'G2IA attempts',
    version: 1,
    steps: {
      draft: {
        description: 'Draft',
        execution: 'agent',
        output_schema: OUTPUT_SCHEMA,
        ...stepOverrides,
      },
    },
  };
}

/** A fake secret a program might wrongly put in a try: it must never reach the stored entry. */
const SECRET = 'sk-fake-g2ia-0123456789';

/** Tries as a careless program might pass them: one clean, and every kind of value the write closes. */
const PASSED: unknown[] = [
  {
    request: 0,
    kind: 'transient',
    error_class: 'api_status',
    status: 503,
    wait_ms: 500,
    retry_after_ms: null,
  },
  {
    request: 0,
    kind: `retry-me ${SECRET}`,
    error_class: SECRET,
    status: `status ${SECRET}`,
    wait_ms: 1.5,
    retry_after_ms: -1,
    exhausted_by: SECRET,
    then: SECRET,
    message: `the provider said: ${SECRET}`,
  },
  {
    request: 1,
    kind: 'setup',
    error_class: 'api_status',
    status: 401,
    wait_ms: null,
    retry_after_ms: 30000,
    exhausted_by: 'attempts',
    then: 'gateway',
  },
  { request: 'zero', kind: 'transient', error_class: SECRET },
  { request: -1, kind: 'transient' },
  { request: 2.5, kind: 'transient' },
  `a whole text entry ${SECRET}`,
  null,
  [0, SECRET],
];

/** What the write keeps of {@link PASSED}. */
const CLOSED: ModelAttempt[] = [
  {
    request: 0,
    kind: 'transient',
    error_class: 'api_status',
    status: 503,
    wait_ms: 500,
    retry_after_ms: null,
  },
  { request: 0, kind: null, error_class: null, status: null, wait_ms: null, retry_after_ms: null },
  {
    request: 1,
    kind: 'setup',
    error_class: 'api_status',
    status: 401,
    wait_ms: null,
    retry_after_ms: 30000,
    exhausted_by: 'attempts',
    then: 'gateway',
  },
];

describe('gap 2, unit (i-a) — StepMeta.modelAttempts on the entries, closed at the write', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  async function newRun(d: WorkflowDefinition, rejections?: number) {
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    if (rejections !== undefined) {
      await store.update({ ...run, validation_rejections: { draft: rejections } });
    }
    return run.id;
  }

  it("the attempt's entry keeps the closed tries only: a word outside its set, a text where a number goes and an extra key never reach it", async () => {
    const d = def();
    const runId = await newRun(d);
    const envelope = await executeStep(store, d, {
      runId,
      command: 'draft',
      input: { category: 'billing' },
      dispatcher: echoDispatcher,
      stepMeta: { modelAttempts: PASSED as ModelAttempt[] },
    });
    expect(envelope.status).toBe('ok');
    const { record } = await store.get(runId);
    const entry = record.evidence.find((e) => e.step_id === 'draft');
    // (a) red when captureEvidence writes the list as given; (b) prints the stored list.
    expect(entry?.model_attempts).toEqual(CLOSED);
    // (a) red when any passed text survives the write; (b) prints the stored JSON.
    expect(JSON.stringify(entry?.model_attempts)).not.toContain(SECRET);
    expect(JSON.stringify(entry)).not.toContain(SECRET);
  });

  it('a value that is not a list is not written, and an entry with no tries passed has no field', async () => {
    const d = def();
    for (const [what, modelAttempts] of [
      ['a text', `not a list ${SECRET}`],
      ['an object', { request: 0, kind: 'transient' }],
      ['nothing', undefined],
    ] as const) {
      const runId = await newRun(d);
      await executeStep(store, d, {
        runId,
        command: 'draft',
        input: { category: 'billing' },
        dispatcher: echoDispatcher,
        stepMeta: modelAttempts === undefined ? {} : { modelAttempts: modelAttempts as never },
      });
      const { record } = await store.get(runId);
      const entry = record.evidence.find((e) => e.step_id === 'draft');
      // (a) red when a value that is not a list is written (or the field is made up); (b) prints
      //     the case and the entry's keys.
      expect({ what, keys: Object.keys(entry ?? {}) }).toEqual({
        what,
        keys: expect.not.arrayContaining(['model_attempts']),
      });
    }
  });

  it("#220's default entry carries the closed tries, as it carries modelText", async () => {
    const d = def({
      validation_exhaustion: { mode: 'default', default_output: { category: 'fallback' } },
    });
    const runId = await newRun(d, DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1);
    const envelope = await executeStep(store, d, {
      runId,
      command: 'draft',
      input: {},
      dispatcher: echoDispatcher,
      stepMeta: { modelAttempts: PASSED as ModelAttempt[] },
    });
    expect(envelope.status).toBe('ok');
    const { record } = await store.get(runId);
    const settled = record.evidence.find(
      (e) => e.step_id === 'draft' && e.diagnostics?.settled_by_default === true,
    );
    expect(settled, 'fixture: the step settled by its default').toBeDefined();
    // (a) red when the default site leaves the member out; (b) prints the entry's list.
    expect(settled?.model_attempts).toEqual(CLOSED);
  });

  it("#220's fail entry carries the closed tries, as it carries modelText", async () => {
    const d = def();
    const runId = await newRun(d, DEFAULT_VALIDATION_EXHAUSTION_THRESHOLD - 1);
    const envelope = await executeStep(store, d, {
      runId,
      command: 'draft',
      input: {},
      dispatcher: echoDispatcher,
      stepMeta: { modelAttempts: PASSED as ModelAttempt[] },
    });
    expect(envelope.status).toBe('error');
    const { record } = await store.get(runId);
    const failed = record.evidence.find(
      (e) => e.step_id === 'draft' && e.status === 'error' && e.stop_reason === 'attempts',
    );
    expect(failed, "fixture: #220's fail entry").toBeDefined();
    // (a) red when the fail site leaves the member out; (b) prints the entry's list.
    expect(failed?.model_attempts).toEqual(CLOSED);
  });
});
