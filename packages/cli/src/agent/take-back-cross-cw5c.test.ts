// take-back-cross-cw5c.test.ts — #729 CW-5c check 1, the cross check: a screen names `realm agent` for
// a held step if and only if a `realm agent` drive then takes the step back. The screen's lines are
// `realm run inspect`'s (`heldWayLines` with the steps `stepsTakenBack` gives, from the run's read);
// the drive is the real `runAgent`, with a program name, run in this process on that same record. One
// cell per lease state: below the cap, at the cap, held, absent, unknown.
//
// InMemoryStore with the lease double as its port: the double's states are the lease facts the store
// reads, so each state is set exactly (a killed drive's lock is `closed_kept`, read `not_held`).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it: (1) the
// change that turns it red; (2) what it prints when it fails.
import { describe, it, expect, vi } from 'vitest';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  claimStepForDrive,
  composeWaysAt,
  createDefaultRegistry,
  takeBackStep,
  type Attributed,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, createLeaseDouble, type LeaseDouble } from '@sensigo/realm-testing';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { PLAIN } from '../output/writer.js';
import { stepsTakenBack } from '../lib/holder-render.js';
import { heldEntriesOf, heldWayLines } from '../commands/ways-renderer.js';

const registry = createDefaultRegistry();
const prog = (by: string): Attributed => ({ by, by_source: 'stated', channel: 'agent' });
const A = prog('drive-a');
const B = prog('drive-b');
const DEF = {
  id: 'take-back-cross-cw5c',
  name: 'take-back-cross-cw5c',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { s: { description: 'An agent step.', execution: 'agent', depends_on: [] } },
} as WorkflowDefinition;

type State = 'below' | 'cap' | 'held' | 'absent' | 'unknown';

/** A run whose `s` drive A took under a lease, then left in `state`. */
async function fixture(state: State): Promise<{ store: InMemoryStore; runId: string }> {
  const double: LeaseDouble = createLeaseDouble();
  const store = new InMemoryStore({ leases: double });
  const { record } = await store.create({ workflowId: DEF.id, workflowVersion: 1, params: {} });
  const claim = async () => {
    const a = await claimStepForDrive(store, record.id, 's', {
      definition: DEF,
      registry,
      driver: A,
    });
    if (a.kind !== 'claimed') throw new Error(`fixture: ${JSON.stringify(a)}`);
    return a.hold;
  };
  const first = await claim();
  if (state === 'held') return { store, runId: record.id };
  first.close((await store.get(record.id)).record);
  if (state === 'absent') double.set(first.id, 'removed');
  if (state === 'unknown')
    double.set(first.id, {
      forced: { state: 'unknown', basis: 'kernel_lock', reason: 'cannot_open' },
    });
  if (state === 'cap') {
    // Taken back once since (the next drive's watch), and that drive killed too.
    const token = (await store.get(record.id)).record.claims?.['s']?.token;
    const back = await takeBackStep(store, record.id, 's', { expectToken: token!, drivenBy: A });
    if (back.kind !== 'taken_back') throw new Error(`fixture: ${back.kind}`);
    (await claim()).close((await store.get(record.id)).record);
  }
  return { store, runId: record.id };
}

/** What `realm run inspect` prints under `s`, from the run's read. */
async function screen(store: InMemoryStore, runId: string): Promise<string[]> {
  const read = await store.get(runId);
  const held = heldEntriesOf(
    composeWaysAt(read.record, read.at, {
      definition: DEF,
      persistsClaims: true,
      lease_facts: read.lease_facts,
    }),
  );
  const takesBack = stepsTakenBack(read.record, DEF, held);
  return held.flatMap((e) => heldWayLines(e, PLAIN, takesBack));
}

/** Drive B on the run: whether it took `s` back (its audit entry), and its model calls. */
async function drive(
  store: InMemoryStore,
  runId: string,
): Promise<{ tookBack: boolean; calls: number }> {
  let calls = 0;
  const provider = new (class extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      calls += 1;
      return { ok: true };
    }
  })();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await runAgent(
      {
        store,
        workflowStore: {
          async register() {},
          async get() {
            return DEF;
          },
          async list() {
            return [DEF];
          },
        },
        provider,
        registry,
        driver: B,
      },
      {
        definition: DEF,
        existingRunId: runId,
        params: {},
        inFlightPollMs: 10,
        inFlightWatchMs: 200,
        pollIntervalMs: 10,
      },
    );
  } finally {
    vi.restoreAllMocks();
  }
  const { record } = await store.get(runId);
  const tookBack = record.evidence.some(
    (e) =>
      e.output_summary?.['reason'] === 'lease_not_held' &&
      JSON.stringify(e.driven_by) === JSON.stringify(B),
  );
  return { tookBack, calls };
}

describe('#729 CW-5c — check 1: the screen names realm agent exactly where the drive takes the step back', () => {
  for (const [state, takes] of [
    ['below', true],
    ['cap', false],
    ['held', false],
    ['absent', false],
    ['unknown', false],
  ] as const)
    it(`${state}: the screen ${takes ? 'names' : 'does not name'} realm agent, and the drive ${takes ? 'takes the step back (one model call)' : 'does not take it back'}`, async () => {
      const { store, runId } = await fixture(state);
      const lines = await screen(store, runId);
      const names = lines.some((l) => l.startsWith('Or let realm agent --run-id'));
      const ran = await drive(store, runId);
      // (1) red when the screen's answer drops the cap (it then names realm agent at the cap, where
      //     the drive's own take-back refuses), or reads only that the claim names a lease (it then
      //     names it for a held, absent or unknown lease, where the drive watches); (2) prints the
      //     screen and what the drive did.
      expect({ names, ...ran }, lines.join('\n')).toEqual({
        names: takes,
        tookBack: takes,
        calls: takes ? 1 : 0,
      });
    });
});
