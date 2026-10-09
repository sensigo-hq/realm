// race-workflow-run-625.test.ts — issue #625 PR-2a, the last prompt's F7 on `realm workflow run`
// (review G7-06, G1-R2): the step the command drives reads core's classifier. A step whose own settle
// another process refused (rows 3–6: it settled the step, took it over, removed the claim, or ended
// the run while the engine ran it after the typed answer) prints the line `realm run advance` prints,
// never `✗ error:`, and the command goes on with what is left. A step's prompt closes when another
// process opens a question, and says the step waits behind it (F7 (f)). The C179 cells
// (`run-prompt-625.test.ts`: another process took or ran the step before the engine's claim) are the
// preservation cells for rows 1–2 and stay unchanged.
//
// In-process through the real command, with `node:readline/promises` mocked (the #447 harness), and a
// project handler `h` that performs the other process's act while this command's engine runs it.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand, setInFlightWatchForTests } from './run.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WORKFLOW_PAGE = 'docs/reference/cli/realm-workflow.md';
const OTHER = { by: 'other-prog', by_source: 'stated', channel: 'test' } as const;
const OTHER_WORDS = 'other-prog (as stated, via test)';

/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  const text = readFileSync(join(ROOT, page), 'utf8').replace(/\s+/g, ' ');
  expect(text, `${page} no longer says: ${sentence}`).toContain(sentence.replace(/\s+/g, ' '));
}

type Race = (runId: string) => Promise<void>;
/** The other process's act, which the project handler `h` performs while this command runs it. */
const hook = globalThis as { __f7WorkflowRunRace?: Race | undefined };

/** `s` (auto, handler `h` — the race) then `u` (auto, after `s`). */
const RACE_YAML = (id: string) =>
  [
    `id: ${id}`,
    `name: ${id}`,
    'version: 1',
    'extensions: ./ext.mjs',
    'steps:',
    '  s:',
    '    description: Runs the race.',
    '    execution: auto',
    '    handler: h',
    '  u:',
    '    description: After s.',
    '    execution: auto',
    '    depends_on: [s]',
    '',
  ].join('\n');

/** The project handler: runs the hook once, then returns. */
const EXT = `export default {
  handlers: {
    h: {
      id: 'h',
      async execute(_inputs, ctx) {
        const race = globalThis.__f7WorkflowRunRace;
        globalThis.__f7WorkflowRunRace = undefined;
        if (race !== undefined) await race(ctx.run_id);
        return { data: { by: 'here' } };
      },
    },
  },
};
`;

describe('#625 PR-2a, F7 — realm workflow run reads core’s classifier', () => {
  let home: string;
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-f7-wfrun-home-'));
    dir = mkdtempSync(join(tmpdir(), 'realm-f7-wfrun-wf-'));
    mkdirSync(join(home, '.realm'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    hook.__f7WorkflowRunRace = undefined;
    if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else process.stdin.isTTY = savedTTY;
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    mocks.question.mockReset();
    vi.restoreAllMocks();
  });

  const logged = (): string[] => logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  const errored = (): string[] => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  const runId = (): string =>
    readdirSync(join(home, '.realm', 'runs'))
      .filter((f) => f.endsWith('.json'))[0]!
      .replace('.json', '');

  /** Runs `realm workflow run <file>`; returns the exit code (0 for a natural return). */
  async function run(yaml: string): Promise<number> {
    writeFileSync(join(dir, 'workflow.yaml'), yaml, 'utf8');
    writeFileSync(join(dir, 'ext.mjs'), EXT, 'utf8');
    try {
      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });
      return 0;
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
      return Number(exitSpy.mock.calls[0]?.[0]);
    }
  }

  it.each([
    [
      '3: takes it over (reclaim --force, then holds it)',
      'takeover',
      `  • Step 's' was taken by ${OTHER_WORDS} at <t>; this program's outcome for it was not recorded.\n`,
    ],
    [
      '4: runs it and the rest (reclaim --force, then advance)',
      'settle',
      `  • Step 's' was taken by ${OTHER_WORDS}, and completed; this program's outcome for it was not recorded.\n`,
    ],
    [
      '5: ends the run',
      'abandon',
      "  • Step 's': the run ended (abandoned) before this program's outcome for it was recorded.\n",
    ],
    [
      '6: removes its claim (reclaim --force), nobody runs it — asked for again',
      'reclaim',
      "  • Step 's': another process removed the claim this program held on it; this program's outcome for it was not recorded.\n",
    ],
  ] as const)(
    'row %s — realm run advance’s line in place of `✗ error:`, and the command goes on',
    async (_row, kase, line) => {
      claim(
        WORKFLOW_PAGE,
        "When another process settles the step, takes it over, removes its claim or ends the run while the engine runs it after your answer, the line is the one `realm run advance` prints — `• Step '<step>' was taken by <program>, and completed; this program's outcome for it was not recorded.`, for one — and the command goes on with what is left; never `✗ error:`.",
      );
      const core = await import('@sensigo/realm');
      let raced = false;
      hook.__f7WorkflowRunRace = async (id: string) => {
        raced = true;
        const def = core.loadWorkflowFromFile(join(dir, 'workflow.yaml'));
        const store = new core.JsonFileStore();
        if (kase === 'abandon') {
          await core.abandonRun(store, id, 'another program');
          return;
        }
        await core.reclaimStep(store, id, 's');
        if (kase === 'takeover') await store.claimStep(id, 's', def, OTHER);
        if (kase === 'settle') {
          const other = new core.ExtensionRegistry();
          other.register('handler', 'h', { id: 'h', execute: async () => ({ data: {} }) });
          await core.advanceRun(store, def, { runId: id, registry: other, driver: OTHER });
        }
      };
      mocks.question.mockImplementation(async () => '');
      const restore = setInFlightWatchForTests(300);
      let code: number;
      try {
        code = await run(RACE_YAML(`f7-wfrun-${kase}`));
      } finally {
        restore();
      }
      const out = logged().map((l) =>
        l
          .split(runId())
          .join('<run>')
          .replace(/ (at|since) \S+Z/g, ' $1 <t>'),
      );
      const at = out.indexOf('→ [auto] s: Runs the race.');
      // (a) red when the refused settle prints `✗ error: …` (the step did not fail), or the line is
      //     another kind's; (b) prints the line after the step and every `✗` line.
      expect({
        raced,
        line: out.slice(at + 1).find((l) => l.startsWith('  • Step')),
        failed: [...out, ...errored()].filter((l) => l.includes('✗')),
      }).toEqual({ raced: true, line, failed: [] });
      void code;
    },
    30_000,
  );

  it('row 1: another process holds the step when the engine claims it for the typed answer (STATE_STEP_ALREADY_CLAIMED) — C179’s not-run line, never `✗` (preservation)', async () => {
    const core = await import('@sensigo/realm');
    const yaml = [
      'id: f7-wfrun-claimed',
      'name: f7-wfrun-claimed',
      'version: 1',
      'steps:',
      '  s:',
      '    description: S.',
      '    execution: auto',
      '',
    ].join('\n');
    const realClaim = core.JsonFileStore.prototype.claimStep;
    let raced = false;
    const spy = vi
      .spyOn(core.JsonFileStore.prototype, 'claimStep')
      .mockImplementation(async function (this: InstanceType<typeof core.JsonFileStore>, ...a) {
        if (!raced && a[1] === 's') {
          raced = true;
          // another process claims `s` first, and holds it
          await realClaim.call(this, a[0], a[1], a[2], OTHER);
        }
        return realClaim.apply(this, a);
      });
    mocks.question.mockImplementation(async () => '');
    const restore = setInFlightWatchForTests(300);
    try {
      await run(yaml);
    } finally {
      restore();
      spy.mockRestore();
    }
    const out = logged().map((l) =>
      l
        .split(runId())
        .join('<run>')
        .replace(/ (at|since) \S+Z/g, ' $1 <t>'),
    );
    // (a) red when the claim's refusal prints `✗ blocked: …`, or the line names no program;
    //     (b) prints the not-run line and every `✗` line.
    expect({
      raced,
      line: out.find((l) => l.startsWith('  Not run here:')),
      failed: [...out, ...errored()].filter((l) => l.includes('✗')),
    }).toEqual({
      raced: true,
      line: `  Not run here: step 's' was taken by ${OTHER_WORDS}; the answer typed here was not recorded.\n`,
      failed: [],
    });
  }, 30_000);

  it('G1-R2 (F7 (f)): another process opens a question while a step’s prompt waits — the prompt says the step waits behind it, and asks for it again after the answer', async () => {
    claim(
      WORKFLOW_PAGE,
      "A step's prompt also closes when another process opens a question: `This prompt is closed: a question is open on '<question step>', and '<step>' waits for its answer.`, and the step is asked for again after the answer.",
    );
    const yaml = [
      'id: f7-wfrun-question',
      'name: f7-wfrun-question',
      'version: 1',
      'steps:',
      '  note:',
      '    description: Note.',
      '    execution: auto',
      '  ask:',
      '    description: Ask.',
      '    execution: auto',
      '    trust: human_confirmed',
      '    gate:',
      '      choices: [ok, no]',
      '',
    ].join('\n');
    const core = await import('@sensigo/realm');
    const def = core.loadWorkflowFromString(yaml);
    let notePrompts = 0;
    mocks.question.mockImplementation((prompt: string, opts?: { signal?: AbortSignal }) => {
      if (prompt.startsWith('  Mock output')) {
        notePrompts += 1;
        if (notePrompts > 1) return Promise.resolve('');
        return new Promise<string>((_resolve, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () =>
              reject(
                Object.assign(new Error('The operation was aborted'), {
                  name: 'AbortError',
                  code: 'ABORT_ERR',
                }),
              ),
            { once: true },
          );
          // another process opens `ask`'s question while `note`'s prompt waits
          void core.executeStep(new core.JsonFileStore(), def, {
            runId: runId(),
            command: 'ask',
            input: {},
            dispatcher: async () => ({}),
            driver: OTHER,
          });
        });
      }
      if (prompt.startsWith('  Choice ')) return Promise.resolve('ok');
      return Promise.reject(new Error(`fixture: an unexpected prompt: ${prompt}`));
    });
    const code = await run(yaml);
    const closed = logged().filter((l) => l.includes('This prompt is closed'));
    // (a) red when the prompt says the step "no longer waits for an answer — the run is
    //     'gate_waiting'" (G1-R2), or the step is not asked for again; (b) prints the close line,
    //     the prompts and the exit code.
    expect({ closed, notePrompts, code }).toEqual({
      closed: [
        "  This prompt is closed: a question is open on 'ask', and 'note' waits for its answer.\n",
      ],
      notePrompts: 2,
      code: 0,
    });
  }, 30_000);
});
