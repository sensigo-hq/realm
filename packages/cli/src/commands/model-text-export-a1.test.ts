// Gap 1, unit A1 — `realm run export` carries each model call's text, masked for the file it writes:
// the evidence entry's `model_text` is classed `'value'` in core's disclosure table, so the export
// walk masks every text inside it and keeps its shape.
//
// The cell names the break that turns it red (prompts/gap1-a1-model-text-record.md, check 12) and
// prints the exported field.
import { afterEach, describe, expect, it } from 'vitest';
import { buildDisclosureSet, type EvidenceSnapshot, type ModelText } from '@sensigo/realm';
import { buildExportBundle } from './export.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const CANARY = 'fake-env-canary-a1-model-text';
const homes: TempHome[] = [];
afterEach(async () => {
  for (const h of homes.splice(0)) await h.cleanup();
});

describe('gap 1, unit A1 — export carries model_text, masked as a value', () => {
  it('check 12: the field is in the file, its texts masked for the file audience, its shape kept', async () => {
    const h = await makeTempHome();
    homes.push(h);
    const store = h.home.runStore;
    const { record: run } = await store.create({
      workflowId: 'model-text-export-a1',
      workflowVersion: 1,
      params: {},
    });
    const modelText: ModelText = {
      recorded: true,
      messages: [
        { role: 'system', text: 'the system text' },
        { role: 'user', text: `a prompt naming ${CANARY}` },
        { role: 'assistant', text: 'the reply' },
      ],
      tools: [{ json: '[{"name":"t"}]' }],
      requests: [{ request_id: 'r-1', sent: [0, 1], tools: 0, reply: [2] }],
    };
    const entry: EvidenceSnapshot = {
      step_id: 'ask',
      started_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:01.000Z',
      duration_ms: 1000,
      input_summary: {},
      output_summary: { summary: 'done' },
      status: 'success',
      evidence_hash: 'model-text-export-a1',
      model_text: modelText,
    };
    await store.update({ ...run, evidence: [entry] });
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
    const exported = bundle.run.evidence[0]?.model_text;
    // (1) red when the field is classed `'fact'` (the text then leaves unmasked); (2) prints the
    //     exported field and whether the file holds the canary.
    expect({
      exported,
      leaked: JSON.stringify(bundle).includes(CANARY),
    }).toEqual({
      exported: {
        ...modelText,
        messages: [
          modelText.messages[0],
          { role: 'user', text: 'a prompt naming [REDACTED]' },
          modelText.messages[2],
        ],
      },
      leaked: false,
    });
  });
});
