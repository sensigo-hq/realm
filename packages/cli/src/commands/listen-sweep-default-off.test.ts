// listen-sweep-default-off.test.ts — issue #291, Deliverable 9 (O7): the listen sweeper's
// default-OFF pin — startListen schedules NO interval at all when sweepExpiredGatesIntervalMs is
// omitted from ListenOptions (the CLI flag's own absence-propagation, confirmed end-to-end
// through the real scheduling call).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startListen, type ListenDeps, type Logger, type WorkflowEntry } from './listen.js';
import { doubleClock, listing, noSettle } from '../test-support/snapshot-double.js';

const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeDeps(): ListenDeps {
  return {
    workflowStore: {
      register: async () => {},
      get: async () => {
        throw new Error('n/a');
      },
    },
    runStore: {
      create: async () => {
        throw new Error('n/a');
      },
      get: async () => {
        throw new Error('n/a');
      },
      update: async () => {
        throw new Error('n/a');
      },
      list: async () => listing([]),
      // #715 (b): `settleStep` is required on the listen store — this double's never settles.
      settleStep: noSettle,
      // #715 (b) (03 §A.4): and its `clock` — the sweeper's waits are the store's.
      clock: doubleClock,
    },
    dedupStoreFor: () => ({
      // The DedupStore contract is asynchronous (#616 B1: core's interface): `check`, `record` and
      // `cleanup` each return a promise, and listen awaits each (`if (await dedupStore.check(...))`,
      // listen.ts). `cleanup` is required. This path is not exercised by this test, but the double
      // must not lie about the contract.
      check: async () => false,
      record: async () => {},
      cleanup: async () => {},
    }),
    spawnAgent: async () => ({ pid: 1 }),
    logger: silentLogger,
  };
}

describe('startListen — sweeper default-OFF (issue #291)', () => {
  let handle: Awaited<ReturnType<typeof startListen>> | undefined;

  afterEach(async () => {
    if (handle !== undefined) await handle.shutdown('test-cleanup');
    vi.restoreAllMocks();
  });

  it('schedules NO setInterval when sweepExpiredGatesIntervalMs is omitted', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const routes = new Map<string, WorkflowEntry>();
    handle = await startListen(
      routes,
      {
        port: 0,
        host: '127.0.0.1',
        bodyTimeoutMs: 5000,
        maxBodyBytes: 1_048_576,
        maxConcurrent: 20,
      },
      makeDeps(),
    );
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('DOES schedule a setInterval when sweepExpiredGatesIntervalMs is explicitly set', async () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const routes = new Map<string, WorkflowEntry>();
    handle = await startListen(
      routes,
      {
        port: 0,
        host: '127.0.0.1',
        bodyTimeoutMs: 5000,
        maxBodyBytes: 1_048_576,
        maxConcurrent: 20,
        sweepExpiredGatesIntervalMs: 60_000,
      },
      makeDeps(),
    );
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000);
  });
});
