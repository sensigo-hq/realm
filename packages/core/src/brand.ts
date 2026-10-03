// The release mark (issue #620 PR-B). npm sometimes installs realm more than once in a project: the
// project's own `@sensigo/realm`, and a copy nested under `@sensigo/realm-cli`, `@sensigo/realm-mcp`
// or `@sensigo/realm-testing`. Each copy has its own classes, so `err instanceof WorkflowError` is
// false for an error another copy made — and realm's own code, branching on that, quietly behaves
// differently (a handler's retryable error is not retried; a provider module is refused; a gc,
// purge or reclaim misreads a refusal).
//
// The mark lets copies of the SAME release recognise each other's objects. Every class a realm
// package exports carries, on its prototype, an object naming the package, the version and the
// release's generation, and an `instanceof` check that accepts an object carrying the same
// generation under the same key. Copies of different releases never share a generation, so they are
// never recognised: realm does not guess that a copy of another release behaves the same.
//
// A generation is, today, the whole version string, compared as a raw string — `'0.45.0'` and
// `'0.45.1'` are two generations. `createRealmBrand` is the one place that decides it, so a later
// release can widen what copies must share without touching a class or a call site.
//
// This module is a leaf: its only import is the package's own version. Nothing here reads a
// stack, an environment variable or the file system.
import { VERSION } from './version.js';

/** What one copy of one package says about itself, on the prototype of each class it defines. */
export interface RealmBrand {
  /** The defining package's name. */
  readonly package: string;
  /** What copies must share to recognise each other: today, the full version. */
  readonly generation: string;
  /** The version of the defining package. */
  readonly version: string;
  /** The package's root folder as a file URL; `null` when `import.meta.url` is not a string. */
  readonly url: string | null;
}

/**
 * The one key every realm class carries its brand under, whatever the class. A later release reads
 * any object's release line from here without knowing its class.
 */
export const RELEASE_LINE_KEY: symbol = Symbol.for('@sensigo/realm/release-line');

/** Marks the instance check `brandClass` installs, so a check can tell it from any other. */
const BRAND_CHECK_TAG: symbol = Symbol.for('@sensigo/realm/brand-check');

/** Builds the frozen mark. The one place that decides what a generation is. */
export function createRealmBrand(
  packageName: string,
  version: string,
  packageUrl: string | null,
): RealmBrand {
  return Object.freeze({
    package: packageName,
    generation: version,
    version,
    url: packageUrl,
  });
}

/**
 * Marks `Class` with `brand` and gives it an `instanceof` that recognises other copies of the same
 * release. Defines three properties, each non-enumerable, non-writable and non-configurable:
 *
 *  1. `Class.prototype[key]` — the class's identity across copies;
 *  2. `Class.prototype[RELEASE_LINE_KEY]` — one key for every realm class;
 *  3. `Class[Symbol.hasInstance]` — the check (set with `defineProperty`: assigning it throws).
 *
 * Nothing is added to an instance, so an object's own keys, `JSON.stringify` and
 * `Object.getOwnPropertySymbols` are what they were.
 *
 * The check runs the ordinary `instanceof` first and answers true when it does. Otherwise it answers
 * for `Class` only (a subclass that inherited the check gets the ordinary answer alone), and only
 * when the value carries the same generation under `key`. Reading the value never throws out of the
 * check: a hostile object answers false.
 */
export function brandClass(
  Class: abstract new (...args: never[]) => object,
  key: symbol,
  brand: RealmBrand,
): void {
  const fixed = { enumerable: false, writable: false, configurable: false } as const;
  Object.defineProperty(Class.prototype, key, { value: brand, ...fixed });
  Object.defineProperty(Class.prototype, RELEASE_LINE_KEY, { value: brand, ...fixed });

  const check = function (this: unknown, value: unknown): boolean {
    // The ordinary check first, outside any `try`: a revoked proxy throws here exactly as it does
    // for every other `instanceof`.
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    // An unmarked subclass inherited this method: the ordinary answer is the whole answer.
    if (this !== Class) return false;
    try {
      if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        return false;
      }
      const mark: unknown = (value as Record<symbol, unknown>)[key];
      if (typeof mark !== 'object' || mark === null) return false;
      return (mark as { generation?: unknown }).generation === brand.generation;
    } catch {
      return false;
    }
  };
  Object.defineProperty(check, BRAND_CHECK_TAG, { value: key, ...fixed });
  Object.defineProperty(Class, Symbol.hasInstance, { value: check, ...fixed });
}

/** This package's own mark: `@sensigo/realm`, at the version it was built at. */
export const REALM_BRAND: RealmBrand = createRealmBrand(
  '@sensigo/realm',
  VERSION,
  typeof import.meta.url === 'string' ? new URL('../', import.meta.url).href : null,
);
