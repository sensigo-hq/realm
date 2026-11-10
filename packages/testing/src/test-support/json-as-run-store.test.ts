// json-as-run-store.test.ts — #616 PR-2c c4: `jsonAsRunStore`, the JSON store seen as a `RunStore`
// (test support; PR-3 deletes both with the class).
import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, releaseLineOf, type RunStore } from '@sensigo/realm';
import { jsonAsRunStore } from './json-as-run-store.js';

describe("#616 PR-2c c4 — jsonAsRunStore(json): the JSON store's runs, paged", () => {
  it("pages one workflow's runs in id order, the other filters applied, and carries the JSON store's release line", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'realm-json-as-run-store-'));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const json = new JsonFileStore(dir);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await json.create({ workflowId: 'a', workflowVersion: 1, params: {} })).record.id);
    }
    await json.create({ workflowId: 'b', workflowVersion: 1, params: {} });
    const { record: ended } = await json.get(ids[0]!);
    await json.update({
      ...ended,
      completed_steps: ['s'],
      terminal_state: true,
      sealed_by: { arm: 'complete', step: 's' },
      terminal_reason: 'Workflow completed.',
    });
    const store = jsonAsRunStore(json);
    const pages = async (filter: Parameters<RunStore['scan']>[0]) => {
      const got: Array<{ ids: string[]; next: boolean }> = [];
      for await (const page of store.scan(filter, { pageSize: 2 })) {
        got.push({
          ids: page.items.map((item) => (item.kind === 'run' ? item.run.record.id : item.run_id)),
          next: page.next_after !== undefined,
        });
      }
      return got;
    };
    const sorted = [...ids].sort();
    // (1) red when a filter is dropped (the workflow filter: b's run comes back; the terminal one: the
    //     ended run does), the pages are off (a run doubled or dropped, a short page with a cursor),
    //     or the wrapper carries no release line of the JSON store's; (2) prints the pages.
    expect({
      workflow: await pages({ workflow: 'a' }),
      live: await pages({ workflow: 'a', terminal: false }),
      line:
        releaseLineOf(store) !== undefined &&
        releaseLineOf(store)?.generation === releaseLineOf(json)?.generation,
    }).toEqual({
      workflow: [
        { ids: sorted.slice(0, 2), next: true },
        { ids: sorted.slice(2), next: false },
      ],
      live: [
        { ids: sorted.filter((id) => id !== ids[0]), next: true },
        { ids: [], next: false },
      ],
      line: true,
    });
  });
});
