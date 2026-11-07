// contract-homes.ts — issue #616 PR-1a unit 16 (the shared checks): the homes the wirings of the
// published store contracts run on (`contract-fidelity-616.test.ts`, `contract-clock-616.test.ts`,
// `contract-settlement-616.test.ts`, `contract-artifact-616.test.ts`). A contract builds its store,
// or has its route build one, for each case it runs; each wiring here opens a FRESH home for it, as
// the JSON and in-memory wirings do, tracks every home it opened (the clock route has no teardown
// hook of its own) and closes them all when the cell ends.
//
// Test support only: nothing in the store imports it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock, RunRecord } from '@sensigo/realm';
import { openDatabase, type DatabaseLike } from '../driver.js';
import type { OpenSeams } from '../open-file.js';
import { openHome, type RealmHome } from '../open-realm-home.js';
import { insertRunRecord } from '../run-rows.js';
import { faultyFiles, type FaultyFiles } from './commit-faults.js';
import { openForeignConnection } from './foreign-connection.js';

/** One open home: its folder, its run store and, when it was opened `faulty`, its connection's faults. */
export interface ContractHome {
  readonly home: string;
  readonly store: RealmHome['runStore'];
  readonly files?: FaultyFiles;
}

/** What a wiring asks of `open`. */
export interface OpenOptions {
  /** The home's clock; the system clock when left out (the fidelity law brackets `Date.now()`). */
  readonly clock?: Clock;
  /** Give the store's connection faults that a cell can arm (the artifact wiring's failure). */
  readonly faulty?: boolean;
}

/** The homes of one cell. Call `dispose` when the cell ends. */
export class ContractHomes {
  readonly #dirs: string[] = [];
  readonly #handles: RealmHome[] = [];
  readonly #connections: DatabaseLike[] = [];

  /** The home opened last: the clock route's seed hook writes into the store its route built last. */
  last: ContractHome | undefined;

  /** Opens a fresh home in a temp folder. */
  async open(options: OpenOptions = {}): Promise<ContractHome> {
    const dir = mkdtempSync(join(tmpdir(), 'realm-616-u16-'));
    this.#dirs.push(dir);
    const home = join(dir, '.realm');
    const files = options.faulty === true ? faultyFiles((path) => openDatabase(path)) : undefined;
    const seams: OpenSeams = files === undefined ? {} : { openFile: files.openFile };
    const handle = await openHome(
      options.clock === undefined ? { home } : { home, clock: options.clock },
      seams,
    );
    this.#handles.push(handle);
    this.last = { home, store: handle.runStore, ...(files === undefined ? {} : { files }) };
    return this.last;
  }

  /**
   * A run as an older Realm left it, written past the store's own boundary (the store's verbs
   * refuse to make one): `legacy` says how it ends (a terminal run with no seal, for `stampSeal`
   * to stamp), over a run the store made. It is written through a second connection with
   * `insertRunRecord` inside its own `BEGIN IMMEDIATE` (unit 13a's channel), under `id`. Returns
   * the run as `get` reads it. The caller writes `legacy`: a terminal write in this file would be a
   * writer the terminal-writer census counts, and this one is a fixture, not a writer.
   */
  async seedLegacy(into: ContractHome, id: string, legacy: Partial<RunRecord>): Promise<RunRecord> {
    const { record: base } = await into.store.create({
      workflowId: `seed-${id}`,
      workflowVersion: 1,
      params: {},
    });
    const c = await openForeignConnection(into.home);
    this.#connections.push(c);
    c.exec('BEGIN IMMEDIATE');
    try {
      insertRunRecord(c, { ...base, ...legacy, id });
      c.exec('COMMIT');
    } catch (err) {
      c.exec('ROLLBACK');
      throw err;
    }
    return (await into.store.get(id)).record;
  }

  /** Closes every connection and handle this cell opened and removes its folders. */
  dispose(): void {
    for (const c of this.#connections.splice(0)) c.close();
    for (const h of this.#handles.splice(0)) h.close();
    for (const d of this.#dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    this.last = undefined;
  }
}
