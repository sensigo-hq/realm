// below-floor.mjs — issue #616 PR-1a unit 11: what CI's below-floor legs run, on a Node whose built-in
// SQLite has the WAL-reset bug (Node 22.22.2 and 24.14.1 bundle SQLite 3.51.2; the fix is 3.51.3). It
// checks two things through the package's entry, and exits 1 when either differs:
//   1. the SQLite version this Node reports is below the store's floor, 3.51.3 (so the leg checks
//      something: a Node at or above the floor would open the home and this check would fail);
//   2. `openRealmHome` refuses with STATE_STORE_DRIVER_UNAVAILABLE, naming this Node and that SQLite
//      version, and makes nothing: the home's folder does not exist after the refusal.
// It prints what it saw. Run it after building the package and core:
//   npx turbo run build --filter=@sensigo/realm-store-sqlite
//   node packages/store-sqlite/ci/below-floor.mjs
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRealmHome } from '@sensigo/realm-store-sqlite';

/** SQLite's first release with the WAL-reset fix on the 3.51 line. */
const FLOOR = [3, 51, 3];

/** Whether a SQLite version (three numbers) is below the floor; `false` when it is not three numbers. */
function belowFloor(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version));
  if (parts === null) return false;
  for (let i = 0; i < 3; i += 1) {
    const n = Number(parts[i + 1]);
    if (n !== FLOOR[i]) return n < FLOOR[i];
  }
  return false;
}

const reported = process.versions.sqlite;
const dir = mkdtempSync(join(tmpdir(), 'realm-616-below-floor-'));
const home = join(dir, '.realm');
let outcome;
try {
  (await openRealmHome({ home })).close();
  outcome = 'opened';
} catch (err) {
  outcome = { code: err?.code, details: err?.details, message: err?.message };
}
const seen = {
  node: process.version,
  reported,
  belowFloor: belowFloor(reported),
  outcome,
  homeMade: existsSync(home),
};
rmSync(dir, { recursive: true, force: true });

const failures = [];
if (!seen.belowFloor) {
  failures.push(`this Node reports SQLite ${reported}, which is not below ${FLOOR.join('.')}`);
}
if (outcome === 'opened' || outcome.code !== 'STATE_STORE_DRIVER_UNAVAILABLE') {
  failures.push('openRealmHome did not refuse with STATE_STORE_DRIVER_UNAVAILABLE');
} else if (outcome.details?.sqlite !== reported || outcome.details?.node !== process.version) {
  failures.push(
    "the refusal's details do not name this Node and the SQLite version it reports (details.node, details.sqlite)",
  );
}
if (outcome !== 'opened' && seen.homeMade) failures.push('the home was made before the refusal');

console.log(JSON.stringify(seen, null, 2));
if (failures.length > 0) {
  for (const failure of failures) console.error(`below-floor check FAILED: ${failure}`);
  process.exit(1);
}
console.log(
  `below-floor check passed: Node ${process.version} reports SQLite ${reported} and the store refused it.`,
);
