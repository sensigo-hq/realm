// output-source-625.test.ts — issue #625 PR-2a, the last prompt's F4, from the built `realm` (a child
// process, a fresh HOME): `realm run inspect` renders one line for a bare `auto` step's entry — where its
// output came from, or why that is not recorded — and `realm run export` writes the record as stored,
// from which a reader derives the same with core's `outputSourceOf`. Each page sentence F4 adds or
// changes is quoted here.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as realmCore from '@sensigo/realm';
import {
  JsonFileStore,
  JsonWorkflowStore,
  advanceRun,
  executeStep,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type EvidenceSnapshot,
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

/** Core's read, off the module so the cell runs before it exists (and fails on that). */
const outputSourceOf = (
  realmCore as { outputSourceOf?: (e: EvidenceSnapshot, d: unknown) => unknown }
).outputSourceOf;

/** `first` (agent); bare `auto` steps `fromDep` (after `first`), `fromParams` (no dependency),
 *  `fromTwo` (after `first` and `second`). */
const WF: WorkflowDefinition = {
  id: 'os-cli-625',
  name: 'os-cli-625',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    first: { description: 'First.', execution: 'agent', depends_on: [] },
    second: { description: 'Second.', execution: 'agent', depends_on: [] },
    fromDep: { description: 'From its one dependency.', execution: 'auto', depends_on: ['first'] },
    fromParams: { description: 'From the params.', execution: 'auto', depends_on: [] },
    fromTwo: {
      description: 'Two dependencies.',
      execution: 'auto',
      depends_on: ['first', 'second'],
    },
  },
};

describe(
  '#625 PR-2a, F4 — realm run inspect says where a bare step’s output came from',
  { timeout: 60_000 },
  () => {
    let home: string;
    let runStore: JsonFileStore;

    beforeEach(async () => {
      home = mkdtempSync(join(tmpdir(), 'realm-os-cli-625-'));
      mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
      mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
      runStore = new JsonFileStore(join(home, '.realm', 'runs'));
      await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(WF);
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

    /** A run where a caller drives `first`, `second` and `fromParams`, and the engine the rest. */
    async function ranAll(): Promise<string> {
      const { run } = await runStore.create({
        workflowId: WF.id,
        workflowVersion: 1,
        params: { x: 1 },
      });
      for (const step of ['first', 'second', 'fromParams']) {
        await executeStep(runStore, WF, {
          runId: run.id,
          command: step,
          input: {},
          dispatcher: async () => ({ out: step }),
        });
      }
      await advanceRun(runStore, WF, { runId: run.id });
      return run.id;
    }

    /** The line under each step's `Output:`, by step: the `Output source:` line, or none. */
    const sourceLines = (out: string[]) => {
      const lines: Record<string, string> = {};
      let step = '';
      for (const l of out) {
        const head = /^\s+\d+\. (\S+)/.exec(l);
        if (head) step = head[1]!;
        else if (l.trim().startsWith('Output source:')) lines[step] = l.trim();
      }
      return lines;
    };

    it('each bare step’s line, from its entry; no line for an agent step’s entry', async () => {
      claim(
        'docs/reference/cli/realm-run-reading.md',
        "| `Output source` | The entry is a bare `auto` step's (no handler, no service) | Where its output came from: `Output source: driven_step — what the call that named the step returned`, `dependency — '<step>''s recorded output`, `run_params — the run's params` or `none — nothing to copy, so {} was recorded`; or, for an entry written before Realm recorded it, `Output source: not recorded — this entry was written before Realm recorded it`. Added after version 0.46.0. |",
      );
      claim(
        'CHANGELOG.md',
        "`realm run inspect` prints `Output source: …` under a bare step's `Output:`; `get_run_state` and `realm run export` show nothing new, each page saying why.",
      );
      claim(
        'docs/reference/run-record-and-export.md',
        '`none` (nothing to copy, so `{}`: the engine ran a step that depends on several steps, or whose one dependency has no successful entry)',
      );
      const id = await ranAll();
      // (a) red when inspect does not render the entry's source, renders it for an agent step, or names
      //     the wrong dependency; (b) prints the lines it rendered.
      expect(sourceLines(realm('run', 'inspect', id).out)).toEqual({
        fromParams: 'Output source: driven_step — what the call that named the step returned',
        fromDep: "Output source: dependency — 'first''s recorded output",
        fromTwo: 'Output source: none — nothing to copy, so {} was recorded',
      });
      const { run: other } = await runStore.create({
        workflowId: WF.id,
        workflowVersion: 1,
        params: {},
      });
      await advanceRun(runStore, WF, { runId: other.id });
      // (a) red when the engine's run of a step with no dependency is not said as the run's params;
      //     (b) prints the line.
      expect(sourceLines(realm('run', 'inspect', other.id).out)['fromParams']).toBe(
        "Output source: run_params — the run's params",
      );
    });

    it('an entry written before the field: `not recorded`, never a source (predates_output_source)', async () => {
      const id = await ranAll();
      const record = await runStore.get(id);
      await runStore.update({
        ...record,
        evidence: record.evidence.map(({ output_source: _old, ...rest }) => rest),
      });
      // (a) red when inspect guesses a source for an entry that carries none, or prints nothing for a
      //     bare step's entry; (b) prints the lines.
      expect(sourceLines(realm('run', 'inspect', id).out)).toEqual({
        fromParams: 'Output source: not recorded — this entry was written before Realm recorded it',
        fromDep: 'Output source: not recorded — this entry was written before Realm recorded it',
        fromTwo: 'Output source: not recorded — this entry was written before Realm recorded it',
      });
    });

    it('realm run export writes the record as stored; a reader derives the source, or why there is none, with core’s outputSourceOf', async () => {
      claim(
        'docs/reference/run-record-and-export.md',
        '`realm run export` writes the record as stored, so a reader of an export derives the absence with that same read.',
      );
      claim(
        'docs/reference/run-record-and-export.md',
        "core's `outputSourceOf(entry, definition)` gives the source or why there is none (`not_an_output_entry`, `definition_unavailable`, `not_a_bare_step`, `predates_output_source`).",
      );
      const id = await ranAll();
      const out = join(home, 'bundle.json');
      const r = realm('run', 'export', id, '--out', out);
      expect(r.code, r.err.join('\n')).toBe(0);
      const bundle = JSON.parse(readFileSync(out, 'utf8')) as {
        run: { evidence: EvidenceSnapshot[] };
      };
      const reads = Object.fromEntries(
        bundle.run.evidence.map((e) => [
          e.step_id,
          outputSourceOf?.(e, WF) ?? '<no outputSourceOf>',
        ]),
      );
      // (a) red when the export drops or rewrites `output_source`, or the read is not exported;
      //     (b) prints each entry's read.
      expect(reads).toEqual({
        first: { absent_cause: 'not_a_bare_step' },
        second: { absent_cause: 'not_a_bare_step' },
        fromParams: { source: 'driven_step' },
        fromDep: { source: 'dependency' },
        fromTwo: { source: 'none' },
      });
    });
  },
);
