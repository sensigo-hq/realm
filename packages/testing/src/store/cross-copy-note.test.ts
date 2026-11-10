// issue #620 PR-C — U6: what a contract says when a store's refusal is not this copy's class, per kind.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  REALM_BRAND,
  WorkflowError,
  brandClass,
  createRealmBrand,
  type RunStore,
} from '@sensigo/realm';
import { crossCopyNote } from './cross-copy-note.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';
import { InMemoryStore } from './in-memory-store.js';

const OTHER = createRealmBrand('@sensigo/realm', '9.9.9', 'file:///tmp/other-realm/');

function foreignWorkflowError(message: string): Error {
  class WorkflowError extends Error {
    code = 'STATE_STEP_ALREADY_CLAIMED';
  }
  brandClass(WorkflowError, Symbol.for('@sensigo/realm/WorkflowError'), OTHER);
  return new WorkflowError(message);
}

describe('crossCopyNote (U6), per kind', () => {
  it('foreign_line: names the other version and folder and this copy’s version, the whole text', () => {
    expect(crossCopyNote(foreignWorkflowError('x'), WorkflowError)).toBe(
      ` — got a WorkflowError from realm 9.9.9 (/tmp/other-realm), not this copy's (${REALM_BRAND.version})`,
    );
  });
  it('unbranded_copy: the hedged clause, the whole text', () => {
    class WorkflowError2 extends Error {}
    Object.defineProperty(WorkflowError2, 'name', { value: 'WorkflowError' });
    expect(crossCopyNote(new WorkflowError2('x'), WorkflowError)).toBe(
      " — got a WorkflowError — it looks like realm's WorkflowError by its class name but carries no release mark: an older realm copy that does not mark its classes, or another library's class of the same name.",
    );
  });
  it('not_realm: nothing', () => {
    expect(crossCopyNote(new Error('x'), WorkflowError)).toBe('');
    expect(crossCopyNote('a string', WorkflowError)).toBe('');
  });
  it('a contract’s failure text carries the note (CLAIM_SINGLE_OWNER with a store refusing in another copy’s class)', async () => {
    const real = new InMemoryStore();
    let claims = 0;
    const store = Object.create(real) as RunStore;
    store.claimStep = async (runId, step, def) => {
      claims += 1;
      if (claims === 1) return real.claimStep(runId, step, def);
      throw foreignWorkflowError('already claimed');
    };
    const law = runStoreFidelityContract({
      store,
      definition: {
        id: 'w',
        name: 'w',
        version: 1,
        steps: { s: { description: 's', execution: 'agent', depends_on: [] } },
      },
      stepName: 's',
    }).find((c) => c.law === 'CLAIM_SINGLE_OWNER')!;
    await expect(law.run()).rejects.toThrow(
      `got a WorkflowError from realm 9.9.9 (/tmp/other-realm), not this copy's (${REALM_BRAND.version})`,
    );
    expect(fileURLToPath(REALM_BRAND.url!)).toContain('packages');
  });
});
