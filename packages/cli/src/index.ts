#!/usr/bin/env node
// @sensigo/realm-cli — command-line interface for Realm
import 'dotenv/config';
import { Command } from 'commander';
import { workflowCommands, runCommands, topLevelCommands } from './commands-registry.js';

const program = new Command();

program.name('realm').description('Realm workflow engine CLI').version('0.14.1');

// realm workflow — operations on workflow definitions
const workflowCmd = new Command('workflow').description('Manage workflow definitions');
for (const cmd of workflowCommands) workflowCmd.addCommand(cmd);

// realm run — operations on run instances
const runCmd = new Command('run').description('Manage workflow run instances');
for (const cmd of runCommands) runCmd.addCommand(cmd);

program.addCommand(workflowCmd);
program.addCommand(runCmd);
for (const cmd of topLevelCommands) program.addCommand(cmd);

program.parse();
