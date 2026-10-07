// The vitest global setup that the root `vitest.config.mts` gives every package's own test run.
//
// Tests read BUILT output: the CLI's cells start `realm` from `packages/cli/dist`, and the packages'
// tests import each other through their `dist` (core's tests load realm-testing's, which core cannot
// declare as a dependency). A test run therefore needs the whole build to be the build of the source
// it is testing, and it must never build itself: a build during the run rewrites the files that other
// test processes are loading (a `realm` child once found `dist/agent/run-agent.js` empty in the middle
// of such a rewrite). So every run checks every package, before any test file starts, and refuses to
// start when a build is older than its source. The check is `tsc --build --dry`, which writes nothing.
// turbo runs every test task after all four builds (turbo.json), so `npm test` always passes it.
//
// It fails closed. Every package under packages/ must be reported as up to date (or as needing only
// the timestamps of its output refreshed, which a build restored from turbo's cache can need). A
// package `tsc` would build refuses the run as old code; a line it does not recognise, or a package
// it does not report, refuses it as unconfirmed. Either way the run stops before any test starts,
// with only this message (a thrown error would sit under vitest's own "No test files found" lines).
//
// What it cannot see: it reads tsc's bookkeeping and timestamps, not the built files themselves. A
// built file emptied by a killed build, or one left behind by a deleted source file, passes it; so
// does a source file copied in with an older timestamp. Deleting packages/*/dist and running
// `npm run build` rebuilds from nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

const STALE = /^A non-dry build would build project '(.+)'$/;
const CURRENT = [
  /^Project '(.+)' is up to date/,
  /^A non-dry build would update timestamps for output of project '(.+)'$/,
];
const REMEDY = 'Run `npm run build` from the repository root, then run the tests again.';

export function setup() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const packages = join(root, 'packages');
  const projects = (existsSync(packages) ? readdirSync(packages) : [])
    .map((name) => join(packages, name, 'tsconfig.json'))
    .filter((p) => existsSync(p));
  if (projects.length === 0) {
    refuse(`Found no package to check under ${packages}.`, [], REMEDY);
  }
  let out;
  try {
    const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    out = execFileSync(process.execPath, [tsc, '--build', '--dry', ...projects], {
      encoding: 'utf8',
    });
  } catch (err) {
    const how = err.status === undefined ? err.message : `tsc --build --dry exited ${err.status}`;
    refuse(
      `Could not check that the build is current: ${how}.`,
      `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n'),
      'Fix what is printed above, then run `npm run build` from the repository root and the tests again.',
    );
  }
  // Each line reads "<time> - <message>"; the time's format follows the locale, the separator does not.
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.slice(l.indexOf(' - ') + 3));
  const stale = lines.filter((l) => STALE.test(l));
  if (stale.length > 0) {
    refuse('The build is older than the source, so these tests would run old code:', stale, REMEDY);
  }
  // tsc prints paths with forward slashes on every platform; compare them that way.
  const slash = (p) => p.replaceAll('\\', '/');
  const current = new Set();
  const unknown = [];
  for (const l of lines) {
    const p = CURRENT.map((r) => r.exec(l)?.[1]).find((m) => m !== undefined);
    if (p === undefined) unknown.push(l);
    else current.add(slash(p));
  }
  const unreported = projects.filter((p) => !current.has(slash(p)));
  if (unknown.length > 0 || unreported.length > 0) {
    refuse(
      'Could not confirm that the build is current. tsc --build --dry printed:',
      [...lines, ...unreported.map((p) => `(no line for ${p})`)],
      `${REMEDY} If this message stays, tsc has new wording and scripts/vitest-build-is-current.mjs must learn it.`,
    );
  }
}

function refuse(what, lines, remedy) {
  process.stderr.write(`\n${what}\n${lines.map((l) => `  ${l}`).join('\n')}\n${remedy}\n\n`);
  process.exit(1);
}
