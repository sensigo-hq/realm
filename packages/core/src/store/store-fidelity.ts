// Pure helper for the RunStore field-fidelity capability (issue #188). Every runtime honesty gate
// (execution-loop.ts, get-run-state.ts) and the forcing conformance TCK (@sensigo/realm-testing)
// checks fidelity through this ONE function, so there is a single place that encodes the
// fail-closed default — never a scattered `store.persistedRunRecordFields?.has(x) ?? false` at
// each call site, which would risk one site quietly drifting to a different (unsafe) default.
import type { LoadBearingRunRecordField, RunStore } from './store-interface.js';

/**
 * Whether `store` guarantees to round-trip `field` (issue #188). Fail-closed: a store that
 * doesn't declare `persistedRunRecordFields` at all, or declares a set that doesn't include
 * `field`, is treated as NOT persisting it — the engine must never assume an absent declaration
 * means "safe to trust the field's absence on read."
 */
export function persistsField(
  store: Pick<RunStore, 'persistedRunRecordFields'>,
  field: LoadBearingRunRecordField,
): boolean {
  return store.persistedRunRecordFields?.has(field) ?? false;
}
