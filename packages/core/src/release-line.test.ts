// issue #620 PR-C — the release-line helpers.
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  assertRegistryLine,
  assertReleaseLine,
  declareReleaseLine,
  describeForeignProvider,
  describeThrown,
  describeUnrecognised,
  releaseLineError,
  releaseLineOf,
} from './release-line.js';
import { REALM_BRAND, RELEASE_LINE_KEY, brandClass, createRealmBrand } from './brand.js';
import { WorkflowError } from './types/workflow-error.js';
import { ExtensionRegistry as RealExtensionRegistry } from './extensions/registry.js';

const KEY = Symbol.for('@sensigo/realm/WorkflowError');
const OTHER = createRealmBrand('@sensigo/realm', '9.9.9', 'file:///tmp/other-realm/');
const LOCAL_PATH = fileURLToPath(REALM_BRAND.url!).replace(/\/$/, '');

/** A WorkflowError of another realm copy, as that copy builds it. */
function foreignWorkflowError(code: unknown = 'SERVICE_RATE_LIMITED'): object {
  class WorkflowError extends Error {
    code = code;
  }
  brandClass(WorkflowError, KEY, OTHER);
  return new WorkflowError('rate limited');
}

const throwingProxy = new Proxy(
  {},
  {
    get() {
      throw new Error('hostile');
    },
    getPrototypeOf() {
      throw new Error('hostile');
    },
  },
);

describe('releaseLineOf', () => {
  it('a branded instance carries its package line', () => {
    expect(
      releaseLineOf(
        new WorkflowError('x', {
          code: 'ENGINE_INTERNAL',
          category: 'ENGINE',
          agentAction: 'stop',
          retryable: false,
        }),
      )?.generation,
    ).toBe(REALM_BRAND.generation);
  });
  it('a declared class carries this line', () => {
    class Store {}
    declareReleaseLine(Store);
    expect(releaseLineOf(new Store())?.version).toBe(REALM_BRAND.version);
  });
  it('a declared plain object carries this line, non-enumerably', () => {
    const store = { get: async () => undefined };
    declareReleaseLine(store);
    expect(releaseLineOf(store)?.version).toBe(REALM_BRAND.version);
    expect(Object.keys(store)).toEqual(['get']);
  });
  it('a plain Error, null and a throwing proxy carry none', () => {
    expect(releaseLineOf(new Error('x'))).toBeUndefined();
    expect(releaseLineOf(null)).toBeUndefined();
    expect(releaseLineOf(throwingProxy)).toBeUndefined();
  });
});

describe('declareReleaseLine', () => {
  it('re-declaring the same generation is a no-op', () => {
    class Store {}
    declareReleaseLine(Store);
    expect(() => declareReleaseLine(Store)).not.toThrow();
  });
  it('another generation throws MISMATCH naming both', () => {
    class Store {}
    Object.defineProperty(Store.prototype, RELEASE_LINE_KEY, { value: OTHER });
    let err: unknown;
    try {
      declareReleaseLine(Store);
    } catch (e) {
      err = e;
    }
    expect((err as WorkflowError).code).toBe('ENGINE_RELEASE_LINE_MISMATCH');
    expect((err as WorkflowError).message).toContain('9.9.9');
    expect((err as WorkflowError).message).toContain(REALM_BRAND.version);
  });
  it('a frozen object throws with the remedy', () => {
    const store = Object.freeze({ get: async () => undefined });
    expect(() => declareReleaseLine(store)).toThrow(/declare the object before freezing it/);
  });
});

describe('describeUnrecognised', () => {
  it('foreign_line for another copy of the same class', () => {
    const d = describeUnrecognised(foreignWorkflowError(), WorkflowError);
    expect(d.kind).toBe('foreign_line');
  });
  it('unbranded_copy for a same-named class with no mark', () => {
    class WorkflowError extends Error {}
    const d = describeUnrecognised(new WorkflowError('x'), RealWorkflowError);
    expect(d).toMatchObject({ kind: 'unbranded_copy', className: 'WorkflowError' });
  });
  it('not_realm for a plain Error', () => {
    expect(describeUnrecognised(new Error('x'), WorkflowError).kind).toBe('not_realm');
  });
  it('not_realm when the class has no installed check of its own (an unbranded subclass)', () => {
    class Sub extends WorkflowError {}
    expect(describeUnrecognised(foreignWorkflowError(), Sub).kind).toBe('not_realm');
  });
  it('a throwing proxy is not_realm', () => {
    expect(describeUnrecognised(throwingProxy, WorkflowError).kind).toBe('not_realm');
  });
});
const RealWorkflowError = WorkflowError;

describe('assertReleaseLine', () => {
  it('accepts this line', () => {
    class Store {}
    declareReleaseLine(Store);
    expect(() =>
      assertReleaseLine(new Store(), 'the run store handed to executeChain'),
    ).not.toThrow();
  });
  it('refuses another line as MISMATCH with both versions', () => {
    const store = {};
    Object.defineProperty(store, RELEASE_LINE_KEY, { value: OTHER });
    try {
      assertReleaseLine(store, 'the run store handed to executeChain');
      expect.unreachable();
    } catch (err) {
      expect((err as WorkflowError).code).toBe('ENGINE_RELEASE_LINE_MISMATCH');
      expect((err as WorkflowError).message).toBe(
        `The run store handed to executeChain (a plain object) belongs to realm 9.9.9 (/tmp/other-realm); this engine runs realm ${REALM_BRAND.version} (${LOCAL_PATH}). Realm objects do not cross versions. Hand realm a store from @sensigo/realm ${REALM_BRAND.version}, or install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`,
      );
    }
  });
  it('refuses no line as UNDECLARED', () => {
    class TenantScopedRunStore {}
    try {
      assertReleaseLine(new TenantScopedRunStore(), 'the run store handed to executeChain');
      expect.unreachable();
    } catch (err) {
      expect((err as WorkflowError).code).toBe('ENGINE_RELEASE_LINE_UNDECLARED');
      expect((err as WorkflowError).message).toBe(
        `The run store handed to executeChain (class TenantScopedRunStore) declares no realm release line. Realm identifies store errors by class, so every store it runs against must belong to the realm it runs on (${REALM_BRAND.version}). If the class is yours, declare it once: declareReleaseLine(TenantScopedRunStore), imported from the @sensigo/realm your store imports its errors from. If it is realm's own class, it comes from a realm too old to mark its classes: install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`,
      );
    }
  });
  it('remembers an accepted object: a second check makes no property read', () => {
    const target = { get: async () => undefined };
    declareReleaseLine(target);
    let reads = 0;
    const counted = new Proxy(target, {
      get(t, k, r) {
        reads += 1;
        return Reflect.get(t, k, r);
      },
    });
    assertReleaseLine(counted, 'r');
    const first = reads;
    assertReleaseLine(counted, 'r');
    expect(first).toBeGreaterThan(0);
    expect(reads).toBe(first);
  });
});

describe('releaseLineError', () => {
  it('names both versions and both paths, the role and the code', () => {
    const d = describeUnrecognised(foreignWorkflowError(), WorkflowError);
    if (d.kind === 'not_realm') throw new Error('setup');
    const err = releaseLineError(d, {
      role: "Handler 'lookup'",
      message: "Handler 'lookup' threw: rate limited",
      code: 'ENGINE_HANDLER_FAILED',
      foreignCode: 'SERVICE_RATE_LIMITED',
    });
    expect(err.message).toBe(
      `Handler 'lookup' threw a WorkflowError from realm 9.9.9 (/tmp/other-realm); this engine runs realm ${REALM_BRAND.version} (${LOCAL_PATH}). Realm objects do not cross versions, so its code 'SERVICE_RATE_LIMITED' and its retry setting were not used. Install @sensigo/realm@${REALM_BRAND.version} (and every other @sensigo package the project has, at ${REALM_BRAND.version}) in the project your code imports it from, or, when you run the realm command, run version 9.9.9 there: npm install --save-dev @sensigo/realm-cli@9.9.9, then npx realm.`,
    );
  });
  it('cuts the foreign code at 500 characters and replaces control characters', () => {
    const d = describeUnrecognised(foreignWorkflowError(), WorkflowError);
    if (d.kind === 'not_realm') throw new Error('setup');
    const long = releaseLineError(d, {
      role: 'r',
      message: 'm',
      code: 'ENGINE_INTERNAL',
      foreignCode: 'A'.repeat(600),
    });
    expect((long.details['unrecognised'] as { foreign_code: string }).foreign_code).toBe(
      `${'A'.repeat(500)}…[truncated]`,
    );
    const ctl = releaseLineError(d, {
      role: 'r',
      message: 'm',
      code: 'ENGINE_INTERNAL',
      foreignCode: 'X\u0000\n\u007fY',
    });
    expect((ctl.details['unrecognised'] as { foreign_code: string }).foreign_code).toBe('X???Y');
  });
  it('drops a non-string code and says so in the clause', () => {
    const d = describeUnrecognised(foreignWorkflowError(42), WorkflowError);
    if (d.kind === 'not_realm') throw new Error('setup');
    const err = releaseLineError(d, {
      role: 'r',
      message: 'm',
      code: 'ENGINE_INTERNAL',
      foreignCode: 42,
    });
    expect(err.message).toContain('so its code and its retry setting were not used');
    expect(err.details['unrecognised']).not.toHaveProperty('foreign_code');
  });
  it('unbranded_copy: the hedged clause, what was not used, the remedy with the other version unknown, foreign_code', () => {
    class WorkflowError extends Error {
      code = 'SERVICE_RATE_LIMITED';
    }
    const thrown = new WorkflowError('rate limited');
    const d = describeUnrecognised(thrown, RealWorkflowError);
    if (d.kind !== 'unbranded_copy') throw new Error('setup');
    const err = releaseLineError(d, {
      role: "Handler 'lookup'",
      message: "Handler 'lookup' threw: rate limited",
      code: 'ENGINE_HANDLER_FAILED',
      foreignCode: thrown.code,
    });
    expect(err.code).toBe('ENGINE_HANDLER_FAILED');
    expect(err.message).toBe(
      `Handler 'lookup' threw: rate limited — it looks like realm's WorkflowError by its class name but carries no release mark: an older realm copy that does not mark its classes, or another library's class of the same name. If it is realm's, its code 'SERVICE_RATE_LIMITED' and its retry setting were not used: install @sensigo/realm@${REALM_BRAND.version} (and every other @sensigo package the project has, at ${REALM_BRAND.version}) in the project your code imports it from, or, when you run the realm command, run the version the project has: npm install --save-dev @sensigo/realm-cli@<that version>, then npx realm (npm ls @sensigo/realm shows that version).`,
    );
    expect(err.details['unrecognised']).toEqual({
      class: 'WorkflowError',
      kind: 'unbranded_copy',
      local_version: REALM_BRAND.version,
      local_path: LOCAL_PATH,
      foreign_code: 'SERVICE_RATE_LIMITED',
    });
  });
  it('unbranded_copy with no readable string code: "its code and its retry setting were not used", no foreign_code', () => {
    class WorkflowError extends Error {}
    const d = describeUnrecognised(new WorkflowError('boom'), RealWorkflowError);
    if (d.kind !== 'unbranded_copy') throw new Error('setup');
    const err = releaseLineError(d, {
      role: "Handler 'lookup'",
      message: "Handler 'lookup' threw: boom",
      code: 'ENGINE_HANDLER_FAILED',
      foreignCode: undefined,
    });
    expect(err.message).toBe(
      `Handler 'lookup' threw: boom — it looks like realm's WorkflowError by its class name but carries no release mark: an older realm copy that does not mark its classes, or another library's class of the same name. If it is realm's, its code and its retry setting were not used: install @sensigo/realm@${REALM_BRAND.version} (and every other @sensigo package the project has, at ${REALM_BRAND.version}) in the project your code imports it from, or, when you run the realm command, run the version the project has: npm install --save-dev @sensigo/realm-cli@<that version>, then npx realm (npm ls @sensigo/realm shows that version).`,
    );
    expect(err.details['unrecognised']).not.toHaveProperty('foreign_code');
  });
});

describe('describeThrown', () => {
  it('prints every value without throwing', () => {
    expect(describeThrown(new Error('boom'))).toBe('boom');
    expect(describeThrown('s')).toBe('s');
    expect(describeThrown(null)).toBe('null');
    expect(describeThrown(undefined)).toBe('undefined');
    expect(describeThrown(Object.create(null))).toBe('(unprintable value)');
    expect(
      describeThrown({
        toString() {
          throw new Error('x');
        },
      }),
    ).toBe('(unprintable value)');
    const e = new Error('x');
    Object.defineProperty(e, 'message', {
      get() {
        throw new Error('y');
      },
    });
    expect(describeThrown(e)).toBe('(unreadable error)');
  });
});

describe('assertRegistryLine', () => {
  it('a registry of another release: MISMATCH, the whole message', () => {
    class ExtensionRegistry {}
    brandClass(ExtensionRegistry, Symbol.for('@sensigo/realm/ExtensionRegistry'), OTHER);
    try {
      assertRegistryLine(
        new ExtensionRegistry(),
        'the registry handed to executeChain',
        RealExtensionRegistry,
      );
      expect.unreachable();
    } catch (err) {
      expect((err as WorkflowError).code).toBe('ENGINE_RELEASE_LINE_MISMATCH');
      expect((err as WorkflowError).message).toBe(
        `The registry handed to executeChain (class ExtensionRegistry) belongs to realm 9.9.9 (/tmp/other-realm); this engine runs realm ${REALM_BRAND.version} (${LOCAL_PATH}). Realm objects do not cross versions. Hand realm a registry from @sensigo/realm ${REALM_BRAND.version}, or install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`,
      );
    }
  });
  it('a same-named class with no mark and a plain object are accepted; undefined is skipped', () => {
    class ExtensionRegistry {}
    expect(() =>
      assertRegistryLine(new ExtensionRegistry(), 'r', RealExtensionRegistry),
    ).not.toThrow();
    expect(() => assertRegistryLine({}, 'r', RealExtensionRegistry)).not.toThrow();
    expect(() => assertRegistryLine(undefined, 'r', RealExtensionRegistry)).not.toThrow();
  });
});

/** The message a call throws, or a failure when it does not throw. */
function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

// The per-member sweep (issue #620 PR-C, round 2) found these texts pinned by no cell; each is
// asserted whole here.
describe('the remaining minted texts, whole', () => {
  const OTHER_NO_URL = createRealmBrand('@sensigo/realm', '9.9.9', null);
  const OTHER_NOT_FILE = createRealmBrand(
    '@sensigo/realm',
    '9.9.9',
    'https://example.invalid/realm/',
  );
  const carrying = (brand: object): object => {
    const store = {};
    Object.defineProperty(store, RELEASE_LINE_KEY, { value: brand });
    return store;
  };

  it('declareReleaseLine on a class that already carries another release', () => {
    class Store {}
    Object.defineProperty(Store.prototype, RELEASE_LINE_KEY, { value: OTHER });
    expect(thrownMessage(() => declareReleaseLine(Store))).toBe(
      `declareReleaseLine(Store): it already carries realm 9.9.9 (/tmp/other-realm) — it is a realm class, or was declared by another copy of realm, and its line cannot change. Hand realm a store from this @sensigo/realm (${REALM_BRAND.version}, ${LOCAL_PATH}), or install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`,
    );
  });
  it('declareReleaseLine on realm’s own class of another release names it and the way out', () => {
    class JsonFileStore {}
    brandClass(JsonFileStore, Symbol.for('@sensigo/realm/JsonFileStore'), OTHER);
    expect(thrownMessage(() => declareReleaseLine(new JsonFileStore()))).toBe(
      `declareReleaseLine(JsonFileStore): it already carries realm 9.9.9 (/tmp/other-realm) — it is a realm class, or was declared by another copy of realm, and its line cannot change. Hand realm a store from this @sensigo/realm (${REALM_BRAND.version}, ${LOCAL_PATH}), or install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`,
    );
  });
  it('declareReleaseLine on an anonymous class and on a plain object that carry another release', () => {
    const Anonymous = (() => class {})();
    Object.defineProperty(Anonymous.prototype, RELEASE_LINE_KEY, { value: OTHER });
    expect(thrownMessage(() => declareReleaseLine(Anonymous))).toBe(
      `declareReleaseLine(an anonymous class): it already carries realm 9.9.9 (/tmp/other-realm) — it is a realm class, or was declared by another copy of realm, and its line cannot change. Hand realm a store from this @sensigo/realm (${REALM_BRAND.version}, ${LOCAL_PATH}), or install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`,
    );
    expect(thrownMessage(() => declareReleaseLine(carrying(OTHER)))).toBe(
      `declareReleaseLine(a plain object): it already carries realm 9.9.9 (/tmp/other-realm) — it is a realm class, or was declared by another copy of realm, and its line cannot change. Hand realm a store from this @sensigo/realm (${REALM_BRAND.version}, ${LOCAL_PATH}), or install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`,
    );
  });
  it('declareReleaseLine on a frozen object, a frozen prototype and an anonymous frozen prototype', () => {
    expect(
      thrownMessage(() => declareReleaseLine(Object.freeze({ get: async () => undefined }))),
    ).toBe(
      'declareReleaseLine(a plain object): the object cannot be extended (it is frozen, sealed or non-extensible). Declare the class, or declare the object before freezing it.',
    );
    class Store {}
    Object.freeze(Store.prototype);
    expect(thrownMessage(() => declareReleaseLine(Store))).toBe(
      "declareReleaseLine(Store): the class's prototype cannot be extended (it is frozen, sealed or non-extensible). Declare the class, or declare the object before freezing it.",
    );
    const Anonymous = (() => class {})();
    Object.freeze(Anonymous.prototype);
    expect(thrownMessage(() => declareReleaseLine(Anonymous))).toBe(
      "declareReleaseLine(an anonymous class): the class's prototype cannot be extended (it is frozen, sealed or non-extensible). Declare the class, or declare the object before freezing it.",
    );
  });
  it('a release mark with no folder, or a folder that is not a file URL, prints (path unknown)', () => {
    for (const brand of [OTHER_NO_URL, OTHER_NOT_FILE]) {
      expect(
        thrownMessage(() =>
          assertReleaseLine(carrying(brand), 'the run store handed to executeChain'),
        ),
      ).toBe(
        `The run store handed to executeChain (a plain object) belongs to realm 9.9.9 ((path unknown)); this engine runs realm ${REALM_BRAND.version} (${LOCAL_PATH}). Realm objects do not cross versions. Hand realm a store from @sensigo/realm ${REALM_BRAND.version}, or install every @sensigo package at one version (npm ls @sensigo/realm in the project, or npm ls -g @sensigo/realm for a global install, lists the copies).`,
      );
    }
  });
  it('a release mark with no package name prints (unknown package) in the provider refusal', () => {
    const value = {};
    Object.defineProperty(value, KEY, {
      value: { generation: '9.9.9', version: '9.9.9', url: 'file:///tmp/other-realm/' },
    });
    const d = describeUnrecognised(value, WorkflowError);
    if (d.kind !== 'foreign_line') throw new Error('setup');
    expect(describeForeignProvider(d)).toEqual([
      `Error: the provider module's WorkflowError comes from (unknown package) 9.9.9 (/tmp/other-realm); this realm command is @sensigo/realm ${REALM_BRAND.version} (${LOCAL_PATH}). Realm objects do not cross versions. Run realm 9.9.9 in the project: npm install --save-dev @sensigo/realm-cli@9.9.9, then npx realm; or install @sensigo/realm-cli@${REALM_BRAND.version} and @sensigo/realm@${REALM_BRAND.version} in the project.`,
    ]);
  });
});
