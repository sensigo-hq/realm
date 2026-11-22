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
import type { EvidenceSnapshot, RunRecord, StepDiagnostics } from '../types/run-record.js';
import { capText } from '../utils/redaction.js';
import { readFailureWords, type FailureWordField } from './ways.js';

/**
 * A failed step, as its last failed evidence entry records it. With the words: the error `code`,
 * its `category`, why Realm stopped retrying (`stop_reason`), the entry's action word
 * (`agent_action`) and the failure's kind (`failure_kind`: `transient` or `permanent`, on a step
 * that took its failure path after a failed model request), each as recorded and absent when the
 * entry lacks it; a word outside its list is kept and named in `unknown`. Without them: `absent` says why — `written_before_failure_words`
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
      failure_kind?: string;
      attempt?: number;
      message: string;
      unknown?: Array<'code' | 'category' | 'stop_reason' | 'agent_action' | 'failure_kind'>;
    }
  | {
      step: string;
      absent: 'written_before_failure_words';
      message: string;
      attempt?: number;
    }
  | { step: string; absent: 'entry_not_found' };

/** The view's key for each of the reader's word fields. */
const VIEW_KEY = {
  error_code: 'code',
  error_category: 'category',
  stop_reason: 'stop_reason',
  agent_action: 'agent_action',
} as const satisfies Record<FailureWordField, string>;

const stringOr = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Gap 2, unit (ii-b1): the kinds a failure-path entry records (`StepDiagnostics.failure_kind`). */
const FAILURE_KINDS = ['transient', 'permanent'] as const satisfies readonly NonNullable<
  StepDiagnostics['failure_kind']
>[];
type MissingKind = Exclude<
  NonNullable<StepDiagnostics['failure_kind']>,
  (typeof FAILURE_KINDS)[number]
>;
const _everyKindListed: [MissingKind] extends [never] ? true : MissingKind = true;
void _everyKindListed;

/** The entry's `diagnostics.failure_kind` when it is a string, else `undefined`. */
function failureKindOf(entry: Record<string, unknown>): string | undefined {
  const diagnostics = entry['diagnostics'];
  if (typeof diagnostics !== 'object' || diagnostics === null) return undefined;
  return stringOr((diagnostics as Record<string, unknown>)['failure_kind']);
}

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
    // Gap 2, unit (ii-b1): the kind, read as the other words are — kept as recorded, and named in
    // `unknown` when it is outside its list.
    const kind = failureKindOf(entry);
    const unknown: NonNullable<Extract<FailureView, { code: string }>['unknown']> = [
      ...words.unknown.map((f) => VIEW_KEY[f]),
      ...(kind !== undefined && !(FAILURE_KINDS as readonly string[]).includes(kind)
        ? (['failure_kind'] as const)
        : []),
    ];
    return {
      step,
      code: words.error_code,
      ...(words.error_category !== undefined ? { category: words.error_category } : {}),
      ...(words.stop_reason !== undefined ? { stop_reason: words.stop_reason } : {}),
      ...(words.agent_action !== undefined ? { agent_action: words.agent_action } : {}),
      ...(kind !== undefined ? { failure_kind: kind } : {}),
      ...(attempt !== undefined ? { attempt } : {}),
      message,
      ...(unknown.length > 0 ? { unknown } : {}),
    };
  });
}
