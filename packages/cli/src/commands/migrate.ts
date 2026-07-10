// realm workflow migrate — back-fills origin: 'human' on local workflow JSON files.
import { Command } from 'commander';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { atomicWriteFile } from '@sensigo/realm';

export const migrateCommand = new Command('migrate')
  .description(
    'Back-fill origin field on local workflow definitions that predate provenance tracking',
  )
  .action(async () => {
    const workflowsDir = join(homedir(), '.realm', 'workflows');
    if (!existsSync(workflowsDir)) {
      console.log('No local workflow store found. Nothing to migrate.');
      return;
    }

    const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) {
      console.log('No workflow files found. Nothing to migrate.');
      return;
    }

    let migrated = 0;
    let skipped = 0;

    for (const file of files) {
      const filePath = join(workflowsDir, file);
      let definition: Record<string, unknown>;
      try {
        definition = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      } catch (err) {
        console.warn(
          `Skipping ${file}: could not parse JSON — ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }

      if ('origin' in definition) {
        skipped++;
        continue;
      }

      definition.origin = 'human';
      await atomicWriteFile(filePath, JSON.stringify(definition, null, 2));
      console.log(`Migrated: ${file}`);
      migrated++;
    }

    console.log(`Done. ${migrated} migrated, ${skipped} already up to date.`);
  });
