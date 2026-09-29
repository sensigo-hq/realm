#!/usr/bin/env node
// scripts/publish-guard.mjs — issue #620 PR-A (D5). Run from a package directory inside a
// publish step (`node ../../scripts/publish-guard.mjs`): decides whether this commit should
// publish, skip (a re-run after a partial release: this exact commit is already published), or
// refuse (a different commit already holds this version — a version names one artifact).
//
// Keys on the commit npm records as `gitHead`, never on the tarball's bytes: a re-run after the
// build artifact's one-day retention expires rebuilds from source, and a non-reproducible byte
// difference between the two builds would otherwise force a new version for no real reason.
//
// Usage: node ../../scripts/publish-guard.mjs [--fixture <file>]
// `--fixture <file>` swaps the registry read for a canned result (the #326
// `--resolver-fixture` precedent): it replaces the DATA SOURCE, never a check. The file is JSON:
// `{ "exitCode": 0 | 1, "stdout": "…", "stderr": "…" }`, exactly what a real `npm view … --json`
// call would have produced.

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const fixtureIdx = args.indexOf('--fixture');
const fixturePath = fixtureIdx !== -1 ? args[fixtureIdx + 1] : null;

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const { name, version } = pkg;

const head = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout.trim();

function readRegistry() {
  if (fixturePath !== null) {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
    return {
      exitCode: fixture.exitCode,
      stdout: fixture.stdout ?? '',
      stderr: fixture.stderr ?? '',
    };
  }
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'gitHead', '--json'], {
    encoding: 'utf-8',
  });
  return { exitCode: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function firstNonEmptyLine(...texts) {
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (line.trim().length > 0) return line;
    }
  }
  return '(no output)';
}

const { exitCode, stdout, stderr } = readRegistry();

if (exitCode !== 0) {
  // npm view failed. E404 (the version, or the whole package, is not published) means it is
  // safe to publish; npm writes the E404 error object as JSON on STDOUT (verified against the
  // real registry). Any other failure is unreadable, so refuse rather than guess.
  let isE404 = false;
  try {
    const parsed = JSON.parse(stdout);
    if (parsed?.error?.code === 'E404') isE404 = true;
  } catch {
    // stdout was not the expected JSON error object: fall through to the generic refusal.
  }
  if (isE404) {
    console.log('publish');
    process.exit(0);
  }
  const line = firstNonEmptyLine(stderr, stdout);
  console.error(
    `::error::Cannot read ${name}@${version} from the registry: ${line}. Re-run the workflow.`,
  );
  process.exit(1);
}

// npm view succeeded: the version IS published. What commit does the registry record for it?
const trimmed = stdout.trim();
if (trimmed === '') {
  console.error(
    `::error::${name}@${version} is already published, and the registry records no commit for it. Release a new version.`,
  );
  process.exit(1);
}
const recordedSha = JSON.parse(trimmed);
if (recordedSha === head) {
  console.error(`::notice::${name}@${version} is already published from ${recordedSha}; skipping.`);
  console.log('skip');
  process.exit(0);
}
console.error(
  `::error::${name}@${version} is already published from ${recordedSha}, not from this commit ${head}. A version names one artifact: release a new version.`,
);
process.exit(1);
