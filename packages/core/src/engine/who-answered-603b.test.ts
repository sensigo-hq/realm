// who-answered-603b.test.ts — #603 A3b: the account a channel reported for an answer, read once
// (`answerAccountOf`), in the answer view and in the outcome. Acceptance checks 1 (core's part: the
// view reads `channel_evidence`), 4 (an account that cannot be shown: the view and the outcome) and
// 7 (an `admitted_by` that is not one of the five). Check 8 (the entry the gate's expiry wrote) is the
// real expiry's: step-view.test.ts "C2" and mcp-server's holder-625 "C2". The lines a person reads are
// pinned beside each door (the CLI and the MCP server).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  executeStep,
  outcomeOf,
  submitHumanResponse,
  type SubmitGateOptions,
} from './execution-loop.js';
import { composeStepViews } from './step-view.js';
import { ACCOUNT_ABSENT_CAUSES, ADMITTED_BY_ABSENT_CAUSES } from './holder.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import type { RunRecord } from '../types/run-record.js';

/** One gated step whose question names no one, so any account counts. */
const open: WorkflowDefinition = {
  id: 'who-answered-603b',
  name: 'who-answered-603b',
  version: 1,
  steps: {
    confirm: {
      description: 'Confirm',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'] },
    },
  },
};

/** The record after one answer with `opts` (a Slack answer's route and account by default). */
async function answered(opts: Partial<SubmitGateOptions> = {}): Promise<RunRecord> {
  const store = new InMemoryStore();
  const { record } = await store.create({ workflowId: open.id, workflowVersion: 1, params: {} });
  const opened = await executeStep(store, open, {
    runId: record.id,
    command: 'confirm',
    input: {},
    dispatcher: async () => ({}),
  });
  if (opened.gate === undefined) throw new Error(`fixture: ${opened.status}`);
  const reply = await submitHumanResponse(store, open, {
    runId: record.id,
    gateId: opened.gate.gate_id,
    choice: 'approve',
    route: 'slack',
    channelEvidence: {
      user: 'U0ALICE',
      team: 'T1',
      forms: ['U0ALICE', '<@U0ALICE>'],
      ts: '1.2',
      thread_ts: '1.1',
    },
    ...opts,
  });
  if (reply.status !== 'ok') throw new Error(`fixture: ${reply.status} ${reply.errors[0]}`);
  return (await store.get(record.id)).record;
}

/** The view's answer, and the outcome `outcomeOf` composes, for the record's one answer. */
function read(run: RunRecord) {
  const answer = composeStepViews(run)['confirm']?.answers?.[0];
  return { answer, by: outcomeOf(run, 'confirm', undefined, false)?.by };
}

/** The record with its answer's entry changed by `change`. */
function withEntry(run: RunRecord, change: (e: Record<string, unknown>) => void): RunRecord {
  const evidence = run.evidence.map((e) => {
    if (e.kind !== 'gate_response') return e;
    const copy = JSON.parse(JSON.stringify(e)) as Record<string, unknown>;
    change(copy);
    return copy as unknown as typeof e;
  });
  return { ...run, evidence };
}

describe('#603 A3b — the account a channel reported, in the answer view and the outcome', () => {
  it('check 1 (core): a Slack answer — the view names the account (team kept) and how it was let through; the outcome names the account', async () => {
    const { answer, by } = read(await answered());
    // (1) red when the view or the outcome does not read `answer.channel_evidence` (the account is
    //     left out), or `admitted_by` is not read; (2) prints the view's new members and the outcome.
    expect({
      account: answer?.account,
      account_absent: answer?.account_absent,
      admitted_by: answer?.admitted_by,
      admitted_by_absent: answer?.admitted_by_absent,
      by,
    }).toEqual({
      account: { user: 'U0ALICE', team: 'T1' },
      account_absent: undefined,
      admitted_by: 'no_named_answerer',
      admitted_by_absent: undefined,
      by: { kind: 'answer', account: 'U0ALICE', basis: 'stated' },
    });
  });

  it('check 4 (core): an account that cannot be shown — `account_unreadable` on the view and the outcome, no byte of it', async () => {
    // A library call (or another program) can store any string as the account.
    const run = await answered({
      channelEvidence: { user: 'U0\u0007ALICE', forms: ['U0\u0007ALICE'] },
    });
    const { answer, by } = read(run);
    // (1) red when the raw value passes through the reader; (2) prints both.
    expect({
      account: answer?.account,
      account_absent: answer?.account_absent,
      by,
      rawShown: JSON.stringify({ answer, by }).includes('\\u0007'),
    }).toEqual({
      account: undefined,
      account_absent: 'account_unreadable',
      by: { kind: 'answer', account_absent: 'account_unreadable', basis: 'stated' },
      rawShown: false,
    });
  });

  it('a stored `team` that cannot be shown is left out; the account is still named', async () => {
    const run = withEntry(await answered(), (e) => {
      (e['answer'] as { channel_evidence: Record<string, unknown> }).channel_evidence['team'] = 7;
    });
    // (1) red when an unreadable team makes the whole account unreadable, or passes through; (2)
    //     prints the view's account.
    expect(read(run).answer?.account).toEqual({ user: 'U0ALICE' });
  });

  it('check 7: `admitted_by: boss` reads `admission_unreadable`; a missing one `admission_not_recorded`', async () => {
    const base = await answered();
    const boss = read(
      withEntry(base, (e) => {
        e['admitted_by'] = 'boss';
      }),
    ).answer;
    const none = read(
      withEntry(base, (e) => {
        delete e['admitted_by'];
      }),
    ).answer;
    // (1) red when an unknown value passes through, or a missing one reads as a value; (2) prints
    //     both views' pairs.
    expect({
      boss: [boss?.admitted_by, boss?.admitted_by_absent],
      none: [none?.admitted_by, none?.admitted_by_absent],
    }).toEqual({
      boss: [undefined, 'admission_unreadable'],
      none: [undefined, 'admission_not_recorded'],
    });
  });

  it('the two absence lists, named after their noun, as exported', () => {
    // (1) red when a cause is renamed or added without the docs; (2) prints both lists.
    expect({
      account: [...ACCOUNT_ABSENT_CAUSES],
      admitted: [...ADMITTED_BY_ABSENT_CAUSES],
    }).toEqual({
      account: ['settled_by_expiry', 'account_not_recorded', 'account_unreadable'],
      admitted: ['settled_by_expiry', 'admission_not_recorded', 'admission_unreadable'],
    });
  });
});
