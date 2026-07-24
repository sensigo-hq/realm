#!/usr/bin/env node
// issue #238 PR2 (D4) — files or updates the tracking issue for the tier-2 weekly scheduled
// audit. Invoked ONLY when the tier-2 audit step itself failed (an advisory was found) — see
// `.github/workflows/scheduled-audit.yml`'s `steps.audit.outcome == 'failure'` gate, which keeps
// a failed `npm ci`/guard step from filing a spurious "advisories found" issue.
//
// Dedup by a STABLE title: an open issue with that title gets a comment (the new run's evidence),
// never a duplicate issue. Uses `--body-file`, NEVER inline `--body`, so the captured audit
// output (arbitrary text, potentially containing shell-special characters) can never corrupt the
// `gh` invocation via shell-quoting.
//
// DRY_RUN=1: the dedup lookup (a read-only `gh issue list`) still runs for real — it's needed to
// print the CORRECT create-vs-comment decision — but the mutating step (create/comment) is only
// PRINTED, never executed. This makes the whole decision path testable locally without filing a
// real issue.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TITLE = 'Weekly dependency audit surfaced advisories (tier-2)';
const LABEL = 'dependencies';
const ASSIGNEE = 'mihai-r-lupu';
const DRY_RUN = process.env['DRY_RUN'] === '1';

function readRequiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required (set as an env var before running this script).`);
  }
  return value;
}

/** Runs a `gh` subcommand via argv (never a shell string) and returns trimmed stdout. Throws on
 * a non-zero exit. */
function runGh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf-8' });
  if (result.error) {
    throw new Error(`Failed to run 'gh ${args.join(' ')}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `'gh ${args.join(' ')}' exited ${String(result.status)}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

/** Renders a `gh` argv array as a readable, copy-pasteable command line (for DRY_RUN output and
 * error messages only — never used to actually invoke a shell). */
function renderCommand(args) {
  return ['gh', ...args.map((a) => (/[\s"]/.test(a) ? `'${a}'` : a))].join(' ');
}

function findOpenIssueNumber() {
  const searchArgs = [
    'issue',
    'list',
    '--state',
    'open',
    '--search',
    `"${TITLE}" in:title`,
    '--json',
    'number',
    '--jq',
    '.[0].number // empty',
  ];
  const stdout = runGh(searchArgs);
  return stdout === '' ? undefined : stdout;
}

function buildBody(auditOutput, runUrl) {
  return [
    `The weekly tier-2 dependency audit (\`npm run audit:full\` — moderate+, including ` +
      `devDependencies) surfaced one or more advisories not already covered by the shared ` +
      `allowlist.`,
    '',
    `Run: ${runUrl}`,
    '',
    '<details>',
    '<summary>Audit output</summary>',
    '',
    '```',
    auditOutput.trimEnd(),
    '```',
    '',
    '</details>',
    '',
    '**Triage:** fix-in-range (bump the dependency within its declared range) / merge the ' +
      'corresponding Dependabot PR if one exists / only-if-genuinely-`not_affected`, add a ' +
      'GHSA-id-keyed entry with `expiry` and a reason to `audit-ci.tier2.jsonc` (the guard ' +
      'enforces GHSA-id-only entries and tier-1 ⊆ tier-2 — see `scripts/check-audit-allowlist.mjs`). ' +
      '**Do not auto-suppress.** Owner: @mihai-r-lupu.',
  ].join('\n');
}

function main() {
  const auditOutputFile = readRequiredEnv('AUDIT_OUTPUT_FILE');
  const runUrl = readRequiredEnv('RUN_URL');
  const auditOutput = readFileSync(auditOutputFile, 'utf-8');

  const body = buildBody(auditOutput, runUrl);

  const tmpDir = mkdtempSync(join(tmpdir(), 'audit-issue-'));
  const bodyPath = join(tmpDir, 'body.md');
  writeFileSync(bodyPath, body, 'utf-8');

  try {
    // Read-only — safe to run for real even under DRY_RUN, and required to print the CORRECT
    // create-vs-comment decision.
    const existingIssueNumber = findOpenIssueNumber();

    const mutatingArgs =
      existingIssueNumber !== undefined
        ? ['issue', 'comment', existingIssueNumber, '--body-file', bodyPath]
        : [
            'issue',
            'create',
            '--title',
            TITLE,
            '--body-file',
            bodyPath,
            '--label',
            LABEL,
            '--assignee',
            ASSIGNEE,
          ];

    if (DRY_RUN) {
      console.log(
        existingIssueNumber !== undefined
          ? `[DRY_RUN] Open issue #${existingIssueNumber} found ('${TITLE}') — would COMMENT.`
          : `[DRY_RUN] No open issue titled '${TITLE}' found — would CREATE a new one.`,
      );
      console.log(`[DRY_RUN] Would run: ${renderCommand(mutatingArgs)}`);
      console.log('[DRY_RUN] Assembled body:');
      console.log('---');
      console.log(body);
      console.log('---');
      return;
    }

    runGh(mutatingArgs);
    console.log(
      existingIssueNumber !== undefined
        ? `Commented on existing issue #${existingIssueNumber}.`
        : `Created a new tracking issue: '${TITLE}'.`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
