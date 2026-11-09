// store-check.ts — issue #616 PR-2c, units c8a1 and c8a3 (design d4-frozen-r3 §8 `realm db check`;
// DELTAS 50, 51, 52, 53): the report the maintenance entry opened for `'check'` returns
// (`openRealmHomeForMaintenance({ verb: 'check' })`, `maintenance.ts`). It is a published contract
// for scripts, so its words, its check ids, its finding codes and the checks each finding stops are
// each composed here, once.
//
// The check's open (`open-file.ts`, `openForCheck`) hands over every outcome of the open's checks
// (c8a3): each becomes its finding, and each check it stops is listed in `not_run` with that
// finding's code (a `part` when the check ran in part). Then, on the open's read-only connection,
// when the file could be read, writing nothing to the store file:
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
import { runPhaseDerivationFingerprint } from '@sensigo/realm';
import { META_ROW_PART, type CheckedFile, type FileOutcome } from './open-file.js';
import { corruptCode, readRecords, type RecordPass } from './store-check-records.js';

/** The checks, in the order they run and are reported: one `as const` list (framework R3; c8b adds its own). */
export const CHECK_IDS = [
  'open',
  'header',
  'version',
  'schema',
  'settings',
  'writable',
  'integrity',
  // c8b1: the data checks, each run's stored record (`store-check-records.ts`), and the pass's read.
  'records',
  'evidence_hashes',
  'phase_index',
  'key_hashes',
  'filter_columns',
  'placeholders',
  'data_read',
] as const;
/** A check's id. */
export type CheckId = (typeof CHECK_IDS)[number];

/** The finding codes, in the contract's order: one `as const` list (framework R3; c8b adds its own). */
export const CHECK_FINDING_CODES = [
  'open_failed',
  'header_damaged',
  'newer_version',
  'older_version',
  'version_unknown',
  'schema_differs',
  'settings_differ',
  'not_writable',
  'integrity_failed',
  'integrity_unreadable',
  // c8b1 (DELTAS 54).
  'record_unreadable',
  'evidence_hash_mismatch',
  'phase_index_wrong',
  'key_hash_mismatch',
  'filter_column_differs',
  'placeholder_mismatch',
  'data_unreadable',
] as const;
/** A finding's code. */
export type CheckFindingCode = (typeof CHECK_FINDING_CODES)[number];

/** The data checks (c8b's, and the pass's read): what "every data check" stops. */
const DATA_CHECKS: readonly CheckId[] = [
  'records',
  'evidence_hashes',
  'phase_index',
  'key_hashes',
  'filter_columns',
  'placeholders',
  'data_read',
];

/** What this version does not check, always listed: one `as const` list. */
export const NOT_CHECKED_IDS = [
  'other_processes',
  'tombstone_phase',
  'purged_key_hash',
  'data_checks',
] as const;
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

/** A check that did not run, or ran in part, and the finding that says why. */
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
  /** How many runs another phase derivation stamped (c8b1): an upgrade's normal state, never a
   *  finding (`realm db migrate` re-stamps them). Counted by the data pass; absent when it did not run. */
  readonly phase_other_stamps?: number;
}

/** The report `check()` resolves to: the published contract (DELTAS 51). */
export interface CheckReport {
  /** `'ok'` when `findings` and `not_run` are both empty, else `'findings'`. */
  readonly status: 'ok' | 'findings';
  /** The store file's absolute path. */
  readonly path: string;
  /** The file's schema version (`user_version`); absent when it could not be read. */
  readonly schema_version?: number;
  /** The newest schema version this Realm reads. */
  readonly reads_up_to: number;
  readonly facts: CheckFacts;
  readonly findings: readonly CheckFinding[];
  readonly not_run: readonly CheckNotRun[];
  readonly not_checked: readonly CheckNotChecked[];
}

/** What the check needs besides the open's: the facts it does not read from the file. */
export interface CheckContext {
  readonly path: string;
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
    check: 'tombstone_phase',
    why: "A purged run's phase cannot be verified: its record is gone.",
  },
  {
    check: 'purged_key_hash',
    why: "A purged run's key hash cannot be recomputed: no key is kept.",
  },
  {
    check: 'data_checks',
    why:
      'The checks on tombstones, orphaned rows, workflow pointers and workflow version hashes are ' +
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

/** The checks an outcome of the open stops, whole. */
type Stops = readonly CheckId[];

/** The checks `open_failed` stops: every other check but `writable`, which runs whenever the file exists. */
const AFTER_THE_OPEN: Stops = [
  ...CHECK_IDS.filter((id) => id !== 'open' && id !== 'writable'),
  ...DATA_CHECKS,
];

/** The checks `header_damaged` stops: everything that reads the file after its header. */
const AFTER_THE_HEADER: Stops = [
  ...CHECK_IDS.filter((id) => id !== 'open' && id !== 'header' && id !== 'writable'),
  ...DATA_CHECKS,
];

/** The schema's names in a difference's words: its keys (type and name), in its order. */
function names(keys: readonly string[]): string {
  return keys.join(', ');
}

/** One outcome of the open as its finding, the checks it stops whole, and whether it stops the meta row. */
function fileFinding(outcome: FileOutcome): {
  readonly finding: CheckFinding;
  readonly stops: Stops;
  readonly metaRow: boolean;
} {
  switch (outcome.kind) {
    case 'open_failed':
      return {
        finding: {
          check: 'open',
          code: 'open_failed',
          message: `SQLite could not open the file: ${outcome.errstr} (SQLite error ${String(outcome.errcode)}).`,
        },
        stops: AFTER_THE_OPEN,
        metaRow: false,
      };
    case 'header_damaged':
      return {
        finding: {
          check: 'header',
          code: 'header_damaged',
          message:
            'The file is not a readable SQLite database: its header or schema cannot be read.',
        },
        stops: AFTER_THE_HEADER,
        metaRow: false,
      };
    case 'newer_version':
      return {
        finding: {
          check: 'version',
          code: 'newer_version',
          message: `Written by a later version of Realm (schema version ${String(outcome.file)}; this version reads up to ${String(outcome.realm)}).`,
        },
        stops: ['schema', ...DATA_CHECKS],
        metaRow: true,
      };
    case 'older_version':
      return {
        finding: {
          check: 'version',
          code: 'older_version',
          message: `Written by an earlier version: schema version ${String(outcome.file)}; this version needs ${String(outcome.realm)}; run \`realm db migrate\`.`,
        },
        stops: DATA_CHECKS,
        metaRow: false,
      };
    case 'version_unknown':
      return {
        finding: {
          check: 'version',
          code: 'version_unknown',
          message:
            outcome.file === 0
              ? "The file's schema version is 0: it was never set up (a first open was interrupted) or it is not a Realm store."
              : `The file's schema version is ${String(outcome.file)}, which no version of Realm writes.`,
        },
        stops: ['schema', ...DATA_CHECKS],
        metaRow: true,
      };
    case 'schema_differs': {
      const { missing, extra, changed } = outcome.difference;
      const parts = [
        ...(missing.length > 0 ? [`missing ${names(missing)}`] : []),
        ...(extra.length > 0 ? [`extra ${names(extra)}`] : []),
        ...(changed.length > 0 ? [`changed ${names(changed)}`] : []),
      ];
      return {
        finding: {
          check: 'schema',
          code: 'schema_differs',
          message: `The schema differs from schema version ${String(outcome.version)}'s: ${parts.join('; ')}.`,
        },
        stops: DATA_CHECKS,
        metaRow: outcome.metaTable,
      };
    }
    case 'settings_differ':
      return {
        finding: {
          check: 'settings',
          code: 'settings_differ',
          message: `A store setting differs: ${outcome.setting} is ${outcome.found}, expected ${outcome.expected}.`,
        },
        stops: [],
        // A missing row in a present meta table: the page size it records is not compared.
        metaRow: outcome.setting === META_ROW_PART,
      };
    case 'not_writable':
      return {
        finding: {
          check: 'writable',
          code: 'not_writable',
          message:
            'Realm cannot write to this file or its folder: every other command that opens this store, reads included, is refused until it can, except the checks that only look at it.',
        },
        stops: [],
        metaRow: false,
      };
    default: {
      const unknown: never = outcome;
      throw new Error(
        `An outcome of the open the check has no words for: ${JSON.stringify(unknown)}`,
      );
    }
  }
}

/**
 * The open's outcomes as the report's findings and `not_run` (DELTAS 52, 54 R1): the findings in the
 * checks' order; each stopped check once, with the first stopping code in the codes' order, whole
 * entries before a `part` one.
 */
function fileFindings(outcomes: readonly FileOutcome[]): {
  readonly findings: CheckFinding[];
  readonly notRun: CheckNotRun[];
} {
  const composed = outcomes.map(fileFinding);
  const findings = composed
    .map((c) => c.finding)
    .sort((a, b) => CHECK_IDS.indexOf(a.check) - CHECK_IDS.indexOf(b.check));
  const byCode = [...composed].sort(
    (a, b) =>
      CHECK_FINDING_CODES.indexOf(a.finding.code) - CHECK_FINDING_CODES.indexOf(b.finding.code),
  );
  // A check with a finding of its own ran, so it is never listed as not run whole.
  const ran = new Set(findings.map((f) => f.check));
  const notRun: CheckNotRun[] = [];
  for (const { finding, stops } of byCode) {
    for (const check of stops) {
      if (!ran.has(check) && !notRun.some((n) => n.check === check)) {
        notRun.push({ check, because: finding.code });
      }
    }
  }
  // The meta row's part of `settings`, once, unless `settings` did not run at all.
  for (const { finding, metaRow } of byCode) {
    if (metaRow && !notRun.some((n) => n.check === 'settings')) {
      notRun.push({ check: 'settings', because: finding.code, part: META_ROW_PART });
    }
  }
  notRun.sort((a, b) => CHECK_IDS.indexOf(a.check) - CHECK_IDS.indexOf(b.check));
  return { findings, notRun };
}

/** "1 <one>" or "<n> <many>": a message's two forms (c8b1). */
function counted(n: number, one: string, many: string): string {
  return n === 1 ? one : `${String(n)} ${many}`;
}

/** A value of an example: plain text for a phase or a hash, `none` for NULL (c8b1). */
function plain(value: unknown): string {
  return value === null || value === undefined ? 'none' : String(value);
}

/** A value of an example as JSON, so that 1 and "1" differ; NULL is `null` (c8b1). */
function json(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

/** Entries grouped by their run, in first-seen order: one example per run (c8b1). */
function byRun<T extends { readonly runId: string }>(entries: readonly T[]): Map<string, T[]> {
  const runs = new Map<string, T[]>();
  for (const entry of entries) runs.set(entry.runId, [...(runs.get(entry.runId) ?? []), entry]);
  return runs;
}

/** A finding of the data pass: its count and at most {@link MAX_EXAMPLES} examples of the same unit. */
function dataFinding(
  check: CheckId,
  code: CheckFindingCode,
  message: string,
  count: number,
  examples: readonly string[],
): CheckFinding {
  return { check, code, message, count, examples: examples.slice(0, MAX_EXAMPLES) };
}

/** The checks each scan of the pass stops when it cannot finish (Behaviour 4; correction 1). */
const SCAN_STOPS: Record<'runs' | 'evidence' | 'blobs', readonly CheckId[]> = {
  runs: ['records', 'phase_index', 'key_hashes', 'filter_columns', 'placeholders'],
  evidence: ['evidence_hashes', 'placeholders'],
  blobs: ['placeholders'],
};

/**
 * The data pass's results as the report's findings and `not_run` (c8b1; DELTAS 54): a check whose
 * scans all finished keeps its result; a scan stopped by SQLite's corrupt error or a too-large
 * integer is the one `data_unreadable` finding, and the checks it stops are not run because of it,
 * their partial findings dropped.
 */
function recordFindings(pass: RecordPass): {
  readonly findings: CheckFinding[];
  readonly notRun: CheckNotRun[];
} {
  const findings: CheckFinding[] = [];
  const runs = pass.runs.done;
  if (runs && pass.unreadable.length > 0) {
    const n = pass.unreadable.length;
    findings.push(
      dataFinding(
        'records',
        'record_unreadable',
        n === 1
          ? '1 run holds a stored record that is not JSON; the checks that read a record skipped it.'
          : `${String(n)} runs hold a stored record that is not JSON; the checks that read a record skipped them.`,
        n,
        pass.unreadable.map((id) => `run ${id}`),
      ),
    );
  }
  if (pass.evidence.done && pass.evidenceMismatches.length > 0) {
    const n = pass.evidenceMismatches.length;
    findings.push(
      dataFinding(
        'evidence_hashes',
        'evidence_hash_mismatch',
        counted(
          n,
          '1 evidence entry does not match its stored hash.',
          'evidence entries do not match their stored hash.',
        ),
        n,
        pass.evidenceMismatches.map((e) => `run ${e.runId}, entry ${String(e.seq)}`),
      ),
    );
  }
  if (runs && pass.phaseWrong.length > 0) {
    const n = pass.phaseWrong.length;
    findings.push(
      dataFinding(
        'phase_index',
        'phase_index_wrong',
        counted(
          n,
          "1 run carries a phase that differs from its record's.",
          "runs carry a phase that differs from their record's.",
        ),
        n,
        pass.phaseWrong.map(
          (p) =>
            `run ${p.runId}: stored ${plain(p.stored)}, ` +
            (p.derived === undefined ? 'derived: none' : `derived ${p.derived}`),
        ),
      ),
    );
  }
  if (runs && pass.keyHashWrong.length > 0) {
    const n = pass.keyHashWrong.length;
    findings.push(
      dataFinding(
        'key_hashes',
        'key_hash_mismatch',
        counted(
          n,
          '1 run carries a key hash that does not match its key.',
          'runs carry a key hash that does not match their key.',
        ),
        n,
        pass.keyHashWrong.map(
          (k) =>
            `run ${k.runId}: ` +
            (k.stored === null ? 'stored: none' : `stored ${plain(k.stored)}`) +
            ', ' +
            (k.derived === undefined || k.derived === null
              ? 'derived: none'
              : `derived ${k.derived}`),
        ),
      ),
    );
  }
  if (runs && pass.filterDiffers.length > 0) {
    const grouped = byRun(pass.filterDiffers);
    findings.push(
      dataFinding(
        'filter_columns',
        'filter_column_differs',
        counted(
          grouped.size,
          '1 run holds a filter column that differs from its record.',
          'runs hold a filter column that differs from their record.',
        ),
        grouped.size,
        [...grouped].map(
          ([id, columns]) =>
            `run ${id}, ` +
            columns
              .map((c) => `column ${c.column}: stored ${json(c.stored)}, record ${json(c.record)}`)
              .join('; '),
        ),
      ),
    );
  }
  const complete = runs && pass.evidence.done && pass.blobs.done;
  if (complete && pass.placeholderMismatch.length > 0) {
    const grouped = byRun(pass.placeholderMismatch);
    findings.push(
      dataFinding(
        'placeholders',
        'placeholder_mismatch',
        counted(
          grouped.size,
          '1 run holds stored placeholders that do not match their rows.',
          'runs hold stored placeholders that do not match their rows.',
        ),
        grouped.size,
        [...grouped].map(([id, fields]) => `run ${id}, ${fields.map((f) => f.field).join('; ')}`),
      ),
    );
  }
  // A scan that could not finish: one finding, the first stopped scan's words; its checks not run.
  const notRun: CheckNotRun[] = [];
  const stopped = (['runs', 'evidence', 'blobs'] as const).filter((scan) => !pass[scan].done);
  if (stopped.length > 0) {
    const first = pass[stopped[0]!];
    findings.push({
      check: 'data_read',
      code: 'data_unreadable',
      // Only SQLite's corrupt error is called damage; a too-large integer claims no cause.
      message:
        'errcode' in first
          ? `SQLite could not read the store's data: SQLite error ${String(first.errcode)}, the file is damaged.`
          : "Realm could not read the store's data: a stored integer is too large for Realm to read.",
    });
    for (const scan of stopped) {
      for (const check of SCAN_STOPS[scan]) {
        if (!notRun.some((n) => n.check === check))
          notRun.push({ check, because: 'data_unreadable' });
      }
    }
    notRun.sort((a, b) => CHECK_IDS.indexOf(a.check) - CHECK_IDS.indexOf(b.check));
  }
  return { findings, notRun };
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

/** The facts and findings read on the open's read-only connection: steps 1-3 of the module comment. */
async function onTheConnection(
  db: RealmDb,
  platform: string,
  records: boolean,
): Promise<{
  readonly read:
    | {
        readonly pageSize: number | undefined;
        readonly pageCount: number | undefined;
        readonly freelistCount: number | undefined;
        readonly durability: CheckDurability;
      }
    | undefined;
  readonly findings: CheckFinding[];
  readonly pass: RecordPass | undefined;
  readonly wal: { readonly log: number; readonly checkpointed: number } | undefined;
}> {
  // 1. The facts a read transaction reads.
  const read = await measured(() =>
    db.snapshot(
      (c) => ({
        pageSize: pragmaInteger(c, 'page_size'),
        pageCount: pragmaInteger(c, 'page_count'),
        freelistCount: pragmaInteger(c, 'freelist_count'),
        durability: durabilityOf(c, platform),
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
  // 3. The data pass (c8b1), when no finding of the file stopped it: one read transaction.
  const pass = records ? await readRecords(db, runPhaseDerivationFingerprint()) : undefined;
  // 4. The WAL's frames, outside any read transaction: NOOP copies and writes nothing.
  const wal = await measured(() =>
    db.autocommit((c) => {
      const row = c.prepare('PRAGMA wal_checkpoint(NOOP)').get() ?? {};
      return { log: Number(row['log']), checkpointed: Number(row['checkpointed']) };
    }),
  );
  return { read, findings, pass, wal };
}

/**
 * Runs the check (see the module comment): the open's outcomes as findings and `not_run`, then, when
 * the file could be read, the facts and the integrity check on its read-only connection.
 */
export async function runCheck(file: CheckedFile, context: CheckContext): Promise<CheckReport> {
  const { findings, notRun } = fileFindings(file.outcomes);
  // The data checks run only when no finding of the file put them in `not_run` (c8b1).
  const records = !notRun.some((n) => DATA_CHECKS.includes(n.check));
  const measuredOn =
    file.db === undefined ? undefined : await onTheConnection(file.db, context.platform, records);
  const read = measuredOn?.read;
  const wal = measuredOn?.wal;
  const pass = measuredOn?.pass;
  if (measuredOn !== undefined) findings.push(...measuredOn.findings);
  if (pass !== undefined) {
    const data = recordFindings(pass);
    findings.push(...data.findings);
    notRun.push(...data.notRun);
  }
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
    ...optional('phase_other_stamps', pass?.runs.done === true ? pass.otherStamps : undefined),
  };
  return {
    status: findings.length === 0 && notRun.length === 0 ? 'ok' : 'findings',
    path: context.path,
    ...(file.schemaVersion === undefined ? {} : { schema_version: file.schemaVersion }),
    reads_up_to: file.readsUpTo,
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
