// option-value-guard-classes.test.ts — issue #920, C-2: the completeness law. Every option of the
// command tree that takes a value is in EXACTLY ONE of three classes, so a new value-taking option
// cannot ship unclassified:
//   - GUARDED (production, `option-value-guard.ts`): takes any word without a check of its own; the
//     guard refuses a flag-like word typed after it;
//   - OWN_CHECK (here): already refuses such a word with its own message (13 by an `argParser`, 37 by
//     a check in the action or, for `serve --host`, by the name lookup that names the word);
//   - FREE_TEXT (here): free text recorded as typed, where a value that starts with `-` is plausible.
// Rule for a new option: it already refuses → OWN_CHECK; free text where a dash-leading value is
// plausible → FREE_TEXT; otherwise → GUARDED. Prints only the (leaf, flag) pairs that break the law.
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { workflowCommands, runCommands, topLevelCommands } from '../commands-registry.js';
import { GUARDED_OPTIONS } from './option-value-guard.js';

type Pair = `${string} ${string}`;

/** The 50 that already refuse a flag-like word with their own message (do NOT guard). */
const OWN_CHECK: readonly Pair[] = [
  // by an argParser (13)
  'validate --provider',
  'register --provider',
  'watch --provider',
  'agent --provider',
  'agent --schema-retries',
  'agent --llm-timeout',
  'agent --prompt-cache',
  'listen --provider',
  'listen --llm-timeout',
  'listen --prompt-cache',
  'listen --body-timeout-ms',
  'listen --max-body-bytes',
  'listen --max-concurrent',
  // in the action, or by the operating system's name lookup for `serve --host` (37)
  'validate --registered',
  'validate --extensions-module',
  'validate --floor',
  'validate --ratio',
  'register --floor',
  'register --ratio',
  'watch --floor',
  'watch --ratio',
  'run --params',
  'run --params-from-run',
  'run --extensions-module',
  'test --fixtures',
  'test --extensions-module',
  'list --status',
  'list --older-than',
  'replay --with',
  'resume --from',
  'reclaim --step',
  'reclaim --older-than',
  'respond --gate',
  'respond --choice',
  'respond --extensions-module',
  'advance --extensions-module',
  'cleanup --older-than',
  'purge --older-than',
  'gc --older-than',
  'drain --void',
  'mcp --gate-answers',
  'mcp --form-wait-seconds',
  'serve --host',
  'serve --gate-answers',
  'serve --form-wait-seconds',
  'agent --workflow',
  'agent --run-id',
  'agent --provider-module',
  'agent --extensions-module',
  'agent --cache-gaps',
];

/** Free text recorded as typed: a value that starts with `-` ("- duplicate run") is plausible (2). */
const FREE_TEXT: readonly Pair[] = ['abandon --reason', 'respond --by'];

/** Every (leaf name, long flag) of an option that takes a value, with each command object it is on. */
function derived(): Map<Pair, Command[]> {
  const out = new Map<Pair, Command[]>();
  const seen = new Set<Command>();
  const visit = (command: Command): void => {
    if (seen.has(command)) return;
    seen.add(command);
    for (const option of command.options) {
      if (!(option.required || option.optional) || option.long === undefined) continue;
      const pair: Pair = `${command.name()} ${option.long}`;
      out.set(pair, [...(out.get(pair) ?? []), command]);
    }
    for (const sub of command.commands) visit(sub);
  };
  for (const list of [workflowCommands, runCommands, topLevelCommands])
    for (const c of list) visit(c);
  return out;
}

describe('#920 C-2 — every value-taking option is classified exactly once', () => {
  it('1. the three tables and the command tree agree (28 + 50 + 2 = 80)', () => {
    // (a) red when a guarded row is deleted, an option is added to a command, or a row is in two
    // tables; (b) prints the unclassified, extra and duplicated (leaf, flag) pairs only.
    const tree = derived();
    const guarded: Pair[] = GUARDED_OPTIONS.map((g) => `${g.command} ${g.option}` as Pair);
    const tables = { guarded, ownCheck: [...OWN_CHECK], freeText: [...FREE_TEXT] };
    const all = [...guarded, ...OWN_CHECK, ...FREE_TEXT];
    const inTwo = [...new Set(all.filter((p, i) => all.indexOf(p) !== i))];
    const unclassified = [...tree.keys()].filter((p) => !all.includes(p));
    const notInTree = all.filter((p) => !tree.has(p));
    // The tables are keyed by (leaf name, long flag): two command objects that share both would get
    // one class for two options, so the law refuses that too.
    const shared = [...tree.entries()]
      .filter(([, commands]) => commands.length > 1)
      .map(([p]) => p);
    expect(
      {
        counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])),
        tree: tree.size,
        inTwo,
        unclassified,
        notInTree,
        shared,
      },
      JSON.stringify({ inTwo, unclassified, notInTree, shared }),
    ).toEqual({
      counts: { guarded: 28, ownCheck: 50, freeText: 2 },
      tree: 80,
      inTwo: [],
      unclassified: [],
      notInTree: [],
      shared: [],
    });
  });
});
