// template-check.ts — fix 1, piece 3a-i: a template's filters, their arguments, and a templated
// field's type, judged when the file loads.
//
// Three loader warning codes, each policy 'error' (refused by validate, register and watch; printed
// as a warning by `realm workflow run`, `realm workflow test`, `realm agent` and `realm listen`):
//   TEMPLATE_FILTER_UNKNOWN — a placeholder's filter Realm does not have;
//   TEMPLATE_FILTER_ARGUMENT — a filter argument no value accepts;
//   TEMPLATED_FIELD_NOT_TEXT — a templated field that is not a string.
//
// The fields judged are the ones Realm renders: `gate.message`, `prompt` and `display` on an auto or
// agent step, and `instructions` on a step whose trust opens a gate (the gate's opening reply renders
// them, on an auto step and an agent step alike); a gateless agent step's `instructions` are passed on
// raw and never rendered. One placeholder rule (`TEMPLATE_PLACEHOLDER`), one filter parse
// (`placeholderParts`), one list of filters (`FILTER_STABILITY`'s keys, held equal to `applyFilter`'s
// cases by its witness cell). Paths and roots are not judged here (3a-ii).
import {
  FILTER_STABILITY,
  TEMPLATE_PLACEHOLDER,
  applyFilter,
  placeholderParts,
} from '../engine/render-template.js';
import { isGateTrust } from '../types/workflow-definition.js';
import { capText } from '../utils/redaction.js';
import {
  closestKey,
  resolveSeverity,
  type LoaderWarning,
  type WarningCode,
} from './diagnostics.js';
import type { SourcePosition } from './source-positions.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The filters Realm has. */
const KNOWN_FILTERS: readonly string[] = Object.keys(FILTER_STABILITY);

/**
 * The samples each filter is applied to, one of each kind a value can be: a number, a text (an
 * instant, for `date` and `from_now`), a list, a list of maps (for `pluck`), a map, true or false.
 */
const SAMPLES: readonly unknown[] = [
  1.5,
  '2026-01-28T14:05:00Z',
  [1, 2],
  [{ a: 1 }],
  { a: 1 },
  true,
];

type Field = 'gate.message' | 'prompt' | 'instructions' | 'display';

const UNFILLED_DISPLAY = "that placeholder is not filled in where the step's result is shown";
const AS_WRITTEN = 'the placeholder is passed on as written';

/** Item 1: what an unknown filter does to the run, by field. */
const UNKNOWN_CONSEQUENCE: Record<Field, string> = {
  'gate.message': 'the gate does not open, and the run stays open with the step not done',
  prompt: AS_WRITTEN,
  instructions: AS_WRITTEN,
  display: UNFILLED_DISPLAY,
};

/** Item 2: what an argument no value accepts does to the run, by field and by cause. */
function argumentConsequence(field: Field, verdict: ArgumentVerdict): string {
  if (field === 'display') return UNFILLED_DISPLAY;
  if (verdict.cause === 'out_of_range') {
    return field === 'instructions'
      ? 'the call that opens the gate fails with an error after the question is already open'
      : `the step stops with an error when the run reaches it and the value is ${verdict.kind === 'number' ? 'a number' : 'text'}`;
  }
  return field === 'gate.message' ? 'the question shows the placeholder as written' : AS_WRITTEN;
}

type ArgumentVerdict =
  { cause: 'out_of_range'; kind: 'number' | 'text' } | { cause: 'no_value_accepted' };

/**
 * Item 2: one filter, on its own (never fed by the previous one), with its literal arguments at
 * `'stored'` time, applied to each sample. Out of range when any sample throws a RangeError; no value
 * accepted when no sample returns ok; else `undefined` (a value accepts it).
 */
function judgeArguments(
  name: string,
  args: string[],
  quoted?: readonly boolean[],
): ArgumentVerdict | undefined {
  let gave = false;
  for (const sample of SAMPLES) {
    try {
      if (applyFilter(sample, name, args, 'stored', quoted).ok) gave = true;
    } catch (err) {
      if (err instanceof RangeError) {
        return { cause: 'out_of_range', kind: typeof sample === 'number' ? 'number' : 'text' };
      }
    }
  }
  return gave ? undefined : { cause: 'no_value_accepted' };
}

/**
 * Fix 1, piece 3a-ii-a: whether one placeholder gets a finding here — an unknown filter, or an
 * argument no value accepts — so the path check gives it no second one.
 */
export function hasFilterFinding(expr: string): boolean {
  for (const filter of placeholderParts(expr.trim()).filters) {
    if (!KNOWN_FILTERS.includes(filter.name)) return true;
    if (judgeArguments(filter.name, filter.args, filter.quoted) !== undefined) return true;
  }
  return false;
}

/** Item 3: the type word for a value that is not text. */
function typeWord(value: unknown): string {
  if (value === null || value === undefined) return 'empty';
  // YAML reads an unquoted date (`display: 2026-01-28`) as a date (correction 1, O2).
  if (value instanceof Date) return 'a date';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'true or false';
  return 'a map';
}

/** The fields of one step this check judges, each with where its key sits. */
function fieldsOf(raw: Obj): Array<{ field: Field; value: unknown; key: string[] }> {
  const out: Array<{ field: Field; value: unknown; key: string[] }> = [];
  const gate = raw['gate'];
  if (isObj(gate) && has(gate, 'message')) {
    out.push({ field: 'gate.message', value: gate['message'], key: ['gate', 'message'] });
  }
  if (has(raw, 'prompt')) out.push({ field: 'prompt', value: raw['prompt'], key: ['prompt'] });
  if (isGateTrust(raw['trust']) && has(raw, 'instructions')) {
    out.push({ field: 'instructions', value: raw['instructions'], key: ['instructions'] });
  }
  if (has(raw, 'display')) out.push({ field: 'display', value: raw['display'], key: ['display'] });
  return out;
}

/**
 * The findings for one workflow's steps, in the steps' file order, each field's in the order above,
 * each placeholder's in chain order up to and including its first finding: the first unknown filter,
 * or the first argument no value accepts — no filter after it can run (correction 1). `positionOf`
 * resolves a key's place in the source.
 */
export function checkTemplates(
  stepsRaw: unknown,
  positionOf: (segments: readonly string[]) => SourcePosition | undefined,
): LoaderWarning[] {
  if (!isObj(stepsRaw)) return [];
  const findings: LoaderWarning[] = [];
  for (const [stepName, raw] of Object.entries(stepsRaw)) {
    if (!isObj(raw) || (raw['execution'] !== 'auto' && raw['execution'] !== 'agent')) continue;
    const s = capText(stepName);
    for (const { field, value, key } of fieldsOf(raw)) {
      const place = {
        key: positionOf(['steps', stepName, ...key]),
        stepLine: positionOf(['steps', stepName])?.line,
      };
      if (typeof value !== 'string') {
        findings.push(
          finding(
            'TEMPLATED_FIELD_NOT_TEXT',
            `Step '${s}': ${field} must be text; it is ${typeWord(value)}, so Realm stops with an ` +
              `error when it reads it.`,
            stepName,
            field,
            place,
          ),
        );
        continue;
      }
      for (const match of value.matchAll(TEMPLATE_PLACEHOLDER)) {
        const expr = match[1]!.trim();
        const shown = `'{{ ${capText(expr)} }}'`;
        for (const filter of placeholderParts(expr).filters) {
          const f = capText(filter.name);
          if (!KNOWN_FILTERS.includes(filter.name)) {
            const dym = closestKey(filter.name, KNOWN_FILTERS);
            findings.push(
              finding(
                'TEMPLATE_FILTER_UNKNOWN',
                `Step '${s}': ${field} uses the filter '${f}' in ${shown}, which Realm does not ` +
                  `have, so ${UNKNOWN_CONSEQUENCE[field]}.` +
                  (dym !== undefined ? ` Did you mean '${capText(dym)}'?` : ''),
                stepName,
                field,
                place,
                dym,
              ),
            );
            break; // a filter after an unknown one is not judged
          }
          const verdict = judgeArguments(filter.name, filter.args, filter.quoted);
          if (verdict !== undefined) {
            findings.push(
              finding(
                'TEMPLATE_FILTER_ARGUMENT',
                `Step '${s}': ${field} gives the filter '${f}' an argument no value accepts in ` +
                  `${shown}, so ${argumentConsequence(field, verdict)}.`,
                stepName,
                field,
                place,
              ),
            );
            break; // a filter after it can never run, so it is not judged
          }
        }
      }
    }
  }
  return findings;
}

/** One finding, its line appended (#420): ` (line N)` for the key's, else ` (step at line N)`. */
function finding(
  code: WarningCode,
  text: string,
  step: string,
  field: Field,
  place: { key: SourcePosition | undefined; stepLine: number | undefined },
  didYouMean?: string,
): LoaderWarning {
  const at =
    place.key !== undefined
      ? ` (line ${place.key.line})`
      : place.stepLine !== undefined
        ? ` (step at line ${place.stepLine})`
        : '';
  const out: LoaderWarning = {
    code,
    severity: resolveSeverity(code),
    message: text + at,
    scope: 'step',
    step,
    key: field,
  };
  if (didYouMean !== undefined) out.did_you_mean = didYouMean;
  if (place.key !== undefined) {
    out.line = place.key.line;
    out.column = place.key.column;
    out.endLine = place.key.endLine;
    out.endColumn = place.key.endColumn;
  }
  return out;
}
