// render-time-715b.test.ts — issue #715 (b) 02 §D.4 (D6-22, D5 §3.4): a template's `from_now` reads no
// clock. A text STORED in a record (a question's message, and the display text made from it) writes
// time as an absolute instant; a text rendered for one reply (a step's prompt; the opening reply's
// hint) is judged at that reply's reading. The instants are in 2031 on a test location's clock, far
// from the host's: a filter that read the wall clock would say "in 5 years".
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { advanceRun } from './execution-loop.js';
import { applyFilter } from './render-template.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

const T = new Date('2031-05-06T07:00:00.000Z');
const DUE = new Date(T.getTime() + 2 * 3_600_000).toISOString();

describe('#715 (b) §D.4 — from_now takes its instant from the caller', () => {
  it('the filter: judged at the caller’s instant; absolute in a stored text; left as written with no instant', () => {
    // (a) red when the filter reads a clock (the first form says years, the last renders); (b) prints
    //     the three results.
    expect([
      applyFilter(DUE, 'from_now', [], { at: T }),
      applyFilter(DUE, 'from_now', [], 'stored'),
      applyFilter(DUE, 'from_now', []),
    ]).toEqual([
      { ok: true, value: 'in 2 hours' },
      { ok: true, value: DUE },
      { ok: false, reason: 'type_mismatch' },
    ]);
  });

  it('a question’s stored message and its display: the absolute instant; the opening reply’s hint and a step’s prompt in a reply: relative to the reply’s reading', async () => {
    // (a) red when a stored text keeps a relative phrase, or a reply's text is judged at any instant
    //     but its own reading; (b) prints the four texts.
    const store = new InMemoryStore({ clock: settableClock(T) });
    const def: WorkflowDefinition = {
      id: 'render-715b',
      name: 'render 715b',
      version: 1,
      steps: {
        ask: {
          description: 'Ask.',
          execution: 'auto',
          trust: 'human_confirmed',
          depends_on: [],
          instructions: 'Answer before {{ run.params.due | from_now }}.',
          gate: {
            choices: ['approve', 'reject'],
            message: 'Ship by {{ run.params.due | from_now }}?',
          },
        },
        after: {
          description: 'After.',
          execution: 'agent',
          depends_on: ['ask'],
          prompt: 'Due {{ run.params.due | from_now }}.',
        },
      },
    } as WorkflowDefinition;
    const { record } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: { due: DUE },
    });
    const opened = await advanceRun(store, def, { runId: record.id });
    const { record: atGate } = await store.get(record.id);
    // Answer, and the next reply offers `after` with its prompt.
    const { submitHumanResponse } = await import('./execution-loop.js');
    const answered = await submitHumanResponse(store, def, {
      runId: record.id,
      gateId: atGate.pending_gate!.gate_id,
      choice: 'approve',
    });
    const brief = answered.ways.find((w) => w.verb === 'run_step' && w.step === 'after') as
      { brief: { prompt?: string } } | undefined;
    expect({
      stored: atGate.pending_gate?.resolved_message,
      display: opened.gate?.display,
      hint: opened.gate?.agent_hint,
      prompt: brief?.brief.prompt,
    }).toEqual({
      stored: `Ship by ${DUE}?`,
      display: `Ship by ${DUE}?`,
      hint: 'Answer before in 2 hours.',
      prompt: 'Due in 2 hours.',
    });
  });
});
