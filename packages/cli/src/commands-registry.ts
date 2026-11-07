// commands-registry.ts — exports all CLI commands grouped by category.
// Consumed by @sensigo/realm-cli itself and by realm-cloud/packages/cli-cloud,
// which adds cloud-specific commands on top.
import { validateCommand } from './commands/validate.js';
import { registerCommand } from './commands/register.js';
import { runCommand } from './commands/run.js';
import { resumeCommand } from './commands/resume.js';
import { abandonCommand } from './commands/abandon.js';
import { reclaimCommand } from './commands/reclaim.js';
import { cleanupCommand } from './commands/cleanup.js';
import { purgeCommand } from './commands/purge.js';
import { exportCommand } from './commands/export.js';
import { attemptsCommand } from './commands/attempts.js';
import { drainCommand } from './commands/drain.js';
import { respondCommand } from './commands/respond.js';
import { runAdvanceCommand } from './commands/run-advance.js';
import { inspectCommand } from './commands/inspect.js';
import { replayCommand } from './commands/replay.js';
import { diffCommand } from './commands/diff.js';
import { initCommand } from './commands/init.js';
import { testCommand } from './commands/test.js';
import { watchCommand } from './commands/watch.js';
import { workflowListCommand } from './commands/workflow-list.js';
import { listCommand } from './commands/list.js';
import { mcpCommand } from './commands/mcp.js';
import { serveCommand } from './commands/serve.js';
// issue #367 (part 3): `realm run migrate`, run-scoped.
import { runMigrateCommand } from './commands/run-migrate.js';
import { agentCommand } from './commands/agent.js';
import { webhookCommand } from './commands/webhook.js';
import { listenCommand } from './commands/listen.js';
import { setClockErrorSink } from '@sensigo/realm';
import { attachWriterHook } from './output/writer.js';
import { attachOptionValueGuard } from './lib/option-value-guard.js';

export { attachWriterHook, writerHook } from './output/writer.js';
// issue #920: the guard that refuses a flag-like word as the value of an option that would swallow it;
// exported beside the writer's hook so a program that reuses realm's commands attaches it the same way.
export { attachOptionValueGuard, optionValueGuard } from './lib/option-value-guard.js';

/** Commands that operate on workflow definitions (realm workflow <cmd>). */
export const workflowCommands = [
  initCommand,
  workflowListCommand,
  validateCommand,
  registerCommand,
  watchCommand,
  runCommand,
  testCommand,
];

/** Commands that operate on run instances (realm run <cmd>). */
export const runCommands = [
  listCommand,
  inspectCommand,
  replayCommand,
  diffCommand,
  resumeCommand,
  abandonCommand,
  reclaimCommand,
  respondCommand,
  runAdvanceCommand,
  cleanupCommand,
  purgeCommand,
  exportCommand,
  attemptsCommand,
  drainCommand,
  runMigrateCommand,
];

/** Top-level commands not nested under a subgroup. */
export const topLevelCommands = [
  mcpCommand,
  serveCommand,
  agentCommand,
  webhookCommand,
  listenCommand,
];

// issue #920: the option-value guard, on every command object in the three lists. Attached BEFORE the
// writer's hook (a command's hooks run in the order they were added): a refusal is printed before the
// writer is installed.
attachOptionValueGuard([workflowCommands, runCommands, topLevelCommands]);
// #729 PR-3 (L-1): every command object in the three lists — nested ones included — carries the
// writer's `preAction` hook, so the one writer is installed in any program that reuses realm's
// commands (cli-cloud attaches the exported hook to its own commands too).
attachWriterHook([workflowCommands, runCommands, topLevelCommands]);

/**
 * #715 (b) (03 §A.1, D-22): installs the process's waiter-error sink — a waiter on a store's clock (a
 * gate's expiry timer, `realm listen`'s sweeper) that fails is reported as one line on standard error,
 * `error: <message>`, through the one writer. Called ONCE at the start of a program that runs realm's
 * commands: the CLI's `index.ts`, before it parses its arguments; realm-cloud's CLI calls it too.
 * Without it, core re-throws a waiter's failure from a microtask (an uncaught exception).
 */
export function installClockErrorSink(): void {
  setClockErrorSink((err: unknown): void => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  });
}
