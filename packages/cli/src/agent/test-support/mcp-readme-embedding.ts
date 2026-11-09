// mcp-readme-embedding.ts — #616 PR-2c c10b-2: DELTAS 58c and 58e (a release gate), closed by c10b-3.

/**
 * The one cell that uses this runs `@sensigo/realm-mcp`'s README program, which still builds a
 * `JsonFileStore` on the CLI helper's SQLite home and meets the store's fence until c10b-3 rewrites
 * the README to the home entry. The skip is the only change to that cell. c10b-3a's FIRST step deletes
 * this constant, so `tsc` fails at its site and it cannot stay dark.
 */
export const MCP_README_EMBEDDING_UNTIL_C10B3 = true;
