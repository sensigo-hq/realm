// actor-who-ended-625.test.ts — #625 PR-2b, the actor unit: who ended a run, on the CLI.
//
// Ana's order run ends, and every screen says how, but never who: she cannot tell her colleague's
// `realm run abandon` from the assistant's `abandon_run`. Now `realm run abandon` and `realm run
// cleanup` record the program that ended the run (REALM_OPERATOR's value, or the OS user and host
// name) and the command, and every ending sentence and `realm run inspect` name them.
//
// The cells run the BUILT `realm` as a child process on a temp SQLite home, with a minimal
// environment (PATH, HOME, NO_COLOR, and REALM_OPERATOR or USER where a cell needs it; no LOGNAME,
// USERNAME or HOSTNAME). A derived name is computed here as `<OS user>@<host>`, and replaced by
// `<derived>` before any comparison, so a failure never prints the machine's names. Every
// assertion carries (a) the change that turns it red and (b) what it prints.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  abandonRun,
  type Attributed,
  type RunStore,
  type SealedBy,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';
import { inspectRun } from './inspect.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../../..');
const CLI = join(HERE, '../../dist/index.js');
const flat = (t: string): string => t.replace(/\s+/g, ' ');

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const READING = 'docs/reference/cli/realm-run-reading.md';
const ENVIRONMENT = 'docs/reference/environment-and-files.md';
const LISTEN = 'docs/reference/cli/realm-listen.md';

/** The name `realm` derives with no REALM_OPERATOR: the OS user and the host name. */
const DERIVED = `${userInfo().username.trim()}@${hostname().trim()}`;
const masked = (text: string): string => text.split(DERIVED).join('<derived>');

/** One agent step: a run that is open and not at a question, so abandon and cleanup take it. */
const ONE: WorkflowDefinition = {
  id: 'actor-cli',
  name: 'actor-cli',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
} as WorkflowDefinition;

const TOO_LONG = 'x'.repeat(201);
const WARNING_ABANDON =
  '⚠ REALM_OPERATOR: longer than 200 characters; this ending names no program. Unset it or give it a name of at most 200 characters with no control characters.';
const WARNING_CLEANUP =
  '⚠ REALM_OPERATOR: longer than 200 characters; the runs this cleanup marked abandoned name no program. Unset it or give it a name of at most 200 characters with no control characters.';

// Each cell runs the built `realm` several times: 120 s, not vitest's default 5 s.
describe(
  '#625 the actor unit — realm run abandon and cleanup record who ended the run',
  { timeout: 120_000 },
  () => {
    let h: TempHome & { readonly root: string };
    let runStore: RunStore;

    beforeEach(async () => {
      h = await makeTempHome();
      runStore = h.home.runStore;
      await h.home.workflowStore.register(ONE);
    });
    afterEach(async () => {
      await h.cleanup();
    });

    /** Runs the built `realm` with this HOME and a minimal environment. */
    function realm(
      args: string[],
      env: Record<string, string> = {},
      home: string = h.root,
    ): { code: number | null; out: string; err: string[] } {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        cwd: home,
        env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1', ...env },
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { code: r.status, out: r.stdout, err: r.stderr.split('\n').filter((l) => l !== '') };
    }
    const fresh = async (): Promise<string> =>
      (await runStore.create({ workflowId: ONE.id, workflowVersion: 1, params: {} })).record.id;
    const sealOf = async (id: string): Promise<SealedBy | undefined> =>
      (await runStore.get(id)).record.sealed_by;
    /** The two later reads that say how the run ended: `realm run respond`'s refusal and `advance`. */
    const laterReads = (id: string, env: Record<string, string> = {}) => {
      const respond = realm(['run', 'respond', id, '--gate', 'any', '--choice', 'approve'], env);
      const advance = realm(['run', 'advance', id], env);
      return {
        respond: masked(respond.err.join('\n')),
        advance: masked(advance.out + advance.err.join('\n')),
      };
    };
    const once = (text: string, part: string): number => text.split(part).length - 1;

    it('check 2 — realm run abandon with REALM_OPERATOR=tester: the record names it and the command; respond and advance say it', async () => {
      claim(
        'CHANGELOG.md',
        "- **A run's ending says who ended it.** `realm run abandon`, the assistant's `abandon_run` tool and `realm run cleanup` now record the program that ended the run: its name, how the name is known (from REALM_OPERATOR, from the OS user, or named by the program that runs Realm) and the command or tool. Every ending sentence and `realm run inspect` say it, for example \"It was abandoned with 'realm run abandon', by mihai@host (from the OS user), with the reason \"duplicate order\".\" `get_run_state` gains `sealed_by_actor` and `sealed_by_door`. Realm names a program, never a person. On the assistant's side and in piped output the name is masked as an OS user name is. `realm run abandon` and `realm run cleanup` now read REALM_OPERATOR; a value they cannot use gives a warning, not a stop. `SealedBy`, `SealRunDelta` and `abandonRun` gain optional members, and the store kit gains `SEAL_RUN_KEEPS_ACTOR`. Core exports `SEAL_DOORS` and `SealDoor`, the words for the command or tool. Old runs read as before. (#625)",
      );
      claim(
        ENVIRONMENT,
        '`realm run respond`, `realm run drain`, `realm run advance` (added after version 0.46.0), `realm run abandon`, `realm run cleanup` (added after version 0.50.0) |',
      );
      claim(
        ENVIRONMENT,
        '`realm run abandon` and `realm run cleanup` write it on each run they end, as the program that ended it.',
      );
      claim(
        ACTING,
        "**Who ended the run** (added after version 0.50.0). `realm run abandon` records on the run the program that ended it: its name, how the name is known, and the command. The name is `REALM_OPERATOR`'s value when it is set, and otherwise the OS user and host name, as on the steps `realm run advance` takes.",
      );
      const id = await fresh();
      const r = realm(['run', 'abandon', id, '--reason', 'duplicate order'], {
        REALM_OPERATOR: 'tester',
      });
      const seal = await sealOf(id);
      const said =
        'It was abandoned with \'realm run abandon\', by tester (from REALM_OPERATOR), with the reason "duplicate order".';
      const later = laterReads(id);
      // (a) red when the command passes no name, another source or channel, or no door; or a later
      //     read does not say it; (b) prints the exit, the seal and the counts.
      expect({
        code: r.code,
        warned: r.err.some((l) => l.startsWith('⚠')),
        seal,
        respond: once(later.respond, said),
        advance: once(later.advance, said),
      }).toEqual({
        code: 0,
        warned: false,
        seal: {
          arm: 'abandon_requested',
          by: { by: 'tester', by_source: 'ambient', channel: 'abandon' },
          door: 'realm_run_abandon',
        },
        respond: 1,
        advance: 1,
      });
    });

    it('check 2 — realm run abandon with no REALM_OPERATOR: the derived name, from the OS user; the default reason reads as none given', async () => {
      claim(
        ACTING,
        "Every sentence that says how the run ended then names them, such as `It was abandoned with 'realm run abandon', by ops@server-1 (from the OS user), with the reason \"upstream still down\".` (`It was abandoned with 'realm run abandon', by ops@server-1 (from the OS user); no reason was given.` with the default reason)",
      );
      const [given, none] = [await fresh(), await fresh()];
      const a = realm(['run', 'abandon', given, '--reason', 'duplicate order']);
      const b = realm(['run', 'abandon', none]);
      const seal = await sealOf(given);
      const [lg, ln] = [laterReads(given), laterReads(none)];
      const withReason =
        'It was abandoned with \'realm run abandon\', by <derived> (from the OS user), with the reason "duplicate order".';
      const noReason =
        "It was abandoned with 'realm run abandon', by <derived> (from the OS user); no reason was given.";
      // (a) red when the derived name is not recorded, is recorded as ambient, or the default reason
      //     is read as one a person gave; (b) prints the exits, the seal (names replaced) and counts.
      expect({
        codes: [a.code, b.code],
        seal: { ...seal, by: { ...seal?.by, by: masked(String(seal?.by?.by)) } },
        given: [once(lg.respond, withReason), once(lg.advance, withReason)],
        none: [once(ln.respond, noReason), once(ln.advance, noReason)],
      }).toEqual({
        codes: [0, 0],
        seal: {
          arm: 'abandon_requested',
          by: { by: '<derived>', by_source: 'derived', channel: 'abandon' },
          door: 'realm_run_abandon',
        },
        given: [1, 1],
        none: [1, 1],
      });
    });

    it('check 2 — realm run cleanup with REALM_OPERATOR=tester: each run it marks names it; advance says it', async () => {
      claim(
        ACTING,
        "`realm run cleanup` records the program that ran it on each run it abandons, with its name read as `realm run abandon` reads it (added after version 0.50.0). The sentence of how such a run ended then reads `'realm run cleanup', run by ops@server-1 (from the OS user), marked it abandoned.`",
      );
      const id = await fresh();
      const r = realm(['run', 'cleanup', '--older-than', '0m'], { REALM_OPERATOR: 'tester' });
      const { record } = await runStore.get(id);
      const advance = realm(['run', 'advance', id]);
      // (a) red when cleanup passes no name or door, or changes its reason; (b) prints them.
      expect({
        code: r.code,
        warned: r.err.some((l) => l.startsWith('⚠')),
        seal: record.sealed_by,
        reason: record.terminal_reason,
        advance: once(
          advance.out + advance.err.join('\n'),
          "'realm run cleanup', run by tester (from REALM_OPERATOR), marked it abandoned.",
        ),
      }).toEqual({
        code: 0,
        warned: false,
        seal: {
          arm: 'cleanup_sweep',
          by: { by: 'tester', by_source: 'ambient', channel: 'cleanup' },
          door: 'realm_run_cleanup',
        },
        reason: 'Marked abandoned by realm cleanup',
        advance: 1,
      });
    });

    it('check 3 — an unusable REALM_OPERATOR: abandon still works, records no name, and warns once after the write; a later read says today’s sentence', async () => {
      claim(ACTING, '```text\n' + WARNING_ABANDON + '\n```');
      claim(
        ACTING,
        'A `REALM_OPERATOR` it cannot use (longer than 200 characters, or with a control character) does not stop the command: no name is recorded, the run is abandoned, and then one line goes to stderr:',
      );
      claim(
        ENVIRONMENT,
        'A value that breaks that prints one line and stops the command before it starts; `realm run abandon` and `realm run cleanup` instead record no name, do the work, and print a warning after it.',
      );
      const id = await fresh();
      const r = realm(['run', 'abandon', id, '--reason', 'duplicate order'], {
        REALM_OPERATOR: TOO_LONG,
      });
      const seal = await sealOf(id);
      const later = laterReads(id);
      // (a) red when the command refuses (the old stop), records a name, warns before the write or
      //     twice, or the later sentence names a program; (b) prints the exit, stderr, seal, counts.
      expect({
        code: r.code,
        warnings: r.err.filter((l) => l.startsWith('⚠')),
        lastLine: r.err.at(-1),
        seal,
        respond: once(later.respond, 'It was abandoned, with the reason "duplicate order".'),
      }).toEqual({
        code: 0,
        warnings: [WARNING_ABANDON],
        lastLine: WARNING_ABANDON,
        seal: { arm: 'abandon_requested' },
        respond: 1,
      });
    });

    it('check 3 — no warning where nothing was ended: an already-abandoned run, a refused abandon, a dry run, an empty sweep', async () => {
      claim(ACTING, 'A refused abandon and a run that was already abandoned print no such line.');
      claim(ACTING, 'A dry run and a sweep that marks no run print no such line.');
      const bad = { REALM_OPERATOR: TOO_LONG };
      const done = await fresh();
      await abandonRun(runStore, done, 'x');
      const again = realm(['run', 'abandon', done], bad);
      const refused = realm(['run', 'abandon', 'no-such-run'], bad);
      const open = await fresh();
      const dry = realm(['run', 'cleanup', '--older-than', '0m', '--dry-run'], bad);
      const swept = realm(['run', 'cleanup', '--older-than', '0m'], bad);
      const empty = realm(['run', 'cleanup', '--older-than', '0m'], bad);
      const warned = (r: { err: string[] }) => r.err.filter((l) => l.startsWith('⚠'));
      // (a) red when a warning is printed without an ending, or the sweep that marked a run does not
      //     warn once; (b) prints the exits and the warnings.
      expect({
        again: [again.code, warned(again)],
        refused: [refused.code, warned(refused)],
        dry: [dry.code, warned(dry)],
        swept: [swept.code, warned(swept), (await sealOf(open))?.arm],
        empty: [empty.code, warned(empty)],
      }).toEqual({
        again: [0, []],
        refused: [1, []],
        dry: [0, []],
        swept: [0, [WARNING_CLEANUP], 'cleanup_sweep'],
        empty: [0, []],
      });
      claim(ACTING, '```text\n' + WARNING_CLEANUP + '\n```');
    });

    it('check 6 — realm run inspect: each door’s Ended by line after Sealed by, none with no program recorded', async () => {
      claim(
        READING,
        "| `Ended by` | When the run's record names the program that ended it: `realm run abandon`, the assistant's `abandon_run` tool or `realm run cleanup` knew its name | That program and the command or tool, such as `Ended by: realm run abandon, by ops@server-1 (from the OS user)`, `Ended by: the assistant's abandon_run tool, on the Realm server running as ops@server-1 (from the OS user)` or `Ended by: realm run cleanup, run by ops@server-1 (from REALM_OPERATOR)`; for a program that named no command or tool, `Ended by: ops@server-1 (from the OS user, via mcp-stdio)`.",
      );
      const by: Attributed = { by: 'ops@server-1', by_source: 'derived', channel: 'mcp-stdio' };
      const [cmd, tool, library, bare, swept] = [
        await fresh(),
        await fresh(),
        await fresh(),
        await fresh(),
        await fresh(),
      ];
      await abandonRun(runStore, cmd, 'x', {
        by: { ...by, channel: 'abandon' },
        door: 'realm_run_abandon',
      });
      await abandonRun(runStore, tool, 'x', { by, door: 'abandon_run' });
      await abandonRun(runStore, library, 'x', { by });
      await abandonRun(runStore, bare, 'x');
      const { record } = await runStore.get(swept);
      await runStore.settleStep(swept, {
        kind: 'seal_run',
        arm: 'cleanup_sweep',
        reason: 'Marked abandoned by realm cleanup',
        expected_version: record.version,
        release_claims: true,
        by: { by: 'ops@server-1', by_source: 'ambient', channel: 'cleanup' },
        door: 'realm_run_cleanup',
      });
      const linesOf = async (id: string): Promise<string[]> => {
        const out = (await inspectRun(id, runStore, h.home.workflowStore)).split('\n');
        const at = out.findIndex((l) => l.startsWith('Sealed by:'));
        return out.slice(at, at + 2);
      };
      // (a) red when a door's line is worded wrong, is not right after Sealed by, or a line is
      //     printed with no program recorded; (b) prints the two lines of each run.
      expect({
        cmd: await linesOf(cmd),
        tool: await linesOf(tool),
        library: await linesOf(library),
        swept: await linesOf(swept),
        bare: (await linesOf(bare))[1]?.startsWith('Ended by:'),
      }).toEqual({
        cmd: [
          'Sealed by: abandon_requested',
          'Ended by: realm run abandon, by ops@server-1 (from the OS user)',
        ],
        tool: [
          'Sealed by: abandon_requested',
          "Ended by: the assistant's abandon_run tool, on the Realm server running as ops@server-1 (from the OS user)",
        ],
        library: [
          'Sealed by: abandon_requested',
          'Ended by: ops@server-1 (from the OS user, via mcp-stdio)',
        ],
        swept: [
          'Sealed by: cleanup_sweep',
          'Ended by: realm run cleanup, run by ops@server-1 (from REALM_OPERATOR)',
        ],
        bare: false,
      });
    });

    it('check 6 — the name is plain text: piped, the OS user name in it is masked, as every OS user name is there', async () => {
      claim(
        ACTING,
        'The name is plain text: your terminal shows it whole, and in piped output the OS user name in it is masked, as every OS user name is there.',
      );
      const id = await fresh();
      await abandonRun(runStore, id, 'x', {
        by: { by: 'abcdefgh@box', by_source: 'derived', channel: 'abandon' },
        door: 'realm_run_abandon',
      });
      const piped = realm(['run', 'inspect', id], { USER: 'abcdefgh' });
      const line = piped.out.split('\n').find((l) => l.startsWith('Ended by:'));
      // (a) red when the line is written as a command span (the CLI then shows it whole, or not at
      //     all), or piped output stops masking the OS user; (b) prints the exit and the line.
      expect([piped.code, line]).toEqual([
        0,
        'Ended by: realm run abandon, by [REDACTED]@box (from the OS user)',
      ]);
    });

    it('check 8 — export and import: a run with a program and a door round-trips at bundle version 5', async () => {
      const id = await fresh();
      realm(['run', 'abandon', id, '--reason', 'duplicate order'], { REALM_OPERATOR: 'tester' });
      const outDir = mkdtempSync(join(tmpdir(), 'realm-actor-export-'));
      const other = await makeTempHome();
      try {
        const exported = realm([
          'run',
          'export',
          id,
          '--out',
          outDir,
          '--accept-partial-disclosure',
        ]);
        const file = join(outDir, readdirSync(outDir)[0]!);
        const bundle = JSON.parse(readFileSync(file, 'utf8')) as {
          realm_export_version: number;
          run: { sealed_by?: unknown };
        };
        const imported = realm(['run', 'import', file], {}, other.root);
        const back = (await other.home.runStore.get(id)).record.sealed_by;
        const expected = {
          arm: 'abandon_requested',
          by: { by: 'tester', by_source: 'ambient', channel: 'abandon' },
          door: 'realm_run_abandon',
        };
        // (a) red when the bundle version moves, the export drops a member, or the import does;
        //     (b) prints the exits, the version and both seals.
        expect({
          codes: [exported.code, imported.code],
          version: bundle.realm_export_version,
          inFile: bundle.run.sealed_by,
          back,
        }).toEqual({ codes: [0, 0], version: 5, inFile: expected, back: expected });
      } finally {
        await other.cleanup();
        rmSync(outDir, { recursive: true, force: true });
      }
    });

    it('realm agent --run-id on a run abandoned with a command or the tool: its refusal says who ended it', async () => {
      claim(
        LISTEN,
        '`It was abandoned, with the reason "<reason>".` (`It was abandoned with \'realm run abandon\', by <name> (<how>), with the reason "<reason>".` or `It was abandoned with the assistant\'s \'abandon_run\' tool, on the Realm server running as <name> (<how>), with the reason "<reason>".` when the record names the program that ended it, added after version 0.50.0)',
      );
      const [cmd, tool] = [await fresh(), await fresh()];
      await abandonRun(runStore, cmd, 'wrong run', {
        by: { by: 'tester', by_source: 'ambient', channel: 'abandon' },
        door: 'realm_run_abandon',
      });
      await abandonRun(runStore, tool, 'wrong run', {
        by: { by: 'srv@box', by_source: 'derived', channel: 'mcp-stdio' },
        door: 'abandon_run',
      });
      const agent = (id: string) =>
        realm(['agent', '--run-id', id, '--model', 'anthropic:fake-model-actor'], {
          ANTHROPIC_API_KEY: 'fake-key-actor',
        });
      const [a, b] = [agent(cmd), agent(tool)];
      // (a) red when the refusal drops the program's clause; (b) prints the exits and stderr.
      expect({ cmd: [a.code, a.err], tool: [b.code, b.err] }).toEqual({
        cmd: [
          1,
          [
            `Error: Run ${cmd} has already ended (abandoned). It was abandoned with 'realm run abandon', by tester (from REALM_OPERATOR), with the reason "wrong run".`,
          ],
        ],
        tool: [
          1,
          [
            `Error: Run ${tool} has already ended (abandoned). It was abandoned with the assistant's 'abandon_run' tool, on the Realm server running as srv@box (from the OS user), with the reason "wrong run".`,
          ],
        ],
      });
    });
  },
);
