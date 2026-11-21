// start-lines-c2c.test.ts — R1.3 callback C2c: the start lines' one pure function for the case a real
// start cannot be made to show (the key store's listing throws: line 8, in place of 6 and 7), and the
// one quote rule every entry refusal uses. The other lines are executed on the built `realm listen`
// (`commands/listen-switch-c2c.test.ts`).
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import { parseCallbackEntry } from './allow-list.js';
import { quotedEntry } from './entry-words.js';
import { callbackStartLines } from './start-lines.js';

const entry = (text: string) => {
  const p = parseCallbackEntry(text);
  if (!p.ok) throw new Error(text);
  return p.entry;
};

describe('C2c — the start lines when the stored keys cannot be listed', () => {
  it('one warning with the error, and no key line', () => {
    const lines = callbackStartLines({
      lists: { public: [entry('hooks.example.com')], private: [] },
      workflows: [{ id: 'refunds', folder: '/srv/refunds', takes: true }],
      master: { state: 'found', source: 'env', fp: '52fe6094' },
      keys: { error: 'database is locked' },
    });
    // (1) red when a listing that throws stops the start, prints key lines, or loses its message;
    //     (2) prints the lines.
    expect(lines).toEqual([
      {
        kind: 'text',
        level: 'info',
        text: 'allowed hosts: hooks.example.com:443; workflows that take callbacks: refunds',
      },
      { kind: 'text', level: 'info', text: 'encryption key 52fe6094 from REALM_ENCRYPTION_KEY' },
      {
        kind: 'text',
        level: 'warn',
        text: 'could not read the stored callback keys: database is locked',
      },
    ]);
  });
});

describe('C2c — the quote rule of an entry refusal', () => {
  it('up to the first / ? or # after any scheme, never with an @, never for userinfo', () => {
    // (1) red when a path, a query, a fragment, a password or a token is quoted back; (2) prints
    //     each quote.
    expect({
      path: quotedEntry('hooks.example.com/webhook/TOKEN'),
      query: quotedEntry('hooks.example.com?token=x'),
      fragment: quotedEntry('hooks.example.com#x'),
      scheme: quotedEntry('https://hooks.example.com/x'),
      at: quotedEntry('user:pw@hooks.example.com/x', 'path'),
      userinfo: quotedEntry('a', 'userinfo'),
      whole: quotedEntry('10.0.0.5'),
    }).toEqual({
      path: ' "hooks.example.com"',
      query: ' "hooks.example.com"',
      fragment: ' "hooks.example.com"',
      scheme: ' "https://hooks.example.com"',
      at: '',
      userinfo: '',
      whole: ' "10.0.0.5"',
    });
  });
});
