// gate-answers-setting.ts — #627 W (§5.1, §5.2b): the MCP door's two process settings, judged ONCE —
// the gate-answers value (the most restrictive of the flag, the environment and the option wins;
// default `asked`) and the form wait (the smallest value set wins; bounded 30…3600 s). Pure: every
// value is passed in — the server and the bins read their own flags and environment and call these,
// so `--check` judges exactly what the server will start with.
import { GATE_ANSWERS_VALUES, type GateAnswers, type Source } from './ways.js';

/** The environment variable the gate-answers value is read from. */
export const GATE_ANSWERS_ENV = 'REALM_MCP_GATE_ANSWERS';
/** The environment variable the form-wait setting is read from. */
export const FORM_WAIT_ENV = 'REALM_MCP_FORM_WAIT_SECONDS';

/**
 * The longest a form waits by default, in seconds. 240, not more: the wait is counted from the start
 * of the tool call, and the shortest fixed client call limit the field read (Goose, 300 s, FL-13)
 * runs from the call's start too, so the call ends — and the reply arrives — before the client gives
 * up on it (R-ss). Longer values can outlast some clients' limits.
 */
export const FORM_WAIT_SECONDS_DEFAULT = 240;
/** The bounds of the form-wait setting (W-s8): a person needs time; hours would hold a call. */
export const FORM_WAIT_SECONDS_MIN = 30;
export const FORM_WAIT_SECONDS_MAX = 3600;

/** Where a gate-answers value was set (P-10 `source`), with the name a person reads. */
const SOURCE_REFS = {
  flag: '--gate-answers',
  env: GATE_ANSWERS_ENV,
  option: 'the program that started this server (gateAnswers option)',
  default: 'the default',
} as const;

type SetKind = 'flag' | 'env' | 'option';

/** The gate-answers value a server runs with: the winner, where it came from, every other set value. */
export interface GateAnswersSetting {
  value: GateAnswers;
  source: Source;
  alsoSet: { source: Source; value: GateAnswers }[];
}

/** The places a gate-answers value can be set, as given (unchecked). */
export interface GateAnswersInput {
  /** The bins' `--gate-answers` flag. */
  flag?: string | undefined;
  /** `REALM_MCP_GATE_ANSWERS`. */
  env?: string | undefined;
  /** `RealmMcpServerOptions.gateAnswers`. */
  option?: string | undefined;
}

const RANK: Record<GateAnswers, number> = { offered: 0, asked: 1, withheld: 2 };

const isGateAnswers = (v: string): v is GateAnswers =>
  (GATE_ANSWERS_VALUES as readonly string[]).includes(v);

/** One source's `Source`. */
const sourceOf = (kind: SetKind | 'default'): Source => ({ kind, ref: SOURCE_REFS[kind] });

/**
 * The effective gate-answers value, judged: the most restrictive of the values set (ties go to the
 * flag, then the environment, then the option — the most direct place), else `asked` from the
 * default; or the first value that is not one of the three, with where it was set.
 */
export function judgeGateAnswers(
  input: GateAnswersInput,
): { ok: true; setting: GateAnswersSetting } | { ok: false; kind: SetKind; raw: string } {
  const set: { kind: SetKind; value: GateAnswers }[] = [];
  for (const kind of ['flag', 'env', 'option'] as const) {
    const raw = input[kind];
    // Correction 1 (E1): an EMPTY flag is a value given, and not one of the three — refused (a
    // `--gate-answers "$MODE"` with `MODE` unset must not start the default silently); an empty
    // environment variable, or option, stays unset.
    if (raw === undefined || (raw === '' && kind !== 'flag')) continue;
    if (!isGateAnswers(raw)) return { ok: false, kind, raw };
    set.push({ kind, value: raw });
  }
  if (set.length === 0) {
    return { ok: true, setting: { value: 'asked', source: sourceOf('default'), alsoSet: [] } };
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

/** The "also set" clause of a start line or `--check`: every other source that was set, with its value. */
export function alsoSetClause(setting: GateAnswersSetting): string {
  if (setting.alsoSet.length === 0) return '';
  const list = setting.alsoSet.map((a) => `${a.source.ref} = ${a.value}`).join(', ');
  return `; also set: ${list} — the most restrictive value wins`;
}

/** The form-wait setting a server runs with: the smallest value set, else the default. */
export interface FormWaitSetting {
  seconds: number;
  source: Source;
}

/** The places the form-wait setting can be set, as given (unchecked). */
export interface FormWaitInput {
  flag?: string | number | undefined;
  env?: string | undefined;
  option?: number | string | undefined;
}

const FORM_WAIT_REFS = {
  flag: '--form-wait-seconds',
  env: FORM_WAIT_ENV,
  option: 'the program that started this server (formWaitSeconds option)',
  default: 'the default',
} as const;

/**
 * The form-wait setting, judged: every value set must be a whole number of seconds from 30 to 3600;
 * the SMALLEST wins (a shorter wait never outlasts a client); none set ⇒ the default.
 */
export function judgeFormWait(
  input: FormWaitInput,
): { ok: true; setting: FormWaitSetting } | { ok: false; kind: SetKind; raw: string } {
  let best: { kind: SetKind; seconds: number } | undefined;
  for (const kind of ['flag', 'env', 'option'] as const) {
    const raw = input[kind];
    if (raw === undefined || raw === '') continue;
    const text = String(raw);
    const n = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isInteger(n) || n < FORM_WAIT_SECONDS_MIN || n > FORM_WAIT_SECONDS_MAX) {
      return { ok: false, kind, raw: text };
    }
    if (best === undefined || n < best.seconds) best = { kind, seconds: n };
  }
  return best === undefined
    ? {
        ok: true,
        setting: {
          seconds: FORM_WAIT_SECONDS_DEFAULT,
          source: { kind: 'default', ref: FORM_WAIT_REFS.default },
        },
      }
    : {
        ok: true,
        setting: {
          seconds: best.seconds,
          source: { kind: best.kind, ref: FORM_WAIT_REFS[best.kind] },
        },
      };
}
