// db-backup.ts — issue #616 PR-2c, unit c6 (design d4-frozen-r3 §8): `realm db backup <path>`. It
// opens the home through the store package's maintenance entry (`openRealmHomeForMaintenance`; not
// the CLI's own door, which is the JSON store's until unit c10a), copies the store file to <path> and
// prints one line. The copy is made by SQLite's `VACUUM INTO` into a file created owner-only first,
// switched to WAL and checked with SQLite's quick check; a path inside the home or where anything
// exists is refused. Every refusal is a typed one, printed by the entry as one `Error:` line with exit
// code 1 (`lib/expected-refusal.ts`). Restoring a copy is a documented procedure, never a command.
import { Command } from 'commander';
import { openRealmHomeForMaintenance } from '@sensigo/realm-store-sqlite';

export const dbBackupCommand = new Command('backup')
  .description('Copy the store file to a new file outside the Realm home, and check the copy')
  .argument('<path>', 'where the copy is written; outside the Realm home, not yet existing')
  .action(async (path: string) => {
    const home = await openRealmHomeForMaintenance();
    try {
      const report = await home.backup(path);
      console.log(
        `Backed up ${home.path} (schema version ${report.schemaVersion}, ${report.bytes} bytes) ` +
          `to ${report.path}; the copy passes SQLite's quick check.`,
      );
    } finally {
      home.close();
    }
  });
