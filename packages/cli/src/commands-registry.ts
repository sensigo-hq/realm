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
import { reconcileCommand } from './commands/reconcile.js';
import { attemptsCommand } from './commands/attempts.js';
import { respondCommand } from './commands/respond.js';
import { inspectCommand } from './commands/inspect.js';
import { replayCommand } from './commands/replay.js';
import { diffCommand } from './commands/diff.js';
import { initCommand } from './commands/init.js';
import { testCommand } from './commands/test.js';
import { watchCommand } from './commands/watch.js';
import { listCommand } from './commands/list.js';
import { mcpCommand } from './commands/mcp.js';
import { serveCommand } from './commands/serve.js';
import { migrateCommand } from './commands/migrate.js';
import { agentCommand } from './commands/agent.js';
import { webhookCommand } from './commands/webhook.js';
import { listenCommand } from './commands/listen.js';

/** Commands that operate on workflow definitions (realm workflow <cmd>). */
export const workflowCommands = [
  initCommand,
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
  cleanupCommand,
  purgeCommand,
  gcCommand,
  reconcileCommand,
  attemptsCommand,
];

/** Top-level commands not nested under a subgroup. */
export const topLevelCommands = [
  mcpCommand,
  serveCommand,
  agentCommand,
  webhookCommand,
  listenCommand,
];
