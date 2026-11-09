// json-option-set-715b.test.ts — issue #715 (b), Amendment 5 (4): the set of CLI commands that print
// JSON is pinned, so a command that gains `--json` cannot do it without deciding whether its output
// carries `as_of` (02 §C: a reply that judges time states the instant it judged at). Today none of
// the commands that judge a run's time (`inspect`, `list`, `run`, `respond`, `advance`) prints JSON.
//
// Derived from the commands as Commander holds them: the three exported command lists, nested
// commands included.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import {
  dbCommands,
  runCommands,
  topLevelCommands,
  workflowCommands,
} from '../commands-registry.js';

/** Every command under `group`, nested ones included, as `<group> <name> …`. */
function commandsOf(group: string, commands: readonly Command[]): Array<[string, Command]> {
  return commands.flatMap((c) => {
    const path = [group, c.name()].filter((p) => p !== '').join(' ');
    return [[path, c] as [string, Command], ...commandsOf(path, c.commands)];
  });
}

describe('#715 (b) Amendment 5 — the CLI commands that print JSON', () => {
  it('exactly `realm run attempts`, `realm workflow validate`, `realm workflow list` and `realm db check` declare --json', () => {
    const all = [
      ...commandsOf('workflow', workflowCommands),
      ...commandsOf('run', runCommands),
      ...commandsOf('db', dbCommands),
      ...commandsOf('', topLevelCommands),
    ];
    const withJson = new Set(
      all.filter(([, c]) => c.options.some((o) => o.long === '--json')).map(([path]) => path),
    );
    const expected = new Set(['run attempts', 'workflow validate', 'workflow list', 'db check']);
    // (a) red when a command gains (or loses) `--json` — e.g. `realm run list`; its adder decides
    //     whether the JSON carries `as_of`; (b) prints only the set difference.
    expect({
      added: [...withJson].filter((p) => !expected.has(p)),
      missing: [...expected].filter((p) => !withJson.has(p)),
    }).toEqual({ added: [], missing: [] });
    // Non-vacuity: the walk reached the run commands that judge time.
    expect(
      ['run list', 'run inspect', 'run respond', 'run advance', 'workflow run'].filter(
        (p) => !all.some(([q]) => q === p),
      ),
    ).toEqual([]);
  });
});
