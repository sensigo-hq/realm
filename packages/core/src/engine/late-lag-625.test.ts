// late-lag-625.test.ts — issue #625 PR-2a, the last prompt's F1 (framework blocker: shipped strength
// A.3 #5, "the expiry receipt names the enactor and the lag"): every call that carries out an expired
// question's `on_expiry` says how long before it the question's time was up, through core's one
// duration formatter, and every late answer's reply carries the fact typed (`error_details.expired_at`
// and `overdue_ms`).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../index.js';
import { advanceRun, executeStep, submitHumanResponse } from './execution-loop.js';
import { InMemoryStore, settableClock, type SettableClock } from '@sensigo/realm-testing';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import { zOf } from '../test-support/instant.js';

/** #715 (b) (01 §C.4): the store's clock decides what is due — an in-memory store on a settable
 *  clock, first set to the host's reading, which `setClockOf` moves. */
function clockedStore(): InMemoryStore {
  return new InMemoryStore({ clock: settableClock(new Date()) });
}
async function setClockOf(store: object, t: Date): Promise<void> {
  const clock = (store as { clock?: Partial<SettableClock> }).clock ?? {};
  if (typeof clock.set !== 'function')
    throw new Error('setClockOf: this store has no settable clock');
  await clock.set(t);
}

const CHANGELOG = join(dirname(fileURLToPath(import.meta.url)), '../../../../CHANGELOG.md');

/** (a) red when the CHANGELOG no longer holds the sentence word for word; (b) prints it. */
function changelogSays(sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(CHANGELOG, 'utf8')),
    `CHANGELOG.md no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

/** `q` (a question, 60 s, `on_expiry` as given, default `approve`), then `after` (`auto`). */
function gated(onExpiry: 'settle_default' | 'abort'): WorkflowDefinition {
  return {
    id: `lag-${onExpiry}`,
    name: 'lag',
    version: 1,
    steps: {
      q: {
        description: 'Ask.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          timeout_seconds: 60,
          on_expiry: onExpiry,
          ...(onExpiry === 'settle_default' ? { default_choice: 'approve' } : {}),
        },
      },
      after: { description: 'After.', execution: 'auto', depends_on: ['q'] },
    },
  };
}

describe('#625 PR-2a, F1 — the late answer says how late it was', () => {
  let store: InMemoryStore;
  beforeEach(async () => {
    store = clockedStore();
  });

  /** A run at its question; `at(ms)` is the instant `ms` after the question's time was up. */
  async function atQuestion(d: WorkflowDefinition) {
    const { record: run } = await store.create({
      workflowId: d.id,
      workflowVersion: 1,
      params: {},
    });
    const opened = await executeStep(store, d, {
      runId: run.id,
      command: 'q',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    const gate = (await store.get(run.id)).record.pending_gate!;
    const expiresAt = gate.expires_at!;
    const at = (ms: number) => new Date(new Date(expiresAt).getTime() + ms);
    return { runId: run.id, gateId: gate.gate_id, expiresAt, at };
  }

  it('the one formatter: seconds under a minute (never 0m), then minutes, hours and minutes, days and hours; a negative duration is 0s', () => {
    changelogSays(
      "The expiry line says how long before the call the question's time was up — `had expired 15s before this call`, in seconds under a minute, then minutes, hours and days — on every call that carries an expiry out",
    );
    changelogSays('Core exports the one formatter, `formatDuration`.');
    const cases: Array<[number, string]> = [
      [-5_000, '0s'],
      [0, '0s'],
      [15_000, '15s'],
      [59_999, '59s'],
      [60_000, '1m'],
      [3_599_999, '59m'],
      [3_600_000, '1h 0m'],
      [86_399_999, '23h 59m'],
      [86_400_000, '1d 0h'],
      [3 * 86_400_000 + 5 * 3_600_000, '3d 5h'],
    ];
    // (a) red when core exports no `formatDuration`, or a form changes (`0m` under a minute, as the
    //     older formatters say); (b) prints each duration with what it was written as.
    const format = (core as { formatDuration?: (ms: number) => string }).formatDuration;
    expect(cases.map(([ms]) => [ms, format?.(ms) ?? '<no formatDuration>'])).toEqual(cases);
  });

  it.each([
    ['settle_default', 'approve', 'ok'],
    ['settle_default', 'reject', 'error'],
    ['abort', 'approve', 'error'],
  ] as const)(
    'submitHumanResponse, %s, the answer %s: the line names the call and the lag (15s); the expiry receipt carries expired_at and the lag (#729 PR-0, T-2: no longer error_details) — on both store kinds',
    async (onExpiry, choice, status) => {
      changelogSays(
        "A late answer's expiry is the reply's `expiry` receipt (`ExpiryReceipt`: `gate_id`, `step`, `on_expiry`, `choice`, `enacted_via`, `by_this_call`, `expired_at`, `overdue`); `error_details` no longer carries `expired_at` or `overdue_ms`.",
      );
      // #715 (b): the legacy store kind (no `settleStep`) is gone — one kind left.
      for (const legacy of [false]) {
        const d = gated(onExpiry);
        const { runId, gateId, expiresAt, at } = await atQuestion(d);
        await setClockOf(store, at(15_000));
        const reply = await submitHumanResponse(store, d, {
          runId,
          gateId,
          choice,
        });
        const did =
          onExpiry === 'settle_default'
            ? "settle_default: the default choice 'approve' was recorded"
            : 'abort: the run ended';
        // (a) red when the line drops the lag, says it in minutes (`0m`), or the reply does not carry
        //     the question's `expires_at` and the lag in milliseconds; (b) prints the line and fields.
        expect({
          legacy,
          status: reply.status,
          line: reply.warnings[0],
          expired_at: reply.expiry?.expired_at,
          overdue: reply.expiry?.overdue,
          details: [reply.error_details?.['expired_at'], reply.error_details?.['overdue_ms']],
        }).toEqual({
          legacy,
          status,
          line: `gate '${gateId}' on 'q' had expired 15s before this call (deadline ${zOf(expiresAt)}) — this submitHumanResponse call first carried out its declared ${did} (enacted_via: submitHumanResponse).`,
          expired_at: expiresAt,
          overdue: { ms: 15_000 },
          details: [undefined, undefined],
        });
      }
    },
  );

  // #715 (b), Q-1 (MA 3, 2026-10-30): the race the deleted cell named ("the race: a late answer
  // whose own expiry write found the question already settled names the lag to THIS call, and
  // another call") had a window between two writes; with the late answer in one write (01 A.8
  // (iii)) the same situation is another process carrying the expiry out BEFORE this answer's one
  // write, and the answer meets an already-settled question. Pinned as the build says it (verify-
  // first); NAMED DIVERGENCE from the old line, which said `… had expired 42s before this call —
  // another call had already carried out its declared settle_default: …`: no `warnings` line, no
  // `expiry` receipt — the reply's `outcome` and hint carry it (MA 3 decides: report, divergence 10).
  it.each([
    [
      'settle_default',
      'approve',
      'ok',
      undefined,
      false,
      { kind: 'timeout' },
      'the outcome matches your choice, but it was settled by timeout; your response was not recorded.',
    ],
    [
      'settle_default',
      'reject',
      'error',
      'STATE_BLOCKED',
      false,
      { kind: 'timeout' },
      "Gate '<g>' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.",
    ],
    // Amendment 3: the abort row — the run the expiry ended answers as any ended run does; #729
    // PR-6a (B2 (3)): with what the question met — its expiry (`outcome`), and the answer not
    // recorded — as the reply of the call that carried the abort out says.
    [
      'abort',
      'approve',
      'error',
      'STATE_RUN_TERMINAL',
      false,
      { kind: 'timeout' },
      "Run '<r>' is terminal (aborted); cannot submit a gate response — an aborted run is never resumed; 'realm run purge <r>' previews what it would remove.",
    ],
  ] as const)(
    "an answer that reaches a question another process already expired (%s gate, answered '%s'): %s, not recorded, no expiry receipt and no expiry line",
    async (onExpiry, choice, status, code, recorded, by, hint) => {
      const d = gated(onExpiry);
      const { runId, gateId, at } = await atQuestion(d);
      await setClockOf(store, at(42_000));
      let fired = false;
      const racing = new Proxy(store, {
        get(target, prop) {
          if (prop === 'settleStep') {
            return async (...a: Parameters<InMemoryStore['settleStep']>) => {
              if (!fired && a[1].kind === 'settle_gate') {
                fired = true; // another process's expire_gate write lands first
                await target.settleStep(a[0], { kind: 'expire_gate', gateId }, a[2]);
              }
              return target.settleStep(...a);
            };
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
        },
      });
      const reply = await submitHumanResponse(racing, d, { runId, gateId, choice });
      // (a) red when the answer is recorded over the expired question, the settle is not said to be
      //     the timeout's, the ended run is not refused as ended, or an expiry line/receipt appears;
      //     (b) prints the reply's fields.
      expect({
        status: reply.status,
        error_code: reply.error_code,
        answer_recorded: reply.answer_recorded,
        by: reply.outcome?.by,
        warnings: reply.warnings,
        expiry: reply.expiry,
        hint: reply.context_hint?.replace(gateId, '<g>').replaceAll(runId, '<r>'),
      }).toEqual({
        status,
        error_code: code,
        answer_recorded: recorded,
        by,
        warnings: [],
        expiry: undefined,
        hint,
      });
    },
  );

  it.each([
    ['advanceRun', 59_000, '59s'],
    ['executeStep', 61_000, '1m'],
    ['advanceRun', 2 * 3_600_000 + 7 * 60_000, '2h 7m'],
  ] as const)(
    '%s carries out an expired question %ims late: its line says %s',
    async (entry, lateBy, words) => {
      changelogSays(
        "now reads `gate '<g>' on '<s>' had expired <how long> before this call — this <call> call first carried out its declared settle_default: the default choice '<c>' was recorded (enacted_via: <via>).`",
      );
      const d = gated('settle_default');
      const { runId, gateId, at } = await atQuestion(d);
      await setClockOf(store, at(lateBy));
      const reply =
        entry === 'advanceRun'
          ? await advanceRun(store, d, { runId })
          : await executeStep(store, d, {
              runId,
              command: 'after',
              input: {},
              dispatcher: async () => ({}),
            });
      // (a) red when the call's line drops the lag or writes it in another form; (b) prints the
      //     reply's expiry lines.
      expect(reply.warnings.filter((w) => w.includes('had expired'))).toEqual([
        `gate '${gateId}' on 'q' had expired ${words} before this call (deadline ${zOf(at(0))}) — this ${entry} call first carried out its declared settle_default: the default choice 'approve' was recorded (enacted_via: ${entry}).`,
      ]);
    },
  );
});
