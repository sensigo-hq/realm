// issue #620 PR-C: the hand-off check every published tool handler runs first. A host may call a
// handler directly, without `createRealmMcpServer` (bradley-max's reader does), so the check lives
// at the handler's entry, before the handler defaults any store. Core composes every refusal; this
// file only names the store and the handler.
import { assertReleaseLine, WorkflowError } from '@sensigo/realm';

/** The stores a tool handler may be handed. Absent ones are realm's own defaults: not checked. */
export interface ToolStores {
  workflowStore?: unknown;
  runStore?: unknown;
  traceBufferStore?: unknown;
  failedAttemptStore?: unknown;
}

const ROLE_NAMES: ReadonlyArray<readonly [keyof ToolStores, string]> = [
  ['workflowStore', 'the workflow store'],
  ['runStore', 'the run store'],
  ['traceBufferStore', 'the trace buffer'],
  ['failedAttemptStore', 'the failed-attempt store'],
];

/**
 * Checks every store a host injected into `handlerName`: each must carry this realm's release
 * line. Throws core's `ENGINE_RELEASE_LINE_UNDECLARED` / `ENGINE_RELEASE_LINE_MISMATCH`.
 */
export function assertToolStores(stores: ToolStores | undefined, handlerName: string): void {
  if (stores === undefined) return;
  for (const [field, name] of ROLE_NAMES) {
    const value = stores[field];
    if (value !== undefined) assertReleaseLine(value, `${name} handed to ${handlerName}`);
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
