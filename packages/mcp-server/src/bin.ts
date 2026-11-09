#!/usr/bin/env node
// bin.ts — the `realm-mcp` program (issue #616 PR-2a, unit ii-a): realm's MCP server on stdio, over the
// four stores its door (`home.ts`) opens on `~/.realm`. A plain program: importing this file starts
// the server, so nothing imports it; the library is `server.ts`, reached through the package's index.
// npm and npx start it through a bin shim (a symlink); it carries no "was I run as main" check, so a
// symlink runs it as the file itself does.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describeThrown, setClockErrorSink } from '@sensigo/realm';
import { composeBinIdentity } from './bin-identity.js';
import { gateAnswersStartLine, readBinDoorSettings } from './bin-settings.js';
import { openMcpHome } from './home.js';
import { logMasked } from './render-reply.js';
import { REALM_MCP_TAKES_NO_FLAGS, createRealmMcpServer } from './server.js';

if (process.argv.length > 2) {
  console.error(REALM_MCP_TAKES_NO_FLAGS);
  process.exit(1);
}

// Correction 2 (4.1): the variables judged as `realm mcp` judges its flags — a refusal is one line
// naming the variable and exit 1, never a stack trace.
const settings = readBinDoorSettings('realm-mcp', {}, process.env);
if (!settings.ok) {
  console.error(settings.line);
  process.exit(1);
}
// This program's name, which may itself refuse with one line.
const driver = composeBinIdentity();
// #715 (b) (03 §A.1, D-22): the program's waiter-error sink — a waiter on the store's clock that fails
// is one masked line on stderr (stdout carries the protocol). An embedded server sets none: it is a
// library, and core's loud default applies.
setClockErrorSink((err: unknown): void => {
  logMasked(`realm-mcp: ${err instanceof Error ? err.message : String(err)}`);
});
// #627 W (§5.8): the stdio transport authenticates no one, so this program's answers name no
// principal. #616 PR-2c c10b-2: everything the open and the build throw is one masked line on stderr
// and exit 1 — the store's or core's own sentence, never a stack, and nothing on stdout — as
// `realm mcp`'s `hostRefusalLine` does.
let server: ReturnType<typeof createRealmMcpServer>;
try {
  const home = await openMcpHome();
  server = createRealmMcpServer({
    workflowStore: home.workflowStore,
    runStore: home.runStore,
    traceBufferStore: home.traceBufferStore,
    failedAttemptStore: home.failedAttemptStore,
    ...(driver !== undefined ? { driver } : {}),
    principal: { absent: 'door_authenticates_no_principal' },
  });
} catch (err) {
  logMasked(`realm-mcp: ${describeThrown(err).replace(/\s*\n\s*/g, ' ')}`);
  process.exit(1);
}
// The start line — stderr, since stdout carries the protocol — only once the store has opened and the
// server is built: a refusal never follows a "started" line.
console.error(gateAnswersStartLine(settings.answers, false, 'realm-mcp'));
const transport = new StdioServerTransport();
await server.connect(transport);
