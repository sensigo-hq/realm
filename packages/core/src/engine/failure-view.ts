// failure-view.ts — Q1 (#592) unit b: a run's failures, read from the record, composed ONCE in
// core and shown by both read surfaces: `get_run_state`'s `failures[]` and `realm run inspect`'s
// lines under `Failed:`. One derivation, two carriers.
//
// For each name in `failed_steps`, the step's LAST evidence entry carrying a string `error` — the
// pick `failureMessagesFromEvidence` makes for `terminal_reason` — its words read through unit a's
// `readFailureWords` (never off the entry by hand), its message bounded by `capText`, the same cap
// `terminal_reason` goes through.
//
// TOTALITY, as `composeStepViews`: no record a store can hand this function makes it throw. A
// malformed `evidence` or `failed_steps`, an entry that is not an object, a word that is not a
// string: each degrades to an absence, never an exception.
import type { EvidenceSnapshot, RunRecord } from '../types/run-record.js';
import { capText } from '../utils/redaction.js';
import { readFailureWords, type FailureWordField } from './ways.js';

/**
 * A failed step, as its last failed evidence entry records it. With the words: the error `code`,
 * its `category`, why Realm stopped retrying (`stop_reason`) and the entry's action word
 * (`agent_action`), each as recorded and absent when the entry lacks it; a word outside its list is
 * kept and named in `unknown`. Without them: `absent` says why — `written_before_failure_words`
 * (an entry an older Realm wrote, with its message) or `entry_not_found` (no failed entry on the
 * record). `message` is the entry's error text, bounded at 500 characters as `terminal_reason` is.
 */
export type FailureView =
  | {
      step: string;
      code: string;
      category?: string;
      stop_reason?: string;
      agent_action?: string;
      attempt?: number;
      message: string;
      unknown?: Array<'code' | 'category' | 'stop_reason' | 'agent_action'>;
    }
  | {
      step: string;
      absent: 'written_before_failure_words';
      message: string;
      attempt?: number;
    }
  | { step: string; absent: 'entry_not_found' };

/** The words of a failure's `unknown`: the type the list below is checked against. */
type FailureUnknownField = NonNullable<Extract<FailureView, { code: string }>['unknown']>[number];
/**
 * Every field a failure's `unknown` can name: the stored words it could not read, in the type's order.
 * Compile-checked both ways: a word added to the type and not to the list fails the build,
 * and so does a word in the list the type does not have (Q1, #592, unit d1b).
 */
export const FAILURE_UNKNOWN_WORDS = [
  'code',
  'category',
  'stop_reason',
  'agent_action',
] as const satisfies readonly FailureUnknownField[];
type MissingFailureUnknownWords = Exclude<
  FailureUnknownField,
  (typeof FAILURE_UNKNOWN_WORDS)[number]
>;
const _everyFailureUnknownWordsListed: [MissingFailureUnknownWords] extends [never]
  ? true
  : MissingFailureUnknownWords = true;
void _everyFailureUnknownWordsListed;

/** The words of a failure's `absent`: the type the list below is checked against. */
type FailureAbsentCause = Extract<FailureView, { absent: string }>['absent'];
/**
 * Every reason a failure's words can be absent, in the type's order.
 * Compile-checked both ways: a word added to the type and not to the list fails the build,
 * and so does a word in the list the type does not have (Q1, #592, unit d1b).
 */
export const FAILURE_ABSENT_CAUSES = [
  'written_before_failure_words',
  'entry_not_found',
] as const satisfies readonly FailureAbsentCause[];
type MissingFailureAbsentCauses = Exclude<
  FailureAbsentCause,
  (typeof FAILURE_ABSENT_CAUSES)[number]
>;
const _everyFailureAbsentCausesListed: [MissingFailureAbsentCauses] extends [never]
  ? true
  : MissingFailureAbsentCauses = true;
void _everyFailureAbsentCausesListed;

/** The view's key for each of the reader's word fields. */
const VIEW_KEY = {
  error_code: 'code',
  error_category: 'category',
  stop_reason: 'stop_reason',
  agent_action: 'agent_action',
} as const satisfies Record<FailureWordField, string>;

const stringOr = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * One view per name in `failed_steps`, in the list's order (a name appears once: resume is the one
 * remover, and a failed step can be neither claimed nor reclaimed). A word that is not a string is
 * read as absent; so is an `attempt` that is not a number.
 *
 * Gap 2, unit (iv-b1): `message` makes each view's message from the entry's error text as recorded
 * (default `capText`); `get_run_state` under the failure-text setting `hidden` passes the shape, so
 * its length is the record's, never the 500-character cut's.
 */
export function composeFailures(
  run: RunRecord,
  options: { message?: (text: string) => string } = {},
): FailureView[] {
  const messageOf = options.message ?? capText;
  const failed: unknown = run.failed_steps;
  const names = Array.isArray(failed)
    ? failed.filter((name): name is string => typeof name === 'string')
    : [];
  if (names.length === 0) return [];

  const evidence: unknown = run.evidence;
  const lastFailed = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(evidence) ? evidence : []) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const step = entry['step_id'];
    if (typeof step === 'string' && typeof entry['error'] === 'string') lastFailed.set(step, entry);
  }

  return names.map((step): FailureView => {
    const entry = lastFailed.get(step);
    if (entry === undefined) return { step, absent: 'entry_not_found' };
    const message = messageOf(entry['error'] as string);
    const attempt = typeof entry['attempt'] === 'number' ? entry['attempt'] : undefined;
    // The recorded words, as strings: a newer Realm's word is outside our lists, which is what the
    // reader exists to name, so the record's words are read as the entry's fields' type here.
    const recorded = {
      error_code: stringOr(entry['error_code']),
      error_category: stringOr(entry['error_category']),
      agent_action: stringOr(entry['agent_action']),
      stop_reason: stringOr(entry['stop_reason']),
    } as Pick<EvidenceSnapshot, FailureWordField>;
    const read = readFailureWords(recorded);
    if ('absent' in read) {
      return {
        step,
        absent: read.absent,
        message,
        ...(attempt !== undefined ? { attempt } : {}),
      };
    }
    const { words } = read;
    return {
      step,
      code: words.error_code,
      ...(words.error_category !== undefined ? { category: words.error_category } : {}),
      ...(words.stop_reason !== undefined ? { stop_reason: words.stop_reason } : {}),
      ...(words.agent_action !== undefined ? { agent_action: words.agent_action } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      message,
      ...(words.unknown.length > 0 ? { unknown: words.unknown.map((f) => VIEW_KEY[f]) } : {}),
    };
  });
}
