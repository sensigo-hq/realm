// callback-keys.ts — R1.3 the callback, callback A2 (prompt `feat-callback-a2-keys-port.md`; design
// `DESIGN-CALLBACK-rev4.md` §1): the signing keys of the callback store (`CallbackStore.keys`). For
// each (workflow, host), up to two keys: `current`, and for a while after a rotation `previous`.
//
// Core declares the port, its request check, the fingerprint, ONE liveness function, ONE pure
// decider per write method and (callback K2a-1) ONE listing entry; a store does the I/O around them, as `callback-store.ts` and
// `outbound-ledger.ts`: it checks the request (`checkCallbackKeyRequest`), takes its ONE raw reading,
// reads the pair, calls the decider and applies the writes it returns, slot by slot, with nothing
// that yields between the read and the last write. The port is storage-neutral: key text goes in and
// comes out plain; how a store keeps it at rest is its own business.
import { createHash } from 'node:crypto';
import { isPastDeadline, parseStamp } from '../engine/instants.js';

/**
 * The two places a pair keeps a key, one list for every use of the word.
 * @beta
 */
export const CALLBACK_KEY_SLOTS = ['current', 'previous'] as const;

/**
 * The name of a slot: `current` signs; `previous` is the key a rotation replaced, kept for a while.
 * @beta
 */
export type CallbackKeySlotName = (typeof CALLBACK_KEY_SLOTS)[number];

/**
 * One slot of a pair, as the store holds it.
 * `readable` carries the key's text (64 lowercase hex characters) and `key_fp`, its fingerprint;
 * `unreadable` is a slot the store holds but cannot read (sealed under another master key), with the
 * fingerprint of the master key that sealed it. `created_at` and `expires_at` are the store's own
 * readings; `expires_at` is set on a `previous` only.
 * @beta
 */
export type CallbackKeySlot =
  | {
      readonly slot: CallbackKeySlotName;
      readonly state: 'readable';
      readonly key: string;
      readonly key_fp: string;
      readonly created_at: string;
      readonly expires_at?: string;
    }
  | {
      readonly slot: CallbackKeySlotName;
      readonly state: 'unreadable';
      readonly master_fp: string;
      readonly created_at: string;
      readonly expires_at?: string;
    };

/**
 * The keys of one (workflow, host). An absent slot is omitted, never `null`.
 * @beta
 */
export interface CallbackKeyPair {
  readonly current?: CallbackKeySlot;
  readonly previous?: CallbackKeySlot;
}

/**
 * What `make` answers: the current key, and whether this call wrote it.
 * @beta
 */
export interface CallbackKeyMakeResult {
  readonly created: boolean;
  readonly key: CallbackKeySlot;
}

/**
 * A rotation: the new key's text, how long the old key stays as the previous (1–604,800 seconds),
 * and whether a live previous may be dropped to make room.
 * @beta
 */
export interface CallbackKeyRotateRequest {
  readonly candidate: string;
  readonly keepSeconds: number;
  readonly endPrevious?: boolean;
}

/**
 * What `rotate` answers: the pair it wrote, or why it wrote nothing.
 * @beta
 */
export type CallbackKeyRotateResult =
  | {
      readonly applied: true;
      readonly current: CallbackKeySlot;
      readonly previous: CallbackKeySlot;
    }
  | {
      readonly applied: false;
      readonly reason: 'no_current' | 'current_unreadable' | 'previous_live';
    };

/**
 * What `endPrevious` answers: whether a live previous was there to remove.
 * @beta
 */
export type CallbackKeyEndResult =
  { readonly ended: true } | { readonly ended: false; readonly reason: 'no_previous' };

/**
 * What `replace` answers: the new current key, or why it wrote nothing.
 * @beta
 */
export type CallbackKeyReplaceResult =
  | { readonly applied: true; readonly key: CallbackKeySlot }
  | { readonly applied: false; readonly reason: 'no_current' | 'readable' };

/**
 * What `delete` answers: whether the pair had a current key, readable or not.
 * @beta
 */
export interface CallbackKeyDeleteResult {
  readonly had_current: boolean;
}

/**
 * One slot as `list` gives it: what `read` answers, without the key's text. `readable` carries the
 * key's fingerprint, `unreadable` the fingerprint of the master key that sealed it.
 * @beta
 */
export type CallbackKeySlotInfo =
  | {
      readonly slot: CallbackKeySlotName;
      readonly state: 'readable';
      readonly key_fp: string;
      readonly created_at: string;
      readonly expires_at?: string;
    }
  | {
      readonly slot: CallbackKeySlotName;
      readonly state: 'unreadable';
      readonly master_fp: string;
      readonly created_at: string;
      readonly expires_at?: string;
    };

/**
 * One (workflow, host) of a store's listing (`list`), with its live slots. An absent slot is omitted.
 * @beta
 */
export interface CallbackKeyListing {
  readonly workflow_id: string;
  readonly host: string;
  readonly current?: CallbackKeySlotInfo;
  readonly previous?: CallbackKeySlotInfo;
}

/**
 * The signing keys of a callback store (`CallbackStore.keys`): for each (workflow, host), a current
 * key and, for a while after a rotation, a previous one.
 * `workflowId` and `host` are each 1–255 characters, compared byte for byte; a key's text is 64
 * lowercase hex characters. Every method but `delete` takes ONE raw reading of the store's clock,
 * refused or applied; `delete` takes none; a malformed request throws before any reading, and its
 * message never repeats a candidate key. A previous counts only while it is live: past its
 * `expires_at` it is absent for every method, and no method returns it. Refusals are results, never
 * thrown. Keys are kept apart from the callback rows and the runs: a run's purge leaves them.
 * @beta
 */
export interface CallbackKeyStore {
  /** The pair: the current as stored, the previous only while it is live. Changes nothing. */
  read(workflowId: string, host: string): Promise<CallbackKeyPair>;
  /** Writes `candidate` as the current only when the pair has none; otherwise returns the stored one. */
  make(workflowId: string, host: string, candidate: string): Promise<CallbackKeyMakeResult>;
  /** Makes the current the previous, with an end, and `candidate` the current, in one step. */
  rotate(
    workflowId: string,
    host: string,
    request: CallbackKeyRotateRequest,
  ): Promise<CallbackKeyRotateResult>;
  /** Removes a live previous at once; the current is untouched. */
  endPrevious(workflowId: string, host: string): Promise<CallbackKeyEndResult>;
  /** Writes `candidate` as the current only when the current cannot be read. */
  replace(workflowId: string, host: string, candidate: string): Promise<CallbackKeyReplaceResult>;
  /** Removes both slots, an expired one included. Takes no reading. */
  delete(workflowId: string, host: string): Promise<CallbackKeyDeleteResult>;
  /**
   * Every pair that holds a live key, in UTF-8 byte order of `workflow_id`, then of `host`: each slot
   * as `read` answers it, without the key's text. Changes nothing.
   */
  list(): Promise<readonly CallbackKeyListing[]>;
}

/** The longest a rotated-out key may stay as the previous, in seconds (7 days). */
export const CALLBACK_KEY_KEEP_MAX_SECONDS = 604_800;

const KEY_TEXT = /^[0-9a-f]{64}$/;

/** A request to check, by the method that takes it. */
export type CallbackKeyCheck =
  | { readonly kind: 'pair'; readonly workflowId: string; readonly host: string }
  | {
      readonly kind: 'candidate';
      readonly workflowId: string;
      readonly host: string;
      readonly candidate: string;
    }
  | {
      readonly kind: 'rotate';
      readonly workflowId: string;
      readonly host: string;
      readonly request: CallbackKeyRotateRequest;
    };

function malformed(what: string): never {
  throw new Error(`A malformed callback key request: ${what}.`);
}

const label = (v: unknown): boolean => typeof v === 'string' && v.length >= 1 && v.length <= 255;

/**
 * Checks a request, and throws on a malformed one: a store calls it BEFORE it takes its reading, so a
 * malformed request takes none. The message never repeats what was given. A programming error,
 * never a refusal.
 */
export function checkCallbackKeyRequest(check: CallbackKeyCheck): void {
  if (!label(check.workflowId)) malformed('`workflowId` must be 1 to 255 characters');
  if (!label(check.host)) malformed('`host` must be 1 to 255 characters');
  if (check.kind === 'pair') return;
  const r =
    check.kind === 'rotate' ? (check.request as Partial<CallbackKeyRotateRequest>) : undefined;
  const candidate: unknown = check.kind === 'rotate' ? r?.candidate : check.candidate;
  if (typeof candidate !== 'string' || !KEY_TEXT.test(candidate))
    malformed('a key must be 64 lowercase hexadecimal characters');
  if (r === undefined) return;
  const keep = r.keepSeconds;
  if (!(Number.isInteger(keep) && keep! >= 1 && keep! <= CALLBACK_KEY_KEEP_MAX_SECONDS))
    malformed('`keepSeconds` must be a whole number from 1 to 604,800');
  if (r.endPrevious !== undefined && typeof r.endPrevious !== 'boolean')
    malformed('`endPrevious` must be a boolean when given');
}

/**
 * A key's fingerprint: the first 8 lowercase hex characters of SHA-256 of its text's UTF-8 bytes. It
 * checks nothing; every store calls it, so one key has one fingerprint everywhere.
 */
export function callbackKeyFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Whether `previous` is live at `at`: it ends at its `expires_at` (`isPastDeadline`, at or after it).
 * The ONE judgement of expiry: `read` and every decider use it, so a previous stops counting at the
 * same instant for all of them. A previous without a readable end never signs: one with no
 * `expires_at`, or one `parseStamp` cannot read, is never live.
 */
export function callbackPreviousIsLive(previous: CallbackKeySlot | undefined, at: Date): boolean {
  const end = previous?.expires_at;
  return end !== undefined && parseStamp(end) !== undefined && !isPastDeadline(end, at);
}

/** The pair as `read` returns it at `at`: the current as stored, the previous only while live. */
export function callbackKeyPairAt(pair: CallbackKeyPair, at: Date): CallbackKeyPair {
  return {
    ...(pair.current !== undefined ? { current: pair.current } : {}),
    ...(callbackPreviousIsLive(pair.previous, at) ? { previous: pair.previous } : {}),
  };
}

/** A slot without its key's text: the fields are copied one by one, so the text cannot ride along. */
function slotInfo(slot: CallbackKeySlot): CallbackKeySlotInfo {
  const ends = slot.expires_at !== undefined ? { expires_at: slot.expires_at } : {};
  const { slot: name, created_at } = slot;
  return slot.state === 'readable'
    ? { slot: name, state: 'readable', key_fp: slot.key_fp, created_at, ...ends }
    : { slot: name, state: 'unreadable', master_fp: slot.master_fp, created_at, ...ends };
}

/**
 * The listing entry of one pair at `at` (`list`): its live slots as `read` answers them, without any
 * key's text, or `undefined` when no slot is live. The ONE place a listing is made: every store uses it.
 */
export function callbackKeyListingAt(
  workflowId: string,
  host: string,
  pair: CallbackKeyPair,
  at: Date,
): CallbackKeyListing | undefined {
  const { current, previous } = callbackKeyPairAt(pair, at);
  if (current === undefined && previous === undefined) return undefined;
  return {
    workflow_id: workflowId,
    host,
    ...(current !== undefined ? { current: slotInfo(current) } : {}),
    ...(previous !== undefined ? { previous: slotInfo(previous) } : {}),
  };
}

/** One write a decider asks for: set one slot, or drop one. A store applies them in order. */
export type CallbackKeyWrite =
  { readonly set: CallbackKeySlot } | { readonly drop: CallbackKeySlotName };

/** A decider's answer: the result, and the writes to apply (none for a refusal). */
export interface CallbackKeyDecision<R> {
  readonly result: R;
  readonly writes: readonly CallbackKeyWrite[];
}

/** A readable slot holding `text`, stamped `created_at`. */
function readableSlot(
  slot: CallbackKeySlotName,
  text: string,
  createdAt: string,
  expiresAt?: string,
): CallbackKeySlot {
  return {
    slot,
    state: 'readable',
    key: text,
    key_fp: callbackKeyFingerprint(text),
    created_at: createdAt,
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
  };
}

/** `make`, pure: writes `candidate` as the current only when the pair has none. */
export function decideCallbackKeyMake(
  pair: CallbackKeyPair,
  candidate: string,
  at: Date,
): CallbackKeyDecision<CallbackKeyMakeResult> {
  if (pair.current !== undefined)
    return { result: { created: false, key: pair.current }, writes: [] };
  const key = readableSlot('current', candidate, at.toISOString());
  return { result: { created: true, key }, writes: [{ set: key }] };
}

/**
 * `rotate`, pure. First match wins: `no_current` · `current_unreadable` · `previous_live` (a live
 * previous and no `endPrevious: true`) · otherwise it applies: the old current becomes the previous
 * (its text and `created_at` carried) ending `keepSeconds` after `at`, `candidate` becomes the current
 * at `at`, and any other previous is replaced.
 */
export function decideCallbackKeyRotate(
  pair: CallbackKeyPair,
  request: CallbackKeyRotateRequest,
  at: Date,
): CallbackKeyDecision<CallbackKeyRotateResult> {
  const old = pair.current;
  if (old === undefined) return { result: { applied: false, reason: 'no_current' }, writes: [] };
  if (old.state !== 'readable')
    return { result: { applied: false, reason: 'current_unreadable' }, writes: [] };
  if (callbackPreviousIsLive(pair.previous, at) && request.endPrevious !== true)
    return { result: { applied: false, reason: 'previous_live' }, writes: [] };
  const ends = new Date(at.getTime() + request.keepSeconds * 1000).toISOString();
  const previous = readableSlot('previous', old.key, old.created_at, ends);
  const current = readableSlot('current', request.candidate, at.toISOString());
  return {
    result: { applied: true, current, previous },
    writes: [{ set: previous }, { set: current }],
  };
}

/** `endPrevious`, pure: removes a live previous; `no_previous` otherwise. */
export function decideCallbackKeyEndPrevious(
  pair: CallbackKeyPair,
  at: Date,
): CallbackKeyDecision<CallbackKeyEndResult> {
  if (!callbackPreviousIsLive(pair.previous, at))
    return { result: { ended: false, reason: 'no_previous' }, writes: [] };
  return { result: { ended: true }, writes: [{ drop: 'previous' }] };
}

/**
 * `replace`, pure. First match wins: `no_current` · `readable` (a working key is never discarded) ·
 * otherwise it writes `candidate` as the current at `at`; the previous stays as it is.
 */
export function decideCallbackKeyReplace(
  pair: CallbackKeyPair,
  candidate: string,
  at: Date,
): CallbackKeyDecision<CallbackKeyReplaceResult> {
  if (pair.current === undefined)
    return { result: { applied: false, reason: 'no_current' }, writes: [] };
  if (pair.current.state === 'readable')
    return { result: { applied: false, reason: 'readable' }, writes: [] };
  const key = readableSlot('current', candidate, at.toISOString());
  return { result: { applied: true, key }, writes: [{ set: key }] };
}
