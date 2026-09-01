// workflow-list.ts — `realm workflow list`: what is actually in the registry (issue #427).
//
// The registry was a black box. `realm workflow register` wrote into it, everything else read
// from it by id, and nothing showed an operator what was there — so a definition registered
// under an older realm sat there indefinitely and invisibly. A CURRENT-SCHEMA one keeps running,
// grandfathered; an older one is worse than that, because it cannot run at all — every runtime
// consumer resolves through the store's get(), which refuses it. Either way nothing surfaced it
// until something tried to use it. This is the read surface that makes a pre-upgrade audit
// possible: list what you have, then audit each one with
// `realm workflow validate --registered <id>`.
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

/** The SCHEMA column: current, or a legacy marker naming the remedy. */
export function schemaCell(schemaVersion: number | undefined): string {
  if (schemaVersion === CURRENT_WORKFLOW_SCHEMA_VERSION) return `${schemaVersion} (current)`;
  // An absent schema_version predates the field entirely — there is no number to show, and
  // printing `undefined — legacy` would be worse than saying only what is true.
  if (schemaVersion === undefined) return 'legacy (re-register)';
  return `${schemaVersion} — legacy (re-register)`;
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

    const rows = sorted.map((w) => ({
      id: w.id,
      name: w.name,
      version: String(w.version),
      origin: w.origin ?? '-',
      schema: schemaCell(w.schema_version),
    }));

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
    console.log(`\n${rows.length} ${rows.length === 1 ? 'workflow' : 'workflows'} registered.`);

    // The census lines go to stderr: they are not part of the listing a script would consume,
    // and an operator piping stdout should still see them.
    if (unreadable.length > 0) {
      const names = unreadable.map((u) => u.file).join(', ');
      console.warn(
        unreadable.length === 1
          ? `⚠ 1 file in the registry could not be parsed: ${names} — realm cannot audit what it cannot read.`
          : `⚠ ${unreadable.length} files in the registry could not be parsed: ${names} — realm cannot audit what it cannot read.`,
      );
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
