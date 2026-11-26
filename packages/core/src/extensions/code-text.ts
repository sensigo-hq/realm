// code-text.ts — the fingerprint of the code of an object a host program registers (#828 unit 2a).
//
// A host program can register its own handler, adapter or processor object with Realm. `codeTextOf`
// takes one fingerprint of that object's code, so later units can record it on every step the code
// serves and compare it between steps and runs (Prefect's task-source model: a task run is keyed by
// a hash of its function's own code).
//
// Covered: the text of the object's own functions and of its class chain, base classes included,
// and a function kept in an own field of the object: two different host functions give two hashes.
//
// Not covered:
// - a function kept in an object a field points to, in a `#private` field, or in a closure;
// - a module the code imports;
// - the platform's functions among the own properties of `globalThis`, of its object- and
//   function-valued data properties, and of `node:events`' and `node:stream`'s exports: an injected
//   platform function gives no line, so a Node upgrade alone does not change the fingerprint;
// - a named native member, and a method bound in its own constructor (its target is read on the
//   prototype).
//
// Still covered, though it can change with Node: a platform method reached through a prototype or
// an accessor (`crypto.randomUUID`, `performance.now`), a function from another Node module
// (`node:timers/promises`), and a class extending another Node module's class.
//
// For TypeScript loaded through jiti the text is jiti's output, and `import.meta.url` inside a
// method becomes the file's absolute URL: the same code deployed to another folder hashes differently.
//
// It never throws, and it never calls one of the object's getters, setters or methods: every member
// is read through its property descriptor, and every function's text through
// `Function.prototype.toString`. A Proxy's traps do run, as any read of a Proxy runs them.
import { createHash } from 'node:crypto';

/**
 * The whole text of a function whose code cannot be read. The name part is empty for a bound
 * function or a callable Proxy, and holds the name for a built-in one (`max`, `get size`,
 * `[Symbol.split]`). No host code has this text: each is a SyntaxError as source.
 */
const NATIVE_TEXT = /^function\s*([^(]*)\s*\(\)\s*\{\s*\[native code\]\s*\}$/;
/** The deepest level read. A walk that reaches one level more, not at a stop, is unavailable. */
const MAX_LEVEL = 64;
/** A descriptor's function slots, in the order their lines are written. */
const SLOTS = ['value', 'get', 'set'] as const;

/** A function's own text, which the object cannot replace (unlike `fn.toString()`). */
const textOf = (fn: object): string => Function.prototype.toString.call(fn);
const isObject = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

let platform: ReadonlySet<unknown> | undefined;

/**
 * The platform's own functions, by identity, built once per process on first use and kept: every
 * function among the own properties of `globalThis` and of its object- and function-valued data
 * properties; in Node, every function exported by `node:events` and `node:stream`; and, for each,
 * the constructors on its `prototype`'s chain. It reads only the platform's values, never the host's
 * object, and skips a property whose read throws.
 */
function platformFunctions(): ReadonlySet<unknown> {
  if (platform) return platform;
  const found = new Set<unknown>();
  const read = <T>(get: () => T): T | undefined => {
    try {
      return get();
    } catch {
      return undefined;
    }
  };
  const addOwn = (target: object, follow: boolean): void => {
    for (const key of read(() => Reflect.ownKeys(target)) ?? []) {
      const descriptor = read(() => Reflect.getOwnPropertyDescriptor(target, key));
      for (const slot of SLOTS)
        if (typeof descriptor?.[slot] === 'function') found.add(descriptor[slot]);
      const value: unknown = descriptor?.value;
      if (follow && isObject(value)) addOwn(value, false);
    }
  };
  addOwn(globalThis, true);
  // Node's built-in-module loader, where this Node has one (22.3 and later): each call names its
  // module as a literal, so the #616 one-loader scan can tell it never loads SQLite. Without the
  // loader, or when it is not a function, the call gives nothing (its throw is caught).
  const proc = read(() => globalThis.process);
  const modules: unknown[] = [
    read(() => proc?.getBuiltinModule?.('node:events')),
    read(() => proc?.getBuiltinModule?.('node:stream')),
  ];
  for (const exported of modules) {
    if (typeof exported === 'function') found.add(exported);
    if (isObject(exported)) addOwn(exported, false);
  }
  for (const fn of [...found]) {
    let proto: unknown = read(() => (fn as { prototype?: unknown }).prototype);
    for (let level = 0; isObject(proto) && level <= MAX_LEVEL; level++) {
      const at: object = proto;
      const ctor: unknown = read(() => Reflect.getOwnPropertyDescriptor(at, 'constructor'))?.value;
      if (typeof ctor === 'function') found.add(ctor);
      proto = read(() => Reflect.getPrototypeOf(at));
    }
  }
  platform = found;
  return found;
}

/** `null`, `Object.prototype`, `Function.prototype`, or a level whose own `constructor` is the platform's. */
const isStop = (level: unknown, platformFns: ReadonlySet<unknown>): boolean => {
  if (level === null || level === Object.prototype || level === Function.prototype) return true;
  const ctor: unknown = Reflect.getOwnPropertyDescriptor(level as object, 'constructor')?.value;
  return typeof ctor === 'function' && (platformFns.has(ctor) || NATIVE_TEXT.test(textOf(ctor)));
};

/**
 * The sha256 of an object's code: one line per function, `<level>\0<key>\0<value|get|set>\0<text>`,
 * joined with `\n`. Level 0 is the object itself; each level above is the next prototype, child
 * first. A function object's own text comes first, as `0\0\0self\0<text>`.
 *
 * The walk stops at `null`, `Object.prototype`, `Function.prototype`, or a level whose own
 * `constructor` is the platform's (in the set above, or built-in): that level and those above it
 * are the platform's, and their members are not read. Each level's own keys, symbols and
 * non-enumerable ones included, are read in the order of `String(key)`.
 *
 * No line: a member whose function is the platform's (in the set above); a named built-in member;
 * a method bound in its own constructor, whose own `name` is `bound <key>` and whose method sits on
 * a later level the walk reads.
 *
 * Unavailable, never the hash of empty text: no line produced; the object itself a bound, built-in
 * or callable-Proxy function; any other bound member (a bound `EventEmitter` method is unavailable)
 * or a callable-Proxy member; a read that throws; or a chain deeper than 64 levels.
 */
export function codeTextOf(
  impl: unknown,
): { code_text_sha256: string } | { absent: 'code_text_unavailable' } {
  const unavailable = { absent: 'code_text_unavailable' } as const;
  try {
    const platformFns = platformFunctions();
    const lines: string[] = [];
    if (typeof impl === 'function') {
      const text = textOf(impl);
      if (NATIVE_TEXT.test(text)) return unavailable;
      lines.push(`0\0\0self\0${text}`);
    }
    // The levels the walk reads: the object, then each prototype, up to the first stop.
    const levels: object[] = [];
    for (
      let current: unknown = impl;
      !isStop(current, platformFns);
      current = Reflect.getPrototypeOf(current as object)
    ) {
      if (levels.length > MAX_LEVEL) return unavailable;
      levels.push(current as object);
    }
    for (const [level, target] of levels.entries()) {
      const keys = Reflect.ownKeys(target)
        .map((key) => [String(key), key] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      for (const [name, key] of keys) {
        const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
        for (const slot of SLOTS) {
          const fn: unknown = descriptor?.[slot];
          if (typeof fn !== 'function' || platformFns.has(fn)) continue;
          const text = textOf(fn);
          const native = NATIVE_TEXT.exec(text);
          if (native) {
            if (native[1]?.trim()) continue;
            const boundOwn =
              Reflect.getOwnPropertyDescriptor(fn, 'name')?.value === `bound ${name}` &&
              levels
                .slice(level + 1)
                .some(
                  (later) =>
                    typeof Reflect.getOwnPropertyDescriptor(later, key)?.value === 'function',
                );
            if (boundOwn) continue;
            return unavailable;
          }
          lines.push(`${level}\0${name}\0${slot}\0${text}`);
        }
      }
    }
    if (lines.length === 0) return unavailable;
    return { code_text_sha256: createHash('sha256').update(lines.join('\n')).digest('hex') };
  } catch {
    return unavailable;
  }
}
