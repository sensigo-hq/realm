#!/usr/bin/env node
// bin.ts — the `realm-mcp` program (issue #616 PR-2a, unit ii-a): realm's MCP server on stdio, over the
// four stores its opener (`home.ts`) builds on `~/.realm`. A plain program: importing this file starts
// the server, so nothing imports it; the library is `server.ts`, reached through the package's index.
// npm and npx start it through a bin shim (a symlink); it carries no "was I run as main" check, so a
// symlink runs it as the file itself does.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { setClockErrorSink } from '@sensigo/realm';
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
// naming the variable and exit 1, never a stack trace; then the start line, on stderr (stdout carries
// the protocol), before anything is built.
const settings = readBinDoorSettings('realm-mcp', {}, process.env);
if (!settings.ok) {
  console.error(settings.line);
  process.exit(1);
}
// This program's name, which may itself refuse with one line — then no start line is printed.
const driver = composeBinIdentity();
console.error(gateAnswersStartLine(settings.answers, false, 'realm-mcp'));
// #715 (b) (03 §A.1, D-22): the program's waiter-error sink — a waiter on the store's clock that fails
// is one masked line on stderr (stdout carries the protocol). An embedded server sets none: it is a
// library, and core's loud default applies.
setClockErrorSink((err: unknown): void => {
  logMasked(`realm-mcp: ${err instanceof Error ? err.message : String(err)}`);
});
// #627 W (§5.8): the stdio transport authenticates no one, so this program's answers name no
// principal. #715 (a) correction 1 (C-6): a run store opened on a copy of a test location refuses with
// one line on stderr, masked for a log as `realm mcp`'s line is, and exit 1 — never Node's crash dump,
// and nothing on stdout. #616 PR-2a (i): an unusable home (`STATE_HOME_UNUSABLE`) the same way. #616
// PR-2a (ii-a): both are thrown by the opener now (the home's path, then the run store's clock read),
// so the opener sits inside this catch. Any other error escapes as before. Read by its code, never
// `instanceof`.
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
  const code = (err as { code?: unknown } | null)?.code;
  if (code !== 'STATE_TEST_CLOCK_FOREIGN' && code !== 'STATE_HOME_UNUSABLE') throw err;
  logMasked(`realm-mcp: ${(err as Error).message}`);
  process.exit(1);
}
const transport = new StdioServerTransport();
await server.connect(transport);
