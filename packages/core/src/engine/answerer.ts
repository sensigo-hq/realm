// answerer.ts — #603 A3a: who may answer a question. One pure judge, used by the write that settles
// an answer (`applySettleGate`) and by a door before it acts on a reply. Core names no platform: a
// name is compared by equality with the forms the door says name the sender, and never parsed.
import type { AdmittedBy } from '../types/run-record.js';

/** What the judge reads of a question: its `owner` and `answerers`, as stored or as declared. */
export interface AnswererQuestion {
  owner?: unknown;
  answerers?: unknown;
}

/** How the sender was let through, or the names that may answer (as written). */
export type AnswererVerdict = { admitted: AdmittedBy } | { refused: { allowed: string[] } };

/**
 * #603 A3a: the one rule of who may answer.
 * - No `senderForms`: the answer carries no channel evidence and is not compared —
 *   `owner_not_checked_on_route` when the question names someone, else `no_named_answerer`.
 * - A question names answerers when its `owner` is a non-empty string, or its `answerers` is set and
 *   is not an empty list (a value that is not a list names someone and matches no one). Then only
 *   those names count, and the project's list is not added: `owner` when it equals one of the
 *   sender's forms, else `answerers`; otherwise refused with those names.
 * - A question that names no one is answered by `projectAnswerers` when it is not empty.
 * - With none of these, anyone: `no_named_answerer`.
 * Passing `[]` as the forms asks which names a question allows: refused with them, or none.
 */
export function judgeAnswerer(
  question: AnswererQuestion,
  senderForms?: readonly string[],
  projectAnswerers?: readonly string[],
): AnswererVerdict {
  const owner =
    typeof question.owner === 'string' && question.owner !== '' ? question.owner : undefined;
  const list = question.answerers;
  const listed = Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [];
  const names =
    owner !== undefined || (list !== undefined && !(Array.isArray(list) && list.length === 0));
  if (senderForms === undefined) {
    return { admitted: names ? 'owner_not_checked_on_route' : 'no_named_answerer' };
  }
  const matches = (name: string): boolean => senderForms.includes(name);
  if (names) {
    if (owner !== undefined && matches(owner)) return { admitted: 'owner' };
    if (listed.some(matches)) return { admitted: 'answerers' };
    return { refused: { allowed: [...(owner !== undefined ? [owner] : []), ...listed] } };
  }
  if (projectAnswerers !== undefined && projectAnswerers.length > 0) {
    return projectAnswerers.some(matches)
      ? { admitted: 'project_answerers' }
      : { refused: { allowed: [...projectAnswerers] } };
  }
  return { admitted: 'no_named_answerer' };
}
