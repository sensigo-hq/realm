// Tests for the release mark (issue #620 PR-B). Copies of realm are simulated with separate classes
// marked under one key: the key is what makes two classes "the same class", the generation is what
// makes them "the same release".
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { brandClass, createRealmBrand, RELEASE_LINE_KEY, REALM_BRAND } from './brand.js';
import { WorkflowError } from './types/workflow-error.js';

const KEY = Symbol.for('@sensigo/brand-test/Thing');
const TAG = Symbol.for('@sensigo/realm/brand-check');

/** One simulated copy of a class: a fresh class, marked under KEY at `generation`. */
function copyAt(generation: string) {
  class Thing {
    readonly label = 'thing';
  }
  brandClass(Thing, KEY, createRealmBrand('@sensigo/brand-test', generation, null));
  return Thing;
}

const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

describe('copies of one release recognise each other', () => {
  it('a class recognises its own instances', () => {
    const A = copyAt('0.45.0');
    expect(new A() instanceof A).toBe(true);
  });

  it('another class under the same key and the same generation: true, both directions', () => {
    const A = copyAt('0.45.0');
    const B = copyAt('0.45.0');
    expect(A).not.toBe(B);
    expect(new A() instanceof B).toBe(true);
    expect(new B() instanceof A).toBe(true);
  });

  it('a user subclass of the other class is recognised', () => {
    const A = copyAt('0.45.0');
    const B = copyAt('0.45.0');
    class Sub extends B {}
    expect(new Sub() instanceof A).toBe(true);
  });

  it('an instance made with Object.create(prototype) is recognised: the mark is on the prototype', () => {
    const A = copyAt('0.45.0');
    const B = copyAt('0.45.0');
    expect(Object.create(A.prototype) instanceof A).toBe(true);
    expect(Object.create(B.prototype) instanceof A).toBe(true);
  });
});

describe('copies of different releases never do', () => {
  it('0.45.0 against 0.45.1: false, both directions', () => {
    const A = copyAt('0.45.0');
    const B = copyAt('0.45.1');
    expect(new A() instanceof B).toBe(false);
    expect(new B() instanceof A).toBe(false);
  });

  it('0.47 against 0.47.0: false — the generation is compared as a raw string', () => {
    const A = copyAt('0.47');
    const B = copyAt('0.47.0');
    expect(new A() instanceof B).toBe(false);
    expect(new B() instanceof A).toBe(false);
  });
});

describe('subclasses', () => {
  it('an instance of the base is not an instance of a subclass: the ordinary check alone decides', () => {
    const A = copyAt('0.45.0');
    class Sub extends A {}
    expect(new A() instanceof Sub).toBe(false);
    // The same through another copy of the same release: a subclass is never "recognised" by mark.
    const B = copyAt('0.45.0');
    expect(new B() instanceof Sub).toBe(false);
  });

  it('an instance of a user subclass is an instance of that subclass', () => {
    const A = copyAt('0.45.0');
    class Sub extends A {}
    expect(new Sub() instanceof Sub).toBe(true);
    expect(new Sub() instanceof A).toBe(true);
  });
});

describe('what is not an instance', () => {
  it('a plain Error, null, undefined, a number, a string', () => {
    const A = copyAt('0.45.0');
    const values: unknown[] = [new Error('x'), null, undefined, 42, 'thing'];
    for (const value of values) expect(value instanceof A).toBe(false);
  });

  it('an object rebuilt from JSON is not; an instance carries no own symbol; JSON.stringify never shows the mark', () => {
    const A = copyAt('0.45.0');
    const instance = new A();
    expect(JSON.parse(JSON.stringify(instance)) instanceof A).toBe(false);
    expect(Object.getOwnPropertySymbols(instance)).toEqual([]);
    const json = JSON.stringify(instance);
    expect(json).not.toContain('0.45.0');
    expect(json).not.toContain('@sensigo/brand-test');
  });

  it('a Proxy whose get trap throws: false, and no throw', () => {
    const A = copyAt('0.45.0');
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('no reading me');
        },
      },
    );
    let answer: boolean | undefined;
    expect(() => {
      answer = hostile instanceof A;
    }).not.toThrow();
    expect(answer).toBe(false);
  });

  it('a revoked proxy: throws exactly when `revoked instanceof Error` throws', () => {
    const A = copyAt('0.45.0');
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const ordinary = throws(() => proxy instanceof Error);
    expect(ordinary).toBe(true); // sanity: the ordinary check throws on a revoked proxy
    expect(throws(() => proxy instanceof A)).toBe(ordinary);
  });

  it('an object built by Reflect.construct(Error, [], Object) is not an instance', () => {
    const A = copyAt('0.45.0');
    expect(Reflect.construct(Error, [], Object) instanceof A).toBe(false);
    expect(Reflect.construct(Error, [], Object) instanceof WorkflowError).toBe(false);
  });
});

describe('what brandClass installs', () => {
  it('three properties, each non-enumerable, non-writable and non-configurable', () => {
    const A = copyAt('0.45.0');
    const fixed = { enumerable: false, writable: false, configurable: false };
    expect(Object.getOwnPropertyDescriptor(A.prototype, KEY)).toMatchObject(fixed);
    expect(Object.getOwnPropertyDescriptor(A.prototype, RELEASE_LINE_KEY)).toMatchObject(fixed);
    expect(Object.getOwnPropertyDescriptor(A, Symbol.hasInstance)).toMatchObject(fixed);
  });

  it('the tag on the check equals the key; the release-line key holds the same object as the identity key', () => {
    const A = copyAt('0.45.0');
    const check = Object.getOwnPropertyDescriptor(A, Symbol.hasInstance)?.value as object;
    expect(Object.getOwnPropertyDescriptor(check, TAG)?.value).toBe(KEY);
    const protoMarks = A.prototype as unknown as Record<symbol, unknown>;
    expect(protoMarks[RELEASE_LINE_KEY]).toBe(protoMarks[KEY]);
  });

  it('a real class carries its package’s mark under both keys', () => {
    const protoMarks = WorkflowError.prototype as unknown as Record<symbol, unknown>;
    expect(protoMarks[Symbol.for('@sensigo/realm/WorkflowError')]).toBe(REALM_BRAND);
    expect(protoMarks[RELEASE_LINE_KEY]).toBe(REALM_BRAND);
  });

  it('createRealmBrand: frozen, generation and version are the string as given, four fields in order', () => {
    const brand = createRealmBrand('p', '1.2.3', null);
    expect(Object.isFrozen(brand)).toBe(true);
    expect(brand.generation).toBe('1.2.3');
    expect(brand.version).toBe('1.2.3');
    expect(Object.keys(brand)).toEqual(['package', 'generation', 'version', 'url']);
    expect(brand).toEqual({ package: 'p', generation: '1.2.3', version: '1.2.3', url: null });
  });

  it('an abstract class can be marked (this file type-checks under typecheck:tests)', () => {
    abstract class Base {
      abstract name(): string;
    }
    class Concrete extends Base {
      name(): string {
        return 'concrete';
      }
    }
    brandClass(Base, KEY, createRealmBrand('@sensigo/brand-test', '0.45.0', null));
    expect(new Concrete() instanceof Base).toBe(true);
  });

  it('narrowing: after `instanceof WorkflowError` the code reads `e.code` with no cast', () => {
    const read = (e: unknown): string | undefined => {
      if (e instanceof WorkflowError) return e.code;
      return undefined;
    };
    const err = new WorkflowError('x', {
      code: 'ENGINE_HANDLER_FAILED',
      category: 'ENGINE',
      agentAction: 'stop',
      retryable: false,
    });
    expect(read(err)).toBe('ENGINE_HANDLER_FAILED');
    expect(read(new Error('x'))).toBeUndefined();
  });
});

describe('the brand modules import only what a leaf may', () => {
  const imports = (source: string): string[] =>
    [...source.matchAll(/^import\b[^;]*?\bfrom\s+'([^']+)';/gm)].map((m) => m[1]!);

  it('core’s brand.ts has exactly one import statement, from ./version.js', async () => {
    const source = await readFile(new URL('./brand.ts', import.meta.url), 'utf8');
    expect(imports(source)).toEqual(['./version.js']);
  });

  it.each(['cli', 'mcp-server', 'testing'])(
    '%s’s src/brand.ts imports only from @sensigo/realm and ./version.js',
    async (dir) => {
      const source = await readFile(new URL(`../../${dir}/src/brand.ts`, import.meta.url), 'utf8');
      expect(imports(source).sort()).toEqual(['./version.js', '@sensigo/realm']);
    },
  );
});
