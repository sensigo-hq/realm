// purge-preview-625.test.ts — issue #625 PR-2a, the last prompt's F3 (framework A.3 #10, R10: a destructive
// act shows its blast radius first; review A1-S1): the refusal of an answer to an ended run names
// `realm run purge <id>` — the preview, which says what it would remove and removes nothing — never
// `realm run purge <id> --force`. Run as the built `realm` (a child process, a fresh HOME): the refusal
// is read, the command it names is run as printed, and the record is still there.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  abandonRun,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const ONE: WorkflowDefinition = {
  id: 'purge-preview',
  name: 'purge-preview',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
};

describe(
  '#625 PR-2a, F3 — a refusal names the purge preview, never --force',
  { timeout: 60_000 },
  () => {
    let home: string;
    let runStore: JsonFileStore;

    beforeEach(async () => {
      home = mkdtempSync(join(tmpdir(), 'realm-purge-625-'));
      mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
      runStore = new JsonFileStore(join(home, '.realm', 'runs'));
      await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(ONE);
    });
    afterEach(() => rmSync(home, { recursive: true, force: true }));

    function realm(...args: string[]) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: home,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { code: r.status, out: r.stdout.split('\n'), err: r.stderr.split('\n') };
    }

    /** A run that ended as `how`: aborted, abandoned by an operator, or failed with no step to resume. */
    async function ended(how: 'aborted' | 'abandoned' | 'failed'): Promise<RunRecord> {
      const { run } = await runStore.create({ workflowId: ONE.id, workflowVersion: 1, params: {} });
      if (how === 'abandoned') return abandonRun(runStore, run.id, 'stopped');
      return runStore.update({
        ...(await runStore.get(run.id)),
        terminal_state: true,
        run_phase: how,
        ...(how === 'aborted'
          ? {
              aborted_at: { step_id: 'a', message: 'stopped' },
              sealed_by: { arm: 'handler_abort', step: 'a' },
            }
          : { sealed_by: { arm: 'step_failure', step: 'a' } }),
      } as RunRecord);
    }

    it.each(['aborted', 'abandoned', 'failed'] as const)(
      'an answer to a %s run: the refusal names `realm run purge <id>` and says it previews; that command, run as printed, removes nothing',
      async (how) => {
        claim(
          'docs/reference/workflow/gates.md',
          "an aborted run is never resumed; 'realm run purge 063dee23-e68e-4d7f-bcc2-968dd764370c' previews what it would remove",
        );
        claim(
          'docs/reference/cli/realm-run-acting.md',
          "an aborted run is never resumed; 'realm run purge 00b33778-…' previews what it would remove.`",
        );
        claim(
          'CHANGELOG.md',
          "The purge it names is the preview, `'realm run purge <id>' previews what it would remove`, never `--force`.",
        );
        const run = await ended(how);
        const r = realm('run', 'respond', run.id, '--gate', 'g-old', '--choice', 'yes');
        const refusal = r.err.filter((l) => l !== '').join('\n');
        const named = /'(realm run purge [^']+)' previews what it would remove/.exec(refusal)?.[1];
        // (a) red when the refusal names `--force` or says the record is removed; (b) prints it.
        expect({
          forced: refusal.includes('--force'),
          removes: refusal.includes('removes its record'),
          named,
        }).toEqual({ forced: false, removes: false, named: `realm run purge ${run.id}` });
        const preview = realm(...(named ?? 'realm').split(' ').slice(1));
        // (a) red when the command it names deletes the run, or does not say what it would remove;
        //     (b) prints its output and whether the record is still there.
        expect({
          code: preview.code,
          would: preview.out.some((l) => l.includes('WOULD be purged')),
          kept: existsSync(join(home, '.realm', 'runs', `${run.id}.json`)),
        }).toEqual({ code: 0, would: true, kept: true });
      },
    );
  },
);
