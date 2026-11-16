/**
 * Compares two strings using exact, prefix, or regex match modes.
 */

/**
 * Compares two strings using a specified match mode.
 *
 * @param a     The string to test.
 * @param b     The reference string (pattern for regex/prefix, exact target for exact).
 * @param mode  "exact" | "prefix" | "regex"
 * @returns     true if a matches b under the given mode.
 * @public
 */
export function compareStrings(a: string, b: string, mode: 'exact' | 'prefix' | 'regex'): boolean {
  switch (mode) {
    case 'exact':
      return a === b;
    case 'prefix':
      return a.startsWith(b);
    case 'regex': {
      try {
        return new RegExp(b).test(a);
      } catch {
        return false;
      }
    }
  }
}
