// required-parts.ts — issue #719: the admission table's `required_parts` row. What each engine entry
// needs from the parts its host hands it — present, and of the right type — in ONE entry-keyed
// table (the `ENTRY_CALLERS` precedent), checked before anything is read or written. Content is
// tier 2's (a string is never checked for emptiness here); this row checks presence and type only.
import { WorkflowError } from '../types/workflow-error.js';
import { OUTPUT_SOURCES } from '../types/run-record.js';
import {
  runRecordFieldProblems,
  runRecordProblemClause,
  type RunRecordFieldProblem,
} from '../types/run-record-shape.js';
import { callsHostDispatcher } from './output-source.js';
import type { StepDefinition } from '../types/workflow-definition.js';
import type { EngineEntry as Entry } from '../admission.js';

/** What a part must be. Each kind has one test and one phrase. */
type PartKind =
  | 'object'
  | 'string'
  | 'function'
  | 'boolean'
  | 'array'
  | 'given'
  | 'date'
  | 'run'
  | 'output_source';

const EXPECTED: Record<PartKind, string> = {
  object: 'an object',
  string: 'a string',
  function: 'a function',
  boolean: 'a boolean',
  array: 'an array',
  given: 'present and not null',
  date: 'a valid Date',
  run: 'a run record',
  output_source: `one of ${OUTPUT_SOURCES.join(', ')}`,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function holds(kind: PartKind, value: unknown): boolean {
  switch (kind) {
    case 'object':
      return isPlainObject(value);
    case 'string':
      return typeof value === 'string';
    case 'function':
      return typeof value === 'function';
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'given':
      return value !== undefined && value !== null;
    case 'date':
      return value instanceof Date && Number.isFinite(value.getTime());
    case 'run':
      return isPlainObject(value) && runRecordFieldProblems(value).length === 0;
    case 'output_source':
      return (OUTPUT_SOURCES as readonly unknown[]).includes(value);
  }
}

/** A value's type as a word — never the value itself (an option can be a secret). */
export function givenTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? 'Date' : 'Date (invalid)';
  return typeof value;
}

interface PartRule {
  /** The parameter, then the member path inside it (`['options', 'runId']`). */
  readonly path: readonly string[];
  readonly kind: PartKind;
  /** `false`: checked only when present (`undefined` is absent). */
  readonly required: boolean;
  /** When given, the rule applies only when this holds (the dispatcher's step-kind condition). */
  readonly when?: (parts: Record<string, unknown>) => boolean;
}

const need = (kind: PartKind, ...path: string[]): PartRule => ({ path, kind, required: true });
const typed = (kind: PartKind, ...path: string[]): PartRule => ({ path, kind, required: false });

/**
 * issue #719 (R1): the dispatcher is required exactly when `command` names a step Realm calls the
 * host's dispatcher for — judged only when the definition's steps are an object, `command` is a
 * string and the definition has that step; otherwise it is unjudged and today's unknown-step reply
 * answers.
 */
function needsDispatcher(parts: Record<string, unknown>): boolean {
  const definition = parts['definition'];
  const options = parts['options'];
  if (!isPlainObject(definition) || !isPlainObject(options)) return false;
  const steps = definition['steps'];
  const command = options['command'];
  if (!isPlainObject(steps) || typeof command !== 'string') return false;
  if (!Object.hasOwn(steps, command)) return false;
  return callsHostDispatcher(steps[command] as StepDefinition);
}

const DEFINITION: readonly PartRule[] = [
  need('object', 'definition'),
  need('object', 'definition', 'steps'),
];

/** `executeStep` and `executeChain` share these; `outputSource` is `executeStep`'s alone. */
const STEP_PARTS: readonly PartRule[] = [
  ...DEFINITION,
  need('object', 'options'),
  need('string', 'options', 'runId'),
  need('string', 'options', 'command'),
  need('given', 'options', 'input'),
  { ...need('function', 'options', 'dispatcher'), when: needsDispatcher },
  typed('date', 'options', 'now'),
  typed('object', 'options', 'stepMeta'),
  typed('array', 'options', 'trace'),
  typed('object', 'options', 'traceBufferStore'),
  typed('string', 'options', 'writerNonce'),
];

/**
 * issue #719 — each entry's parts: what is required, and what is typed when present (R3, derived
 * from each entry's options type: every typed optional member except `registry`, `driver` and
 * `caller`, which earlier rows of the table check). Order is the order the defects are named in.
 */
export const REQUIRED_PARTS: Readonly<Record<Entry, readonly PartRule[]>> = {
  executeStep: [...STEP_PARTS, typed('output_source', 'options', 'outputSource')],
  executeChain: STEP_PARTS,
  executeEngineStep: [
    ...DEFINITION,
    need('object', 'options'),
    need('string', 'options', 'runId'),
    need('string', 'options', 'step'),
    need('run', 'options', 'run'),
    typed('date', 'options', 'now'),
    typed('object', 'options', 'traceBufferStore'),
  ],
  advanceRun: [
    ...DEFINITION,
    need('object', 'options'),
    need('string', 'options', 'runId'),
    typed('date', 'options', 'now'),
    typed('object', 'options', 'traceBufferStore'),
    typed('string', 'options', 'command'),
    typed('function', 'options', 'onStep'),
    typed('function', 'options', 'onTaken'),
    typed('function', 'options', 'onNotRecorded'),
    typed('function', 'options', 'onGuard'),
    typed('function', 'options', 'onExpiry'),
  ],
  submitHumanResponse: [
    ...DEFINITION,
    need('object', 'options'),
    need('string', 'options', 'runId'),
    need('string', 'options', 'gateId'),
    need('string', 'options', 'choice'),
    typed('date', 'options', 'now'),
    typed('string', 'options', 'respondedBy'),
    typed('string', 'options', 'claimToken'),
  ],
  abandonRun: [need('string', 'runId'), typed('string', 'reason')],
  drainFinalizers: [...DEFINITION, need('string', 'runId')],
  getWorkflowForRun: [
    need('run', 'run'),
    need('object', 'opts'),
    need('string', 'opts', 'retryVerb'),
    need('string', 'opts', 'verb'),
    typed('boolean', 'opts', 'terminalOk'),
  ],
  reclaimStep: [
    need('string', 'runId'),
    need('string', 'stepName'),
    typed('object', 'options'),
    typed('date', 'options', 'now'),
    typed('object', 'options', 'traceBufferStore'),
  ],
};

/** One defect, as the error's details name it: names and type words only. */
export interface InvalidPart {
  option: string;
  expected: string;
  given_type: string;
  fields?: RunRecordFieldProblem[];
}

/**
 * The value at `path`, or `skip` when a container on the way is not an object (that container's
 * own rule names it — a missing container is reported alone, without its members).
 */
function valueAt(
  parts: Record<string, unknown>,
  path: readonly string[],
): { value: unknown } | 'skip' {
  let value: unknown = parts[path[0]!];
  for (const key of path.slice(1)) {
    if (!isPlainObject(value)) return 'skip';
    value = value[key];
  }
  return { value };
}

/** Every defect of `parts` against the entry's rules, in table order. */
export function invalidParts(entry: Entry, parts: Record<string, unknown>): InvalidPart[] {
  const invalid: InvalidPart[] = [];
  for (const rule of REQUIRED_PARTS[entry]) {
    if (rule.when !== undefined && !rule.when(parts)) continue;
    const at = valueAt(parts, rule.path);
    if (at === 'skip') continue;
    const { value } = at;
    if (!rule.required && value === undefined) continue;
    if (holds(rule.kind, value)) continue;
    const fields =
      rule.kind === 'run' && isPlainObject(value) ? runRecordFieldProblems(value) : undefined;
    invalid.push({
      option: rule.path.join('.'),
      expected: EXPECTED[rule.kind],
      given_type: givenTypeOf(value),
      ...(fields !== undefined ? { fields } : {}),
    });
  }
  return invalid;
}

function clause(p: InvalidPart): string {
  const base = `${p.option} must be ${p.expected} (got ${p.given_type})`;
  return p.fields === undefined
    ? base
    : `${base} (${p.fields.map(runRecordProblemClause).join('; ')})`;
}

/**
 * The `required_parts` row's check (issue #719): every defect of the parts at once, as one
 * `VALIDATION_OPTION_INVALID` thrown before anything is read or written. `parts` absent: nothing to
 * check (an `admitEntry` call that hands none still admits).
 */
export function checkRequiredParts(entry: Entry, parts: Record<string, unknown> | undefined): void {
  if (parts === undefined) return;
  const invalid = invalidParts(entry, parts);
  if (invalid.length === 0) return;
  throw new WorkflowError(
    `${entry} was called with ${invalid.length} invalid option(s): ${invalid.map(clause).join('; ')}. Nothing was read or written.`,
    {
      code: 'VALIDATION_OPTION_INVALID',
      category: 'VALIDATION',
      agentAction: 'report_to_user',
      retryable: false,
      details: { entry, invalid },
    },
  );
}
