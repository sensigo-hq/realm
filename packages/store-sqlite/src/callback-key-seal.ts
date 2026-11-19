// callback-key-seal.ts — callback K1 (R1.3; the callback design rev 4 §1.4, owner 896326ed): the seal
// of a signing key for the store file, B1a's `CallbackKeySealer`, with AES-256-GCM under the master
// key. Exported from the package entry with the master key's fingerprint; the cli resolves the master
// key and hands its 32 bytes here.
//
// The format is a one-way door, pinned by a known-answer cell: a blob is the version byte 0x01, a
// fresh random 12-byte IV, the ciphertext of the key text's UTF-8 bytes and the 16-byte tag (93 bytes
// for a 64-character key). The associated data binds the blob to its place: 0x01 ‖ workflow_id ‖ 0x00
// ‖ host ‖ 0x00 ‖ slot (UTF-8), so a blob moved to another workflow, host or slot does not open, and
// the version byte is authenticated with it. `unseal` never throws: anything it cannot open, or that
// opens to something other than a key text, is `undefined`.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { CALLBACK_KEY_SLOTS } from '@sensigo/realm';
import type { CallbackKeySealer } from './callback-keys.js';

/** The blob's version byte: the first byte of every blob, and of its associated data. */
const VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The shortest blob that can be read: the version, the IV and the tag around no ciphertext. */
const MIN_BLOB_BYTES = 1 + IV_BYTES + TAG_BYTES;
const KEY_TEXT = /^[0-9a-f]{64}$/;

type SealContext = Parameters<CallbackKeySealer['seal']>[1];

/**
 * A master key's fingerprint: the first 8 lowercase hex characters of SHA-256 of its 32 bytes. The
 * one function for it: the sealer stores it beside every slot, and the cli's resolver compares with
 * it.
 */
export function masterKeyFingerprint(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 8);
}

/** A workflow id or host a blob can be bound to: 1–255 characters, no NUL (the AAD's separator). */
const label = (value: unknown): boolean =>
  typeof value === 'string' && value.length >= 1 && value.length <= 255 && !value.includes('\0');

const placed = (ctx: SealContext): boolean =>
  label(ctx?.workflow_id) &&
  label(ctx?.host) &&
  (CALLBACK_KEY_SLOTS as readonly unknown[]).includes(ctx?.slot);

/** The associated data of a blob at `ctx`: 0x01 ‖ workflow_id ‖ 0x00 ‖ host ‖ 0x00 ‖ slot. */
function associatedData(ctx: SealContext): Buffer {
  return Buffer.concat([
    Buffer.from([VERSION]),
    Buffer.from(ctx.workflow_id, 'utf8'),
    Buffer.from([0]),
    Buffer.from(ctx.host, 'utf8'),
    Buffer.from([0]),
    Buffer.from(ctx.slot, 'utf8'),
  ]);
}

/**
 * Seals `plaintext` at `ctx` under `master` with the given IV. Module-internal (the package entry does
 * not export it): the known-answer cell fixes the IV, and a cell seals a plaintext that is not a key
 * text. It checks nothing.
 */
export function sealWithIv(
  master: Uint8Array,
  plaintext: Uint8Array,
  ctx: SealContext,
  iv: Uint8Array,
): Uint8Array {
  const cipher = createCipheriv('aes-256-gcm', master, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(associatedData(ctx));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, body, cipher.getAuthTag()]));
}

/** Opens `blob` at `ctx` under `master`: the key text, or `undefined` for anything else. */
function open(master: Uint8Array, blob: unknown, ctx: SealContext): string | undefined {
  try {
    if (!(blob instanceof Uint8Array) || blob.length < MIN_BLOB_BYTES || blob[0] !== VERSION)
      return undefined;
    if (!placed(ctx)) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', master, blob.subarray(1, 1 + IV_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(associatedData(ctx));
    decipher.setAuthTag(blob.subarray(blob.length - TAG_BYTES));
    const text = Buffer.concat([
      decipher.update(blob.subarray(1 + IV_BYTES, blob.length - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    return KEY_TEXT.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The AES-256-GCM sealer under the master key's 32 bytes (callback K1). `seal` takes a key text (64
 * lowercase hex characters) and a place (a workflow id and host of 1–255 characters with no NUL, and
 * one of `CALLBACK_KEY_SLOTS`), with a fresh random IV each time; anything else throws a plain error
 * that names none of them.
 */
export function createCallbackKeySealer(master: Uint8Array): CallbackKeySealer {
  if (!(master instanceof Uint8Array) || master.length !== 32)
    throw new Error('A callback key sealer needs a master key of 32 bytes.');
  const key = new Uint8Array(master);
  return {
    masterFp: masterKeyFingerprint(key),
    seal(text, ctx) {
      if (typeof text !== 'string' || !KEY_TEXT.test(text) || !placed(ctx))
        throw new Error('A callback key seal was asked for a malformed key or place.');
      return sealWithIv(key, Buffer.from(text, 'utf8'), ctx, randomBytes(IV_BYTES));
    },
    unseal: (blob, ctx) => open(key, blob, ctx),
  };
}
