// db-restore.ts — #616 R1b (prompts/feat-616-r1b-restore.md): `realm db restore <backup>`. It opens
// the home through the store package's maintenance entry for this verb
// (`openRealmHomeForMaintenance({ verb: 'restore' })`), and the handle's `restore` does the work: the
// backup is proven in a scratch folder before anything of the home is touched; the file it replaces is
// kept in the backups folder beside the home (never deleted); no other process may have it open; then
// one rename puts the backup in place. There is no confirmation prompt: nothing is destroyed, and the
// person who runs the command is the decision. This file words it: the kept copy's line as it
// happens, then the restored line, how the two files' runs differ, and, for a backup older than this
// Realm, what comes next, all on standard output. Every refusal is a typed one, printed by the entry as
// one `Error:` line with exit code 1 (`lib/expected-refusal.ts`).
import { Command } from 'commander';
import {
  openRealmHomeForMaintenance,
  type RestoreProgress,
  type RestoreReport,
} from '@sensigo/realm-store-sqlite';

/** The line `realm db restore` prints for one event of the store file `file`, as it happens. */
export function progressLine(file: string, event: RestoreProgress): string {
  // `realm db backup`'s line, unchanged, for the kept copy.
  return (
    `Backed up ${file} (schema version ${event.report.schemaVersion}, ${event.report.bytes} bytes) ` +
    `to ${event.report.path}; the copy passes SQLite's quick check.`
  );
}

/** The lines `realm db restore` prints once the backup is in place, in order. */
export function reportLines(report: RestoreReport): string[] {
  const { onlyReplaced, changed, onlyRestored } = report.replaced.difference;
  const lines = [
    `Restored ${report.path} from ${report.backup} (schema version ${report.schemaVersion}).`,
    onlyReplaced === 0 && changed === 0 && onlyRestored === 0
      ? 'The file it replaced and the backup hold the same runs.'
      : `The file it replaced had ${onlyReplaced} run(s) the backup lacks and ${changed} that ` +
        `differ; the backup has ${onlyRestored} it lacked (they are back). The replaced file is ` +
        'the copy above. Only runs are counted.',
  ];
  if (report.schemaVersion < report.writes) {
    lines.push(
      `This backup is at schema version ${report.schemaVersion} and this Realm writes version ` +
        `${report.writes}. To use it with this Realm, run \`realm db migrate\`; to use it with an ` +
        'older Realm, install that Realm now.',
    );
  }
  return lines;
}

export const dbRestoreCommand = new Command('restore')
  .description(
    'Put a backup in place of the store file; the file it replaces is kept in the backups folder beside the home',
  )
  .argument(
    '<backup>',
    'the backup to put back: a copy `realm db backup` or `realm db migrate` made',
  )
  .action(async (backup: string) => {
    const home = await openRealmHomeForMaintenance({ verb: 'restore' });
    try {
      const report = await home.restore(backup, (event) =>
        console.log(progressLine(home.path, event)),
      );
      for (const line of reportLines(report)) console.log(line);
    } finally {
      home.close();
    }
  });
