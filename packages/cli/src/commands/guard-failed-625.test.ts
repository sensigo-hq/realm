// guard-failed-625.test.ts — issue #625 PR-2a, the last prompt's F8 (review G2-R2): `realm run advance`
// says a guard that failed the run as a step that failed, and exits 1. A guard's resolution error inside
// the call (decided by the call's own loop, or by the write of a step the call ran) ended the run
// `failed` with exit 0 and no `'<guard>' failed:` line, while an `auto` step's failure prints one and
// exits 1. Round 26's rule ("failed" from the record) now covers the guards the call decided.
//
// In-process: the command's body (`advanceRunFromShell`) on a fresh store.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { advanceRunFromShell } from './run-advance.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ACTING = 'docs/reference/cli/realm-run-acting.md';

/** (a) red when the page no longer holds the sentence word for word; (b) prints it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});

/** A guard after `p` whose path finds nothing in `p`'s output (`{}`): a resolution error. */
const GUARD = {
  description: 'G.',
  execution: 'guard',
  depends_on: ['p'],
  abort_unless: ['p.ok == true'],
} as StepDefinition;
const AFTER = { description: 'T.', execution: 'auto', depends_on: ['g'] } as StepDefinition;

/**
 * One `realm run advance` on a fresh run of `def`; `prep` acts on the run first. `lines` are the
 * command's lines from its `Owed to the engine:` line on, the run id as `<run>`.
 */
async function advance(
  def: WorkflowDefinition,
  prep?: (runs: JsonFileStore, runId: string) => Promise<void>,
  registry = new ExtensionRegistry(),
) {
  const home = mkdtempSync(join(tmpdir(), 'realm-guard-failed-625-'));
  try {
    const runs = new JsonFileStore(join(home, 'runs'));
    const workflows = new JsonWorkflowStore(join(home, 'wf'));
    await workflows.register(def);
    const { run } = await runs.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await prep?.(runs, run.id);
    const lines: string[] = [];
    const code = await advanceRunFromShell(
      run.id,
      { project: home },
      runs,
      workflows,
      undefined,
      (l) => lines.push(l),
      registry,
    );
    const after = await runs.get(run.id);
    const from = lines.findIndex((l) => l.startsWith('Owed to the engine:'));
    return {
      code,
      lines: lines.slice(from).map((l) => l.split(run.id).join('<run>')),
      failed: after.failed_steps,
      phase: after.run_phase,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** `p` recorded by a plain write that decides no guard, so the call's own loop decides `g`. */
async function pRecordedWithoutItsGuard(runs: JsonFileStore, runId: string): Promise<void> {
  const cur = await runs.get(runId);
  const now = new Date().toISOString();
  await runs.update({
    ...cur,
    completed_steps: ['p'],
    evidence: [
      ...cur.evidence,
      {
        step_id: 'p',
        started_at: now,
        completed_at: now,
        duration_ms: 0,
        input_summary: {},
        output_summary: {},
        status: 'success',
        evidence_hash: 'f8',
      },
    ],
  });
}

const REASON = "Guard resolution error: unresolvable path 'p.ok' (condition: p.ok == true)";

describe('#625 PR-2a, F8 — realm run advance says a guard that failed the run as a step that failed, and exits 1', () => {
  it.each([
    [
      'the call’s own loop decides the guard',
      wf('f8-loop', {
        p: { description: 'P.', execution: 'agent', depends_on: [] },
        g: GUARD,
        t: AFTER,
      }),
      pRecordedWithoutItsGuard,
      ["Owed to the engine: 'g'."],
    ],
    [
      'the write of a step the call ran decides the guard',
      wf('f8-write', {
        p: { description: 'P.', execution: 'auto', depends_on: [] },
        g: GUARD,
        t: AFTER,
      }),
      undefined,
      ["Owed to the engine: 'p'.", '→ p'],
    ],
  ] as const)(
    "%s: `Stopped: 'g' failed: <its reason>`, first of the stop lines; exit 1",
    async (_shape, def, prep, head) => {
      claim(
        ACTING,
        "A guard that failed — its path found nothing — is a step that failed: a `Stopped: '<guard>' failed: <reason>` line follows, and the exit code is 1, as for an `auto` step that failed.",
      );
      const r = await advance(def, prep);
      // (a) red when the guard that failed the run is not said as a step that failed, or the exit code
      //     is 0 (G2-R2); (b) prints the lines, the exit code and the record's failed steps.
      expect(r).toEqual({
        code: 1,
        lines: [
          ...head,
          "Guard step 'g' failed with a resolution error. Run is terminated.",
          `Reason: ${REASON}`,
          `Stopped: 'g' failed: ${REASON}`,
          "Stopped: the run has ended (failed) — to make 'g' runnable again: realm run resume <run> --from g",
          "Run <run>: phase 'failed'",
        ],
        failed: ['g'],
        phase: 'failed',
      });
    },
  );

  it("the same form as an `auto` step that failed (preservation): `Stopped: 'a' failed: <error>`, exit 1", async () => {
    const boom = new ExtensionRegistry();
    boom.register('handler', 'boom', {
      id: 'boom',
      execute: async () => {
        throw new Error('it broke');
      },
    });
    const r = await advance(
      wf('f8-auto', {
        a: { description: 'A.', execution: 'auto', handler: 'boom', depends_on: [] },
      }),
      undefined,
      boom,
    );
    // (a) red when an `auto` step's failure loses its line or its exit code; (b) prints them.
    expect({
      code: r.code,
      failedLine: r.lines.filter((l) => l.startsWith("Stopped: 'a' failed:")),
    }).toEqual({
      code: 1,
      failedLine: ["Stopped: 'a' failed: Handler 'boom' threw: it broke"],
    });
  });

  it('a guard that aborted the run did not fail (preservation): no failed line, exit 0', async () => {
    const no = new ExtensionRegistry();
    no.register('handler', 'no', { id: 'no', execute: async () => ({ data: { ok: false } }) });
    const r = await advance(
      wf('f8-abort', {
        p: { description: 'P.', execution: 'auto', handler: 'no', depends_on: [] },
        g: GUARD,
        t: AFTER,
      }),
      undefined,
      no,
    );
    // (a) red when a guard that aborted the run is said as failed, or its exit code is 1; (b) prints
    //     the stop lines, the exit code and the phase.
    expect({
      code: r.code,
      stops: r.lines.filter((l) => l.startsWith('Stopped:')),
      failed: r.failed,
      phase: r.phase,
    }).toEqual({
      code: 0,
      stops: ['Stopped: the run has ended (aborted)'],
      failed: [],
      phase: 'aborted',
    });
  });
});
