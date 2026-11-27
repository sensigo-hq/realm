/**
 * CheckQuotesHandler — the built-in `check_quotes` (issue #760; design D1, D4, D5).
 *
 * For every extracted value it records how its quote was found in the source document (one of the
 * six `QUOTE_STATES`, with offsets), and warns when any quote is not found. It never stops the run
 * and never judges whether a value is correct: an author stops the run with a guard on the step's
 * `all_found` (design D4). The matching rule lives in `locateQuote` alone; this composes nothing of
 * its own.
 *
 * Both inputs are read from the run's evidence (`context.resources`) by step id, never from
 * `inputs.params`: an engine-run step that depends on another receives `{}` unless it declares an
 * `input_map` (decision C2).
 */
import type {
  StepHandler,
  StepHandlerInputs,
  StepContext,
  StepHandlerResult,
} from '../extensions/step-handler.js';
import { WorkflowError } from '../types/workflow-error.js';
import { VALIDATION_PROBLEMS_SHOWN, renderMore } from '../validation/validation-problems.js';
import { controlEscape } from '../utils/redaction.js';
import { resolveResource } from './primitives/resolve-resource.js';
import {
  locateQuote,
  releaseQuoteCache,
  QUOTE_STATES,
  DEFAULT_MIN_PART_CHARS,
  MIN_PART_CHARS_LEAST,
  type QuoteCheck,
  type QuoteState,
} from './primitives/locate-quote.js';

/** The config keys `check_quotes` reads; any other key is refused. */
export const CHECK_QUOTES_CONFIG_KEYS = [
  'source_step',
  'source_field',
  'candidates_step',
  'candidates_field',
  'quote_field',
  'min_part_chars',
] as const;

/** How many characters of a missing quote, and of a value's field, the warning shows. */
const QUOTE_HEAD_CHARS = 80;

const KEY_LIST =
  'source_step, source_field, candidates_step, candidates_field, quote_field and min_part_chars';

/** H6: what a refusal says happened — the STEP failed; a run whose later steps do not need it can
 *  still complete. */
const CONSEQUENCE = 'so the quote check did not run and this step failed';
/** H6: how the step runs again — `resume` is offered only for a run that ended `failed`, so it is
 *  said conditionally (the handler cannot know how the run will end). */
const READMISSION =
  'then register the workflow again and start a new run; if this run ended failed, ' +
  'realm run resume <run-id> --from <step> runs the step again instead.';

/** #845 1b-ii-c (A1): how a step whose output has no field to point at is got past — this run keeps
 *  that output, so running the check again in it reads the same one. */
const NEW_RUN_READMISSION =
  'then start a new run: this run keeps that output, so running this step again in it fails the ' +
  'same way.';

/** One fault: what is wrong, its own remedy, and — when resume cannot help — its own way back. */
interface Fault {
  readonly validity: string;
  readonly remedy: string;
  readonly readmission?: string;
}

/** The four-clause refusal (validity · consequence · remedy · re-admission); H5: every config fault
 *  in one message, each with its own remedy, capped with the remainder counted. */
function refuse(faults: readonly Fault[]): WorkflowError {
  const only = faults[0]!;
  const message =
    faults.length === 1
      ? `check_quotes: ${only.validity}, ${CONSEQUENCE}. ${only.remedy}, ${only.readmission ?? READMISSION}`
      : (() => {
          const shown = faults.slice(0, VALIDATION_PROBLEMS_SHOWN);
          const more = renderMore(faults.length, shown.length);
          const list = shown.map((f) => `${f.validity} (${lowerFirst(f.remedy)})`).join('; ');
          return (
            `check_quotes: the step's config has ${faults.length} problems: ${list}` +
            `${more === '' ? '' : `; ${more}`}, ${CONSEQUENCE}. Fix each one, ${READMISSION}`
          );
        })();
  return new WorkflowError(message, {
    code: 'ENGINE_HANDLER_FAILED',
    category: 'ENGINE',
    agentAction: 'stop',
    retryable: false,
  });
}

const lowerFirst = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1);

/** A value's kind for a refusal — never the value itself. */
function kindOf(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/** A string config key, its default when absent; a fault is pushed, never thrown, so every config
 *  fault is named in one refusal (H5). */
function stringKey(
  config: Record<string, unknown>,
  key: string,
  faults: Fault[],
  fallback?: string,
): string {
  const value = config[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined) {
    faults.push({
      validity: `the config key '${key}' is required`,
      remedy: `Add '${key}' to the step's config`,
    });
    return '';
  }
  if (typeof value !== 'string' || value === '') {
    faults.push({
      validity: `the config key '${key}' must be a non-empty string (got ${kindOf(value)})`,
      remedy: `Set '${key}' to a step or field name`,
    });
    return '';
  }
  return value;
}

/** #845 1b-ii-c (A6): one letter or symbol as a reader sees it — a grapheme cluster, as Node reads
 *  one. */
const LETTERS = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** #845 1b-ii-c (A6): how many characters of a text longer than 80 the warning shows — 80, or fewer
 *  where the 80th is part of a letter or symbol that goes on past it: the cut then moves back to
 *  before it, unless that one letter or symbol alone runs from the text's start past the 80th. */
function headLength(oneLine: string): number {
  let before = 0;
  for (const { segment } of LETTERS.segment(oneLine)) {
    const size = Array.from(segment).length;
    if (before + size > QUOTE_HEAD_CHARS) return before === 0 ? QUOTE_HEAD_CHARS : before;
    before += size;
  }
  return QUOTE_HEAD_CHARS;
}

/** H2: text the model wrote, as one terminal-safe line: whitespace runs as one space, cut at 80
 *  characters with `…` (never inside a letter or symbol written with several, #845 1b-ii-c), then
 *  every control character left written out (decision C183). */
function shown(text: string): string {
  const oneLine = text.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(oneLine);
  const head =
    chars.length > QUOTE_HEAD_CHARS ? `${chars.slice(0, headLength(oneLine)).join('')}…` : oneLine;
  // eslint-disable-next-line no-control-regex -- the control characters are what is escaped
  return head.replace(/[\u0000-\u001f\u007f-\u009f]/g, controlEscape);
}

/** Whether a prior step's output is in the run's evidence — checked by key, before its field. */
function hasStep(resources: Record<string, unknown> | undefined, stepId: string): boolean {
  return resources !== undefined && Object.prototype.hasOwnProperty.call(resources, stepId);
}

/** #845 1b-ii-c (A1): the fault of a step (`role` `source` or `candidates`) whose output is not
 *  an object with at least one field, so no field of it can be pointed at — or `undefined`. `{}`,
 *  `[]`, and `null` or `undefined` from a library caller gave no output; any other list, a string,
 *  a number or a boolean gave that. */
function outputFault(
  role: string,
  stepId: string,
  output: unknown,
  holds: string,
): Fault | undefined {
  const isObject = output !== null && typeof output === 'object' && !Array.isArray(output);
  if (isObject && Object.keys(output).length > 0) return undefined;
  const empty =
    output === null || output === undefined
      ? 'null'
      : isObject
        ? 'an empty object'
        : Array.isArray(output) && output.length === 0
          ? 'an empty list'
          : undefined;
  return {
    validity:
      empty !== undefined
        ? `the ${role} step '${stepId}' gave no output (got ${empty})`
        : `the ${role} step '${stepId}' gave ${kindOf(output)}, not an object with fields`,
    remedy: `Make '${stepId}' put ${holds} in a field of its output (register the workflow again if you change it)`,
    readmission: NEW_RUN_READMISSION,
  };
}

/** H1: a value is empty only when the candidate HAS a `value` key holding `null`, or a string that
 *  is empty after trimming; with no `value` key the check cannot know the value is empty. */
const hasEmptyValue = (candidate: Record<string, unknown>): boolean => {
  if (!Object.prototype.hasOwnProperty.call(candidate, 'value')) return false;
  const value = candidate['value'];
  return value === null || (typeof value === 'string' && value.trim() === '');
};

export class CheckQuotesHandler implements StepHandler {
  readonly id = 'check_quotes';

  async execute(_inputs: StepHandlerInputs, context: StepContext): Promise<StepHandlerResult> {
    try {
      return this.check(context);
    } finally {
      // L4: the cached document is let go when the step finishes.
      releaseQuoteCache();
    }
  }

  private check(context: StepContext): StepHandlerResult {
    const config = context.config;
    const faults: Fault[] = [];
    for (const key of Object.keys(config)) {
      if (!(CHECK_QUOTES_CONFIG_KEYS as readonly string[]).includes(key)) {
        faults.push({
          validity: `the config key '${key}' is not one this handler reads`,
          remedy: `Remove it or correct its spelling (the keys are ${KEY_LIST})`,
        });
      }
    }
    const sourceStep = stringKey(config, 'source_step', faults);
    const sourceField = stringKey(config, 'source_field', faults, 'text');
    const candidatesStep = stringKey(config, 'candidates_step', faults);
    const candidatesField = stringKey(config, 'candidates_field', faults, 'candidates');
    const quoteField = stringKey(config, 'quote_field', faults, 'quote');
    // H6: only an absent key takes the default; `null` is refused like any other value.
    const minPartChars =
      config['min_part_chars'] === undefined ? DEFAULT_MIN_PART_CHARS : config['min_part_chars'];
    if (
      typeof minPartChars !== 'number' ||
      !Number.isInteger(minPartChars) ||
      minPartChars < MIN_PART_CHARS_LEAST
    ) {
      faults.push({
        validity: `min_part_chars must be a whole number of at least ${MIN_PART_CHARS_LEAST} (got ${kindOf(minPartChars)}${typeof minPartChars === 'number' ? ` ${minPartChars}` : ''})`,
        remedy: `Set it to ${MIN_PART_CHARS_LEAST} or more, or remove it to use ${DEFAULT_MIN_PART_CHARS}`,
      });
    }
    if (faults.length > 0) throw refuse(faults);
    const floor = minPartChars as number;

    const resources = context.resources;
    if (!hasStep(resources, sourceStep)) {
      throw refuse([
        {
          validity: `the source step '${sourceStep}' has no output in this run`,
          remedy: `Name in source_step a step that runs before this one (list it in depends_on)`,
        },
      ]);
    }
    const sourceFault = outputFault(
      'source',
      sourceStep,
      resources![sourceStep],
      "the document's text",
    );
    if (sourceFault !== undefined) throw refuse([sourceFault]);
    const source = resolveResource(resources, sourceStep, sourceField);
    if (typeof source !== 'string') {
      throw refuse([
        {
          validity: `'${sourceStep}.${sourceField}' is not the document's text (got ${kindOf(source)})`,
          remedy: `Point source_field at the field of '${sourceStep}' that holds the text`,
        },
      ]);
    }
    if (!hasStep(resources, candidatesStep)) {
      throw refuse([
        {
          validity: `the candidates step '${candidatesStep}' has no output in this run`,
          remedy: `Name in candidates_step a step that runs before this one (list it in depends_on)`,
        },
      ]);
    }
    const candidatesFault = outputFault(
      'candidates',
      candidatesStep,
      resources![candidatesStep],
      'the list of extracted values',
    );
    if (candidatesFault !== undefined) throw refuse([candidatesFault]);
    const candidates = resolveResource(resources, candidatesStep, candidatesField);
    if (!Array.isArray(candidates)) {
      throw refuse([
        {
          validity: `'${candidatesStep}.${candidatesField}' is not a list of candidates (got ${kindOf(candidates)})`,
          remedy: `Point candidates_field at the field of '${candidatesStep}' that holds the list of extracted values`,
        },
      ]);
    }
    const at = candidates.findIndex((c) => c === null || typeof c !== 'object' || Array.isArray(c));
    if (at >= 0) {
      throw refuse([
        {
          validity: `candidate ${at + 1} of '${candidatesStep}.${candidatesField}' is not an object (got ${kindOf(candidates[at])})`,
          remedy: `Make every candidate an object carrying its '${quoteField}'`,
        },
      ]);
    }

    const byState = Object.fromEntries(QUOTE_STATES.map((s) => [s, 0])) as Record<
      QuoteState,
      number
    >;
    const missing: string[] = [];
    const results = (candidates as Record<string, unknown>[]).map((candidate, index) => {
      const quote = candidate[quoteField];
      const hasQuote = typeof quote === 'string' && quote.trim() !== '';
      const check: QuoteCheck = hasQuote
        ? locateQuote(quote, source, { minPartChars: floor })
        : {
            state: hasEmptyValue(candidate) ? 'unquoted' : 'not_found',
            parts: [],
            occurrences: 0,
          };
      byState[check.state]++;
      if (check.state === 'not_found') {
        const field = shown(
          typeof candidate['field'] === 'string' ? candidate['field'] : `candidate ${index + 1}`,
        );
        // H3: a value with no quote says so; a search that ran says where it came closest — or, for a
        // quote refused only for joining text across a blank line (#845, Q-C), how to quote it.
        const what = hasQuote
          ? `"${shown(quote)}" (${
              check.cause === 'blank_line_join'
                ? 'this quote joins text across a blank line; quote each part separately'
                : check.nearest !== undefined
                  ? `nearest match at ${check.nearest.start}–${check.nearest.end}`
                  : 'no nearby match'
            })`
          : quote === undefined || typeof quote === 'string'
            ? 'no quote given'
            : 'the quote is not text';
        missing.push(`${field} — ${what}`);
      }
      return { ...candidate, quote_check: check };
    });

    const data = {
      results,
      by_state: byState,
      all_found: byState.not_found === 0,
      candidates_found: candidates.length,
    };
    if (missing.length === 0) return { data };
    const listed = missing.slice(0, VALIDATION_PROBLEMS_SHOWN);
    const more = renderMore(missing.length, listed.length);
    return {
      data,
      warn: {
        message:
          `Quote check: ${missing.length} of ${candidates.length} values not found in ` +
          `'${sourceStep}.${sourceField}': ${listed.join('; ')}${more === '' ? '' : `; ${more}`}.`,
      },
    };
  }
}
