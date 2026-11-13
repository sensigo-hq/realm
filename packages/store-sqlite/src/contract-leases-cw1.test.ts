// contract-leases-cw1.test.ts — issue #729, the claim window, unit CW-1: the published lease-port
// contract (`leasePortContract`, @sensigo/realm-testing) run against the SQLite store's claim leases,
// every law, with each holder in a child process of its own (holder kind `process`).
//
// A holder is `node --input-type=module -e HOLDER`: it imports the built package (`dist/index.js`, as
// the racers of `run-store-settle-616.test.ts` do; the root vitest config refuses a stale build), opens
// the home with `openRealmHome`, takes its holds, prints `{ ready, pid, ids }` only once every `hold()`
// has resolved, then answers one command per line on its stdin (close a hold with a record, probe an
// id through its own port, drop its holds and collect garbage). It installs no signal handler: a kill
// ends it as the operating system ends any program. The prober is this process, through the home's
// port as `openRealmHome` builds it.
//
// This file runs on CI's macOS job too (it runs every store-sqlite test file): the evidence lines the
// contract prints there are the merge gate's darwin record.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RunRecord } from '@sensigo/realm';
import {
  LEASE_PORT_LAWS,
  leasePortContract,
  type LeaseHolder,
  type LeasePortContractAdapter,
  type LeasePortLaw,
  type LeaseTestHome,
} from '@sensigo/realm-testing';
import { describe, expect, it } from 'vitest';
import { CLAIM_LEASES_FOLDER, leaseFile } from './claim-lease.js';
import { loadSqlite, openDatabase } from './driver.js';
import { openRealmHome } from './open-realm-home.js';

/** The laws this file does not run, each with its reason. None: every law runs against real locks. */
const NOT_RUN: Partial<Record<LeasePortLaw, string>> = {};

/** Every exported law but those named above: a law added to the contract runs here untouched. */
const LAWS: readonly LeasePortLaw[] = LEASE_PORT_LAWS.filter((law) => !(law in NOT_RUN));

/** The odd home's folder name: a `#`, a `%` (as `%25`), a `?` and spaces (CW-AU1-03's). */
const ODD_HOME = 'dir with #hash %25pct?q';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const INDEX = pathToFileURL(join(PACKAGE_ROOT, 'dist', 'index.js')).href;

/** One holder: opens the home, takes its holds, says so, then serves its commands. */
const HOLDER =
  `import { openRealmHome } from ${JSON.stringify(INDEX)};` +
  "import { createInterface } from 'node:readline';" +
  'const p = JSON.parse(process.env.CW1_LEASE_HOLDER);' +
  'const home = await openRealmHome({ home: p.home });' +
  'const port = home.runStore.leases;' +
  // The holds are taken inside a function of their own, so that once it returns nothing but `holds`
  // refers to them: a hold left in a variable of this script would stay referenced after `drop`, and
  // LGC could not see a store whose holds the garbage collector frees.
  'const take = async (n) => {' +
  ' const out = [];' +
  ' for (let i = 0; i < n; i += 1) {' +
  '  const r = await port.hold();' +
  '  if (r.held === undefined) { console.log(JSON.stringify({ ready: false, unavailable: r.unavailable })); process.exit(3); }' +
  '  out.push(r.held);' +
  ' }' +
  ' return out;' +
  '};' +
  'let holds = await take(p.count);' +
  'console.log(JSON.stringify({ ready: true, pid: process.pid, ids: holds.map((h) => h.id) }));' +
  'for await (const line of createInterface({ input: process.stdin })) {' +
  ' const c = JSON.parse(line);' +
  " if (c.cmd === 'close') { holds[c.i].close(c.record ?? undefined); console.log(JSON.stringify({ closed: c.i })); }" +
  " else if (c.cmd === 'probe') { console.log(JSON.stringify({ fact: await port.probe(c.id) })); }" +
  " else if (c.cmd === 'drop') {" +
  '  holds = [];' +
  '  for (let n = 0; n < 4; n += 1) { globalThis.gc(); await new Promise((resolve) => setImmediate(resolve)); }' +
  '  console.log(JSON.stringify({ dropped: true }));' +
  ' }' +
  '}';

/** Starts a holder of `count` leases in `home`, in a child process. */
function spawnHolder(
  home: string,
  options: { count?: number; exposeGc?: boolean } = {},
): Promise<LeaseHolder> {
  const child = spawn(
    process.execPath,
    [...(options.exposeGc === true ? ['--expose-gc'] : []), '--input-type=module', '-e', HOLDER],
    {
      env: {
        ...process.env,
        CW1_LEASE_HOLDER: JSON.stringify({ home, count: options.count ?? 1 }),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  );
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  const queue: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const next = waiting.shift();
    if (next !== undefined) next(line);
    else queue.push(line);
  });
  const nextLine = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const queued = queue.shift();
      if (queued !== undefined) return resolve(queued);
      waiting.push(resolve);
      void exited.then(({ code, signal }) =>
        reject(
          new Error(
            `the holder ended (code ${code}, signal ${signal}) before answering; its stderr: ${stderr.trim().slice(0, 400)}`,
          ),
        ),
      );
    });
  const ask = async (command: object): Promise<Record<string, unknown>> => {
    child.stdin.write(`${JSON.stringify(command)}\n`);
    return JSON.parse(await nextLine()) as Record<string, unknown>;
  };
  return nextLine().then((line) => {
    const ready = JSON.parse(line) as { ready: boolean; pid?: number; ids?: string[] };
    if (!ready.ready || ready.pid === undefined || ready.ids === undefined)
      throw new Error(`the holder could not take its leases: ${line}`);
    return {
      pid: ready.pid,
      ids: ready.ids,
      close: async (index: number, newestRecord?: RunRecord) => {
        await ask({ cmd: 'close', i: index, record: newestRecord ?? null });
      },
      selfProbe: async (id: string) =>
        (await ask({ cmd: 'probe', id }))['fact'] as Awaited<ReturnType<LeaseHolder['selfProbe']>>,
      dropAndCollect: async () => {
        await ask({ cmd: 'drop' });
      },
      kill: async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        const { signal } = await exited;
        return { signal };
      },
    };
  });
}

/** Every path under `root`, relative to it, sorted. */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      out.push(relative(root, path));
      if (statSync(path).isDirectory()) walk(path);
    }
  };
  walk(root);
  return out.sort();
}

/** A fresh home in a temp folder, opened as `openRealmHome` opens it. */
async function makeHome(options: { oddPath: boolean }): Promise<LeaseTestHome> {
  const root = mkdtempSync(join(tmpdir(), 'realm-cw1-lease-'));
  const home = join(root, options.oddPath ? ODD_HOME : 'home');
  const handle = await openRealmHome({ home });
  const folder = join(home, CLAIM_LEASES_FOLDER);
  const file = (id: string) => leaseFile(folder, id);
  return {
    port: handle.runStore.leases,
    spawnHolder: (o) => spawnHolder(home, o),
    files: {
      list: () => (existsSync(folder) ? readdirSync(folder).sort() : []),
      tree: () => tree(root),
      fileName: (id) => basename(file(id)),
      remove: (id) => unlinkSync(file(id)),
      makeForeign: (id, kind) => {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        if (kind === 'empty') {
          writeFileSync(file(id), '', { mode: 0o600 });
        } else {
          // A SQLite database whose `application_id` is 0 (any database Realm did not make a lease).
          const db = openDatabase(file(id));
          db.exec('PRAGMA user_version = 1');
          db.close();
        }
      },
      denyWrite: (id) => chmodSync(file(id), 0o444),
      fileMode: (id) => statSync(file(id)).mode,
      folderMode: () => statSync(folder).mode,
    },
    dispose: async () => {
      handle.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const ADAPTER: LeasePortContractAdapter = {
  storeName: 'SqliteRunStore',
  holderKind: 'process',
  sqliteVersion: loadSqlite().version,
  makeHome,
};

describe('#729 CW-1 — the SQLite store runs the lease-port contract (holders in other processes)', () => {
  it('runs every law: NOT_RUN is empty', () => {
    // (1) red when a law is put in NOT_RUN (it then never runs against real locks, here or on the
    //     macOS job); (2) prints the laws named there, with their reasons.
    expect(NOT_RUN).toEqual({});
  });

  const cases = leasePortContract(ADAPTER);
  for (const law of LAWS) {
    it(`conforms to ${law}`, { timeout: 120_000 }, async () => {
      const target = cases.find((c) => c.law === law);
      // (1) red when the contract stops registering a case for a law this file runs; (2) prints
      //     the law.
      expect(target, `no case registered for law ${law}`).toBeDefined();
      // (1) red when the store breaks the law (a read-only probe, a create descriptor closed after
      //     the lock, no registry, no stat step, no application_id check, a close that deletes or
      //     keeps the wrong file, ...); (2) prints the contract's own sentence: what was probed, by
      //     which pid, and what it read.
      await target!.run();
    });
  }
});
