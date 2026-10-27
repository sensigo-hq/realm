// person-notice.test.ts — #729 PR-4 (02; 04 "The notice"): the asked person's notice — its type
// witness (G9: the person's route only), `composePersonNotice` per kind, and `durationWords`, the one
// duration producer on core's instant helpers. Every value is a fake. Each assertion names (a) the
// change that turns it red and (b) what it prints when it fails: texts, kinds, booleans.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composePersonNotice, durationWords, type PersonNotice } from './person-notice.js';
import { outcomeOf } from './execution-loop.js';
import { respondWayOfGate, type AdvanceWay, type RespondWay } from './ways.js';
import type { QuestionView } from './question-view.js';
import type { PendingGate, RunRecord } from '../types/run-record.js';

const gate: PendingGate = {
  gate_id: 'g-1',
  step_name: 'review',
  preview: { s: 1 },
  choices: ['approve', 'reject'],
  opened_at: '2026-10-26T10:00:00.000Z',
  owner: '@alex',
  expires_at: '2026-10-26T11:00:00.000Z',
  on_expiry: 'settle_default',
  default_choice: 'reject',
  resolution_messages: { approve: 'Approved — shipping.' },
};
const view: QuestionView = {
  question_text: 'Ship it?',
  preview_text: '{}',
  preview_format: 'json',
  choices: ['approve', 'reject'],
};
const respond: RespondWay = {
  ...respondWayOfGate('r-1', gate),
  proof: { claim_token: 'FAKE-token' },
};
const at = (iso: string) => new Date(iso);

/** Records for `outcomeOf`: answered by another, expired with a default, cancelled by an abort. */
const record = (over: Partial<RunRecord>): RunRecord =>
  ({ id: 'r-1', evidence: [], ...over }) as unknown as RunRecord;
const ANSWERED = record({
  evidence: [
    {
      step_id: 'review',
      kind: 'gate_response',
      completed_at: '2026-10-26T10:05:00.000Z',
      responded_by: 'sam',
      output_summary: { choice: 'approve' },
    },
  ] as unknown as RunRecord['evidence'],
  settled: { review: { outcome: 'gate', choice: 'approve', resolved_by: 'human' } } as never,
});
const EXPIRED = record({
  settled: { review: { outcome: 'gate', choice: 'reject', resolved_by: 'timeout' } } as never,
});
const CANCELLED = record({
  evidence: [
    {
      step_id: 'review',
      completed_at: '2026-10-26T10:06:00.000Z',
      output_summary: { gate_cancelled_by_abort: true },
    },
  ] as unknown as RunRecord['evidence'],
  skip_details: { review: { kind: 'gate_cancelled_by_abort' } } as never,
  aborted_at: { step_id: 'guard' } as never,
});
const outcome = (r: RunRecord, attempted: boolean) =>
  outcomeOf(r, 'review', gate.expires_at, attempted);

describe('#729 PR-4 — the notice carries the person’s route only (G9)', () => {
  it('type witness: a notice’s route is the respond way without its proof; no operator way enters', () => {
    type RouteOf<N> = N extends { respond: infer R } ? R : never;
    type Route = RouteOf<PersonNotice>;
    const exact: [Route] extends [Omit<RespondWay, 'proof'>]
      ? [Omit<RespondWay, 'proof'>] extends [Route]
        ? true
        : false
      : false = true;
    const advance = {
      verb: 'advance',
      conditions: [],
      run_id: 'r-1',
      owed: [],
    } as unknown as AdvanceWay;
    // @ts-expect-error — an operator way (advance) is not the person's route.
    const operator: Route = advance;
    // (a) red when a notice's route admits another way (the type widens: typecheck red) or keeps the
    //     proof; (b) prints the boolean.
    expect({ exact, operator: operator !== undefined }).toEqual({ exact: true, operator: true });
  });

  it('source: person-notice.ts imports no way type but RespondWay', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'person-notice.ts'),
      'utf8',
    );
    const imported = [...source.matchAll(/import type \{([^}]*)\} from '\.\/ways\.js'/g)]
      .flatMap((m) => m[1]!.split(','))
      .map((name) => name.trim())
      .filter((name) => /Way$/.test(name));
    // (a) red when another way type is imported (an operator way can then enter a notice); (b)
    //     prints the names.
    expect(imported).toEqual(['RespondWay']);
  });
});

describe('#729 PR-4 — composePersonNotice, per kind', () => {
  it('question_opened: the view, the route without its proof, the deadline and the owner', () => {
    const n = composePersonNotice({ kind: 'question_opened', run_id: 'r-1', gate, view, respond });
    // (a) red when a field is dropped or the proof rides the notice; (b) prints the fields.
    expect({
      kind: n.kind,
      view: n.kind === 'question_opened' && n.view === view,
      proof: 'proof' in (n as { respond: object }).respond,
      expires: (n as { expires_at?: string }).expires_at,
      owner: (n as { owner?: string }).owner,
    }).toEqual({
      kind: 'question_opened',
      view: true,
      proof: false,
      expires: gate.expires_at,
      owner: '@alex',
    });
  });

  it("reminder: count, elapsed (formatDuration's form), owner and escalation", () => {
    const n = composePersonNotice({
      kind: 'reminder',
      run_id: 'r-1',
      gate,
      view,
      respond,
      scheduled_at: '2026-10-26T10:12:00.000Z',
      count: 2,
      escalation: true,
      now: at('2026-10-26T11:05:30.000Z'),
    });
    // (a) red when a field is dropped or the elapsed span is computed elsewhere; (b) prints them.
    expect(n).toMatchObject({
      kind: 'reminder',
      count: 2,
      elapsed: '1h 5m',
      owner: '@alex',
      escalation: true,
    });
  });

  it('expiry_reminder: the on_expiry it carries, the overdue span; `none` when the gate declares none', () => {
    const now = at('2026-10-26T11:00:42.000Z');
    const n = composePersonNotice({
      kind: 'expiry_reminder',
      run_id: 'r-1',
      gate,
      view,
      respond,
      now,
    });
    const none = composePersonNotice({
      kind: 'expiry_reminder',
      run_id: 'r-1',
      gate: { ...gate, on_expiry: undefined },
      view,
      respond,
      now,
    });
    // (a) red when on_expiry or the overdue span is mapped wrong; (b) prints the pairs.
    expect([
      (n as { on_expiry: string }).on_expiry,
      (n as { overdue?: string }).overdue,
      (none as { on_expiry: string }).on_expiry,
    ]).toEqual(['settle_default', '42s', 'none']);
  });

  it('answer_recorded: the resolution message when the run goes on; none when the answer ended it', () => {
    const on = composePersonNotice({
      kind: 'answer_recorded',
      run_id: 'r-1',
      gate,
      choice: 'approve',
      ended: false,
    });
    const ended = composePersonNotice({
      kind: 'answer_recorded',
      run_id: 'r-1',
      gate,
      choice: 'approve',
      ended: true,
    });
    // (a) red when run_goes_on is read wrong or the message rides an ended run; (b) prints them.
    expect(
      [on, ended].map((n) => [
        (n as { run_goes_on: boolean }).run_goes_on,
        (n as { resolution_message?: string }).resolution_message,
      ]),
    ).toEqual([
      [true, 'Approved — shipping.'],
      [false, undefined],
    ]);
  });

  it('answer_late: the Outcome outcomeOf reads off a settled record — answered by another, expired with a default, cancelled by an abort', () => {
    const kinds = [ANSWERED, EXPIRED, CANCELLED].map((r) => {
      const n = composePersonNotice({
        kind: 'answer_late',
        run_id: 'r-1',
        gate,
        choice: 'reject',
        outcome: outcome(r, true)!,
        ended: r === CANCELLED,
      });
      const o = (n as { outcome: { by: { kind: string; name?: string }; choice?: string } })
        .outcome;
      return [
        o.by.kind,
        o.choice ?? null,
        o.by.name ?? null,
        (n as { run_goes_on: boolean }).run_goes_on,
      ];
    });
    // (a) red when the outcome is not passed through, or run_goes_on is read wrong; (b) prints them.
    expect(kinds).toEqual([
      ['answer', 'approve', 'sam', true],
      ['timeout', 'reject', null, true],
      ['engine', null, null, false],
    ]);
  });

  it('answer_refused: the code', () => {
    const n = composePersonNotice({
      kind: 'answer_refused',
      run_id: 'r-1',
      gate,
      choice: 'approve',
      code: 'STATE_RUN_TERMINAL',
    });
    // (a) red when the code is dropped; (b) prints it.
    expect((n as { code: string }).code).toBe('STATE_RUN_TERMINAL');
  });

  it('question_closed: `how` from outcomeOf — expired, abandoned, superseded with its choice; an unsettled ending is abandoned', () => {
    const hows = [EXPIRED, CANCELLED, ANSWERED, record({})].map((r) => {
      const n = composePersonNotice({
        kind: 'question_closed',
        run_id: 'r-1',
        gate,
        outcome: outcome(r, false),
      });
      return [(n as { how: string }).how, (n as { choice?: string }).choice ?? null];
    });
    // (a) red when a `how` is mapped wrong (a timeout read as abandoned); (b) prints the pairs.
    expect(hows).toEqual([
      ['expired', null],
      ['abandoned', null],
      ['superseded', 'approve'],
      ['abandoned', null],
    ]);
  });
});

describe('#729 PR-4 — durationWords (PD-7)', () => {
  const now = at('2026-10-26T12:00:00.000Z');
  it('a deadline, through overdueOf: not yet past is undefined; 90 seconds past reads `1m`', () => {
    // (a) red when overdueOf is replaced by a subtraction (`0s` on the deadline ahead); (b) prints
    //     the two readings. formatDuration rounds a span past a minute down to whole minutes.
    expect([
      durationWords('2026-10-26T12:00:01.000Z', 'deadline', now),
      durationWords('2026-10-26T11:58:30.000Z', 'deadline', now),
    ]).toEqual([undefined, '1m']);
  });

  it('a past event, through readInstant: one cell per text form — `1h 5m`, `12m`, `42s`', () => {
    // (a) red when the span is formatted by anything but formatDuration; (b) prints the readings.
    expect([
      durationWords('2026-10-26T10:55:00.000Z', 'past_event', now),
      durationWords('2026-10-26T11:48:00.000Z', 'past_event', now),
      durationWords('2026-10-26T11:59:18.000Z', 'past_event', now),
    ]).toEqual(['1h 5m', '12m', '42s']);
  });

  it('undefined, never `NaN` or `0s`: an unparseable stamp, a past event stamped ahead (ahead_ms), one 1 s ahead', () => {
    // (a) red when Date.parse is used unchecked (`NaNs`) or the ahead case is formatted (`0s`); (b)
    //     prints the readings.
    expect([
      durationWords('not a time', 'past_event', now),
      durationWords('2026-10-26T12:10:00.000Z', 'past_event', now),
      durationWords('2026-10-26T12:00:01.000Z', 'past_event', now),
      durationWords('not a time', 'deadline', now),
    ]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('never throws: garbage in, undefined out', () => {
    // (a) red when anything throws (a host timer's throw ends the attending process); (b) prints the
    //     readings.
    expect([
      durationWords(undefined as unknown as string, 'past_event', now),
      durationWords('2026-10-26T10:00:00.000Z', 'past_event', new Date('garbage')),
      durationWords({} as unknown as string, 'deadline', now),
    ]).toEqual([undefined, undefined, undefined]);
  });
});
