// operator-ending-625.test.ts — issue #625 PR-2a, the last prompt's F2, from the built `realm` (a child
// process, a fresh HOME) and the drivers' own composers: on a run an operator ended, `realm run respond`
// and `realm run advance` offer no `realm run resume` and say the operator's ending and its reason;
// the hand-back of `realm workflow run` and `realm agent` says it as a line of its own (`Ended:`);
// `realm run inspect` still names the fact, with what resuming does (the operator's own read surface);
// `realm run purge` still counts the run as resumable. Each page sentence F2 changes is quoted here.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  abandonRun,
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  describePending,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { renderDetachMap } from './run.js';
import { runAgent } from '../agent/run-agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';

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

/** `a`, `b` (agent steps), `c` after `b` — the reviewer's workflow (`probes/a1/wf2`). */
const TWO: WorkflowDefinition = {
  id: 'two-branch',
  name: 'Two branches',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'agent', depends_on: [] },
    c: { description: 'C.', execution: 'agent', depends_on: ['b'] },
  },
};

const REASON = 'wrong run\nPhase: completed\u001b[31m RED';
const SHOWN = '"wrong run\\nPhase: completed\\u001b[31m RED"';
const SENTENCE = `An operator ended this run, with the reason ${SHOWN}; to run the work again, start a new run.`;

describe('#625 PR-2a, F2 — the CLI on a run an operator ended', { timeout: 60_000 }, () => {
  let home: string;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-op-625-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
    runStore = new JsonFileStore(join(home, '.realm', 'runs'));
    workflowStore = new JsonWorkflowStore(join(home, '.realm', 'workflows'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  function realm(...args: string[]) {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: r.status, out: r.stdout.split('\n'), err: r.stderr.split('\n') };
  }

  /** A run whose step `a` failed, then an operator abandoned it with {@link REASON}. */
  async function abandoned(): Promise<RunRecord> {
    await workflowStore.register(TWO);
    const { run } = await runStore.create({ workflowId: TWO.id, workflowVersion: 1, params: {} });
    await runStore.update({ ...(await runStore.get(run.id)), failed_steps: ['a'] });
    return abandonRun(runStore, run.id, REASON);
  }

  it('realm run respond: the refusal says the operator’s ending and its reason, on one line — no realm run resume (discrimination)', async () => {
    claim(
      'CHANGELOG.md',
      '**A run an operator ended is never offered `realm run resume` (issue #625, PR-2a).**',
    );
    claim(
      'CHANGELOG.md',
      'for a failed one in which a step failed; for an abandoned one, that an operator ended it, its reason, and that a new run runs the work again, or that preview.',
    );
    const run = await abandoned();
    const r = realm('run', 'respond', run.id, '--gate', 'g-old', '--choice', 'yes');
    const err = r.err.filter((l) => l !== '');
    // (a) red when the refusal offers the undo, drops the reason, or prints it raw over two lines;
    //     (b) prints stderr and the exit.
    expect({ code: r.code, err }).toEqual({
      code: 1,
      err: [
        `Run '${run.id}' is terminal (abandoned); cannot submit a gate response — an operator ended this run, with the reason ${SHOWN}; to run the work again, start a new run; 'realm run purge ${run.id}' previews what it would remove.`,
      ],
    });
  });

  it('realm run advance: the ended reason goes on with the operator’s ending, never the undo (discrimination)', async () => {
    claim(
      'docs/reference/cli/realm-run-acting.md',
      'when an operator ended it, it goes on `. An operator ended this run, with the reason "<reason>"; to run the work again, start a new run.`, never with `realm run resume`, which would erase that ending and its reason)',
    );
    const run = await abandoned();
    const r = realm('run', 'advance', run.id);
    const reason = r.out.find((l) => l.startsWith('Nothing is owed to the engine: ')) ?? '<none>';
    // (a) red when advance offers `realm run resume` for the operator's ending, or drops the ending;
    //     (b) prints the line.
    expect(reason).toBe(
      `Nothing is owed to the engine: the run has ended (abandoned). ${SENTENCE}`,
    );
    expect(r.out.join('\n')).not.toContain('realm run resume');
  });

  it('realm run inspect: the Resumable: line still names the fact, with what resuming does (discrimination for the warning)', async () => {
    claim(
      'docs/reference/cli/realm-run-reading.md',
      "For a run an operator ended (`abandoned`), the `Resumable:` line goes on `— resuming erases the operator's ending and its reason, and records no one and no reason for the undo`. No other surface offers `realm run resume` for such a run.",
    );
    claim(
      'CHANGELOG.md',
      "`realm run purge`'s preview and `realm run inspect` read it, and every offer of `realm run resume` reads it through `offeredResumeWay`, which offers it only for a run an engine failure ended.",
    );
    const run = await abandoned();
    const line = realm('run', 'inspect', run.id).out.find((l) => l.startsWith('Resumable: '));
    // (a) red when the warning is missing, or inspect stops naming the fact; (b) prints the line.
    expect(line).toBe(
      `Resumable: 'a' — realm run resume ${run.id} --from a — resuming erases the operator's ending and its reason, and records no one and no reason for the undo`,
    );
  });

  it('realm run purge (the dry run) still counts a run an operator ended as resumable (preservation)', async () => {
    const run = await abandoned();
    const r = realm('run', 'purge', run.id);
    // (a) red when purge's preview stops reading the fact; (b) prints stdout.
    expect(r.out.join('\n'), r.out.join('\n')).toContain(
      "1 of 1 selected run(s) are resumable via 'realm run resume'",
    );
  });

  it('realm workflow run’s hand-back: `Ended:` with the operator’s ending in place of `Resume:` (discrimination); a failed run keeps `Resume:` (preservation)', async () => {
    claim(
      'docs/reference/cli/realm-workflow.md',
      'When an operator ended the run, that line is `  Ended:     An operator ended this run, with the reason "<reason>"; to run the work again, start a new run.`, never `realm run resume`, which would erase that ending and its reason.',
    );
    claim(
      'CHANGELOG.md',
      "`Resume: realm run resume <run> --from <step>` above `Inspect` for a run an engine failure ended with a failed step resume takes (`Ended:` with the operator's ending and its reason for a run an operator ended);",
    );
    const run = await abandoned();
    const failed = {
      ...run,
      run_phase: 'failed',
      sealed_by: { arm: 'step_failure', step: 'a' },
      abandoned_at: undefined,
    } as unknown as RunRecord;
    const ways = { pending: describePending(TWO, run, undefined, new Date()), workflow: TWO };
    // (a) red when the map offers the undo for the operator's ending, or drops `Resume:` for an engine
    //     failure; (b) prints both maps' lines after the headline.
    expect({
      abandoned: renderDetachMap(run, 'b', ways).split('\n').slice(1),
      failed: renderDetachMap(failed, 'b', ways).split('\n').slice(1),
    }).toEqual({
      abandoned: [`  Ended:     ${SENTENCE}`, `  Inspect:   realm run inspect ${run.id}`],
      failed: [
        `  Resume:    realm run resume ${run.id} --from a`,
        `  Inspect:   realm run inspect ${run.id}`,
      ],
    });
  });

  it('realm agent whose run an operator ends during the drive: `Ended:` with the ending, no `Resume:` (discrimination)', async () => {
    claim(
      'docs/reference/cli/realm-agent.md',
      'When an operator ended the run, that line is `  Ended:     An operator ended this run, with the reason "<reason>"; to run the work again, start a new run.`, never `realm run resume`, which would erase that ending and its reason.',
    );
    await workflowStore.register(TWO);
    const { run } = await runStore.create({ workflowId: TWO.id, workflowVersion: 1, params: {} });
    await runStore.update({ ...(await runStore.get(run.id)), failed_steps: ['a'] });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // The model is asked for step `b`; while it answers, an operator abandons the run.
    const provider = new (class extends LlmProvider {
      callStep = vi.fn(async () => {
        await abandonRun(runStore, run.id, REASON);
        return {};
      });
    })();
    await runAgent(
      { store: runStore, workflowStore, provider, registry: createDefaultRegistry() },
      { definition: TWO, existingRunId: run.id, params: {}, pollIntervalMs: 20 },
    );
    const printed = errSpy.mock.calls.map((c) => String(c[0]));
    // (a) red when the drive's stop offers the undo, or says no ending; (b) prints stderr.
    expect(
      printed.filter((l) => l.includes('Ended:') || l.includes('Resume:')),
      printed.join('\n'),
    ).toEqual([`  Ended:     ${SENTENCE}`]);
    expect((await runStore.get(run.id)).run_phase, 'fixture: the operator ended the run').toBe(
      'abandoned',
    );
  });
});
