// option-parsers.test.ts — issues #944, #949: the value parsers of `realm listen` and `realm serve`.
// One assertion per input: (a) each cell is red when its parser drops the rule the input names;
// (b) on a failing host it prints the parser, the input (the test's own constant, never the
// environment) and what the parser returned or the sentence it threw.
import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { parseHost, parseOneOf, parseWholeNumber } from './option-parsers.js';

/** What a parser does with one input: `{ ok: value }` or `{ refused: sentence }`. */
function outcome<T>(parse: (value: string) => T, input: string): { ok: T } | { refused: string } {
  try {
    return { ok: parse(input) };
  } catch (err) {
    if (err instanceof InvalidArgumentError) return { refused: err.message };
    throw err;
  }
}

describe('parseWholeNumber (issues #944, #949)', () => {
  const port = parseWholeNumber('--port', 0, 65535);
  const PORT_REFUSED = { refused: '--port must be a whole number from 0 to 65535.' };
  it.each([
    ['0', 0],
    ['3000', 3000],
    ['65535', 65535],
  ])("--port accepts '%s'", (input, expected) => {
    expect(outcome(port, input), `--port ${JSON.stringify(input)}`).toEqual({ ok: expected });
  });
  it.each(['65536', '-1', '3000abc', 'abc', '', ' 5', '1.5', '1e3', '0x10', '+5'])(
    "--port refuses '%s'",
    (input) => {
      expect(outcome(port, input), `--port ${JSON.stringify(input)}`).toEqual(PORT_REFUSED);
    },
  );
  const sweep = parseWholeNumber('--sweep-expired-gates', 1, 2147483);
  it.each(['0', '2147484', 'abc'])("--sweep-expired-gates refuses '%s'", (input) => {
    expect(outcome(sweep, input), `--sweep-expired-gates ${JSON.stringify(input)}`).toEqual({
      refused: '--sweep-expired-gates must be a whole number from 1 to 2147483.',
    });
  });
});

describe('parseOneOf (issues #944, #949)', () => {
  const level = parseOneOf('--log-level', ['debug', 'info', 'warn', 'error']);
  const store = parseOneOf('--dedup-store', ['file', 'memory']);
  it.each(['debug', 'info', 'warn', 'error'])("--log-level accepts '%s'", (input) => {
    expect(outcome(level, input), `--log-level ${JSON.stringify(input)}`).toEqual({ ok: input });
  });
  it.each(['file', 'memory'])("--dedup-store accepts '%s'", (input) => {
    expect(outcome(store, input), `--dedup-store ${JSON.stringify(input)}`).toEqual({ ok: input });
  });
  it.each(['bogus', 'INFO', ''])("--log-level refuses '%s'", (input) => {
    expect(outcome(level, input), `--log-level ${JSON.stringify(input)}`).toEqual({
      refused: '--log-level must be debug, info, warn or error.',
    });
  });
  it.each(['mem', 'File', ''])("--dedup-store refuses '%s'", (input) => {
    expect(outcome(store, input), `--dedup-store ${JSON.stringify(input)}`).toEqual({
      refused: '--dedup-store must be file or memory.',
    });
  });
});

describe('parseHost (issues #944, #949)', () => {
  const host = parseHost('--host');
  it.each([
    '127.0.0.1',
    '::1',
    '0.0.0.0',
    'localhost',
    'my_service',
    'a.b-c.example',
    'fe80::1%eth0',
    '[::1]',
    'example.com.',
  ])("accepts '%s' (the operating system judges it)", (input) => {
    expect(outcome(host, input), `--host ${JSON.stringify(input)}`).toEqual({ ok: input });
  });
  it.each([
    ['the empty string', ''],
    ['a space inside', 'a b'],
    ['a leading space', ' localhost'],
    ['a tab', 'a\tb'],
    ['a following flag', '--strict'],
    ['a short flag', '-x'],
    ['a lone dash', '-'],
    ['a newline', 'local\nhost'],
    ['another control character', 'local\u0007host'],
  ])('refuses %s', (_what, input) => {
    expect(outcome(host, input), `--host ${JSON.stringify(input)}`).toEqual({
      refused: '--host must be an IP address or a host name.',
    });
  });
});
