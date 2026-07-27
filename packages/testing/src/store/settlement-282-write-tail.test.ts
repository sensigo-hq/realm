// settlement-282-write-tail.test.ts — the #282 class closure's write-tail integration pin (issue
// #279, increment 2, PR-C — design record §8, "per-store (testing, non-TCK)"): a hand-built
// `failed ∧ pending_gate` record, written via the plain `store.update()` path (not settleStep —
// this proves the WRITE-TAIL derive every store's `update()` already performs, load-bearing for
// the closure regardless of which write surface produced the record), persists the DERIVED
// 'failed' phase — never the stale 'gate_waiting' a pre-#282 write order would have produced.
// Run against BOTH in-repo stores so neither can silently regress independently.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '@sensigo/realm';
import type { RunStore } from '@sensigo/realm';
import { InMemoryStore } from './in-memory-store.js';

describe.each([
  ['JsonFileStore', async () => new JsonFileStore(await mkdtemp(join(tmpdir(), 'realm-282-wt-')))],
  ['InMemoryStore', async () => new InMemoryStore()],
] as const)(
  '%s — write-tail derives a hand-built failed ∧ pending_gate record (issue #279, increment 2, PR-C)',
  (_name, makeStore) => {
    let dir: string | undefined;

    afterEach(async () => {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    });

    it('store.update() on a hand-built failed ∧ pending_gate record persists the DERIVED phase (never the hand-set stale one)', async () => {
      const store: RunStore = await makeStore();
      if (store instanceof JsonFileStore) dir = store.runsDirPath;

      const { run } = await store.create({ workflowId: 'wf', workflowVersion: 1, params: {} });
      const written = await store.update({
        ...run,
        failed_steps: ['a'],
        terminal_state: true,
        // Deliberately stale/wrong — a hand-authored fixture or a legacy writer that never learned
        // about deriveRunPhase's own reorder. pending_gate is a genuine leftover: never cleared.
        run_phase: 'gate_waiting',
        pending_gate: {
          gate_id: 'stale-gate',
          step_name: 'b',
          preview: {},
          choices: ['approve', 'reject'],
          opened_at: '2026-01-01T00:00:00.000Z',
        },
      });

      expect(written.run_phase).toBe('failed');

      const reread = await store.get(run.id);
      expect(reread.run_phase).toBe('failed');
    });
  },
);
