#!/usr/bin/env node
// @sensigo/realm-cli — command-line interface for Realm
import 'dotenv/config';
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { workflowCommands, runCommands, topLevelCommands } from './commands-registry.js';

const program = new Command();

program.name('realm').description('Realm workflow engine CLI').version('0.41.0');

// realm workflow — operations on workflow definitions
const workflowCmd = new Command('workflow').description('Manage workflow definitions');
for (const cmd of workflowCommands) workflowCmd.addCommand(cmd);

// realm run — operations on run instances
const runCmd = new Command('run').description('Manage workflow run instances');
for (const cmd of runCommands) runCmd.addCommand(cmd);

program.addCommand(workflowCmd);
program.addCommand(runCmd);
for (const cmd of topLevelCommands) program.addCommand(cmd);

// issue #427 — `realm run ./my-workflow` is the discoverability trap: `realm run` manages run
// INSTANCES, while the dev-mode runner is `realm workflow run`. Commander's own unknown-command
// error names the mistake but not the fix.
//
// A PRE-PARSE intercept rather than a `command:*` listener, and the difference matters: attaching
// that listener SUPPRESSES commander's unknown-command handling entirely (executed — silence and
// exit 0, a silent success), and hand-rolling a replacement would lose the near-miss suggestion
// commander already gives (`realm run inspct` prints "Did you mean inspect?" from an internal it
// does not export). Intercepting only the path-shaped case leaves every other token — typos
// included — falling through to commander untouched.
const [group, token] = process.argv.slice(2);
if (
  group === 'run' &&
  token !== undefined &&
  !token.startsWith('-') &&
  !runCmd.commands.some((c) => c.name() === token) &&
  (token.includes('/') || token.endsWith('.yaml') || token.endsWith('.yml') || existsSync(token))
) {
  console.error(`error: unknown command '${token}'`);
  console.error(
    `Did you mean 'realm workflow run ${token}'? ('realm run' manages run instances; the dev-mode runner is 'realm workflow run'.)`,
  );
  process.exit(1);
}

program.parse();
