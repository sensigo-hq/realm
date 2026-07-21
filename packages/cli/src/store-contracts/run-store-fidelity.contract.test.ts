// RunStore field-fidelity + claimStep single-owner TCK conformance for JsonFileStore (issue #188,
// PR-2).
//
// Lives in @sensigo/realm-cli, NOT in @sensigo/realm's own packages/core test suite, for the SAME
// reason json-file-store.contract.test.ts (issue #183) does: @sensigo/realm-testing depends on
// @sensigo/realm, so a devDependency the other way round (packages/core → @sensigo/realm-testing)
// would be a genuine circular PACKAGE dependency. @sensigo/realm-cli already depends on both (no
// new dependency needed).
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';
import { runStoreFidelityContract, type RunStoreFidelityLaw } from '@sensigo/realm-testing';

const LAWS: RunStoreFidelityLaw[] = ['FIDELITY_HONESTY', 'CLAIM_SINGLE_OWNER'];

const agentWf: WorkflowDefinition = {
  id: 'run-store-fidelity-tck-wf',
  name: 'RunStore Fidelity TCK WF',
  version: 1,
  steps: {
    work: { description: 'Agent step, immediately eligible', execution: 'agent', depends_on: [] },
  },
};

describe('JsonFileStore — RunStore fidelity TCK conformance (issue #188)', () => {
  it('declares the full LoadBearingRunRecordField set (byte-identical local behavior depends on this)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'json-file-store-fidelity-tck-'));
    try {
      const store = new JsonFileStore(dir);
      expect(store.persistedRunRecordFields?.has('capability_blocks')).toBe(true);
      expect(store.persistedRunRecordFields?.has('workflow_context_snapshots')).toBe(true);
      expect(store.persistedRunRecordFields?.has('extension_identity')).toBe(true);
      expect(store.persistedRunRecordFields?.has('validation_rejections')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const law of LAWS) {
    it(`conforms to ${law}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'json-file-store-fidelity-tck-'));
      try {
        const store = new JsonFileStore(dir);
        const cases = runStoreFidelityContract({ store, definition: agentWf, stepName: 'work' });
        const matching = cases.filter((c) => c.law === law);
        expect(matching.length).toBeGreaterThan(0);
        for (const c of matching) {
          await c.run();
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});
