// pathless-repair-616c5c.test.ts — #616 PR-2c c5c: a registry refusal whose copy has no file (a
// database's row) names no file to remove. The states are told apart by the refusal's own fields:
//   1. a file path (the JSON registry): the act, "if it was never registered from a source, remove
//      the file (rm <path>) instead", and the command `rm <path>` — unchanged, pinned in
//      `registrar-probe.test.ts` and the readers' own files;
//   2. no path, with `details.fault` (B2's `storedCopyFaultError`, the only builder that carries it):
//      the re-register act alone — no alternative, no command;
//   3. no path, no `fault` (the SQLite registry's damaged pointer, or any other registrar's): no act,
//      since its message carries its own way on (LAW-r). That refusal is private to store-sqlite, so
//      its composed words are pinned there, on the real registry
//      (`packages/store-sqlite/src/pathless-repair-616c5c.test.ts`); here a copy of it stands in.
//
// Each assertion carries (a) the break that turns it red and (b) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import { declared } from '../test-support/declared.js';
import { WorkflowError } from '../types/workflow-error.js';
import type { RunRecord } from '../types/run-record.js';
import { getWorkflowForRun, repairActFor, storedCopyFaultError } from './registrar.js';

const REREGISTER =
  're-register the workflow from its source (realm workflow register <path-to-workflow>)';

/** State 2: B2's refusal of a damaged copy that has no file. */
const damagedRow = (): WorkflowError =>
  storedCopyFaultError('wf', { kind: 'not_a_workflow', fault: 'no_steps' });

/** State 3: a copy of the SQLite registry's damaged-pointer refusal (`damagedPointerError`,
 *  store-sqlite `workflow-store.ts:73-86`, private to its module): its code, details and message. */
const damagedPointer = (): WorkflowError =>
  new WorkflowError(
    "The registered copy of workflow 'wf' is missing from the store or is not JSON: something " +
      'other than Realm changed the database. Register the workflow again from its source; if ' +
      'this message comes back, restore the database from a backup.',
    {
      code: 'RESOURCE_FORMAT_INVALID',
      category: 'RESOURCE',
      agentAction: 'stop',
      retryable: false,
      details: { workflowId: 'wf' },
    },
  );

function makeRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    workflow_id: 'wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
    ...over,
  };
}

/** The composed refusal of `run` when the registry throws `err`: its message, and whether a repair
 *  command rides its details. */
async function composed(
  err: WorkflowError,
  run: RunRecord,
): Promise<{ message: string; repair_command: boolean }> {
  const store = declared({
    get: async (): Promise<never> => {
      throw err;
    },
  });
  const got = (await getWorkflowForRun(store, run, { retryVerb: 'retry', verb: 'run' }).catch(
    (e: unknown) => e,
  )) as WorkflowError;
  return { message: got.message, repair_command: 'repair_command' in got.details };
}

describe('#616 PR-2c c5c — the repair act for a registry refusal with no file path', () => {
  it('state 2 (no path, a fault): the re-register act alone — no alternative, no command', () => {
    // (a) red when the pathless branch is removed: the alternative "remove the file (rm ) instead"
    //     and the command "rm " come back; (b) prints the act.
    expect(repairActFor(damagedRow())).toEqual({ act: REREGISTER });
  });

  it("state 3 (no path, no fault — the damaged pointer's shape): no act", () => {
    // (a) red when the `fault` condition is removed (the pointer gets the re-register act beside its
    //     own remedy); (b) prints the act it was given.
    expect(repairActFor(damagedPointer())).toBeUndefined();
  });
});

describe('#616 PR-2c c5c — getWorkflowForRun on a damaged copy with no file (state 2)', () => {
  it('a live run: the copy\'s words, the way to end the run, and "To repair: <act>, then retry." — no "rm", no repair command', async () => {
    const err = damagedRow();
    // (a) red when the pathless branch is removed: "; if it was never registered from a source,
    //     remove the file (rm ) instead." ends the message and `repair_command: 'rm '` rides it;
    //     (b) prints the message and whether a repair command rides it.
    expect(await composed(err, makeRun())).toEqual({
      message: `${err.message}. To end the run: realm run abandon run-1. To repair: ${REREGISTER}, then retry.`,
      repair_command: false,
    });
  });

  it('a terminal run: the copy\'s words, "there is nothing to run", and "To repair: <act>." — no "rm", no repair command', async () => {
    const err = damagedRow();
    // (a) red when the pathless branch is removed (the "rm " alternative and command come back);
    //     (b) prints the message and whether a repair command rides it.
    expect(
      await composed(
        err,
        makeRun({ terminal_state: true, run_phase: 'failed', failed_steps: ['one'] }),
      ),
    ).toEqual({
      message: `${err.message}. The run is terminal (failed); there is nothing to run. To repair: ${REREGISTER}.`,
      repair_command: false,
    });
  });
});
