/**
 * Partitions candidates into accepted/rejected based on exact substring matching.
 */

/**
 * Partitions a list of candidate objects into accepted and rejected groups.
 * A candidate is accepted when the value of candidate[quoteField] appears
 * as a literal substring of sourceText. Matching is strict — no normalization.
 *
 * @param candidates   Array of objects, each expected to have quoteField.
 * @param quoteField   The property name holding the quote string to test.
 * @param sourceText   The document text to search within.
 * @returns            { accepted: Record<string, unknown>[], rejected: Record<string, unknown>[] }
 * @public
 */
export function partitionBySubstring(
  candidates: Record<string, unknown>[],
  quoteField: string,
  sourceText: string,
): { accepted: Record<string, unknown>[]; rejected: Record<string, unknown>[] } {
  const accepted: Record<string, unknown>[] = [];
  const rejected: Record<string, unknown>[] = [];

  for (const candidate of candidates) {
    const quote = candidate[quoteField];
    if (typeof quote !== 'string' || sourceText === '' || !sourceText.includes(quote)) {
      rejected.push(candidate);
    } else {
      accepted.push(candidate);
    }
  }

  return { accepted, rejected };
}
