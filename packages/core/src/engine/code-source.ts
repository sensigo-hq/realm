// code-source.ts — #828 unit 2c: which code an attempt of a step chose, read at the call's own
// lookup, for the attempt's evidence entry (`EvidenceSnapshot.code_source`).
//
// The call functions (`callHandler`, `callAdapter`) fill the attempt's slot right after their lookup,
// before any input mapping, wait or call, so every way the attempt ends mints it: a return, a throw,
// a `STEP_TIMEOUT` from `withTimeout`'s timer, and the branches that chose code and failed before it
// ran. Pure: nothing here runs the host's code or reads a file.
import type { CodeSource, StepCodeSource } from '../types/code-source.js';
import { codeTextOf } from '../extensions/code-text.js';
import { replacesBuiltIn } from '../extensions/built-in-requirements.js';
import { VERSION } from '../version.js';
import type { codeRequirementForStep } from './capability.js';

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
