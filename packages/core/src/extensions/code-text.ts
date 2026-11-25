// code-text.ts — the fingerprint of the code of an object a host program registers (#828 unit 2a).
//
// A host program can register its own handler, adapter or processor object with Realm. `codeTextOf`
// takes one fingerprint of that object's code, so later units can record it on every step the code
// serves and compare it between steps and runs (Prefect's task-source model: a task run is keyed by
// a hash of its function's code).
//
// What it covers: the text of the object's functions as loaded (for TypeScript loaded through jiti,
// jiti's output) and the object's own class chain, base classes included. What it does NOT cover:
// a closure's captured values, a function passed in at construction, or a module the code imports.
// Two objects whose code differs only there get one fingerprint.
//
// It never throws, and it never calls one of the object's getters, setters or methods: every member
// is read through its property descriptor, and every function's text through
// `Function.prototype.toString`. A Proxy's traps do run, as any read of a Proxy runs them.
import { createHash } from 'node:crypto';

/** The whole text of a function whose code cannot be read: a bound, native or callable-Proxy one. */
const NATIVE_TEXT = /^function\s*[\w$]*\s*\(\)\s*\{\s*\[native code\]\s*\}$/;
/** The deepest level read. A walk that reaches one level more, not at a stop, is unavailable. */
const MAX_LEVEL = 64;
/** A descriptor's function slots, in the order their lines are written. */
const SLOTS = ['value', 'get', 'set'] as const;

/** A function's own text, which the object cannot replace (unlike `fn.toString()`). */
const textOf = (fn: (...args: never[]) => unknown): string => Function.prototype.toString.call(fn);

/**
 * The sha256 of an object's code: one line per function, `<level>\0<key>\0<value|get|set>\0<text>`,
 * joined with `\n`. Level 0 is the object itself; each level above is the next prototype, child
 * first. A function object's own text comes first, as `0\0\0self\0<text>`.
 *
 * The walk stops at `null`, `Object.prototype`, `Function.prototype`, or a level whose own
 * `constructor` is a built-in function: that level and those above it are the platform's, and their
 * members are not read. Each level's own keys, symbols and non-enumerable ones included, are read in
 * the order of `String(key)`.
 *
 * Unavailable, never the hash of empty text: no function found; a function whose code cannot be read
 * (a bound, native or callable-Proxy one); a read that throws; or a chain deeper than 64 levels.
 */
export function codeTextOf(
  impl: unknown,
): { code_text_sha256: string } | { absent: 'code_text_unavailable' } {
  const unavailable = { absent: 'code_text_unavailable' } as const;
  try {
    const lines: string[] = [];
    if (typeof impl === 'function') {
      const text = textOf(impl as (...args: never[]) => unknown);
      if (NATIVE_TEXT.test(text)) return unavailable;
      lines.push(`0\0\0self\0${text}`);
    }
    let current: unknown = impl;
    for (let level = 0; ; level++) {
      if (current === null || current === Object.prototype || current === Function.prototype) break;
      const target = current as object;
      const ctor = Reflect.getOwnPropertyDescriptor(target, 'constructor');
      if (typeof ctor?.value === 'function' && NATIVE_TEXT.test(textOf(ctor.value))) break;
      if (level > MAX_LEVEL) return unavailable;
      const keys = Reflect.ownKeys(target)
        .map((key) => [String(key), key] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [name, key] of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        for (const slot of SLOTS) {
          const fn: unknown = descriptor?.[slot];
          if (typeof fn !== 'function') continue;
          const text = textOf(fn as (...args: never[]) => unknown);
          if (NATIVE_TEXT.test(text)) return unavailable;
          lines.push(`${level}\0${name}\0${slot}\0${text}`);
        }
      }
      current = Reflect.getPrototypeOf(target);
    }
    if (lines.length === 0) return unavailable;
    return { code_text_sha256: createHash('sha256').update(lines.join('\n')).digest('hex') };
  } catch {
    return unavailable;
  }
}
