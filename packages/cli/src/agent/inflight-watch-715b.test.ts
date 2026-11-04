// inflight-watch-715b.test.ts — issue #715 (b) 02 §B.1 (D6-19): `realm agent`'s in-flight watch
// REPLACES its held snapshot on every poll, changed or not — the same record at a newer reading — so
// a claim another program holds is judged stale at the latest reading. The store's settable clock
// stands a second before the claim's deadline when the watch starts and a second after it before the
// watch ends; the record never changes.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import {
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

const DEADLINE = Date.parse('2031-05-06T07:08:09.000Z');

describe('#715 (b) §B.1 — the in-flight watch judges a held claim at its latest reading', () => {
  it('a claim whose deadline passes during the watch (the record unchanged) is said to be past its deadline', async () => {
    // (a) red when a poll keeps the record but not its reading (the claim is then judged at the
    //     reading before its deadline: no "past its deadline"); (b) prints the drive's lines.
    const def: WorkflowDefinition = {
      id: 'watch-715b',
      name: 'watch 715b',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { review: { description: 'R', execution: 'agent', depends_on: [] } },
    };
    const clock = settableClock(new Date(DEADLINE - 1_000));
    const store = new InMemoryStore({ clock });
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    await store.update({
      ...run,
      in_progress_steps: ['review'],
      claims: {
        review: {
          deadline: new Date(DEADLINE).toISOString(),
          token: 't',
          since: new Date(DEADLINE - 60_000).toISOString(),
        },
      },
    });
    const provider = new (class extends LlmProvider {
      callStep = vi.fn();
    })();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Two seconds pass on the store's clock while the watch runs (after its first polls).
    const step = setTimeout(() => {
      void clock.set(new Date(DEADLINE + 1_000));
    }, 20);
    await runAgent(
      {
        store,
        workflowStore: {
          async register() {},
          async get() {
            return def;
          },
          async list() {
            return [def];
          },
        },
        provider,
        registry: createDefaultRegistry(),
      },
      {
        definition: def,
        existingRunId: run.id,
        params: {},
        inFlightPollMs: 10,
        inFlightWatchMs: 50,
      },
    );
    clearTimeout(step);
    const out = logSpy.mock.calls.flat().join('\n');
    vi.restoreAllMocks();
    expect(out.includes('Its claim is past its deadline (its runner likely died).'), out).toBe(
      true,
    );
  });
});
