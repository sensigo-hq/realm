// db-check.ts — issue #616 PR-2c, unit c8a2 (design d4-frozen-r3 §8; DELTAS 50–54): `realm db check
// [--json]`. It opens the home through the store package's maintenance entry for this verb
// (`openRealmHomeForMaintenance({ verb: 'check' })`), calls the handle's `check()` and prints the
// report. The store composes every finding's words (one composer); this file words only the lines
// around them. It never says the store is healthy: it says what the checks that ran found, and what
// this version does not check. The exit code is 0 only when every check ran and found nothing; it is
// set after the report is printed, and never by exiting inside the `try`, which would skip `close()`.
// Every refusal is a typed one, printed by the entry as one `Error:` line with exit code 1
// (`lib/expected-refusal.ts`).
import { Command } from 'commander';
import type { DisclosureClass } from '@sensigo/realm';
import {
  openRealmHomeForMaintenance,
  type CheckFacts,
  type CheckFinding,
  type CheckNotChecked,
  type CheckNotRun,
  type CheckReport,
} from '@sensigo/realm-store-sqlite';
import { printJsonByTable } from '../output/writer.js';

/**
 * The class of every key of the report. A key added to the store's report and left out here fails
 * `tsc`. `message`, `examples` and `why` can carry SQLite's own words. `path` is `bounded`, unlike the
 * house tables' paths, so that the JSON's path is masked exactly as the text line's is.
 */
const CHECK_JSON_TABLE = {
  status: 'fact',
  path: 'bounded',
  schema_version: 'fact',
  reads_up_to: 'fact',
  facts: {
    nested: {
      sqlite_version: 'fact',
      node_version: 'fact',
      filesystem: 'fact',
      durability: 'fact',
      file_bytes: 'fact',
      page_size: 'fact',
      page_count: 'fact',
      freelist_count: 'fact',
      wal_bytes: 'fact',
      wal_frames: 'fact',
      wal_frames_copied: 'fact',
      phase_other_stamps: 'fact',
      tombstones_since: 'fact',
      tombstones_through_seq: 'fact',
      purged_ids: 'fact',
    } satisfies Record<keyof CheckFacts, DisclosureClass>,
  },
  findings: {
    nested: {
      check: 'fact',
      code: 'fact',
      message: 'bounded',
      count: 'fact',
      count_is_lower_bound: 'fact',
      examples: 'bounded',
      examples_of: 'fact',
    } satisfies Record<keyof CheckFinding, DisclosureClass>,
  },
  not_run: {
    nested: {
      check: 'fact',
      because: 'fact',
      part: 'fact',
    } satisfies Record<keyof CheckNotRun, DisclosureClass>,
  },
  not_checked: {
    nested: {
      check: 'fact',
      why: 'bounded',
    } satisfies Record<keyof CheckNotChecked, DisclosureClass>,
  },
} satisfies Record<keyof CheckReport, DisclosureClass>;

/** A finding: its message, then its examples, then how many were not shown. */
function findingLines(finding: CheckFinding): string[] {
  const examples = finding.examples ?? [];
  // `examples_of` when the examples count something other than `count` (`orphaned_rows`).
  const total = finding.examples_of ?? finding.count;
  const left = total === undefined ? 0 : total - examples.length;
  const atLeast = finding.count_is_lower_bound === true ? 'at least ' : '';
  return [
    `✗ ${finding.message}`,
    ...examples.map((example) => `    ${example}`),
    ...(left > 0 ? [`    … and ${atLeast}${left} more.`] : []),
  ];
}

/** Counts findings, never problems, and tells a check that did not run from one that ran in part. */
function summaryLine(report: CheckReport): string {
  if (report.status === 'ok') return 'No problems found by the checks that ran.';
  const k = report.findings.length;
  const whole = report.not_run.filter((entry) => entry.part === undefined).length;
  const inPart = report.not_run.length - whole;
  return (
    (k === 1 ? '1 finding.' : `${k} findings.`) +
    (whole > 0 ? ` ${whole} check(s) did not run.` : '') +
    (inPart > 0 ? ` ${inPart} ran in part.` : '')
  );
}

function platformLine(facts: CheckFacts): string {
  const engine =
    facts.sqlite_version === undefined
      ? `Node ${facts.node_version}`
      : `SQLite ${facts.sqlite_version} on Node ${facts.node_version}`;
  if (facts.filesystem === undefined) return `${engine}.`;
  const judged = facts.filesystem.escaped
    ? 'not judged (REALM_STORE_FS=local)'
    : facts.filesystem.type;
  return `${engine}; filesystem: ${judged}.`;
}

function pagesPart(facts: CheckFacts): string | undefined {
  const size = facts.page_size === undefined ? '' : `of ${facts.page_size} bytes`;
  if (facts.page_count === undefined) return size === '' ? undefined : `pages ${size}`;
  return size === '' ? `${facts.page_count} pages` : `${facts.page_count} pages ${size}`;
}

function fileLine(facts: CheckFacts): string | undefined {
  const parts = [
    facts.file_bytes === undefined ? undefined : `${facts.file_bytes} bytes`,
    pagesPart(facts),
    facts.freelist_count === undefined ? undefined : `${facts.freelist_count} free`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : `File: ${parts.join(', ')}.`;
}

function walLine(facts: CheckFacts): string | undefined {
  const frames =
    facts.wal_frames === undefined || facts.wal_frames_copied === undefined
      ? undefined
      : `${facts.wal_frames} frames, ${facts.wal_frames_copied} of them already copied into the database`;
  if (facts.wal_bytes === undefined) return frames === undefined ? undefined : `WAL: ${frames}.`;
  return frames === undefined
    ? `WAL: ${facts.wal_bytes} bytes; its frame counts could not be read.`
    : `WAL: ${facts.wal_bytes} bytes, ${frames}.`;
}

/** The facts' lines: a part only when its fact is present, and no line with none. */
function factLines(facts: CheckFacts): string[] {
  const stamped = facts.phase_other_stamps ?? 0;
  return [
    platformLine(facts),
    fileLine(facts),
    walLine(facts),
    stamped > 0
      ? `Runs stamped by another phase derivation: ${stamped} (realm db migrate re-stamps them).`
      : undefined,
    facts.purged_ids === undefined ? undefined : `Purged runs: ${facts.purged_ids}.`,
    facts.tombstones_since === undefined || facts.tombstones_through_seq === undefined
      ? undefined
      : `Every run purged after ${facts.tombstones_since} keeps its tombstone (compacted through seq ${facts.tombstones_through_seq}).`,
  ].filter((line) => line !== undefined);
}

/** The report as text, line by line, in the order an operator reads it. */
function reportLines(report: CheckReport): string[] {
  const version =
    report.schema_version === undefined
      ? 'its schema version could not be read'
      : `schema version ${report.schema_version}`;
  return [
    `Checked ${report.path} (${version}; this version of Realm reads up to ${report.reads_up_to}).`,
    ...report.findings.flatMap(findingLines),
    ...report.not_run.map((entry) =>
      entry.part === undefined
        ? `Not run: ${entry.check} (because of ${entry.because}).`
        : `Not run: ${entry.check}, its ${entry.part} part (because of ${entry.because}).`,
    ),
    summaryLine(report),
    ...report.not_checked.map((entry) => `Not checked in this version: ${entry.why}`),
    ...factLines(report.facts),
    'Never delete, move or replace realm.db or its side files while a Realm process is running.',
  ];
}

export const dbCheckCommand = new Command('check')
  .description(
    "Report on the store file without writing it: SQLite's integrity check, the file's settings, version and schema, every run's stored record, the tables against each other, and what this version does not check",
  )
  .option('--json', 'Print the report as JSON on stdout, and nothing else')
  .action(async (opts: { json?: boolean }) => {
    const home = await openRealmHomeForMaintenance({ verb: 'check' });
    let status: CheckReport['status'];
    try {
      const report = await home.check();
      status = report.status;
      if (opts.json === true) printJsonByTable(report, CHECK_JSON_TABLE);
      else for (const line of reportLines(report)) console.log(line);
    } finally {
      home.close();
    }
    if (status === 'findings') process.exitCode = 1;
  });
