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
    expect(claimLine(out, 'work')).toBe(`  work: ${PHRASE_UNSHOWABLE}, 5m ago`);
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
    [
      'settled by the gate’s expiry (a resolution, no verdict)',
      { resolution: 'expired_default' },
      "none recorded — settled by the gate's expiry",
    ],
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

  it('the multi-attempt and the answer-only branches KEEP the `Choice:` line and gain the `Answer:` line beside it', async () => {
    const multi = await render(
      baseRun({
        completed_steps: ['confirm'],
        evidence: [exec('confirm', { status: 'error' }), exec('confirm'), answer('confirm')],
      }),
    );
    expect(multi).toContain('Choice:   approve');
    expect(multi).toContain('Answer: approve');
    const answerOnly = await render(
      baseRun({ completed_steps: ['confirm'], evidence: [answer('confirm')] }),
    );
    expect(answerOnly).toContain('Choice:   approve');
    expect(answerOnly).toContain('Answer: approve');
  });
});
