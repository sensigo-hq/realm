// door-words-c2.test.ts — R1.3 callback C2 correction 1: two sentences an operator reads, from their
// pure functions. The no-key fix for a pair with no key, by what the process knows of its own master
// key (a fingerprint, none, unknown): a process with none must be restarted after the key is made,
// since it reads its master key only at start. And the `inspect` line of a failed callback, which
// says "1 attempt" and "<n> attempts".
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import type { CallbackView } from '@sensigo/realm';
import { noKeyFix } from './door.js';
import { callbackLine } from './inspect-line.js';

const CMD = 'realm callback key /srv/flows --host hooks.example.com:443';

describe('C2 correction 1 — the no-key fix for a pair with no key', () => {
  it('a fingerprint: make a key; none: restart after you make one; unknown: make a key', () => {
    const none = { ok: false, state: 'none' } as const;
    // (1) red when a process with no master key is told only to make a key (the same process then
    //     refuses again), or another case changes; (2) prints the three texts.
    expect({
      fingerprint: noKeyFix(none, 'c0ffee01', CMD),
      noMaster: noKeyFix(none, null, CMD),
      unknown: noKeyFix(none, undefined, CMD),
    }).toEqual({
      fingerprint: `make a key with: ${CMD}`,
      noMaster: `this process has no encryption key; restart realm listen after you make a key with: ${CMD}`,
      unknown: `make a key with: ${CMD}`,
    });
  });
});

describe('C2 correction 1 — the inspect line of a failed callback', () => {
  it('1 attempt, 2 attempts, 0 attempts', () => {
    const failed = (attempts: number, last: number): CallbackView => ({
      workflow_id: 'refunds',
      host: 'hooks.example.com:443',
      status: 'failed',
      attempts,
      created_at: '2026-11-21T12:00:00.000Z',
      next_attempt_at: '2026-11-21T12:00:00.000Z',
      last_status: last,
    });
    const at = new Date('2026-11-21T12:02:00.000Z');
    // (1) red when the count always takes "attempts" (or never); (2) prints the three lines.
    expect([
      callbackLine(failed(1, 410), true, at),
      callbackLine(failed(2, 503), true, at),
      callbackLine(failed(0, 410), true, at),
    ]).toEqual([
      'Callback: failed after 1 attempt, last answer 410',
      'Callback: failed after 2 attempts, last answer 503',
      'Callback: failed after 0 attempts, last answer 410',
    ]);
  });
});
