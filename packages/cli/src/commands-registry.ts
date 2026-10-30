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
import { gcCommand } from './commands/gc.js';
import { exportCommand } from './commands/export.js';
import { reconcileCommand } from './commands/reconcile.js';
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
import { migrateCommand } from './commands/migrate.js';
// issue #367 (part 3): the run-scoped sibling of `realm workflow migrate` — different group, no
// collision.
import { runMigrateCommand } from './commands/run-migrate.js';
import { agentCommand } from './commands/agent.js';
import { webhookCommand } from './commands/webhook.js';
import { listenCommand } from './commands/listen.js';
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
  migrateCommand,
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
  gcCommand,
  exportCommand,
  reconcileCommand,
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
