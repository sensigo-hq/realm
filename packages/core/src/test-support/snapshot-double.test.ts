// snapshot-double.test.ts — #616 PR-2c c4: `scanning`, the scan this package's store doubles page with.
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../types/run-record.js';
import { scanning } from './snapshot-double.js';

/** A run record of `workflow` with this id, stamped in the past. */
function record(id: string, workflow: string): RunRecord {
  return {
    id,
    workflow_id: workflow,
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    run_phase: 'running',
    version: 0,
    params: {},
    evidence: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    terminal_state: false,
  };
}

describe('#616 PR-2c c4 — scanning(records), the scan of a store double', () => {
  it('pages the records in id order, of one workflow when asked, with next_after on a full page only', async () => {
    const records = [record('c', 'wf'), record('a', 'wf'), record('d', 'other'), record('b', 'wf')];
    const pages: Array<{ ids: string[]; next: string | null }> = [];
    for await (const page of scanning(records)({ workflow: 'wf' }, { pageSize: 2 })) {
      pages.push({
        ids: page.items.map((item) => (item.kind === 'run' ? item.run.record.id : item.run_id)),
        next: page.next_after ?? null,
      });
    }
    // (1) red when the slice or the cursor is off (a record doubled or dropped across pages), the
    //     order is not by id, the workflow filter is not applied, or a short page carries next_after;
    //     (2) prints each page's ids and cursor.
    expect(pages).toEqual([
      { ids: ['a', 'b'], next: 'b' },
      { ids: ['c'], next: null },
    ]);
  });
});
