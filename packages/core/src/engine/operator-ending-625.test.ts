// operator-ending-625.test.ts — issue #625 PR-2a, the last prompt's F2 (framework blocker: axes 8/2/7,
// §4 R8 over R7; review A1-B2): until a signed reversal exists, no surface offers `realm run resume` for
// a run an operator ended — resuming it erases the operator's ending and its reason and records no one
// and no reason for the undo. `resumeWay` stays the fact (what `realm run resume` takes); every offer
// reads `offeredResumeWay` (an engine failure only); a run an operator ended is told who ended it and
// why (`operatorEndingSentence`), its free-text reason through the escaped, bounded value renderer.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '../index.js';
import {
  submitHumanResponse,
  terminalAnswerRefusalMessage,
  withEndedRunWays,
} from './execution-loop.js';
import { abandonRun } from './abandon-run.js';
import { resumeWay } from './pending.js';
import { JsonFileStore } from '../store/json-file-store.js';
import type { RunRecord } from '../types/run-record.js';
import type { ResponseEnvelope } from '../types/response-envelope.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';
import * as redaction from '../utils/redaction.js';

/** `a`, `b` (agent steps), `c` after `b` — the reviewer's workflow (`probes/a1/wf2`). */
const TWO: WorkflowDefinition = {
  id: 'two-branch',
  name: 'Two branches',
  version: 1,
  steps: {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'agent', depends_on: [] },
    c: { description: 'C.', execution: 'agent', depends_on: ['b'] },
  },
};

/** A reason holding a newline and a terminal escape (an operator types free text). */
const REASON = 'wrong run\nPhase: completed\u001b[31m RED';
/** The reason as the one renderer writes it: JSON, its controls escaped, on one line. */
const SHOWN = '"wrong run\\nPhase: completed\\u001b[31m RED"';
const SENTENCE = `An operator ended this run, with the reason ${SHOWN}; to run the work again, start a new run.`;

/** The core exports F2 adds, read without a named import so the cells can run before they exist. */
const F2 = core as unknown as {
  offeredResumeWay?: typeof resumeWay;
  operatorEndingSentence?: (run: RunRecord) => string | undefined;
};
const render = (redaction as { escapedBoundedValue?: (v: unknown) => string }).escapedBoundedValue;

describe('#625 PR-2a, F2 — a run an operator ended is never offered the undo', () => {
  let store: JsonFileStore;
  beforeEach(async () => {
    store = new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-op-625-')));
  });

  /** A run whose step `a` failed, then ended as `how`: an operator's abandon, or an engine failure. */
  async function ended(how: 'abandoned' | 'failed'): Promise<RunRecord> {
    const { run } = await store.create({ workflowId: TWO.id, workflowVersion: 1, params: {} });
    await store.update({ ...(await store.get(run.id)), failed_steps: ['a'] });
    if (how === 'abandoned') return abandonRun(store, run.id, REASON);
    const open = await store.get(run.id);
    return store.update({
      ...open,
      terminal_state: true,
      run_phase: 'failed',
      sealed_by: { arm: 'step_failure', step: 'a' },
    } as RunRecord);
  }

  it('the escaped, bounded value renderer: one line, every control escaped, then capped (escaping first); undefined reads undefined', () => {
    const long = '\u001b'.repeat(300);
    // (a) red when the renderer is missing, prints a raw newline or ESC, caps before escaping (the
    //     cap would let 500 raw characters through), or loses `undefined`; (b) prints each rendering.
    expect({
      reason: render?.(REASON),
      separators: render?.('a b\u0085c'),
      long: render?.(long),
      undefined: render?.(undefined),
      number: render?.(42),
    }).toEqual({
      reason: SHOWN,
      separators: '"a\\u2028b\\u0085c"',
      long: `"${'\\u001b'.repeat(300)}`.slice(0, 500) + '…[truncated]',
      undefined: 'undefined',
      number: '42',
    });
  });

  it('the fact and the offer: resumeWay still says what `realm run resume` takes (preservation); offeredResumeWay offers it for an engine failure only (discrimination)', async () => {
    const abandoned = await ended('abandoned');
    const failed = await ended('failed');
    const fact = (r: RunRecord) => resumeWay(r, TWO)?.command;
    const offer = (r: RunRecord) => F2.offeredResumeWay?.(r, TWO)?.command ?? '<none>';
    // (a) red when the fact drops the abandoned run (purge's preview and inspect read it), or the offer
    //     is made for it, or withheld from the failed run; (b) prints the four commands.
    expect({
      factAbandoned: fact(abandoned),
      factFailed: fact(failed),
      offerAbandoned: offer(abandoned),
      offerFailed: offer(failed),
    }).toEqual({
      factAbandoned: `realm run resume ${abandoned.id} --from a`,
      factFailed: `realm run resume ${failed.id} --from a`,
      offerAbandoned: '<none>',
      offerFailed: `realm run resume ${failed.id} --from a`,
    });
  });

  it('the refusal of an answer to a run an operator ended says the ending and its reason, on one line, never the undo', async () => {
    const run = await ended('abandoned');
    const reply = await submitHumanResponse(store, TWO, {
      runId: run.id,
      gateId: 'g-old',
      choice: 'yes',
    });
    // (a) red when the refusal offers `realm run resume`, drops the reason, or prints it raw;
    //     (b) prints the refusal.
    expect({ error: reply.errors[0], code: reply.error_code }).toEqual({
      error: `Run '${run.id}' is terminal (abandoned); cannot submit a gate response — an operator ended this run, with the reason ${SHOWN}; to run the work again, start a new run; 'realm run purge ${run.id}' previews what it would remove.`,
      code: 'STATE_RUN_TERMINAL',
    });
    expect(terminalAnswerRefusalMessage(run, TWO)).not.toContain('realm run resume');
  });

  it('an ended-run reply (execute_step, advance_run, start_run) on a run an operator ended ends with the ending; a failed one with the offer (preservation)', async () => {
    const reply = (hint: string): ResponseEnvelope => ({
      command: 'x',
      run_id: 'r',
      run_version: 1,
      status: 'ok',
      data: {},
      evidence: [],
      warnings: [],
      errors: [],
      context_hint: hint,
      run_phase: 'abandoned',
      next_actions: [],
    });
    const abandoned = await ended('abandoned');
    const failed = await ended('failed');
    // (a) red when the abandoned reply offers the undo or drops the ending, or the failed one stops
    //     offering it; (b) prints both hints.
    expect({
      abandoned: withEndedRunWays(reply('Ended.'), abandoned, TWO).context_hint,
      failed: withEndedRunWays(reply('Ended.'), failed, TWO).context_hint,
    }).toEqual({
      abandoned: `Ended. ${SENTENCE}`,
      failed: `Ended. 'realm run resume ${failed.id} --from a' makes the failed step runnable again.`,
    });
  });

  it('a legacy abandoned record (no sealed_by) is an operator’s ending too: no offer, the sentence', () => {
    const legacy = {
      id: 'legacy-run',
      workflow_id: TWO.id,
      terminal_state: true,
      run_phase: 'abandoned',
      abandoned_at: '2026-01-01T00:00:00.000Z',
      terminal_reason: 'stopped by hand',
      failed_steps: ['a'],
      completed_steps: [],
      skipped_steps: [],
    } as unknown as RunRecord;
    // (a) red when the offer is keyed on `sealed_by` (a legacy record has none) instead of the derived
    //     phase; (b) prints the offer and the sentence.
    expect({
      offer: F2.offeredResumeWay?.(legacy, TWO) ?? '<none>',
      sentence: F2.operatorEndingSentence?.(legacy),
    }).toEqual({
      offer: '<none>',
      sentence:
        'An operator ended this run, with the reason "stopped by hand"; to run the work again, start a new run.',
    });
  });
});
