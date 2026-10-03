// fence-run-source.ts — the run source the fenced trace-buffer contract evaluates fences against
// (issue #616 PR-0). A reader-backed trace buffer (the JSON and in-memory ones) evaluates each
// `FencePredicate` against the run it reads through its injected `FenceRunReader`; the contract
// needs to CONTROL that run (create it, change it, remove it) and to PARK the read — the read sits
// inside the store's critical section, so a parked read holds the section open exactly where the
// former latch-injected guard did.
//
// issue #616 PR-0, D3 (review finding F6): a store that reads the run inside its own transaction
// (PR-1's SQLite store) can let the contract control the run, but it cannot park its read — there
// is no injected call for the contract to latch. `FenceRunSource`'s single interface required
// both, so it is split into two: `FenceRunControl` (what every adapter supplies) and `FenceRunPark`
// (what only an injected-reader store supplies). `createFenceRunSource()` still builds the one
// concrete run source a reader-backed store is constructed over, now as `{ reader, control, park }`.
//
// A calling test constructs its reader-backed store over `source.reader` and hands `source.control`
// (as the adapter's `fenceRuns`) and `source.park` (as the adapter's `fenceRunPark`, for a
// `fenceForm: 'injected-reader'` adapter) to the contract.
import {
  WorkflowError,
  declareReleaseLine,
  runNotFoundError,
  type FenceRunReader,
  type RunRecord,
} from '@sensigo/realm';

/** The TCK's handle on one parked read: `entered` resolves when the store has called `get()` for
 *  the parked run id (the read has STARTED inside the store's critical section); `release()` lets
 *  that read return. */
export interface ParkedRead {
  entered: Promise<void>;
  release: () => void;
}

/**
 * What every fenced-trace-buffer-contract adapter supplies, regardless of how its store reads the
 * run it fences against (issue #616 PR-0, D3).
 */
export interface FenceRunControl {
  /** Makes `run` the record every later read of `run.id` returns (create or replace). */
  put: (run: RunRecord) => void;
  /** Makes `runId` absent for every later read. */
  remove: (runId: string) => void;
  /** How many times a fence evaluation has read `runId`'s run — for an injected-reader store, its
   *  reader's `get(runId)` calls; for an in-transaction store (#616 PR-1), its own in-transaction
   *  run reads. Not a count of `get` calls specifically: whatever the store's own fence-evaluation
   *  mechanism reads, once per evaluation. */
  readCount: (runId: string) => number;
}

/**
 * What only an injected-reader adapter supplies (issue #616 PR-0, D3): the ability to park or fail
 * the store's NEXT read of a given run — meaningless for an in-transaction store, which has no
 * injected read to intercept; its own suite races its transaction's lock instead.
 */
export interface FenceRunPark {
  /** Arms a park on the NEXT `get(runId)`: that call captures the record, then blocks until
   *  `release()`. */
  parkNextRead: (runId: string) => ParkedRead;
  /** Arms a failure on the NEXT `get(runId)`: that call throws `err` (e.g. an `FsIoError` for an
   *  unreadable run file). */
  failNextRead: (runId: string, err: unknown) => void;
}

/** The concrete run source `createFenceRunSource()` builds: `reader` is what an injected-reader
 *  store is constructed over; `control` and `park` are what the contract adapter supplies as
 *  `fenceRuns` and (for an `'injected-reader'` adapter) `fenceRunPark`. */
export interface FenceRunSource {
  /** The reader the store under test must be constructed with. `get(runId)` returns a COPY of the
   *  record present AT THE MOMENT OF THE CALL (a read that started before a racer's update returns
   *  the pre-update record, as a real read does), or throws core's `runNotFoundError` — the
   *  `JsonFileStore` not-found shape — when the run is absent. */
  reader: FenceRunReader;
  control: FenceRunControl;
  park: FenceRunPark;
}

/** Builds a fresh, empty `FenceRunSource` — every run id is absent until `put`. */
export function createFenceRunSource(): FenceRunSource {
  const runs = new Map<string, RunRecord>();
  const parks = new Map<string, { resolveEntered: () => void; latch: Promise<void> }>();
  const failures = new Map<string, unknown>();
  const counts = new Map<string, number>();

  const reader: FenceRunReader = {
    get: async (runId: string): Promise<RunRecord> => {
      counts.set(runId, (counts.get(runId) ?? 0) + 1);
      const failure = failures.get(runId);
      if (failures.has(runId)) {
        failures.delete(runId);
        throw failure;
      }
      // Captured BEFORE any park: the read observes the state at the moment it started.
      const captured = runs.get(runId);
      const snapshot =
        captured !== undefined ? (JSON.parse(JSON.stringify(captured)) as RunRecord) : undefined;
      const park = parks.get(runId);
      if (park !== undefined) {
        parks.delete(runId);
        park.resolveEntered();
        await park.latch;
      }
      if (snapshot === undefined) throw runNotFoundError(runId);
      return snapshot;
    },
  };

  // issue #620 PR-C: every store realm runs against carries its release line; this reader is a
  // plain object, so it declares this copy's line itself.
  declareReleaseLine(reader);

  return {
    reader,
    control: {
      put: (run) => {
        runs.set(run.id, JSON.parse(JSON.stringify(run)) as RunRecord);
      },
      remove: (runId) => {
        runs.delete(runId);
      },
      readCount: (runId) => counts.get(runId) ?? 0,
    },
    park: {
      parkNextRead: (runId) => {
        let resolveEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
          resolveEntered = resolve;
        });
        let release!: () => void;
        const latch = new Promise<void>((resolve) => {
          release = resolve;
        });
        parks.set(runId, { resolveEntered, latch });
        return { entered, release };
      },
      failNextRead: (runId, err) => {
        failures.set(runId, err);
      },
    },
  };
}

/** A minimal run record for fence tests: a live run at `version` 1 with no step in any set,
 *  unless `overrides` say otherwise. `terminal: true` makes it a sealed, completed run (its DERIVED
 *  phase is `completed`). */
export function fenceTestRun(
  runId: string,
  overrides: Partial<RunRecord> & { terminal?: boolean } = {},
): RunRecord {
  const { terminal, ...rest } = overrides;
  const base = {
    id: runId,
    workflow_id: 'fenced-tck-workflow',
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
  };
  const terminalFields =
    terminal === true
      ? {
          terminal_state: true,
          run_phase: 'completed',
          terminal_reason: 'Workflow completed.',
          sealed_by: { arm: 'complete' },
        }
      : {};
  return { ...base, ...terminalFields, ...rest } as unknown as RunRecord;
}

/** True iff `err` is a `WorkflowError` — re-exported locally so the contract's assertions do not
 *  need a second import path. */
export function isWorkflowError(err: unknown): err is WorkflowError {
  return err instanceof WorkflowError;
}
