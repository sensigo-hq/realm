// code-source.ts — #828 unit 2c: which code an attempt of a step chose, read at the call's own
// lookup, for the attempt's evidence entry (`EvidenceSnapshot.code_source`). Unit 2d: the one reader
// of that field, `codeSourceOf`, which gives an entry's code source or why the record has none.
//
// The call functions (`callHandler`, `callAdapter`) fill the attempt's slot right after their lookup,
// before any input mapping, wait or call, so every way the attempt ends mints it: a return, a throw,
// a `STEP_TIMEOUT` from `withTimeout`'s timer, and the branches that chose code and failed before it
// ran. Pure: nothing here runs the host's code or reads a file.
import type { CodeSource, StepCodeSource } from '../types/code-source.js';
import type { EvidenceSnapshot } from '../types/run-record.js';
import type { StepDefinition, WorkflowDefinition } from '../types/workflow-definition.js';
import { codeTextOf } from '../extensions/code-text.js';
import { replacesBuiltIn } from '../extensions/built-in-requirements.js';
import { VERSION } from '../version.js';
import { codeRequirementForStep } from './capability.js';

/** One attempt's slot: the code it chose, set at the lookup and read when its entry is minted. */
export interface ChosenCodeSlot {
  code: StepCodeSource | undefined;
}

/**
 * A new attempt's slot. For a step that runs code (`codeRequirementForStep`), it holds
 * `not_looked_up` until the call's lookup replaces it; for any other step, nothing.
 */
export function chosenCodeSlot(
  requirement: ReturnType<typeof codeRequirementForStep>,
): ChosenCodeSlot {
  if (requirement === undefined) return { code: undefined };
  return {
    code: {
      absent: 'not_looked_up',
      kind: requirement.kind,
      ...(requirement.name !== undefined ? { name: requirement.name } : {}),
      ...(requirement.kind === 'adapter' ? { service: requirement.service } : {}),
    },
  };
}

/** The lookup found nothing under `name`. */
export function notRegisteredCode(
  kind: 'handler' | 'adapter',
  name: string,
  service?: string,
): StepCodeSource {
  return { absent: 'not_registered', kind, name, ...(service !== undefined ? { service } : {}) };
}

/**
 * A duck-typed registry's objects (#719 admits a registry with only the four methods), each
 * fingerprinted at first sight and never again: a handler that gives itself a function on first use
 * keeps one fingerprint (notes-for-2b-2c, 828-RD2A-11).
 */
const DUCK_SOURCES = new WeakMap<object, CodeSource>();

function duckSourceOf(impl: unknown): CodeSource {
  const keyed = (typeof impl === 'object' && impl !== null) || typeof impl === 'function';
  const held = keyed ? DUCK_SOURCES.get(impl as object) : undefined;
  if (held !== undefined) return held;
  const source: CodeSource = Object.freeze({ source: 'host_registered', ...codeTextOf(impl) });
  if (keyed) DUCK_SOURCES.set(impl as object, source);
  return source;
}

/**
 * The source the registry's own entry gives `impl`: read through `entry()` when the registry has
 * it, and only when that entry holds the very object the lookup returned. `undefined` otherwise, a
 * throw from `entry()` included: the call never fails for its record's sake.
 */
function entrySourceOf(
  registry: unknown,
  kind: 'handler' | 'adapter',
  name: string,
  impl: unknown,
): CodeSource | undefined {
  const read = (registry as { entry?: unknown } | null | undefined)?.entry;
  if (typeof read !== 'function') return undefined;
  try {
    const held = Reflect.apply(read, registry, [kind, name]) as
      { readonly impl?: unknown; readonly source?: unknown } | null | undefined;
    if (held === null || held === undefined || held.impl !== impl) return undefined;
    const source = held.source;
    return typeof source === 'object' &&
      source !== null &&
      typeof (source as { source?: unknown }).source === 'string'
      ? (source as CodeSource)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The code a call chose: `impl`, which `registry`'s lookup returned under `kind` `name` (the same
 * registry the call ran from, its default-registry fallback included). Its source is the registry
 * entry's, or, for a duck-typed registry, `host_registered` with the fingerprint of `impl`.
 * `realm_version` is set only for Realm's own code that replaced no built-in; `replaces_built_in`
 * only when it did (2b's `replacesBuiltIn`: a duck's code is never Realm's).
 */
export function chosenCodeOf(
  registry: unknown,
  kind: 'handler' | 'adapter',
  name: string,
  impl: unknown,
  service?: string,
): StepCodeSource {
  const from = entrySourceOf(registry, kind, name, impl) ?? duckSourceOf(impl);
  const replaces = replacesBuiltIn(kind, name, from);
  const realms = !replaces && (from.source === 'built_in' || from.source === 'catalog');
  return {
    kind,
    name,
    ...(service !== undefined ? { service } : {}),
    from,
    ...(realms ? { realm_version: VERSION } : {}),
    ...(replaces ? { replaces_built_in: true as const } : {}),
  };
}

/**
 * Why an evidence entry gives no code source (`codeSourceOf`'s `absent_cause`). The first that holds,
 * in this order:
 *  - `unreadable`: the entry carries `code_source`, but not in a form this Realm reads: a malformed
 *    value, or a form or member a newer Realm added;
 *  - `not_a_code_entry`: no code made the entry: a gate's answer or expiry (`kind: 'gate_response'`),
 *    a reclaim or take-back (`output_summary.reclaimed`), a compensating un-claim
 *    (`output_summary.compensating_unclaim`), an operator's void of a finalizer
 *    (`output_summary.voided` with `provenance: 'operator'`), a gate cancelled by another step's abort
 *    (`output_summary.gate_cancelled_by_abort`), a default settle (`diagnostics.settled_by_default`),
 *    or a guard's pass or abort (`diagnostics.guard_conditions`);
 *  - `definition_unavailable`: the workflow is not at hand: none was given, it has no `steps`, or no
 *    step by the entry's name, or that step is not an object;
 *  - `not_a_code_step`: the step runs no handler or adapter: an agent step, a bare `auto` step, a guard,
 *    a finalizer with no handler;
 *  - `predates_code_source`: a code step's entry with no field and no marker: written before the field
 *    existed, or by a store that does not keep it. It says nothing about when, or by which version.
 * @beta
 */
export const CODE_SOURCE_ABSENT_CAUSES = [
  'unreadable',
  'not_a_code_entry',
  'definition_unavailable',
  'not_a_code_step',
  'predates_code_source',
] as const;
/**
 * Why an evidence entry gives no code source (`codeSourceOf`'s `absent_cause`).
 * @beta
 */
export type CodeSourceAbsentCause = (typeof CODE_SOURCE_ABSENT_CAUSES)[number];

/** One closed form: each member it declares, whether it is required, and the test its value meets. */
type Form = ReadonlyMap<string, readonly [required: boolean, test: (value: unknown) => boolean]>;

const form = (members: Record<string, readonly [boolean, (value: unknown) => boolean]>): Form =>
  new Map(Object.entries(members));
const required = (test: (value: unknown) => boolean) => [true, test] as const;
const optional = (test: (value: unknown) => boolean) => [false, test] as const;
const isString = (value: unknown): boolean => typeof value === 'string';
const isHex64 = (value: unknown): boolean =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const exactly =
  (word: unknown) =>
  (value: unknown): boolean =>
    value === word;
const oneOf =
  (...words: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === 'string' && words.includes(value);

const VIA = oneOf('manifest', 'extensions_file', 'override_flag', 'host_stated');
const PROJECT = {
  source: required(exactly('project')),
  declared: required(isString),
  via: required(VIA),
};
/** `CodeSource`'s six forms, member by member. */
const FROM_FORMS: readonly Form[] = [
  form({ source: required(exactly('built_in')) }),
  form({ source: required(exactly('catalog')), use: required(isString) }),
  form({ ...PROJECT, entry_hash: required(isHex64), folder_tree_hash: required(isHex64) }),
  form({ ...PROJECT, absent: required(exactly('hashes_unavailable')) }),
  form({ source: required(exactly('host_registered')), code_text_sha256: required(isHex64) }),
  form({
    source: required(exactly('host_registered')),
    absent: required(exactly('code_text_unavailable')),
  }),
];
const KIND = oneOf('handler', 'adapter');
/** `StepCodeSource`'s three forms, member by member. */
const STEP_FORMS: readonly Form[] = [
  form({
    kind: required(KIND),
    name: required(isString),
    service: optional(isString),
    from: required((value) => readsAs(value, FROM_FORMS)),
    realm_version: optional(isString),
    replaces_built_in: optional(exactly(true)),
  }),
  form({
    absent: required(exactly('not_registered')),
    kind: required(KIND),
    name: required(isString),
    service: optional(isString),
  }),
  form({
    absent: required(exactly('not_looked_up')),
    kind: required(KIND),
    name: optional(isString),
    service: optional(isString),
  }),
];

/**
 * Whether `value` is a plain object that one of `forms` holds exactly: every member it carries is
 * declared by that form and meets its test, and every required member is there. Its members are what
 * a store keeps: its own enumerable keys whose value is not `undefined`.
 */
function readsAs(value: unknown, forms: readonly Form[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const members = new Map(Object.entries(value).filter(([, member]) => member !== undefined));
  return forms.some((one) => {
    for (const key of members.keys()) if (!one.has(key)) return false;
    for (const [key, [needed, test]] of one) {
      const member = members.get(key);
      if (member === undefined ? needed : !test(member)) return false;
    }
    return true;
  });
}

/** Whether the field is in a form this Realm reads; a value whose read throws is not. */
function readableCodeSource(value: unknown): value is StepCodeSource {
  try {
    return readsAs(value, STEP_FORMS);
  } catch {
    return false;
  }
}

/** The member `key` of `value` when `value` is an object, else `undefined`. */
const memberOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** Whether the entry carries a marker of an entry no code made (`not_a_code_entry`). */
function madeByNoCode(
  entry: Pick<EvidenceSnapshot, 'kind' | 'output_summary' | 'diagnostics'>,
): boolean {
  const said = (key: string) => memberOf(entry.output_summary, key);
  const diagnosed = (key: string) => memberOf(entry.diagnostics, key);
  return (
    entry.kind === 'gate_response' ||
    said('reclaimed') === true ||
    said('compensating_unclaim') === true ||
    (said('voided') === true && said('provenance') === 'operator') ||
    said('gate_cancelled_by_abort') === true ||
    diagnosed('settled_by_default') === true ||
    diagnosed('guard_conditions') !== undefined
  );
}

/**
 * Which code made an evidence entry: its `code_source`, or why the record has none. It returns
 * `{ source }`, the field exactly as recorded (its own `not_registered` and `not_looked_up`
 * included), or `{ absent_cause }`, the first `CODE_SOURCE_ABSENT_CAUSES` member that holds.
 * `definition` is the run's workflow, when the reader has it. `definition` must be the run's own
 * workflow; another version can give a wrong cause.
 *
 * @remarks
 * It reads only the forms `StepCodeSource` declares, member by member: any member, word or form it
 * does not declare, at either level, makes it answer `unreadable`, never a guess. A later Realm that
 * adds even an informative member accepts that older readers say `unreadable` for those entries; one
 * that changes what the other members mean writes a new form, never an added member, so a reader that
 * skips unknown members is not misled either. A new kind of entry no code made, on a step that runs
 * code, carries a `code_source` form this reader does not read (so older readers say `unreadable`),
 * never a new marker alone; the field then also appears on an entry that is not an attempt, and such
 * a form names no code.
 *
 * It reads no file and runs none of the host's code. Given a record's data and a workflow definition
 * the types allow, it never throws.
 * @beta
 */
export function codeSourceOf(
  entry: Pick<
    EvidenceSnapshot,
    'step_id' | 'kind' | 'output_summary' | 'diagnostics' | 'code_source'
  >,
  definition: Pick<WorkflowDefinition, 'steps' | 'services'> | undefined,
): { source: StepCodeSource } | { absent_cause: CodeSourceAbsentCause } {
  const field: unknown = entry.code_source;
  if (field !== undefined) {
    return readableCodeSource(field) ? { source: field } : { absent_cause: 'unreadable' };
  }
  if (madeByNoCode(entry)) return { absent_cause: 'not_a_code_entry' };
  const steps: unknown = definition?.steps;
  if (definition === undefined || typeof steps !== 'object' || steps === null) {
    return { absent_cause: 'definition_unavailable' };
  }
  const step = Object.hasOwn(steps, entry.step_id) ? memberOf(steps, entry.step_id) : undefined;
  if (typeof step !== 'object' || step === null) return { absent_cause: 'definition_unavailable' };
  return codeRequirementForStep(entry.step_id, step as StepDefinition, definition) === undefined
    ? { absent_cause: 'not_a_code_step' }
    : { absent_cause: 'predates_code_source' };
}
