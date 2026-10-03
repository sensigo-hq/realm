// issue #620 PR-C — STORE_RELEASE_LINE_TRUE: a store's declared release line must be its errors'.
import { describe, it, expect } from 'vitest';
import {
  REALM_BRAND,
  RELEASE_LINE_KEY,
  createRealmBrand,
  declareReleaseLine,
  runNotFoundError,
  type RunStore,
} from '@sensigo/realm';
import { storeReleaseLineLaw } from './store-release-line-law.js';
import { runStoreFidelityContract } from './run-store-fidelity-contract.js';
import { InMemoryStore } from './in-memory-store.js';

const OTHER = createRealmBrand('@sensigo/realm', '9.9.9', 'file:///tmp/other-realm/');

describe('storeReleaseLineLaw', () => {
  it('a plain-object store declared from this realm, refusing with this realm’s error, passes', async () => {
    const store = { get: async (id: string) => Promise.reject(runNotFoundError(id)) };
    declareReleaseLine(store);
    await expect(storeReleaseLineLaw(store, () => store.get('x'))).resolves.toBeUndefined();
  });
  it('a store whose declared line differs from its errors’ line fails', async () => {
    const store = { get: async (id: string) => Promise.reject(runNotFoundError(id)) };
    Object.defineProperty(store, RELEASE_LINE_KEY, { value: OTHER });
    await expect(storeReleaseLineLaw(store, () => store.get('x'))).rejects.toThrow(
      /declares realm 9\.9\.9, but its refusal is an error from realm/,
    );
  });
  it('the fidelity contract’s STORE_RELEASE_LINE_TRUE case fails for a store that lies', async () => {
    const real = new InMemoryStore();
    const liar = Object.create(real) as RunStore;
    Object.defineProperty(liar, RELEASE_LINE_KEY, { value: OTHER });
    const cases = runStoreFidelityContract({
      store: liar,
      definition: {
        id: 'w',
        name: 'w',
        version: 1,
        steps: { s: { description: 's', execution: 'agent', depends_on: [] } },
      },
      stepName: 's',
    }).filter((c) => c.law === 'STORE_RELEASE_LINE_TRUE');
    expect(cases).toHaveLength(1);
    await expect(cases[0]!.run()).rejects.toThrow(/the declaration is false/);
  });
  it('each of its four failures, the whole text', async () => {
    const lying = { get: async (id: string) => Promise.reject(runNotFoundError(id)) };
    Object.defineProperty(lying, RELEASE_LINE_KEY, { value: OTHER });
    await expect(storeReleaseLineLaw(lying, () => lying.get('x'))).rejects.toMatchObject({
      message: `STORE_RELEASE_LINE_TRUE: the store declares realm 9.9.9, but its refusal is an error from realm ${REALM_BRAND.version} — the declaration is false`,
    });
    const undeclared = { get: async () => undefined };
    await expect(storeReleaseLineLaw(undeclared, () => undeclared.get())).rejects.toMatchObject({
      message:
        'STORE_RELEASE_LINE_TRUE: the store declares no realm release line (declareReleaseLine)',
    });
    const resolving = { get: async () => undefined };
    declareReleaseLine(resolving);
    await expect(storeReleaseLineLaw(resolving, () => resolving.get())).rejects.toMatchObject({
      message: 'STORE_RELEASE_LINE_TRUE: the provoked call resolved; expected the store to refuse',
    });
    const plainError = { get: async () => Promise.reject(new Error('missing')) };
    declareReleaseLine(plainError);
    await expect(storeReleaseLineLaw(plainError, () => plainError.get())).rejects.toMatchObject({
      message: `STORE_RELEASE_LINE_TRUE: the store declares realm ${REALM_BRAND.version}, but its refusal carries no realm release line — it is not a realm error`,
    });
  });
  it('realm’s own InMemoryStore passes', async () => {
    const store = new InMemoryStore();
    await expect(storeReleaseLineLaw(store, () => store.get('missing'))).resolves.toBeUndefined();
  });
});
