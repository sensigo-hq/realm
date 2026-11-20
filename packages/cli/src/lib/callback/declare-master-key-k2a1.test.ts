// declare-master-key-k2a1.test.ts — callback K2a-1 (R1.3): `declareMasterKey`, the one place the
// master key's value is declared to the writer. With the writer installed for a pipe (where declared
// values are masked), the master key's lowercase AND uppercase hex text are hidden, and another
// 64-hex text (a callback signing key) is not; a master whose hex has no letter (both texts the same)
// declares without error; and the writer is given exactly those two values, under two names (its map
// is keyed by name: one name for both would keep only the last, CB-K2A-AU-08).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { declareMasterKey } from './declare-master-key.js';
import * as writer from '../../output/writer.js';

const calls = vi.hoisted(() => ({ declared: [] as Record<string, string>[] }));

vi.mock('../../output/writer.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../output/writer.js')>();
  return {
    ...real,
    addDeclaredValues: (declared: Record<string, string>, notSecret?: readonly string[]) => {
      calls.declared.push({ ...declared });
      real.addDeclaredValues(declared, notSecret);
    },
  };
});

/** A master key whose hex text has letters in it. */
const MASTER = new Uint8Array(32).map((_, i) => (i * 37 + 171) % 256);
const LOWER = Buffer.from(MASTER).toString('hex');
const UPPER = LOWER.toUpperCase();
/** A callback signing key: 64 lowercase hex, not the master. */
const CALLBACK_KEY = 'c'.repeat(16) + 'd'.repeat(16) + '0123456789abcdef'.repeat(2);

let savedTTY: boolean | undefined;
beforeEach(() => {
  savedTTY = process.stdout.isTTY;
  process.stdout.isTTY = false;
  writer.installWriter('default');
  calls.declared.length = 0;
});
afterEach(() => {
  writer.writerTestSeams.reset();
  if (savedTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
  else process.stdout.isTTY = savedTTY;
});

/** Whether `text` still shows on stdout as the writer would show it. */
const shows = (text: string): boolean =>
  writer.writerTestSeams.visible(`v=${text};`).includes(text);

describe('callback K2a-1 — the master key declared to the writer', () => {
  it('both cases of the master are hidden; a callback key is not', () => {
    expect(LOWER).not.toBe(UPPER);
    const before = { lower: shows(LOWER), upper: shows(UPPER) };
    declareMasterKey(MASTER);
    // (1) red when both cases are declared under one name (the first is then forgotten), or only
    //     one case is declared, or a callback key is masked too; (2) prints each text's fate.
    expect({
      before,
      after: { lower: shows(LOWER), upper: shows(UPPER), callbackKey: shows(CALLBACK_KEY) },
    }).toEqual({
      before: { lower: true, upper: true },
      after: { lower: false, upper: false, callbackKey: true },
    });
  });

  it('the writer is given the two texts and nothing else; a master with no letter declares too', () => {
    const digits = new Uint8Array(32).fill(0x11);
    declareMasterKey(MASTER);
    declareMasterKey(digits);
    // (1) red when another value is declared, a name holds both cases, or a digits-only master
    //     throws; (2) prints every declaration.
    expect(calls.declared.map((d) => Object.values(d).sort())).toEqual([
      [LOWER, UPPER].sort(),
      ['11'.repeat(32), '11'.repeat(32)],
    ]);
    expect(shows('11'.repeat(32))).toBe(false);
  });
});
