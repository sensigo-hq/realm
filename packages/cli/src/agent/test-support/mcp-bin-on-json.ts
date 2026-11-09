// mcp-bin-on-json.ts — #616 PR-2c c10a-3a: DELTAS 57 (a release gate), closed by c10b.

/**
 * The cells that use this start the `realm-mcp` bin on a home the CLI opened on SQLite. The bin builds
 * JSON stores until c10b and fails at the store's fence (`EEXIST … workflows`); that loud failure is
 * the honest state, and nothing makes the bin work on a SQLite home before c10b. The skip is the only
 * change to those cells. c10b's FIRST step deletes this constant, so `tsc` fails at every site and
 * none can stay dark.
 */
export const MCP_BIN_ON_JSON_UNTIL_C10B_DELTAS_57 = true;
