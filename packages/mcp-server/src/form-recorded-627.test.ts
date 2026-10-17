// form-recorded-627.test.ts — #627 W correction 2 (1.5): each conjunct of `formAnswerRecorded` — "the
// form's answer was recorded" — pinned on its own. A reply that is an error, a refusal, a late answer
// not recorded (`answer_recorded: false`) or one that carries an `outcome` counts as the form coming
// back, through the door's own count (`formFacts(g).came_back`). The submit is stubbed here — a
// passthrough of `@sensigo/realm` that replaces only `submitHumanResponse` — in a file of its own,
// because `vi.mock` applies to the whole file.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the
// row's name and the door's two counts.
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  advanceRun,
  judgeFormWait,
  judgeGateAnswers,
  loadWorkflowFromString,
  type EngineReply,
} from '@sensigo/realm';
import { McpDoor } from './door.js';
import { sendQuestionForm } from './form-path.js';

const stub = vi.hoisted(() => ({ reply: undefined as unknown }));

vi.mock('@sensigo/realm', async (importOriginal) => {
  const original = await importOriginal<typeof import('@sensigo/realm')>();
  return { ...original, submitHumanResponse: vi.fn(async () => stub.reply) };
});

const YAML = [
  'id: rec627',
  'name: rec627',
  'version: 1',
  'steps:',
  '  q:',
  '    description: Ask.',
  '    execution: auto',
  '    trust: human_confirmed',
  '    gate:',
  '      choices: [approve, reject]',
].join('\n');

/** A recorded answer's reply: `ok`, nothing that says it was turned away. */
const RECORDED = {
  command: 'submit_human_response',
  run_id: 'r',
  run_version: 2,
  status: 'ok',
  reply_kind: 'ok',
  data: {},
  evidence: [],
  warnings: [],
  errors: [],
  context_hint: '',
  ways: [],
  unavailable: [],
} as unknown as EngineReply;

/** Sends one form that the person accepts, with the stubbed submit returning `reply`; the counts. */
async function countsFor(reply: EngineReply) {
  stub.reply = reply;
  const dir = await mkdtemp(join(tmpdir(), 'realm-rec-627-'));
  const runStore = new JsonFileStore(join(dir, 'runs'));
  const definition = loadWorkflowFromString(YAML);
  const { run } = await runStore.create({ workflowId: 'rec627', workflowVersion: 1, params: {} });
  await advanceRun(runStore, definition, { runId: run.id });
  const gateId = (await runStore.get(run.id)).pending_gate!.gate_id;
  const answers = judgeGateAnswers({});
  const wait = judgeFormWait({});
  if (!answers.ok || !wait.ok) throw new Error('fixture: the defaults judge');
  const door = new McpDoor({
    gateAnswers: answers.setting,
    formWait: wait.setting,
    sendsForms: true,
  });
  door.forms = { ...door.forms, shown: true };
  await sendQuestionForm(
    {
      door,
      elicit: async () => ({ action: 'accept', content: { choice: 'approve' } }),
      runStore,
      definition,
      principal: { absent: 'door_authenticates_no_principal' },
    },
    run.id,
    gateId,
    { started: door.monotonicNow() },
    false,
  );
  const facts = door.formFacts(gateId);
  return { sent: facts.sent, came_back: facts.came_back };
}

describe('#627 W correction 2 (1.5) — formAnswerRecorded, one conjunct per row', () => {
  it('the control: a recorded answer does not count as came back', async () => {
    // (a) red when every answer counts as came back; (b) prints the counts.
    expect(await countsFor(RECORDED)).toEqual({ sent: 1, came_back: 0 });
  });

  it.each([
    ['status error', { status: 'error', reply_kind: 'error' }],
    ['status blocked', { status: 'blocked', reply_kind: 'refusal' }],
    ['answer_recorded: false', { answer_recorded: false }],
    ['an outcome', { outcome: { step: 'q', attempted: true, by: { kind: 'timeout' } } }],
  ] as const)('%s → the form counts as came back', async (_row, over) => {
    // (a) red when that conjunct is dropped from formAnswerRecorded; (b) prints the counts.
    expect(await countsFor({ ...RECORDED, ...over } as unknown as EngineReply)).toEqual({
      sent: 1,
      came_back: 1,
    });
  });
});
