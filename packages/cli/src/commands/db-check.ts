// db-check.ts — issue #616 PR-2c, unit c8a2 (design d4-frozen-r3 §8; DELTAS 50–54): `realm db check
// [--json]`. It opens the home through the store package's maintenance entry for this verb
// (`openRealmHomeForMaintenance({ verb: 'check' })`), calls the handle's `check()` and prints the
// report. The store composes every finding's words (one composer); this file words only the lines
// around them. It never says the store is healthy: it says what the checks that ran found, and what
// this version does not check. The exit code is 0 only when every check ran and found nothing; it is
// set after the report is printed, and never by exiting inside the `try`, which would skip `close()`.
// Every refusal is a typed one, printed by the entry as one `Error:` line with exit code 1
// (`lib/expected-refusal.ts`).
//
// The filter-mask fix, PR 2: `--project <dir>` reads the project's `realm.yaml` and resolves its
// `${secret:NAME}` values as the read commands do (`lib/read-run-manifest.ts`: no project code runs),
// then asks the check to look for their changed forms (the store's `declared_forms` check). The values
// cross in process only; the writer is given them too, so a value that reached a printed line would be
// masked. A folder with no `realm.yaml`, a manifest that cannot be read or is invalid, or a secret it
// names that cannot be resolved is refused before the store is opened: nothing is scanned.
//
// Callback K2b: the check counts the stored callback keys and, given this shell's master key
// fingerprint, how many were recorded under another. The master key is resolved after the store
// opened and is declared to the writer; a setting that gives no key only means nothing is compared.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  collectManifestSecretRefs,
  parseDeploymentManifest,
  realmHomePath,
  WorkflowError,
  type DisclosureClass,
} from '@sensigo/realm';
import {
  openRealmHomeForMaintenance,
  type CheckFacts,
  type CheckFinding,
  type CheckNotChecked,
  type CheckNotRun,
  type CheckReport,
} from '@sensigo/realm-store-sqlite';
import { addDeclaredDisclosure, printJsonByTable } from '../output/writer.js';
import { resolveManifestSecrets } from '../extensions/manifest-secrets.js';
import { declareMasterKey } from '../lib/callback/declare-master-key.js';
import { resolveMasterKey } from '../lib/callback/master-key.js';

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
      callback_keys: 'fact',
      callback_keys_other_master: 'fact',
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
      // The filter-mask fix, PR 2: a script purges by `run_id`; none of the three holds a value.
      run_id: 'fact',
      path: 'fact',
      kind: 'fact',
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

/** The callback keys' line (K2b): only when the store holds any. */
function keysLine(facts: CheckFacts): string | undefined {
  const n = facts.callback_keys ?? 0;
  if (n === 0) return undefined;
  const other = facts.callback_keys_other_master;
  if (other === undefined)
    return `Callback keys: ${n} stored; this shell has no usable master key, so none were compared.`;
  return other === 0
    ? `Callback keys: ${n} stored, all recorded as sealed under this shell's master key.`
    : `Callback keys: ${n} stored, ${other} sealed under another master key than this shell's.`;
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
    keysLine(facts),
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

/** A refusal of `--project`, before the store is opened. */
function projectRefused(message: string, path: string, reason: string): WorkflowError {
  return new WorkflowError(`realm db check --project: ${message}`, {
    code: 'STATE_STORE_CHECK_REFUSED',
    category: 'STATE',
    agentAction: 'report_to_user',
    retryable: false,
    details: { path, reason },
  });
}

/**
 * The project's declared values: its `realm.yaml`'s `${secret:NAME}` values, resolved from the sources
 * it declares, as the read commands resolve them. Every failure is a refusal that names no value.
 */
function declaredValuesOf(dir: string): Record<string, string> {
  const root = resolve(dir);
  const path = join(root, 'realm.yaml');
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT') throw projectRefused(`no realm.yaml in ${root}.`, path, 'no_manifest');
    throw projectRefused(
      `cannot read '${path}': ${typeof code === 'string' ? code : String(err)}.`,
      path,
      'manifest_unreadable',
    );
  }
  const parsed = parseDeploymentManifest(text);
  if ('error' in parsed) {
    throw projectRefused(
      parsed.error.kind === 'yaml'
        ? `'${path}' is not valid YAML.`
        : `'${path}' is invalid: ${parsed.error.errors[0] ?? 'invalid'}.`,
      path,
      'manifest_invalid',
    );
  }
  try {
    const refs = collectManifestSecretRefs(parsed.document);
    return resolveManifestSecrets(refs, parsed.document.secrets, root, 'real').values;
  } catch (err) {
    // The resolver's one error names every `${secret:NAME}` it could not resolve, and no value.
    throw projectRefused(
      `${err instanceof Error ? err.message : String(err)}\nNothing was scanned.`,
      path,
      'secret_unresolved',
    );
  }
}

export const dbCheckCommand = new Command('check')
  .description(
    "Report on the store file without writing it: SQLite's integrity check, the file's settings, version and schema, every run's stored record, the tables against each other, and what this version does not check",
  )
  .option('--json', 'Print the report as JSON on stdout, and nothing else')
  .option(
    '--project <dir>',
    "Also name each stored run that holds a changed form (upper-cased, lower-cased, capitalised, title-cased or truncated) of a secret the project's realm.yaml declares",
  )
  .action(async (opts: { json?: boolean; project?: string }) => {
    // Refused before the store is opened: nothing is scanned.
    const declared = opts.project === undefined ? undefined : declaredValuesOf(opts.project);
    if (declared !== undefined) addDeclaredDisclosure(declared, undefined);
    const home = await openRealmHomeForMaintenance({ verb: 'check' });
    let status: CheckReport['status'];
    try {
      // After the open, so a refusal of the store is not held up by the master key's command.
      const master = resolveMasterKey({ env: process.env, homeDir: realmHomePath() });
      if (master.state === 'found') declareMasterKey(master.key);
      const report = await home.check({
        ...(declared === undefined ? {} : { declaredValues: Object.values(declared) }),
        masterFp: master.state === 'found' ? master.fp : null,
      });
      status = report.status;
      if (opts.json === true) printJsonByTable(report, CHECK_JSON_TABLE);
      else for (const line of reportLines(report)) console.log(line);
    } finally {
      home.close();
    }
    if (status === 'findings') process.exitCode = 1;
  });
