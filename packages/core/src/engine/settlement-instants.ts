// settlement-instants.ts — issue #715 (b) (D-17; D6-3, D6-10, D6-67): the EVENT instants a settlement
// delta carries. A step's `started_at` / `completed_at` are this process's own readings, taken when the
// work ran and ended — events, ≤ the write that records them. `takeReading` folds them into the
// write's one reading, so no instant the write mints lies before an event it records.
import type { EvidenceSnapshot } from '../types/run-record.js';
import type { SettlementDelta } from '../types/settlement.js';
import { parseStamp } from './instants.js';

/**
 * The parseable `started_at` and `completed_at` of every evidence entry `delta` carries
 * (`settle_step`, `open_gate` and `settle_gate`'s `evidence[]`, `mark_finalizer` and `settle_guard`'s
 * `evidence`, `release_step`'s optional `evidence[]`). NOTHING from a `seal_run` delta: its identity
 * entry's `captured_at` is outside class — minted before any store — carried verbatim and never folded
 * (D6-67). An unparseable stamp is skipped (D-25). Pure.
 */
export function eventInstantsOf(delta: SettlementDelta): Date[] {
  const entries: readonly EvidenceSnapshot[] = evidenceOf(delta);
  const out: Date[] = [];
  for (const e of entries) {
    for (const stamp of [e.started_at, e.completed_at]) {
      if (typeof stamp !== 'string') continue;
      const ms = parseStamp(stamp);
      if (ms !== undefined) out.push(new Date(ms));
    }
  }
  return out;
}

function evidenceOf(delta: SettlementDelta): readonly EvidenceSnapshot[] {
  switch (delta.kind) {
    case 'settle_step':
    case 'open_gate':
    case 'settle_gate':
      return delta.evidence;
    case 'mark_finalizer':
    case 'settle_guard':
      return [delta.evidence];
    case 'release_step':
      return delta.evidence ?? [];
    case 'lease_finalizer':
    case 'expire_gate':
    case 'seal_run':
      return [];
  }
}
