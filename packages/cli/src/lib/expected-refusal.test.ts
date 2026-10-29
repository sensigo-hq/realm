// expected-refusal.test.ts — #715 (a) correction 1 (C-6): the CLI entry's one handler for an expected
// typed refusal. The code in its list prints `Error: <message>` on stderr, sets exit code 1 and returns
// true; another `WorkflowError` and a plain `Error` print nothing and return false, so the entry
// rethrows them and they stay loud. Each assertion names (a) the change that turns it red and (b)
// what it prints: the lines written and the exit code.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowError } from '@sensigo/realm';
import { reportExpectedRefusal } from './expected-refusal.js';

const refusal = (code: string): WorkflowError =>
  new WorkflowError(`a refusal coded ${code}`, {
    code: code as 'STATE_TEST_CLOCK_FOREIGN',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
  });

function call(err: unknown): { handled: boolean; written: string[]; exitCode: unknown } {
  const before = process.exitCode;
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    const handled = reportExpectedRefusal(err);
    return {
      handled,
      written: write.mock.calls.map((c) => String(c[0])),
      exitCode: process.exitCode,
    };
  } finally {
    write.mockRestore();
    process.exitCode = before;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#715 (a) correction 1 (C-6) — reportExpectedRefusal', () => {
  it('the code in the list: one Error line on stderr, exit code 1, true', () => {
    // (a) red when the list loses the code, or the line its prefix; (b) prints what was written.
    const r = call(refusal('STATE_TEST_CLOCK_FOREIGN'));
    expect(r, JSON.stringify(r)).toEqual({
      handled: true,
      written: ['Error: a refusal coded STATE_TEST_CLOCK_FOREIGN\n'],
      exitCode: 1,
    });
  });

  it('read by its code, not its class: an object from another copy of the library is handled too', () => {
    // (a) red when the handler tests `instanceof WorkflowError`; (b) prints what was written.
    const foreign = { code: 'STATE_TEST_CLOCK_FOREIGN', message: 'from another copy' };
    const r = call(foreign);
    expect(r, JSON.stringify(r)).toEqual({
      handled: true,
      written: ['Error: from another copy\n'],
      exitCode: 1,
    });
  });

  it('another WorkflowError and a plain Error: nothing written, false — the entry rethrows them', () => {
    // (a) red when the handler takes every WorkflowError (it would hide bugs, #123); (b) prints what
    // was written for each.
    const other = call(refusal('STATE_RUN_NOT_FOUND'));
    const plain = call(new Error('a bug'));
    expect({ other, plain }, JSON.stringify({ other, plain })).toEqual({
      other: { handled: false, written: [], exitCode: other.exitCode },
      plain: { handled: false, written: [], exitCode: plain.exitCode },
    });
    expect([other.exitCode, plain.exitCode], 'the exit code is left alone').not.toContain(1);
  });
});
