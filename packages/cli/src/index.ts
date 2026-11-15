#!/usr/bin/env node
// @sensigo/realm-cli — command-line interface for Realm
import 'dotenv/config';
import { existsSync } from 'node:fs';
import { shellWord } from '@sensigo/realm';
import { buildRealmProgram, runCommands, installClockErrorSink } from './commands-registry.js';
import { reportExpectedRefusal } from './lib/expected-refusal.js';
import { declareRealmProgram } from './output/relay.js';

// CP-I: one function builds the tree, so the kept-surface inventory's test walks the one the binary runs.
const program = buildRealmProgram();

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
  !runCommands.some((c) => c.name() === token) &&
  (token.includes('/') || token.endsWith('.yaml') || token.endsWith('.yml') || existsSync(token))
) {
  console.error(`error: unknown command '${token}'`);
  // #729 PR-0 (T-8): the token through the one quoter, the command delimited on its own — no
  // punctuation after it (C212).
  console.error(`Did you mean: realm workflow run ${shellWord(token)}`);
  console.error(
    "('realm run' manages run instances; the dev-mode runner is 'realm workflow run'.)",
  );
  process.exit(1);
}

// #715 (a) correction 1 (C-6): awaited, so an error a command's action throws reaches this one catch.
// An expected typed refusal is printed as one line with exit code 1; everything else is rethrown and
// stays loud (the writer's fatal handler prints it with its stack).
// #715 (b) (03 §A.1, D-22): the process's waiter-error sink, set once before any command runs (a
// gate's expiry timer, `realm listen`'s sweeper and `realm mcp`'s store all wait on a store's clock).
installClockErrorSink();
// U1b (prompt amendment A1): this process is the realm program, so a command in log mode may run its
// work in a second process of this same program.
declareRealmProgram();
try {
  await program.parseAsync();
} catch (err) {
  if (!reportExpectedRefusal(err)) throw err;
}
