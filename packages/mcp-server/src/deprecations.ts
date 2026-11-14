// deprecations.ts — CP-W: the MCP server's deprecation door, one per process however many servers
// the process builds. `warnDeprecated(id)` says the retired thing once per id per process (core's
// said-set, shared with the CLI's door when both run in one process): the line on the server's
// masked stderr (`logMasked`); and, best-effort, the protocol's `notifications/message` (level
// `warning`, logger `realm`, the same text) through the one server registered as the sink — a
// server built with `deprecationNotifications`, which declares the `logging` capability. A raise
// with no sink, or whose sink has no transport connected, gets the stderr line only, never a later
// notification. A deprecation never changes a reply.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  DEPRECATIONS,
  deprecationLine,
  markSaid,
  validateDeprecations,
  type DeprecationEntry,
} from '@sensigo/realm';
import { logMasked, sendWarningLogMasked } from './render-reply.js';

let table: readonly DeprecationEntry[] = DEPRECATIONS;
let sink: McpServer | undefined;

/** The server the door's notification goes through (the last one registered), or none. */
export function setDeprecationSink(server: McpServer | undefined): void {
  sink = server;
}

/**
 * Says the retired thing `id` once in this process. An id not in the table is a programming error:
 * this throws, naming it. It never throws for the notification: the SDK's send is async, and a send
 * before `connect` (or after close) rejects, so the promise is caught here.
 */
export function warnDeprecated(id: string): void {
  const entry = table.find((e) => e.id === id);
  if (entry === undefined)
    throw new Error(`warnDeprecated: ${id} is not in Realm's deprecation table`);
  if (!markSaid(id)) return;
  const line = deprecationLine(entry);
  logMasked(line);
  const server = sink;
  // A courtesy that saves the attempt; the send's own catch is what guarantees no rejection escapes.
  if (server === undefined || !server.isConnected()) return;
  sendWarningLogMasked(server, line);
}

/** A test seam, not a product path: the door reads `entries` in place of the product table until
 *  the returned restore runs. The entries are validated as the product table is. */
export function setDeprecationTableForTests(entries: readonly DeprecationEntry[]): () => void {
  validateDeprecations(entries);
  const before = table;
  table = entries;
  return (): void => {
    table = before;
  };
}
