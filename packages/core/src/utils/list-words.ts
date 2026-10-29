// list-words.ts — #872 (b1) correction 1 (H1): the ONE producer of a bounded list in words. A list a
// sentence names shows its first items and says how many more; a name goes through `capText` (I4:
// a name over the cap is named by its length, never cut). Pure; beside `redaction.ts`, so both
// `ways.ts` and `pending.ts` import it without a cycle between them.

import { capText } from './redaction.js';

/** How many names a flat list in a sentence shows before it counts the rest. */
export const NAMES_SHOWN = 10;

/**
 * The first `shown` items joined by `, `, then ` and <N> more` when N = `items.length − shown` is
 * above zero: `'a', 'b', 'c' and 7 more`. Every item is shown when there are `shown` or fewer.
 */
export function listWords(items: readonly string[], shown: number): string {
  const head = items.slice(0, shown).join(', ');
  const more = items.length - Math.min(shown, items.length);
  return more > 0 ? `${head} and ${more} more` : head;
}

/** {@link listWords} over names quoted `'<name>'`, each through `capText`. */
export function quotedNames(names: readonly string[], shown: number): string {
  return listWords(
    names.map((n) => `'${capText(n)}'`),
    shown,
  );
}
