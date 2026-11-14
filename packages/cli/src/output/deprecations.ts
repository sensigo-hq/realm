// output/deprecations.ts — CP-W: the CLI's deprecation door. `warnDeprecated(id)` prints one line on
// stderr, `Warning: [<id>] <used> <means> <instead> <when>`, once per id per command the operator
// ran: once per process through core's said-set, which a relay seeds into its worker and `realm
// listen` into the agents it starts (the `REALM_DEPRECATIONS_SAID` marker, `writer.ts`). The line
// goes through the output writer, so log-mode masking applies and it never reaches stdout or a
// `--json` document. A command's action (or what it calls) raises it, never an option parser.
//
// An id raised before the writer is installed (a deprecated variable read at a module's init) is
// queued: the writer's install drains the queue after its stderr patch, so the line is masked; in a
// process where no writer ever installs (an in-process host, a library embedder) the queue drains at
// exit, to stderr as it is.
//
// This module imports nothing from the writer: the writer calls `deprecationWriterInstalled` at its
// install and at its test reset, so neither module reads the other while it loads.
import { writeSync } from 'node:fs';
import {
  DEPRECATIONS,
  deprecationLine,
  markSaid,
  validateDeprecations,
  type DeprecationEntry,
} from '@sensigo/realm';

let table: readonly DeprecationEntry[] = DEPRECATIONS;
let writerReady = false;
const queue: string[] = [];
let exitDrainArmed = false;

/** Whether `id` is in the door's table (the product's, or a test's). */
export function isKnownDeprecation(id: string): boolean {
  return table.some((entry) => entry.id === id);
}

/**
 * Says the retired thing `id` once in this command: one line on stderr through the writer. An id
 * not in the table is a programming error: this throws, naming it.
 */
export function warnDeprecated(id: string): void {
  const entry = table.find((e) => e.id === id);
  if (entry === undefined)
    throw new Error(`warnDeprecated: ${id} is not in Realm's deprecation table`);
  if (!markSaid(id)) return;
  const line = deprecationLine(entry);
  if (writerReady) {
    process.stderr.write(`${line}\n`);
    return;
  }
  queue.push(line);
  if (!exitDrainArmed) {
    exitDrainArmed = true;
    process.once('exit', () => {
      // No writer ever installed in this process: it masks nothing anywhere, so the line goes as it is.
      if (writerReady) return;
      for (const queued of queue.splice(0)) {
        try {
          writeSync(2, `${queued}\n`);
        } catch {
          // Nothing more can be written.
        }
      }
    });
  }
}

/**
 * The writer's install calls this with `true` after its stderr patch (the queued lines then go out
 * through it, masked); its test reset calls it with `false`.
 */
export function deprecationWriterInstalled(installed: boolean): void {
  writerReady = installed;
  if (!installed) return;
  for (const queued of queue.splice(0)) process.stderr.write(`${queued}\n`);
}

/** A test seam, not a product path: the door reads `entries` in place of the product table until
 *  the returned restore runs. The entries are validated as the product table is. */
export function setDeprecationTableForTests(entries: readonly DeprecationEntry[]): () => void {
  validateDeprecations(entries);
  const before = table;
  table = entries;
  return (): void => {
    table = before;
  };
}
