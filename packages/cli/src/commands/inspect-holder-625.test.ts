// inspect-holder-625.test.ts — issue #625 (the holder slice, PR-H): what `realm run inspect` PRINTS
// about who took a step and who answered a question, on the real rendered output.
//
//   * the claim line of an in-progress step, and every word it can show for a name that is not there;
//   * the attempt line — "Taken by" for work, "Question opened through" for a question;
//   * the answer line — the choice, the answerer (as stated, not verified), the proof in WORDS;
//   * the read bound — a hand-planted escape sequence prints no byte of itself, on one line.
//
// Every phrase is pinned on the output of `inspectRun` over a hand-built record (no model, no
// network, no `$HOME`). Each assertion carries (a) the change that turns it red and (b) what it
// prints on failure: synthetic names only.
import { describe, it, expect } from 'vitest';
import { inspectRun } from './inspect.js';
import { listRuns } from './list.js';
import type { RunRecord, RunStore, WorkflowRegistrar } from '@sensigo/realm';

const workflowStore: WorkflowRegistrar = {
  register: async () => {},
  get: async () => {
    throw new Error('not registered');
  },
  list: async () => [],
};

function makeStore(run: RunRecord, persistsClaims = true): RunStore {
  return {
    persistsClaims,
    get: async () => run,
    create: async () => ({ run, created: true }),
    update: async () => run,
    list: async () => [run],
    claimStep: async () => {
      throw new Error('claimStep is not used by inspect');
    },
  };
}

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

function baseRun(over: Record<string, unknown>): RunRecord {
  return {
    id: 'run_h625',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: ago(3_600_000),
    updated_at: ago(60_000),
    terminal_state: false,
    ...over,
  } as unknown as RunRecord;
}

const exec = (stepId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  step_id: stepId,
  kind: 'execution',
  status: 'success',
  started_at: ago(120_000),
  completed_at: ago(119_000),
  duration_ms: 5,
  input_summary: {},
  output_summary: {},
  evidence_hash: `h-${stepId}`,
  ...extra,
});

const answer = (stepId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  step_id: stepId,
  kind: 'gate_response',
  status: 'success',
  started_at: ago(60_000),
  completed_at: ago(60_000),
  duration_ms: 1,
  input_summary: { choice: 'approve' },
  output_summary: { choice: 'approve' },
  evidence_hash: `a-${stepId}`,
  ...extra,
});

async function render(run: RunRecord, persistsClaims = true): Promise<string> {
  return inspectRun(run.id, makeStore(run, persistsClaims), workflowStore);
}
/** The claim line of `step` — the line right after `In Progress:` that starts with its name. */
const claimLine = (out: string, step: string): string =>
  out.split('\n').find((l) => l.startsWith(`  ${step}: `)) ??
  `<no claim line for ${step}:\n${out}>`;

const PHRASE_UNSHOWABLE =
  'a recorded name that cannot be printed (control characters, or not a name with its source)';
const ESC = '\u001b';

describe('the claim line of an in-progress step', () => {
  const claim = (extra: Record<string, unknown>) => ({
    deadline: null,
    token: 't-never-printed',
    since: ago(5 * 60_000),
    ...extra,
  });

  it('names the program, how its name is known (words) and the door, with how long ago', async () => {
    for (const [by_source, words] of [
      ['derived', 'from the OS user'],
      ['ambient', 'from REALM_OPERATOR'],
      ['stated', 'as stated'],
    ] as const) {
      const out = await render(
        baseRun({
          in_progress_steps: ['work'],
          claims: { work: claim({ holder: { by: 'prog@host', by_source, channel: 'agent' } }) },
        }),
      );
      // (a) red when the class token reaches the screen instead of words, or the door/age goes;
      //     (b) prints the line.
      expect(claimLine(out, 'work')).toBe(
        `  work: taken by prog@host (${words}, via agent), 5m ago`,
      );
    }
  });

  it('a step whose question is OPEN reads "question opened through" — never "taken by"', async () => {
    const out = await render(
      baseRun({
        run_phase: 'gate_waiting',
        in_progress_steps: ['confirm'],
        claims: {
          confirm: claim({
            holder: { by: 'prog@host', by_source: 'derived', channel: 'mcp-stdio' },
          }),
        },
        pending_gate: {
          gate_id: 'g-1',
          step_name: 'confirm',
          choices: ['approve', 'reject'],
          opened_at: ago(60_000),
        },
      }),
    );
    expect(claimLine(out, 'confirm')).toBe(
      '  confirm: question opened through prog@host (from the OS user, via mcp-stdio), 5m ago',
    );
  });

  it.each([
    [
      'a claim with a since and no holder',
      { since: ago(5 * 60_000) },
      true,
      'no program name was recorded on this claim',
    ],
    [
      'a claim with neither',
      { since: undefined },
      true,
      'claimed before program names were recorded',
    ],
  ])('%s ⇒ the absence word', async (_l, extra, persists, word) => {
    const c: Record<string, unknown> = { deadline: null, token: 't', ...extra };
    if (c['since'] === undefined) delete c['since'];
    const out = await render(
      baseRun({ in_progress_steps: ['work'], claims: { work: c } }),
      persists,
    );
    expect(claimLine(out, 'work')).toContain(word);
  });

  it('no claim at all, on a store that keeps claims ⇒ "no claim is recorded for this step"', async () => {
    const out = await render(baseRun({ in_progress_steps: ['work'] }));
    expect(claimLine(out, 'work')).toBe('  work: no claim is recorded for this step');
  });

  it('no claim on a store that keeps none ⇒ "this run store keeps no claims"', async () => {
    const out = await render(baseRun({ in_progress_steps: ['work'] }), false);
    expect(claimLine(out, 'work')).toBe('  work: this run store keeps no claims');
  });

  it('a HAND-PLANTED holder with an escape sequence prints the ONE unshowable phrase — no byte of the value, one line', async () => {
    const out = await render(
      baseRun({
        in_progress_steps: ['work'],
        claims: {
          work: claim({ holder: { by: `${ESC}[2Jevil`, by_source: 'stated', channel: 'x' } }),
        },
      }),
    );
    // (a) red when the reader stops applying the writer's bound; (b) prints the line.
    // The verb stays: "work: a recorded name …" read as if the step were a name.
    expect(claimLine(out, 'work')).toBe(`  work: taken by ${PHRASE_UNSHOWABLE}, 5m ago`);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain('evil');
  });

  it('an OVER-LONG stored name is SHOWN capped with the house marker — not withheld', async () => {
    const out = await render(
      baseRun({
        in_progress_steps: ['work'],
        claims: {
          work: claim({ holder: { by: 'n'.repeat(300), by_source: 'stated', channel: 'x' } }),
        },
      }),
    );
    const line = claimLine(out, 'work');
    expect(line).toContain('n'.repeat(200));
    expect(line).not.toContain('n'.repeat(201));
    expect(line).toContain('…[truncated]');
    expect(line).not.toContain(PHRASE_UNSHOWABLE);
  });

  it('the claim token never prints', async () => {
    const out = await render(
      baseRun({
        in_progress_steps: ['work'],
        claims: {
          work: claim({ holder: { by: 'prog@host', by_source: 'derived', channel: 'agent' } }),
        },
      }),
    );
    expect(out).not.toContain('t-never-printed');
  });
});

describe('the attempt line — "Taken by" for work, "Question opened through" for a question', () => {
  const DRIVEN = { by: 'prog@host', by_source: 'derived', channel: 'agent' };

  it('a non-gate step: "Taken by"', async () => {
    const out = await render(
      baseRun({ completed_steps: ['work'], evidence: [exec('work', { driven_by: DRIVEN })] }),
    );
    expect(out).toContain('Taken by: prog@host (from the OS user, via agent)');
    expect(out).not.toContain('Question opened through');
  });

  it('a gate step — open or answered: "Question opened through" (control: its sibling still says "Taken by")', async () => {
    for (const answered of [false, true]) {
      const out = await render(
        baseRun({
          completed_steps: answered ? ['confirm', 'work'] : ['work'],
          in_progress_steps: answered ? [] : ['confirm'],
          run_phase: answered ? 'running' : 'gate_waiting',
          ...(answered
            ? {}
            : {
                pending_gate: {
                  gate_id: 'g-1',
                  step_name: 'confirm',
                  choices: ['approve', 'reject'],
                  opened_at: ago(60_000),
                },
              }),
          evidence: [
            exec('work', { driven_by: DRIVEN }),
            exec('confirm', { driven_by: { ...DRIVEN, by: 'asker@host' } }),
            ...(answered ? [answer('confirm')] : []),
          ],
        }),
      );
      expect(out, `answered=${answered}`).toContain(
        'Question opened through: asker@host (from the OS user, via agent)',
      );
      expect(out).not.toContain('Taken by: asker@host');
      expect(out).toContain('Taken by: prog@host');
    }
  });

  it('an attempt with no recorded name prints NO line for it (the absence word is withheld here)', async () => {
    const out = await render(baseRun({ completed_steps: ['work'], evidence: [exec('work')] }));
    expect(out).not.toContain('Taken by');
    expect(out).not.toContain('no program name was recorded on this step');
  });

  it('an attempt with an unreadable name prints the one phrase and no byte of the value', async () => {
    const out = await render(
      baseRun({
        completed_steps: ['work'],
        evidence: [
          exec('work', { driven_by: { by: `${ESC}[2Jx`, by_source: 'derived', channel: 'a' } }),
        ],
      }),
    );
    expect(out).toContain(`Taken by: ${PHRASE_UNSHOWABLE}`);
    expect(out).not.toContain(ESC);
  });
});

describe('the answer line — the choice, the answerer, the proof in words', () => {
  const answerLine = (out: string): string =>
    out.split('\n').find((l) => l.trim().startsWith('Answer: ')) ?? `<no Answer line:\n${out}>`;
  const withAnswer = (extra: Record<string, unknown>): RunRecord =>
    baseRun({
      completed_steps: ['confirm'],
      evidence: [exec('confirm'), answer('confirm', extra)],
    });

  it.each<[string, Record<string, unknown>, string]>([
    [
      'matched',
      { claim_proof: { proof: 'matched' } },
      'matched the claim_token of the reply that opened this question',
    ],
    [
      'absent (door-neutral)',
      { claim_proof: { proof: 'absent' } },
      'no claim_token passed (the CLI never passes one; over MCP, only the conversation that opened the question has one to pass)',
    ],
    [
      'mismatch',
      { claim_proof: { proof: 'mismatch' } },
      "the claim_token passed is not this question's",
    ],
    [
      'unverifiable / no_claim',
      { claim_proof: { proof: 'unverifiable', cause: 'no_claim' } },
      'could not be checked — no claim on this record',
    ],
    [
      'unverifiable / claim_has_no_token',
      { claim_proof: { proof: 'unverifiable', cause: 'claim_has_no_token' } },
      'could not be checked — the claim has no token',
    ],
    [
      'unverifiable / store_keeps_no_claims',
      { claim_proof: { proof: 'unverifiable', cause: 'store_keeps_no_claims' } },
      'could not be checked — this store keeps no claims',
    ],
    [
      'spent / answered',
      { claim_proof: { proof: 'spent', cause: 'answered' } },
      'could not be checked — already settled by an earlier answer',
    ],
    [
      'spent / expired',
      { claim_proof: { proof: 'spent', cause: 'expired' } },
      'could not be checked — already settled by its expiry',
    ],
    ['no verdict recorded', {}, 'none recorded'],
    // (The expiry's answer line has no proof part since the review correction C2 — see below.)
    [
      'an unreadable verdict',
      { claim_proof: { proof: 'not-a-verdict' } },
      'the recorded proof cannot be read',
    ],
  ])('proof: %s', async (_label, extra, phrase) => {
    const line = answerLine(await render(withAnswer(extra)));
    // (a) red when the phrase changes, or the verdict word leaks instead of words; (b) prints it.
    expect(line.endsWith(`proof: ${phrase}`)).toBe(true);
    expect(line).not.toMatch(/\bunverifiable\b|\bmismatch\b|\bspent\b/);
  });

  it('the answerer: a stated name is labelled "as stated, not verified"', async () => {
    expect(answerLine(await render(withAnswer({ responded_by: 'alice' })))).toContain(
      'Answer: approve · answered by alice (as stated, not verified) · proof:',
    );
  });

  it('the answerer: none given ⇒ "(not stated)"; an empty or whitespace-only stored name reads the same, never as a blank name', async () => {
    for (const responded_by of [undefined, '', '   ']) {
      const extra = responded_by === undefined ? {} : { responded_by };
      expect(answerLine(await render(withAnswer(extra)))).toContain(
        'answered by (not stated) · proof:',
      );
    }
  });

  it('the answerer: an escape sequence prints the ONE phrase with NO outer parentheses, and no byte of the value', async () => {
    const out = await render(withAnswer({ responded_by: `${ESC}[2Jevil` }));
    expect(answerLine(out)).toContain(`answered by ${PHRASE_UNSHOWABLE} · proof:`);
    expect(out).not.toContain(ESC);
    expect(out).not.toContain('evil');
  });

  it('the answerer: an over-long stored name is shown capped with the marker', async () => {
    const line = answerLine(await render(withAnswer({ responded_by: 'n'.repeat(300) })));
    expect(line).toContain(`${'n'.repeat(200)}…[truncated] (as stated, not verified)`);
  });

  it('one answer, one line — the common gate step (one execution entry, then its answer) prints its answer', async () => {
    const out = await render(withAnswer({ responded_by: 'alice' }));
    expect(out.split('\n').filter((l) => l.trim().startsWith('Answer: '))).toHaveLength(1);
  });

  it('one answer, one line — the multi-attempt and the answer-only layouts print the choice on the `Answer:` line only', async () => {
    const multi = await render(
      baseRun({
        completed_steps: ['confirm'],
        evidence: [exec('confirm', { status: 'error' }), exec('confirm'), answer('confirm')],
      }),
    );
    // (a) red when a `Choice:` line prints beside the `Answer:` line that carries the same choice
    //     (the walk's "said twice"); (b) prints the screen.
    expect(multi).not.toContain('Choice:');
    expect(multi).toContain('Answer: approve');
    const answerOnly = await render(
      baseRun({ completed_steps: ['confirm'], evidence: [answer('confirm')] }),
    );
    expect(answerOnly).not.toContain('Choice:');
    expect(answerOnly).toContain('Answer: approve');
  });
});

describe('CLAIM_TOKEN_ONE_DOOR — `realm run list` never prints the token either', () => {
  it('plain and --stuck, for a run waiting at a gate whose claim holds a token', async () => {
    const run = baseRun({
      run_phase: 'gate_waiting',
      in_progress_steps: ['confirm'],
      claims: {
        confirm: {
          deadline: null,
          token: 't-never-printed',
          since: ago(60_000),
          holder: { by: 'prog@host', by_source: 'derived', channel: 'agent' },
        },
      },
      pending_gate: {
        gate_id: 'g-1',
        step_name: 'confirm',
        choices: ['approve', 'reject'],
        opened_at: ago(60_000),
      },
    });
    const plain = await listRuns(undefined, makeStore(run));
    // (a) red when a listing starts printing the claim; (b) prints the listing.
    expect(plain).toContain(run.id);
    expect(plain).not.toContain('t-never-printed');
    expect(await listRuns(undefined, makeStore(run), undefined, true)).not.toContain(
      't-never-printed',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Issue #625, PR-H review correction (C1, C2, C7)
// ---------------------------------------------------------------------------------------------

describe('review correction C1 — each answer is printed ONCE, whatever the layout', () => {
  /** Every `Answer:` line of the output, whole lines. */
  const answerLines = (out: string): string[] =>
    out.split('\n').filter((l) => /^\s*Answer: /.test(l));
  const LINE = '     Answer: approve · answered by (not stated) · proof: none recorded';
  const LINE_BOB =
    '     Answer: approve · answered by bob (as stated, not verified) · proof: none recorded';
  const layout = (evidence: Record<string, unknown>[]): RunRecord =>
    baseRun({ completed_steps: ['confirm'], evidence });

  it.each<[string, Record<string, unknown>[], string[]]>([
    ['execution then answer', [exec('confirm'), answer('confirm')], [LINE]],
    ['answer only', [answer('confirm')], [LINE]],
    ['answer then execution', [answer('confirm'), exec('confirm')], [LINE]],
    [
      'two attempts then an answer',
      [exec('confirm', { status: 'error' }), exec('confirm'), answer('confirm')],
      [LINE],
    ],
    [
      'two answers (execution first)',
      [exec('confirm'), answer('confirm'), answer('confirm', { responded_by: 'bob' })],
      [LINE, LINE_BOB],
    ],
    [
      'two answers (answer first)',
      [answer('confirm'), answer('confirm', { responded_by: 'bob' })],
      [LINE, LINE_BOB],
    ],
  ])('%s', async (_label, evidence, expected) => {
    // (a) red when a layout prints an answer twice (the trailing loop runs for an answer-first
    //     step) or drops one; (b) prints the Answer lines found.
    expect(answerLines(await render(layout(evidence)))).toEqual(expected);
  });
});

describe('review correction C2 — an answer the gate’s expiry wrote reads as no one answering', () => {
  const answerLine = (out: string): string =>
    out.split('\n').find((l) => l.trim().startsWith('Answer: ')) ?? `<no Answer line:\n${out}>`;
  const expiryRun = (extra: Record<string, unknown>): RunRecord =>
    baseRun({
      completed_steps: ['confirm'],
      evidence: [exec('confirm'), answer('confirm', extra)],
    });

  it("expired_default: `Answer: hold · settled by the gate's expiry (no one answered)` — no answerer, no proof", async () => {
    const out = await render(
      expiryRun({
        responded_by: 'timeout',
        resolution: 'expired_default',
        input_summary: { choice: 'hold' },
        output_summary: { choice: 'hold' },
      }),
    );
    // (a) red when the expiry's literal `timeout` is read as a stated name again, or the line gains
    //     an answerer or proof part; (b) prints the line.
    expect(answerLine(out)).toBe(
      "     Answer: hold · settled by the gate's expiry (no one answered)",
    );
    expect(out).not.toContain('answered by timeout');
  });

  // An `on_expiry: abort` expiry answers nothing and settles nothing: the run ends and the step is
  // skipped (`gate_expired`). Its entry is not an answer, so no `Answer:` line — but the step still
  // opened a question, so its attempt keeps the question verb.
  const abortEntry = {
    responded_by: 'timeout',
    resolution: 'expired_abort',
    input_summary: {},
    output_summary: { gate_expired: true, disposition: 'abort' },
  };
  const abortRun = (evidence: Record<string, unknown>[]): RunRecord =>
    baseRun({
      run_phase: 'aborted',
      terminal_state: true,
      skipped_steps: ['confirm'],
      skip_details: { confirm: { kind: 'gate_expired', gate_id: 'g-1' } },
      evidence,
    });

  it('expired_abort: no `Answer:` line at all; the attempt still reads `Question opened through:`', async () => {
    const out = await render(
      abortRun([
        exec('confirm', {
          driven_by: { by: 'asker@host', by_source: 'derived', channel: 'agent' },
        }),
        answer('confirm', abortEntry),
      ]),
    );
    // (a) red when the abort expiry's entry is composed as an answer again, or when the question
    //     verb is keyed on answers instead of the step's gate entries; (b) prints the screen.
    expect(out.split('\n').filter((l) => l.trim().startsWith('Answer: '))).toEqual([]);
    expect(out).not.toContain('settled by the gate');
    expect(out).toContain('Question opened through: asker@host (from the OS user, via agent)');
    expect(out).not.toContain('Taken by: asker@host');
  });

  it('expired_abort on a multi-attempt step: the answers pair with the answer entries only', async () => {
    const out = await render(
      abortRun([
        exec('confirm', { status: 'failure' }),
        exec('confirm'),
        answer('confirm', abortEntry),
        answer('confirm', {
          input_summary: { choice: 'reject' },
          output_summary: { choice: 'reject' },
          responded_by: 'bob',
        }),
      ]),
    );
    // (a) red when the answers pair with every gate entry by position — the abort entry's block
    //     would take bob's answer and bob's block would print none; (b) prints the gate blocks.
    const lines = out.split('\n');
    const from = lines.findIndex(
      (l) => l.startsWith('     Output:   ') || l.startsWith('     Choice:'),
    );
    expect(lines.slice(from).filter((l) => /^ {5}(Choice|Answer|Output):/.test(l))).toEqual([
      '     Output:   {"gate_expired":true,"disposition":"abort"}',
      '     Answer: reject · answered by bob (as stated, not verified) · proof: none recorded',
      '     Output:   {"choice":"reject"}',
    ]);
  });

  it('(control) a caller who STATES `timeout` as its own name, with no resolution, is still a stated name', async () => {
    const out = await render(expiryRun({ responded_by: 'timeout' }));
    // (a) red when the reading keys on the literal `timeout` instead of `resolution`; (b) prints it.
    expect(answerLine(out)).toBe(
      '     Answer: approve · answered by timeout (as stated, not verified) · proof: none recorded',
    );
  });
});

describe('review correction C7 — "Question opened through" only under the attempt that opened the question', () => {
  it('a REAL run: an auto gate step with retry whose handler fails once ⇒ `Taken by:` under attempt 1, `Question opened through:` under attempt 2', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { JsonFileStore, ExtensionRegistry, executeStep, WorkflowError } =
      await import('@sensigo/realm');
    const dir = await mkdtemp(join(tmpdir(), 'realm-c7-'));
    try {
      const store = new JsonFileStore(dir);
      let calls = 0;
      const registry = new ExtensionRegistry();
      registry.register('handler', 'flaky', {
        id: 'flaky',
        execute: async () => {
          calls += 1;
          if (calls === 1) {
            throw new WorkflowError('the service was busy', {
              code: 'SERVICE_RATE_LIMITED',
              category: 'SERVICE',
              agentAction: 'wait_and_proceed',
              retryable: true,
            });
          }
          return { data: { ok: true } };
        },
      });
      const definition = {
        id: 'c7-wf',
        name: 'c7',
        version: 1,
        steps: {
          confirm: {
            description: 'Confirm',
            execution: 'auto' as const,
            trust: 'human_confirmed' as const,
            depends_on: [],
            handler: 'flaky',
            retry: { max_attempts: 2 },
            gate: { choices: ['approve', 'reject'] },
          },
        },
      };
      const { run } = await store.create({ workflowId: 'c7-wf', workflowVersion: 1, params: {} });
      const reply = await executeStep(store, definition, {
        runId: run.id,
        command: 'confirm',
        input: {},
        dispatcher: async () => {
          throw new Error('fixture: the handler runs, never the dispatcher');
        },
        registry,
        driver: { by: 'prog@host', by_source: 'derived', channel: 'agent' },
      });
      // The run really retried, and the question really opened on the second attempt.
      expect(calls).toBe(2);
      expect(reply.status).toBe('confirm_required');
      const out = await inspectRun(run.id, store, workflowStore);
      const lines = out.split('\n');
      const a1 = lines.findIndex((l) => l.includes('(attempt 1/2)'));
      const a2 = lines.findIndex((l) => l.includes('(attempt 2/2)'));
      // (a) red when every attempt of a question step is labelled "Question opened through";
      //     (b) prints the two lines under the attempts.
      expect([lines[a1 + 1], lines[a2 + 1]]).toEqual([
        '       Taken by: prog@host (from the OS user, via agent)',
        '       Question opened through: prog@host (from the OS user, via agent)',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
