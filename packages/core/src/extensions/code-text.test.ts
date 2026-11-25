// code-text.test.ts — #828 unit 2a: `codeTextOf`, the fingerprint of a registered object's code
// (prompt feat-828-u2a-code-text.md rev 1). One cell per acceptance check, numbered as the prompt
// numbers them. Every assertion carries (1) the change that turns it red and (2) what it prints when
// it fails.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { codeTextOf } from './code-text.js';

const UNAVAILABLE = { absent: 'code_text_unavailable' };
const HASH = /^[0-9a-f]{64}$/;
/** A function's own text, as the rule reads it. */
const text = (fn: unknown): string => Function.prototype.toString.call(fn);
/** The sha256 of the rule's lines, built by hand. */
const sha = (lines: string[]): string =>
  createHash('sha256').update(lines.join('\n')).digest('hex');
/** The hash, or the word `code_text_unavailable`, so a failure prints which one it got. */
const hashOf = (impl: unknown): string => {
  const result = codeTextOf(impl);
  return 'code_text_sha256' in result ? result.code_text_sha256 : result.absent;
};
/** Two different hashes, each a hash. */
const expectTwoHashes = (a: unknown, b: unknown): void => {
  const [ha, hb] = [hashOf(a), hashOf(b)];
  expect(ha).toMatch(HASH);
  expect(hb).toMatch(HASH);
  expect(ha).not.toBe(hb);
};

describe('#828 unit 2a — codeTextOf', () => {
  it('check 1: the line format, pinned for an object literal, a class instance and a function', () => {
    // (1) red when a line's separator or slot word changes; (2) prints both hashes.
    const literal = {
      id: 'x',
      execute() {
        return 1;
      },
    };
    expect(codeTextOf(literal)).toEqual({
      code_text_sha256: sha([`0\0execute\0value\0${text(literal.execute)}`]),
    });
    class Handler {
      execute() {
        return 2;
      }
    }
    expect(codeTextOf(new Handler())).toEqual({
      code_text_sha256: sha([
        `1\0constructor\0value\0${text(Handler)}`,
        `1\0execute\0value\0${text(Handler.prototype.execute)}`,
      ]),
    });
    // A function's own text is its first line; an arrow function has no other function member.
    const fn = async () => 3;
    expect(codeTextOf(fn)).toEqual({ code_text_sha256: sha([`0\0\0self\0${text(fn)}`]) });
  });

  it('check 2: two plain functions with different bodies give two hashes', () => {
    // (1) red when the function's own line is left out (both read unavailable); (2) prints the two.
    expectTwoHashes(
      async () => 1,
      async () => 2,
    );
  });

  it('check 3: byte-identical child classes over two different bases give two hashes', () => {
    const childOfA = (() => {
      class Base {
        execute() {
          return 'a';
        }
      }
      class Child extends Base {}
      return new Child();
    })();
    const childOfB = (() => {
      class Base {
        execute() {
          return 'b';
        }
      }
      class Child extends Base {}
      return new Child();
    })();
    // The fixture's premise: the two child classes' texts are the same.
    expect(text(childOfA.constructor)).toBe(text(childOfB.constructor));
    // (1) red when the walk stops after the child (one hash); (2) prints the two.
    expectTwoHashes(childOfA, childOfB);
  });

  it('check 4: two ES5 constructors whose prototype methods differ give two hashes', () => {
    const instanceOfA = (() => {
      function X() {}
      X.prototype.execute = function () {
        return 'a';
      };
      return Reflect.construct(X, []) as object;
    })();
    const instanceOfB = (() => {
      function X() {}
      X.prototype.execute = function () {
        return 'b';
      };
      return Reflect.construct(X, []) as object;
    })();
    // (1) red when a level reads only its constructor's own text (one hash); (2) prints the two.
    expectTwoHashes(instanceOfA, instanceOfB);
  });

  it('check 5: the same members in another key order give one hash', () => {
    const a = {
      id: 'x',
      execute() {
        return 1;
      },
      cancel() {
        return 0;
      },
    };
    const b = {
      cancel() {
        return 0;
      },
      execute() {
        return 1;
      },
      id: 'x',
    };
    // (1) red when the keys are not sorted (two hashes); (2) prints the two.
    expect(hashOf(a)).toMatch(HASH);
    expect(hashOf(a)).toBe(hashOf(b));
  });

  it('check 6: a symbol-keyed method that differs gives two hashes', () => {
    const extra = Symbol('extra');
    const a = {
      execute() {
        return 1;
      },
      [extra]() {
        return 'a';
      },
    };
    const b = {
      execute() {
        return 1;
      },
      [extra]() {
        return 'b';
      },
    };
    // (1) red when the keys come from `Object.keys` (one hash); (2) prints the two.
    expectTwoHashes(a, b);
  });

  it('check 7: a getter that throws is never called, and the result is a hash', () => {
    let calls = 0;
    const impl = {
      execute() {
        return 1;
      },
      get boom(): never {
        calls++;
        throw new Error('the getter ran');
      },
    };
    // (1) red when a member is read by `impl[key]` (the getter runs, the result is unavailable);
    // (2) prints the result and the number of calls.
    expect(hashOf(impl)).toMatch(HASH);
    expect(calls).toBe(0);
  });

  it('check 8: an instance of a class extending Map gives a hash', () => {
    class Registry extends Map<string, number> {
      execute() {
        return 1;
      }
    }
    // (1) red when the walk reads the platform's level, `Map.prototype` (unavailable); (2) prints it.
    expect(hashOf(new Registry())).toMatch(HASH);
  });

  it('check 9: Object.create of two different literals gives two hashes', () => {
    const a = Object.create({
      execute() {
        return 'a';
      },
    }) as object;
    const b = Object.create({
      execute() {
        return 'b';
      },
    }) as object;
    // (1) red when the walk does not stop at `Object.prototype` (unavailable); (2) prints the two.
    expectTwoHashes(a, b);
  });

  it("check 10: a method that only contains the words '[native code]' is code", () => {
    const impl = {
      execute() {
        return '[native code]';
      },
    };
    // (1) red when any text containing "[native code]" is read as native (unavailable); (2) prints it.
    expect(hashOf(impl)).toMatch(HASH);
  });

  it('check 11: a bound, a native and a callable-Proxy member are each unavailable', () => {
    const bound = {
      execute: function () {
        return 1;
      }.bind(null),
    };
    const native = { execute: Math.max };
    const proxied = {
      execute: new Proxy(function () {
        return 1;
      }, {}),
    };
    // (1) red when a native text is hashed as code (three hashes); (2) prints each result.
    expect(codeTextOf(bound)).toEqual(UNAVAILABLE);
    expect(codeTextOf(native)).toEqual(UNAVAILABLE);
    expect(codeTextOf(proxied)).toEqual(UNAVAILABLE);
  });

  it('check 12: an object with no functions is unavailable', () => {
    // (1) red when no lines give the hash of empty text; (2) prints the result.
    expect(codeTextOf({ id: 'x', retries: 3 })).toEqual(UNAVAILABLE);
  });

  it('check 13: a Proxy whose ownKeys trap throws is unavailable, and nothing is thrown', () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('the ownKeys trap');
        },
      },
    );
    // (1) red when the trap's throw escapes; (2) prints the thrown error, or the result.
    let result: unknown;
    expect(() => {
      result = codeTextOf(hostile);
    }).not.toThrow();
    expect(result).toEqual(UNAVAILABLE);
  });

  it('check 14: a replaced toString does not hide two different bodies', () => {
    const same = () => 'function () {}';
    const f1 = function () {
      return 1;
    };
    f1.toString = same;
    const f2 = function () {
      return 2;
    };
    f2.toString = same;
    // (1) red when a function's text is `fn.toString()` (one hash); (2) prints the two.
    expectTwoHashes({ execute: f1 }, { execute: f2 });
  });

  describe('check 15: the depth limit', () => {
    /** A chain of `levels` objects above Object.prototype, each with its own function member. */
    const chain = (levels: number): object => {
      let o: object = Object.prototype;
      for (let i = 0; i < levels; i++) {
        o = Object.create(o) as object;
        (o as Record<string, unknown>)[`m${i}`] = function () {
          return i;
        };
      }
      return o;
    };

    it('66 levels are unavailable, and 65 levels give a hash', () => {
      // (1) red when there is no depth limit (66 levels give a hash); (2) prints the result.
      expect(codeTextOf(chain(66))).toEqual(UNAVAILABLE);
      expect(hashOf(chain(65))).toMatch(HASH);
    });

    it('a Proxy whose getPrototypeOf returns itself is unavailable after 65 steps', () => {
      // Without the limit the walk would never end: vitest's time limit cannot stop a loop that
      // never yields, so the run would hang. The trap therefore throws past 10,000 calls, which
      // also makes the result unavailable; the count tells the two apart.
      let calls = 0;
      const looping: object = new Proxy(
        {},
        {
          getPrototypeOf() {
            calls++;
            if (calls > 10_000) throw new Error('the safety stop');
            return looping;
          },
        },
      );
      // (1) red when there is no depth limit (the walk runs to the safety stop, 10,001 calls);
      // (2) prints the result and the number of calls.
      expect(codeTextOf(looping)).toEqual(UNAVAILABLE);
      expect(calls).toBe(65);
    });
  });

  it('check 16 (grounding): the same object read twice gives the same hash', () => {
    const impl = {
      execute() {
        return 1;
      },
    };
    expect(hashOf(impl)).toMatch(HASH);
    expect(hashOf(impl)).toBe(hashOf(impl));
  });
});
