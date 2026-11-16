// outbound-lines-d1b.test.ts — issue #597 D1b: what `realm run inspect` and `realm run list` say about
// the reminders and the escalation the store's outbound ledger recorded for a run's question, counted
// from the ledger's rows alone (`store.outbound.read`), at the run read's own reading:
//   `Reminders: N sent (of at most M), last <when>; K skipped; U not confirmed; F failed (not retried)`
//   `Escalation: sent <when>` / `not confirmed` / `failed (not retried)`
//   `Reminders: none recorded` for an open question with no reminder row.
// `inspect` prints them after the open question's block (after `Updated:` when none is open); `list`
// appends `reminders: …` and `escalation: …` to a `gate_waiting` row only. A store with no ledger, a
// run with neither an open question nor rows, or a read that throws: no line, nothing else changes.
//
// The store is an `InMemoryStore` on a settable clock in 2030; the rows are leased and marked through
// its real ledger at known readings, so every count and instant has a known answer.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import {
  declareReleaseLine,
  executeStep,
  loadWorkflowFromString,
  stripSpanMarks,
  submitHumanResponse,
  type OutboundLeaseRequest,
  type OutboundLedger,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock, type SettableClock } from '@sensigo/realm-testing';
import { inspectRun } from './inspect.js';
import { listRuns } from './list.js';

const T = Date.parse('2030-01-01T00:00:00.000Z');
const MIN = 60_000;
const at = (ms: number): Date => new Date(T + ms);

// Loaded as a workflow file is (its defaults applied), so `inspect` prints the question's `To answer:`.
const GATED: WorkflowDefinition = loadWorkflowFromString(
  [
    'id: outbound-lines-d1b',
    'name: outbound-lines-d1b',
    'version: 1',
    'steps:',
    '  q:',
    '    description: Ask.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    gate:',
    '      choices: [approve, reject]',
    '      reminder_seconds: 600',
    '      reminder_max: 3',
    '  after:',
    '    description: After.',
    '    execution: agent',
    '    depends_on: [q]',
  ].join('\n'),
);

/** The same workflow with no authored reminder schedule: the ledger's `of_max` is 1. */
const UNSCHEDULED: WorkflowDefinition = loadWorkflowFromString(
  [
    'id: outbound-lines-d1b-default',
    'name: outbound-lines-d1b-default',
    'version: 1',
    'steps:',
    '  q:',
    '    description: Ask.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    gate:',
    '      choices: [approve, reject]',
    '  after:',
    '    description: After.',
    '    execution: agent',
    '    depends_on: [q]',
  ].join('\n'),
);

// Declared, so the run's definition resolves (and `inspect` prints the question and `To answer:`).
const workflowStore = {
  async register() {},
  async get() {
    return GATED;
  },
  async list() {
    return [GATED];
  },
};
declareReleaseLine(workflowStore);

interface Rig {
  readonly clock: SettableClock;
  readonly store: InMemoryStore;
  readonly ledger: OutboundLedger;
  readonly runId: string;
  readonly gateId: string;
}

/** A run waiting at `q`, its question (every 10 min, at most 3; or `def`'s) opened at T. */
async function waiting(
  store?: InMemoryStore,
  clock?: SettableClock,
  def: WorkflowDefinition = GATED,
): Promise<Rig> {
  const c = clock ?? settableClock(at(0));
  const s = store ?? new InMemoryStore({ clock: c });
  const { record } = await s.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  const step = await executeStep(s, def, {
    runId: record.id,
    command: 'q',
    input: {},
    dispatcher: async () => ({}),
  });
  if (step.status !== 'confirm_required') throw new Error(`fixture: ${step.status}`);
  const gateId = (await s.get(record.id)).record.pending_gate!.gate_id;
  return { clock: c, store: s, ledger: s.outbound!, runId: record.id, gateId };
}

const reminder = (r: Rig, occurrence: number): OutboundLeaseRequest['what'] => ({
  type: 'reminder',
  gateId: r.gateId,
  occurrence,
});
const escalation = (r: Rig): OutboundLeaseRequest['what'] => ({
  type: 'escalation',
  gateId: r.gateId,
});

/** Leases `what` at `ms` after T (a 120-s lease); marks it `result` at the same reading when given. */
async function row(
  r: Rig,
  what: OutboundLeaseRequest['what'],
  ms: number,
  result?: 'sent' | 'failed',
): Promise<void> {
  await r.clock.set(at(ms));
  const token = `t-${what.type}-${what.type === 'reminder' ? what.occurrence : 'e'}-${ms}`;
  const leased = await r.ledger.lease(r.runId, { what, leaseToken: token, leaseSeconds: 120 });
  if (!leased.applied) throw new Error(`fixture: ${leased.reason}`);
  if (result === undefined) return;
  const marked = await r.ledger.mark(r.runId, {
    what,
    leaseToken: token,
    result,
    outcome: result === 'sent' ? 'ok' : 'refused:channel_not_found',
  });
  if (!marked.applied) throw new Error(`fixture: ${marked.reason}`);
}

/** `inspect`'s output, at the clock's reading `ms` after T. */
async function inspected(r: Rig, ms: number, store: RunStore = r.store): Promise<string[]> {
  await r.clock.set(at(ms));
  return stripSpanMarks(await inspectRun(r.runId, store, workflowStore)).split('\n');
}

/** `inspect`'s ledger lines. */
const ledgerLines = (out: string[]): string[] =>
  out.filter((l) => l.startsWith('Reminders: ') || l.startsWith('Escalation: '));

/** `list`'s row for the run, from its gate column on. */
async function listed(
  r: Rig,
  ms: number,
  store: RunStore = r.store,
  runId = r.runId,
): Promise<string> {
  await r.clock.set(at(ms));
  const line = (await listRuns(undefined, store)).split('\n').find((l) => l.includes(runId));
  return stripSpanMarks(line ?? '(no row)').replace(/^.*?(?=gate: |\d+ step\(s\))/, '');
}

describe('#597 D1b — inspect and list say what the outbound ledger recorded', () => {
  it('counts: sent; sent + skipped; failed; rows with none sent; each line exactly as the grammar, instants through the one formatter', async () => {
    // (a) red when a count is wrong (skipped not the highest occurrence minus the rows; failed not
    //     counted), `of at most` is not the row's `of_max` (3 for the schedule, 1 with none), `last`
    //     is not the latest `sent_at` or is judged at another reading, or a zero part prints; (b)
    //     prints each case's lines.
    const sent = await waiting();
    await row(sent, reminder(sent, 1), 10 * MIN, 'sent');
    const skipped = await waiting();
    await row(skipped, reminder(skipped, 3), 30 * MIN, 'sent');
    const failed = await waiting();
    await row(failed, reminder(failed, 1), 10 * MIN, 'failed');
    const twoSent = await waiting();
    await row(twoSent, reminder(twoSent, 1), 10 * MIN, 'sent');
    await row(twoSent, reminder(twoSent, 2), 20 * MIN, 'sent');
    const unscheduled = await waiting(undefined, undefined, UNSCHEDULED);
    await row(unscheduled, reminder(unscheduled, 1), 10 * MIN, 'sent');
    expect({
      sent: ledgerLines(await inspected(sent, 70 * MIN)),
      skipped: ledgerLines(await inspected(skipped, 70 * MIN)),
      failed: ledgerLines(await inspected(failed, 70 * MIN)),
      twoSent: ledgerLines(await inspected(twoSent, 70 * MIN)),
      unscheduled: ledgerLines(await inspected(unscheduled, 70 * MIN)),
    }).toEqual({
      sent: ['Reminders: 1 sent (of at most 3), last 1h 0m ago (2030-01-01T00:10:00Z)'],
      skipped: ['Reminders: 1 sent (of at most 3), last 40m ago (2030-01-01T00:30:00Z); 2 skipped'],
      failed: ['Reminders: 0 sent (of at most 3); 1 failed (not retried)'],
      twoSent: ['Reminders: 2 sent (of at most 3), last 50m ago (2030-01-01T00:20:00Z)'],
      // A gate with no authored schedule: its one reminder.
      unscheduled: ['Reminders: 1 sent (of at most 1), last 1h 0m ago (2030-01-01T00:10:00Z)'],
    });
  });

  it('not confirmed: a pending row whose lease has passed at the read’s reading; a live lease prints nothing', async () => {
    // (a) red when a live lease reads as not confirmed, or a passed one is not counted, or the lease
    //     is judged at the host's clock (years later: always passed); (b) prints both readings.
    const r = await waiting();
    await row(r, reminder(r, 1), 10 * MIN); // its lease: until 12 min
    expect({
      live: ledgerLines(await inspected(r, 11 * MIN)),
      passed: ledgerLines(await inspected(r, 13 * MIN)),
    }).toEqual({
      live: ['Reminders: 0 sent (of at most 3)'],
      passed: ['Reminders: 0 sent (of at most 3); 1 not confirmed'],
    });
  });

  it('the escalation: sent <when>, failed (not retried), not confirmed; a live lease prints no line', async () => {
    // (a) red when the escalation's status is misread, its instant is not the formatter's, or a live
    //     lease prints a line; (b) prints each case's lines.
    const sent = await waiting();
    await row(sent, escalation(sent), 30 * MIN, 'sent');
    const failed = await waiting();
    await row(failed, escalation(failed), 30 * MIN, 'failed');
    const pending = await waiting();
    await row(pending, escalation(pending), 30 * MIN);
    expect({
      sent: ledgerLines(await inspected(sent, 70 * MIN)),
      failed: ledgerLines(await inspected(failed, 70 * MIN)),
      unconfirmed: ledgerLines(await inspected(pending, 33 * MIN)),
      live: ledgerLines(await inspected(pending, 31 * MIN)),
    }).toEqual({
      sent: ['Reminders: none recorded', 'Escalation: sent 40m ago (2030-01-01T00:30:00Z)'],
      failed: ['Reminders: none recorded', 'Escalation: failed (not retried)'],
      unconfirmed: ['Reminders: none recorded', 'Escalation: not confirmed'],
      live: ['Reminders: none recorded'],
    });
  });

  it('where it prints: after the open question’s `To answer:` line; after `Updated:` when the question was answered (a resolved run keeps its lines)', async () => {
    // (a) red when the lines move into the question's block (the lines after `Gate:` shift), are
    //     lost once the question is answered, or print before `Updated:`; (b) prints both outputs.
    const r = await waiting();
    await row(r, reminder(r, 1), 10 * MIN, 'sent');
    const open = await inspected(r, 15 * MIN);
    const answered = await submitHumanResponse(r.store, GATED, {
      runId: r.runId,
      gateId: r.gateId,
      choice: 'approve',
      route: 'cli',
    });
    if (answered.status !== 'ok') throw new Error(`fixture: ${answered.status}`);
    const resolved = await inspected(r, 16 * MIN);
    const after = (out: string[], i: number) =>
      out[out.findIndex((l) => l.startsWith('Reminders: ')) + i];
    expect({
      openBefore: after(open, -1)?.trimStart().split(':')[0],
      resolvedBefore: after(resolved, -1)?.split(':')[0],
      resolved: ledgerLines(resolved),
    }).toEqual({
      openBefore: 'To answer',
      resolvedBefore: 'Updated',
      resolved: ['Reminders: 1 sent (of at most 3), last 6m ago (2030-01-01T00:10:00Z)'],
    });
  });

  it('absence: a store with no ledger, and a run with neither an open question nor rows, print no line; an open question with no rows reads `none recorded`', async () => {
    // (a) red when a line is invented (no ledger, nothing to say) or `none recorded` is lost; (b)
    //     prints the lines and rows of each case.
    const clock = settableClock(at(0));
    const noLedger = await waiting(new InMemoryStore({ clock, outbound: null }), clock);
    const empty = await waiting();
    const bare = new InMemoryStore({ clock: settableClock(at(0)) });
    const { record } = await bare.create({ workflowId: GATED.id, workflowVersion: 1, params: {} });
    const bareOut = stripSpanMarks(await inspectRun(record.id, bare, workflowStore)).split('\n');
    expect({
      noLedger: ledgerLines(await inspected(noLedger, 15 * MIN)),
      noLedgerRow: (await listed(noLedger, 15 * MIN)).includes('reminders:'),
      bare: ledgerLines(bareOut),
      empty: ledgerLines(await inspected(empty, 15 * MIN)),
    }).toEqual({ noLedger: [], noLedgerRow: false, bare: [], empty: ['Reminders: none recorded'] });
  });

  it('a read that throws: `inspect` prints no ledger line and nothing else changes; `list` drops the words of that row only', async () => {
    // (a) red when the command fails, prints a line, or another line changes; (b) prints the outputs.
    const r = await waiting();
    await row(r, reminder(r, 1), 10 * MIN, 'sent');
    const other = await waiting(r.store, r.clock);
    const failingFor = (how: 'rejects' | 'throws'): RunStore =>
      Object.create(r.store, {
        outbound: {
          value: {
            ...Object.fromEntries(
              (['lease', 'mark', 'statAllForRun', 'deleteAllForRun'] as const).map((k) => [
                k,
                (...a: never[]) => (r.ledger[k] as (...b: never[]) => unknown)(...a),
              ]),
            ),
            read: (id: string) => {
              if (id !== r.runId) return r.ledger.read(id);
              if (how === 'throws') throw new Error('database disk image is malformed');
              return Promise.reject(new Error('database disk image is malformed'));
            },
          },
        },
      }) as RunStore;
    const noLedger = Object.create(r.store, { outbound: { value: null } }) as RunStore;
    const want = await inspected(r, 15 * MIN, noLedger);
    const got: Record<string, unknown> = {};
    for (const how of ['rejects', 'throws'] as const) {
      const store = failingFor(how);
      got[how] = {
        inspectSame: (await inspected(r, 15 * MIN, store)).join('\n') === want.join('\n'),
        thisRow: (await listed(r, 15 * MIN, store)).includes('reminders:'),
        otherRow: (await listed(other, 15 * MIN, store, other.runId)).endsWith(
          'reminders: none recorded',
        ),
      };
    }
    expect(got).toEqual({
      rejects: { inspectSame: true, thisRow: false, otherRow: true },
      throws: { inspectSame: true, thisRow: false, otherRow: true },
    });
  });

  it('`list`: a `gate_waiting` row carries `reminders: …` and `escalation: …` after the schedule words; a resolved run’s row carries none', async () => {
    // (a) red when a row that is not `gate_waiting` carries the words, the labels are not lowercase,
    //     or the words come before the schedule's; (b) prints both rows.
    const r = await waiting();
    await row(r, reminder(r, 1), 10 * MIN, 'sent');
    await row(r, escalation(r), 12 * MIN, 'sent');
    const open = await listed(r, 15 * MIN);
    await submitHumanResponse(r.store, GATED, {
      runId: r.runId,
      gateId: r.gateId,
      choice: 'approve',
      route: 'cli',
    });
    const resolved = await listed(r, 16 * MIN);
    expect({
      open: open.slice(open.indexOf('next reminder')),
      resolved: /reminders:|escalation:/.test(resolved),
    }).toEqual({
      open: 'next reminder: 2 of 3 scheduled in 5m (2030-01-01T00:20:00Z) (reminders are sent only while a realm agent attends this question, or realm listen --send-reminders is running)  reminders: 1 sent (of at most 3), last 5m ago (2030-01-01T00:10:00Z)  escalation: sent 3m ago (2030-01-01T00:12:00Z)',
      resolved: false,
    });
  });

  it('sent, skipped and not confirmed together, with the escalation: the real `inspect` and `list` output (the page’s example)', async () => {
    // (a) red when one of the three parts is lost or miscounted when they appear together; (b) prints
    //     both outputs (the report quotes them).
    const r = await waiting();
    await row(r, reminder(r, 1), 10 * MIN, 'sent');
    await row(r, escalation(r), 12 * MIN, 'sent');
    await row(r, reminder(r, 3), 30 * MIN); // occurrence 2 skipped; 3 leased, never marked
    const out = await inspected(r, 40 * MIN);
    const line = await listed(r, 40 * MIN);
    // The lines `realm-run-reading.md` shows (docs-597-d1b quotes them).
    expect(
      { inspect: ledgerLines(out), list: line.slice(line.indexOf('  reminders:')) },
      `${out.join('\n')}\n${line}`,
    ).toEqual({
      inspect: [
        'Reminders: 1 sent (of at most 3), last 30m ago (2030-01-01T00:10:00Z); 1 skipped; 1 not confirmed',
        'Escalation: sent 28m ago (2030-01-01T00:12:00Z)',
      ],
      list: '  reminders: 1 sent (of at most 3), last 30m ago (2030-01-01T00:10:00Z); 1 skipped; 1 not confirmed  escalation: sent 28m ago (2030-01-01T00:12:00Z)',
    });
  });
});

// ── Correction 1: the lines are about ONE question ───────────────────────────────────────────────
// The ledger keys a question's rows by its gate id, and `read` returns every row of the run, so a run
// that asks a second question holds the first question's rows too. The lines count the open
// question's rows only; with no question open, the rows of the question that owns the newest row.

/** Two questions in a row, each every 10 min, at most 3. */
const TWO: WorkflowDefinition = loadWorkflowFromString(
  [
    'id: outbound-lines-d1b-two',
    'name: outbound-lines-d1b-two',
    'version: 1',
    'steps:',
    '  q1:',
    '    description: Ask first.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    gate:',
    '      choices: [approve, reject]',
    '      reminder_seconds: 600',
    '      reminder_max: 3',
    '  q2:',
    '    description: Ask again.',
    '    execution: auto',
    '    trust: human_confirmed',
    '    depends_on: [q1]',
    '    gate:',
    '      choices: [approve, reject]',
    '      reminder_seconds: 600',
    '      reminder_max: 3',
  ].join('\n'),
);
const twoStore = {
  async register() {},
  async get() {
    return TWO;
  },
  async list() {
    return [TWO];
  },
};
declareReleaseLine(twoStore);

interface TwoRig {
  readonly clock: SettableClock;
  readonly store: InMemoryStore;
  readonly ledger: OutboundLedger;
  readonly runId: string;
  readonly g1: string;
  readonly g2: string;
}

/** One lease (120 s) at `ms` after T, marked `sent` at the same reading. */
async function sent(r: TwoRig, what: OutboundLeaseRequest['what'], ms: number): Promise<void> {
  await r.clock.set(at(ms));
  const token = `t-${JSON.stringify(what)}-${ms}`;
  const leased = await r.ledger.lease(r.runId, { what, leaseToken: token, leaseSeconds: 120 });
  if (!leased.applied) throw new Error(`fixture: ${leased.reason}`);
  const marked = await r.ledger.mark(r.runId, {
    what,
    leaseToken: token,
    result: 'sent',
    outcome: 'ok',
  });
  if (!marked.applied) throw new Error(`fixture: ${marked.reason}`);
}

/**
 * A run whose first question (opened at T) got reminders 1–3 and the escalation if `g1Rows`, was
 * answered at 35 min, and whose second question opened at 36 min and is open.
 */
async function twoQuestions(g1Rows = true): Promise<TwoRig> {
  const clock = settableClock(at(0));
  const store = new InMemoryStore({ clock });
  const { record } = await store.create({ workflowId: TWO.id, workflowVersion: 1, params: {} });
  const ask = async (step: string): Promise<string> => {
    const r = await executeStep(store, TWO, {
      runId: record.id,
      command: step,
      input: {},
      dispatcher: async () => ({}),
    });
    if (r.status !== 'confirm_required') throw new Error(`fixture: ${step} ${r.status}`);
    return (await store.get(record.id)).record.pending_gate!.gate_id;
  };
  const g1 = await ask('q1');
  const rig = { clock, store, ledger: store.outbound!, runId: record.id, g1, g2: '' };
  if (g1Rows) {
    for (const k of [1, 2, 3])
      await sent(rig, { type: 'reminder', gateId: g1, occurrence: k }, k * 10 * MIN);
    await sent(rig, { type: 'escalation', gateId: g1 }, 30 * MIN);
  }
  await clock.set(at(35 * MIN));
  await answer(store, record.id, g1);
  await clock.set(at(36 * MIN));
  return { ...rig, g2: await ask('q2') };
}

async function answer(store: InMemoryStore, runId: string, gateId: string): Promise<void> {
  const r = await submitHumanResponse(store, TWO, {
    runId,
    gateId,
    choice: 'approve',
    route: 'cli',
  });
  if (r.status !== 'ok') throw new Error(`fixture: ${r.status}`);
}

/** `inspect`'s ledger lines and the line before the first, and `list`'s ledger part, at `ms`. */
async function readTwo(
  r: TwoRig,
  ms: number,
): Promise<{ inspect: string[]; before: string | undefined; list: string }> {
  await r.clock.set(at(ms));
  const out = stripSpanMarks(await inspectRun(r.runId, r.store, twoStore)).split('\n');
  const first = out.findIndex((l) => l.startsWith('Reminders: ') || l.startsWith('Escalation: '));
  const row = stripSpanMarks(
    (await listRuns(undefined, r.store)).split('\n').find((l) => l.includes(r.runId)) ?? '(no row)',
  );
  const i = row.indexOf('  reminders:');
  return {
    inspect: ledgerLines(out),
    before: first > 0 ? out[first - 1]?.trimStart().split(':')[0] : undefined,
    list: i >= 0 ? row.slice(i) : '(no ledger part)',
  };
}

describe('#597 D1b correction 1 — the lines are about one question', () => {
  it('two questions, the second open with only its reminder 3 sent: `inspect` and `list` say the second question’s, and no escalation', async () => {
    // (a) red when the first question's rows are counted too (`4 sent`, an `Escalation:` line from
    //     the first question, `of at most` from its row); (b) prints both reads.
    const r = await twoQuestions();
    await sent(r, { type: 'reminder', gateId: r.g2, occurrence: 3 }, 66 * MIN);
    expect(await readTwo(r, 70 * MIN)).toEqual({
      inspect: ['Reminders: 1 sent (of at most 3), last 4m ago (2030-01-01T01:06:00Z); 2 skipped'],
      before: 'To answer',
      list: '  reminders: 1 sent (of at most 3), last 4m ago (2030-01-01T01:06:00Z); 2 skipped',
    });
  });

  it('the second question open with no rows of its own, the first question’s rows present: `none recorded`', async () => {
    // (a) red when the first question's rows stand in for the open one's; (b) prints both reads.
    const r = await twoQuestions();
    expect(await readTwo(r, 40 * MIN)).toEqual({
      inspect: ['Reminders: none recorded'],
      before: 'To answer',
      list: '  reminders: none recorded',
    });
  });

  it('the same run finished (no question open): the lines are the newest row’s question’s, the second one’s; `list` prints none', async () => {
    // (a) red when a finished run sums both questions' rows, or keeps the first question's; (b)
    //     prints both reads.
    const r = await twoQuestions();
    await sent(r, { type: 'reminder', gateId: r.g2, occurrence: 3 }, 66 * MIN);
    await r.clock.set(at(68 * MIN));
    await answer(r.store, r.runId, r.g2);
    expect(await readTwo(r, 70 * MIN)).toEqual({
      inspect: ['Reminders: 1 sent (of at most 3), last 4m ago (2030-01-01T01:06:00Z); 2 skipped'],
      before: 'Updated',
      list: '(no ledger part)',
    });
  });

  it('a finished run whose rows all belong to its first question (the second got none): the first question’s lines, as they were', async () => {
    // (a) red when a finished run's lines are lost because its last question has no row, or invent
    //     rows for it; (b) prints both reads.
    const r = await twoQuestions();
    await r.clock.set(at(68 * MIN));
    await answer(r.store, r.runId, r.g2);
    expect(await readTwo(r, 70 * MIN)).toEqual({
      inspect: [
        'Reminders: 3 sent (of at most 3), last 40m ago (2030-01-01T00:30:00Z)',
        'Escalation: sent 40m ago (2030-01-01T00:30:00Z)',
      ],
      before: 'Updated',
      list: '(no ledger part)',
    });
  });

  it('the docs’ `list` samples: a waiting row with no authored schedule ends `opened 0s ago (…)  reminders: none recorded`', async () => {
    // (a) red when the waiting row's last part differs from the samples in human-gates.md and
    //     realm-run-reading.md (docs-597-d1b quotes them); (b) prints the row.
    const r = await waiting(undefined, undefined, UNSCHEDULED);
    const row = await listed(r, 0);
    expect(row.slice(row.indexOf('gate: '))).toBe(
      'gate: q opened 0s ago (2030-01-01T00:00:00Z)  reminders: none recorded',
    );
  });

  it('a row whose key does not parse, and a row of a question whose id starts with the open one’s, are not counted', async () => {
    // (a) red when the question is matched by prefix (`startsWith`), or an unparsable key is read;
    //     (b) prints the lines.
    const { rowsOfOneQuestion, outboundWords } = await import('../lib/outbound-words.js');
    const view = (entry_key: string, occurrence: number) => ({
      entry_key,
      type: 'reminder' as const,
      occurrence,
      of_max: 3,
      status: 'sent' as const,
      lease_deadline: '2030-01-01T00:12:00.000Z',
      attempts: 1,
      sent_at: '2030-01-01T00:10:00.000Z',
      created_at: '2030-01-01T00:10:00.000Z',
    });
    const rows = [
      view('gate:g-1:reminder:1', 1),
      view('gate:g-10:reminder:2', 2),
      view('gate:g-1:reminder:x', 3),
      view('not-a-key', 3),
    ];
    const open = rowsOfOneQuestion(rows, 'g-1');
    const newest = rowsOfOneQuestion([...rows, view('gate:g-10:escalationx', 4)], undefined);
    expect({
      open: open.map((row) => row.entry_key),
      words: outboundWords(open, at(70 * MIN), true).reminders,
      newest: newest.map((row) => row.entry_key),
    }).toEqual({
      open: ['gate:g-1:reminder:1'],
      words: '1 sent (of at most 3), last 1h 0m ago (2030-01-01T00:10:00Z)',
      // the newest parsable row is `gate:g-10:reminder:2`: its question's rows only
      newest: ['gate:g-10:reminder:2'],
    });
  });
});
