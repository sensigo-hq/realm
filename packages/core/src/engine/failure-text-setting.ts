// failure-text-setting.ts — gap 2, unit (iv-b1): the MCP door's failure-text setting, judged ONCE, in
// the gate-answers judge's form — whether an assistant reads a failure's words in `get_run_state`.
// `hidden` wins over `shown` whichever source sets it (the most restrictive value); default `shown`.
// Pure: every value is passed in — the server and the bins read their own flags and environment and
// call this, so `--check` judges exactly what the server will start with.
import type { Source } from './ways.js';

/**
 * Whether the MCP door shows an assistant a failure's words: `shown` (the default) or `hidden`, which
 * shows each failure's step and its code, category or class where the record has them, and in place
 * of its words their length. The most restrictive value wins: `hidden` > `shown`.
 */
export const FAILURE_TEXT_VALUES = ['shown', 'hidden'] as const;
/** A failure-text value: `shown` or `hidden`. */
export type FailureText = (typeof FAILURE_TEXT_VALUES)[number];

/** The environment variable the failure-text value is read from. */
export const FAILURE_TEXT_ENV = 'REALM_MCP_FAILURE_TEXT';

/** Where a failure-text value was set, with the name a person reads. */
const SOURCE_REFS = {
  flag: '--failure-text',
  env: FAILURE_TEXT_ENV,
  option: 'the program that started this server (failureText option)',
  default: 'the default',
} as const;

type SetKind = 'flag' | 'env' | 'option';

/** The failure-text value a server runs with: the winner, where it came from, and every other set
 *  value with its source. */
export interface FailureTextSetting {
  value: FailureText;
  source: Source;
  alsoSet: { source: Source; value: FailureText }[];
}

/** The places a failure-text value can be set, as given (unchecked). */
export interface FailureTextInput {
  /** The bins' `--failure-text` flag. */
  flag?: string | undefined;
  /** `REALM_MCP_FAILURE_TEXT`. */
  env?: string | undefined;
  /** `RealmMcpServerOptions.failureText`. */
  option?: string | undefined;
}

const RANK: Record<FailureText, number> = { shown: 0, hidden: 1 };

const isFailureText = (v: string): v is FailureText =>
  (FAILURE_TEXT_VALUES as readonly string[]).includes(v);

const sourceOf = (kind: SetKind | 'default'): Source => ({ kind, ref: SOURCE_REFS[kind] });

/**
 * The effective failure-text value, judged as the gate-answers value is: `hidden` when any source
 * sets it (ties go to the flag, then the environment, then the option — the most direct place), else
 * `shown` from the default; or the first value that is neither, with where it was set. An empty flag
 * or option is a value given, and refused where it was given; an empty environment variable stays
 * unset.
 */
export function judgeFailureText(
  input: FailureTextInput,
): { ok: true; setting: FailureTextSetting } | { ok: false; kind: SetKind; raw: string } {
  const set: { kind: SetKind; value: FailureText }[] = [];
  for (const kind of ['flag', 'env', 'option'] as const) {
    const raw = input[kind];
    if (raw === undefined || (raw === '' && kind === 'env')) continue;
    if (!isFailureText(raw)) return { ok: false, kind, raw };
    set.push({ kind, value: raw });
  }
  if (set.length === 0) {
    return { ok: true, setting: { value: 'shown', source: sourceOf('default'), alsoSet: [] } };
  }
  const winner = set.reduce((best, s) => (RANK[s.value] > RANK[best.value] ? s : best));
  return {
    ok: true,
    setting: {
      value: winner.value,
      source: sourceOf(winner.kind),
      alsoSet: set
        .filter((s) => s !== winner)
        .map((s) => ({ source: sourceOf(s.kind), value: s.value })),
    },
  };
}
