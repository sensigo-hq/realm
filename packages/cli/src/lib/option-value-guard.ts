// option-value-guard.ts — issue #920: a word that starts with `-` is refused as the value of an option
// that would swallow it. Commander takes the word after an option that needs a value as that value,
// whatever it is, so `--model --strict` took `--strict` as the model id and dropped the flag: a CI
// gate that should fail exited 0. Python's argparse, Rust's clap and Node's `util.parseArgs` refuse
// such a word, with `--option=value` as the way to mean it; Commander has no setting for it (its
// maintainers closed the reports as intended), so this guard is realm's.
//
// One `preAction` hook, attached to every command by a walk like the writer's, BEFORE the writer's
// hook: a refusal is printed by Commander's own error channel (standard error, exit 1, nothing on
// standard output) before anything else runs. It refuses only the options in GUARDED_OPTIONS: the
// value-taking options that take any word without a check of their own. The other value-taking
// options refuse such a word with their own message already; `option-value-guard-classes.test.ts`
// classifies every value-taking option of the command tree, so a new one cannot ship unclassified.
import type { Command, Option } from 'commander';

/** A guarded option: the leaf command's name and the option's long flag. */
export interface GuardedOption {
  readonly command: string;
  readonly option: string;
}

/**
 * The options whose value is refused when it is a flag-like word typed as the next word (31). Keyed by
 * the leaf command's name (a command parsed on its own has no parent, so a path cannot be read) and
 * the long flag. Each takes any word without a check of its own (the census, `plans/issue-920/census/`).
 * `option-value-guard-classes.test.ts` holds the other class: the options that already refuse such a
 * word with their own message.
 */
export const GUARDED_OPTIONS: readonly GuardedOption[] = [
  // C-1: the model id, on the five commands that take one.
  { command: 'validate', option: '--model' },
  { command: 'register', option: '--model' },
  { command: 'watch', option: '--model' },
  { command: 'agent', option: '--model' },
  { command: 'listen', option: '--model' },
  // C-2: the other options that take any word without a check of their own (26). Each accepts the word
  // and goes on, and a dropped flag changes what the command does (`reconcile --workflow --dry-run`
  // writes; `drain <id> --extensions-module --force` drains nothing) or its message misleads.
  { command: 'run', option: '--project' }, // realm workflow run
  { command: 'agent', option: '--project' },
  { command: 'agent', option: '--params' },
  { command: 'agent', option: '--base-url' },
  { command: 'drain', option: '--project' },
  // Its own check ("Cannot resolve --extensions-module") runs only on the --force path, so the
  // swallow `--extensions-module --force` was never checked.
  { command: 'drain', option: '--extensions-module' },
  { command: 'serve', option: '--project' },
  { command: 'serve', option: '--extensions-module' },
  { command: 'serve', option: '--port' },
  { command: 'mcp', option: '--project' },
  { command: 'mcp', option: '--extensions-module' },
  { command: 'listen', option: '--port' },
  { command: 'listen', option: '--host' },
  { command: 'listen', option: '--dedup-store' },
  { command: 'listen', option: '--log-level' },
  { command: 'listen', option: '--sweep-expired-gates' },
  { command: 'list', option: '--workflow' }, // realm run list
  { command: 'reclaim', option: '--workflow' },
  { command: 'purge', option: '--workflow' },
  { command: 'reconcile', option: '--workflow' },
  { command: 'export', option: '--out' },
  { command: 'respond', option: '--project' },
  { command: 'advance', option: '--project' },
  { command: 'abandon', option: '--reason' }, // realm run abandon
  { command: 'respond', option: '--by' }, // realm run respond
  { command: 'reclaim', option: '--step' }, // realm run reclaim
];

/** A string of two or more characters that starts with `-` (Commander's option-looking token). A lone
 *  `-` is not one. */
export function looksLikeFlag(word: string): boolean {
  return word.length >= 2 && word.startsWith('-');
}

/** The root command's raw arguments (a subcommand's own `rawArgs` is empty). */
function rootRawArgs(command: Command): readonly string[] {
  let root = command;
  while (root.parent !== null && root.parent !== undefined) root = root.parent;
  return (root as unknown as { rawArgs?: string[] }).rawArgs ?? [];
}

/** The refusal, in Node `util.parseArgs`'s words for the way out. `word` is cut at its first `=`, so a
 *  swallowed `--api-key=<secret>` prints only `--api-key`. */
function refusal(option: Option, long: string, word: string): string {
  const shown = word.split('=')[0] ?? word;
  return (
    `error: option '${option.flags}' argument is ambiguous: '${shown}' looks like a flag.\n` +
    `Did you forget to specify the option argument for '${long}'? To specify an option argument starting with a dash use '${long}=-XYZ'.`
  );
}

/**
 * The `preAction` hook: refuses the run when a guarded option of the command being run holds a
 * flag-like word AND that word was typed as the next word after the option's long flag (so
 * `--model --strict` is refused and `--model=--strict`, one word, is not).
 */
export function optionValueGuard(_thisCommand: Command, actionCommand: Command): void {
  const name = actionCommand.name();
  for (const guarded of GUARDED_OPTIONS) {
    if (guarded.command !== name) continue;
    const option = actionCommand.options.find((o) => o.long === guarded.option);
    if (option === undefined) continue;
    const value: unknown = actionCommand.getOptionValue(option.attributeName());
    if (typeof value !== 'string' || !looksLikeFlag(value)) continue;
    const raw = rootRawArgs(actionCommand);
    const adjacent = raw.some((token, i) => token === guarded.option && raw[i + 1] === value);
    if (adjacent) actionCommand.error(refusal(option, guarded.option, value));
  }
}

/** Attaches {@link optionValueGuard} to every command object in `lists`, nested ones included. Call it
 *  BEFORE `attachWriterHook`: hooks run in the order they were added, and the refusal must come
 *  before the writer is installed. */
export function attachOptionValueGuard(lists: readonly (readonly Command[])[]): void {
  const seen = new Set<Command>();
  const visit = (command: Command): void => {
    if (seen.has(command)) return;
    seen.add(command);
    command.hook('preAction', optionValueGuard);
    for (const sub of command.commands) visit(sub);
  };
  for (const list of lists) for (const command of list) visit(command);
}
