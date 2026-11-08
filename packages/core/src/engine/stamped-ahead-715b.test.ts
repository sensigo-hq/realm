// stamped-ahead-715b.test.ts — issue #715 (b) 02 §D.1 (D6-3, D6-34) with Amendment 7: the run-health
// finding `record_stamped_ahead` fires when a record's `updated_at` lies more than ε after the
// reader's RAW reading, and carries that raw lead — never the capped one. Each record is made by an
// in-memory store whose settable clock stood `lead` ahead when it was written, then read with the
// clock back at T: the store reads it at `max(T, min(updated_at, T + ε))`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { classifyRunHealth } from './run-health.js';
import { CLOCK_SKEW_EPSILON_MS as EPS } from './instants.js';

const T = Date.parse('2026-10-30T10:00:00.000Z');

/** The `record_stamped_ahead` finding of a record written `lead` ms ahead of T, read at T. */
async function readAfterLead(lead: number) {
  const clock = settableClock(new Date(T + lead));
  const store = new InMemoryStore({ clock });
  const { record } = await store.create({ workflowId: 'w', workflowVersion: 1, params: {} });
  await clock.set(new Date(T));
  const snapshot = await store.get(record.id);
  return classifyRunHealth(snapshot).find((f) => f.kind === 'record_stamped_ahead');
}

describe('#715 (b) §D.1 — record_stamped_ahead, from the raw reading', () => {
  it('a record stamped exactly ε ahead: no finding', async () => {
    // (a) red when the finding fires at a lead of ε (a `>=` in place of `>`); (b) prints it.
    expect(await readAfterLead(EPS)).toBeUndefined();
  });

  it('ε + 1 ms ahead: the finding, its delta the raw lead', async () => {
    // (a) red when the delta is measured from the capped reading (1 ms, not ε + 1 ms); (b) prints the
    //     evidence.
    const f = await readAfterLead(EPS + 1);
    expect(f?.evidence).toEqual({
      record_updated_at: new Date(T + EPS + 1).toISOString(),
      reader_at: new Date(T).toISOString(),
      delta_ms: EPS + 1,
    });
  });

  it('a record stamped an hour ahead (an import, a copied record): reader_at is the raw reading, and the sentence names the lead', async () => {
    // (a) red when reader_at is the capped reading (T + ε) or the lead is the capped one; (b) prints
    //     the finding.
    const f = await readAfterLead(3_600_000);
    expect({ evidence: f?.evidence, reason: f?.reason }).toEqual({
      evidence: {
        record_updated_at: new Date(T + 3_600_000).toISOString(),
        reader_at: new Date(T).toISOString(),
        delta_ms: 3_600_000,
      },
      reason:
        "this run's last write is stamped 3600 s after this reader's clock; one of the two clocks is off by 3600 s",
    });
  });

  it('a record stamped behind the clock: no finding', async () => {
    // (a) red when the finding fires on any stamp other than the reading (behind, too); (b) prints it.
    expect(await readAfterLead(-3_600_000)).toBeUndefined();
  });
});
