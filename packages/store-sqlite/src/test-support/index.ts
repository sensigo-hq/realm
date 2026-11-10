// test-support/index.ts — issue #616 PR-2c c9a (DELTAS row 49) and c10b-2b (DELTAS 58e): the package's
// `./test-support` entry. Tests in other workspace packages (the CLI's, the MCP server's) that need a
// second, raw connection on a home's `realm.db`, or a registered copy the store must refuse, import it
// from `@sensigo/realm-store-sqlite/test-support`. It exports exactly two functions and no type: a
// consumer writes `Awaited<ReturnType<typeof openForeignConnection>>` for the connection. The schema
// ladder and the fault seam beside it stay unexported until a test outside the package needs one,
// each addition a DELTAS line. Both helpers open through the package's one loader.
// Test support, not a production API: `test-support-export-616.test.ts` pins this entry and its two
// exports; the CLI's pack cell (`store-sqlite-package-616.test.ts`) pins the files it publishes.
export { openForeignConnection } from './foreign-connection.js';
export { plantRegistryRow } from './plant-registry-row.js';
