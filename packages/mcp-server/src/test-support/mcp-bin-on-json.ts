// mcp-bin-on-json.ts — #616 PR-2c c10a-3a: DELTAS 57 (a release gate), closed by c10b. A twin of the
// CLI's constant of the same name (that file is not importable from this package).

/**
 * The cells that use this pair the SQLite CLI with this package's JSON stores on one `.realm`: the
 * CLI refuses the home that holds the JSON store's folders (`STATE_HOME_HOLDS_LEGACY_STORE`), and that
 * loud refusal is the honest state; nothing makes the two work on one home before c10b. The skip is
 * the only change to those cells. c10b's FIRST step deletes this constant, so `tsc` fails at every
 * site and none can stay dark.
 */
export const MCP_BIN_ON_JSON_UNTIL_C10B_DELTAS_57 = true;
