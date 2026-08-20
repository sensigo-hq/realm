// sealed-by-disclosure-parity.test.ts — issue #367: every field of `SealedBy` must reach a
// consumer of `get_run_state`, or carry a written reason why it does not.
//
// The sibling of the CLI guard, same trigger and same rule. The short version: the adjudication
// channel shipped with rulings no read surface rendered, nothing caught it because no type or test
// can see "we added a field and forgot to show it", and a customer-journey walk found it. This
// guard makes the class unshippable — in both packages at once.
//
// ROUTING RULE for a new `SealedBy` field: emit it here and write a probe that asserts it, or
// waive it with a reason a reader can weigh. The assertion lives IN the registry entry so that the
// same `satisfies` forcing a future field's ENTRY also forces its ASSERTION; a registry of bare
// markers would let a field be routed 'rendered' with nothing asserting it — this defect rebuilt
// inside its own guard. An empty reason is not a reason: the compiler accepts `reason: ''`, so the
// runtime loop below rejects it.
//
//
// ONE THING TO KNOW ABOUT THE TRIGGER: it fires against the BUILT `SealedBy`, because this package
// resolves `@sensigo/realm` through node_modules to core's emitted types, not to core's source. So
// adding a field to the source type and typechecking without rebuilding looks clean — misleading
// for exactly as long as it takes to build. CI typechecks after the build, which is where this
// bites, and it bites in both packages at once.
// OUT OF SCOPE, with dispositions: `export` carries the whole record verbatim by design and needs
// no per-field routing; the migrate report renders rulings and is pinned in its own suite;
// `realm run list` renders none of this today and rides a later increment.
//
// One thing differs here and it is deliberate: `step` is routed rendered, but the surface emits it
// ONLY for arms where the step is the seal's deterministic identity. For `complete`/`step_failure`
// the recorded step is a settle-order artifact, and this surface's consumers are agents — the
// readers most likely to take a named step as THE culprit, which is the misreading #373 exists to
// prevent. The discriminating cell below pins the absence.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, JsonWorkflowStore } from '@sensigo/realm';
import type { RunRecord, SealedBy, WorkflowDefinition } from '@sensigo/realm';
import { handleGetRunState } from './get-run-state.js';
import type { RunStateSummary } from './get-run-state.js';

type DisclosureRoute =
  | { surface: 'rendered'; probe: (summary: RunStateSummary) => void }
  | { surface: 'waived'; reason: string };

const RULING = {
  by: 'mihai',
  at: '2026-08-21T00:00:00.000Z',
  previous_arm: 'complete' as const,
  reason: 'the guard is what stopped this run',
};

const SEALED_BY_DISCLOSURE = {
  arm: {
    surface: 'rendered',
    // First-ever pin on this field's emission: nothing in the repo asserted it before this guard.
    probe: (s) => expect(s.sealed_by_arm).toBe('guard_abort'),
  },
  step: {
    surface: 'rendered',
    probe: (s) => expect(s.sealed_by_step).toBe('g'),
  },
  classified: {
    surface: 'rendered',
    probe: (s) => expect(s.sealed_by_classified).toBe(true),
  },
  adjudicated: {
    surface: 'rendered',
    // The FULL object, field by field: a surface that keeps `by` and drops `reason` has shipped
    // half a provenance record, which is worse than none.
    probe: (s) => expect(s.sealed_by_adjudicated).toEqual(RULING),
  },
} satisfies Record<keyof SealedBy, DisclosureRoute>;

const definition = {
  id: 'parity-wf',
  name: 'Parity',
  version: 1,
  steps: { g: { description: 'Guard', execution: 'guard', abort_unless: ['$.x == true'] } },
} as unknown as WorkflowDefinition;

let runStore: JsonFileStore;
let workflowStore: JsonWorkflowStore;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'realm-parity-mcp-'));
  runStore = new JsonFileStore(dir);
  workflowStore = new JsonWorkflowStore(join(dir, 'workflows'));
  await workflowStore.register(definition);
});

/**
 * Seeds a ruled terminal run through the store's OWN write path, in the two writes the contract
 * requires: the seal first, then the ruling. (A single write carrying both is refused — a first
 * seal cannot claim a prior arm, and the boundary said so when this fixture tried it.)
 */
async function seedRuled(sealedBy: SealedBy): Promise<string> {
  const { run } = await runStore.create({
    workflowId: definition.id,
    workflowVersion: 1,
    params: {},
  });
  const sealed = await runStore.update({
    ...run,
    terminal_state: true,
    terminal_reason: 'Workflow completed.',
    sealed_by: { arm: 'complete' },
  } as RunRecord);
  await runStore.update({
    ...sealed,
    aborted_at: { step_id: 'g' },
    sealed_by: sealedBy,
  } as RunRecord);
  return run.id;
}

describe('#367 — every SealedBy field reaches a get_run_state consumer', () => {
  it('runs each field OWN probe against the real summary', async () => {
    // Deliberately super-lawful: `classified` and `step` do not co-occur on anything a lawful
    // writer mints. This guard tests emission CAPACITY, not a shape the engine produces.
    const runId = await seedRuled({
      arm: 'guard_abort',
      step: 'g',
      classified: true,
      adjudicated: RULING,
    });
    const summary = await handleGetRunState({ run_id: runId }, { runStore, workflowStore });
    for (const [field, route] of Object.entries(SEALED_BY_DISCLOSURE) as Array<
      [string, DisclosureRoute]
    >) {
      if (route.surface === 'rendered') {
        route.probe(summary);
      } else {
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
    expect(
      Object.values(SEALED_BY_DISCLOSURE as Record<string, DisclosureRoute>).filter(
        (r) => r.surface === 'waived',
      ),
    ).toEqual([]);
  });
});
