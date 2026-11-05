// test-clock-basis-715b.test.ts — issue #715 (b) 02 §C.1, §C.3 (D-24, D6-53, D6-59) with Amendment 5,
// on the MCP door: a reply's stamp says `as_of_basis: 'test_clock'` only when the store's clock is a
// marked TEST clock, and a server whose store is at a test LOCATION says so once on stderr, at its
// first read. Three stores, three clocks:
//   (i)   a HAND-BUILT clock (a plain `{ now, at }` object — a realm-cloud port's) → no `as_of_basis`,
//         no notice;
//   (ii)  a `settableClock` (in-process) → `as_of_basis: 'test_clock'`, no notice;
//   (iii) a test location (its clock is the clock file) → both, the notice exactly once.
// The cells run in this order in one file (one process): the notice is said once per process, and
// only (iii) may say it.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileFailedAttemptStore,
  InMemoryTraceBufferStore,
  JsonFileStore,
  JsonWorkflowStore,
  testClockNoticeLine,
  type Clock,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, createTestLocation, settableClock } from '@sensigo/realm-testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRealmMcpServer } from './server.js';

const T = new Date('2033-01-02T03:04:05.000Z');

const ONE: WorkflowDefinition = {
  id: 'basis-715b',
  name: 'basis-715b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'agent', depends_on: ['a'] },
  },
};

type Reply = Record<string, unknown>;

afterEach(() => {
  vi.restoreAllMocks();
});

/** One `start_run` and one `get_run_state` on `runStore`, with stderr captured. */
async function twoCalls(runStore: RunStore) {
  const lines: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  const dir = await mkdtemp(join(tmpdir(), 'realm-basis-715b-'));
  const workflowStore = new JsonWorkflowStore(join(dir, 'wf'));
  await workflowStore.register(ONE);
  // A store that is not a local file store comes with its artifact stores (the server refuses to
  // guess their folder).
  const server = createRealmMcpServer({
    runStore,
    workflowStore,
    traceBufferStore: new InMemoryTraceBufferStore(runStore),
    failedAttemptStore: new JsonFileFailedAttemptStore(join(dir, 'attempts')),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'basis-715b', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  const call = async (name: string, args: Reply): Promise<Reply> => {
    const raw = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text: string }>;
    };
    return JSON.parse(raw.content[0]!.text) as Reply;
  };
  const started = await call('start_run', { workflow_id: ONE.id });
  const state = await call('get_run_state', { run_id: started['run_id'] as string });
  vi.restoreAllMocks();
  const notices = lines
    .join('')
    .split('\n')
    .filter((l) => l.startsWith('this store runs on a test clock'));
  return {
    startBasis: (started['basis'] as { as_of_basis?: string } | undefined)?.as_of_basis,
    stateBasis: (state['basis'] as { as_of_basis?: string } | undefined)?.as_of_basis,
    notices,
  };
}

describe('#715 (b) §C — what a reply’s instant stands on, and the test-location notice (MCP door)', () => {
  it('(i) a hand-built clock: no as_of_basis, no notice', async () => {
    // (a) red when every clock is taken for a test clock (as_of_basis appears), or the notice fires
    //     for a store that is not at a test location; (b) prints the two bases and the notices.
    const handBuilt: Clock = { now: () => new Date(T), at: () => () => undefined };
    const r = await twoCalls(new InMemoryStore({ clock: handBuilt }));
    expect(r).toEqual({ startBasis: undefined, stateBasis: undefined, notices: [] });
  });

  it('(ii) a settable test clock in this process: as_of_basis test_clock, no notice', async () => {
    // (a) red when stampOf drops the basis (as_of_basis missing), or the notice fires for a clock
    //     that is not a test location's; (b) prints the two bases and the notices.
    const r = await twoCalls(new InMemoryStore({ clock: settableClock(T) }));
    expect(r).toEqual({ startBasis: 'test_clock', stateBasis: 'test_clock', notices: [] });
  });

  it('(iii) a store at a test location: as_of_basis test_clock, and the notice once, at the first read’s reading', async () => {
    // (a) red when stampOf drops the basis, the server does not wrap its store with the notice, or the
    //     notice repeats per read; (b) prints the two bases and the notices.
    const location = await createTestLocation({ start: T });
    try {
      const r = await twoCalls(new JsonFileStore(location.runsDir));
      expect(r).toEqual({
        startBasis: 'test_clock',
        stateBasis: 'test_clock',
        notices: [testClockNoticeLine(T)],
      });
    } finally {
      await location.remove();
    }
  });
});
