// test-default-timeout.test.ts — the repository's default time limit for one test is 30 seconds.
//
// `vitest.config.mts` (`testTimeout`) gave every test 5 seconds until the owner's yes of 2026-10-30
// (session aaefd3da, uuid 359abf57-54f1-4af3-b7e5-2df4b96e18d0): raise the default from 5 to 30 s in
// one config line. This file pins the number the run actually uses, so a change of the config that
// puts the 5 seconds back (or any other value) is seen here and not first as a flake under load.
// A cell that needs more than 30 seconds, or less, still carries a budget of its own (#371).
import { describe, expect, it } from 'vitest';

describe('the default time limit of a test (#371; the owner, 2026-10-30)', () => {
  it('is 30 seconds for a cell that carries no budget of its own', ({ task }) => {
    // (a) red when `testTimeout` in the root `vitest.config.mts` is not 30_000 (it was 5000 before
    //     2026-10-30); (b) prints the number the run used and the number expected, nothing else.
    expect(task.timeout).toBe(30_000);
  });
});
