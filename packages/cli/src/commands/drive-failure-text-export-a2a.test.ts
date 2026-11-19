// Gap 1, unit A2a, check 5 — `realm run export` carries a drive failure's `model_text` (the model
// calls' texts), masked for the file it writes: core's drive-failure disclosure row classes it
// `'value'`, so the export walk masks every text inside it and keeps its shape.
//
// The cell names the break that turns it red (prompts/gap1-a2a-store-side.md, check 5) and prints
// the exported field.
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDisclosureSet,
  type DriveFailureModelText,
  type DriveFailureRecord,
} from '@sensigo/realm';
import { buildExportBundle } from './export.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CANARY = 'fake-env-canary-a2a-failure-text';
const homes: TempHome[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await h.cleanup();
});

describe('gap 1, unit A2a — export carries a drive failure’s model_text, masked as a value', () => {
  it('check 5: the field is in the file, its texts masked for the file audience, its shape kept', async () => {
    const h = await makeTempHome();
    homes.push(h);
    const store = h.home.runStore;
    const { record: run } = await store.create({
      workflowId: 'drive-failure-text-export-a2a',
      workflowVersion: 1,
      params: {},
    });
    const modelText: DriveFailureModelText = {
      recorded: true,
      messages: [
        { role: 'system', text: 'the system text' },
        { role: 'user', text: `a prompt naming ${CANARY}` },
      ],
      tools: [{ json: '[{"name":"t"}]' }],
      requests: [{ request_id: null, sent: [0, 1], tools: 0, reply: null }],
      dropped_messages: 1,
    };
    const failure: DriveFailureRecord = {
      at: '2026-01-01T00:00:02.000Z',
      step: 'ask',
      provider: 'anthropic',
      error_class: 'connection_error',
      message: 'connection dropped',
      elapsed_ms: 1000,
      model_text: modelText,
    };
    await store.update({
      ...run,
      drive_failures: { first_failed_at: failure.at, total: 1, entries: [failure] },
    });
    const set = buildDisclosureSet({
      env: { APP_CANARY: CANARY },
      declared: {},
      declaredState: 'resolved',
      audience: 'file',
    }).set;
    const { bundle } = await buildExportBundle(
      run.id,
      {
        runStore: store,
        failedAttemptStore: { read: async () => ({ records: [], capped: false }) },
        traceBufferStore: { readAllForRun: async () => ({}) },
      },
      new Date(),
      set,
    );
    const exported = bundle.run.drive_failures?.entries[0]?.model_text;
    // (1) red when the field is classed `'fact'` (the text then leaves unmasked); (2) prints the
    //     exported field and whether the file holds the canary.
    expect({
      exported,
      leaked: JSON.stringify(bundle).includes(CANARY),
    }).toEqual({
      exported: {
        ...modelText,
        messages: [modelText.messages[0], { role: 'user', text: 'a prompt naming [REDACTED]' }],
      },
      leaked: false,
    });
  });
});
