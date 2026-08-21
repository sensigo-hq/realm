// sealed-by-disclosure-parity.test.ts — issue #367: every field of `SealedBy` must reach an
// operator, or carry a written reason why it does not.
//
// WHY THIS EXISTS. The adjudication channel shipped with rulings that no read surface rendered:
// an operator could rule on a run and then have no way to see that they had, short of exporting
// the record. Nothing caught it — not the type system, not any test — because "we added a field
// and forgot to show it" is not a shape any of them can see. A customer-journey walk found it.
//
// This guard mechanises the class so the next one needs no walk. The `satisfies Record<keyof
// SealedBy, …>` below is the trigger: add a field to `SealedBy` and BOTH surface packages stop
// compiling until someone routes it — rendered, or waived with a reason in writing.
//
// THE ASSERTION LIVES IN THE REGISTRY ENTRY, deliberately. A registry of bare markers with the
// expectations written separately would let a future field be routed 'rendered' while nothing
// actually asserted it — the same defect rebuilt inside its own guard.
//
// ROUTING RULE for a new `SealedBy` field: render it on this surface and write a probe that
// asserts it, or waive it with a reason a reader can weigh. An empty reason is not a reason — the
// runtime loop below rejects it, because the compiler will not.
//
//
// ONE THING TO KNOW ABOUT THE TRIGGER: it fires against the BUILT `SealedBy`, because this package
// resolves `@sensigo/realm` through node_modules to core's emitted types, not to core's source. So
// adding a field to the source type and typechecking without rebuilding looks clean — misleading
// for exactly as long as it takes to build. CI typechecks after the build, which is where this
// bites, and it bites in both packages at once.
// OUT OF SCOPE, with dispositions: `export` carries the whole record verbatim by design, so it
// needs no per-field routing; the migrate report renders rulings and is pinned in its own suite;
// `realm run list` renders none of this today and rides a later increment.
import { describe, it, expect } from 'vitest';
import type {
  RunRecord,
  RunStore,
  WorkflowDefinition,
  WorkflowRegistrar,
  SealedBy,
} from '@sensigo/realm';
import { inspectRun } from './inspect.js';

type DisclosureRoute =
  { surface: 'rendered'; probe: (out: string) => void } | { surface: 'waived'; reason: string };

/**
 * The fixture's arm is PINNED to a deterministic one (`guard_abort` + `step`). A
 * `complete`/`step_failure` arm would suppress the step suffix by design and red this guard on
 * correct code — and the tempting fix would be to widen the render, which would undo #373.
 *
 * It is also deliberately super-lawful: `classified` and `step` do not co-occur on anything a
 * lawful writer mints. This guard tests render CAPACITY, not a shape the engine produces.
 */
const RULED_RUN: RunRecord = {
  id: 'run_parity',
  workflow_id: 'test-workflow',
  workflow_version: 1,
  run_phase: 'aborted',
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: [],
  skipped_steps: [],
  version: 1,
  params: {},
  evidence: [],
  created_at: '2024-01-01T00:00:00.000Z',
  updated_at: '2024-01-01T00:00:01.000Z',
  terminal_state: true,
  aborted_at: { step_id: 'g' },
  sealed_by: {
    arm: 'guard_abort',
    step: 'g',
    classified: true,
    adjudicated: {
      by: 'mihai',
      at: '2026-08-21T00:00:00.000Z',
      previous_arm: 'complete',
      reason: 'the guard is what stopped this run',
    },
  },
} as RunRecord;

const SEALED_BY_DISCLOSURE = {
  arm: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('Sealed by: guard_abort'),
  },
  step: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('(g)'),
  },
  classified: {
    surface: 'rendered',
    probe: (out) => expect(out).toContain('(recovered by classifier)'),
  },
  adjudicated: {
    surface: 'rendered',
    probe: (out) => {
      expect(out).toContain('Ruled: mihai at 2026-08-21T00:00:00.000Z (was complete)');
      expect(out).toContain('— the guard is what stopped this run');
    },
  },
} satisfies Record<keyof SealedBy, DisclosureRoute>;

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

const definition: WorkflowDefinition = {
  id: 'test-workflow',
  name: 'Test Workflow',
  version: 1,
  steps: { g: { description: 'Guard', execution: 'guard' } },
} as unknown as WorkflowDefinition;

function makeWorkflowStore(): WorkflowRegistrar {
  return { register: async () => {}, get: async () => definition, list: async () => [definition] };
}

describe('#367 — every SealedBy field reaches an operator through `realm run inspect`', () => {
  it('runs each field OWN probe against the real rendered output', async () => {
    const out = await inspectRun('run_parity', makeRunStore(RULED_RUN), makeWorkflowStore());
    for (const [field, route] of Object.entries(SEALED_BY_DISCLOSURE) as Array<
      [string, DisclosureRoute]
    >) {
      if (route.surface === 'rendered') {
        route.probe(out);
      } else {
        // The compiler refuses a MISSING reason; it accepts an empty one. Emptiness is this
        // loop's job — a waiver nobody can weigh is not a waiver.
        expect(
          route.reason.trim().length,
          `waiver for '${field}' has an empty reason`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('the registry covers every field, and v1 waives none', () => {
    expect(Object.keys(SEALED_BY_DISCLOSURE).sort()).toEqual([
      'adjudicated',
      'arm',
      'classified',
      'step',
    ]);
    const waived = Object.values(SEALED_BY_DISCLOSURE as Record<string, DisclosureRoute>).filter(
      (r) => r.surface === 'waived',
    );
    expect(waived).toEqual([]);
  });
});
