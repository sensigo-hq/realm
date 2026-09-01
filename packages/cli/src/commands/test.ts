// realm test <workflow-path> --fixtures <dir> — runs fixture-based workflow tests.
import { Command } from 'commander';
import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadWorkflowFromFileWithDiagnostics,
  renderLoaderWarning,
  WorkflowError,
} from '@sensigo/realm';
import { renderLoadFailure } from '../lib/loader-warnings.js';
import { runFixtureTests } from '@sensigo/realm-testing';
import type { TestResult, RunFixtureTestsOptions } from '@sensigo/realm-testing';
import { loadProjectExtensions } from '../extensions/load-project-extensions.js';

/**
 * Formats fixture test results for display.
 * Returns an array of output lines and the appropriate process exit code.
 */
export function formatTestResults(results: TestResult[]): { lines: string[]; exitCode: number } {
  const lines: string[] = [];
  let allPassed = true;

  for (const result of results) {
    if (result.passed) {
      lines.push(`  ${chalk.green('PASS')} ${result.name}`);
    } else {
      allPassed = false;
      const errorPart = result.error !== undefined ? `: ${result.error}` : '';
      lines.push(`  ${chalk.red('FAIL')} ${result.name}${errorPart}`);
    }
  }

  return { lines, exitCode: allPassed ? 0 : 1 };
}

/** Mirrors the test-runner's workflow path resolution (kept in sync with runFixtureTests). */
function resolveWorkflowFilePath(workflowPath: string): string {
  return workflowPath.endsWith('.yaml') || workflowPath.endsWith('.yml')
    ? workflowPath
    : existsSync(join(workflowPath, 'workflow.yaml'))
      ? join(workflowPath, 'workflow.yaml')
      : workflowPath;
}

export const testCommand = new Command('test')
  .argument('<workflow-path>', 'Path to workflow directory or workflow.yaml file')
  .requiredOption('-f, --fixtures <dir>', 'Directory containing fixture YAML files')
  .option(
    '--extensions-module <path>',
    "Extensions module that REPLACES the workflow's declared 'extensions' modules (repair/override)",
  )
  .description('Run fixture-based workflow tests')
  .action(async (workflowPath: string, opts: { fixtures: string; extensionsModule?: string }) => {
    if (!existsSync(opts.fixtures)) {
      console.error(`Error: fixtures directory does not exist: ${opts.fixtures}`);
      process.exit(1);
      return;
    }

    let results: TestResult[];
    try {
      // issue #450: load SILENTLY and render once. The default `loadWorkflowFromFile` prints as
      // it loads, and the fixture runner loaded the same file again — so every warning appeared
      // twice.
      const { definition, warnings } = loadWorkflowFromFileWithDiagnostics(
        resolveWorkflowFilePath(workflowPath),
      );
      // PLACEMENT IS LOAD-BEARING: this loop must stay ABOVE the extensions load below. The
      // printing wrapper it replaces emitted before extensions loading could throw, so on an
      // extensions failure the operator still saw the workflow's own warnings. Moved below, every
      // warning on that path would vanish silently.
      //
      // And renderLoaderWarning directly, NOT printLoaderWarnings: that helper rewrites
      // `— ignored` to `— REFUSED below` for codes the boundary commands refuse, and post-#170
      // that includes the unknown-key family. `realm workflow test` is execution-LENIENT — it
      // proceeds and can pass — so "REFUSED below" above a passing run would be a false
      // statement about what just happened.
      for (const warning of warnings) console.warn(renderLoaderWarning(warning));

      // Resolve project extensions so custom HANDLERS run real and custom ADAPTERS get
      // fail-if-unmocked tripwires inside the fixture runner. Extension-free workflows
      // (without an override) pass no `extensions` — current behavior byte-for-byte.
      // Sentinel mode: fixtures never see real credentials — secret-bearing handlers are
      // constructed with sentinels and FAIL the fixture on first execution (runner-side).
      const loaded = await loadProjectExtensions(definition, {
        ...(opts.extensionsModule !== undefined ? { overrideModule: opts.extensionsModule } : {}),
        secretMode: 'sentinel',
      });
      for (const warning of loaded.sentinelWarnings ?? []) console.warn(`⚠ ${warning}`);
      const hasExtensionContent =
        loaded.manifest.modules.length > 0 ||
        loaded.manifest.adapters.length > 0 ||
        loaded.manifest.handlers.length > 0 ||
        loaded.manifest.processors.length > 0;
      const extensions: RunFixtureTestsOptions['extensions'] = hasExtensionContent
        ? { registry: loaded.registry, manifest: loaded.manifest }
        : undefined;
      results = await runFixtureTests({
        workflowPath,
        fixturesPath: opts.fixtures,
        // issue #450: the runner reuses this instead of re-loading (and re-printing) the file.
        definition,
        ...(extensions !== undefined ? { extensions } : {}),
      });
    } catch (err) {
      // issue #425 — THE FAMILY SPLIT. An `Invalid workflow:` message announces itself, so it
      // renders verbatim through the shared helper (which also lists a multi-error throw one per
      // line). Everything else this catch can see — a store failure, a broken extension module —
      // announces nothing on its own, so it keeps the prefix that earns its place (#417). The
      // predicate carries the colon, byte-matching the helper's own check.
      if (err instanceof WorkflowError && err.message.startsWith('Invalid workflow:')) {
        console.error(renderLoadFailure(err));
      } else {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
      return;
    }

    if (results.length === 0) {
      console.error('Error: no fixture files found in the specified directory');
      process.exit(1);
      return;
    }

    const { lines, exitCode } = formatTestResults(results);
    const passed = results.filter((r) => r.passed).length;

    console.log(`\nRealm Test — ${workflowPath}`);
    for (const line of lines) {
      console.log(line);
    }
    console.log(`\n${passed}/${results.length} passed`);

    process.exit(exitCode);
  });
