// t21-729.test.ts — issue #729 PR-0 (D4 T-21, #742; A-5): "the definition is reachable" is a
// precondition of every definition-reading way; when it fails, the run's ways list
// `definition_absent { cause }` with the remedy `[register { workflow_id, path? }]`. `path` only
// where the registry knows the file (an unreadable, invalid or legacy copy); the not-found arms say
// why no path exists. The registrar's not-registered arm (`:681-688`, the one #742 reported: it named
// `realm agent`'s `--register` to a `realm workflow run` run) renders the entry's own words.
//
// Each damaged copy is built from the OS up (as `registrar-probe.test.ts`'s shapes are). Every
// assertion carries (a) the change that turns it red and (b) what it prints on failure: codes,
// causes and booleans — paths only as "carried or not".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonWorkflowStore } from './registrar.js';
import { definitionAbsenceOf, getWorkflowForRun } from './registrar.js';
import { renderDefinitionAbsent } from '../engine/ways.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunRecord } from '../types/run-record.js';

const runOf = (workflowId: string): RunRecord =>
  ({
    id: 'r1',
    workflow_id: workflowId,
    params: {},
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    evidence: [],
    terminal_state: false,
    version: 1,
    workflow_version: 1,
    run_phase: 'running',
    created_at: '2026-10-16T12:00:00.000Z',
    updated_at: '2026-10-16T12:00:00.000Z',
  }) as unknown as RunRecord;

const OPTS = { retryVerb: 'retry', verb: 'advance' };

let dir: string;
let store: JsonWorkflowStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'realm-t21-729-'));
  store = new JsonWorkflowStore(dir);
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

/** The thrown error of a definition read on `run`. */
async function thrown(run: RunRecord): Promise<WorkflowError> {
  try {
    await getWorkflowForRun(store, run, OPTS);
  } catch (err) {
    if (err instanceof WorkflowError) return err;
    throw err;
  }
  throw new Error('fixture: the definition was read');
}

describe('#729 PR-0 — T-21: the definition is reachable, or the ways say why and how', () => {
  it('not registered (a run from a file): the entry’s own words name why no path exists; the remedy is register, with no path', async () => {
    const run = runOf('my-flow');
    const err = await thrown(run);
    const absence = definitionAbsenceOf(err, run);
    // (a) red when the arm's old hint is restored (it named `--register`, a flag `realm workflow
    //     run` lacks), or the remedy is lost; (b) prints the code, the cause and booleans.
    expect({
      code: err.code,
      startsWithEntry: err.message.startsWith(
        `${renderDefinitionAbsent({ workflow_id: 'my-flow', cause: 'not_registered' })}. `,
      ),
      saysWhyNoPath: err.message.includes('so no path to it is recorded'),
      namesFlag: err.message.includes('--register'),
      remedy: (err.remedy ?? []).map((w) => [w.verb, 'path' in w]),
      absence,
    }).toEqual({
      code: 'STATE_WORKFLOW_NOT_FOUND',
      startsWithEntry: true,
      saysWhyNoPath: true,
      namesFlag: false,
      remedy: [['register', false]],
      absence: { absent: 'not_registered', workflow_id: 'my-flow' },
    });
  });

  it('an agent-created copy gone: agent_copy_gone — no source file to register', async () => {
    const run = runOf('summary-0123456789abcdef');
    const err = await thrown(run);
    // (a) red when the agent arm loses its cause; (b) prints the cause and a boolean.
    expect({
      absence: definitionAbsenceOf(err, run)?.absent,
      noFile: err.message.includes('there is no source file to register'),
    }).toEqual({ absence: 'agent_copy_gone', noFile: true });
  });

  it('the three path-carrying arms: an unreadable, an invalid and a legacy copy carry the file’s path', async () => {
    const file = join(dir, 'flow.json');
    const cases: [string, () => Promise<void>, string][] = [
      [
        'unreadable',
        async () => {
          await writeFile(file, '{}');
          await chmod(file, 0o000);
        },
        'STATE_WORKFLOW_UNREADABLE',
      ],
      [
        'format_invalid',
        async () => {
          await chmod(file, 0o600).catch(() => undefined);
          await writeFile(file, '{"a"');
        },
        'RESOURCE_FORMAT_INVALID',
      ],
      [
        'legacy',
        async () => {
          await writeFile(file, JSON.stringify({ id: 'flow', version: 1, steps: [] }));
        },
        'STATE_LEGACY_FORMAT',
      ],
    ];
    const found: unknown[] = [];
    for (const [cause, make, code] of cases) {
      await make();
      const run = runOf('flow');
      const err = await thrown(run);
      const absence = definitionAbsenceOf(err, run);
      found.push([cause, err.code === code, absence?.absent, absence?.path === file]);
    }
    // (a) red when an arm drops the path the registry knows, or names the wrong cause; (b) prints
    //     the cause, whether the code matched, the absence and whether the path is the file's.
    expect(found).toEqual([
      ['unreadable', true, 'unreadable', true],
      ['format_invalid', true, 'format_invalid', true],
      ['legacy', true, 'legacy', true],
    ]);
  });
});
