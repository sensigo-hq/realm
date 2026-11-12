// docs-616-c12.test.ts — issue #616 PR-2c, c12 (the docs switch-over; guardrails 7(f) and 9): every
// sentence c12 writes is quoted here word for word and asserted to be on its page, read from the
// repository, with the cell that pins what it says named beside it; the cells this unit adds run the
// BUILT CLI (or the CLI's home opener, in process) on a scratch home. Each assertion names (a) the change
// that turns it red and (b) what it prints when it fails. A path under a scratch home is compared as the
// pages show a home: the scratch HOME written `/home/dana`. The children run with REALM_NOT_SECRET=HOME:
// their stderr is a log here, and a log hides the home path, which a terminal shows whole.
//
// The old-format home (C2) is the committed fixture `fixtures/old-json-home/runs`: the `runs` folder of
// a JSON-store home as core's `JsonFileStore` wrote it (at main da77aa89, on a test location's clock at
// 2026-10-20T09:00:00.000Z — run e8e798ce… keyed `note-a`, so `keys/` exists; run 8372be7d… with one
// refused answer in its `.attempts.jsonl`), formatted by prettier (a final newline, nothing else). It is
// written once rather than by each run, so the guide's captures are exact, and it outlives the JSON
// classes, which PR-3 deletes.
//
// Every describe whose cells start the built CLI, the server or a node child carries a budget of its own
// (60 s; spawn-budget-guard.test.ts, #371).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { RunRecord } from '@sensigo/realm';
import { createTestHome } from '@sensigo/realm-testing';
import { plantRegistryRow } from '@sensigo/realm-store-sqlite/test-support';
import { openCliHome, type CliHome } from '../lib/home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/old-json-home', import.meta.url));
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** The CHANGELOG section that holds this unit's entries: `[Unreleased]` until a release renames it. */
function unreleased(): string {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  return text.slice(start, text.indexOf('\n## [0.48.0]'));
}
function claimChangelog(sentence: string): void {
  expect(flat(unreleased()), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}
/** A product file's text: the constant a page quotes. (a) red when the constant changes by a word;
 *  (b) prints the words. */
function inSource(file: string, words: string): void {
  expect(read(`packages/${file}`), `${file} no longer holds: ${words}`).toContain(words);
}
/** The `text` blocks of a page's section (from `heading` to the next `## `), list-indented or not. */
function blocksOf(page: string, heading: string): string[] {
  const text = read(page);
  const start = text.indexOf(`${heading}\n`);
  if (start < 0) throw new Error(`${page} has no heading: ${heading}`);
  const end = text.indexOf('\n## ', start + heading.length);
  const section = text.slice(start, end < 0 ? undefined : end);
  return [...section.matchAll(/^( *)```text\n([\s\S]*?)\n\1```$/gm)].map((m) =>
    m[2]!
      .split('\n')
      .map((l) => l.slice(m[1]!.length))
      .join('\n'),
  );
}

const ENV = 'docs/reference/environment-and-files.md';
const UPGRADE = 'docs/guides/upgrade.md';
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const WORKFLOW = 'docs/reference/cli/realm-workflow.md';
const CODES = 'docs/reference/error-codes.md';
const TOOLS = 'docs/reference/mcp/tools.md';
const CORE = 'docs/reference/core-library.md';
const TESTING = 'docs/reference/testing-package.md';
const IDEMPOTENCY = 'docs/guides/idempotency-and-batches.md';
const MOVE = '## Move your runs into the SQLite store';
const MIN = 60_000;

let scratch = '';
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'realm-c12-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface Ran {
  code: number | null;
  out: string;
  err: string;
}
/** The built CLI with an environment of PATH, HOME and REALM_NOT_SECRET, in a scratch folder. */
function realm(args: string[], home: string): Ran {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: scratch,
    env: { PATH: process.env['PATH'] ?? '', HOME: home, REALM_NOT_SECRET: 'HOME' },
    encoding: 'utf8',
  });
  const shown = (t: string): string => t.split(home).join('/home/dana');
  return { code: r.status, out: shown(r.stdout), err: shown(r.stderr) };
}
/** A fresh HOME under the scratch folder. */
function freshHome(name: string): string {
  const home = join(scratch, name);
  mkdirSync(home);
  return home;
}

describe(
  '#616 PR-2c c12 — the files on disk (environment-and-files.md)',
  { timeout: 60_000 },
  () => {
    it('C1: a fresh home after one command holds exactly the names the table gives, at their modes', () => {
      const home = freshHome('c1');
      const r = realm(['workflow', 'list'], home);
      const listing = readdirSync(join(home, '.realm')).sort();
      const text = read(ENV);
      const table = text.slice(
        text.indexOf('## Files under `~/.realm`'),
        text.indexOf('### The clock'),
      );
      const named = table
        .split('\n')
        .filter((l) => l.startsWith('| `'))
        .flatMap((l) => [...l.split('|')[1]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
      const mode = (n: string): string =>
        (statSync(join(home, '.realm', n)).mode & 0o777).toString(8);
      // (a) red when a command leaves another entry (a side file, a folder) or the page's table drops a
      //     name the home holds, or a mode moves; (b) prints the listing, the table's names, the stderr.
      expect(
        {
          code: r.code,
          listing,
          notOnThePage: listing.filter((n) => !named.includes(n)),
          modes: listing.map((n) => `${n} ${mode(n)}`),
        },
        `the page's table names: ${named.join(', ')}\n${r.err}`,
      ).toEqual({
        code: 0,
        listing: ['dedup', 'realm.db', 'replays', 'runs', 'workflows'],
        notOnThePage: [],
        modes: ['dedup 444', 'realm.db 600', 'replays 444', 'runs 444', 'workflows 444'],
      });
    });

    it('C1 (the side files): a killed process leaves realm.db-wal and realm.db-shm; the next command reads the run, and they go when it exits', () => {
      const home = freshHome('c1-crash');
      const store = pathToFileURL(join(ROOT, 'packages', 'store-sqlite', 'dist', 'index.js')).href;
      const killed = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `const { openRealmHome } = await import(${JSON.stringify(store)});
const h = await openRealmHome({ home: ${JSON.stringify(join(home, '.realm'))} });
await h.runStore.create({ workflowId: 'crash', workflowVersion: 1, params: {} });
process.kill(process.pid, 'SIGKILL');`,
        ],
        { encoding: 'utf8' },
      );
      const afterKill = readdirSync(join(home, '.realm')).sort();
      const r = realm(['run', 'list'], home);
      // (a) red when the killed process leaves no log (the sentence's crash case is then not one), the
      //     next command does not read the run the killed one wrote, or a side file stays after it
      //     exits; (b) prints both listings and the command's output.
      expect(
        {
          signal: killed.signal,
          afterKill,
          listed: r.out.includes(' crash v1 '),
          code: r.code,
          afterNext: readdirSync(join(home, '.realm')).sort(),
        },
        `${killed.stderr}\n${r.out}${r.err}`,
      ).toEqual({
        signal: 'SIGKILL',
        afterKill: [
          'dedup',
          'realm.db',
          'realm.db-shm',
          'realm.db-wal',
          'replays',
          'runs',
          'workflows',
        ],
        listed: true,
        code: 0,
        afterNext: ['dedup', 'realm.db', 'replays', 'runs', 'workflows'],
      });
    });

    it('the page’s new sentences', () => {
      // C1 (the listing after one command, the modes, the side files after a crash).
      for (const sentence of [
        'The file list comes from the code and from a listing of a home after one command.',
        'Every `realm` command and the `realm-mcp` server keep their data in one SQLite file in the Realm home. The first command on a new home creates the home folder, the store file and four fence files:',
        "| `realm.db` | The store: runs with their evidence, refused answers, trace lines and sealed lines; the registered workflows; saved replays; `realm listen`'s duplicate-webhook marks. Created owner-only (mode 0600). | Every command and tool that opens its stores |",
        "| `realm.db-wal`, `realm.db-shm` | SQLite's write-ahead log and its index, beside the file while a process has the store open. A Realm that exits normally leaves none behind; after a crash, the next Realm that opens the store replays the log, and the files go when it exits. | SQLite |",
        // The fence's own text says so (store-sqlite home.ts, FENCE_MARKER and the placed file's words).
        "| `runs`, `workflows`, `replays`, `dedup` | Four read-only fence files (mode 0444), a few lines of text each, at the names the old JSON store's folders had. A Realm from before the SQLite store that is pointed at this home fails on them at once instead of starting a second store. Do not delete them while Realm uses the home. | The first open of the home |",
        '| `.realm-fence-<name>-<pid>-<random>.tmp` | A fence file being placed; it exists for the length of one write. One left behind by a process that was killed can be deleted when no Realm process is running. | The first open of the home |',
        // realm-db.md's backup section (db-backup-616.test.ts): outside the home, `<path>.part-`.
        'Never delete, move or replace `realm.db` or its side files while a Realm process is running. `realm db backup <path>` writes its copy outside the home; a backup that was killed may leave files whose names begin `<path>.part-` beside its target, which you can delete.',
        '### Which commands remove data',
        // purge-sqlite-616.test.ts (the force line's `realm.db shrank by`); store-sqlite home-purge (the
        // run's rows and its artifact stores' rows, then vacuum and checkpoint when no other process holds it).
        "| `realm run purge` | An ended run: its record and evidence, its refused answers, trace lines and sealed lines — rows in `realm.db`. The space goes back to the file (the force line says by how much). Text of a deleted run may stay readable in the file's free pages and in `realm.db-wal` until the file is vacuumed and checkpointed, which the purge does when no other process is using the file. |",
        // store-sqlite dedup-store.ts (EXPIRED_PER_RECORD, below).
        'A duplicate-webhook mark expires at the end of its window; `realm listen` removes up to 100 expired marks of a workflow each time it records a new one. Nothing removes a registered workflow or a saved replay.',
        '## A store other than `realm.db`',
        'Every `realm` command and the `realm-mcp` server use the SQLite store in the Realm home. A program that calls Realm as a library can keep runs in a store of its own.',
        '- [`realm db`](cli/realm-db.md) covers `backup`, `migrate` and `check`.',
      ])
        claim(ENV, sentence);
      // C13: the names the page gives, in the store's code.
      inSource(
        'store-sqlite/src/home.ts',
        "`.realm-fence-${name}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`",
      );
      inSource('store-sqlite/src/maintenance.ts', '`${target}.part-${process.pid}-');
      inSource('store-sqlite/src/dedup-store.ts', 'export const EXPIRED_PER_RECORD = 100;');
    });
  },
);

describe(
  '#616 PR-2c c12 — the move procedure (upgrade.md), on the built CLI',
  { timeout: 60_000 },
  () => {
    it('C2: an old-format home is refused as the page shows; moved, registered, imported, listed, imported again', () => {
      const home = freshHome('c2');
      const realmHome = join(home, '.realm');
      mkdirSync(join(realmHome, 'workflows'), { recursive: true });
      cpSync(join(FIXTURE, 'runs'), join(realmHome, 'runs'), { recursive: true });
      const ids = readdirSync(join(FIXTURE, 'runs'))
        .filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))
        .map((n) => n.slice(0, -'.json'.length))
        .sort();
      const [refusalBlock, importBlock, listBlock] = blocksOf(UPGRADE, MOVE);
      const before = readdirSync(realmHome).sort();
      // (i) The first command.
      const first = realm(['run', 'list'], home);
      // (a) red when the refusal is not the page's line (a word changed on the page or in the store's
      //     sentence), goes to stdout, exits otherwise, or the open creates anything; (b) prints it.
      expect({
        code: first.code,
        out: first.out,
        err: first.err.trimEnd(),
        before,
        after: readdirSync(realmHome).sort(),
      }).toEqual({
        code: 1,
        out: '',
        err: refusalBlock,
        before: ['runs', 'workflows'],
        after: before,
      });
      // (ii) Step 3: the folders that exist, moved out; step 4: the workflow registered; step 5.
      mkdirSync(join(home, 'realm-old'));
      for (const name of ['runs', 'workflows', 'replays', 'dedup']) {
        try {
          renameSync(join(realmHome, name), join(home, 'realm-old', name));
        } catch {
          // `for those that exist`
        }
      }
      const source = join(scratch, 'c2-workflow.yaml');
      writeFileSync(
        source,
        'id: tidy-notes\nname: Tidy notes\nversion: 1\nsteps:\n  work:\n    description: Tidy the notes.\n    execution: auto\n    handler: noop\n',
      );
      const registered = realm(['workflow', 'register', source], home);
      const imported = realm(['run', 'import', join(home, 'realm-old', 'runs')], home);
      // (iii) Step 6.
      const listed = realm(['run', 'list'], home);
      // Step 7: again.
      const again = realm(['run', 'import', join(home, 'realm-old', 'runs')], home);
      // (a) red when the import's lines are not the page's (one line per record, the count line, the
      //     ignored-entries line), the list does not show the imported runs as the page does (the
      //     import did not land), a second import is not `unchanged`, or the attempts file and the key
      //     folder do not stay behind; (b) prints every output.
      expect({
        registered: registered.code,
        imported: [imported.code, imported.out.trimEnd(), imported.err],
        listed: [listed.code, listed.out.trimEnd(), ids.every((id) => listed.out.includes(id))],
        again: [again.code, again.out.trimEnd()],
        leftBehind: readdirSync(join(home, 'realm-old', 'runs')).filter(
          (n) => !n.endsWith('.json'),
        ),
      }).toEqual({
        registered: 0,
        imported: [0, importBlock, ''],
        listed: [0, listBlock, true],
        again: [
          0,
          [
            ...ids.map((id) => `unchanged  /home/dana/realm-old/runs/${id}.json`),
            '2 files: 2 unchanged.',
            'Ignored 2 entries that are not .json files.',
          ].join('\n'),
        ],
        leftBehind: [`${ids.find((id) => id.startsWith('8372be7d'))}.attempts.jsonl`, 'keys'],
      });
    });

    it('the page’s words: the exception, the five packages, the procedure and what stays behind', () => {
      // C2 above (the refusal, the steps, the import's lines, the list, the second import).
      for (const sentence of [
        'The outputs on this page are from a real upgrade from 0.48.0 to 0.49.0 on Node 22, except three blocks in step 2, kept as they were: the block that shows two versions in one project and the `ENGINE_HANDLER_FAILED` line, from an earlier upgrade from 0.43.0 to 0.45.0, and the two lines the 0.46.0 `realm` command printed for a project still on 0.43.0.',
        '**Runs carry over, with one exception.** Runs started on the old version can be listed, inspected and continued on the new one. The exception is the version after 0.48.0, which keeps runs in one SQLite file instead of JSON files: its first command on an old home refuses to run until you move the old folders out and import the runs. Do [the first section](#move-your-runs-into-the-sqlite-store) before anything else.',
        // store-sqlite-package-616.test.ts (the published set); the cli and mcp-server package.json "*".
        'There are five: `@sensigo/realm`, `@sensigo/realm-cli`, `@sensigo/realm-mcp`, `@sensigo/realm-testing` and, from the version after 0.48.0, `@sensigo/realm-store-sqlite`, which `@sensigo/realm-cli` and `@sensigo/realm-mcp` install for you.',
        'Runs from a home of 0.48.0 or earlier appear here once you have imported them (the first section).',
        MOVE,
        'From the version after 0.48.0, every `realm` command and the `realm-mcp` server keep their data in one SQLite file, `realm.db`, in the Realm home (`~/.realm`), and need Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later. Earlier versions kept JSON files in four folders there: `runs`, `workflows`, `replays` and `dedup`. The new version does not read them. Its first command on such a home prints one line, creates nothing and exits with code 1:',
        'The names in the parentheses are the folders it found.',
        "1. **Stop every Realm process that uses the home**: `realm listen`, `realm serve`, `realm mcp` or `realm-mcp` (restart the assistant's client afterwards) and any `realm agent` that is running.",
        '2. **Upgrade the packages** (step 2 below).',
        '3. **Move the four folders out of the home — do not delete them yet.** For example `mkdir ~/realm-old && mv ~/.realm/runs ~/.realm/workflows ~/.realm/replays ~/.realm/dedup ~/realm-old/`, for those that exist.',
        // run-store.ts's save() reads no registry (the two import tests register none).
        '4. **Register your workflows again from their source files**, `realm workflow register <path>` for each. The registry is not carried over: the new store registers a workflow from its file. Do it before importing, so that a run you then inspect or continue finds its workflow.',
        "5. **Import the runs**: `realm run import ~/realm-old/runs`. One line per file, then one line that counts them, then one that counts the folder's other entries (the `keys` folder, the `.attempts.jsonl` and trace files) as ignored:",
        '6. **Check** with `realm run list`: the imported runs are listed with any new ones.',
        '7. Once every line read `imported` or `unchanged`, you may delete the moved folders. Running the import again is safe: the runs it imported read `unchanged`.',
        '**What is not carried over** stays in the moved folders:',
        // run-import-core-616.test.ts (the three notes); run-import-616.test.ts (`.attempts.jsonl` not read).
        "- The import reads the files and moves none of them: the records stay in the moved folder until you delete it. Not imported from it: a run's refused answers (the old `<id>.attempts.jsonl` files), its trace buffer and sealed traces (the old `trace-buffer-…` and `sealed-trace-…` `.jsonl` files) and the `keys` folder (the store works out which run holds a key from the runs themselves). From an export bundle, its failed attempts, trace buffer and sealed traces are not imported either (the line's notes `attempts_not_imported`, `wal_not_imported`, `sealed_not_imported`).",
        '- The registered workflows (`workflows/`): register each again from its source (step 4).',
        // listen.ts: a delivery whose id matches an existing run (`created: false`) spawns nothing.
        "- Saved replays (`replays/`), and `realm listen`'s duplicate-webhook marks (`dedup/`). A delivery whose event id belongs to an imported run still starts nothing: the id is that run's idempotency key.",
      ])
        claim(UPGRADE, sentence);
    });

    it('C3: a diverged line names the live run that holds the key (the c11 amendment), on both pages', () => {
      claim(
        UPGRADE,
        '- A run whose idempotency key a live run already holds reads `diverged`, and its line names that run; the stored run is kept.',
      );
      // The row's own claim is docs-pages-625-acting.test.ts's; the line is executed by
      // run-import-core-616.test.ts's `run-holder` cell. (a) red when that cell no longer pins the
      // holder's name; (b) prints the cell's file.
      expect(read('packages/cli/src/commands/run-import-core-616.test.ts')).toContain(
        "the live run run-holder already holds this run's idempotency key",
      );
    });
  },
);

describe(
  '#616 PR-2c c12, review fixes (#1120) — an ID with a `/`; the home hidden in piped output',
  { timeout: 60_000 },
  () => {
    it('top-level-fields.md: an ID with a `/` validates, registers and lists like any other, on the built CLI', () => {
      claim(
        'docs/reference/workflow/top-level-fields.md',
        'The loader does not check which characters the ID contains: the store keeps the copy under the `id` as written, so an ID with a `/` passes `realm workflow validate` and registers and lists like any other.',
      );
      const home = freshHome('slash-id');
      const source = join(scratch, 'slash-id.yaml');
      writeFileSync(
        source,
        'id: team/notes\nname: Team notes\nversion: 1\nsteps:\n  work:\n    description: Work.\n    execution: auto\n    handler: noop\n',
      );
      const validated = realm(['workflow', 'validate', source], home);
      const registered = realm(['workflow', 'register', source], home);
      const listed = realm(['workflow', 'list'], home);
      // (a) red when an ID with a `/` is refused at validate or register, or is not listed; (b) prints
      //     the three outputs.
      expect({
        validated: [validated.code, validated.out.trimEnd()],
        registered: [registered.code, registered.out.trimEnd()],
        listed: [listed.code, listed.out.split('\n').some((l) => l.startsWith('team/notes '))],
      }).toEqual({
        validated: [0, 'Valid: team/notes v1 (1 step)'],
        registered: [0, 'Registered: team/notes v1 (1 step)'],
        listed: [0, true],
      });
    });

    it('upgrade.md: piped, the refusal and the import lines hide the home folder; the page says so', () => {
      claim(
        UPGRADE,
        "When the output goes to a file or a pipe, the home folder's name in this line and in the import's lines is hidden, as in every other output; a terminal shows it.",
      );
      const home = freshHome('piped');
      mkdirSync(join(home, '.realm'));
      cpSync(join(FIXTURE, 'runs'), join(home, '.realm', 'runs'), { recursive: true });
      // No REALM_NOT_SECRET here: the outputs go to pipes, which are a log.
      const piped = (args: string[]) =>
        spawnSync(process.execPath, [CLI, ...args], {
          cwd: scratch,
          env: { PATH: process.env['PATH'] ?? '', HOME: home },
          encoding: 'utf8',
        });
      const refused = piped(['run', 'list']);
      mkdirSync(join(home, 'realm-old'));
      renameSync(join(home, '.realm', 'runs'), join(home, 'realm-old', 'runs'));
      const imported = piped(['run', 'import', join(home, 'realm-old', 'runs')]);
      const lines = imported.stdout.split('\n').filter((l) => l.startsWith('imported  '));
      // (a) red when a piped line shows the home folder's name, or stops hiding it as `[REDACTED]`;
      //     (b) prints both outputs.
      expect(
        {
          refusal: [
            refused.stderr.includes(home),
            refused.stderr.includes(' in [REDACTED]/.realm. '),
          ],
          imports: [
            lines.length,
            lines.every((l) => l.startsWith('imported  [REDACTED]/realm-old/runs/')),
          ],
          homeShown: imported.stdout.includes(home),
        },
        `${refused.stderr}\n${imported.stdout}`,
      ).toEqual({ refusal: [false, true], imports: [2, true], homeShown: false });
    });
  },
);

describe('#616 PR-2c c12 — the duplicate window (webhooks.md, realm-listen.md, webhook-trigger.md)', () => {
  it('C4: a mark is counted from its record; a match, and a second record inside it, do not move it; a purge leaves it', async () => {
    const testHome = await createTestHome({
      start: '2031-03-04T05:06:07.000Z',
      root: join(scratch, 'c4', '.realm'),
    });
    let home: CliHome | undefined;
    try {
      home = await openCliHome({ home: testHome.root });
      const marks = home.dedupStoreFor('c12-webhook');
      await marks.record('evt-201', 10 * MIN);
      await testHome.clock.advance(5 * MIN);
      const atFive = await marks.check('evt-201', 10 * MIN);
      await marks.record('evt-201', 10 * MIN);
      await testHome.clock.advance(5 * MIN + 1_000);
      const pastTen = await marks.check('evt-201', 10 * MIN);
      // The listen bullet: a purge of the run does not clear its event's mark.
      await marks.record('evt-202', 10 * MIN);
      const { record } = await home.runStore.create({
        workflowId: 'c12-webhook',
        workflowVersion: 1,
        params: {},
        idempotencyKey: 'evt-202',
      });
      const ended = (
        await home.runStore.update({
          ...record,
          terminal_state: true,
          sealed_by: { arm: 'complete' },
          terminal_reason: 'Workflow completed.',
        })
      ).record;
      const report = await home.purge([{ runId: ended.id, version: ended.version }]);
      // (a) red when the window starts again at a match or a second record (the T+10 min + 1 s check
      //     then answers true), or a purge clears the mark; (b) prints the three answers.
      expect({
        atFive,
        pastTen,
        purged: report.runs.map((r) => r.outcome),
        afterPurge: await marks.check('evt-202', 10 * MIN),
      }).toEqual({ atFive: true, pastTen: false, purged: ['purged'], afterPurge: true });
    } finally {
      await home?.close();
      await testHome.remove();
    }
  });

  it('the three pages’ words', () => {
    const recorded =
      'The window is counted from the delivery that was recorded; a delivery matched in the meantime does not move it.';
    claim('docs/guides/webhooks.md', recorded);
    claim('docs/reference/cli/realm-listen.md', recorded);
    claim(
      'docs/reference/workflow/webhook-trigger.md',
      // listen.ts's spawn_failure branch records no id.
      'after the duplicate window (counted from the delivery that was recorded; a run ended by a failed start recorded no mark, so a delivery of its event reaches the store again),',
    );
  });
});

describe('#616 PR-2c c12 — the CHANGELOG’s Upgrading section', { timeout: 60_000 }, () => {
  it('C5: four numbered items, first in [Unreleased]', () => {
    // Item 1: C2 (the refusal, the procedure); item 2: the floor's words (driver.ts, below); item 3:
    // the packages (store-sqlite-package-616.test.ts); item 4: the cell below.
    for (const sentence of [
      "**1. Your runs move into one SQLite file (issue #616).** Every `realm` command and the `realm-mcp` server now keep runs, the workflow registry, replays, failed attempts, trace buffers and `realm listen`'s duplicate-webhook marks in `realm.db` in the Realm home.",
      "The first command on a home that still holds the old JSON folders (`runs`, `workflows`, `replays`, `dedup`) refuses with one line — `This Realm keeps its store in realm.db and does not read the old JSON directories (…) in <home>. Move them out of the home, then import what you want to keep with save() or realm run import.` (the store's sentence; its own code spans dropped here) — and creates nothing. Stop every Realm process, move the four folders out of the home, register your workflows again from their source files, then `realm run import <moved>/runs`. The procedure, with what is not carried over, is [Move your runs into the SQLite store](docs/guides/upgrade.md#move-your-runs-into-the-sqlite-store).",
      "**2. Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later.** The store uses Node's built-in SQLite at those versions; on an older Node the first command stops with one `Error:` line that ends with the floor's words, `Realm's store needs Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later.`",
      '**3. Five packages at one version.** `@sensigo/realm-store-sqlite` is published with the others and installed for you by `@sensigo/realm-cli` and `@sensigo/realm-mcp`; `npm ls @sensigo/realm` must still show one version.',
      "**4. The former `gc` and `reconcile` subcommands of `realm run`, and the former `migrate` subcommand of `realm workflow`, are removed.** A script that calls one now stops with `error: unknown command '<name>'` on stderr and exit code 1; what they did is done by the store (one transaction per write) and by `realm db migrate`.",
    ])
      claimChangelog(sentence);
    // (a) red when the section is not the first heading of [Unreleased]; (b) prints the heading.
    expect(/^### .*$/m.exec(unreleased())?.[0]).toBe('### Upgrading');
  });

  it("C5 (item 4), on the built CLI: each former subcommand stops with commander's line on stderr and exit 1, and creates nothing", () => {
    const home = freshHome('c5');
    const ran = (
      [
        [['run', 'gc'], 'gc'],
        [['run', 'reconcile'], 'reconcile'],
        [['workflow', 'migrate'], 'migrate'],
      ] as const
    ).map(([args, name]) => {
      const r = realm([...args], home);
      return [r.code, r.out, r.err === `error: unknown command '${name}'\n`];
    });
    // (a) red when a removed name runs, or the refusal changes; (b) prints each answer.
    expect({ ran, home: readdirSync(home) }).toEqual({
      ran: [
        [1, '', true],
        [1, '', true],
        [1, '', true],
      ],
      home: [],
    });
  });
});

describe('#616 PR-2c c12 — no JSON-era sentence is left (C6)', () => {
  /** Every hit that stays, by its words: L — true of a class the library still exports (PR-3 deletes
   *  it with its sentence); H — the old store's files as the import and the move procedure meet them. */
  const KEPT: ReadonlyArray<{ page: string; words: string; why: string }> = [
    {
      page: UPGRADE,
      words: 'mv ~/.realm/runs ~/.realm/workflows ~/.realm/replays ~/.realm/dedup ~/realm-old/',
      why: "H: the move procedure's own command names the old folders",
    },
    {
      page: UPGRADE,
      words: 'the `.attempts.jsonl` and trace files) as ignored',
      why: 'H: what the import counts as ignored in an old runs folder',
    },
    {
      page: UPGRADE,
      words: "a run's refused answers (the old `<id>.attempts.jsonl` files)",
      why: "H: the c11 amendment's must-say, what is not carried over",
    },
    {
      page: ACTING,
      words:
        "The old store's `<id>.attempts.jsonl` files are not `.json` files: they are not imported.",
      why: "H: the import section's own sentence on the old files it reads",
    },
    {
      page: CORE,
      words: 'The engine, the loader, the file stores, the built-in adapters.',
      why: 'L: `@sensigo/realm` still exports the JSON stores',
    },
    {
      page: CORE,
      words: '(a `JsonFileStore` run file that cannot be read as a run, for one:',
      why: "L: the library store's own error, in two paragraphs",
    },
    {
      page: CORE,
      words: 'are not how Realm keeps its data: a Realm home',
      why: "L: c10b-3a's sentence that the JSON classes are not the home's store",
    },
    {
      page: CORE,
      words: '`JsonFileStore` and `InMemoryStore` each have a `clock`',
      why: "L: the library classes' clocks",
    },
    {
      page: CORE,
      words: '`JsonFileStore` has a `runsDirPath` property',
      why: "L: the library class's members",
    },
    {
      page: CORE,
      words: "The file store's two errors, as a caller sees them:",
      why: "L: the library class's errors",
    },
    {
      page: CORE,
      words: 'as the file store does, lists all 8 fields',
      why: "L: the library class's listed fields",
    },
    {
      page: CORE,
      words: 'A `JsonFileStore` on a folder that several computers share is not supported',
      why: "L: the library class's clock limit",
    },
    {
      page: CORE,
      words: 'A `JsonFileStore` takes file locks',
      why: "L: the library class's locks",
    },
    {
      page: CORE,
      words: '| `JsonFileStore`, `JsonFileFailedAttemptStore`, `JsonTraceBufferStore` |',
      why: 'L: the library classes that implement the interface',
    },
    {
      page: CORE,
      words: "| the CLI's replay file store |",
      why: 'L: the class still in the CLI package (`JsonFileReplayStore`)',
    },
    {
      page: CODES,
      words:
        'its stored copy or the registry folder cannot be read; a program that calls Realm as a library may still use such a registry.',
      why: "L: the file registrar's code",
    },
    {
      page: TESTING,
      words: 'so a `JsonFileStore` opened on its `runsDir`',
      why: "L: `createTestLocation`, the testing package's own",
    },
    {
      page: TESTING,
      words: 'The file store reads a clock file, only when it sits beside `runs/`.',
      why: 'L: the library class, on a test location',
    },
    {
      page: TESTING,
      words: 'such as `JsonFileStore` on `location.runsDir`',
      why: "L: the clock contract's location route",
    },
  ];
  const NOUNS = [
    '~/.realm/runs',
    '~/.realm/workflows',
    '~/.realm/replays',
    'runs/<run-id>.json',
    '.attempts.jsonl',
    'JsonFileStore',
    'file store',
    'clock hour',
    'run gc',
    'run reconcile',
    'workflow migrate',
    'registry folder',
  ];

  it('the sweep over every docs page and README: the hits are the kept list, each kept entry a hit', () => {
    const markdown = (dir: string): string[] =>
      readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? markdown(join(dir, e.name))
          : e.name.endsWith('.md')
            ? [join(dir, e.name)]
            : [],
      );
    const pages = [
      ...markdown('docs'),
      'README.md',
      ...readdirSync(join(ROOT, 'packages'))
        .map((p) => `packages/${p}/README.md`)
        .filter((p) => {
          try {
            return statSync(join(ROOT, p)).isFile();
          } catch {
            return false;
          }
        }),
    ];
    const hits = pages.flatMap((page) =>
      read(page)
        .split('\n')
        .map((line, i) => ({ page, at: i + 1, line: flat(line) }))
        .filter(({ line }) => NOUNS.some((n) => line.toLowerCase().includes(n.toLowerCase()))),
    );
    const strays = hits
      .filter((h) => !KEPT.some((k) => k.page === h.page && h.line.includes(flat(k.words))))
      .map((h) => `${h.page}:${h.at}: ${h.line.slice(0, 200)}`);
    const unmatched = KEPT.filter(
      (k) => !hits.some((h) => h.page === k.page && h.line.includes(flat(k.words))),
    ).map((k) => `${k.page}: ${k.words}`);
    // (a) red when a JSON-era sentence comes back on any page (a stray), or a kept entry no longer
    //     names a line (the list is then stale); the instrument's input: the pages it read include
    //     the README and every package README; (b) prints the strays and the unmatched entries.
    expect({
      readEveryReadme: [
        'README.md',
        'packages/cli/README.md',
        'packages/core/README.md',
        'packages/store-sqlite/README.md',
      ].every((p) => pages.includes(p)),
      strays,
      unmatched,
    }).toEqual({ readEveryReadme: true, strays: [], unmatched: [] });
  });
});

describe(
  '#616 PR-2c c12 — realm workflow list on the store (realm-workflow.md)',
  { timeout: 60_000 },
  () => {
    it('C8: the three ⚠ lines are the page’s, on the built CLI; --json names each copy by id and its class, and mismatched is empty', async () => {
      const home = freshHome('c8');
      const realmHome = join(home, '.realm');
      const opened = await openCliHome({ home: realmHome });
      await opened.workflowStore.register({
        id: 'good',
        name: 'good',
        version: 1,
        schema_version: 1,
        steps: { work: { description: 'Work.', execution: 'auto', handler: 'noop' } },
      } as never);
      // The older cohort's shape (workflow-list-classes.test.ts K8).
      await opened.workflowStore.register({ id: 'old', name: 'old', version: 1 } as never);
      await opened.close();
      // A copy that is not JSON, and one a later Realm wrote: only from outside Realm.
      await plantRegistryRow(realmHome, { id: 'bad', text: '{ not json' });
      await plantRegistryRow(realmHome, {
        id: 'new',
        text: JSON.stringify({ id: 'new', name: 'new', version: 1, schema_version: 2, steps: {} }),
      });
      const text = realm(['workflow', 'list'], home);
      const json = realm(['workflow', 'list', '--json'], home);
      const listing = JSON.parse(json.out) as {
        unreadable: Array<{ workflow_id: string; class: string }>;
        mismatched: unknown[];
      };
      const block = blocksOf(WORKFLOW, '## `list`').find((b) => b.includes('⚠ 1 workflow'));
      // (a) red when the page's ⚠ lines are not what the command prints (the page keeps `rec627.json`),
      //     or --json loses an id or class, or `mismatched` is not empty; (b) prints both outputs.
      expect({
        code: [text.code, json.code],
        warned: text.err.trimEnd(),
        unreadable: listing.unreadable.map((u) => `${u.workflow_id} ${u.class}`),
        mismatched: listing.mismatched,
      }).toEqual({
        code: [0, 0],
        warned: block,
        unreadable: ['bad parse', 'new newer', 'old legacy'],
        mismatched: [],
      });
      claim(
        WORKFLOW,
        'The store reports these three kinds: a damaged stored copy, a copy a later version of Realm registered, and a copy an older version registered (added after version 0.48.0, which named the stored files instead).',
      );
      claim(
        WORKFLOW,
        '`unreadable` lists the registered copies that could not be read, each with its `workflow_id`, its `class` (`parse`, `newer` or `legacy`) and the `reason`. `mismatched` is always empty: the store keeps each copy under the `id` inside it.',
      );
    });
  },
);

describe('#616 PR-2c c12 — the testing package’s counts (testing-package.md)', () => {
  it('C10: the page’s numbers are the built index.js’s values and index.d.ts’s types', async () => {
    const dist = join(ROOT, 'packages', 'testing', 'dist');
    const values = Object.keys(
      (await import(pathToFileURL(join(dist, 'index.js')).href)) as object,
    ).length;
    const types = new Set(
      [
        ...readFileSync(join(dist, 'index.d.ts'), 'utf8').matchAll(/export type \{([^}]*)\}/g),
      ].flatMap((m) =>
        m[1]!
          .split(',')
          .map((n) => n.trim())
          .filter((n) => n !== ''),
      ),
    ).size;
    // (a) red when a value or a type is added or dropped without the page; (b) prints the sentence.
    claim(TESTING, `It exports ${values} values and ${types} types.`);
  });
});

describe(
  '#616 PR-2c c12 — which run holds a key (idempotency-and-batches.md, DELTAS rows 27 and 28)',
  { timeout: 60_000 },
  () => {
    const RULE =
      'Which run holds a key is worked out from the runs themselves: the newest live run that carries it, or, with no live run, the newest finished run that no other run of the key reruns.';
    const keyed = (key: string, extra: object = {}) => ({
      workflowId: 'sync',
      workflowVersion: 1,
      params: {},
      idempotencyKey: key,
      ...extra,
    });
    async function ended(home: CliHome, run: RunRecord, arm: string): Promise<RunRecord> {
      const reason = arm === 'complete' ? 'Workflow completed.' : "Step 'fetch' failed.";
      return (
        await home.runStore.update({
          ...run,
          ...(arm === 'complete' ? {} : { failed_steps: ['fetch'] }),
          terminal_state: true,
          sealed_by: { arm } as NonNullable<RunRecord['sealed_by']>,
          terminal_reason: reason,
        })
      ).record;
    }

    it('C11 (row 28): after the newest run of a key is purged, an older failed one holds it, and a default repeat returns it', async () => {
      claim(IDEMPOTENCY, RULE);
      claim(
        IDEMPOTENCY,
        'and after the newest run of a key is deleted (`realm run purge <id> --force`), an older finished run of that key, even a failed one, holds it again, and a repeat with the default `reuse` returns that run.',
      );
      const home = freshHome('c11-28');
      const realmHome = join(home, '.realm');
      let h = await openCliHome({ home: realmHome });
      const a = await ended(h, (await h.runStore.create(keyed('K'))).record, 'step_failure');
      const b = await ended(
        h,
        (await h.runStore.create(keyed('K', { onTerminalMatch: 'rerun' }))).record,
        'complete',
      );
      await h.close();
      const purged = realm(['run', 'purge', b.id, '--force'], home);
      h = await openCliHome({ home: realmHome });
      try {
        const repeat = await h.runStore.create(keyed('K'));
        // (a) red when the purged run's key answers no holder (a fresh run), or the rerun that was
        //     deleted (B) still holds it; (b) prints the three ids, the purge's output and the answer.
        expect(
          {
            rerunOf: b.rerun_of === a.id,
            purge: purged.code,
            holder: repeat.record.id === a.id,
            created: repeat.created,
          },
          `A ${a.id}, B ${b.id}, the repeat ${repeat.record.id}\n${purged.out}${purged.err}`,
        ).toEqual({ rerunOf: true, purge: 0, holder: true, created: false });
      } finally {
        await h.close();
      }
    });

    it('C11 (row 27): a failed run that was rerun, resumed, holds its key again', async () => {
      // The store's own cell: store-sqlite run-store-keyed-616.test.ts, "check 2b (iv): a LIVE run that a
      // finished run names in rerun_of still holds the key"; here the page's command makes it live.
      claim(
        IDEMPOTENCY,
        "So after a run that failed or was abandoned is rerun and the rerun has finished, resuming the first run (`realm run resume`) makes it the key's holder again;",
      );
      const home = freshHome('c11-27');
      const realmHome = join(home, '.realm');
      let h = await openCliHome({ home: realmHome });
      await h.workflowStore.register({
        id: 'sync',
        name: 'sync',
        version: 1,
        schema_version: 1,
        steps: { fetch: { description: 'Fetch.', execution: 'auto', handler: 'noop' } },
      } as never);
      const a = await ended(h, (await h.runStore.create(keyed('K2'))).record, 'step_failure');
      const b = await ended(
        h,
        (await h.runStore.create(keyed('K2', { onTerminalMatch: 'rerun' }))).record,
        'complete',
      );
      const before = (await h.runStore.create(keyed('K2'))).record.id;
      await h.close();
      const resumed = realm(['run', 'resume', a.id, '--from', 'fetch'], home);
      h = await openCliHome({ home: realmHome });
      try {
        const after = await h.runStore.create(keyed('K2'));
        // (a) red when the rerun B keeps the key after A is live again; (b) prints the ids and the
        //     resume's output.
        expect(
          {
            before: before === b.id,
            resume: resumed.code,
            holder: after.record.id === a.id,
            created: after.created,
          },
          `A ${a.id}, B ${b.id}\n${resumed.out}${resumed.err}`,
        ).toEqual({ before: true, resume: 0, holder: true, created: false });
      } finally {
        await h.close();
      }
    });
  },
);

describe('#616 PR-2c c12 — the other pages’ sentences, each with what pins it', () => {
  it('concepts, guides, references and READMEs', () => {
    const pages: Array<[string, string]> = [
      // store-sqlite store-schema (runs_identity, the evidence rows' append-only triggers); no hash on read;
      // realm-db.md's `check` (evidence hashes).
      [
        'docs/concepts/evidence.md',
        "Run records are rows in the store file `~/.realm/realm.db`. A connection that leaves triggers on cannot change a run's identity (its id, workflow, idempotency key, creation time and the run it reruns) or rewrite an evidence entry; a change made by SQL outside Realm that leaves a valid record is not detected: `realm run inspect` prints the edited text and shows no warning, and the hash is not checked again when the record is read (`realm db check` recomputes it).",
      ],
      [
        'docs/concepts/workflows-steps-and-runs.md',
        "stores a copy in the Realm home's store (`~/.realm/realm.db`), under the workflow's `id`.",
      ],
      [
        'docs/concepts/workflows-steps-and-runs.md',
        "Every run has one record in the Realm home's store, under the run ID. This is the run record.",
      ],
      [
        'docs/concepts/workflows-steps-and-runs.md',
        "The record is a row in the store file. A connection that leaves triggers on cannot change a run's identity or rewrite an evidence entry; a change made by SQL outside Realm that leaves a valid record is not detected.",
      ],
      // No command removes a registered workflow (no `unregister`: workflow*.ts).
      [
        'docs/guides/agent-created-workflows.md',
        'No command removes a registered workflow. Runs of it stay in the store',
      ],
      [
        'docs/guides/deploy.md',
        'Give write access to the project folder, and to the Realm home (`~/.realm`; its store file holds the registered workflows), only to people',
      ],
      // db-backup-616.test.ts (the whole file, `VACUUM INTO`, the copy checked, outside the home).
      [
        'docs/guides/operate-runs.md',
        "`realm db backup <path>` copies the whole store — every run, the registered workflows, replays, failed attempts, trace buffers and `realm listen`'s duplicate-webhook marks — to a new file outside the home and checks the copy; `realm run export` writes one run. See [`realm db`](../reference/cli/realm-db.md#backup).",
      ],
      // db-check-616.test.ts (the `File:` line's free-page count).
      [
        ACTING,
        'The next purge that deletes a run returns them.` `realm db check` reports the free-page count.',
      ],
      // replay.ts saves through the home's replay store.
      [
        'docs/reference/cli/realm-run-reading.md',
        "| `--save` | Stores the result in the Realm home's store and prints its ID. |",
      ],
      [
        WORKFLOW,
        "work on workflow files and on the workflows registered in the Realm home's store.",
      ],
      [
        WORKFLOW,
        "stores a copy in the Realm home's store (`~/.realm/realm.db`), under the workflow's `id`.",
      ],
      [
        'docs/reference/cli/realm-mcp-and-serve.md',
        '- **Workflows** are read from the store at each call.',
      ],
      // Probed over a real MCP client on the built `realm-mcp`: start_run on a later Realm's copy
      // carries the typed facts, on a copy that is not JSON `RESOURCE_FORMAT_INVALID` with `details`.
      [
        TOOLS,
        '(a registered workflow a later version of Realm wrote: `STATE_NEWER_FORMAT`, added after version 0.47.0)',
      ],
      [
        TOOLS,
        'A registered workflow whose stored copy is missing from the store or is not JSON is refused with `RESOURCE_FORMAT_INVALID`; the message says to register the workflow again from its source and, if it comes back, to restore the database from a backup. Any other error the store throws as a `WorkflowError` keeps its code.',
      ],
      // core registrar.ts (STATE_WORKFLOW_UNREADABLE, the file registrar only); store-sqlite workflow-store.ts.
      [
        CODES,
        "The workflow is registered in a registry of files, and its stored copy or the registry folder cannot be read; a program that calls Realm as a library may still use such a registry. The `realm` command's store has no files to read: a damaged stored copy there is `RESOURCE_FORMAT_INVALID`.",
      ],
      // run-import-core.ts (the `legacy` word); the legacy copy's message (workflow-list-classes K8).
      [
        CODES,
        'For a run, `realm run import` reports its file with the word `legacy` and nothing of it is imported; for a registered workflow, the message says to register it again from its source.',
      ],
      // execution-loop.ts (`retryable: false`); store-sqlite connection.ts (`STATE_RUN_BUSY`).
      [
        CODES,
        '`Failed to load run from store: …` is not worth retrying; a store that stays busy past its wait is reported by the SQLite store with its own line, not with this code.',
      ],
      // store-sqlite artifact-delete-failure.ts.
      [
        CODES,
        "A store could not delete a run's artifacts — its failed attempts or trace lines. The SQLite store names the store, the artifact and SQLite's result code; `details.failures` lists each one.",
      ],
      [
        CODES,
        "A workflow file is not valid YAML, or a registered workflow's stored copy is not valid JSON or is missing from the store. For a registered copy in the `realm` command's store, the message names the copy (`The registered copy of workflow '<id>' is missing from the store or is not JSON: …`), never a file.",
      ],
      [
        'docs/reference/glossary.md',
        '| Purge | To delete an ended run from the store, with `realm run purge`.',
      ],
      [
        'docs/reference/glossary.md',
        "| Register | To store a copy of a workflow under its ID in the Realm home's store, where every command and the MCP server find it.",
      ],
      [
        'docs/reference/glossary.md',
        '| Store | Where Realm keeps runs and workflows. The `realm` command and the `realm-mcp` server use one SQLite file, `~/.realm/realm.db`.',
      ],
      [
        'docs/reference/run-record-and-export.md',
        "In the `realm` command's store, the record is one row of `~/.realm/realm.db`.",
      ],
      [
        'docs/reference/run-record-and-export.md',
        "with the run's refused answers, trace lines and sealed lines, into one bundle.",
      ],
      [
        'docs/reference/run-record-and-export.md',
        'Realm rewrites the record each time the run changes, and adds 1 to `version` each time.',
      ],
      [
        'docs/reference/run-record-and-export.md',
        'and a program that reads the record should do the same with `deriveRunPhase`',
      ],
      // export.ts (the three lines on stderr, the three labels; C13 below).
      [
        'docs/reference/run-record-and-export.md',
        "When the store cannot read one of a run's artifacts — its refused answers (`failed-attempt sidecar`), its trace buffer (`trace-buffer WAL`) or its sealed traces (`sealed trace artifacts`) — the bundle is still written: `complete` is `false` and `artifact_errors` lists each artifact with the failure's `code` and `message`. The command prints `⚠ INCOMPLETE export: <n> artifact(s) could not be read`, one `  ✗ <artifact> (<code>): <message>` line each (indented two spaces), and `The bundle was still written to '<path>' — inspect it for what could be recovered.`, all on standard error.",
      ],
      [
        'docs/reference/workflow/top-level-fields.md',
        "The registered copy is stored in the Realm home's store under this `id`.",
      ],
      [
        'docs/start/what-is-realm.md',
        'Workflows and run records are kept in one SQLite file in your home folder, `~/.realm/realm.db`.',
      ],
      [
        'packages/cli/README.md',
        "| `--register` | Store the workflow definition in the Realm home's store, as `realm workflow register` does |",
      ],
      // docs-examples-625.test.ts runs the quick start on a fresh HOME through openRealmHome.
      [
        'packages/core/README.md',
        '| `openRealmHome` | From `@sensigo/realm-store-sqlite`: the store every `realm` command uses, in the Realm home. |',
      ],
      [
        'packages/store-sqlite/README.md',
        "Realm's own store package: `@sensigo/realm-cli` and `@sensigo/realm-mcp` install it for you; a program that opens the Realm home's store itself, as the `@sensigo/realm` quick start does, installs it beside `@sensigo/realm`.",
      ],
      // Probed on Node 24.21.0 and 24.13.1: each case REJECTS with a WorkflowError; mcp-server
      // foreign-test-clock-715.test.ts (`realm-mcp: <message>`).
      [
        'packages/store-sqlite/README.md',
        "A home that cannot be opened — the old JSON folders still there, a folder Realm cannot write to, a Node below the floor — rejects the promise with the store's typed error (`WorkflowError`): catch it; the `realm-mcp` command prints one masked line for it.",
      ],
    ];
    for (const [page, sentence] of pages) claim(page, sentence);
  });

  it('C13: every product line a page quotes is the code’s own', () => {
    // The refusal (upgrade.md, CHANGELOG item 1): C2 executes it; the store's sentence.
    inSource('store-sqlite/src/home.ts', 'does not read the old JSON directories (');
    // (the source escapes its code spans' backticks inside its template literal)
    inSource(
      'store-sqlite/src/home.ts',
      'Move them out of the home, then import what you want to keep with \\`save()\\` or \\`realm run import\\`.',
    );
    // The import's lines (upgrade.md step 5): C2 executes them; the command's words.
    inSource(
      'cli/src/commands/run-import.ts',
      '`Ignored ${entries} entries that are not .json files.`',
    );
    // The Node floor (upgrade.md, CHANGELOG item 2): `NODE_FLOORS` is not exported; its text.
    inSource(
      'store-sqlite/src/driver.ts',
      "Realm's store needs Node 22.22.3 or a later 22.x release, or Node 24.15.0 or later.",
    );
    // The export's three lines and three labels (run-record-and-export.md).
    inSource(
      'cli/src/commands/export.ts',
      '`⚠ INCOMPLETE export: ${bundle.artifact_errors.length} artifact(s) could not be read`',
    );
    inSource('cli/src/commands/export.ts', '`  ✗ ${e.artifact} (${e.code}): ${e.message}`');
    inSource(
      'cli/src/commands/export.ts',
      "`The bundle was still written to '${target}' — inspect it for what could be recovered.`",
    );
    for (const label of ['failed-attempt sidecar', 'trace-buffer WAL', 'sealed trace artifacts'])
      inSource('cli/src/commands/export.ts', `'${label}'`);
    // The damaged copy's message (error-codes.md's RESOURCE_FORMAT_INVALID row).
    inSource('store-sqlite/src/workflow-store.ts', "' is missing from the store or is not JSON: ");
  });
});
