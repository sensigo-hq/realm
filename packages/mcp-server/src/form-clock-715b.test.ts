// form-clock-715b.test.ts — issue #715 (b) 03 §A.5 (PF rows 19 and 21; D6-8): the form's wait for
// the question's deadline — an instant STORED on the record — runs on the store's clock; the cap (a
// duration) and the settle poll stay real timers. On a settable store clock the form is withdrawn
// with "the question's time ran out" when the clock reaches the deadline, without a real minute's
// wait. (The due question that opens no form is pinned in form-627.test.ts.)
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import {
  advanceRun,
  judgeFormWait,
  judgeGateAnswers,
  loadWorkflowFromString,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { sendQuestionForm, WITHDRAWN, type FormDeps } from './form-path.js';
import { McpDoor } from './door.js';

const WORKFLOW = [
  'id: formclock715b',
  'name: formclock715b',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    gate:',
  '      choices: [approve, reject]',
  '      message: Ship it?',
  '      timeout_seconds: 60',
  '      on_expiry: abort',
].join('\n');

describe('#715 (b) 03 §A.5 — the form waits for the stored deadline on the store’s clock', () => {
  it('the deadline is the nearer bound: the store’s clock reaching it withdraws the form with "the question’s time ran out" (60 s waited)', async () => {
    // (a) red when the deadline's withdrawal is a real timer (it would fire only after a real
    //     minute: the cell runs out of time), or the reason is "Realm stopped waiting"; (b) prints the
    //     withdrawal's reason and the form's result.
    const clock = settableClock(new Date('2030-01-01T00:00:00.000Z'));
    const runStore = new InMemoryStore({ clock });
    const definition = loadWorkflowFromString(WORKFLOW);
    const { record: run } = await runStore.create({
      workflowId: definition.id,
      workflowVersion: 1,
      params: {},
    });
    await advanceRun(runStore, definition, { runId: run.id });
    const gateId = (await runStore.get(run.id)).record.pending_gate!.gate_id;
    const answers = judgeGateAnswers({});
    const wait = judgeFormWait({});
    if (!answers.ok || !wait.ok) throw new Error('fixture: the defaults judge');
    const door = new McpDoor({
      gateAnswers: answers.setting,
      formWait: wait.setting,
      sendsForms: true,
    });
    door.forms = { ...door.forms, shown: true };
    let reason: unknown;
    const deps: FormDeps = {
      door,
      runStore,
      definition,
      principal: { absent: 'door_authenticates_no_principal' },
      elicit: (_params, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reason = options.signal.reason;
            reject(Object.assign(new Error('Request timed out'), { code: -32001 }));
          });
          // The form is open: the store's clock moves past the question's deadline.
          setTimeout(() => void clock.advance(61_000), 20);
        }),
    };
    const result = await sendQuestionForm(
      deps,
      run.id,
      gateId,
      { started: door.monotonicNow() },
      false,
    );
    expect({
      reason,
      kind: result.kind,
      waited: 'waited_s' in result ? result.waited_s : undefined,
    }).toEqual({
      reason: WITHDRAWN.timeout,
      kind: 'came_back',
      waited: 60,
    });
  }, 15_000);
});
