// listen-flags-744.test.ts — issue #744: `realm listen`'s three limit flags take only a whole number
// from 1 to 2147483647. Until now `parseInt` took anything, and a `--max-concurrent` that was not a
// number applied no limit at all.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { parseListenLimit } from './listen.js';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const MESSAGE = ' must be a whole number from 1 to 2147483647.';

describe('parseListenLimit (issue #744)', () => {
  const parse = parseListenLimit('--max-concurrent');

  it('accepts a whole number from 1 to 2147483647', () => {
    // (a) red when a valid value is refused or changed; (b) prints the parsed values.
    expect([parse('1'), parse('20'), parse('2147483647')]).toEqual([1, 20, 2147483647]);
  });

  it.each(['abc', '0', '1.5', '', '2147483648'])('refuses %j with the message', (value) => {
    // (a) red when the value is taken, or the message changes; (b) prints the thrown error.
    expect(() => parse(value)).toThrow(InvalidArgumentError);
    expect(() => parse(value)).toThrow(`--max-concurrent${MESSAGE}`);
  });
});

describe('realm listen through the built CLI: a bad limit flag (issue #744)', () => {
  it.each([
    ['--max-concurrent', 'abc'],
    ['--max-body-bytes', '0'],
    ['--body-timeout-ms', '1.5'],
  ])(
    'listen %s %s: exit 1, Commander’s line',
    (flag, value) => {
      // A scratch HOME and working folder with no workflow: nothing of the real ~/.realm is read, no
      // `.env` of this repository is loaded, and nothing could start if the flag were taken.
      const home = mkdtempSync(join(tmpdir(), 'realm-744-flags-'));
      try {
        const r = spawnSync(process.execPath, [CLI_ENTRY, 'listen', flag, value], {
          cwd: home,
          env: { PATH: process.env['PATH'] ?? '', HOME: home },
          encoding: 'utf8',
          timeout: 20_000,
        });
        // (a) red when the CLI takes the value (it then stops on something else, such as the
        //     missing workflow), or the message changes; (b) prints the exit code and standard error.
        expect({ status: r.status, stderr: r.stderr.trim() }).toEqual({
          status: 1,
          stderr: `error: option '${flag} <n>' argument '${value}' is invalid. ${flag}${MESSAGE}`,
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
