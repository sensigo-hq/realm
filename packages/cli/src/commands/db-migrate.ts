// db-migrate.ts — issue #616 PR-2c, unit c7 (design d4-frozen-r3 §2 "Schema evolution", §3 "The
// re-stamp", §8): `realm db migrate --backup <path> | --no-backup`. The operator stops Realm and runs
// it; it opens the home through the store package's maintenance entry, for this verb
// (`openRealmHomeForMaintenance({ verb: 'migrate' })`; not the CLI's own door, which is the JSON
// store's until unit c10a), and the handle's `migrate` does the work: `realm db backup`'s copy first
// (or none, stated with `--no-backup`), then each pending schema step in its own transaction, then
// the re-stamp of every run another phase derivation stamped. This file words it: one line per event,
// printed as the event happens, so the lines of the steps that landed are on the terminal before a
// refusal is. Every refusal is a typed one, printed by the entry as one `Error:` line with exit code
// 1 (`lib/expected-refusal.ts`). The two flags are told apart from the RAW arguments: Commander
// folds `--backup <path>` and `--no-backup` into one value (the last wins). #616 R1: neither flag is
// the default backup, in the backups folder beside the home, when a schema step is pending; a migrate
// that ran a step is recorded there (a record that cannot be written is a warning on standard error).
import { Command } from 'commander';
import {
  openRealmHomeForMaintenance,
  stepBackTarget,
  type MigrateProgress,
} from '@sensigo/realm-store-sqlite';
import { rootRawArgs } from '../lib/option-value-guard.js';

/**
 * The line `realm db migrate` prints for one event of the store file `file`. Exported for the cell
 * that holds the step line to the page's words (#597 D1c-1: the built CLI also runs the first real
 * step, from schema version 1 to 2).
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
    case 'recorded':
      return `Recorded this migrate in ${event.path}.`;
    case 'unrecorded':
      return (
        `Could not record this migrate in ${event.path}: ${event.reason}. The file is migrated; ` +
        'the record is only a note for going back.'
      );
    // #616 R2: the step back's lines.
    case 'stepBack': {
      const { from, to, statements } = event.report;
      return (
        `Stepped ${file} back from schema version ${from} to ${to}: ${statements} statement(s) ran, ` +
        `the schema matches version ${to}'s.${event.loses === undefined ? '' : ` ${event.loses}`}`
      );
    }
    case 'nothingToUndo':
      return `${file} is already at schema version ${event.schemaVersion}; no step to undo.`;
    case 'install':
      return (
        'Every command of this Realm that uses the store now refuses the file, because it is at ' +
        `schema version ${event.schemaVersion} and this Realm writes version ${event.realm}. To use ` +
        `it, install a Realm that writes schema version ${event.schemaVersion}: npm install -g ` +
        `"@sensigo/realm-cli@${event.range}" (in a project that lists Realm packages, give every one ` +
        `of them the same version, one in ${event.range}: the guide says all Realm packages must be ` +
        'the same exact version).'
      );
  }
}

export const dbMigrateCommand = new Command('migrate')
  .description(
    "Upgrade the store file to this Realm's schema version, after a backup (with no flag, into the backups folder beside the home); stop every Realm process first",
  )
  .option(
    '--backup <path>',
    'a copy of the store file, made before anything changes; outside the Realm home, not yet existing',
  )
  .option('--no-backup', 'make no copy first: you have one, or you accept the risk')
  .option(
    '--to <n>',
    'step the store file back to schema version <n>, one version at a time, keeping every run; run it with the Realm that wrote the file',
  )
  .action(async (opts: { backup?: string | false; to?: string }, command: Command) => {
    const raw = rootRawArgs(command);
    const noBackup = raw.includes('--no-backup');
    const backup = raw.some((word) => word === '--backup' || word.startsWith('--backup='));
    if (noBackup && backup) {
      console.error('Cannot combine --backup with --no-backup. Use one or the other.');
      process.exit(1);
    }
    // #616 R2: the value is judged before the store is opened (a word that is not a version it knows).
    const to = opts.to === undefined ? undefined : stepBackTarget(opts.to);
    const home = await openRealmHomeForMaintenance({ verb: 'migrate' });
    try {
      await home.migrate({
        // Neither flag: the default backup (R1).
        ...(noBackup ? { backup: false } : backup ? { backup: opts.backup as string } : {}),
        ...(to === undefined ? {} : { to }),
        // The record's warning goes to standard error; every other line is progress, on standard output.
        progress: (event) =>
          (event.kind === 'unrecorded' ? console.error : console.log)(lineOf(home.path, event)),
      });
    } finally {
      home.close();
    }
  });
