// db-migrate.ts — issue #616 PR-2c, unit c7 (design d4-frozen-r3 §2 "Schema evolution", §3 "The
// re-stamp", §8): `realm db migrate --backup <path> | --no-backup`. The operator stops Realm and runs
// it; it opens the home through the store package's maintenance entry, for this verb
// (`openRealmHomeForMaintenance({ verb: 'migrate' })`; not the CLI's own door, which is the JSON
// store's until unit c10a), and the handle's `migrate` does the work: `realm db backup`'s copy first
// (or none, stated with `--no-backup`), then each pending schema step in its own transaction, then
// the re-stamp of every run another phase derivation stamped. This file words it: one line per event,
// printed as the event happens, so the lines of the steps that landed are on the terminal before a
// refusal is. Every refusal is a typed one, printed by the entry as one `Error:` line with exit code
// 1 (`lib/expected-refusal.ts`). One of the two flags is required, and they are told apart from the
// RAW arguments: Commander folds `--backup <path>` and `--no-backup` into one value (the last wins).
import { Command } from 'commander';
import { openRealmHomeForMaintenance, type MigrateProgress } from '@sensigo/realm-store-sqlite';
import { rootRawArgs } from '../lib/option-value-guard.js';

/**
 * The line `realm db migrate` prints for one event of the store file `file`. Exported for the cell
 * that holds the step line to the page's words: no step can run on the built CLI while only schema
 * version 1 exists.
 */
export function lineOf(file: string, event: MigrateProgress): string {
  switch (event.kind) {
    case 'backup':
      // `realm db backup`'s line, unchanged.
      return (
        `Backed up ${file} (schema version ${event.report.schemaVersion}, ${event.report.bytes} bytes) ` +
        `to ${event.report.path}; the copy passes SQLite's quick check.`
      );
    case 'step': {
      const { from, to, statements, evidenceChecked } = event.report;
      return (
        `Migrated ${file} from schema version ${from} to ${to}: ${statements} statement(s) ran, the ` +
        `schema matches version ${to}'s, ${evidenceChecked} evidence entries match their stored hashes.`
      );
    }
    case 'current':
      return `${file} is already at schema version ${event.schemaVersion}; no schema step to run.`;
    case 'restamped':
      return `Re-stamped the phase index of ${event.runs} run(s) with the current derivation.`;
  }
}

export const dbMigrateCommand = new Command('migrate')
  .description(
    "Upgrade the store file to this Realm's schema version, after a backup; stop every Realm process first",
  )
  .option(
    '--backup <path>',
    'a copy of the store file, made before anything changes; outside the Realm home, not yet existing',
  )
  .option('--no-backup', 'make no copy first: you have one, or you accept the risk')
  .action(async (opts: { backup?: string | false }, command: Command) => {
    const raw = rootRawArgs(command);
    const noBackup = raw.includes('--no-backup');
    const backup = raw.some((word) => word === '--backup' || word.startsWith('--backup='));
    if (noBackup && backup) {
      console.error('Cannot combine --backup with --no-backup. Use one or the other.');
      process.exit(1);
    }
    if (!noBackup && (!backup || typeof opts.backup !== 'string')) {
      console.error(
        'Provide --backup <path> (a copy of the store file, made before anything changes) or --no-backup.',
      );
      process.exit(1);
    }
    const home = await openRealmHomeForMaintenance({ verb: 'migrate' });
    try {
      await home.migrate({
        backup: noBackup ? false : (opts.backup as string),
        progress: (event) => console.log(lineOf(home.path, event)),
      });
    } finally {
      home.close();
    }
  });
