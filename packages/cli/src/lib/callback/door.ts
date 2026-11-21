// door.ts — R1.3 callback C2 (the door; the owner's yes 81e85411, the key 896326ed, the delta
// d4671d42): whether a request to `realm listen` that names a callback address in `realm-callback-url`
// may register it. Pure: the handler reads the header, the lists and the stored keys, and asks here.
//
// The order of the checks is the order of the words: C1's matcher (`malformed`, `too_long`, `scheme`,
// `userinfo`, `not_allowed`), then the classifier for a host that is an IP literal (`address`), then
// K1's host label (none is `malformed`), then the key (`no_key`). A refusal carries the host label
// whenever the address parses far enough to have one; never the address itself.
import type { CallbackKeyPair } from '@sensigo/realm';
import { classifyAddress } from './address.js';
import {
  isIpLiteralHost,
  matchCallbackEntry,
  type CallbackLists,
  type UrlRefusalWord,
} from './allow-list.js';
import { callbackHostLabel } from './host-label.js';

/** The request header a caller names its callback address in. */
export const CALLBACK_HEADER = 'realm-callback-url';

/** The closed word a refused callback address is answered with: the matcher's five, and two more. */
export type CallbackRefusalWord = UrlRefusalWord | 'address' | 'no_key';

/** Every refusal word, in the order the door checks them. */
export const CALLBACK_REFUSAL_WORDS = [
  'malformed',
  'too_long',
  'scheme',
  'userinfo',
  'not_allowed',
  'address',
  'no_key',
] as const satisfies readonly CallbackRefusalWord[];

/** An address the door may register (its host label), or the word it is refused with. */
export type CallbackAddressVerdict =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly word: CallbackRefusalWord; readonly host?: string };

/** The address checks, before the key: the matcher, the classifier, the label. */
export function judgeCallbackAddress(lists: CallbackLists, value: string): CallbackAddressVerdict {
  const label = callbackHostLabel(value);
  const refuse = (word: CallbackRefusalWord): CallbackAddressVerdict =>
    label === undefined ? { ok: false, word } : { ok: false, word, host: label };
  const match = matchCallbackEntry(lists, value);
  if (!match.ok) return refuse(match.word);
  if (isIpLiteralHost(match.host) && !classifyAddress(match.host, match.kind).allowed) {
    return refuse('address');
  }
  return label === undefined ? refuse('malformed') : { ok: true, host: label };
}

/** Whether the pair has a key the door can sign with, and, when not, which of two states it is in. */
export type CallbackKeyVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly state: 'none' }
  | { readonly ok: false; readonly state: 'unreadable'; readonly master_fp: string };

/** A readable current is a key; no current (a previous alone is not one) or an unreadable one is not. */
export function judgeCallbackKey(pair: CallbackKeyPair): CallbackKeyVerdict {
  const current = pair.current;
  if (current === undefined) return { ok: false, state: 'none' };
  if (current.state === 'unreadable') {
    return { ok: false, state: 'unreadable', master_fp: current.master_fp };
  }
  return { ok: true };
}

/**
 * What to do about a pair with no usable key, ending with the command `cmd` (and nothing after it: a
 * full stop pasted into a shell names another host). `processFp` is this process's master key
 * fingerprint, `null` when it has none, absent when unknown (the clause about it is then left out).
 */
export function noKeyFix(
  verdict: Exclude<CallbackKeyVerdict, { ok: true }>,
  processFp: string | null | undefined,
  cmd: string,
): string {
  if (verdict.state === 'none') return `make a key with: ${cmd}`;
  if (processFp !== undefined && processFp !== null && processFp === verdict.master_fp) {
    return `the stored key cannot be read; make a new key with: ${cmd} --replace`;
  }
  const has = processFp === undefined ? '' : `; this process has ${processFp ?? 'none'}`;
  return (
    `its key was sealed with encryption key ${verdict.master_fp}${has}; start realm listen with ` +
    `that encryption key, or make a new key with: ${cmd} --replace`
  );
}
