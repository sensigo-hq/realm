// corpus.test.ts — CP-7: every published release's files, read back by this tree. For each folder
// `packages/cli/src/corpus/<version>/` that scripts/corpus/record.mjs recorded from the PUBLISHED
// release (a folder holding only `PENDING` is not a corpus: corpus-guard.test.ts owns it), the cells
// read what that release wrote with the current store, importer, composer and loader, and require
// the shapes it recorded:
//   (i)    its `realm.db`, gunzipped alone into a fresh home, checked and migrated through the
//          maintenance entry, then opened with the normal door: each run read equals the `run` of
//          that run's recorded bundle;
//   (ii-a) each bundle imported into a fresh store ends `imported`, its notes carry the bundle's own
//          counts, and the record read back equals the bundle's `run`;
//   (ii-b) the current composer over the store from (i), with the disclosure set built from the
//          corpus (the recorder's project files and environment names), equals the bundle;
//   (iii)  the current loader parses each example workflow file, and the definition holds every key
//          and value the recorded one has (a key it newly fills is allowed; a dropped or changed key
//          fails).
// Both sides go through corpus-rules.json (the recorder applied it too) and are compared as text
// after parsing (key order and values kept, whitespace out). (iv) An intended change is a reviewed
// exception file beside the artifact, `<artifact>.after-roundtrip.json` (for a bundle it is the
// comparator of (i), (ii-a) and (ii-b) alike); one equal to the artifact fails as stale. A missing or
// unreadable artifact fails; nothing is skipped.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  buildDisclosureSet,
  collectManifestSecretRefs,
  loadWorkflowFromFileWithDiagnostics,
  parseDeploymentManifest,
  WorkflowError,
} from '@sensigo/realm';
import {
  openRealmHome,
  openRealmHomeForMaintenance,
  type RealmHome,
} from '@sensigo/realm-store-sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { buildExportBundle } from '../commands/export.js';
import { importFile } from '../commands/run-import-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../..');

interface CorpusRules {
  work_placeholder: { value: string };
  uuid: { pattern: string; placeholder_prefix: string };
  keys: {
    values: Record<string, unknown>;
    nested: { values: Record<string, unknown> };
  };
  runtime_only_workflow_keys: { values: string[] };
}

interface CorpusManifest {
  version: string;
  work: string;
  work_realpath: string;
  start: string;
  cli_environment: string[];
  runs: Record<string, string>;
  examples: string[];
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const RULES = JSON.parse(readFileSync(join(HERE, 'corpus-rules.json'), 'utf8')) as CorpusRules;

/**
 * corpus-rules.json applied to one artifact, as record.mjs applies it: each folder in `works` → the
 * WORK placeholder (wherever it appears in the text), the named keys' values, then every v4 UUID → a
 * fixed v4 UUID numbered by first appearance in the text.
 */
function scrub(value: unknown, works: readonly string[] = []): Json {
  let text = JSON.stringify(value);
  for (const work of new Set(works)) text = text.split(work).join(RULES.work_placeholder.value);
  const replaceKeys = (node: Json, parent: string): Json => {
    if (Array.isArray(node)) return node.map((item) => replaceKeys(item, parent));
    if (node === null || typeof node !== 'object') return node;
    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(node)) {
      if (Object.hasOwn(RULES.keys.values, key)) out[key] = RULES.keys.values[key] as Json;
      else if (Object.hasOwn(RULES.keys.nested.values, `${parent}.${key}`)) {
        out[key] = RULES.keys.nested.values[`${parent}.${key}`] as Json;
      } else out[key] = replaceKeys(item, key);
    }
    return out;
  };
  text = JSON.stringify(replaceKeys(JSON.parse(text) as Json, ''));
  const seen = new Map<string, string>();
  text = text.replace(new RegExp(RULES.uuid.pattern, 'g'), (id) => {
    if (!seen.has(id)) {
      seen.set(id, RULES.uuid.placeholder_prefix + String(seen.size + 1).padStart(12, '0'));
    }
    return seen.get(id)!;
  });
  return JSON.parse(text) as Json;
}

/** The compared text: parsed, then stringified, key order and values kept. */
function text(value: Json): string {
  return JSON.stringify(value, null, 2);
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shown(value: Json | undefined): string {
  const s = JSON.stringify(value) ?? 'undefined';
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** Where two shapes differ, one line per place: a missing, new or changed key, a length, an order. */
function shapeDiff(expected: Json, actual: Json, path = ''): string[] {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const lines: string[] = [];
    if (expected.length !== actual.length) {
      lines.push(`~ ${path || '(root)'}: ${expected.length} items → ${actual.length}`);
    }
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
      lines.push(...shapeDiff(expected[i]!, actual[i]!, `${path}[${i}]`));
    }
    return lines;
  }
  if (isObject(expected) && isObject(actual)) {
    const lines: string[] = [];
    for (const key of Object.keys(expected)) {
      if (!Object.hasOwn(actual, key)) lines.push(`- ${path}.${key} (missing)`);
      else lines.push(...shapeDiff(expected[key]!, actual[key]!, `${path}.${key}`));
    }
    for (const key of Object.keys(actual)) {
      if (!Object.hasOwn(expected, key))
        lines.push(`+ ${path}.${key} (new): ${shown(actual[key])}`);
    }
    const order = (o: object, other: object): string =>
      Object.keys(o)
        .filter((k) => Object.hasOwn(other, k))
        .join(',');
    if (order(expected, actual) !== order(actual, expected)) {
      lines.push(
        `~ ${path || '(root)'}: key order ${order(expected, actual)} → ${order(actual, expected)}`,
      );
    }
    return lines;
  }
  return JSON.stringify(expected) === JSON.stringify(actual)
    ? []
    : [`~ ${path || '(root)'}: ${shown(expected)} → ${shown(actual)}`];
}

/** Every key and value of `recorded` that `current` does not hold as it is (extra keys allowed). */
function missingFrom(recorded: Json, current: Json | undefined, path = ''): string[] {
  if (Array.isArray(recorded)) {
    if (!Array.isArray(current)) return [`~ ${path}: ${shown(recorded)} → ${shown(current)}`];
    const lines =
      recorded.length === current.length
        ? []
        : [`~ ${path}: ${recorded.length} items → ${current.length}`];
    for (let i = 0; i < Math.min(recorded.length, current.length); i++) {
      lines.push(...missingFrom(recorded[i]!, current[i], `${path}[${i}]`));
    }
    return lines;
  }
  if (isObject(recorded)) {
    if (!isObject(current)) return [`~ ${path}: ${shown(recorded)} → ${shown(current)}`];
    const lines: string[] = [];
    for (const key of Object.keys(recorded)) {
      if (!Object.hasOwn(current, key)) lines.push(`- ${path}.${key} (missing)`);
      else lines.push(...missingFrom(recorded[key]!, current[key], `${path}.${key}`));
    }
    return lines;
  }
  return JSON.stringify(recorded) === JSON.stringify(current)
    ? []
    : [`~ ${path}: ${shown(recorded)} → ${shown(current)}`];
}

/** Requires `actual` to equal `expected` as compared text; on failure, the places they differ. */
function expectSameShape(actual: Json, expected: Json, what: string): void {
  const lines = shapeDiff(expected, actual);
  expect(
    text(actual),
    `${what} differs from the recorded shape:\n${lines.slice(0, 40).join('\n')}`,
  ).toBe(text(expected));
}

function readJson(file: string): Json {
  return JSON.parse(readFileSync(file, 'utf8')) as Json;
}

const rel = (file: string): string => relative(REPO, file);

/**
 * (iv) The shape the cells require of an artifact: its exception file when one lies beside it, else
 * the artifact itself. An exception file equal to the artifact (after the rules) fails as stale.
 */
function comparator(file: string): Json {
  const original = readJson(file);
  const exception = file.replace(/\.json$/, '.after-roundtrip.json');
  if (!existsSync(exception)) return original;
  const expected = readJson(exception);
  if (text(scrub(expected)) === text(scrub(original))) {
    throw new Error(
      `${rel(exception)} is stale: it equals ${rel(file)}. Delete it: the artifact reads as it was recorded.`,
    );
  }
  return expected;
}

function runOf(bundle: Json, file: string): Json {
  if (!isObject(bundle) || !isObject(bundle['run'])) throw new Error(`${rel(file)} holds no run`);
  return bundle['run'];
}

/** The corpus folders: one per published version from 0.49.0 on, and the marker-only ones apart. */
const FOLDERS = readdirSync(HERE, { withFileTypes: true })
  .filter((d) => d.isDirectory() && /^\d+\.\d+\.\d+$/.test(d.name))
  .map((d) => d.name);
const CORPORA = FOLDERS.filter((v) => readdirSync(join(HERE, v)).some((n) => n !== 'PENDING'));

const opened: RealmHome[] = [];
const folders: string[] = [];
afterAll(() => {
  for (const home of opened.splice(0)) home.close();
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'realm-corpus-'));
  folders.push(dir);
  return dir;
}

/** A refusal of the file at this Realm's own format version: a schema change without its bump. */
function equalVersionRefusal(version: string, err: unknown): Error | undefined {
  if (err instanceof WorkflowError && err.code === 'STATE_STORE_SCHEMA_TAMPERED') {
    return new Error(
      `${version}'s realm.db is refused at this Realm's own format version (${err.code}): a schema ` +
        'change shipped without its bump. The remedy is the format version bump and a ladder step, ' +
        `never an exception file. ${err.message}`,
    );
  }
  return undefined;
}

/** (i)'s store: the release's realm.db alone in a fresh home (no clock file), checked, migrated, opened. */
async function openReleaseStore(version: string): Promise<RealmHome> {
  const dir = freshFolder();
  writeFileSync(
    join(dir, 'realm.db'),
    gunzipSync(readFileSync(join(HERE, version, 'realm.db.gz'))),
    { mode: 0o600 },
  );
  try {
    const check = await openRealmHomeForMaintenance({ home: dir, verb: 'check' });
    try {
      const report = await check.check();
      expect(
        { status: report.status, findings: report.findings, not_run: report.not_run },
        `${version}'s realm.db fails the store check`,
      ).toEqual({ status: 'ok', findings: [], not_run: [] });
    } finally {
      check.close();
    }
    const maintenance = await openRealmHomeForMaintenance({ home: dir, verb: 'migrate' });
    try {
      await maintenance.migrate({ backup: false });
    } finally {
      maintenance.close();
    }
    const home = await openRealmHome({ home: dir });
    opened.push(home);
    return home;
  } catch (err) {
    throw equalVersionRefusal(version, err) ?? err;
  }
}

const stores = new Map<string, Promise<RealmHome>>();
function releaseStore(version: string): Promise<RealmHome> {
  if (!stores.has(version)) stores.set(version, openReleaseStore(version));
  return stores.get(version)!;
}

/** The release's stored run of `workflowId`: exactly one. */
async function storedRunId(home: RealmHome, workflowId: string): Promise<string> {
  const ids: string[] = [];
  for await (const page of home.runStore.scan(
    { workflow: workflowId },
    { pageSize: 100, projection: 'record' },
  )) {
    for (const item of page.items) if (item.kind === 'run') ids.push(item.run.record.id);
  }
  expect(ids, `the stored runs of ${workflowId}`).toHaveLength(1);
  return ids[0]!;
}

/** The disclosure set (ii-b) builds from the corpus: the recorder's project and environment names. */
function corpusDisclosureSet(version: string, manifest: CorpusManifest) {
  const project = join(HERE, version, 'project');
  const parsed = parseDeploymentManifest(readFileSync(join(project, 'realm.yaml'), 'utf8'));
  if (!('document' in parsed)) throw new Error(`${version}'s project/realm.yaml does not parse`);
  const standIn = new Map(
    readFileSync(join(project, 'stand-in.env'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const declared: Record<string, string> = {};
  for (const { name } of collectManifestSecretRefs(parsed.document)) {
    const value = standIn.get(name);
    if (value === undefined) throw new Error(`project/stand-in.env has no ${name}`);
    declared[name] = value;
  }
  // The values the recorder's CLI saw, as placeholders: they occur nowhere in a recorded file.
  const placeholder = RULES.work_placeholder.value;
  const values: Record<string, string> = { PATH: '/realm-corpus/bin', HOME: `${placeholder}/home` };
  const env = Object.fromEntries(manifest.cli_environment.map((name) => [name, values[name]]));
  return buildDisclosureSet({
    env,
    cwd: `${placeholder}/project`,
    declared,
    declaredState: 'resolved',
    audience: 'file',
  }).set;
}

/** The count a note gives, `<label>: N line(s)`; 0 when the importer wrote no such note. */
function notedCount(notes: readonly string[], label: string): number {
  const note = notes.find((n) => n.startsWith(`${label}:`));
  if (note === undefined) return 0;
  const m = /^[a-z_]+: (\d+) line/.exec(note);
  if (m === null) throw new Error(`the note "${note}" carries no count`);
  return Number(m[1]);
}

function walLines(wal: Json | undefined): number {
  return isObject(wal)
    ? Object.values(wal).reduce<number>(
        (n, lines) => n + (Array.isArray(lines) ? lines.length : 0),
        0,
      )
    : 0;
}

describe('the corpus: each published release read back by this tree', () => {
  it('holds a recorded corpus (0.49.0 on)', () => {
    expect(CORPORA).toContain('0.49.0');
  });

  for (const version of CORPORA) {
    describe(version, () => {
      const folder = join(HERE, version);
      const manifestFile = join(folder, 'manifest.json');
      const manifest = (): CorpusManifest =>
        JSON.parse(readFileSync(manifestFile, 'utf8')) as CorpusManifest;
      const works = (): string[] => [manifest().work, manifest().work_realpath];
      const runNames = (): string[] => Object.keys(manifest().runs);
      const bundleFile = (name: string): string => join(folder, 'runs', `${name}.realm.json`);

      it('(i) its realm.db: each stored run reads as its bundle recorded it', async () => {
        expect(manifest().version).toBe(version);
        expect(runNames()).toEqual(['08-pr-review', 'one-step']);
        const home = await releaseStore(version);
        for (const name of runNames()) {
          const recorded = runOf(readJson(bundleFile(name)), bundleFile(name));
          const expected = runOf(comparator(bundleFile(name)), bundleFile(name));
          const workflowId = isObject(recorded) ? String(recorded['workflow_id']) : '';
          const id = await storedRunId(home, workflowId);
          const { record } = await home.runStore.get(id);
          expectSameShape(
            scrub(record, works()),
            scrub(expected),
            `${version} ${name}: the stored run`,
          );
        }
      });

      it('(ii-a) each bundle imports: `imported`, its notes carry its counts, the run reads back as it was', async () => {
        for (const name of runNames()) {
          const file = bundleFile(name);
          const bundle = readJson(file);
          if (!isObject(bundle)) throw new Error(`${rel(file)} is not an object`);
          const expected = runOf(comparator(file), file);
          const home = await openRealmHome({ home: freshFolder() });
          opened.push(home);
          const result = await importFile(file, { runStore: home.runStore });
          if (result.kind !== 'word') throw result.error;
          expect(
            { word: result.word, reason: result.reason },
            `${version} ${name}: the import`,
          ).toEqual({
            word: 'imported',
            reason: undefined,
          });
          const attempts = Array.isArray(bundle['attempts']) ? bundle['attempts'].length : 0;
          const sealed = isObject(bundle['sealed']) ? Object.keys(bundle['sealed']).length : 0;
          expect(
            {
              wal: notedCount(result.notes, 'wal_not_imported'),
              attempts: notedCount(result.notes, 'attempts_not_imported'),
              sealed: result.notes.includes('sealed_not_imported'),
            },
            `${version} ${name}: the import's notes (${JSON.stringify(result.notes)})`,
          ).toEqual({ wal: walLines(bundle['wal']), attempts, sealed: sealed > 0 });
          const run = runOf(bundle, file);
          const { record } = await home.runStore.get(isObject(run) ? String(run['id']) : '');
          expectSameShape(
            scrub(record, works()),
            scrub(expected),
            `${version} ${name}: the imported run`,
          );
        }
      });

      it('(ii-b) the current composer over its realm.db writes each bundle as it was recorded', async () => {
        const home = await releaseStore(version);
        const set = corpusDisclosureSet(version, manifest());
        for (const name of runNames()) {
          const expected = comparator(bundleFile(name));
          const recorded = runOf(readJson(bundleFile(name)), bundleFile(name));
          const workflowId = isObject(recorded) ? String(recorded['workflow_id']) : '';
          const id = await storedRunId(home, workflowId);
          const { bundle } = await buildExportBundle(
            id,
            {
              runStore: home.runStore,
              failedAttemptStore: home.failedAttemptStore,
              traceBufferStore: home.traceBufferStore,
            },
            new Date(manifest().start),
            set,
          );
          expectSameShape(
            scrub(bundle, works()),
            scrub(expected),
            `${version} ${name}: the bundle`,
          );
        }
      });

      it('(iii) the current loader reads each example workflow file with every recorded key and value', () => {
        const examples = manifest().examples;
        expect(examples).toHaveLength(9);
        for (const name of examples) {
          const dir = join(folder, 'examples', name);
          const recorded = scrub(comparator(join(dir, 'definition.json')));
          const { definition } = loadWorkflowFromFileWithDiagnostics(join(dir, 'workflow.yaml'));
          const kept: Record<string, unknown> = { ...definition };
          for (const key of RULES.runtime_only_workflow_keys.values) delete kept[key];
          // The example's folder in the corpus stands where it stood in WORK when it was recorded.
          const current = scrub(kept, [folder]);
          const lines = missingFrom(recorded, current);
          expect(lines, `${version} ${name}: what the current loader no longer gives`).toEqual([]);
        }
      });
    });
  }
});
