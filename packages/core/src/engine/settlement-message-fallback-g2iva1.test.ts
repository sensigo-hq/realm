// settlement-message-fallback-g2iva1.test.ts — gap 2, unit (iv-a1): the question's second render.
// `realm run inspect` shows, for a gate opened before Realm stored its question, the step's prompt
// rendered as the question (`pendingGateQuestion`). A failure's message that prompt reads is hidden
// there at the `all` tier before its filters, as in the stored question. Every fake here is made up
// for the test.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it:
// (a) what turns it red, (b) what it prints then.
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { compileDisclosure } from '../utils/redaction.js';
import { pendingGateQuestion } from './execution-loop.js';
import { writtenSnapshot } from './snapshot.js';

const ENV_VALUE = 'QXZENV-IVA1-0002-FAKE';
const MESSAGE = `Handler 'boom' threw: ${ENV_VALUE} again`;

describe('gap 2 (iv-a1) — the fallback question hides a failure message at `all`, before filters', () => {
  it('a gate opened before its question was stored: `| lower` and the whole-entry dump hide the environment secret', async () => {
    const definition: WorkflowDefinition = {
      id: 'g2iva1-fallback',
      name: 'Fallback',
      version: 1,
      steps: {
        boom: { description: 'Fail.', execution: 'auto', handler: 'boom', depends_on: [] },
        review: {
          description: 'Ask a person.',
          execution: 'auto',
          handler: 'noted',
          trust: 'human_confirmed',
          depends_on: ['boom'],
          trigger_rule: 'one_failed',
          prompt:
            'Why: {{ context.resources.$settlement.boom.message | lower }}\nAll: {{ context.resources.$settlement.boom }}',
          gate: { choices: ['ok'] },
        },
      },
    };
    const store = new InMemoryStore();
    const { record } = await store.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    const snap = writtenSnapshot(
      {
        ...record,
        failed_steps: ['boom'],
        evidence: [{ step_id: 'boom', kind: 'execution', error: MESSAGE, output_summary: {} }],
        pending_gate: {
          gate_id: 'g1',
          step_name: 'review',
          preview: {},
          choices: ['ok'],
          opened_at: '',
        },
      } as never,
      new Date(),
    );
    const set = compileDisclosure([{ value: ENV_VALUE, source: 'env:G2IVA1_ENV' }], {
      declared: 'resolved',
      audience: 'private',
      environment: 'swept',
    }).set;
    // (a) red when the fallback hides the message at the declared tier only (the lowered secret and
    //     the dumped one show); (b) prints the question.
    expect(pendingGateQuestion(definition, snap, { disclosure: set })).toBe(
      [
        "Why: handler 'boom' threw: [redacted] again",
        'All: {',
        '  "settled_by_default": false,',
        '  "validation_rejections": 0,',
        '  "failed": true,',
        `  "message": "Handler 'boom' threw: [REDACTED] again"`,
        '}',
      ].join('\n'),
    );
  });
});
