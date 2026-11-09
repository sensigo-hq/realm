// earlier-runs.ts — caching 3-M piece C2: the read of a workflow's earlier runs. Most steps make one
// request per run, so a step's first request has nothing earlier in its own run to be compared with;
// this read finds the same step's request in the workflow's recent runs. `realm agent` makes it once
// per drive, before the drive, and hands the result to `runAgent` as plain data: the driver's
// `RunStore` has no `scan`, and a host that calls `runAgent` without the data behaves as before.
import {
  AUTO_GAPS_KEPT,
  CACHE_GAP_MAX_S,
  SCAN_MAX_PAGE_SIZE,
  parseStamp,
  type RunRecord,
  type RunRow,
  type UsageRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import type { SqliteRunStore } from '@sensigo/realm-store-sqlite';
import { lastRecordedRequest } from './run-agent.js';

/** One request found for a step in an earlier run, and the run it was found on. */
export interface EarlierRequest {
  readonly run_id: string;
  readonly request: UsageRecord;
}

/**
 * What the read found, by agent step: every request found, latest `request_start` first (the first is
 * the one a step's first request copies; the gaps between them are `D-2`'s), and on equal starts the
 * run updated last first. A step with no earlier request has an empty list.
 */
export type EarlierRuns = ReadonlyMap<string, readonly EarlierRequest[]>;

/** How many of the rows naming a step are opened: `D-2`'s five gaps need six moments. */
const ROWS_PER_STEP = AUTO_GAPS_KEPT + 1;

const namesStep = (row: RunRow, step: string): boolean =>
  row.completed_steps.includes(step) ||
  row.failed_steps.includes(step) ||
  row.in_progress_steps.includes(step);

/** Latest start first; an unparsable stamp sorts oldest, as `parseStamp`'s callers order them. */
function latestStartFirst(a: EarlierRequest, b: EarlierRequest): number {
  const x = parseStamp(a.request.request_start) ?? Number.NEGATIVE_INFINITY;
  const y = parseStamp(b.request.request_start) ?? Number.NEGATIVE_INFINITY;
  return x === y ? 0 : x > y ? -1 : 1;
}

/**
 * Reads `definition`'s rows updated in the last 7 days, opens the newest `ROWS_PER_STEP` that name
 * each agent step (each run once), and takes from each the request the run's own predecessor rule
 * finds (`lastRecordedRequest`). A row carries no `drive_failures`, so a run whose drive stopped on
 * the step before claiming it is never opened. `ownRunId`, a re-attached run, is never a candidate.
 *
 * It only feeds a diagnostic, so it never stops a drive and says nothing: a failed scan answers
 * `undefined`, as when no read is made (never an empty result, which would mean "no earlier runs"),
 * and a failed `get` (a run purged between the two) skips that run. A workflow with no agent step
 * makes no read.
 */
export async function readEarlierRuns(
  store: Pick<SqliteRunStore, 'scan' | 'get' | 'clock'>,
  definition: Pick<WorkflowDefinition, 'id' | 'steps'>,
  ownRunId: string | undefined,
): Promise<EarlierRuns | undefined> {
  const steps = Object.keys(definition.steps).filter(
    (name) => definition.steps[name]?.execution === 'agent',
  );
  if (steps.length === 0) return undefined;

  const rows: RunRow[] = [];
  try {
    // The start of the window, compared with `updated_at`: the store's own stamp, so the store's clock.
    const since = new Date(store.clock.now().getTime() - CACHE_GAP_MAX_S * 1000).toISOString();
    for await (const page of store.scan(
      { workflow: definition.id, updated_since: since },
      { pageSize: SCAN_MAX_PAGE_SIZE, projection: 'row' },
    )) {
      for (const item of page.items) {
        if (item.kind === 'run' && item.run.id !== ownRunId) rows.push(item.run);
      }
    }
  } catch {
    return undefined;
  }
  // Scan order is by id, unrelated to time. The sort is stable, so equal stamps keep that order.
  rows.sort((a, b) => (a.updated_at === b.updated_at ? 0 : a.updated_at > b.updated_at ? -1 : 1));

  const rowsByStep = new Map(
    steps.map((step) => [step, rows.filter((row) => namesStep(row, step)).slice(0, ROWS_PER_STEP)]),
  );
  const records = new Map<string, RunRecord>();
  for (const id of new Set([...rowsByStep.values()].flat().map((row) => row.id))) {
    try {
      records.set(id, (await store.get(id)).record);
    } catch {
      // A run purged between the scan and this read: it holds nothing to compare with.
    }
  }

  const found = new Map<string, EarlierRequest[]>();
  for (const [step, named] of rowsByStep) {
    const requests: EarlierRequest[] = [];
    for (const row of named) {
      const request = lastRecordedRequest(records.get(row.id), step);
      if (request !== undefined) requests.push({ run_id: row.id, request });
    }
    // Stable, and `named` is newest-updated first: on equal starts the run updated last stays first.
    found.set(step, requests.sort(latestStartFirst));
  }
  return found;
}
