// e1j-729.test.ts — issue #729 PR-0's E1 (j): a printed command ends its line — no stop, no mark after
// it — and a stored error text is printed after its label as written. Two lines converted by PR-0 had
// cells that could not fail for it (REVIEW-785 §… J03/J04/J07: green under their breaks, because they
// used `toContain`, or because the branch had no cell at all): the did-you-mean pointer
// (`index.ts`, `realm run <path>`) and the cancel path's line when the run's record cannot be re-read
// (`run.ts`, `realm workflow run`). Test-only (the architect's own branch, owner ruling 2026-09-30).
//
// Every cell carries (a) the change that turns it red and (b) what it prints on failure — ids and
// lines, never a value.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { JsonFileStore } from '@sensigo/realm';
import { runCommand } from './run.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_CLI = join(HERE, '..', '..', 'dist', 'index.js');

function runCli(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [DIST_CLI, ...args], { timeout: 15_000 }, (err, _stdout, stderr) => {
      const code = err !== null && typeof err.code === 'number' ? err.code : err !== null ? 1 : 0;
      resolve({ code, stderr });
    });
  });
}

const lineStarting = (text: string, prefix: string): string | undefined =>
  text.split('\n').find((l) => l.startsWith(prefix));

describe('#729 E1 (j) — the did-you-mean pointer ends its line with the command (index.ts)', () => {
  it('J03 a path-shaped token: the whole line is `Did you mean: realm workflow run <token>` — nothing after the command', async () => {
    const { code, stderr } = await runCli(['run', './my-workflow']);
    // (a) red when a stop, a mark or any word follows the command (the earlier `toContain` cell
    //     stayed green through that); (b) prints the exit code and the line.
    expect({ code, line: lineStarting(stderr, 'Did you mean') }).toEqual({
      code: 1,
      line: 'Did you mean: realm workflow run ./my-workflow',
    });
  }, 30_000);

  it('J07 a token a shell would split is quoted by the one quoter, and still ends the line', async () => {
    const { code, stderr } = await runCli(['run', './my workflow.yaml']);
    // (a) red when the token is printed bare (`shellWord` bypassed — a paste would run two words),
    //     or anything follows the closing quote; (b) prints the exit code and the line.
    expect({ code, line: lineStarting(stderr, 'Did you mean') }).toEqual({
      code: 1,
      line: "Did you mean: realm workflow run './my workflow.yaml'",
    });
  }, 30_000);
});

describe(
  '#729 E1 (j) — the cancel path when the record cannot be re-read (run.ts)',
  { timeout: 60_000 },
  () => {
    let home: string;
    let dir: string;
    let savedHome: string | undefined;
    let savedTTY: boolean | undefined;
    let errSpy: ReturnType<typeof vi.spyOn>;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      clearProjectExtensionsCache();
      home = mkdtempSync(join(tmpdir(), 'realm-729-e1j-home-'));
      dir = mkdtempSync(join(tmpdir(), 'realm-729-e1j-wf-'));
      mkdirSync(join(home, '.realm'), { recursive: true });
      savedHome = process.env['HOME'];
      process.env['HOME'] = home;
      // Without this the non-TTY guard refuses before the loop.
      savedTTY = process.stdin.isTTY;
      process.stdin.isTTY = true;
      vi.spyOn(console, 'log').mockImplementation(() => {});
      errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
        throw new Error('process.exit');
      }) as never);
    });

    afterEach(() => {
      if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
      else process.stdin.isTTY = savedTTY;
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
      mocks.question.mockReset();
      vi.restoreAllMocks();
    });

    const errored = (): string[] => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const runsDir = () => join(home, '.realm', 'runs');
    const runIds = (): string[] => {
      try {
        return readdirSync(runsDir())
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace('.json', ''));
      } catch {
        return [];
      }
    };
    const abortError = () =>
      Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      });

    /** Runs `realm workflow run <file>`; returns the exit code (0 for a natural return). */
    async function run(lines: string[]): Promise<number> {
      errSpy.mockClear();
      exitSpy.mockClear();
      mocks.question.mockClear();
      writeFileSync(join(dir, 'workflow.yaml'), [...lines, ''].join('\n'), 'utf8');
      try {
        await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });
        return 0;
      } catch (err) {
        if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
        return Number(exitSpy.mock.calls[0]?.[0]);
      }
    }

    const GATED = [
      'id: e1j-gate',
      'name: e1j-gate',
      'version: 1',
      'steps:',
      '  review:',
      '    description: Review.',
      '    execution: auto',
      '    trust: human_confirmed',
      '    gate:',
      '      choices: [ship, hold]',
    ];

    it('J04 the record purged while the gate’s prompt waits: the line ends with the inspect command, and the store’s own error text follows its label as written', async () => {
      let id: string | undefined;
      let storeMessage: string | undefined;
      mocks.question.mockImplementation(async (prompt: string) => {
        // The gated step runs on its mock output first; its gate then opens and asks for the choice.
        if (prompt.startsWith('  Mock output')) return '';
        if (!prompt.startsWith('  Choice ')) {
          throw new Error(`fixture: an unexpected prompt: ${prompt}`);
        }
        // Another terminal purged the run while this prompt sat open (the #291 race the fresh
        // read exists for): the record is gone before the cancel.
        id = runIds()[0];
        rmSync(join(runsDir(), `${id}.json`), { force: true });
        // The text the store itself gives for the vanished record — the line must carry it as is.
        storeMessage = await new JsonFileStore(runsDir())
          .get(id!)
          .then(() => 'fixture: the record was still readable')
          .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
        throw abortError();
      });
      const code = await run(GATED);
      const said = errored().find((l) => l.startsWith('Prompt cancelled'));
      const [first, second, ...rest] = (said ?? '').split('\n');
      // (a) red when a stop or a mark follows the inspect command, when the error text is reworded or
      //     closed by a stop the store did not write, when a third line appears, or when the branch is
      //     not reached (no `Prompt cancelled` line, or the detach map's instead); (b) prints the exit
      //     code and the lines, with the run id.
      expect({ code, first, second, rest }).toEqual({
        code: 1,
        first: `Prompt cancelled — detached from run '${id}'; its record could not be re-read. To read it: realm run inspect ${id}`,
        second: `  Error: ${storeMessage}`,
        rest: [],
      });
    });

    it('J04b the same, from an agent step’s prompt (the claim it held is let go first — a release the record no longer allows is swallowed, then the fresh read fails)', async () => {
      let id: string | undefined;
      let storeMessage: string | undefined;
      mocks.question.mockImplementation(async (prompt: string) => {
        if (!prompt.startsWith('  Agent output')) {
          throw new Error(`fixture: an unexpected prompt: ${prompt}`);
        }
        id = runIds()[0];
        rmSync(join(runsDir(), `${id}.json`), { force: true });
        storeMessage = await new JsonFileStore(runsDir())
          .get(id!)
          .then(() => 'fixture: the record was still readable')
          .catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
        throw abortError();
      });
      const code = await run([
        'id: e1j-agent',
        'name: e1j-agent',
        'version: 1',
        'steps:',
        '  note:',
        '    description: Note.',
        '    execution: agent',
      ]);
      const said = errored().find((l) => l.startsWith('Prompt cancelled'));
      const [first, second, ...rest] = (said ?? '').split('\n');
      // (a) red as J04, and when the held claim's release throws on the vanished record (the arm is
      //     then never reached: the stack this arm exists to remove); (b) prints the exit code and
      //     the lines, with the run id.
      expect({ code, first, second, rest }).toEqual({
        code: 1,
        first: `Prompt cancelled — detached from run '${id}'; its record could not be re-read. To read it: realm run inspect ${id}`,
        second: `  Error: ${storeMessage}`,
        rest: [],
      });
    });
  },
);
