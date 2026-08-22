// mcp-server-entry.ts — resolves the path to realm's own MCP server entry point for journey tests
// that spawn it as a real child process.
//
// WHY THIS IS NOT JUST A CONSTANT. The path is only valid once mcp-server has been built, and the
// build is guaranteed by the task graph rather than by anything in this file: `test` dependsOn
// `build`, `build` dependsOn `^build`, and cli depends on `@sensigo/realm-mcp` — so `npm test`
// always has the dist. Running a journey file DIRECTLY after a clean checkout does not, and
// without this check the failure is an ENOENT from `child_process.spawn` several layers down,
// which reads like a broken test rather than a missing build step.
//
// It resolves from THIS FILE rather than the working directory, because vitest's cwd is not
// something a test should depend on.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The built server entry.
 *
 * FOUR `..`: test-support → agent → src → cli → packages. A file one directory shallower needs
 * THREE, so this is exactly the constant that gets miscounted when copied between them — hence
 * the depth pin in this module's tests, which catches the off-by-one while the dist IS built (the
 * symptom otherwise is a confident "not built" message about a path that was never right).
 */
export const DEFAULT_MCP_SERVER_ENTRY = fileURLToPath(
  new URL('../../../../mcp-server/dist/server.js', import.meta.url),
);

/** The message a caller sees when the dist is missing — exported so a test can pin it. */
export const MCP_SERVER_DIST_ABSENT =
  'mcp-server dist not built — run `npm run build` first (turbo guarantees it for `npm test`; running this file directly after a clean checkout does not)';

/**
 * Returns the server entry path, or throws a message that names the actual problem.
 *
 * The candidate is an argument rather than an injectable module-level override, so the check runs
 * at CALL time: a journey cell calls this at module scope and gets the same whole-file failure it
 * would have got from a bad constant, but with a sentence explaining it.
 */
export function resolveMcpServerEntry(candidate: string = DEFAULT_MCP_SERVER_ENTRY): string {
  if (!existsSync(candidate)) {
    throw new Error(`${MCP_SERVER_DIST_ABSENT} (looked for: ${candidate})`);
  }
  return candidate;
}
