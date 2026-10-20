// workflow-list.ts — `realm workflow list`: what is actually in the registry (issue #427).
//
// The registry was a black box. `realm workflow register` wrote into it, everything else read
// from it by id, and nothing showed an operator what was there — so a definition registered
// under an older realm sat there indefinitely and invisibly: it cannot run at all — every runtime
// consumer resolves through the store's get(), which refuses it. This is the read surface that
// makes a pre-upgrade audit possible: the table lists the copies this version reads, a ⚠ line names
// each copy it cannot (an older or a later Realm's among them, #627 W), and each one is audited
// with `realm workflow validate --registered <id>`.
import { Command } from 'commander';
import { JsonWorkflowStore, CURRENT_WORKFLOW_SCHEMA_VERSION } from '@sensigo/realm';
import type { WorkflowDefinition } from '@sensigo/realm';

/**
 * Alphabetical by id — the documented order, and the only one an operator can predict.
 *
 * Extracted and exported because the filesystem is not a reliable witness for it: `readdirSync`
 * happens to return alphabetical order on this repo's ext4, so a cell that registers entries out
 * of order and reads them back would pass with the sort deleted. This pins the rule itself.
 *
 * @internal Exported for testing only.
 */
export function sortedById(workflows: WorkflowDefinition[]): WorkflowDefinition[] {
  return [...workflows].sort((a, b) => a.id.localeCompare(b.id));
}

/** The SCHEMA column. #819 (U4): every copy in the table is at the current format — a copy an older
 *  or a later Realm registered is never listed here (#627 W correction 1 C3, correction 2 8.6 (c)):
 *  its ⚠ line names it, with its way out. #819 correction 1 (02 C1): "(current)" only for the
 *  current format — a schema bump that still reads older numbers would list one, and it prints as
 *  itself. */
export function schemaCell(schemaVersion: number | undefined): string {
  if (schemaVersion === CURRENT_WORKFLOW_SCHEMA_VERSION) return `${schemaVersion} (current)`;
  return schemaVersion === undefined ? 'none' : String(schemaVersion);
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export const workflowListCommand = new Command('list')
  .description('List registered workflow definitions (sorted by id)')
  .option('--json', 'Emit the listing as JSON on stdout, and nothing else')
  .action(async (opts: { json?: boolean }) => {
    const store = new JsonWorkflowStore();
    const { workflows, unreadable, mismatched } = await store.listWithDiagnostics();
    const sorted = sortedById(workflows);

    if (opts.json === true) {
      console.log(
        JSON.stringify(
          {
            workflows: sorted.map((w) => ({
              id: w.id,
              name: w.name,
              version: w.version,
              origin: w.origin ?? null,
              schema_version: w.schema_version ?? null,
              current: w.schema_version === CURRENT_WORKFLOW_SCHEMA_VERSION,
            })),
            unreadable,
            mismatched,
          },
          null,
          2,
        ),
      );
      return;
    }

    const rows = sorted.map((w) => {
      // The type says string; a hand-edited copy at the current format may still lack a name or a
      // version. Read through a Partial view so the table renders `-` instead of dying at `.length`
      // (executed on main with `{"id":"w1"}`: a raw TypeError — the fresh walk's T4; review fold
      // C10). #819 (U4): a legacy copy is never in the table — its ⚠ line is the disclosure.
      const partial: Partial<Pick<typeof w, 'name' | 'version'>> = w;
      return {
        id: w.id,
        name: partial.name ?? '-',
        version: partial.version === undefined ? '-' : String(partial.version),
        origin: w.origin ?? '-',
        schema: schemaCell(w.schema_version),
      };
    });

    const widths = {
      id: Math.max(2, ...rows.map((r) => r.id.length)),
      name: Math.max(4, ...rows.map((r) => r.name.length)),
      version: Math.max(7, ...rows.map((r) => r.version.length)),
      origin: Math.max(6, ...rows.map((r) => r.origin.length)),
    };

    console.log(
      `${pad('ID', widths.id)}  ${pad('NAME', widths.name)}  ${pad('VERSION', widths.version)}  ${pad('ORIGIN', widths.origin)}  SCHEMA`,
    );
    for (const r of rows) {
      console.log(
        `${pad(r.id, widths.id)}  ${pad(r.name, widths.name)}  ${pad(r.version, widths.version)}  ${pad(r.origin, widths.origin)}  ${r.schema}`,
      );
    }
    // issue #558 PR-T (review fold C7) — the count names what it could NOT count: `validate
    // --registered` sends an operator here for a copy that exists but cannot be read, and a bare
    // "0 workflows registered." then contradicts the ⚠ line beneath it (the fresh walk's minor).
    // No "(below)": the ⚠ detail is stderr, and a stdout-only reader would be pointed at nothing
    // (walk 4; review fold C19).
    const registryBroken = unreadable.some((u) => u.class === 'registry_broken');
    const unreadableSuffix = registryBroken
      ? '; the registry itself could not be read'
      : unreadable.length > 0
        ? // R3 (the review walk): the count sums every per-file class, one of which is a DIRECTORY —
          // "entry" is true of all of them; the per-class ⚠ lines beneath keep their own nouns.
          `; ${unreadable.length} ${unreadable.length === 1 ? 'entry' : 'entries'} in the registry could not be read`
        : '';
    console.log(
      `\n${rows.length} ${rows.length === 1 ? 'workflow' : 'workflows'} registered${unreadableSuffix}.`,
    );

    // The census lines go to stderr: they are not part of the listing a script would consume,
    // and an operator piping stdout should still see them.
    if (unreadable.length > 0) {
      // issue #558 PR-T — ONE sentence per CLASS, every one ending in the pinned tail. A single
      // "could not be parsed" sentence for every failure was false for four of the five classes
      // (a chmod-000 file was reported as unparseable — executed on main).
      const broken = unreadable.find((u) => u.class === 'registry_broken');
      if (broken !== undefined) {
        // The whole registry, not an entry: one line, no table, exit 0 (main crashed here).
        console.warn(`⚠ ${broken.reason} — realm cannot audit what it cannot read.`);
      } else {
        const TAIL = ' — realm cannot audit what it cannot read.';
        const groups: Array<{
          cls: string;
          one: (names: string, errno: string) => string;
          many: (n: number, names: string, errno: string) => string;
        }> = [
          {
            cls: 'unreadable',
            one: (names, errno) =>
              `⚠ 1 file in the registry could not be read (${errno}): ${names}`,
            many: (n, names, errno) =>
              `⚠ ${String(n)} files in the registry could not be read (${errno}): ${names}`,
          },
          {
            cls: 'parse',
            one: (names) => `⚠ 1 file in the registry could not be parsed: ${names}`,
            many: (n, names) =>
              `⚠ ${String(n)} files in the registry could not be parsed: ${names}`,
          },
          {
            cls: 'empty',
            one: (names) => `⚠ 1 file in the registry is empty: ${names}`,
            many: (n, names) => `⚠ ${String(n)} files in the registry are empty: ${names}`,
          },
          {
            cls: 'not_a_file',
            one: (names) =>
              `⚠ 1 entry in the registry is a directory, not a workflow file: ${names}`,
            many: (n, names) =>
              `⚠ ${String(n)} entries in the registry are directories, not workflow files: ${names}`,
          },
          {
            // #627 W correction 1 (C3): a copy a later Realm registered — it parsed; this version
            // refuses to read it (W-r2).
            cls: 'newer',
            one: (names) =>
              `⚠ 1 file in the registry was registered by a later version of Realm: ${names}`,
            many: (n, names) =>
              `⚠ ${String(n)} files in the registry were registered by a later version of Realm: ${names}`,
          },
          {
            // #627 W correction 2 (8.6 (c)): a copy an older Realm registered — every run path
            // refuses it, so it is never in the table. #819 (U4): its way out, re-registering.
            cls: 'legacy',
            one: (names) =>
              `⚠ 1 file in the registry was registered by an older version of Realm: ${names}; re-register each from its source (realm workflow register <path-to-workflow>)`,
            many: (n, names) =>
              `⚠ ${String(n)} files in the registry were registered by an older version of Realm: ${names}; re-register each from its source (realm workflow register <path-to-workflow>)`,
          },
          {
            // A directory entry that vanished between readdir and probe — a race, not a state an
            // operator can act on, but it must never print as a parse failure.
            cls: 'missing',
            one: (names) => `⚠ 1 file in the registry is gone: ${names}`,
            many: (n, names) => `⚠ ${String(n)} files in the registry are gone: ${names}`,
          },
        ];
        for (const g of groups) {
          const inClass = unreadable.filter((u) => u.class === g.cls);
          if (inClass.length === 0) continue;
          // One sentence per (class, errno): two files failing for DIFFERENT reasons never share
          // a sentence that names only one of them (executed: an EACCES file was reported under
          // a sibling's ELOOP).
          const errnos = [...new Set(inClass.map((u) => u.errno ?? 'unknown'))];
          for (const errno of errnos) {
            const members = inClass.filter((u) => (u.errno ?? 'unknown') === errno);
            const names = members.map((u) => u.file).join(', ');
            console.warn(
              (members.length === 1 ? g.one(names, errno) : g.many(members.length, names, errno)) +
                TAIL,
            );
          }
        }
      }
    }
    if (mismatched.length > 0) {
      const detail = mismatched.map((m) => `${m.file} (id '${m.id}')`).join(', ');
      console.warn(
        mismatched.length === 1
          ? `⚠ 1 file whose stored id differs from its filename: ${detail} — '--registered' resolves by filename.`
          : `⚠ ${mismatched.length} files whose stored id differs from their filename: ${detail} — '--registered' resolves by filename.`,
      );
    }

    // Exit 0 ALWAYS, including with unreadable entries: this is a read surface, and reporting
    // the broken entry IS the signal. Exiting non-zero would make `workflow list` unusable in
    // the very scripts that most want to know.
  });
