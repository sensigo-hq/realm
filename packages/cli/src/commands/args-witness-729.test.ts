// args-witness-729.test.ts — issue #729 PR-0 (D4 P-5; prompt A4): each CLI command that enacts a
// verb takes that verb's arguments, `ARGS[verb]` — every argument mapped to the command's own
// argument or option, with the same requiredness — read from the commands as Commander holds them.
// The command's other options are named here with why they are this door's own (where the project's
// code is, how much to show); an argument the door does not take is named with why. Anything else on
// either side fails the cell. `run_step` has no CLI command at 358d3c83 (PR0-CONTRACT Amendment 14;
// the prompt's Problems 13).
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: command,
// argument and option names only.
import { describe, it, expect } from 'vitest';
import type { Command } from 'commander';
import { ARGS, type ArgSpec } from '@sensigo/realm';
import { runCommands, workflowCommands } from '../commands-registry.js';

const HOST = {
  '--project': "where the project's code is (this host's)",
  '--extensions-module': "a module replacing the project's code (this host's repair tool)",
};

/** The command that enacts each verb on this door: each argument's place, its own options with why. */
const DOOR: Record<
  string,
  {
    command: () => Command | undefined;
    map: Record<string, string>;
    absent?: Record<string, string>;
    extras: Record<string, string>;
    /** #922: a command with several forms names the one that enacts the verb, and the places that
     *  form requires though the command as a whole leaves them optional. */
    form?: { usage: string; requires: readonly string[] };
  }
> = {
  respond: {
    command: () => runCommands.find((c) => c.name() === 'respond'),
    map: { run_id: '<run-id>', gate_id: '--gate', choice: '--choice', responded_by: '--by' },
    absent: {
      claim_token:
        'an operator at a terminal holds no claim token: it proves the conversation that opened the question',
    },
    extras: HOST,
  },
  advance: {
    command: () => runCommands.find((c) => c.name() === 'advance'),
    map: { run_id: '<run-id>' },
    extras: HOST,
  },
  inspect: {
    command: () => runCommands.find((c) => c.name() === 'inspect'),
    map: { run_id: '<run-id>' },
    extras: {
      '--verbose': 'how much of the record to show (a view option)',
      '--check-drift': 'a view option: re-hash the recorded extension against the disk',
      '--accept-partial-disclosure':
        "a view option: print the run's values when its declared secrets cannot all be read (#729 PR-3 correction 3, H-7'')",
    },
  },
  abandon: {
    command: () => runCommands.find((c) => c.name() === 'abandon'),
    map: { run_id: '<run-id>', reason: '--reason' },
    extras: {},
  },
  // #922 P1b: the per-step form; the dry run (`<run-id>` alone) and `--all` are the command's others.
  reclaim: {
    command: () => runCommands.find((c) => c.name() === 'reclaim'),
    map: { run_id: '<run-id>', step: '--step', force: '--force', claimed_at: '--claimed-at' },
    form: {
      usage: 'realm run reclaim <run-id> --step <name> [--claimed-at <stamp>] --force',
      requires: ['<run-id>', '--step', '--force'],
    },
    extras: {
      '--all': 'the batch form: every idempotent, past-deadline, non-gated claim (this door’s own)',
      '--workflow': 'with --all: only runs of this workflow (the batch form’s)',
      '--older-than': 'with --all: only claims past their deadline by this long (the batch form’s)',
    },
  },
  register: {
    command: () => workflowCommands.find((c) => c.name() === 'register'),
    map: { path: '<path>' },
    extras: {
      '--strict': 'refuse on a loader warning (this host’s policy)',
      // issue #600 caching PR 5: the cache lines' four flags, each this host's report option, never
      // reaching the verb.
      '--provider':
        "the provider whose request the cache lines describe (this host's report, caching PR 5)",
      '--model':
        "the model whose minimum the cache lines judge against (this host's report, caching PR 5)",
      '--floor':
        "the author's own minimum for the cache verdict (this host's report, caching PR 5)",
      '--ratio':
        "the author's own chars-per-token for the cache estimate (this host's report, caching PR 5)",
    },
  },
};

/** The command's places: `<name>` for an argument, `--long` for an option; each with requiredness. */
function placesOf(command: Command): Map<string, boolean> {
  const places = new Map<string, boolean>();
  for (const arg of command.registeredArguments) places.set(`<${arg.name()}>`, arg.required);
  for (const option of command.options) {
    if (option.long !== undefined) places.set(option.long, option.mandatory);
  }
  return places;
}

describe('#729 PR-0 — P-5: each CLI command takes its verb’s ARGS', () => {
  it('respond, advance, inspect, abandon, reclaim (its per-step form), register: every argument in its place with its requiredness, every other option named', () => {
    const found: string[] = [];
    for (const [verb, door] of Object.entries(DOOR)) {
      const command = door.command();
      if (command === undefined) {
        found.push(`${verb}: no command`);
        continue;
      }
      const places = placesOf(command);
      const args = ARGS[verb as keyof typeof ARGS] as Readonly<Record<string, ArgSpec>>;
      for (const [arg, spec] of Object.entries(args)) {
        if (door.absent?.[arg] !== undefined) continue;
        const place = door.map[arg];
        if (place === undefined || !places.has(place)) {
          found.push(`${command.name()}: no place for ${verb}'s '${arg}'`);
          continue;
        }
        const required = door.form?.requires.includes(place) ?? places.get(place);
        if (required !== spec.required) {
          found.push(
            `${command.name()} ${place}: required ${required}, ARGS says ${spec.required}`,
          );
        }
      }
      const known = new Set([...Object.values(door.map), ...Object.keys(door.extras)]);
      for (const place of places.keys()) {
        if (!known.has(place))
          found.push(`${command.name()}: '${place}' is neither an argument nor named here`);
      }
      for (const arg of Object.keys(door.map)) {
        if (!(arg in args))
          found.push(`${command.name()}: maps '${arg}', which ${verb}'s ARGS lacks`);
      }
    }
    // (a) red when a command and ARGS drift apart — an option renamed, a requiredness changed, a new
    //     unnamed option; (b) prints each difference by name.
    expect(found).toEqual([]);
    // run_step has no CLI command (Amendment 14): the lever is a fact line, not a command.
    expect(runCommands.some((c) => c.name() === 'run-step' || c.name() === 'step')).toBe(false);
  });
});
