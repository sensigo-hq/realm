// rollback.ts — issue #616 R3 (prompts/feat-616-r3-rollback.md; PAGE-UPGRADE v3, "`realm rollback`,
// after 0.50.0"): `realm rollback`, a top-level command with no options. A person types it after an
// upgrade, with every Realm process stopped: it reads the last migrate recorded for this home in
// `migrations.jsonl` (R1's record) and, when the store file is at that migrate's schema version, runs
// exactly what `realm db migrate --to <the version before it>` runs (the store package's one flow,
// given the record line). It is registered in `storeTopLevelCommands`, not `topLevelCommands`, so
// realm-cloud's CLI, which registers that list, does not get it. Every refusal is a typed one, printed
// by the entry as one `Error:` line with exit code 1 (`lib/expected-refusal.ts`).
import { Command } from 'commander';
import { openRealmHomeForMaintenance } from '@sensigo/realm-store-sqlite';
import { lineOf } from './db-migrate.js';

export const rollbackCommand = new Command('rollback')
  .description(
    'Undo the last migrate of this home: step the store file back to the version before it, using the record realm db migrate kept; stop every Realm process first',
  )
  .action(async () => {
    const home = await openRealmHomeForMaintenance({ verb: 'rollback' });
    try {
      await home.rollback({
        // As `realm db migrate`: the record's warning on standard error, every other line on standard
        // output, each as it happens.
        progress: (event) =>
          (event.kind === 'unrecorded' ? console.error : console.log)(lineOf(home.path, event)),
      });
    } finally {
      home.close();
    }
  });
