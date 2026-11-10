// store-interface-616-c4.test.ts — #616 PR-2c c4: the run store interface changed once: `list()` left
// it, and `scan`, `resolveKey`, `tombstonesSince` and `purgesRuns` are required members. These cells
// are TYPE-LEVEL: `npm run typecheck:tests` is the run that judges them (an unused `@ts-expect-error`
// is its error TS2578); vitest only records that the file loads.
import { describe, expect, it } from 'vitest';
import type { JsonFileStore } from './json-file-store.js';
import type { RunStore } from './store-interface.js';

describe('#616 PR-2c c4 — RunStore has no list(), and requires the four members', () => {
  it('a store without scan, resolveKey, tombstonesSince or purgesRuns is not a RunStore; nor is JsonFileStore', () => {
    // (1) red under typecheck:tests (TS2578, the directive unused) when `list` comes back on
    //     `RunStore`, when one of the four members leaves it or turns optional, or when
    //     `JsonFileStore` satisfies `RunStore`; (2) prints the line of the unused directive.
    // @ts-expect-error — `list` is gone from the interface.
    type _List = RunStore['list'];
    const refused = {
      // @ts-expect-error — a store without `scan` is not a run store.
      scan: (store: Omit<RunStore, 'scan'>): RunStore => store,
      // @ts-expect-error — nor one without `resolveKey`.
      resolveKey: (store: Omit<RunStore, 'resolveKey'>): RunStore => store,
      // @ts-expect-error — nor one without `tombstonesSince`.
      tombstonesSince: (store: Omit<RunStore, 'tombstonesSince'>): RunStore => store,
      // @ts-expect-error — nor one without `purgesRuns`.
      purgesRuns: (store: Omit<RunStore, 'purgesRuns'>): RunStore => store,
      // @ts-expect-error — the JSON store lacks the four members: it is not a run store (PR-3 deletes it).
      json: (store: JsonFileStore): RunStore => store,
    };
    const _unused: _List | undefined = undefined;
    expect(Object.keys(refused)).toEqual([
      'scan',
      'resolveKey',
      'tombstonesSince',
      'purgesRuns',
      'json',
    ]);
    expect(_unused).toBeUndefined();
  });
});
