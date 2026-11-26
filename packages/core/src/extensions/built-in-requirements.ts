// built-in-requirements.ts — issue #923 (PR0-CONTRACT Amendment 26): the ONE table of Realm's
// config-less built-ins, the handler and adapter every Realm program's registry starts with.
//
// `createDefaultRegistry()` registers under these names, so the table and the registry cannot name
// different things. Every Realm door builds its registry from `createDefaultRegistry()` (the CLI's
// loader, `load-project-extensions.ts`; core's own fallback when a caller passes none), so a built-in
// is never code a project must supply: an observer's `advance` way (`ways.ts`, decision C33) does not
// make it a condition. Data, and the one predicate that says whether an entry replaces a built-in
// (#828 unit 2b).
import type { CodeSource } from '../types/code-source.js';

/** Adapter `filesystem`: reads files from the local filesystem; needs no configuration. */
export const BUILT_IN_FILESYSTEM_ADAPTER = { kind: 'adapter', name: 'filesystem' } as const;

/** Handler `check_quotes` (issue #760): records how each extracted value's quote was found in its source. */
export const BUILT_IN_CHECK_QUOTES_HANDLER = { kind: 'handler', name: 'check_quotes' } as const;

/** The built-ins, one row each: what every Realm program's registry has before any project code. */
export const BUILT_IN_REQUIREMENTS: readonly {
  readonly kind: 'handler' | 'adapter';
  readonly name: string;
}[] = [BUILT_IN_FILESYSTEM_ADAPTER, BUILT_IN_CHECK_QUOTES_HANDLER];

/** Whether `kind` `name` is one of Realm's built-ins (in every program's registry). */
export function isBuiltInRequirement(kind: 'handler' | 'adapter', name: string): boolean {
  return BUILT_IN_REQUIREMENTS.some((r) => r.kind === kind && r.name === name);
}

/**
 * Whether a registry entry under `kind` `name` with `source` replaces one of Realm's built-ins: the
 * name is a built-in's, and the code is neither Realm's own (`built_in`) nor the catalog's entry of
 * that name. It decides from the name and the source, never from what the registry held before. No
 * processor is a built-in (#828 unit 2b; R13: the one rule, which the CLI's loader also uses).
 */
export function replacesBuiltIn(
  kind: 'handler' | 'adapter' | 'processor',
  name: string,
  source: CodeSource,
): boolean {
  if (kind === 'processor' || !isBuiltInRequirement(kind, name)) return false;
  if (source.source === 'built_in') return false;
  return !(source.source === 'catalog' && source.use === name);
}
