// Tests for diffRuns, diffReplays, and isReplayId business logic.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { captureEvidence } from '@sensigo/realm';
import { diffRuns, diffReplays, diffSymbol, isReplayId } from './diff.js';
import type { RunRecord, EvidenceSnapshot } from '@sensigo/realm';
import type { ReplayRecord } from '../store/replay-store.js';

function makeSnap(
  stepId: string,
  hash: string,
  status: 'success' | 'error' | 'skipped' = 'success',
  durationMs = 100,
  output: Record<string, unknown> = {},
): EvidenceSnapshot {
  return {
    step_id: stepId,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:00:01.000Z',
    duration_ms: durationMs,
    input_summary: {},
    output_summary: output,
    status,
    evidence_hash: hash,
  };
}

function makeRun(evidence: EvidenceSnapshot[], workflowId = 'wf1'): RunRecord {
  return {
    id: 'run_' + Math.random().toString(36).slice(2),
    workflow_id: workflowId,
    workflow_version: 1,
    version: 1,
    params: {},
    evidence,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:01.000Z',
    terminal_state: true,
    // The DAG step sets + derived phase are required on RunRecord (they replaced the old scalar
    // `state` field this fixture still carried). diffRuns reads only `evidence`, so they are inert
    // here — present so the fixture is a structurally valid completed run.
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'completed',
  };
}

describe('diffRuns', () => {
  it('two identical runs produce all same_output: true rows', () => {
    const evidence = [makeSnap('step_a', 'hash1'), makeSnap('step_b', 'hash2')];
    const runA = makeRun(evidence);
    const runB = makeRun(evidence);
    const rows = diffRuns(runA, runB);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.same_output)).toBe(true);
    expect(rows.every((r) => r.same_status)).toBe(true);
  });

  it('steps with different outputs show same_output: false', () => {
    // fix-run-diff-field-order: the mark reads the outputs, so step_b's two outputs differ (they
    // were both `{}` and differed only by their hash strings). (a) red when same_output is true for
    // any two present steps (both present only); (b) prints the boolean.
    const runA = makeRun([
      makeSnap('step_a', 'hashA'),
      makeSnap('step_b', 'hashB1', 'success', 100, { v: 1 }),
    ]);
    const runB = makeRun([
      makeSnap('step_a', 'hashA'),
      makeSnap('step_b', 'hashB2', 'success', 100, { v: 2 }),
    ]);
    const rows = diffRuns(runA, runB);
    expect(rows.find((r) => r.step_id === 'step_a')!.same_output).toBe(true);
    expect(rows.find((r) => r.step_id === 'step_b')!.same_output).toBe(false);
  });

  it('step present in A but missing from B shows status_b: missing', () => {
    const runA = makeRun([makeSnap('step_a', 'hashA'), makeSnap('step_b', 'hashB')]);
    const runB = makeRun([makeSnap('step_a', 'hashA')]);
    const rows = diffRuns(runA, runB);
    const stepBRow = rows.find((r) => r.step_id === 'step_b');
    expect(stepBRow).toBeDefined();
    expect(stepBRow!.status_b).toBe('missing');
    expect(stepBRow!.same_output).toBe(false);
  });

  it('different workflow IDs: diff still returns rows (does not throw)', () => {
    const runA = makeRun([makeSnap('step_a', 'hashX')], 'workflow-1');
    const runB = makeRun([makeSnap('step_a', 'hashX')], 'workflow-2');
    const rows = diffRuns(runA, runB);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.same_output).toBe(true);
  });
});

describe('fix-run-diff-field-order — realm run diff compares the outputs, in any field order', () => {
  const at = (stepId: string, output: Record<string, unknown>) =>
    captureEvidence({
      stepId,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      completedAt: new Date('2026-01-01T00:00:01.000Z'),
      input: {},
      output,
    });

  it('C1: the same output with its fields in another order, nested included — the stored hashes differ, and the step reads the same', () => {
    const a = at('step_a', { zeta: 1, rent: 1200, tenant: 'A', terms: { a: 1, b: 2 } });
    const b = at('step_a', { tenant: 'A', terms: { b: 2, a: 1 }, rent: 1200, zeta: 1 });
    const row = diffRuns(makeRun([a]), makeRun([b]))[0]!;
    // (a) red: `hashesDiffer` when the hash ignores field order (#840) — the docs' hash sentence
    //     ("can have a different hash") must change with it; `sameOutput` when the mark compares the
    //     stored hashes again; (b) prints the two 8-character prefixes and the boolean.
    expect({
      hashes: [a.evidence_hash.slice(0, 8), b.evidence_hash.slice(0, 8)],
      hashesDiffer: a.evidence_hash !== b.evidence_hash,
      sameOutput: row.same_output,
    }).toEqual({
      hashes: [a.evidence_hash.slice(0, 8), b.evidence_hash.slice(0, 8)],
      hashesDiffer: true,
      sameOutput: true,
    });
  });

  it('C2: a list keeps its order — `{v:[1,2]}` and `{v:[2,1]}` are different outputs', () => {
    const rows = diffRuns(
      makeRun([makeSnap('step_a', 'h', 'success', 100, { v: [1, 2] })]),
      makeRun([makeSnap('step_a', 'h', 'success', 100, { v: [2, 1] })]),
    );
    // (a) red when the comparison sorts lists; (b) prints the boolean.
    expect(rows[0]!.same_output).toBe(false);
  });

  it('C3: outputs that differ in one value but carry the same stored hash string are different — the mark reads the outputs, not the hashes', () => {
    const rows = diffRuns(
      makeRun([makeSnap('step_a', 'samehash', 'success', 100, { rent: 1200 })]),
      makeRun([makeSnap('step_a', 'samehash', 'success', 100, { rent: 1300 })]),
    );
    // (a) red when the mark compares the stored hashes; (b) prints the boolean.
    expect(rows[0]!.same_output).toBe(false);
  });

  it("C4: values compare strictly — `{n:1}` and `{n:'1'}` are different outputs", () => {
    const rows = diffRuns(
      makeRun([makeSnap('step_a', 'h', 'success', 100, { n: 1 })]),
      makeRun([makeSnap('step_a', 'h', 'success', 100, { n: '1' })]),
    );
    // (a) red when the comparison is loose (node:assert's deepEqual takes 1 for '1'); (b) prints
    //     the boolean.
    expect(rows[0]!.same_output).toBe(false);
  });

  it('C5: the reading reference says what the mark and the hash columns compare — each sentence executed by the cell named beside it', () => {
    const page = readFileSync(
      fileURLToPath(
        new URL('../../../../docs/reference/cli/realm-run-reading.md', import.meta.url),
      ),
      'utf8',
    ).replace(/\s+/g, ' ');
    // "the fields in any order": C1; "a list's items in the same order": C2; "`≠` if not" and
    // "blank if the step is missing from either run": C6; the error and the answer: D1–D12
    // (fix-run-diff-errors-answers re-pin: was "…a list's items in the same order), `≠` if not, …").
    // (a) red when the page no longer says it word for word; (b) prints which sentence is missing.
    expect(
      page.includes(
        "`=` if the step has the same status and the same output in both runs (the same fields and values, the fields in any order, a list's items in the same order) and, for a step that failed, the same error message, and for a step with a question, the same last answer — the same choice, both answered or both settled by the gate's expiry (who answered is not compared), or, with no answer, both still open or both ended by an `on_expiry: abort` expiry — `≠` if not, and blank if the step is missing from either run.",
      ),
      'realm-run-reading.md no longer says what the mark compares',
    ).toBe(true);
    // "can have a different hash": C1's hash half. (a) red when the page no longer says it word for
    // word; (b) prints which sentence is missing.
    expect(
      page.includes(
        "The first 8 characters of the hash of the step's output as recorded. The same output with its fields in another order can have a different hash, so the mark between the status columns, not the hashes, compares the outputs.",
      ),
      'realm-run-reading.md no longer says what the hash columns hold',
    ).toBe(true);
  });

  it('C6: the mark — blank for a step missing from either run; `=` for the same output and status; `≠` for another status or another output', () => {
    const row = (over: Partial<Parameters<typeof diffSymbol>[0]>) =>
      diffSymbol({
        step_id: 's',
        status_a: 'success',
        status_b: 'success',
        hash_a: 'a',
        hash_b: 'b',
        duration_a_ms: 0,
        duration_b_ms: 0,
        same_output: true,
        same_status: true,
        // fix-run-diff-errors-answers re-pin: the row's two new parts, both the same here
        same_error: true,
        same_answer: true,
        ...over,
      });
    // (a) red: `missing` when a missing step is marked; `otherStatus` when the mark reads the output
    //     alone; `otherError`/`otherAnswer` when the mark leaves the error or the answer out; (b)
    //     prints each mark (≠ may carry its colour codes, so it is asserted as contained).
    expect({
      missing: row({ status_b: 'missing', same_status: false, same_output: false }),
      same: row({}),
      otherStatus: row({ status_b: 'error', same_status: false }).includes('\u2260'),
      otherOutput: row({ same_output: false }).includes('\u2260'),
      otherError: row({ same_error: false }).includes('\u2260'),
      otherAnswer: row({ same_answer: false }).includes('\u2260'),
    }).toEqual({
      missing: ' ',
      same: '=',
      otherStatus: true,
      otherOutput: true,
      otherError: true,
      otherAnswer: true,
    });
  });
});

describe('fix-run-diff-errors-answers — a failed step’s message and a question’s answer are compared', () => {
  // Real entries, their fields copied from the e2e runs of 2026-10-21 (plans/hash-order/diff-audit2:
  // fail2 g1/g2, gate gs/gd, gs2/gs3, gate3 xa/xs/xw, gate4 xd/xds, abort ab1); the host's login in
  // `driven_by` is written `agent@host`. What a failing assertion prints: step IDs, statuses, kinds,
  // booleans and marks — never an error message's text.
  const AGENT = { by: 'agent@host', by_source: 'derived', channel: 'agent' } as const;
  const RESPOND = { ...AGENT, channel: 'respond' } as const;
  /** fail2's `work` entry: a handler that threw, `output_summary: {}`, the message in `error`. */
  const failedWork = (error: string): EvidenceSnapshot => ({
    step_id: 'work',
    started_at: '2026-10-21T15:13:41.069Z',
    completed_at: '2026-10-21T15:13:41.070Z',
    duration_ms: 1,
    input_summary: { tenant: 'A' },
    output_summary: {},
    status: 'error',
    error,
    evidence_hash: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
    diagnostics: { input_token_estimate: 4, precondition_trace: [] },
    effective_timeout_seconds: 3600,
    driven_by: AGENT,
  });
  /** The gate step's own entry, written when its question is put: the output copied from `draft`. */
  const reviewPut: EvidenceSnapshot = {
    step_id: 'review',
    started_at: '2026-10-21T15:13:42.522Z',
    completed_at: '2026-10-21T15:13:42.522Z',
    duration_ms: 0,
    input_summary: {},
    output_summary: { tenant: 'A', rent: 1200 },
    status: 'success',
    evidence_hash: '49265beff70e15df5fd5a3559b6eae6ff70f2cff6bb34fa67bb312797340c5d5',
    diagnostics: { input_token_estimate: 1, precondition_trace: [] },
    effective_timeout_seconds: 3600,
    driven_by: AGENT,
    output_source: 'dependency',
  };
  /** An answer `realm run respond` wrote (gs, gd; gs2/gs3 with `--by`). */
  const answered = (choice: string, respondedBy?: string): EvidenceSnapshot => ({
    step_id: 'review',
    started_at: '2026-10-21T15:13:42.522Z',
    completed_at: '2026-10-21T15:13:43.432Z',
    duration_ms: 910,
    input_summary: { choice },
    output_summary: { tenant: 'A', rent: 1200, choice },
    status: 'success',
    evidence_hash:
      choice === 'send'
        ? '311c2a0ef78163fec9fa5c13f86ccaf8d2ef50e5bbe05ec07f0cc3887a0eb149'
        : '1db384be91d5467a75b28746e5729e171a52a3580120f2bfb27db3f1fc3d7ff3',
    kind: 'gate_response',
    gate_message: 'Send the draft?',
    ...(respondedBy !== undefined ? { responded_by: respondedBy } : {}),
    answer: { route: 'cli' },
    driven_by: RESPOND,
    principal: { absent: 'not_a_server_door' },
    claim_proof: { proof: 'absent' },
  });
  /** gate4 xd: `send` settled by the gate's expiry (`on_expiry` with a default choice). */
  const settledSend: EvidenceSnapshot = {
    step_id: 'review',
    started_at: '2026-10-21T15:14:05.820Z',
    completed_at: '2026-10-21T15:14:07.821Z',
    duration_ms: 2001,
    input_summary: { choice: 'send' },
    output_summary: { tenant: 'A', rent: 1200, choice: 'send' },
    status: 'success',
    evidence_hash: '311c2a0ef78163fec9fa5c13f86ccaf8d2ef50e5bbe05ec07f0cc3887a0eb149',
    kind: 'gate_response',
    gate_message: 'Send the draft?',
    responded_by: 'timeout',
    resolution: 'expired_default',
  };
  /** gate3 xa: the entry an `on_expiry: abort` expiry writes (not an answer). */
  const abortExpiry: EvidenceSnapshot = {
    step_id: 'review',
    started_at: '2026-10-21T15:13:57.860Z',
    completed_at: '2026-10-21T15:13:59.862Z',
    duration_ms: 2002,
    input_summary: {},
    output_summary: { gate_expired: true, disposition: 'abort' },
    status: 'success',
    evidence_hash: 'c3a84d8f89c92e32f6baa4b214a089a2ec332b32fd826ad08a08fed085a649c7',
    kind: 'gate_response',
    gate_message: 'Send the draft?',
    responded_by: 'timeout',
    resolution: 'expired_abort',
  };
  /** A gate run: `draft` (as the base fixtures write it), the question's entries, and, for xa, the
   *  record's own skip facts. */
  const gateRun = (entries: EvidenceSnapshot[], over: Partial<RunRecord> = {}): RunRecord => ({
    ...makeRun([makeSnap('draft', 'hd'), reviewPut, ...entries], 'gap-gate'),
    ...over,
  });
  const ENDED_BY_EXPIRY: Partial<RunRecord> = {
    skip_details: {
      review: { kind: 'gate_expired', gate_id: '9b9ed20a-7012-486c-a5fc-f147869a6633' },
    },
    skipped_steps: ['review', 'after'],
    run_phase: 'aborted',
  };
  /** The mark as printed, its colour codes dropped: `=`, `≠` or blank. */
  const markOf = (row: Parameters<typeof diffSymbol>[0]) =>
    diffSymbol(row).includes('≠') ? '≠' : diffSymbol(row);
  /** One step's row in the comparison, as the parts each cell asserts. */
  const compare = (a: RunRecord, b: RunRecord, step = 'review') => {
    const row = diffRuns(a, b).find((r) => r.step_id === step)!;
    return {
      status: [row.status_a, row.status_b],
      same_output: row.same_output,
      same_error: row.same_error,
      same_answer: row.same_answer,
      mark: markOf(row),
    };
  };

  it('D1: two failures, the same output `{}`, different messages (fail2 g1 vs g2) → same_error false, `≠`', () => {
    const r = compare(
      makeRun([failedWork("Handler 'envthrow' threw: the filing system is down")]),
      makeRun([failedWork("Handler 'envthrow' threw: quota exceeded")]),
      'work',
    );
    // (a) red when `error` is not compared (same_error true, `=`); (b) prints the booleans and mark.
    expect(r).toEqual({
      status: ['error', 'error'],
      same_output: true,
      same_error: false,
      same_answer: true,
      mark: '≠',
    });
  });

  it('D2: two failures with the same message → same_error true, `=`', () => {
    const msg = "Handler 'envthrow' threw: quota exceeded";
    const r = compare(makeRun([failedWork(msg)]), makeRun([failedWork(msg)]), 'work');
    // (a) red when `error` reads as always different; (b) prints the boolean and the mark.
    expect({ same_error: r.same_error, mark: r.mark }).toEqual({ same_error: true, mark: '=' });
  });

  it('D3: answered `send` vs `discard` (gate gs vs gd) → the step’s own entries equal (same_output true), same_answer false, `≠`', () => {
    // (a) red: `same_answer` when the answer is not compared; `same_output` when the rows read the
    //     answers' entries (their outputs carry the choice); (b) prints the booleans and the mark.
    expect(compare(gateRun([answered('send')]), gateRun([answered('discard')]))).toEqual({
      status: ['success', 'success'],
      same_output: true,
      same_error: true,
      same_answer: false,
      mark: '≠',
    });
  });

  it('D4: the same choice answered by two people (gs2 `--by alice` vs gs3 `--by bob`) → same_answer true, `=`', () => {
    const r = compare(gateRun([answered('send', 'alice')]), gateRun([answered('send', 'bob')]));
    // (a) red when who answered is compared; (b) prints the boolean and the mark.
    expect({ same_answer: r.same_answer, mark: r.mark }).toEqual({ same_answer: true, mark: '=' });
  });

  it('D5: ended by an `on_expiry: abort` expiry (gate3 xa) vs answered `send` (xs) → same_answer false, `≠`, both statuses `success`', () => {
    // (a) red: `same_answer`/`mark` when an abort expiry reads as any answer; `status` when the
    //     column prints the skipped set's word for the step; (b) prints statuses, boolean and mark.
    const r = compare(gateRun([abortExpiry], ENDED_BY_EXPIRY), gateRun([answered('send')]));
    expect({ status: r.status, same_answer: r.same_answer, mark: r.mark }).toEqual({
      status: ['success', 'success'],
      same_answer: false,
      mark: '≠',
    });
  });

  it('D6: `send` settled by the gate’s expiry (gate4 xd) vs `send` answered (xds) → same_answer false, `≠`, both statuses `success`', () => {
    const r = compare(gateRun([settledSend]), gateRun([answered('send')]));
    // (a) red when settled by expiry is not its own kind (the same choice reads `=`); (b) prints
    //     the statuses, the boolean and the mark.
    expect({ status: r.status, same_answer: r.same_answer, mark: r.mark }).toEqual({
      status: ['success', 'success'],
      same_answer: false,
      mark: '≠',
    });
  });

  it('D7 (derived from real entries: no real record has two answers): `discard` then `send` vs one `send` → same_answer true — the last answer counts', () => {
    const r = compare(
      gateRun([answered('discard'), answered('send')]),
      gateRun([answered('send')]),
    );
    // (a) red when the first answer is read, not `recordedAnswer`'s last; (b) prints the boolean.
    expect(r.same_answer).toBe(true);
  });

  it('D8 (derived from a real entry: every real answer has a choice): an answer with no choice vs `send` → same_answer false', () => {
    const { choice: _drop, ...rest } = answered('send').output_summary;
    const noChoice: EvidenceSnapshot = {
      ...answered('send'),
      input_summary: {},
      output_summary: rest,
    };
    const r = compare(gateRun([noChoice]), gateRun([answered('send')]));
    // (a) red when an absent choice matches any choice; (b) prints the boolean and the mark.
    expect({ same_answer: r.same_answer, mark: r.mark }).toEqual({ same_answer: false, mark: '≠' });
  });

  it('D9: a handler that stopped its step (abort ab1) — the status column prints `skipped`', () => {
    const ab1: EvidenceSnapshot = {
      step_id: 'work',
      started_at: '2026-10-21T15:17:28.880Z',
      completed_at: '2026-10-21T15:17:28.880Z',
      duration_ms: 0,
      input_summary: { mode: 'abort:the order was held', later: 'base' },
      output_summary: { aborted: true, abort_message: 'the order was held' },
      status: 'skipped',
      error: 'the order was held',
      evidence_hash: '9fff53aeef587ce06fc6f2a80cec9c3e73af8c58ab554bf9d8af71500a7a299b',
      driven_by: AGENT,
    };
    // (a) red when the column maps `skipped` to another word; (b) prints the two statuses.
    expect(compare(makeRun([ab1]), makeRun([ab1]), 'work').status).toEqual(['skipped', 'skipped']);
  });

  it('D11: ended by an `on_expiry: abort` expiry (xa) vs a question still open (xw) → same_answer false, `≠`', () => {
    const open = gateRun([], {
      pending_gate: {
        gate_id: 'cfb5309f-04f9-4e01-963a-8f57019c9eec',
        step_name: 'review',
        preview: { tenant: 'A', rent: 1200 },
        choices: ['send', 'discard'],
        opened_at: '2026-10-21T15:14:23.357Z',
        resolved_message: 'Send the draft?',
      },
      in_progress_steps: ['review'],
      run_phase: 'gate_waiting',
      terminal_state: false,
    });
    const r = compare(gateRun([abortExpiry], ENDED_BY_EXPIRY), open);
    // (a) red when the abort expiry is not read from skip_details (both read "none", `=`); (b)
    //     prints the statuses, the boolean and the mark.
    expect(r).toEqual({
      status: ['success', 'success'],
      same_output: true,
      same_error: true,
      same_answer: false,
      mark: '≠',
    });
  });

  it('D12: both questions still open → same_answer true, `=`', () => {
    const r = compare(gateRun([]), gateRun([]));
    // (a) red when "none" never equals "none"; (b) prints the boolean and the mark.
    expect({ same_answer: r.same_answer, mark: r.mark }).toEqual({ same_answer: true, mark: '=' });
  });

  it('D10: the reading reference says what the status column prints and what the mark compares — each sentence executed by the cell named beside it', () => {
    const page = readFileSync(
      fileURLToPath(
        new URL('../../../../docs/reference/cli/realm-run-reading.md', import.meta.url),
      ),
      'utf8',
    ).replace(/\s+/g, ' ');
    const says = (sentence: string) => page.includes(sentence);
    // (a) red when the page no longer says a sentence word for word; (b) prints which.
    expect({
      // the statuses: D9 (`skipped`), #841's test 3 (`missing`); "reads `success` once its question
      // is put": D5's and D6's statuses, D11
      statuses: says(
        '`success`, `error`, or `skipped` (a handler that stopped the step) for the step in each run, or `missing` if the run has no entry for it (the step did not run, or was skipped by its `when` or its trigger rule). A step with a question reads `success` once its question is put — answered, settled or ended by its expiry, or still open; the mark compares its answer.',
      ),
      // "the same error message": D1/D2; "the same last answer … who answered is not compared":
      // D3–D8; "both still open or both ended by an `on_expiry: abort` expiry": D11/D12; the rest:
      // #841's C1, C2, C6
      mark: says(
        "`=` if the step has the same status and the same output in both runs (the same fields and values, the fields in any order, a list's items in the same order) and, for a step that failed, the same error message, and for a step with a question, the same last answer — the same choice, both answered or both settled by the gate's expiry (who answered is not compared), or, with no answer, both still open or both ended by an `on_expiry: abort` expiry — `≠` if not, and blank if the step is missing from either run.",
      ),
      // D3's same_output (the rows leave the answers' entries out)
      entries: says(
        "The status, the output and the error message come from each step's last entry other than the entries its question's answers or its expiry wrote; the answer comes from those entries.",
      ),
    }).toEqual({ statuses: true, mark: true, entries: true });
  });
});

describe('isReplayId', () => {
  it('returns true for an rpl_-prefixed ID', () => {
    expect(isReplayId('rpl_abc123-def456')).toBe(true);
  });

  it('returns false for a plain run UUID', () => {
    expect(isReplayId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isReplayId('')).toBe(false);
  });
});

function makeReplayRecord(
  stepResults: ReplayRecord['results'],
  overrides: string[] = [],
): ReplayRecord {
  return {
    id: `rpl_${Math.random().toString(36).slice(2)}`,
    origin_run_id: `run_${Math.random().toString(36).slice(2)}`,
    workflow_id: 'test-workflow',
    overrides,
    results: stepResults,
    created_at: '2024-01-01T00:00:00.000Z',
  };
}

describe('diffReplays', () => {
  it('two identical replays produce all differs: false rows', () => {
    const results = [
      {
        step_id: 'fetch_doc',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
      {
        step_id: 'write',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: true,
      },
    ];
    const recordA = makeReplayRecord(results);
    const recordB = makeReplayRecord(results);
    const rows = diffReplays(recordA, recordB);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.differs)).toBe(true);
  });

  it('step with has_preconditions false shows "none" in both columns', () => {
    const results = [
      {
        step_id: 'fetch_doc',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
    ];
    const recordA = makeReplayRecord(results);
    const recordB = makeReplayRecord(results);
    const rows = diffReplays(recordA, recordB);
    expect(rows[0]!.precond_a).toBe('none');
    expect(rows[0]!.precond_b).toBe('none');
    expect(rows[0]!.differs).toBe(false);
  });

  it('one step changes from PASS→PASS to PASS→BLOCKED → that step has differs: true', () => {
    const resultsA = [
      {
        step_id: 'validate',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
      {
        step_id: 'write',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: true,
      },
    ];
    const resultsB = [
      {
        step_id: 'validate',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
      {
        step_id: 'write',
        preconditions_original: true,
        preconditions_replay: false,
        changed: true,
        has_preconditions: true,
      },
    ];
    const recordA = makeReplayRecord(resultsA);
    const recordB = makeReplayRecord(resultsB);
    const rows = diffReplays(recordA, recordB);
    const validateRow = rows.find((r) => r.step_id === 'validate');
    const writeRow = rows.find((r) => r.step_id === 'write');
    expect(validateRow!.differs).toBe(false);
    expect(writeRow!.differs).toBe(true);
    expect(writeRow!.precond_a).toContain('PASS');
    expect(writeRow!.precond_b).toContain('BLOCKED');
  });

  it('step present in A but absent from B → precond_b is "missing" and differs: true', () => {
    const resultsA = [
      {
        step_id: 'fetch_doc',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
      {
        step_id: 'extra_step',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: true,
      },
    ];
    const resultsB = [
      {
        step_id: 'fetch_doc',
        preconditions_original: true,
        preconditions_replay: true,
        changed: false,
        has_preconditions: false,
      },
    ];
    const recordA = makeReplayRecord(resultsA);
    const recordB = makeReplayRecord(resultsB);
    const rows = diffReplays(recordA, recordB);
    const extraRow = rows.find((r) => r.step_id === 'extra_step');
    expect(extraRow).toBeDefined();
    expect(extraRow!.precond_b).toBe('missing');
    expect(extraRow!.differs).toBe(true);
  });
});

describe('mixed-ID rejection guard', () => {
  it('isReplayId(runId) !== isReplayId(replayId) evaluates true for mixed pair', () => {
    const runId = '550e8400-e29b-41d4-a716-446655440000';
    const replayId = 'rpl_abc123';
    expect(isReplayId(runId) !== isReplayId(replayId)).toBe(true);
  });

  it('isReplayId(replayIdA) !== isReplayId(replayIdB) evaluates false for two replay IDs', () => {
    const replayIdA = 'rpl_aaa';
    const replayIdB = 'rpl_bbb';
    expect(isReplayId(replayIdA) !== isReplayId(replayIdB)).toBe(false);
  });
});
