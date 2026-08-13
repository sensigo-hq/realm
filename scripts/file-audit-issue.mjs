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
//
// issue #327 — PARAMETERIZED, not forked: this script also files the weekly knip dead-dependency
// finding, which is structurally identical (a scheduled step failed → tee'd output → file/update
// one stable-titled issue) — only the title and two prose blocks differ. Everything load-bearing
// (argv-only `runGh`, title-keyed dedup, `--body-file`, the DRY_RUN guard) stays generic and is
// unaffected by which mode runs. Mode is the first CLI positional arg; omitted ⇒ 'tier2-audit' —
// this is what keeps the EXISTING scheduled-audit.yml step (`run: node scripts/file-audit-issue.mjs`,
// no args) byte-for-byte unchanged while still reaching the new knip mode from a second, additive
// step that passes `knip` explicitly.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One entry per audit source this script can file for. `title` is the STABLE, dedup-keyed issue
 *  title (never changes across runs — that stability IS the dedup mechanism). `intro`/`triage`
 *  are the two prose blocks `buildBody()` composes around the shared Run-link + collapsible
 *  output section; everything else in the body is generic across modes. */
const MODES = {
  'tier2-audit': {
    title: 'Weekly dependency audit surfaced advisories (tier-2)',
    intro:
      'The weekly tier-2 dependency audit (`npm run audit:full` — moderate+, including ' +
      'devDependencies) surfaced one or more advisories not already covered by the shared ' +
      'allowlist.',
    triage:
      '**Triage:** fix-in-range (bump the dependency within its declared range) / merge the ' +
      'corresponding Dependabot PR if one exists / only-if-genuinely-`not_affected`, add a ' +
      'GHSA-id-keyed entry with `expiry` and a reason to `audit-ci.tier2.jsonc` (the guard ' +
      'enforces GHSA-id-only entries and tier-1 ⊆ tier-2 — see `scripts/check-audit-allowlist.mjs`). ' +
      '**Do not auto-suppress.** Owner: @mihai-r-lupu.',
  },
  knip: {
    title: '[scheduled audit] dead-dependency findings (knip)',
    intro:
      'The weekly scheduled audit ran `npm run deps:audit` (knip, `--dependencies` scope — ' +
      'unused and unlisted/phantom dependencies, v1) and found one or more findings.',
    triage:
      '**Triage:** for an *unused* dependency, remove it from the owning package’s ' +
      '`package.json` (verify first it isn’t reached only via a dynamic/variable-specifier ' +
      'import — see the `openai` entry in `knip.jsonc` for that exact shape) / for an ' +
      '*unlisted* (phantom) dependency, add it to the importing package’s `dependencies` or ' +
      '`devDependencies` at its currently-hoisted version / if a dependency is knowingly ' +
      'unreachable to static analysis for a good reason, add an `ignoreDependencies` entry to ' +
      '`knip.jsonc` **with a reason comment** — `--treat-config-hints-as-errors` keeps that ' +
      'list honest mechanically. **Do not silently ignore a genuine phantom dependency to make ' +
      'the run green.** Owner: @mihai-r-lupu.',
  },
};
const DEFAULT_MODE = 'tier2-audit';

const LABEL = 'dependencies';
const ASSIGNEE = 'mihai-r-lupu';
const DRY_RUN = process.env['DRY_RUN'] === '1';

function resolveMode(argv) {
  const requested = argv[0] ?? DEFAULT_MODE;
  const mode = MODES[requested];
  if (mode === undefined) {
    throw new Error(
      `unknown mode '${requested}' — must be one of: ${Object.keys(MODES).join(', ')}.`,
    );
  }
  return mode;
}

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

function findOpenIssueNumber(title) {
  const searchArgs = [
    'issue',
    'list',
    '--state',
    'open',
    '--search',
    `"${title}" in:title`,
    '--json',
    'number',
    '--jq',
    '.[0].number // empty',
  ];
  const stdout = runGh(searchArgs);
  return stdout === '' ? undefined : stdout;
}

function buildBody(mode, auditOutput, runUrl) {
  return [
    mode.intro,
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
    mode.triage,
  ].join('\n');
}

function main() {
  const mode = resolveMode(process.argv.slice(2));
  const auditOutputFile = readRequiredEnv('AUDIT_OUTPUT_FILE');
  const runUrl = readRequiredEnv('RUN_URL');
  const auditOutput = readFileSync(auditOutputFile, 'utf-8');

  const body = buildBody(mode, auditOutput, runUrl);

  const tmpDir = mkdtempSync(join(tmpdir(), 'audit-issue-'));
  const bodyPath = join(tmpDir, 'body.md');
  writeFileSync(bodyPath, body, 'utf-8');

  try {
    // Read-only — safe to run for real even under DRY_RUN, and required to print the CORRECT
    // create-vs-comment decision.
    const existingIssueNumber = findOpenIssueNumber(mode.title);

    const mutatingArgs =
      existingIssueNumber !== undefined
        ? ['issue', 'comment', existingIssueNumber, '--body-file', bodyPath]
        : [
            'issue',
            'create',
            '--title',
            mode.title,
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
          ? `[DRY_RUN] Open issue #${existingIssueNumber} found ('${mode.title}') — would COMMENT.`
          : `[DRY_RUN] No open issue titled '${mode.title}' found — would CREATE a new one.`,
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
        : `Created a new tracking issue: '${mode.title}'.`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
