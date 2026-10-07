// The vitest global setup that the root `vitest.config.ts` gives every package's own test run.
//
// Tests read BUILT output: the CLI's cells start `realm` from `packages/cli/dist`, and every package
// past core imports the others through their `dist`. A test run therefore needs the build to be the
// build of the source it is testing, and it must never build itself: a build during the run rewrites
// the files that other test processes are loading (a `realm` child once found
// `dist/agent/run-agent.js` empty in the middle of such a rewrite). So the run checks, before any test
// file starts, and refuses to start when the build is older than the source. The check is
// `tsc --build --dry`, which writes nothing.
//
// It fails closed: every line `tsc` prints must say a project is up to date (or that only the
// timestamps of its output would be refreshed, which a build restored from turbo's cache can need),
// and the package's own project must be among them. A project `tsc` would build refuses the run as
// old code; any line it does not recognise refuses it as unconfirmed. Either way the run stops before
// any test starts, with only this message (a thrown error would sit under vitest's own "No test
// files found" lines).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';

const STALE = /^A non-dry build would build project '(.+)'$/;
const CURRENT = [
  /^Project '(.+)' is up to date/,
  /^A non-dry build would update timestamps for output of project '(.+)'$/,
];

export function setup() {
  const pkg = process.cwd();
  const own = join(pkg, 'tsconfig.json');
  if (!existsSync(own)) return;
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  let out;
  try {
    out = execFileSync(process.execPath, [tsc, '--build', '--dry', pkg], { encoding: 'utf8' });
  } catch (err) {
    refuse(
      `Could not check that the build is current: tsc --build --dry exited ${err.status}.`,
      `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n'),
      'Fix what tsc printed, run `npm run build` from the repository root, then run the tests again.',
    );
  }
  // Each line reads "<time> - <message>"; the time's format follows the locale, the separator does not.
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.slice(l.indexOf(' - ') + 3));
  const projects = lines.map((l) =>
    CURRENT.map((r) => r.exec(l)?.[1]).find((p) => p !== undefined),
  );
  const stale = lines.filter((l) => STALE.test(l));
  if (stale.length > 0) {
    refuse(
      'The build is older than the source, so these tests would run old code:',
      stale,
      'Run `npm run build` from the repository root, then run the tests again.',
    );
  }
  if (projects.some((p) => p === undefined) || !projects.includes(own)) {
    refuse(
      `Could not confirm that the build of ${own} is current. tsc --build --dry printed:`,
      lines,
      'Run `npm run build` from the repository root. If this message stays, tsc has new wording and ' +
        'scripts/vitest-build-is-current.mjs must learn it.',
    );
  }
}

function refuse(what, lines, remedy) {
  process.stderr.write(`\n${what}\n${lines.map((l) => `  ${l}`).join('\n')}\n${remedy}\n\n`);
  process.exit(1);
}
