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
import { PARTIES } from './ways.js';
import type { StepDefinition } from '../types/workflow-definition.js';
import type { EngineEntry as Entry } from '../admission.js';
import type {
  ExecuteStepOptions,
  ExecuteChainOptions,
  ExecuteEngineStepOptions,
  AdvanceRunOptions,
  SubmitGateOptions,
} from './execution-loop.js';
import type { ReclaimStepOptions } from './reclaim-step.js';
import type { getWorkflowForRun } from '../workflow/registrar.js';
import type { ExtensionRegistry } from '../extensions/registry.js';

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
  | 'output_source'
  | 'registry'
  | 'party';

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
  registry: 'an extension registry',
  // issue #729 (the Q3 unit): the party a door hands in with its call (`ExecuteStepOptions.party`).
  party: `one of ${PARTIES.join(', ')}`,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * issue #719 (C4): a value's time when it is a `Date` — read through `Date`'s own method, so it is
 * a brand check (a `Date` from another realm is one; `Object.create(Date.prototype)` is not) and
 * never throws.
 */
function timeOf(value: unknown): number | undefined {
  try {
    return Date.prototype.getTime.call(value as Date);
  } catch {
    return undefined;
  }
}

/** issue #719 (C4, F3): the methods the engine calls on a host's registry — `getHandler` (a
 *  handler step, a finalizer), `getAdapter` and `getOrCreateRateLimiter` (a service step), `has`
 *  (a capability requirement, the owed view). Derived from the engine's calls; each is a member of
 *  `ExtensionRegistry`. */
const REGISTRY_METHODS = [
  'getHandler',
  'getAdapter',
  'getOrCreateRateLimiter',
  'has',
] as const satisfies readonly (keyof ExtensionRegistry)[];

/** issue #719 (C4, F3): an extension registry is an object on which each method the engine calls
 *  ({@link REGISTRY_METHODS}) is a function. */
function isExtensionRegistry(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  try {
    return REGISTRY_METHODS.every((m) => typeof value[m] === 'function');
  } catch {
    return false;
  }
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
      return Number.isFinite(timeOf(value));
    case 'run':
      return isPlainObject(value) && runRecordFieldProblems(value).length === 0;
    case 'output_source':
      return (OUTPUT_SOURCES as readonly unknown[]).includes(value);
    case 'registry':
      return isExtensionRegistry(value);
    case 'party':
      return (PARTIES as readonly unknown[]).includes(value);
  }
}

/** A value's type as a word — never the value itself (an option can be a secret). */
export function givenTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const time = timeOf(value);
  if (time !== undefined) return Number.isFinite(time) ? 'Date' : 'Date (invalid)';
  return typeof value;
}

interface PartRule {
  /** The parameter, then the member path inside it (`['options', 'runId']`). */
  readonly path: readonly string[];
  readonly kind: PartKind;
  /** `false`: checked only when present (`undefined` is absent; `null` is present, and refused).
   *  A function: required exactly when it holds (the dispatcher's step-kind condition), and
   *  checked whenever present. */
  readonly required: boolean | ((parts: Record<string, unknown>) => boolean);
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

/** issue #719 (C4): a rule required when `required(parts)` holds, and type-checked whenever
 *  present. */
const needWhen = (
  required: (parts: Record<string, unknown>) => boolean,
  kind: PartKind,
  ...path: string[]
): PartRule => ({ path, kind, required });

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
  needWhen(needsDispatcher, 'function', 'options', 'dispatcher'),
  typed('registry', 'options', 'registry'),
  typed('date', 'options', 'now'),
  typed('object', 'options', 'stepMeta'),
  typed('array', 'options', 'trace'),
  typed('object', 'options', 'traceBufferStore'),
  typed('string', 'options', 'writerNonce'),
  // issue #729 (the Q3 unit): the door's party, checked when present — a closed vocabulary.
  typed('party', 'options', 'party'),
];

/**
 * issue #719 — each entry's parts: what is required, and what is typed when present (R3, C4,
 * derived from each entry's options type: every typed optional member except `driver` and
 * `caller`, which earlier rows of the table check — `registry`'s earlier row refuses only a
 * registry of another realm release, so its type is checked here). Order is the order the defects
 * are named in; a member that is not an option of the entry follows them ({@link OPTION_MEMBERS}).
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
    typed('registry', 'options', 'registry'),
    typed('date', 'options', 'now'),
    typed('object', 'options', 'traceBufferStore'),
  ],
  advanceRun: [
    ...DEFINITION,
    need('object', 'options'),
    need('string', 'options', 'runId'),
    typed('registry', 'options', 'registry'),
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
    typed('registry', 'options', 'registry'),
    typed('date', 'options', 'now'),
    typed('string', 'options', 'respondedBy'),
    typed('string', 'options', 'claimToken'),
  ],
  abandonRun: [need('string', 'runId'), typed('string', 'reason')],
  drainFinalizers: [...DEFINITION, typed('registry', 'registry'), need('string', 'runId')],
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

/**
 * `true` exactly when the list `L` holds every key of `T` (with `satisfies`, which keeps every
 * member of `L` inside `keyof T`, the list equals `keyof T`): a member added to an options type
 * fails `tsc` here until its entry's list names it.
 */
type ListsEveryKey<T, L extends readonly PropertyKey[]> = [Exclude<keyof T, L[number]>] extends [
  never,
]
  ? true
  : never;

const EXECUTE_STEP_MEMBERS = [
  'runId',
  'command',
  'input',
  'dispatcher',
  'registry',
  'stepMeta',
  'trace',
  'traceBufferStore',
  'writerNonce',
  'now',
  'driver',
  'outputSource',
  'caller',
  'party',
] as const satisfies readonly (keyof ExecuteStepOptions)[];
const EXECUTE_CHAIN_MEMBERS = [
  'runId',
  'command',
  'input',
  'dispatcher',
  'registry',
  'stepMeta',
  'trace',
  'traceBufferStore',
  'writerNonce',
  'driver',
  'now',
  'caller',
  'party',
] as const satisfies readonly (keyof ExecuteChainOptions)[];
const EXECUTE_ENGINE_STEP_MEMBERS = [
  'runId',
  'step',
  'run',
  'registry',
  'traceBufferStore',
  'driver',
  'now',
  'caller',
] as const satisfies readonly (keyof ExecuteEngineStepOptions)[];
const ADVANCE_RUN_MEMBERS = [
  'runId',
  'registry',
  'traceBufferStore',
  'driver',
  'now',
  'onStep',
  'onTaken',
  'onNotRecorded',
  'onGuard',
  'caller',
  'command',
  'onExpiry',
] as const satisfies readonly (keyof AdvanceRunOptions)[];
const SUBMIT_HUMAN_RESPONSE_MEMBERS = [
  'runId',
  'gateId',
  'choice',
  'registry',
  'respondedBy',
  'claimToken',
  'now',
  'driver',
  'caller',
] as const satisfies readonly (keyof SubmitGateOptions)[];
const GET_WORKFLOW_FOR_RUN_MEMBERS = [
  'retryVerb',
  'verb',
  'terminalOk',
] as const satisfies readonly (keyof Parameters<typeof getWorkflowForRun>[2])[];
const RECLAIM_STEP_MEMBERS = [
  'traceBufferStore',
  'now',
] as const satisfies readonly (keyof ReclaimStepOptions)[];

const _membersExhaustive: [
  ListsEveryKey<ExecuteStepOptions, typeof EXECUTE_STEP_MEMBERS>,
  ListsEveryKey<ExecuteChainOptions, typeof EXECUTE_CHAIN_MEMBERS>,
  ListsEveryKey<ExecuteEngineStepOptions, typeof EXECUTE_ENGINE_STEP_MEMBERS>,
  ListsEveryKey<AdvanceRunOptions, typeof ADVANCE_RUN_MEMBERS>,
  ListsEveryKey<SubmitGateOptions, typeof SUBMIT_HUMAN_RESPONSE_MEMBERS>,
  ListsEveryKey<Parameters<typeof getWorkflowForRun>[2], typeof GET_WORKFLOW_FOR_RUN_MEMBERS>,
  ListsEveryKey<ReclaimStepOptions, typeof RECLAIM_STEP_MEMBERS>,
] = [true, true, true, true, true, true, true];
void _membersExhaustive;

/**
 * issue #719 (C4, R18 — no shim): the members each entry's options object may carry, derived from
 * its options type (one list per entry, each checked against `keyof` that type above). Any other
 * own enumerable key is refused as "not an option of <entry>" — so an options object written for
 * another release (0.46.0's `advanceRun({ dispatcher, input, … })`) is refused, not silently
 * ignored. The entries that take no options object have no list.
 */
export const OPTION_MEMBERS: Readonly<
  Partial<Record<Entry, { readonly container: string; readonly members: readonly string[] }>>
> = {
  executeStep: { container: 'options', members: EXECUTE_STEP_MEMBERS },
  executeChain: { container: 'options', members: EXECUTE_CHAIN_MEMBERS },
  executeEngineStep: { container: 'options', members: EXECUTE_ENGINE_STEP_MEMBERS },
  advanceRun: { container: 'options', members: ADVANCE_RUN_MEMBERS },
  submitHumanResponse: { container: 'options', members: SUBMIT_HUMAN_RESPONSE_MEMBERS },
  getWorkflowForRun: { container: 'opts', members: GET_WORKFLOW_FOR_RUN_MEMBERS },
  reclaimStep: { container: 'options', members: RECLAIM_STEP_MEMBERS },
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

/** The `expected` phrase of a member that is not an option of the entry. */
const notAnOption = (entry: Entry): string => `not an option of ${entry}`;

/**
 * Every defect of `parts` against the entry's rules, in table order, then every member of its
 * options object that is not an option of the entry, in the object's key order.
 */
export function invalidParts(entry: Entry, parts: Record<string, unknown>): InvalidPart[] {
  const invalid: InvalidPart[] = [];
  for (const rule of REQUIRED_PARTS[entry]) {
    const at = valueAt(parts, rule.path);
    if (at === 'skip') continue;
    const { value } = at;
    const required = typeof rule.required === 'function' ? rule.required(parts) : rule.required;
    if (!required && value === undefined) continue;
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
  const options = OPTION_MEMBERS[entry];
  const container = options !== undefined ? parts[options.container] : undefined;
  if (options !== undefined && isPlainObject(container)) {
    for (const key of Object.keys(container)) {
      if (options.members.includes(key)) continue;
      invalid.push({
        option: `${options.container}.${key}`,
        expected: notAnOption(entry),
        given_type: givenTypeOf(container[key]),
      });
    }
  }
  return invalid;
}

function clause(p: InvalidPart): string {
  if (p.expected.startsWith('not an option of ')) {
    return `${p.option} is ${p.expected} (got ${p.given_type})`;
  }
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
  throw optionInvalidError(entry, invalid);
}

/**
 * issue #719: the ONE `VALIDATION_OPTION_INVALID` builder — the `required_parts` row's, and the
 * store row's for a store that is absent (`undefined` or `null`, C4).
 */
export function optionInvalidError(entry: Entry, invalid: readonly InvalidPart[]): WorkflowError {
  return new WorkflowError(
    `${entry} was called with ${invalid.length} invalid option(s): ${invalid.map(clause).join('; ')}. Nothing was read or written.`,
    {
      code: 'VALIDATION_OPTION_INVALID',
      category: 'VALIDATION',
      agentAction: 'report_to_user',
      retryable: false,
      details: { entry, invalid: [...invalid] },
    },
  );
}
