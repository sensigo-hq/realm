/**
 * Counts accepted and rejected candidates and computes candidates_found total.
 */

/**
 * Counts accepted and rejected candidates and adds a candidates_found total.
 *
 * candidates_found distinguishes between:
 *   - wiring failure (candidates_found === 0): no items were located to check
 *   - validation failure (candidates_found > 0, accepted_count === 0): all failed matching
 *   - clean pass (accepted_count === candidates_found): all passed
 *
 * @param accepted  The accepted candidates from partitionBySubstring.
 * @param rejected  The rejected candidates from partitionBySubstring.
 * @returns         { accepted_count, rejected_count, candidates_found }
 * @public
 */
export function countResults(
  accepted: Record<string, unknown>[],
  rejected: Record<string, unknown>[],
): { accepted_count: number; rejected_count: number; candidates_found: number } {
  return {
    accepted_count: accepted.length,
    rejected_count: rejected.length,
    candidates_found: accepted.length + rejected.length,
  };
}
