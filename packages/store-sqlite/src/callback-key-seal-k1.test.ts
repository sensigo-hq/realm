// callback-key-seal-k1.test.ts — callback K1 (R1.3): the AES-256-GCM seal of a callback signing key.
// The known answer pins the one-way format (0x01 ‖ IV ‖ ciphertext ‖ tag, with the AAD 0x01 ‖
// workflow_id ‖ 0x00 ‖ host ‖ 0x00 ‖ slot): its blob was computed by running this code and decrypted
// once by Python's `cryptography` (`AESGCM`, 41.0.7), which also refused it without the version byte
// in the AAD (the report has the output). Then every refusal, which returns `undefined` and never
// throws; the freshness of the IV; the fingerprint; and the seal through B1a's store on a real home.
//
// Each assertion carries (1) the break that turns it red and (2) what it prints when it fails.
import { createCipheriv } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '@sensigo/realm';
import { afterEach, describe, expect, it } from 'vitest';
import { createCallbackKeySealer, masterKeyFingerprint, sealWithIv } from './callback-key-seal.js';
import { openRealmHome, type RealmHome } from './open-realm-home.js';
import { openForeignConnection } from './test-support/foreign-connection.js';

const MASTER = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);
const OTHER = Buffer.from('ff'.repeat(32), 'hex');
const CTX = { workflow_id: 'wf-known-answer', host: 'hooks.example:443', slot: 'current' } as const;
const IV = Buffer.from('0f0e0d0c0b0a090807060504', 'hex');
const TEXT = '3f9a1c7e5b2d8f406e1a9c3b7d5f2e8a0c4b6d9e1f3a5c7e9b0d2f4a6c8e0b1d';
const BLOB =
  '010f0e0d0c0b0a0908070605049756883d6ab498cbdebd833b00fcbd315f032e01f63ac206612d9b99006f884b34e9f7221d2d42eb11d31f8ca66f1f602e62c5355adb6a8ac23f7e93431574ee1e9131125c86e1fc067429453c04cb6a';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const sealer = createCallbackKeySealer(MASTER);
const blob = (): Uint8Array => new Uint8Array(Buffer.from(BLOB, 'hex'));

describe('callback K1 — the seal’s format, pinned by a known answer', () => {
  it('the committed blob unseals to its text, and sealing with its IV makes it again (93 bytes)', () => {
    // (1) red when the AAD's order, the version byte, the IV length or the tag length changes (the
    //     blob then differs, and the old blob no longer opens); (2) prints the blob made, its length
    //     and what the committed one opens to.
    expect({
      opens: sealer.unseal(blob(), CTX),
      made: hex(sealWithIv(MASTER, Buffer.from(TEXT, 'utf8'), CTX, IV)),
      length: blob().length,
    }).toEqual({ opens: TEXT, made: BLOB, length: 93 });
  });

  it('the master key’s fingerprint is the first 8 lowercase hex of SHA-256 of its 32 bytes', () => {
    // Computed apart: printf <hex> | xxd -r -p | sha256sum | cut -c1-8 gives 630dcd29.
    // (1) red when the fingerprint hashes other bytes (the hex text) or takes another length;
    //     (2) prints both.
    expect({ fp: masterKeyFingerprint(MASTER), sealer: sealer.masterFp }).toEqual({
      fp: '630dcd29',
      sealer: '630dcd29',
    });
  });
});

describe('callback K1 — every blob the seal cannot open is undefined, never a throw', () => {
  /** What `unseal` answers, or the thrown message. */
  const answer = (b: Uint8Array, ctx: Parameters<typeof sealer.unseal>[1] = CTX, s = sealer) => {
    try {
      return s.unseal(b, ctx) ?? 'undefined';
    } catch (err) {
      return `threw: ${(err as Error).message}`;
    }
  };
  const flipped = (at: number): Uint8Array => {
    const b = blob();
    b[at] = b[at]! ^ 0x01;
    return b;
  };

  it('a wrong master key; the blob moved to another host, slot or workflow; a flipped bit in each part; 28 and 94 bytes; version 2; the version byte left out of the AAD; a plaintext that is not a key text', () => {
    const notAKey = sealWithIv(MASTER, Buffer.from('not a key text', 'utf8'), CTX, IV);
    const version2 = blob();
    version2[0] = 2;
    // A blob this code seals now: the moved cases move it, so a place left out of the AAD opens it.
    const fresh = sealer.seal(TEXT, CTX);
    // A blob of this format whose AAD leaves out the version byte (the earlier probe's AAD).
    const c = createCipheriv('aes-256-gcm', MASTER, IV, { authTagLength: 16 });
    c.setAAD(Buffer.from(`${CTX.workflow_id}\0${CTX.host}\0${CTX.slot}`, 'utf8'));
    const body = Buffer.concat([c.update(TEXT, 'utf8'), c.final()]);
    const noVersionInAad = new Uint8Array(
      Buffer.concat([Buffer.from([1]), IV, body, c.getAuthTag()]),
    );
    // (1) red when the AAD leaves out the workflow, the host or the slot (a moved blob opens), the
    //     version byte is not authenticated (the blob sealed without it opens), a refusal throws, or a
    //     non-key plaintext is handed back; (2) prints each answer.
    expect({
      wrongMaster: answer(blob(), CTX, createCallbackKeySealer(OTHER)),
      freshAtHome: answer(fresh),
      otherHost: answer(fresh, { ...CTX, host: 'other.example:443' }),
      otherSlot: answer(fresh, { ...CTX, slot: 'previous' }),
      otherWorkflow: answer(fresh, { ...CTX, workflow_id: 'wf-other' }),
      noVersionInAad: answer(noVersionInAad),
      versionBit: answer(flipped(0)),
      ivBit: answer(flipped(5)),
      ciphertextBit: answer(flipped(40)),
      tagBit: answer(flipped(92)),
      bytes28: answer(blob().subarray(0, 28)),
      bytes94: answer(new Uint8Array([...blob(), 0])),
      version2: answer(version2),
      notAKey: answer(notAKey),
      text: answer('a string' as unknown as Uint8Array),
    }).toEqual({
      wrongMaster: 'undefined',
      freshAtHome: TEXT,
      otherHost: 'undefined',
      otherSlot: 'undefined',
      otherWorkflow: 'undefined',
      noVersionInAad: 'undefined',
      versionBit: 'undefined',
      ivBit: 'undefined',
      ciphertextBit: 'undefined',
      tagBit: 'undefined',
      bytes28: 'undefined',
      bytes94: 'undefined',
      version2: 'undefined',
      notAKey: 'undefined',
      text: 'undefined',
    });
  });

  it('two seals of one text at one place differ, and both open', () => {
    const a = sealer.seal(TEXT, CTX);
    const b = sealer.seal(TEXT, CTX);
    // (1) red when the IV is fixed or reused (the two blobs are equal); (2) prints both blobs.
    expect({
      differ: hex(a) !== hex(b),
      open: [sealer.unseal(a, CTX), sealer.unseal(b, CTX)],
    }).toEqual({ differ: true, open: [TEXT, TEXT] });
  });

  it('seal refuses a text that is not a key and a place it cannot bind, naming none of them', () => {
    const thrown = (call: () => unknown): string => {
      try {
        call();
        return 'no throw';
      } catch (err) {
        return (err as Error).message;
      }
    };
    const refusal = 'A callback key seal was asked for a malformed key or place.';
    // (1) red when a malformed key or place is sealed, or the message repeats what was given;
    //     (2) prints each message.
    expect({
      upper: thrown(() => sealer.seal(TEXT.toUpperCase(), CTX)),
      short: thrown(() => sealer.seal(TEXT.slice(1), CTX)),
      nul: thrown(() => sealer.seal(TEXT, { ...CTX, host: 'a\0b' })),
      emptyWorkflow: thrown(() => sealer.seal(TEXT, { ...CTX, workflow_id: '' })),
      longHost: thrown(() => sealer.seal(TEXT, { ...CTX, host: 'h'.repeat(256) })),
      slot: thrown(() => sealer.seal(TEXT, { ...CTX, slot: 'next' as 'current' })),
      master: thrown(() => createCallbackKeySealer(MASTER.subarray(0, 31))),
    }).toEqual({
      upper: refusal,
      short: refusal,
      nul: refusal,
      emptyWorkflow: refusal,
      longHost: refusal,
      slot: refusal,
      master: 'A callback key sealer needs a master key of 32 bytes.',
    });
  });
});

const AT = '2026-03-01T10:00:00.000Z';
const clock: Clock = { now: () => new Date(AT), at: () => () => undefined };
const dirs: string[] = [];
const open: RealmHome[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('callback K1 — the seal through B1a’s store, on a real home', () => {
  it('a key made under the real sealer reads back; the same file under another master reads unreadable, with the row’s fingerprint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-k1-seal-'));
    dirs.push(dir);
    const home = join(dir, '.realm');
    const first = await openRealmHome({ home, clock, sealer });
    await first.runStore.keys.make('wf-k1', 'hooks.example:443', TEXT);
    const readable = await first.runStore.keys.read('wf-k1', 'hooks.example:443');
    first.close();
    const second = await openRealmHome({ home, clock, sealer: createCallbackKeySealer(OTHER) });
    open.push(second);
    // (1) red when the store and the seal disagree on the place (the key does not read back), or a
    //     blob opens under another master; (2) prints both reads.
    expect({
      readable: readable.current?.state === 'readable' ? readable.current.key : readable,
      other: await second.runStore.keys.read('wf-k1', 'hooks.example:443'),
    }).toEqual({
      readable: TEXT,
      other: {
        current: { slot: 'current', state: 'unreadable', master_fp: '630dcd29', created_at: AT },
      },
    });
  });

  it('a TEXT value planted in the sealed column reads unreadable, not a throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'realm-k1-seal-'));
    dirs.push(dir);
    const home = join(dir, '.realm');
    const h = await openRealmHome({ home, clock, sealer });
    open.push(h);
    await h.runStore.keys.make('wf-k1', 'hooks.example:443', TEXT);
    const c = await openForeignConnection(home);
    try {
      c.prepare("UPDATE callback_keys SET sealed = 'not bytes' WHERE workflow_id = 'wf-k1'").run();
    } finally {
      c.close();
    }
    const read = await h.runStore.keys.read('wf-k1', 'hooks.example:443').then(
      (pair) => pair,
      (err: Error) => `threw: ${err.message}`,
    );
    // (1) red when the seal throws on a value that is not bytes; (2) prints the read.
    expect(read).toEqual({
      current: { slot: 'current', state: 'unreadable', master_fp: '630dcd29', created_at: AT },
    });
  });
});
