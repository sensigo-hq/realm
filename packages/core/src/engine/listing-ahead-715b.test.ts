// listing-ahead-715b.test.ts — issue #715 (b) 02 §B.2's listing cell (D6-18, D6-34): a listing judges
// each row at its own reading — the listing's one raw reading floored by that row's stamp — so one
// record stamped an hour ahead (an import, a copied record) is read at `r + ε` while the others are
// read at `r`, and only its row carries `record_stamped_ahead`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { classifyRunHealth } from './run-health.js';
import { CLOCK_SKEW_EPSILON_MS as EPS } from './instants.js';

const T = Date.parse('2031-05-06T07:00:00.000Z');

describe('#715 (b) §B.2 — a listing judges each row at its own reading', () => {
  it('two records written at the reading and one an hour ahead: the ahead row is read at r + ε and alone carries the finding', async () => {
    // (a) red when the listing judges every row at one instant (the ahead row then reads at r, or the
    //     others at r + ε), or the finding fires on a row that is not ahead; (b) prints, per row, its
    //     reading's offset from r and whether it carries the finding.
    // The store's settable clock, first at T; each record is written at its own instant.
    const clock = settableClock(new Date(T));
    const store = new InMemoryStore({ clock });
    const make = async (at: number, workflowId: string) => {
      await clock.set(new Date(at));
      return (await store.create({ workflowId, workflowVersion: 1, params: {} })).record.id;
    };
    const ids = {
      plainA: await make(T - 60_000, 'a'),
      ahead: await make(T + 3_600_000, 'b'),
      plainB: await make(T - 30_000, 'c'),
    };
    await clock.set(new Date(T));
    // #616 PR-2c c4: a page of the store's scan is the listing: its one reading, and the rows.
    const page1 = await store.scan({}, { pageSize: 1000 }).next();
    if (page1.done === true) throw new Error('the scan yielded no page');
    const listing = {
      read_at: page1.value.read_at,
      snapshots: page1.value.items.flatMap((i) => (i.kind === 'run' ? [i.run] : [])),
    };
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
