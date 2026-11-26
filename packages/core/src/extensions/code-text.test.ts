// code-text.test.ts — #828 unit 2a: `codeTextOf`, the fingerprint of a registered object's code.
// Two prompts: "check N" is a cell of feat-828-u2a-code-text.md rev 1, numbered as it numbers them;
// "C1-N" is a check of its correction 1, feat-828-u2a-correction-1.md rev 2.1 (Node's own code is
// never counted as the host's). Every assertion carries (1) the change that turns it red and (2)
// what it prints when it fails.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
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
    // (2) prints the result and the number of calls, also when the getter's error was caught.
    expect({ result: hashOf(impl), calls }).toEqual({
      result: expect.stringMatching(HASH),
      calls: 0,
    });
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

  /** The hash of a class's own lines: its prototype's `constructor` and `execute`, at level 1. */
  const ownLines = (cls: { prototype: { execute: unknown } }): string =>
    sha([
      `1\0constructor\0value\0${text(cls)}`,
      `1\0execute\0value\0${text(cls.prototype.execute)}`,
    ]);

  it('C1-1: a platform function kept in a field gives no line (the real shape, fetchFn = fetch)', () => {
    type Fn = (...args: never[]) => unknown;
    class Handler {
      constructor(private readonly fetchFn: Fn = fetch) {}
      execute(): Fn {
        return this.fetchFn;
      }
    }
    // (1) red when the platform's functions are not left out (Node's own `fetch` and `setTimeout`
    // texts become level-0 lines); (2) prints both hashes.
    expect(codeTextOf(new Handler())).toEqual({ code_text_sha256: ownLines(Handler) });
    expect(codeTextOf(new Handler(setTimeout))).toEqual({ code_text_sha256: ownLines(Handler) });
  });

  it("C1-2: a class extending EventEmitter, or Readable, gives only its own class's lines", () => {
    class Emitting extends EventEmitter {
      execute() {
        return 1;
      }
    }
    class Reading extends Readable {
      execute() {
        return 2;
      }
    }
    // (1) red when a level whose own constructor is the platform's is not a stop (EventEmitter's
    // and the stream classes' lines are added); (2) prints the class and both hashes.
    for (const cls of [Emitting, Reading]) {
      expect({ cls: cls.name, result: codeTextOf(new cls()) }).toEqual({
        cls: cls.name,
        result: { code_text_sha256: ownLines(cls) },
      });
    }
  });

  it('C1-3: a method bound in its own constructor gives no line, and its class lines stay', () => {
    class Bound {
      constructor() {
        this.execute = this.execute.bind(this);
      }
      execute() {
        return 1;
      }
    }
    // (1) red when every bound member makes the result unavailable (rule 2 as on a0485060);
    // (2) prints the result.
    expect(codeTextOf(new Bound())).toEqual({ code_text_sha256: ownLines(Bound) });
  });

  describe('C1-4 (check 11 re-pinned): built-in and bound members', () => {
    function execute() {
      return 1;
    }

    it('a named built-in member outside the platform set gives no line', () => {
      const withBuiltIn = { execute, lookup: Map.prototype.get };
      // (1) red when every native-shape member makes the result unavailable (rule 2 as on
      // a0485060); (2) prints the result or the two hashes.
      expect(hashOf(withBuiltIn)).toMatch(HASH);
      expect(hashOf(withBuiltIn)).toBe(hashOf({ execute }));
    });

    it('any other bound member, and a callable-Proxy member, make the result unavailable', () => {
      const client = {
        send() {
          return 'sent';
        },
      };
      // A bound method of another object, kept under its own name: no later level holds `send`.
      class Sender {
        send: () => string;
        constructor(from: typeof client) {
          this.send = from.send.bind(from);
        }
        execute() {
          return 1;
        }
      }
      // A module function bound as a member: its name is `bound run`, not `bound execute`.
      function run() {
        return 2;
      }
      class Runner {
        constructor() {
          this.execute = run.bind(this);
        }
        execute() {
          return 1;
        }
      }
      // A delegate: `toString` is held only by `Object.prototype`, a level the walk does not read.
      const part = {
        toString() {
          return 'part';
        },
      };
      const fixtures = {
        'a bound method of another object': new Sender(client),
        'a module function bound as a member': new Runner(),
        'a delegate of bound methods': { toString: part.toString.bind(part), execute },
        'a callable-Proxy member': {
          execute,
          handle: new Proxy(function handle() {
            return 3;
          }, {}),
        },
      };
      // (1) red when every bound or callable-Proxy member gives no line (rule 2 as in the
      // correction's rev 1); (2) prints the fixture and its result.
      for (const [fixture, impl] of Object.entries(fixtures)) {
        expect({ fixture, result: codeTextOf(impl) }).toEqual({ fixture, result: UNAVAILABLE });
      }
    });
  });

  it('C1-5: a built-in getter and a symbol-named built-in as own members give no line', () => {
    function execute() {
      return 1;
    }
    const withBuiltIns: object = { execute, split: RegExp.prototype[Symbol.split] };
    // `Map.prototype`'s own `size` descriptor: a built-in getter, `function get size() { … }`.
    Object.defineProperty(
      withBuiltIns,
      'size',
      Reflect.getOwnPropertyDescriptor(Map.prototype, 'size') ?? {},
    );
    // (1) red when the native shape's name part is `[\w$]*` (`get size` and `[Symbol.split]` do
    // not match, so their texts are hashed); (2) prints the result or the two hashes.
    expect(hashOf(withBuiltIns)).toMatch(HASH);
    expect(hashOf(withBuiltIns)).toBe(hashOf({ execute }));
  });
});
