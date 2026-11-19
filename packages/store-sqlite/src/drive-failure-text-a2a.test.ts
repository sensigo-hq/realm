// Gap 1, unit A2a, check 3 — SQLite's refusal of an update that would remove or change the model
// calls' text a stored drive failure keeps: `STATE_EVIDENCE_REWRITTEN`, with the store's one sentence
// for that code, word for word, from the branch that judges drive failures (no evidence is touched).
//
// The cell names the break that turns it red (prompts/gap1-a2a-store-side.md, check 3) and prints
// each write's refusal.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowError, type DriveFailureRecord, type RunRecord } from '@sensigo/realm';
import { openRealmHome } from './index.js';

const handles: Array<{ close(): void }> = [];
const dirs: string[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SENTENCE =
  "The store refused a write that would change or remove a run's stored evidence, which is append-only, or the model text kept on one of its drive failures.";

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

describe('gap 1, unit A2a — SQLite refuses losing or changing a drive failure’s text', () => {
  it('check 3: removing the ring, or changing one failure’s text, is STATE_EVIDENCE_REWRITTEN with the store’s sentence, and the texts stay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-a2a-'));
    dirs.push(dir);
    const handle = await openRealmHome({ home: join(dir, '.realm') });
    handles.push(handle);
    const store = handle.runStore;
    const { record: created } = await store.create({
      workflowId: 'a2a-sentence',
      workflowVersion: 1,
      params: {},
    });
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
    const refused = { code: 'STATE_EVIDENCE_REWRITTEN', message: SENTENCE, details: {} };
    // (1) red when the store keeps its old sentence, or does not judge drive failures; (2) prints
    //     each write's outcome and the texts read after.
    expect({
      removed: await attempt(withoutRing as RunRecord),
      changed: await attempt(changed),
      textsAfter: (await store.get(created.id)).record.drive_failures?.entries.map(
        (entry) => entry.model_text,
      ),
    }).toEqual({
      removed: refused,
      changed: refused,
      textsAfter: stored.drive_failures!.entries.map((entry) => entry.model_text),
    });
  });
});
