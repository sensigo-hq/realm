// claimed-class-592c.test.ts — Q1 (#592) unit c, Amendment 1 (prompt q1-c-startup-death-mark.md):
// the third reader that takes a CLAIMED class. A failed model try is recorded with the class its
// thrown error's `driveCall` names (a third-party `--provider-module`'s included), closed against
// `CLAIMABLE_ERROR_CLASSES`: a payload claiming `startup_failure` becomes `other`, as an unknown word
// does; the other seven words are kept.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import type { RetryConfig } from '@sensigo/realm';
import {
  deriveRetryCap,
  makeModelRetryPolicy,
  modelAttemptsOf,
  tryModelRequest,
} from './agent-utils.js';

const ONE_TRY: RetryConfig = { max_attempts: 1, backoff: 'fixed', base_delay_ms: 1 };
const SEVEN = [
  'connection_timeout',
  'connection_error',
  'api_status',
  'sdk_missing',
  'validation_rejected',
  'aborted_by_budget',
  'other',
];

/** The class recorded for one failed try whose thrown error's payload claims `claimed`. */
async function recordedClass(claimed: string): Promise<string | null | undefined> {
  const policy = makeModelRetryPolicy({
    retry: ONE_TRY,
    ...deriveRetryCap(ONE_TRY, 600_000),
    mayResend: async () => true,
  });
  await tryModelRequest(policy, {}, undefined, async () => {
    throw Object.assign(new Error('refused'), {
      status: 503,
      driveCall: { error_class: claimed },
    });
  }).catch(() => undefined);
  return modelAttemptsOf(policy)[0]?.error_class;
}

describe('Q1 (#592) unit c, Amendment 1 — a model try cannot claim startup_failure', () => {
  it('a payload claiming startup_failure is recorded as other, as made_up_class is; the other seven words are kept', async () => {
    const claims = [...SEVEN, 'startup_failure', 'made_up_class'];
    const recorded: Array<[string, unknown]> = [];
    for (const c of claims) recorded.push([c, await recordedClass(c)]);
    // (a) red when attemptOf closes against ERROR_CLASSES (startup_failure then kept) or drops one
    //     of the seven; (b) prints each claim and the class recorded for it.
    expect(recorded).toEqual([
      ...SEVEN.map((c) => [c, c]),
      ['startup_failure', 'other'],
      ['made_up_class', 'other'],
    ]);
  });
});
