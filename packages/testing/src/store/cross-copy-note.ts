// issue #620 PR-C: what a contract says when a store's refusal is not this copy's class. Core
// composes the description; the contracts append it to their own failure text.
import { describeUnrecognised, describeUnrecognisedForContract } from '@sensigo/realm';
import type { RealmClass } from '@sensigo/realm';

/** `` — <description>`` when `value` comes from another realm copy; `''` otherwise. */
export function crossCopyNote(value: unknown, Class: RealmClass): string {
  const text = describeUnrecognisedForContract(describeUnrecognised(value, Class));
  return text === '' ? '' : ` — ${text}`;
}
