// ending-composer-a1b1.test.ts — issue #625 PR-2b (A1b-1), correction 1: the ending composer's
// sentences for an arm whose step the record does not name.
//
// Every writer Realm has today names the step on these arms' seals (a fresh seal carries
// `sealed_by.step`; a classified abort carries `aborted_at`), so no real run reaches these words.
// The composer still needs one for each, and they are pinned here, at the composer, so a change to
// them is seen. Every assertion carries (a) the change that turns it red and (b) what it prints.
import { describe, it, expect } from 'vitest';
import { runEndingOf } from './pending.js';
import type { RunRecord, SealArm } from '../types/run-record.js';

/** A terminal record sealed by `arm`, with no step named anywhere. */
const sealedWithoutStep = (arm: SealArm): RunRecord =>
  ({
    id: 'r',
    workflow_id: 'w',
    terminal_state: true,
    failed_steps: [],
    completed_steps: [],
    skipped_steps: [],
    sealed_by: { arm },
  }) as unknown as RunRecord;

describe('#625 A1b-1 correction 1 — the composer, for an arm whose step is not on the record (no writer reaches these today)', () => {
  it('each arm that names a step has its own sentence without one', () => {
    const arms: SealArm[] = [
      'gate_resolution_complete',
      'guard_pass_complete',
      'gate_expiry_default',
      'step_failure',
      'guard_resolution_error',
      'handler_abort',
      'guard_abort',
      'gate_expiry_abort',
    ];
    // (a) red when one of these sentences changes or an arm without its step reads another arm's
    //     words; (b) prints every sentence.
    expect(
      Object.fromEntries(
        arms.map((arm) => [arm, runEndingOf(sealedWithoutStep(arm), { steps: {} })?.sentence]),
      ),
    ).toEqual({
      gate_resolution_complete: 'An answer completed the run.',
      guard_pass_complete: 'A guard step passed and completed the run.',
      gate_expiry_default:
        'A question reached its time limit, and its declared default completed the run.',
      step_failure: 'A step failed.',
      guard_resolution_error: 'A guard step failed with a resolution error. Run is terminated.',
      handler_abort: "A step's handler aborted the run.",
      guard_abort: 'A guard step aborted the run.',
      gate_expiry_abort:
        "A question expired and the run aborted per the workflow's declared on_expiry.",
    });
  });
});
