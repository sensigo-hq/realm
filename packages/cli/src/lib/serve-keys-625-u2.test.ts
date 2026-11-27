// serve-keys-625-u2.test.ts — #625 named keys unit 2b: the key file's format 2 (prompt
// feat-625-named-keys-u2-limits.md rev 2.1, Behaviour 5 and check 6). A file whose keys have no limits
// is written as format 1, byte for byte as unit 1 wrote it; a file with a limited key is format 2,
// whose entries may carry one closed `limits` object. The reader takes both formats and treats a bad
// `limits` as a bad entry; the write function refuses to write what its reader would refuse (tested on
// the function, since `realm serve key add` checks its options first). The names and hashes are
// fictional. Beside each assertion: (1) the break that turns it red; (2) what it prints on failure.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readServeKeys,
  serveKeysPath,
  ServeKeysWriteRefused,
  writeServeKeys,
  type ServeKeyEntry,
} from './serve-keys.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'realm-nk2-file-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ANA: ServeKeyEntry = {
  name: 'ana',
  sha256: 'a'.repeat(64),
  created_at: '2026-11-26T10:00:00.000Z',
  expires_at: null,
};
const CI: ServeKeyEntry = {
  name: 'ci',
  sha256: 'b'.repeat(64),
  created_at: '2026-11-26T11:00:00.000Z',
  expires_at: '2026-12-26T11:00:00.000Z',
};
const text = (): string => readFileSync(serveKeysPath(home), 'utf8');
/** The temporary key files left in the home. */
const temps = (): string[] => readdirSync(home).filter((f) => f.endsWith('.tmp'));

/** A key file of `format` holding one entry, ANA with `limits` (raw JSON). */
function fileWith(format: number, limits: unknown): void {
  writeFileSync(
    serveKeysPath(home),
    `${JSON.stringify({ format, keys: [{ ...ANA, limits }] }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

describe('check 6 — the written file', () => {
  it('with no limits, the file is format 1, byte for byte as unit 1 wrote it', () => {
    writeServeKeys(home, [ANA, CI]);
    // (1) red when format 2 is written for a file with no limits, or an entry gains a member;
    //     (2) prints the file.
    expect(text()).toBe(
      [
        '{',
        '  "format": 1,',
        '  "keys": [',
        '    {',
        '      "name": "ana",',
        `      "sha256": "${'a'.repeat(64)}",`,
        '      "created_at": "2026-11-26T10:00:00.000Z",',
        '      "expires_at": null',
        '    },',
        '    {',
        '      "name": "ci",',
        `      "sha256": "${'b'.repeat(64)}",`,
        '      "created_at": "2026-11-26T11:00:00.000Z",',
        '      "expires_at": "2026-12-26T11:00:00.000Z"',
        '    }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('with one limited key, the file is format 2; the key with no limit carries none', () => {
    writeServeKeys(home, [ANA, { ...CI, limits: { read_only: true, workflows: ['invoices'] } }]);
    const file = JSON.parse(text()) as { format: number; keys: Array<Record<string, unknown>> };
    // (1) red when a limited key is written as format 1 (the reader then refuses it), or the
    //     unlimited entry gains `limits`; (2) prints the format and each entry's members.
    expect({ format: file.format, members: file.keys.map((k) => Object.keys(k)) }).toStrictEqual({
      format: 2,
      members: [
        ['name', 'sha256', 'created_at', 'expires_at'],
        ['name', 'sha256', 'created_at', 'expires_at', 'limits'],
      ],
    });
    // (1) red when the reader drops or changes the limits; (2) prints what it read.
    expect(readServeKeys(serveKeysPath(home))).toStrictEqual({
      state: 'valid',
      keys: [ANA, { ...CI, limits: { read_only: true, workflows: ['invoices'] } }],
    });
  });
});

describe('check 6 — the reader takes format 1 and format 2', () => {
  for (const [label, limits] of [
    ['read_only', { read_only: true }],
    ['tools', { tools: ['start_run', 'get_run_state'] }],
    ['workflows', { workflows: ['invoices', 'refunds'] }],
    ['read_only and workflows', { read_only: true, workflows: ['invoices'] }],
    ['tools and workflows', { tools: ['start_run'], workflows: ['invoices'] }],
  ] as const) {
    it(`format 2, ${label}: read as written`, () => {
      fileWith(2, limits);
      // (1) red when the reader refuses a valid limits form, or keeps it otherwise; (2) prints it.
      expect(readServeKeys(serveKeysPath(home))).toStrictEqual({
        state: 'valid',
        keys: [{ ...ANA, limits }],
      });
    });
  }

  it('format 2 with no limits on any key is read', () => {
    writeFileSync(serveKeysPath(home), `${JSON.stringify({ format: 2, keys: [ANA] })}\n`, {
      mode: 0o600,
    });
    // (1) red when format 2 requires a limit; (2) prints what it read.
    expect(readServeKeys(serveKeysPath(home))).toStrictEqual({ state: 'valid', keys: [ANA] });
  });

  it('format 1 never carries limits: an entry with them is not a valid entry', () => {
    fileWith(1, { read_only: true });
    // (1) red when format 1 accepts limits (an older reader would refuse the file); (2) prints it.
    expect(readServeKeys(serveKeysPath(home))).toStrictEqual({
      state: 'invalid',
      cause: 'entry 1 is not a valid key entry',
    });
  });

  it('format 3 is a format this Realm does not know', () => {
    fileWith(3, { read_only: true });
    // (1) red when an unknown format is read; (2) prints what it read.
    expect(readServeKeys(serveKeysPath(home))).toStrictEqual({
      state: 'invalid',
      cause: 'format 3, which this Realm does not know',
    });
  });
});

/** Every `limits` form the closed set refuses (Behaviour 5), each by the clause that refuses it. */
const INVALID: ReadonlyArray<readonly [string, unknown]> = [
  ['an unknown member (a typo)', { workflow: ['invoices'] }],
  ['an unknown member beside a valid one', { read_only: true, watch: true }],
  ['no member', {}],
  ['not an object (a list)', ['read_only']],
  ['not an object (null)', null],
  ['not an object (a string)', 'read_only'],
  ['read_only false', { read_only: false }],
  ['read_only a string', { read_only: 'true' }],
  ['read_only beside tools', { read_only: true, tools: ['start_run'] }],
  ['tools not a list', { tools: 'start_run' }],
  ['an empty tools list', { tools: [] }],
  ['an empty tools item', { tools: ['start_run', ''] }],
  ['a tools item not a string', { tools: [1] }],
  ['a tool realm serve does not offer', { tools: ['present_question'] }],
  ["a name on the list's prototype", { tools: ['constructor'] }],
  ['workflows not a list', { workflows: 'invoices' }],
  ['an empty workflows list', { workflows: [] }],
  ['an empty workflows item', { workflows: ['invoices', ''] }],
  ['a workflows item not a string', { workflows: [{}] }],
];

describe('check 6 — each invalid limits form', () => {
  for (const [label, limits] of INVALID) {
    it(`${label}: the entry is invalid when read, and the write function refuses it`, () => {
      fileWith(2, limits);
      const read = readServeKeys(serveKeysPath(home));
      rmSync(serveKeysPath(home));
      writeServeKeys(home, [ANA]);
      const before = text();
      let refusal: unknown;
      try {
        writeServeKeys(home, [ANA, { ...CI, limits } as unknown as ServeKeyEntry]);
      } catch (err) {
        refusal = err instanceof ServeKeysWriteRefused ? err.message : `other: ${String(err)}`;
      }
      // (1) red when the reader's clause for this form is dropped (the entry is read, and written);
      //     (2) prints the read, the write's refusal, and whether the file or a temp file changed.
      expect({ read, refusal, unchanged: text() === before, temps: temps() }).toStrictEqual({
        read: { state: 'invalid', cause: 'entry 1 is not a valid key entry' },
        refusal: 'the new key file would not be valid (entry 2 is not a valid key entry)',
        unchanged: true,
        temps: [],
      });
    });
  }
});
