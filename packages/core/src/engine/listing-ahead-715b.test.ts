// listing-ahead-715b.test.ts — issue #715 (b) 02 §B.2's listing cell (D6-18, D6-34): a listing judges
// each row at its own reading — the listing's one raw reading floored by that row's stamp — so one
// record stamped an hour ahead (an import, a copied record) is read at `r + ε` while the others are
// read at `r`, and only its row carries `record_stamped_ahead`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../store/json-file-store.js';
import { writeTestClockFile } from '../store/test-clock-file.js';
import { classifyRunHealth } from './run-health.js';
import { CLOCK_SKEW_EPSILON_MS as EPS } from './instants.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const T = Date.parse('2031-05-06T07:00:00.000Z');

describe('#715 (b) §B.2 — a listing judges each row at its own reading', () => {
  it('two records written at the reading and one an hour ahead: the ahead row is read at r + ε and alone carries the finding', async () => {
    // (a) red when the listing judges every row at one instant (the ahead row then reads at r, or the
    //     others at r + ε), or the finding fires on a row that is not ahead; (b) prints, per row, its
    //     reading's offset from r and whether it carries the finding.
    const root = await mkdtemp(join(tmpdir(), 'realm-715b-listing-'));
    roots.push(root);
    // The location's clock file first: a file store resolves its clock when it is opened.
    await writeTestClockFile(root, new Date(T));
    const store = new JsonFileStore(join(root, 'runs'));
    const make = async (at: number, workflowId: string) => {
      await writeTestClockFile(root, new Date(at));
      return (await store.create({ workflowId, workflowVersion: 1, params: {} })).record.id;
    };
    const ids = {
      plainA: await make(T - 60_000, 'a'),
      ahead: await make(T + 3_600_000, 'b'),
      plainB: await make(T - 30_000, 'c'),
    };
    await writeTestClockFile(root, new Date(T));
    const listing = await store.list();
    const rows = Object.fromEntries(
      Object.entries(ids).map(([name, id]) => {
        const row = listing.snapshots.find((s) => s.record.id === id)!;
        return [
          name,
          {
            offset: row.at.getTime() - T,
            ahead: classifyRunHealth(row).some((f) => f.kind === 'record_stamped_ahead'),
          },
        ];
      }),
    );
    expect({ read_at: listing.read_at.getTime() - T, rows }).toEqual({
      read_at: 0,
      rows: {
        plainA: { offset: 0, ahead: false },
        ahead: { offset: EPS, ahead: true },
        plainB: { offset: 0, ahead: false },
      },
    });
  });
});
