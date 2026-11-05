// issue #620 PR-C: the hand-off check every published tool handler runs first. A host may call a
// handler directly, without `createRealmMcpServer` (bradley-max's reader does), so the check lives
// at the handler's entry. #616 PR-2a (ii-b): no handler builds a store any more, so the check also
// refuses, by name, a store the handler needs and was not given — before any store is read. One
// order, the factory's: the stores given are judged by their release line first; a store not given
// (absent, `undefined` or `null`) is skipped by that loop — so it never meets the release-line
// sentence ("declares no realm release line") — and is then named. Core composes the release-line
// refusals; this file names the stores and the handler.
import { assertReleaseLine, WorkflowError } from '@sensigo/realm';

/** The stores a tool handler may be handed. Each handler requires the ones it reads; an absent
 *  `null` or `undefined` member is "not given". */
export interface ToolStores {
  workflowStore?: unknown;
  runStore?: unknown;
  traceBufferStore?: unknown;
  failedAttemptStore?: unknown;
}

/** A store's option name. */
export type StoreName = keyof ToolStores;

/** The four stores in the order every refusal names them (the order a host passes them in). */
export const STORE_ORDER: readonly StoreName[] = [
  'runStore',
  'workflowStore',
  'traceBufferStore',
  'failedAttemptStore',
];

/** Store names joined for a refusal: `a`, `a or b`, `a, b or c` (or with `and`). */
export function joinStoreNames(names: readonly string[], conjunction: 'or' | 'and' = 'or'): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names[names.length - 1]}`;
}

const ROLE_NAMES: ReadonlyArray<readonly [StoreName, string]> = [
  ['workflowStore', 'the workflow store'],
  ['runStore', 'the run store'],
  ['traceBufferStore', 'the trace buffer'],
  ['failedAttemptStore', 'the failed-attempt store'],
];

/**
 * The check every published tool handler runs first, before anything is read or written. (1) Every
 * store given must carry this realm's release line — core's `ENGINE_RELEASE_LINE_UNDECLARED` /
 * `ENGINE_RELEASE_LINE_MISMATCH`. (2) Every store in `required` must be given — else
 * `VALIDATION_OPTION_INVALID`, naming the handler and each missing store (an absent `stores` object
 * misses every required member).
 */
export function assertToolStores(
  stores: ToolStores | undefined,
  handlerName: string,
  required: readonly StoreName[],
): void {
  if (stores != null) {
    for (const [field, name] of ROLE_NAMES) {
      const value = stores[field];
      if (value != null) assertReleaseLine(value, `${name} handed to ${handlerName}`);
    }
  }
  const missing = STORE_ORDER.filter((name) => required.includes(name) && stores?.[name] == null);
  if (missing.length > 0) {
    const needed = STORE_ORDER.filter((name) => required.includes(name));
    throw new WorkflowError(
      `${handlerName}: no ${joinStoreNames(missing)} was given. Nothing was read or written. Pass the stores the server passes to this handler — ${joinStoreNames(needed, 'and')} — or call the tool through createRealmMcpServer.`,
      {
        code: 'VALIDATION_OPTION_INVALID',
        category: 'VALIDATION',
        agentAction: 'report_to_user',
        retryable: false,
        details: { missing },
      },
    );
  }
}

/**
 * The stores objects a registered MCP tool (`registerX`) hands its handler (issue #620 PR-C round
 * 4). A registry a host's `registryProvider` returns through one of them is named by the tool the
 * MCP caller called and its source — never by the handler's internal name.
 */
const SERVED_BY_A_TOOL = new WeakSet<object>();

/** Marks the stores a registered MCP tool hands its handler (see {@link registryRole}). */
export function markServedByTool(stores: object | undefined): void {
  if (stores !== undefined) SERVED_BY_A_TOOL.add(stores);
}

/**
 * The role a registry refusal names. When the MCP server's tool resolved the registry from the
 * host's `registryProvider`: `the registry the server's registry provider returned for <tool>`.
 * Otherwise (a registry handed to a published handler directly): `the registry handed to
 * <handler>`.
 */
export function registryRole(
  stores: { registryProvider?: unknown } | undefined,
  toolName: string,
  handlerName: string,
): string {
  return stores !== undefined &&
    stores.registryProvider !== undefined &&
    SERVED_BY_A_TOOL.has(stores)
    ? `the registry the server's registry provider returned for ${toolName}`
    : `the registry handed to ${handlerName}`;
}

/** True for the two hand-off refusals: a catch that files or discards errors must rethrow these. */
export function isReleaseLineRefusal(err: unknown): boolean {
  return (
    err instanceof WorkflowError &&
    (err.code === 'ENGINE_RELEASE_LINE_MISMATCH' || err.code === 'ENGINE_RELEASE_LINE_UNDECLARED')
  );
}
