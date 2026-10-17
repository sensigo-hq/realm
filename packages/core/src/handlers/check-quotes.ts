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
import { resolveResource } from './primitives/resolve-resource.js';
import {
  locateQuote,
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

/** How many characters of a missing quote the warning shows (the agent's own words). */
const QUOTE_HEAD_CHARS = 80;

const KEY_LIST =
  'source_step, source_field, candidates_step, candidates_field, quote_field and min_part_chars';

/** The four-clause refusal: what is wrong, that the check did not run, the remedy, re-admission. */
function refuse(validity: string, remedy: string): WorkflowError {
  return new WorkflowError(
    `check_quotes: ${validity}, so the quote check did not run and the run failed. ${remedy}, ` +
      `then register the workflow again and start a new run.`,
    { code: 'ENGINE_HANDLER_FAILED', category: 'ENGINE', agentAction: 'stop', retryable: false },
  );
}

/** A value's kind for a refusal — never the value itself. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function stringKey(config: Record<string, unknown>, key: string, fallback?: string): string {
  const value = config[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined) {
    throw refuse(`the config key '${key}' is required`, `Add '${key}' to the step's config`);
  }
  if (typeof value !== 'string' || value === '') {
    throw refuse(
      `the config key '${key}' must be a non-empty string (got ${kindOf(value)})`,
      `Set '${key}' to a step or field name`,
    );
  }
  return value;
}

/** Whether a prior step's output is in the run's evidence — checked by key, before its field. */
function hasStep(resources: Record<string, unknown> | undefined, stepId: string): boolean {
  return resources !== undefined && Object.prototype.hasOwnProperty.call(resources, stepId);
}

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

export class CheckQuotesHandler implements StepHandler {
  readonly id = 'check_quotes';

  async execute(_inputs: StepHandlerInputs, context: StepContext): Promise<StepHandlerResult> {
    const config = context.config;
    for (const key of Object.keys(config)) {
      if (!(CHECK_QUOTES_CONFIG_KEYS as readonly string[]).includes(key)) {
        throw refuse(
          `the config key '${key}' is not one this handler reads`,
          `Remove it or correct its spelling (the keys are ${KEY_LIST})`,
        );
      }
    }
    const sourceStep = stringKey(config, 'source_step');
    const sourceField = stringKey(config, 'source_field', 'text');
    const candidatesStep = stringKey(config, 'candidates_step');
    const candidatesField = stringKey(config, 'candidates_field', 'candidates');
    const quoteField = stringKey(config, 'quote_field', 'quote');
    const minPartChars = config['min_part_chars'] ?? DEFAULT_MIN_PART_CHARS;
    if (
      typeof minPartChars !== 'number' ||
      !Number.isInteger(minPartChars) ||
      minPartChars < MIN_PART_CHARS_LEAST
    ) {
      throw refuse(
        `min_part_chars must be a whole number of at least ${MIN_PART_CHARS_LEAST} (got ${kindOf(minPartChars)}${typeof minPartChars === 'number' ? ` ${minPartChars}` : ''})`,
        `Set it to ${MIN_PART_CHARS_LEAST} or more, or remove it to use ${DEFAULT_MIN_PART_CHARS}`,
      );
    }

    const resources = context.resources;
    if (!hasStep(resources, sourceStep)) {
      throw refuse(
        `the source step '${sourceStep}' has no output in this run`,
        `Name in source_step a step that runs before this one (list it in depends_on)`,
      );
    }
    const source = resolveResource(resources, sourceStep, sourceField);
    if (typeof source !== 'string') {
      throw refuse(
        `'${sourceStep}.${sourceField}' is not the document's text (got ${kindOf(source)})`,
        `Point source_field at the field of '${sourceStep}' that holds the text`,
      );
    }
    if (!hasStep(resources, candidatesStep)) {
      throw refuse(
        `the candidates step '${candidatesStep}' has no output in this run`,
        `Name in candidates_step a step that runs before this one (list it in depends_on)`,
      );
    }
    const candidates = resolveResource(resources, candidatesStep, candidatesField);
    if (!Array.isArray(candidates)) {
      throw refuse(
        `'${candidatesStep}.${candidatesField}' is not a list of candidates (got ${kindOf(candidates)})`,
        `Point candidates_field at the field of '${candidatesStep}' that holds the list of extracted values`,
      );
    }
    const at = candidates.findIndex((c) => c === null || typeof c !== 'object' || Array.isArray(c));
    if (at >= 0) {
      throw refuse(
        `candidate ${at + 1} of '${candidatesStep}.${candidatesField}' is not an object (got ${kindOf(candidates[at])})`,
        `Make every candidate an object carrying its '${quoteField}'`,
      );
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
        ? locateQuote(quote, source, { minPartChars })
        : {
            state: isEmpty(candidate['value']) ? 'unquoted' : 'not_found',
            parts: [],
            occurrences: 0,
          };
      byState[check.state]++;
      if (check.state === 'not_found') {
        const field =
          typeof candidate['field'] === 'string' ? candidate['field'] : `candidate ${index + 1}`;
        const head = Array.from(hasQuote ? quote.replace(/\s+/gu, ' ').trim() : '')
          .slice(0, QUOTE_HEAD_CHARS)
          .join('');
        const where =
          check.nearest !== undefined
            ? `nearest match at ${check.nearest.start}–${check.nearest.end}`
            : 'no nearby match';
        missing.push(`${field} — "${head}" (${where})`);
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
    const shown = missing.slice(0, VALIDATION_PROBLEMS_SHOWN);
    const more = renderMore(missing.length, shown.length);
    return {
      data,
      warn: {
        message:
          `Quote check: ${missing.length} of ${candidates.length} quotes not found in ` +
          `'${sourceStep}.${sourceField}': ${shown.join('; ')}${more === '' ? '' : `; ${more}`}.`,
      },
    };
  }
}
