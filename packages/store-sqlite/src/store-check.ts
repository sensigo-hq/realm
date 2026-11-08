// store-check.ts — issue #616 PR-2c, unit c8a1 (design d4-frozen-r3 §8 `realm db check`; DELTAS 50,
// 51, 52 (0)-(1), 53): the report the maintenance entry opened for `'check'` returns
// (`openRealmHomeForMaintenance({ verb: 'check' })`, `maintenance.ts`). It is a published contract
// for scripts, so its words, its check ids and its finding codes are each composed here, once.
//
// The check runs on the entry's read-only connection (`open-file.ts`, `check`) and writes nothing to
// the store file. In order:
//   1. the measured facts that a read transaction can read: the page counts and this connection's
//      durability settings, as read back;
//   2. SQLite's integrity check, `PRAGMA integrity_check(N)`, in its own read transaction. Anything
//      other than `ok` is the `integrity_failed` finding. A problem is a line, not a row: its
//      page-level problems come as one row, a line each under a `*** in database … ***` heading;
//      N problems means it stopped counting, and the finding says "at least". The check failing with SQLite's corrupt error (`errcode & 0xff` 11:
//      267, 523 and 779 included) is the `integrity_unreadable` finding, never a rejection;
//   3. the WAL's frames, by `PRAGMA wal_checkpoint(NOOP)` in autocommit (inside a read transaction it
//      fails with errcode 6): it copies nothing and writes nothing (DELTAS 53). Its `log` and
//      `checkpointed` are exact at that moment; another Realm process moves them.
// A fact that could not be measured is absent, never 0. `check()` rejects with the store's busy
// refusal (`STATE_RUN_BUSY`, past its budget), with any error of the integrity check other than a
// damaged file's (passed on as every store read passes it), and after `close()`.
import { lstatSync } from 'node:fs';
import { WorkflowError } from '@sensigo/realm';
import type { RealmDb } from './connection.js';
import type { DatabaseLike } from './driver.js';

/** The checks c8a1 runs: one `as const` list (framework R3; c8a3 and c8b add their own). */
export const CHECK_IDS = ['integrity'] as const;
/** A check's id. */
export type CheckId = (typeof CHECK_IDS)[number];

/** The finding codes c8a1 reports: one `as const` list (framework R3; c8a3 and c8b add their own). */
export const CHECK_FINDING_CODES = ['integrity_failed', 'integrity_unreadable'] as const;
/** A finding's code. */
export type CheckFindingCode = (typeof CHECK_FINDING_CODES)[number];

/** What this version does not check, always listed: one `as const` list. */
export const NOT_CHECKED_IDS = ['other_processes', 'refused_files', 'data_checks'] as const;
/** A `not_checked` entry's check. */
export type NotCheckedId = (typeof NOT_CHECKED_IDS)[number];

/** How many rows `PRAGMA integrity_check(N)` returns at most: its N (DELTAS 51 rider R2). */
export const INTEGRITY_CHECK_LIMIT = 100;

/** How many of a finding's examples the report carries at most. */
export const MAX_EXAMPLES = 10;

/** One thing a check found. */
export interface CheckFinding {
  readonly check: CheckId;
  readonly code: CheckFindingCode;
  /** The store's sentence for it. */
  readonly message: string;
  /** How many: for `integrity_failed`, the integrity check's problems (its lines, not its rows). */
  readonly count?: number;
  /** Present, `true`, only when `count` is a cap the check stopped at: there may be more. */
  readonly count_is_lower_bound?: true;
  /** At most {@link MAX_EXAMPLES} of what was found, in SQLite's words. */
  readonly examples?: readonly string[];
}

/** A check that did not run, and the finding that says why (none in c8a1). */
export interface CheckNotRun {
  readonly check: CheckId;
  /** The code of the finding in the same report that says why. */
  readonly because: CheckFindingCode;
  /** Present only when the check ran in part: the part that did not (DELTAS 52 (4b)). */
  readonly part?: string;
}

/** Something this version does not check, and why. */
export interface CheckNotChecked {
  readonly check: NotCheckedId;
  readonly why: string;
}

/** The filesystem the gate judged, or that `REALM_STORE_FS=local` turned it off. */
export type CheckFilesystem =
  { readonly escaped: false; readonly type: string } | { readonly escaped: true };

/** This connection's durability settings, as read back: integers, keyed by pragma. */
export interface CheckDurability {
  readonly synchronous?: number;
  readonly foreign_keys?: number;
  readonly trusted_schema?: number;
  readonly secure_delete?: number;
  readonly journal_size_limit?: number;
  /** macOS only. */
  readonly fullfsync?: number;
  /** macOS only. */
  readonly checkpoint_fullfsync?: number;
}

/** What the check measured (DELTAS 51 rider R3, 53). Never a finding; a fact not measured is absent. */
export interface CheckFacts {
  /** The SQLite library Realm runs on. */
  readonly sqlite_version?: string;
  /** `process.version`, for example `v24.21.0`. */
  readonly node_version: string;
  readonly filesystem?: CheckFilesystem;
  readonly durability?: CheckDurability;
  /** The store file's size, from `lstat` only. */
  readonly file_bytes?: number;
  readonly page_size?: number;
  readonly page_count?: number;
  readonly freelist_count?: number;
  /** The WAL's size, from `lstat`; 0 when there is none. */
  readonly wal_bytes?: number;
  /** Frames in the WAL now (`wal_checkpoint(NOOP)`'s `log`). */
  readonly wal_frames?: number;
  /** How many of those frames are already copied into the database: NOOP's `checkpointed`, which
   *  counts every frame copied since the WAL was last reset, across checkpoints. */
  readonly wal_frames_copied?: number;
}

/** The report `check()` resolves to: the published contract (DELTAS 51). */
export interface CheckReport {
  /** `'ok'` when `findings` and `not_run` are both empty, else `'findings'`. */
  readonly status: 'ok' | 'findings';
  /** The store file's absolute path. */
  readonly path: string;
  /** The file's schema version (`user_version`). */
  readonly schema_version: number;
  /** The newest schema version this Realm reads. */
  readonly reads_up_to: number;
  readonly facts: CheckFacts;
  readonly findings: readonly CheckFinding[];
  readonly not_run: readonly CheckNotRun[];
  readonly not_checked: readonly CheckNotChecked[];
}

/** What the check needs besides the connection: the facts it does not read from the file. */
export interface CheckContext {
  readonly path: string;
  /** The file's schema version as the open read it (`user_version`). */
  readonly schemaVersion: number;
  /** The newest schema version this Realm reads. */
  readonly readsUpTo: number;
  readonly sqliteVersion: string | undefined;
  readonly filesystem: CheckFilesystem | undefined;
  /** The platform the durability pragmas are read for (macOS reads two more). */
  readonly platform: string;
}

/** The `not_checked` list of this version (Behaviour 8; MA1-2C8-02, -03). */
const NOT_CHECKED: readonly CheckNotChecked[] = [
  {
    check: 'other_processes',
    why: "Other Realm processes' connection settings cannot be read from here.",
  },
  {
    check: 'refused_files',
    why:
      "A file the store's open refuses (a damaged header, another schema version, a changed schema " +
      'or setting, a file or folder Realm cannot write to) is refused with one error line, not ' +
      'reported: those reports are not built in this version yet.',
  },
  {
    check: 'data_checks',
    why:
      "The checks on the store's data (evidence hashes, the phase index, tombstones, placeholders, " +
      'key hashes, filter columns, orphaned rows, workflow pointers and workflow version hashes) are ' +
      'not built in this version yet.',
  },
];

/**
 * The problems in the integrity check's rows: a problem is a LINE, not a row (rev 3, AUD-C8A2-01).
 * SQLite returns its page-level problems as one row, one line each, under a `*** in database … ***`
 * heading line, which is not a problem.
 */
function problemsOf(rows: readonly string[]): string[] {
  return rows
    .flatMap((row) => row.split('\n'))
    .filter((line) => line !== '' && line !== 'ok' && !line.startsWith('*** in database'));
}

/** The integrity check's rows as a finding, or none when it says `ok`. */
function integrityFinding(rows: readonly string[]): CheckFinding | undefined {
  const problems = problemsOf(rows);
  if (problems.length === 0) return undefined;
  // `integrity_check(N)` stops at N problems: then there may be more, and the count says "at least".
  const capped = problems.length >= INTEGRITY_CHECK_LIMIT;
  const count = capped ? INTEGRITY_CHECK_LIMIT : problems.length;
  const message = capped
    ? `SQLite's integrity check reported at least ${String(count)} problems.`
    : count === 1
      ? "SQLite's integrity check reported 1 problem."
      : `SQLite's integrity check reported ${String(count)} problems.`;
  return {
    check: 'integrity',
    code: 'integrity_failed',
    message,
    count,
    ...(capped ? { count_is_lower_bound: true as const } : {}),
    examples: problems.slice(0, MAX_EXAMPLES),
  };
}

/** The integrity check could not finish: SQLite's corrupt error. */
function integrityUnreadable(errcode: number): CheckFinding {
  return {
    check: 'integrity',
    code: 'integrity_unreadable',
    message: `SQLite could not finish its integrity check: SQLite error ${String(errcode)}, the file is damaged.`,
  };
}

/** SQLite's corrupt error (11) and its extended codes (267, 523, 779), as the store passes it on. */
function corruptCode(err: unknown): number | undefined {
  const errcode = (err as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' && (errcode & 0xff) === 11 ? errcode : undefined;
}

/** The store's busy refusal, which `check()` passes on. */
function isBusyRefusal(err: unknown): boolean {
  return err instanceof WorkflowError && err.code === 'STATE_RUN_BUSY';
}

/** A pragma's value as an integer, or `undefined` when it does not read as one. */
function pragmaInteger(c: DatabaseLike, name: string): number | undefined {
  const row = c.prepare(`PRAGMA ${name}`).get();
  const value = row === undefined ? undefined : Object.values(row)[0];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** A file's size from `lstat`; `missing` when it is not there; `undefined` when it cannot be read. */
function sizeOf(path: string, missing: number | undefined): number | undefined {
  try {
    return lstatSync(path).size;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? missing : undefined;
  }
}

/** Runs one read; a busy refusal is passed on, any other failure makes its facts absent. */
async function measured<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    if (isBusyRefusal(err)) throw err;
    return undefined;
  }
}

/** The durability pragmas read back, by name (macOS reads two more). */
function durabilityOf(c: DatabaseLike, platform: string): CheckDurability {
  const names = [
    'synchronous',
    'foreign_keys',
    'trusted_schema',
    'secure_delete',
    'journal_size_limit',
    ...(platform === 'darwin' ? ['fullfsync', 'checkpoint_fullfsync'] : []),
  ];
  const durability: Record<string, number> = {};
  for (const name of names) {
    const value = pragmaInteger(c, name);
    if (value !== undefined) durability[name] = value;
  }
  return durability;
}

/** Runs the check on the entry's read-only connection (see the module comment). */
export async function runCheck(db: RealmDb, context: CheckContext): Promise<CheckReport> {
  // 1. The facts a read transaction reads.
  const read = await measured(() =>
    db.snapshot(
      (c) => ({
        pageSize: pragmaInteger(c, 'page_size'),
        pageCount: pragmaInteger(c, 'page_count'),
        freelistCount: pragmaInteger(c, 'freelist_count'),
        durability: durabilityOf(c, context.platform),
      }),
      { takesReading: false },
    ),
  );
  // 2. SQLite's integrity check: a corrupt error is a finding, never a rejection.
  const findings: CheckFinding[] = [];
  try {
    const rows = await db.snapshot(
      (c) =>
        c
          .prepare(`PRAGMA integrity_check(${String(INTEGRITY_CHECK_LIMIT)})`)
          .all()
          .map((row) => String(Object.values(row)[0])),
      { takesReading: false },
    );
    const finding = integrityFinding(rows);
    if (finding !== undefined) findings.push(finding);
  } catch (err) {
    const errcode = corruptCode(err);
    if (errcode === undefined) throw err;
    findings.push(integrityUnreadable(errcode));
  }
  // 3. The WAL's frames, outside any read transaction: NOOP copies and writes nothing.
  const wal = await measured(() =>
    db.autocommit((c) => {
      const row = c.prepare('PRAGMA wal_checkpoint(NOOP)').get() ?? {};
      return { log: Number(row['log']), checkpointed: Number(row['checkpointed']) };
    }),
  );
  const frames = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
  const walFrames = frames(wal?.log);
  const walFramesCopied = walFrames === undefined ? undefined : frames(wal?.checkpointed);
  const facts: CheckFacts = {
    ...(context.sqliteVersion === undefined ? {} : { sqlite_version: context.sqliteVersion }),
    node_version: process.version,
    ...(context.filesystem === undefined ? {} : { filesystem: context.filesystem }),
    ...(read === undefined ? {} : { durability: read.durability }),
    ...optional('file_bytes', sizeOf(context.path, undefined)),
    ...optional('page_size', read?.pageSize),
    ...optional('page_count', read?.pageCount),
    ...optional('freelist_count', read?.freelistCount),
    ...optional('wal_bytes', sizeOf(`${context.path}-wal`, 0)),
    ...optional('wal_frames', walFrames),
    ...optional('wal_frames_copied', walFramesCopied),
  };
  const notRun: CheckNotRun[] = [];
  return {
    status: findings.length === 0 && notRun.length === 0 ? 'ok' : 'findings',
    path: context.path,
    schema_version: context.schemaVersion,
    reads_up_to: context.readsUpTo,
    facts,
    findings,
    not_run: notRun,
    not_checked: NOT_CHECKED,
  };
}

/** `{ [key]: value }` when `value` was measured, else nothing. */
function optional<K extends string>(key: K, value: number | undefined): { [P in K]?: number } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: number };
}
