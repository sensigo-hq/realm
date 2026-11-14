// lease-port-contract.ts — issue #729, the claim window, unit CW-1 (design record C5 §4.1; the laws'
// shape: `phase2-r2-testability-raw.md` §0–§1, with L4E merged into LSELF): the laws of a store's claim
// leases (`RunStore.leases`), as their own family, in the shape of `storeClockContract`.
//
// The family spawns no process. The adapter builds each case's home and its holders: for a store whose
// leases are kernel locks (holder kind `process`), every holder is another process, and a case refuses
// a holder whose pid is this process's (an in-process holder answers from the very registry under
// test). Each `process` case prints one evidence line when it passes:
//   [lease-law] <law> platform= node= sqlite= holder= prober= -> <observed>
// so a run on another operating system shows what each law observed there. A `simulated` adapter (the
// lease double) runs only the laws whose answer it computes from its states; a file running it names
// the others in its `NOT_RUN`.
import type { ClaimRecord, LeaseFact, LeasePort, RunRecord } from '@sensigo/realm';

/**
 * The laws, by name (each law's name says what a failure means):
 * - `L1_HELD_ACROSS_PROCESSES` — a lease another program holds reads `held`, in a plain home and in
 *   one whose path holds `#`, `%`, `?` and a space.
 * - `L2_NOT_HELD_AFTER_DEATH` — a lease read `held` reads `not_held` within ten 100-ms polls after its
 *   program is killed (`SIGKILL`); the poll count is printed.
 * - `L3_DEAD_LEASE_NEVER_HELD_AGAIN` — a dead program's lease id is never handed out again (twenty new
 *   holds), and the dead lease reads `not_held`.
 * - `L4_MISSING_ID_ABSENT_NOTHING_CREATED` — an id no program ever held reads `absent`, and the probe
 *   creates nothing, in both homes.
 * - `L4B_NOT_A_LEASE_UNKNOWN` — a file at a lease's name that is not a lease (empty; a database with
 *   `application_id` 0) reads `unknown` with the reason `not_a_lease`.
 * - `L4C_UNWRITABLE_NEVER_NOT_HELD` — a held lease the prober cannot write reads `unknown` with the
 *   reason `permission` (`held` for a prober running as root), never `not_held`.
 * - `L4D_MODES_AND_CONTENTS` — a lease file is 0600, the lease folder 0700, and while a lease is held
 *   the folder holds only its file.
 * - `L5_CLOSE_BY_RECORD` — a lease closed with a record that names it on no step reads `absent`; with a
 *   record that names it, or with no record, `not_held` — to another program and to its holder alike.
 * - `LGC_UNREFERENCED_HOLD_STAYS_HELD` — a hold its program no longer references stays `held` after
 *   garbage collection.
 * - `LSELF_OWN_ID_OPENS_NOTHING` — with its file deleted, the holder's own probe of its lease reads
 *   `held` (it opens nothing), another program's reads `absent`, and no file is made again.
 */
export const LEASE_PORT_LAWS = [
  'L1_HELD_ACROSS_PROCESSES',
  'L2_NOT_HELD_AFTER_DEATH',
  'L3_DEAD_LEASE_NEVER_HELD_AGAIN',
  'L4_MISSING_ID_ABSENT_NOTHING_CREATED',
  'L4B_NOT_A_LEASE_UNKNOWN',
  'L4C_UNWRITABLE_NEVER_NOT_HELD',
  'L4D_MODES_AND_CONTENTS',
  'L5_CLOSE_BY_RECORD',
  'LGC_UNREFERENCED_HOLD_STAYS_HELD',
  'LSELF_OWN_ID_OPENS_NOTHING',
] as const;

export type LeasePortLaw = (typeof LEASE_PORT_LAWS)[number];

/** One program holding leases, which the adapter started (in another process, for kind `process`). */
export interface LeaseHolder {
  /** Its process id (this process's, for a simulated holder). */
  readonly pid: number;
  /** Its leases' ids, every `hold()` resolved before the holder was handed over. */
  readonly ids: readonly string[];
  /** Closes its lease `index` with `newestRecord` (`undefined`: with no record). */
  close(index: number, newestRecord?: RunRecord): Promise<void>;
  /** The holder's own probe of `id`, through its own port. */
  selfProbe(id: string): Promise<LeaseFact>;
  /** Drops every reference it has to its holds, then collects garbage (four rounds, a turn between). */
  dropAndCollect(): Promise<void>;
  /** Kills it with `SIGKILL`; resolves once it has exited, with the signal it ended by. */
  kill(): Promise<{ signal: string | null }>;
}

/** The home's lease files, for the laws about them (kind `process`). */
export interface LeaseHomeFiles {
  /** The names in the lease folder, sorted (none when the folder does not exist). */
  list(): string[];
  /** Every path under the folder that holds the home, recursively, sorted: what a probe may not add to. */
  tree(): string[];
  /** The name of lease `id`'s file in the lease folder. */
  fileName(id: string): string;
  /** Deletes lease `id`'s file. */
  remove(id: string): void;
  /** Writes a file at lease `id`'s name that is not a lease: empty, or a database with `application_id` 0. */
  makeForeign(id: string, kind: 'empty' | 'app_id_0'): void;
  /** Makes lease `id`'s file read-only (0444). */
  denyWrite(id: string): void;
  /** The mode of lease `id`'s file. */
  fileMode(id: string): number;
  /** The mode of the lease folder. */
  folderMode(): number;
}

/** One home a case runs in. */
export interface LeaseTestHome {
  /** The home's lease port, in this process: the prober's. */
  readonly port: LeasePort;
  /** Starts a holder of `count` (default 1) leases in this home; `exposeGc` lets it collect garbage. */
  spawnHolder(options?: { count?: number; exposeGc?: boolean }): Promise<LeaseHolder>;
  /** The home's lease files; an adapter without them cannot run the laws that need them. */
  readonly files?: LeaseHomeFiles;
  dispose(): Promise<void>;
}

/** Adapter a calling test file supplies to run the family against one kind of store. */
export interface LeasePortContractAdapter {
  /** A name for the store, at the start of each case's `name`. */
  storeName: string;
  /** `process` for a store whose leases are locks the operating system keeps; `simulated` for a double. */
  holderKind: 'process' | 'simulated';
  /** The SQLite version the store runs on, for the evidence line (`n/a` when absent). */
  sqliteVersion?: string;
  /** Builds a fresh home; `oddPath` puts `#`, `%`, `?` and a space in its path. */
  makeHome(options: { oddPath: boolean }): Promise<LeaseTestHome>;
}

export interface LeasePortContractCase {
  law: LeasePortLaw;
  name: string;
  run: () => Promise<void>;
}

function show(fact: LeaseFact | undefined): string {
  if (fact === undefined) return 'nothing';
  return fact.state === 'unknown' ? `unknown(${fact.reason})` : fact.state;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A run record whose claims name the given leases, and one claim that names none. */
function recordNaming(leaseIds: readonly string[]): RunRecord {
  const claims: Record<string, ClaimRecord> = { work: { deadline: null } };
  leaseIds.forEach((id, i) => {
    claims[`step-${i + 1}`] = { deadline: null, lease: { id } };
  });
  return {
    id: 'run-lease-contract',
    workflow_id: 'wf-lease-contract',
    workflow_version: 1,
    claims,
  } as unknown as RunRecord;
}

/** What one case holds: its homes, its holders, and the law's checks. */
class LawRun {
  readonly #homes: LeaseTestHome[] = [];
  readonly #holders: LeaseHolder[] = [];
  readonly #killed = new Set<LeaseHolder>();

  constructor(
    readonly law: LeasePortLaw,
    readonly adapter: LeasePortContractAdapter,
  ) {}

  check(ok: boolean, detail: string): void {
    if (!ok) throw new Error(`${this.law}: ${detail}`);
  }

  async home(oddPath = false): Promise<LeaseTestHome> {
    const home = await this.adapter.makeHome({ oddPath });
    this.#homes.push(home);
    return home;
  }

  files(home: LeaseTestHome): LeaseHomeFiles {
    if (home.files === undefined)
      throw new Error(`${this.law}: adapter wiring: this law needs the home's lease files`);
    return home.files;
  }

  async holder(
    home: LeaseTestHome,
    options: { count?: number; exposeGc?: boolean } = {},
  ): Promise<LeaseHolder> {
    const holder = await home.spawnHolder(options);
    this.#holders.push(holder);
    if (this.adapter.holderKind === 'process' && holder.pid === process.pid) {
      throw new Error(
        `${this.law}: adapter wiring: an in-process holder is not another holder (pid ${holder.pid})`,
      );
    }
    const count = options.count ?? 1;
    this.check(
      holder.ids.length === count,
      `the holder (pid ${holder.pid}) holds ${holder.ids.length} leases, not the ${count} asked for`,
    );
    return holder;
  }

  async kill(holder: LeaseHolder): Promise<{ signal: string | null }> {
    this.#killed.add(holder);
    return holder.kill();
  }

  /** Probes until the lease is no longer `held`, at most ten more times, 100 ms apart. */
  async untilNotHeld(port: LeasePort, id: string): Promise<{ fact: LeaseFact; polls: number }> {
    let fact = await port.probe(id);
    let polls = 0;
    while (fact.state === 'held' && polls < 10) {
      await sleep(100);
      fact = await port.probe(id);
      polls += 1;
    }
    return { fact, polls };
  }

  holderPids(): string {
    return this.#holders.length === 0 ? 'none' : this.#holders.map((h) => h.pid).join(',');
  }

  async dispose(): Promise<void> {
    for (const holder of this.#holders) {
      if (!this.#killed.has(holder)) await holder.kill().catch(() => undefined);
    }
    for (const home of this.#homes) await home.dispose().catch(() => undefined);
  }
}

/** Runs one law with fresh homes; any failure names the law; a `process` case prints its evidence line. */
function lawCase(
  law: LeasePortLaw,
  name: string,
  adapter: LeasePortContractAdapter,
  body: (run: LawRun) => Promise<string>,
): LeasePortContractCase {
  return {
    law,
    name: `${adapter.storeName}: ${name}`,
    run: async () => {
      const run = new LawRun(law, adapter);
      let observed: string;
      try {
        observed = await body(run);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw message.startsWith(`${law}: `)
          ? err
          : new Error(`${law}: ${message}`, { cause: err });
      } finally {
        await run.dispose();
      }
      if (adapter.holderKind === 'process') {
        console.log(
          `[lease-law] ${law} platform=${process.platform} node=${process.version} ` +
            `sqlite=${adapter.sqliteVersion ?? 'n/a'} holder=${run.holderPids()} ` +
            `prober=${process.pid} -> ${observed}`,
        );
      }
    },
  };
}

/** The laws of a store's claim leases, one case per law, for the given adapter. */
export function leasePortContract(adapter: LeasePortContractAdapter): LeasePortContractCase[] {
  const L = (law: LeasePortLaw, name: string, body: (run: LawRun) => Promise<string>) =>
    lawCase(law, name, adapter, body);
  return [
    L(
      'L1_HELD_ACROSS_PROCESSES',
      'a lease another program holds reads held, in a plain home and in one whose path holds #, %, ? and a space',
      async (run) => {
        const seen: string[] = [];
        for (const oddPath of [false, true]) {
          const home = await run.home(oddPath);
          const holder = await run.holder(home);
          const fact = await home.port.probe(holder.ids[0]!);
          const where = oddPath ? 'a home whose path holds #, %, ? and a space' : 'a plain home';
          run.check(
            fact.state === 'held',
            `in ${where}, the lease held by pid ${holder.pid} reads ${show(fact)}, not held`,
          );
          seen.push(`${oddPath ? 'odd' : 'plain'}=${show(fact)}`);
        }
        return seen.join(' ');
      },
    ),
    L(
      'L2_NOT_HELD_AFTER_DEATH',
      'a held lease reads not_held within ten 100-ms polls after its program is killed',
      async (run) => {
        const home = await run.home();
        const holder = await run.holder(home);
        const id = holder.ids[0]!;
        const before = await home.port.probe(id);
        run.check(
          before.state === 'held',
          `before the kill, the lease held by pid ${holder.pid} reads ${show(before)}, not held`,
        );
        const { signal } = await run.kill(holder);
        run.check(signal === 'SIGKILL', `the holder ended by ${String(signal)}, not SIGKILL`);
        const { fact, polls } = await run.untilNotHeld(home.port, id);
        run.check(
          fact.state === 'not_held',
          `after the holder was killed, the lease reads ${show(fact)} after ${polls} more polls, not not_held`,
        );
        return `held -> SIGKILL -> ${show(fact)} after ${polls} polls`;
      },
    ),
    L(
      'L3_DEAD_LEASE_NEVER_HELD_AGAIN',
      "a dead program's lease id is never handed out again, and the dead lease reads not_held",
      async (run) => {
        const home = await run.home();
        const first = await run.holder(home);
        const dead = first.ids[0]!;
        await run.kill(first);
        const second = await run.holder(home, { count: 20 });
        run.check(
          !second.ids.includes(dead),
          `a new holder (pid ${second.pid}) was handed the dead lease's id ${dead}`,
        );
        const { fact, polls } = await run.untilNotHeld(home.port, dead);
        run.check(
          fact.state === 'not_held',
          `the dead lease ${dead} reads ${show(fact)} after ${polls} polls, not not_held`,
        );
        return `20 new ids, none the dead one; dead=${show(fact)} after ${polls} polls`;
      },
    ),
    L(
      'L4_MISSING_ID_ABSENT_NOTHING_CREATED',
      'an id no program held reads absent, and the probe creates nothing, in both homes',
      async (run) => {
        const seen: string[] = [];
        for (const oddPath of [false, true]) {
          const home = await run.home(oddPath);
          const files = run.files(home);
          // A lease held beside it, so the lease folder exists as in a home in use.
          await run.holder(home);
          const before = files.tree();
          const fact = await home.port.probe('never-held');
          const after = files.tree();
          const where = oddPath ? 'a home whose path holds #, %, ? and a space' : 'a plain home';
          run.check(
            fact.state === 'absent',
            `in ${where}, an id never held reads ${show(fact)}, not absent`,
          );
          const made = after.filter((p) => !before.includes(p));
          run.check(made.length === 0, `in ${where}, the probe made ${made.join(', ')}`);
          seen.push(`${oddPath ? 'odd' : 'plain'}=${show(fact)}, nothing made`);
        }
        return seen.join(' ');
      },
    ),
    L(
      'L4B_NOT_A_LEASE_UNKNOWN',
      "a file at a lease's name that is not a lease reads unknown(not_a_lease)",
      async (run) => {
        const home = await run.home();
        const files = run.files(home);
        const seen: string[] = [];
        for (const kind of ['empty', 'app_id_0'] as const) {
          const id = `foreign-${kind}`;
          files.makeForeign(id, kind);
          const fact = await home.port.probe(id);
          run.check(
            fact.state === 'unknown' && fact.reason === 'not_a_lease',
            `a ${kind === 'empty' ? 'empty file' : 'database with application_id 0'} reads ${show(fact)}, not unknown(not_a_lease)`,
          );
          seen.push(`${kind}=${show(fact)}`);
        }
        return seen.join(' ');
      },
    ),
    L(
      'L4C_UNWRITABLE_NEVER_NOT_HELD',
      'a held lease the prober cannot write reads unknown(permission), never not_held',
      async (run) => {
        const home = await run.home();
        const holder = await run.holder(home);
        const id = holder.ids[0]!;
        run.files(home).denyWrite(id);
        const fact = await home.port.probe(id);
        const root = process.getuid?.() === 0;
        const want = root ? 'held' : 'unknown(permission)';
        run.check(
          show(fact) === want,
          `the lease held by pid ${holder.pid}, made read-only, reads ${show(fact)}, not ${want}${root ? ' (the prober runs as root)' : ''}`,
        );
        return `read-only, ${root ? 'as root' : 'not root'}: ${show(fact)}`;
      },
    ),
    L(
      'L4D_MODES_AND_CONTENTS',
      'a lease file is 0600, the lease folder 0700, and while held the folder holds only its file',
      async (run) => {
        const home = await run.home();
        const holder = await run.holder(home);
        const id = holder.ids[0]!;
        const files = run.files(home);
        const fileMode = files.fileMode(id) & 0o777;
        const folderMode = files.folderMode() & 0o777;
        const listed = files.list();
        const octal = (mode: number) => `0${mode.toString(8)}`;
        run.check(fileMode === 0o600, `the lease file's mode is ${octal(fileMode)}, not 0600`);
        run.check(
          folderMode === 0o700,
          `the lease folder's mode is ${octal(folderMode)}, not 0700`,
        );
        run.check(
          listed.length === 1 && listed[0] === files.fileName(id),
          `while the lease is held, the folder holds ${listed.join(', ')}, not only ${files.fileName(id)}`,
        );
        return `file ${octal(fileMode)}, folder ${octal(folderMode)}, folder holds ${listed.length} entry`;
      },
    ),
    L(
      'L5_CLOSE_BY_RECORD',
      'a lease closed with a record that names it on no step reads absent; with one that names it, or with no record, not_held — to another program and to its holder',
      async (run) => {
        const home = await run.home();
        const holder = await run.holder(home, { count: 3 });
        const [none, named, noRecord] = holder.ids as readonly [string, string, string];
        const halves: [string, string, RunRecord | undefined, LeaseFact['state']][] = [
          [none, 'a record that names it on no step', recordNaming([]), 'absent'],
          [named, 'a record that names it', recordNaming([named]), 'not_held'],
          [noRecord, 'no record', undefined, 'not_held'],
        ];
        const seen: string[] = [];
        for (const [index, [id, how, record, want]] of halves.entries()) {
          await holder.close(index, record);
          const other = await home.port.probe(id);
          const own = await holder.selfProbe(id);
          run.check(
            other.state === want && own.state === want,
            `closed with ${how}, the lease reads ${show(other)} to another program and ${show(own)} to its holder, not ${want} to both`,
          );
          seen.push(`${how}: ${show(other)}/${show(own)}`);
        }
        return seen.join('; ');
      },
    ),
    L(
      'LGC_UNREFERENCED_HOLD_STAYS_HELD',
      'a hold its program no longer references stays held after garbage collection',
      async (run) => {
        const home = await run.home();
        const holder = await run.holder(home, { exposeGc: true });
        await holder.dropAndCollect();
        const fact = await home.port.probe(holder.ids[0]!);
        run.check(
          fact.state === 'held',
          `after pid ${holder.pid} dropped its hold and collected garbage, the lease reads ${show(fact)}, not held`,
        );
        return `dropped, collected: ${show(fact)}`;
      },
    ),
    L(
      'LSELF_OWN_ID_OPENS_NOTHING',
      "with its file deleted, the holder's own probe reads held, another program's reads absent, and no file is made again",
      async (run) => {
        const home = await run.home();
        const holder = await run.holder(home);
        const id = holder.ids[0]!;
        const files = run.files(home);
        files.remove(id);
        const own = await holder.selfProbe(id);
        const other = await home.port.probe(id);
        run.check(
          own.state === 'held',
          `with the file deleted, the holder's own probe reads ${show(own)}, not held`,
        );
        run.check(
          other.state === 'absent',
          `with the file deleted, another program's probe reads ${show(other)}, not absent`,
        );
        run.check(
          !files.list().includes(files.fileName(id)),
          `a probe made the deleted lease file ${files.fileName(id)} again`,
        );
        return `deleted: own=${show(own)} other=${show(other)}, no file made`;
      },
    ),
  ];
}
