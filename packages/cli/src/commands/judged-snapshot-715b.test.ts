// judged-snapshot-715b.test.ts — issue #715 (b) 02 §B.1 (D6-17) with Amendment 4: `realm run advance`
// judges the lines it prints after its call on the snapshot the engine judged its reply on
// (`judgedSnapshotOf`), and never reads the run again for them. Cell (i)'s composer half (a settle
// interposed between the engine's load and the reply) and cell (iv)'s CLI half (no read by the
// composer).
//
// In-process: the command's body (`advanceRunFromShell`) with a store wrapped so another program ends
// the run right after the engine's load returned its snapshot.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  stripSpanMarks,
  type Attributed,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { advanceRunFromShell } from './run-advance.js';

const HERE: Attributed = { by: 'here-a', by_source: 'stated', channel: 'advance' };

/** `s` (auto: the engine owes it) then `a` (agent): the advance runs `s` and stops at `a`. */
const ONE: WorkflowDefinition = {
  id: 'judged-715b-cli',
  name: 'judged-715b-cli',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    s: { description: 'S.', execution: 'auto', depends_on: [] },
    a: { description: 'A.', execution: 'agent', depends_on: ['s'] },
  },
};

/**
 * The reads one advance makes on this run (measured, 2026-10-30): the command's preview read, the
 * engine's load, `s`'s own load, and the engine's read of the run after `s` — the snapshot its reply
 * is judged on. None after the call.
 */
const READS = 4;

/**
 * One `realm run advance` on a fresh run of `ONE`. When `interpose` is set, another program ends the
 * run (a `seal_run` at the version just read) right AFTER the engine's last read returns (read
 * `READS`) — between the engine's load of the snapshot it judges and its reply. Counts every read.
 */
async function advance(interpose: boolean) {
  const home = mkdtempSync(join(tmpdir(), 'realm-judged-715b-'));
  try {
    const runs = new JsonFileStore(join(home, 'runs'));
    const workflows = new JsonWorkflowStore(join(home, 'wf'));
    await workflows.register(ONE);
    const { record: run } = await runs.create({
      workflowId: ONE.id,
      workflowVersion: 1,
      params: {},
    });
    let gets = 0;
    let fired = false;
    const store = new Proxy(runs, {
      get(target, prop) {
        if (prop === 'get') {
          return async (id: string) => {
            const snap = await target.get(id);
            if (++gets === READS && interpose && !fired) {
              fired = true;
              await target.settleStep(id, {
                kind: 'seal_run',
                arm: 'abandon_requested',
                reason: 'ended by another program',
                expected_version: snap.record.version,
                release_claims: true,
              });
            }
            return snap;
          };
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const lines: string[] = [];
    const code = await advanceRunFromShell(
      run.id,
      { project: home },
      store,
      workflows,
      HERE,
      (l) => lines.push(stripSpanMarks(l)),
      new ExtensionRegistry(),
    );
    const { record: after } = await runs.get(run.id);
    return {
      fired,
      gets,
      code,
      last: lines.at(-1)?.split(run.id).join('<run>'),
      storedPhase: after.run_phase,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('#715 (b) Amendment 4 — realm run advance judges what it prints on the engine’s snapshot', () => {
  it('(i) another program ends the run right after the engine’s load: the last line names the phase the engine judged, not a later read’s', async () => {
    // (a) red when the command reads the run again after the call (its phase line names the
    //     interposed ending, 'abandoned'); (b) prints whether the act fired, the line, the stored phase.
    const r = await advance(true);
    expect({ fired: r.fired, last: r.last, storedPhase: r.storedPhase }).toEqual({
      fired: true,
      last: "Run <run>: phase 'running'",
      // non-vacuity: the other program's write landed — the store holds the ended run.
      storedPhase: 'abandoned',
    });
  });

  it('(iv) the lines after the call read the run no more: one advance makes exactly the reads before and inside the engine call', async () => {
    // (a) red when the command reads the run again after the call (READS + 1); (b) prints the count.
    const r = await advance(false);
    expect(r.gets).toBe(READS);
  });
});
