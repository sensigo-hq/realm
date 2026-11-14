// contract-lease-facts-cw1b.test.ts — issue #729, the claim window, unit CW-1b part 1: the published
// lease-facts contract (`leaseFactsContract`, @sensigo/realm-testing) run against the SQLite store with
// its real lease port, every law. The held lease is taken by a program in a child process of its own:
// `node --input-type=module -e HOLDER` imports the built package (`dist/index.js`; the root vitest
// config refuses a stale build), opens the home with `openRealmHome`, takes one hold, prints
// `{ ready, pid, id }`, and waits until it is killed. The store under test is this process's, built as
// `openRealmHome` builds it but with the home's lease port behind a wrapper that lists every id it is
// asked about (the contract's `probed()`).
//
// This file runs on CI's macOS job too (it runs every store-sqlite test file).
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { systemClock, type LeasePort } from '@sensigo/realm';
import {
  LEASE_FACTS_LAWS,
  leaseFactsContract,
  type LeaseFactsContractAdapter,
  type LeaseFactsLaw,
} from '@sensigo/realm-testing';
import { describe, expect, it } from 'vitest';
import { createLeasePort } from './claim-lease.js';
import { RealmDb } from './connection.js';
import { SqliteRunStore } from './run-store.js';

/** The laws this file does not run, each with its reason. None: every law runs on the real port. */
const NOT_RUN: Partial<Record<LeaseFactsLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly LeaseFactsLaw[] = LEASE_FACTS_LAWS.filter((law) => !(law in NOT_RUN));

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const INDEX = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'index.js')).href;

/** One holder: opens the home, takes one hold, says so, then waits to be killed. */
const HOLDER =
  `import { openRealmHome } from ${JSON.stringify(INDEX)};` +
  'const p = JSON.parse(process.env.CW1B_LEASE_HOLDER);' +
  'const home = await openRealmHome({ home: p.home });' +
  'const r = await home.runStore.leases.hold();' +
  'if (r.held === undefined) { console.log(JSON.stringify({ ready: false, unavailable: r.unavailable })); process.exit(3); }' +
  // A module-level binding keeps the hold referenced for the program's whole life.
  'const held = r.held;' +
  'console.log(JSON.stringify({ ready: true, pid: process.pid, id: held.id }));' +
  'process.stdin.resume();';

/** Starts a holder of one lease in `home`, in a child process; resolves with its pid, id and kill. */
function spawnHolder(
  home: string,
): Promise<{ pid: number; id: string; kill: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', HOLDER], {
    env: { ...process.env, CW1B_LEASE_HOLDER: JSON.stringify({ home }) },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  const kill = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  };
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    lines.once('line', (line) => {
      const ready = JSON.parse(line) as { ready: boolean; pid?: number; id?: string };
      if (!ready.ready || ready.pid === undefined || ready.id === undefined) {
        void kill();
        reject(new Error(`the holder could not take its lease: ${line}`));
      } else if (ready.pid === process.pid) {
        void kill();
        reject(new Error('adapter wiring: the holder is this process'));
      } else {
        resolve({ pid: ready.pid, id: ready.id, kill });
      }
    });
    void exited.then(() =>
      reject(
        new Error(`the holder ended before it was ready; its stderr: ${stderr.slice(0, 400)}`),
      ),
    );
  });
}

const ADAPTER: LeaseFactsContractAdapter = {
  storeName: 'SqliteRunStore with its claim leases',
  makeStore: async () => {
    const root = mkdtempSync(join(tmpdir(), 'realm-cw1b-facts-'));
    const home = join(root, 'home');
    const db = await RealmDb.open(home, { clock: systemClock });
    const real = createLeasePort(home);
    const probed: string[] = [];
    const leases: LeasePort = {
      hold: () => real.hold(),
      probe: (id) => {
        probed.push(id);
        return real.probe(id);
      },
    };
    const holders: Array<() => Promise<void>> = [];
    return {
      store: new SqliteRunStore(db, leases),
      heldLease: async () => {
        const holder = await spawnHolder(home);
        holders.push(holder.kill);
        return holder.id;
      },
      probed: () => probed,
      dispose: async () => {
        for (const kill of holders) await kill();
        db.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
};

describe('#729 CW-1b — the SQLite store runs the lease-facts contract (a holder in another process)', () => {
  it('runs every law: NOT_RUN is empty', () => {
    // (1) red when a law is put in NOT_RUN (it then never runs on the real port, here or on the
    //     macOS job); (2) prints the laws named there, with their reasons.
    expect(NOT_RUN).toEqual({});
  });

  const cases = leaseFactsContract(ADAPTER);
  for (const law of LAWS) {
    it(`conforms to ${law}`, { timeout: 120_000 }, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints the
      //     law. The case itself throws, naming the law and what the store returned, when it fails.
      expect(target, `no case for ${law}`).toBeDefined();
      await target!.run();
    });
  }
});
