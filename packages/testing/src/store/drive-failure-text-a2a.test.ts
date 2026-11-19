// Gap 1, unit A2a, check 3 — InMemoryStore's two refusals of an update that would lose or change the
// model calls' text a stored drive failure keeps: each sentence word for word, from its own branch,
// naming the failure by its number counted from 1 (`total − length + index + 1`).
//
// The cell names the break that turns it red (prompts/gap1-a2a-store-side.md, check 3) and prints
// each write's refusal.
import { describe, expect, it } from 'vitest';
import { WorkflowError, type DriveFailureRecord, type RunRecord } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';

const failure = (n: number): DriveFailureRecord => ({
  at: `2026-01-01T00:00:1${n}.000Z`,
  step: 'work',
  provider: 'fake-provider',
  error_class: 'other',
  message: `fake failure ${n}`,
  elapsed_ms: n + 1,
  model_text: {
    recorded: true,
    messages: [{ role: 'user', text: `the fake text of failure ${n}` }],
    tools: [],
    requests: [{ request_id: null, sent: [0], reply: null }],
  },
});

/** What an update did: the refusal's code, message and details, or `accepted`. */
const outcome = (err: unknown) =>
  err instanceof WorkflowError
    ? { code: err.code, message: err.message, details: err.details ?? {} }
    : { plain: String(err) };

describe('gap 1, unit A2a — InMemoryStore refuses losing or changing a drive failure’s text', () => {
  it('check 3: the removed and the changed sentence, each from its branch, number the failure from 1', async () => {
    const store = new InMemoryStore();
    const { record: created } = await store.create({
      workflowId: 'a2a-sentences',
      workflowVersion: 1,
      params: {},
    });
    // Seven failures so far, the ring holding the last five: numbers 3 to 7 counted from 1.
    await store.update({
      ...created,
      drive_failures: {
        first_failed_at: failure(0).at,
        total: 7,
        entries: [0, 1, 2, 3, 4].map(failure),
      },
    });
    const { record: stored } = await store.get(created.id);
    const { drive_failures: _ring, ...withoutRing } = stored;
    void _ring;
    const changed: RunRecord = {
      ...stored,
      drive_failures: {
        ...stored.drive_failures!,
        entries: stored.drive_failures!.entries.map((entry, i) =>
          i === 2 ? { ...entry, model_text: { recorded: false, why: 'switched_off' } } : entry,
        ),
      },
    };
    const attempt = (record: RunRecord) =>
      store.update(record).then(() => ({ accepted: true }), outcome);
    const id = created.id;
    // (1) red when a branch's sentence differs, or a failure is numbered from 0 or by position;
    //     (2) prints each write's outcome.
    expect({
      removed: await attempt(withoutRing as RunRecord),
      changed: await attempt(changed),
    }).toEqual({
      removed: {
        code: 'STATE_EVIDENCE_REWRITTEN',
        message: `The store refused a write that would remove the model calls' text from drive failure 3 of run ${id}: a listing of runs leaves the texts out, and its record is never written back.`,
        details: { runId: id, driveFailure: 3 },
      },
      changed: {
        code: 'STATE_EVIDENCE_REWRITTEN',
        message: `The store refused a write that would change the model calls' text kept on drive failure 5 of run ${id}: a drive failure's text is written once.`,
        details: { runId: id, driveFailure: 5 },
      },
    });
  });
});
