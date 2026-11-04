// stuck-kinds-715b.test.ts — issue #715 (b) 02 §D.1, Amendment 7 (4): every run-health finding kind is
// in exactly ONE of three places on `realm run list --stuck`: it has a label (`renderFindingLabel`),
// it is in core's set of kinds that never select a run (`RUN_HEALTH_STUCK_EXCLUDED`), or it is
// `never_claimed_idle` — the listing's own reason (its `idle:` column), which selects the run and
// has no label of its own. A new kind cannot ship silent: it must take a label or join the set.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure —
// kind names only.
import { describe, it, expect } from 'vitest';
import { RUN_HEALTH_KINDS, RUN_HEALTH_STUCK_EXCLUDED, type RunHealthFinding } from '@sensigo/realm';
import { renderFindingLabel } from './list.js';

/** A finding of `kind` carrying every evidence field a label reads, so only the kind decides. */
const sample = (kind: RunHealthFinding['kind']): RunHealthFinding => ({
  kind,
  step: 's',
  reason: 'r',
  evidence: {
    requirement: { kind: 'handler', name: 'h' },
    disposition: 'abort',
    error_class: 'other',
    class: 'missing',
  },
});

describe('#715 (b) Amendment 7 — the --stuck law over every finding kind', () => {
  it('each kind is labelled, excluded, or the listing’s own idle reason — exactly one', () => {
    const places = RUN_HEALTH_KINDS.map((kind) => ({
      kind,
      count: [
        renderFindingLabel(sample(kind)) !== undefined,
        RUN_HEALTH_STUCK_EXCLUDED.has(kind),
        kind === 'never_claimed_idle',
      ].filter(Boolean).length,
    }));
    // (a) red when a kind has no label and is not excluded (it would select a run and print nothing
    //     for it), or is both labelled and excluded — e.g. `record_stamped_ahead` taken out of the
    //     set; (b) prints the kind names in no place and in two.
    expect({
      none: places.filter((p) => p.count === 0).map((p) => p.kind),
      several: places.filter((p) => p.count > 1).map((p) => p.kind),
    }).toEqual({ none: [], several: [] });
    // Non-vacuity: the stamped-ahead kind is in the walk, and in the excluded set.
    expect([
      RUN_HEALTH_KINDS.includes('record_stamped_ahead'),
      RUN_HEALTH_STUCK_EXCLUDED.has('record_stamped_ahead'),
    ]).toEqual([true, true]);
  });
});
