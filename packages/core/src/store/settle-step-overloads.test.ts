// settle-step-overloads.test.ts — #715 (b), Amendment 1 (D-21): `RunStore.settleStep`'s two overloads.
// A `seal_run` change takes NO workflow definition (a run is sealed even when its workflow is gone);
// every other kind takes one. The checks are compile-time: `npm run typecheck:tests` fails when an
// `@ts-expect-error` line below stops being an error (a single signature with an optional
// definition would accept both). They type against `RunStore`, not a store class (MA 3's addendum:
// the classes declare one signature, `definition?`, which satisfies both overloads).
import { describe, expect, it } from 'vitest';
import type { RunStore } from './store-interface.js';
import type { SealRunDelta } from '../types/settlement.js';
import type { WorkflowDefinition } from '../types/workflow-definition.js';

describe('#715 (b) Amendment 1 — RunStore.settleStep overloads', () => {
  it('a seal_run takes no definition; every other kind needs one (the two @ts-expect-error lines are the cells)', () => {
    const calls = (store: RunStore, definition: WorkflowDefinition): void => {
      const seal: SealRunDelta = {
        kind: 'seal_run',
        arm: 'abandon_requested',
        reason: 'r',
        expected_version: 0,
        release_claims: true,
      };
      // (a) red (an unused @ts-expect-error) when a seal_run is accepted WITH a definition.
      // @ts-expect-error — a seal_run takes no definition (Amendment 1)
      void store.settleStep('run', seal, definition);
      // (a) red (an unused @ts-expect-error) when a non-seal change is accepted WITHOUT one.
      // @ts-expect-error — every other kind needs a workflow definition
      void store.settleStep('run', { kind: 'expire_gate', gateId: 'g' });
      // The two forms the overloads accept.
      void store.settleStep('run', seal);
      void store.settleStep('run', { kind: 'expire_gate', gateId: 'g' }, definition);
    };
    // (b) the runtime part only proves the function compiled into the suite; it prints its type.
    expect(typeof calls).toBe('function');
  });
});
