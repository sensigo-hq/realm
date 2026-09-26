// inspect-cache-render.test.ts — issue #600 PR 1a (D6): how StepDiagnostics.cache reads on
// `realm run inspect`, and (D2) that the render never assumes a fixed request count.
//
// Reuses the fixture shape from inspect.test.ts (makeSnapshot/makeRun/makeRunStore/
// makeWorkflowStore) locally, following this package's own convention (drive-failure-render.test.ts
// does the same beside drive-failure-disclosure-parity.test.ts rather than importing across test
// files).
import { describe, it, expect } from 'vitest';
import { inspectRun } from './inspect.js';
import { deriveCacheDetail } from '@sensigo/realm';
import type {
  RunStore,
  RunRecord,
  WorkflowRegistrar,
  WorkflowDefinition,
  EvidenceSnapshot,
  StepDiagnostics,
  UsageRecord,
} from '@sensigo/realm';

function makeSnapshot(stepId: string, overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    step_id: stepId,
    started_at: '2024-01-01T00:00:00.000Z',
    completed_at: '2024-01-01T00:00:01.000Z',
    duration_ms: 1000,
    input_summary: {},
    output_summary: {},
    status: 'success',
    evidence_hash: 'abc123def456789012345678901234567890abcd',
    ...overrides,
  };
}

function makeRun(evidence: EvidenceSnapshot[] = [], overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_test1',
    workflow_id: 'test-workflow',
    workflow_version: 1,
    run_phase: 'completed',
    terminal_reason: 'Workflow completed.',
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    version: 1,
    params: {},
    evidence,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:01.000Z',
    terminal_state: true,
    ...overrides,
  };
}

function makeRunStore(run: RunRecord): RunStore {
  return {
    persistsClaims: true,
    get: async () => run,
    create: async () => ({ run, created: true }),
    update: async () => run,
    list: async () => [run],
    claimStep: async () => {
      throw new Error('claimStep is not used by inspect');
    },
  };
}

function makeWorkflowStore(def?: WorkflowDefinition): WorkflowRegistrar {
  if (def !== undefined) {
    return {
      register: async () => {},
      get: async () => def,
      list: async () => [def],
    };
  }
  return {
    register: async () => {},
    get: async () => {
      throw new Error('Workflow not found');
    },
    list: async () => [],
  };
}

const basicDef: WorkflowDefinition = {
  id: 'test-workflow',
  name: 'Test Workflow',
  version: 1,
  steps: { step_one: { description: 'First step', execution: 'agent' } },
};

const render = async (diag: StepDiagnostics): Promise<string> => {
  const run = makeRun([makeSnapshot('step_one', { diagnostics: diag })]);
  return inspectRun('run_test1', makeRunStore(run), makeWorkflowStore(basicDef));
};

const req = (overrides: Partial<UsageRecord> = {}, index = 0): UsageRecord => ({
  request_index: index,
  request_start: '2024-01-01T00:00:00.000Z',
  ...overrides,
});

describe('issue #600 PR 1a (D6) inspect — StepDiagnostics.cache, five branches', () => {
  it('cache ABSENT — no cache segment at all (no model call happened)', async () => {
    const out = await render({ input_token_estimate: 10, precondition_trace: [] });
    expect(out).not.toContain('cache:');
    expect(out).not.toContain('prompt tokens (measured');
  });

  it('unobservable, ZERO requests known — no request count is fabricated', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: { state: 'unobservable', basis: 'unobservable', requests: [] },
    });
    expect(out).toContain('cache: not reported by the provider');
    expect(out).not.toContain('(0 requests)');
  });

  it('unobservable, but a request WAS made — says so, with the honest count', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: { state: 'unobservable', basis: 'unobservable', requests: [req()] },
    });
    expect(out).toContain('cache: not reported by the provider (1 request)');
  });

  it('never_engaged — provenance from `basis`, never a hardcoded literal', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'never_engaged',
        basis: 'provider_reported',
        requests: [req({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })],
      },
    });
    // Both reported zeros are printed. One `0` standing for two counters has an ambiguous referent,
    // and this way every observable state renders through the SAME composition — the state word
    // summarises, it does not replace the facts.
    expect(out).toContain('cache: not engaged — read 0, wrote 0 (provider-reported, 1 request)');
  });

  it('write_only — read 0, wrote > 0, single request', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'write_only',
        basis: 'provider_reported',
        // The read counter is REPORTED as 0 here, which is what makes both `write_only` and the
        // `read 0` below true. Before the field-level absence fix this fixture omitted it and the
        // render printed `read 0` anyway — a zero for a counter nobody reported. The omitted-read
        // variant now has its own cell in the absence lattice at the bottom of this file.
        requests: [
          req({
            prompt_tokens: 1200,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 1150,
          }),
        ],
      },
    });
    expect(out).toContain('cache: read 0, wrote 1150 (provider-reported, 1 request)');
    // No judgement — a write-only step is a fact, not an accusation (D6 rule 4).
    expect(out).not.toMatch(/wasted|unnecessary|should|inefficient/i);
  });

  it('engaged — read AND write both present', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [
          req({
            prompt_tokens: 1200,
            cache_read_input_tokens: 1150,
            cache_creation_input_tokens: 0,
          }),
        ],
      },
    });
    expect(out).toContain('cache: read 1150, wrote 0 (provider-reported, 1 request)');
  });

  it('the measured prompt size is LABELLED separately from the ~N-token estimate', async () => {
    const out = await render({
      input_token_estimate: 300,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 1200, cache_read_input_tokens: 1150 })],
      },
    });
    // The estimate says WHAT it estimates. Without that, two "tokens" numbers a pipe apart read as
    // two takes on one quantity and an operator files a ~100x estimator bug; they measure different
    // things — this one the step's resolved input, the other the whole prompt the provider received.
    expect(out).toContain('~300 tokens (estimate, step input)');
    expect(out).toContain('1200 prompt tokens (measured, first request)');
  });

  it("a WARM and a COLD call of the SAME prompt report the SAME measured number (D6's acceptance test)", async () => {
    const cold = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'write_only',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 1200, cache_creation_input_tokens: 1150 })],
      },
    });
    const warm = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 1200, cache_read_input_tokens: 1150 })],
      },
    });
    expect(cold).toContain('1200 prompt tokens (measured, first request)');
    expect(warm).toContain('1200 prompt tokens (measured, first request)');
    // The falsity this rejects: reading the provider's raw remainder term instead would report
    // 0 on the warm call beside a cache read of 1150 — the number would SHRINK as caching
    // succeeded. Both calls of the SAME prompt report 1200, unconditionally.
  });
});

describe("issue #600 PR 1a (D2) inspect — the render is COUNT-AGNOSTIC, never 'expect 2 or 3'", () => {
  it('FIVE requests: the prompt TOTAL with its scope, counters SUMMED across all five, in wire order', async () => {
    const requests: UsageRecord[] = [
      req({ prompt_tokens: 1200, cache_creation_input_tokens: 1150 }, 0),
      req({ prompt_tokens: 1210, cache_read_input_tokens: 1150 }, 1),
      req({ prompt_tokens: 1210, cache_read_input_tokens: 1150 }, 2),
      req({ prompt_tokens: 1210, cache_write_tokens: 40 }, 3),
      req({ prompt_tokens: 1210, cache_read_input_tokens: 1190 }, 4),
    ];
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests },
    });
    // All five reported a prompt, so the figure is their TOTAL and the label says what it summed.
    // Showing the first reporting request's figure alone understated this step's spend five-fold.
    expect(out).toContain('6040 prompt tokens (measured, totals across 5 of 5 requests)');
    // Each request in this fixture reports exactly ONE direction, so each total covers a SUBSET of
    // the five requests and says so: wrote = 1150 (request 0) + 40 (request 3) = 1190 over 2 of 5;
    // read = 1150 + 1150 + 1190 = 3490 over 3 of 5. A total over a subset is a lower bound, and
    // printing it bare would have claimed the two silent requests contributed zero.
    expect(out).toContain('read at least 3490 (3 of 5 requests reported a read)');
    expect(out).toContain('wrote at least 1190 (2 of 5 requests reported a write)');
  });

  it('FIVE requests where every one reports BOTH directions: the totals are plain, no lower-bound marker', async () => {
    // The realistic shape (a provider that reports both counters on every response, zero included) —
    // this is the cell that keeps the original count-agnostic summing pinned.
    const requests: UsageRecord[] = [0, 1, 2, 3, 4].map((i) =>
      req(
        {
          prompt_tokens: 1200,
          cache_read_input_tokens: i === 0 ? 0 : 1000,
          cache_creation_input_tokens: i === 0 ? 1150 : 0,
        },
        i,
      ),
    );
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests },
    });
    expect(out).toContain(
      'cache: read 4000, wrote 1150 (provider-reported, totals across 5 requests)',
    );
    expect(out).not.toContain('+ (');
  });

  it('the same derivation over ONE request never says "totals across"', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 1200, cache_read_input_tokens: 1150 })],
      },
    });
    expect(out).toContain('(provider-reported, 1 request)');
    expect(out).not.toContain('totals across');
  });
});

// =========================================================================================
// THE ABSENCE LATTICE ON SCREEN — the anti-repeat law for this issue's one rule, at the render.
//
// The class this block exists to prevent: "an absence is never a zero" honoured for the whole usage
// OBJECT and broken one level down, per FIELD. That is how an unreported direction came to print as
// `0` under a `provider-reported` tag that vouched for it. The instrument is a LATTICE, not a
// sample: every cell of (read direction) x (write direction) over {not reported, reported 0,
// reported > 0} is enumerated with the FULL sentence an operator sees, so the next hole of this
// shape lands on a cell that already exists.
//
// The state word in each fixture is the one `deriveCacheDetail` produces for that cell (core's
// `step-diagnostics-cache.test.ts` owns that pairing as its own lattice); this file owns what the
// screen says once it has it.
// =========================================================================================
describe('issue #600 PR 1a (D6) inspect — the absence lattice: what each observation cell prints', () => {
  type Obs = 'absent' | 'zero' | 'positive';
  const OBS: Obs[] = ['absent', 'zero', 'positive'];
  const value = (o: Obs): number | undefined =>
    o === 'absent' ? undefined : o === 'zero' ? 0 : 500;
  // DERIVED from the classifier that produces it, never hand-written beside the sentence. A
  // hand-written column let the two lattices drift: a mutation of `deriveCacheDetail` left this
  // whole suite green, so these cells could have described (read x write x state) triples production
  // can never mint. `expectedState` below is the declared intent; the derivation is the pin.
  const stateFor = (read: Obs, write: Obs): NonNullable<StepDiagnostics['cache']>['state'] => {
    const rv = value(read);
    const wv = value(write);
    return deriveCacheDetail([
      {
        request_index: 0,
        request_start: '2024-01-01T00:00:00.000Z',
        ...(rv !== undefined ? { cache_read_input_tokens: rv } : {}),
        ...(wv !== undefined ? { cache_creation_input_tokens: wv } : {}),
      },
    ]).state;
  };
  const expectedState: Record<Obs, Record<Obs, NonNullable<StepDiagnostics['cache']>['state']>> = {
    absent: { absent: 'unobservable', zero: 'partially_observed', positive: 'partially_observed' },
    zero: { absent: 'partially_observed', zero: 'never_engaged', positive: 'write_only' },
    positive: { absent: 'engaged', zero: 'engaged', positive: 'engaged' },
  };
  const state = expectedState;
  // The whole sentence, per cell. A `0` appears ONLY where a provider reported one.
  const expected: Record<Obs, Record<Obs, string>> = {
    absent: {
      absent: 'cache: not reported by the provider (1 request)',
      zero: 'cache: read not reported, wrote 0 (provider-reported, 1 request)',
      positive: 'cache: read not reported, wrote 500 (provider-reported, 1 request)',
    },
    zero: {
      absent: 'cache: read 0, wrote not reported (provider-reported, 1 request)',
      zero: 'cache: not engaged — read 0, wrote 0 (provider-reported, 1 request)',
      positive: 'cache: read 0, wrote 500 (provider-reported, 1 request)',
    },
    positive: {
      absent: 'cache: read 500, wrote not reported (provider-reported, 1 request)',
      zero: 'cache: read 500, wrote 0 (provider-reported, 1 request)',
      positive: 'cache: read 500, wrote 500 (provider-reported, 1 request)',
    },
  };

  it('the state column this table renders is the one the CLASSIFIER produces for each cell', () => {
    // The join the two lattices could not see. Mutate `deriveCacheDetail` and this cell reds in the
    // cli suite, where before only core noticed.
    for (const read of OBS) {
      for (const write of OBS) {
        expect(stateFor(read, write), `read ${read} x write ${write}`).toBe(
          expectedState[read][write],
        );
      }
    }
  });

  for (const read of OBS) {
    for (const write of OBS) {
      it(`read ${read} x write ${write} prints: ${expected[read][write]}`, async () => {
        const rv = value(read);
        const wv = value(write);
        const out = await render({
          input_token_estimate: 10,
          precondition_trace: [],
          cache: {
            state: state[read][write],
            basis: read === 'absent' && write === 'absent' ? 'unobservable' : 'provider_reported',
            requests: [
              req({
                // Hoisted, not inlined: TS cannot narrow a call's result inside a conditional
                // spread, so `value(read)` there is `number | undefined` and
                // `exactOptionalPropertyTypes` rejects it. A const narrows.
                ...(rv !== undefined ? { cache_read_input_tokens: rv } : {}),
                ...(wv !== undefined ? { cache_creation_input_tokens: wv } : {}),
              }),
            ],
          },
        });
        expect(out).toContain(expected[read][write]);
        // The load-bearing half: a direction nobody reported never appears as a number, and the
        // provenance word never sits beside a figure that does not exist.
        if (read === 'absent') expect(out).not.toContain('read 0');
        if (write === 'absent') expect(out).not.toContain('wrote 0');
      });
    }
  }

  it('the two write spellings are ALTERNATIVES, never summed — one quantity reported twice is not two writes', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'write_only',
        basis: 'provider_reported',
        requests: [
          req({
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 500,
            cache_write_tokens: 500,
          }),
        ],
      },
    });
    expect(out).toContain('wrote 500');
    expect(out).not.toContain('wrote 1000');
  });

  it('a direction only SOME requests reported is a LOWER BOUND with its count, never a total', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [
          req({ cache_read_input_tokens: 100, cache_creation_input_tokens: 0 }, 0),
          req({ cache_creation_input_tokens: 0 }, 1),
          req({ cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }, 2),
        ],
      },
    });
    expect(out).toContain('read at least 150 (2 of 3 requests reported a read)');
    expect(out).toContain('wrote 0');
  });

  it('when the WHOLE prompt is not knowable, the uncached part the provider DID report survives — labelled as the part, not the whole', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'partially_observed',
        basis: 'provider_reported',
        requests: [req({ uncached_input_tokens: 40, cache_read_input_tokens: 0 })],
      },
    });
    expect(out).toContain(
      '40 uncached input tokens (measured, first request; whole prompt not reported)',
    );
    expect(out).not.toContain('prompt tokens (measured');
  });
});

describe('issue #600 PR 1a — correction 2: what the line says about WHICH request, and about words it does not know', () => {
  it('a prompt measured on a NON-FIRST request is shown, and the label names which request', async () => {
    // The defect: `requests[0]` only. A provider silent on turn 1 and reporting on turn 2 left the
    // line with NO prompt figure at all — while the cache clauses on the same line proved two of
    // three requests had reported — so the only prompt number on screen was the ~N estimate, two
    // orders of magnitude out. A prompt is not additive across requests, so the figure is ONE
    // request's and the label must say which.
    const out = await render({
      input_token_estimate: 11,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [
          req({ cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }, 0),
          req({ prompt_tokens: 1300, cache_read_input_tokens: 1300 }, 1),
          // Only ONE request reports a prompt here, so this cell keeps pinning the which-request
          // label; the several-reported case is its own cell below.
          req({ cache_read_input_tokens: 1400 }, 2),
        ],
      },
    });
    expect(out).toContain('1300 prompt tokens (measured, request 2 of 3)');
    expect(out).not.toContain('(measured, first request)');
  });

  it('an uncached figure measured on a non-first request names its request too', async () => {
    const out = await render({
      input_token_estimate: 11,
      precondition_trace: [],
      cache: {
        state: 'partially_observed',
        basis: 'provider_reported',
        requests: [req({ cache_read_input_tokens: 0 }, 0), req({ uncached_input_tokens: 40 }, 1)],
      },
    });
    expect(out).toContain(
      '40 uncached input tokens (measured, request 2 of 2; whole prompt not reported)',
    );
  });

  it('no request reported a prompt: the ABSENCE is on the screen, never a silent omission', async () => {
    const out = await render({
      input_token_estimate: 11,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, 0)],
      },
    });
    expect(out).toContain('| prompt not reported |');
  });

  it('the estimate says WHAT it estimates, so the pair cannot read as one quantity measured twice', async () => {
    const out = await render({
      input_token_estimate: 11,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [req({ prompt_tokens: 1200, cache_read_input_tokens: 1150 }, 0)],
      },
    });
    // Two numbers a pipe apart, both in "tokens": without the scope words an operator reads them as
    // two takes on one quantity and files a 109x estimator bug.
    expect(out).toContain('~11 tokens (estimate, step input)');
    expect(out).toContain('1200 prompt tokens (measured, first request)');
  });

  it('the floor reads `at least N` and its ratio names the DIRECTION it counted', async () => {
    // `wrote 0+` was the defect: "at least zero" is a non-statement and the eye lands on the 0. And
    // the ratio is counted per direction — two requests each reporting one direction print `1 of 2`
    // twice, which reads as "only one call came back with cache data".
    const out = await render({
      input_token_estimate: 11,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [
          req({ cache_read_input_tokens: 500 }, 0),
          req({ cache_creation_input_tokens: 0 }, 1),
        ],
      },
    });
    expect(out).toContain(
      'cache: read at least 500 (1 of 2 requests reported a read), wrote at least 0 (1 of 2 requests reported a write)',
    );
    expect(out).not.toContain('0+');
    expect(out).not.toContain('500+');
  });

  it('a state word this build does not know is NAMED as unrecognised, and the counters still print', async () => {
    // How a typo'd `not_engaged` became indistinguishable from `engaged` in a walk: an unknown state
    // fell through to the ordinary branch and read as an ordinary fact.
    const out = await render({
      input_token_estimate: 11,
      precondition_trace: [],
      cache: {
        state: 'not_engaged' as NonNullable<StepDiagnostics['cache']>['state'],
        basis: 'provider_reported',
        requests: [req({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 0)],
      },
    });
    expect(out).toContain(
      "cache: unrecognized state 'not_engaged' — read 0, wrote 0 (provider-reported, 1 request)",
    );
  });

  it('a basis word this build does not know is named too — this slot says whether a number was measured', async () => {
    const out = await render({
      input_token_estimate: 11,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'nonsense_basis' as NonNullable<StepDiagnostics['cache']>['basis'],
        requests: [req({ cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, 0)],
      },
    });
    expect(out).toContain("unrecognized basis 'nonsense_basis'");
  });

  it('`never_engaged` prints BOTH reported zeros, not one 0 standing for two counters', async () => {
    const out = await render({
      input_token_estimate: 11,
      precondition_trace: [],
      cache: {
        state: 'never_engaged',
        basis: 'provider_reported',
        requests: [req({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 0)],
      },
    });
    expect(out).toContain('cache: not engaged — read 0, wrote 0 (provider-reported, 1 request)');
  });
});

describe('issue #600 PR 1a — correction 2: a provenance word may not vouch for nothing', () => {
  it('a record whose state claims engagement but carries NO reported counter gets the nothing-reported sentence', async () => {
    // Not mintable by realm's own classifier (it would say `unobservable`), but a foreign or
    // hand-edited record can carry it — and the old render printed `read not reported, wrote not
    // reported (provider-reported, 1 request)`, i.e. "the provider reported: not reported", with the
    // one word left standing being the one that cannot vouch for anything.
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests: [req({}, 0)] },
    });
    expect(out).toContain('cache: not reported by the provider (1 request)');
    expect(out).not.toContain('provider-reported,');
  });

  it('and with NO requests at all it does not fabricate a request count either', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: { state: 'engaged', basis: 'provider_reported', requests: [] },
    });
    expect(out).toContain('cache: not reported by the provider');
    expect(out).not.toContain('0 requests');
  });
});

describe('issue #600 PR 1a — correction 2: a null counter is an absence at the RENDER too', () => {
  it('a NULL read prints `read not reported`, never `read 0`', async () => {
    // `null !== undefined` is TRUE, so the looser test counts a null as REPORTED and the sum then
    // renders it as a `0` — while this line's own comment says a `0` here always means a provider
    // said zero. Two guards now stand between that: `reportedFigure`'s `value()` and the caller's
    // own `typeof` filter. Either alone suffices, which is why a mutant against one of them is
    // equivalent — so the BEHAVIOUR is pinned here rather than the guard.
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'partially_observed',
        basis: 'provider_reported',
        requests: [
          req({
            cache_read_input_tokens: null as unknown as number,
            cache_creation_input_tokens: 7,
          }),
        ],
      },
    });
    expect(out).toContain('cache: read not reported, wrote 7 (provider-reported, 1 request)');
    expect(out).not.toContain('read 0');
  });

  it('a NULL prompt figure is not a measured 0 either — the segment says nothing rather than a zero', async () => {
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [
          req({
            prompt_tokens: null as unknown as number,
            cache_read_input_tokens: 500,
            cache_creation_input_tokens: 0,
          }),
        ],
      },
    });
    expect(out).toContain('| prompt not reported |');
    expect(out).not.toContain('0 prompt tokens');
  });
});

describe('issue #600 PR 1a — correction 2: several requests reported a prompt', () => {
  it('shows the TOTAL with its scope, never the first reporting request while a larger sibling hides', async () => {
    // A fresh operator read `777 prompt tokens (measured, request 2 of 4)` off a record that also
    // held 888, concluded the prompt was under the provider's cacheable floor, and would have
    // cancelled a caching change that pays on ≥1665 tokens. The failed-drive line sums the identical
    // data shape, so showing one request here also made the two surfaces disagree about one number.
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        basis: 'provider_reported',
        requests: [
          req({ cache_read_input_tokens: 1 }, 0),
          req({ prompt_tokens: 777, cache_read_input_tokens: 1 }, 1),
          req({ prompt_tokens: 888, cache_read_input_tokens: 1 }, 2),
          req({ cache_read_input_tokens: 1 }, 3),
        ],
      },
    });
    expect(out).toContain('1665 prompt tokens (measured, totals across 2 of 4 requests)');
    expect(out).not.toContain('777 prompt tokens');
  });

  it('an ABSENT basis says so plainly — it is not a basis whose value is the token "undefined"', async () => {
    // The quoted form asserts the record literally holds that string, which sent a walker hunting a
    // stringify-undefined bug in the writer. Missing and corrupt are different facts.
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'engaged',
        requests: [req({ cache_read_input_tokens: 10, cache_creation_input_tokens: 20 }, 0)],
      },
    } as unknown as StepDiagnostics);
    expect(out).toContain('cache: read 10, wrote 20 (basis not recorded, 1 request)');
    expect(out).not.toContain("'undefined'");
  });

  it('a state word claiming nothing was observed may NOT discard counters the record carries', async () => {
    // `state: unobservable` used to win over the data, so a record holding a read of 77 and a write
    // of 88 printed "not reported by the provider" — and an operator dropped the caching work for
    // that provider on the strength of it.
    const out = await render({
      input_token_estimate: 10,
      precondition_trace: [],
      cache: {
        state: 'unobservable',
        basis: 'unobservable',
        requests: [req({ cache_read_input_tokens: 77, cache_creation_input_tokens: 88 }, 0)],
      },
    });
    expect(out).toContain('read 77, wrote 88');
    expect(out).not.toContain('not reported by the provider');
  });
});
