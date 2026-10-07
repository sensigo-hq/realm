// run-prompt-625.test.ts — issue #625 (PR-1): what the terminal run mode (`realm workflow run`)
// prints after a gate answer whose own write settled a guard.
//
// The prompt says what the answer's write did BEFORE its state line: the guard that ended the
// run (its sentence, `Reason:`), or one passed line per guard. A late answer — this process's own
// timer enacted the gate's expiry while the prompt was open — never reads as recorded: its last
// line is `✗ not recorded — … → <phase>`, never `✓ →`. When the answer is handled after the time
// is up and before that timer runs (#625 PR-2a, decision C146), the answer carries the expiry out
// itself and its first line says so: `⚠ … this run call first carried out …`.
//
// In-process through the real command, with `node:readline/promises` mocked (the #447 harness):
// each prompt is answered by its own text, so a cell cannot answer the wrong question.
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

import { runCommand, setQuestionWatchIntervalForTests } from './run.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

/** C163: (a) red when gates.md no longer holds the sentence these cells pin, word for word; (b) prints it. */
const GATES_MD_215 = `an answer that came after the time was up and carried the expiry out prints it first too, before its refusal or the sentence that says it was not recorded — through \`realm run respond\` (\`this respond call …\`), the prompt of \`realm workflow run\` (\`this run call …\`) or a reply in the gate's Slack thread to \`realm agent\` (\`this agent call …\`, posted in the thread).`;
/** C158: (a) red when realm-workflow.md no longer holds the sentence, word for word; (b) prints it. */
function claimWorkflowPage(sentence: string): void {
  const page = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../docs/reference/cli/realm-workflow.md',
    ),
    'utf8',
  ).replace(/\s+/g, ' ');
  expect(page, `realm-workflow.md no longer says: ${sentence}`).toContain(sentence);
}
const PROMPT_CLOSES =
  "A gate's prompt closes when its question is settled while it waits: by its time running out, when the gate declares an `on_expiry` (this process carries the expiry out and prints its own `⏰` line), or by another process — `realm run respond` from another terminal, `realm run advance`, `realm run drain --expired` or `realm listen`. It then prints what the run's record holds, in the words of `realm run inspect`, and the run goes on:";
function claimGates215(): void {
  const page = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/reference/workflow/gates.md'),
    'utf8',
  ).replace(/\s+/g, ' ');
  expect(page, `gates.md no longer says: ${GATES_MD_215}`).toContain(GATES_MD_215);
}

const NOT_APPROVED = 'Not approved — stopping the run.';
const LATE_SAME_CHOICE =
  'the outcome matches your choice, but it was settled by timeout; your response was not recorded.';

/** gate `confirm` → guard `check` (aborts unless approved) [→ agent step `finish`]. */
function workflowYaml(opts: {
  id: string;
  finish?: boolean;
  expiresTo?: string;
  aborts?: boolean;
}): string {
  return [
    `id: ${opts.id}`,
    `name: ${opts.id}`,
    'version: 1',
    'steps:',
    '  confirm:',
    '    description: Confirm',
    '    execution: auto',
    '    trust: human_confirmed',
    '    depends_on: []',
    '    gate:',
    '      choices: [approve, reject]',
    ...(opts.expiresTo !== undefined
      ? [
          '      timeout_seconds: 1',
          '      on_expiry: settle_default',
          `      default_choice: ${opts.expiresTo}`,
        ]
      : []),
    ...(opts.aborts === true ? ['      timeout_seconds: 1', '      on_expiry: abort'] : []),
    '  check:',
    '    description: Check',
    '    execution: guard',
    '    depends_on: [confirm]',
    `    abort_unless: ["confirm.choice == 'approve'"]`,
    `    abort_message: "${NOT_APPROVED}"`,
    ...(opts.finish === true
      ? ['  finish:', '    description: Finish', '    execution: agent', '    depends_on: [check]']
      : []),
    '',
  ].join('\n');
}

describe('issue #625 — the terminal run prompt after a gate answer', () => {
  let home: string;
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-625-prompt-home-'));
    dir = mkdtempSync(join(tmpdir(), 'realm-625-prompt-wf-'));
    mkdirSync(join(home, '.realm'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    // Without this the non-TTY guard refuses before the loop.
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
  /** What the prompt printed on stdout after it showed the gate (its `Preview:` line). */
  const afterTheGate = (): string[] => {
    const lines = logged();
    const preview = lines.findIndex((l) => l.startsWith('  Preview:'));
    if (preview === -1) throw new Error(`the prompt never showed a gate:\n${lines.join('\n')}`);
    return lines.slice(preview + 1);
  };
  const runId = (): string =>
    readdirSync(join(home, '.realm', 'runs'))
      .filter((f) => f.endsWith('.json'))[0]!
      .replace('.json', '');
  const gateId = (): string => {
    const line = logged().find((l) => l.startsWith('  ⏸  Gate: confirm | gate_id: '));
    if (line === undefined) throw new Error('the prompt never printed the gate id');
    return line.replace('  ⏸  Gate: confirm | gate_id: ', '');
  };

  /** The stored record, read with a store constructed while the scratch HOME is live. */
  async function readRecord() {
    const { JsonFileStore } = await import('@sensigo/realm');
    return new JsonFileStore().get(runId());
  }

  /**
   * Answers each prompt by its own text. `choice` answers the gate; when `afterExpiry` is set
   * the gate's answer is held until this process's own timer has enacted the expiry.
   */
  function answerPrompts(
    choice: string,
    opts?: { afterExpiry?: boolean; pastDeadlineFirst?: boolean },
  ): void {
    mocks.question.mockImplementation(async (prompt: string) => {
      if (prompt.startsWith('  Choice ')) {
        if (opts?.pastDeadlineFirst === true) {
          // decision C146's race: the answer is handled after the question's time is up and
          // before this process's own timer runs — as when the event loop is busy as the deadline
          // passes and the typed line is read first. The loop is held (synchronously) past the
          // deadline; the answer's promise then settles, its `finally` cancels the timer, and the
          // answer carries out the expiry itself. The timer is the real one, not stubbed.
          const expiresAt = new Date((await readRecord()).pending_gate!.expires_at!).getTime();
          while (Date.now() <= expiresAt + 20) {
            // hold the event loop past the deadline
          }
        }
        if (opts?.afterExpiry === true) {
          const deadline = Date.now() + 15_000;
          for (;;) {
            if ((await readRecord()).settled?.['confirm'] !== undefined) break;
            if (Date.now() > deadline) throw new Error('fixture: the expiry timer never fired');
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        return choice;
      }
      if (prompt.startsWith('  Mock output') || prompt.startsWith('  Agent output')) return '';
      throw new Error(`fixture: an unexpected prompt: ${prompt}`);
    });
  }

  /** Runs `realm workflow run <file>`; returns the exit code (0 for a natural return). */
  async function run(yaml: string): Promise<number> {
    writeFileSync(join(dir, 'workflow.yaml'), yaml, 'utf8');
    try {
      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });
      return 0;
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
      return Number(exitSpy.mock.calls[0]?.[0]);
    }
  }

  it('the answer ENDED the run (the guard aborted): the ending and its Reason print before the state line', async () => {
    answerPrompts('reject');

    const code = await run(workflowYaml({ id: 'prompt-625-abort' }));

    // (a) red when the prompt prints only `✓ → aborted` for an answer whose guard ended the run,
    //     or drops the Reason line; (b) prints what the prompt printed after the gate.
    expect(afterTheGate()).toEqual([
      "  Guard step 'check' aborted the run.",
      `  Reason: ${NOT_APPROVED}`,
      '  ✓ → aborted\n',
      'Run complete. Phase: aborted',
    ]);
    // An aborted run exits 1 from the terminal run mode (unchanged).
    expect(code).toBe(1);
    expect(errored()).toEqual([]);
  }, 30_000);

  it('the answer ENDED the run (the guard passed and completed it): the completing sentence, no Reason line', async () => {
    answerPrompts('approve');

    const code = await run(workflowYaml({ id: 'prompt-625-complete' }));

    // (a) red when the run stalls after the answer ("No eligible steps" — the #625 dead end), or
    //     the completing sentence is missing; (b) prints what the prompt printed after the gate.
    expect(afterTheGate()).toEqual([
      "  Guard step 'check' passed and completed the run.",
      '  ✓ → completed\n',
      'Run complete. Phase: completed',
    ]);
    expect(code).toBe(0);
    expect(errored()).toEqual([]);
  }, 30_000);

  it('the guard PASSED and the run goes on: one passed line before the state line, and the next step is offered', async () => {
    answerPrompts('approve');

    const code = await run(workflowYaml({ id: 'prompt-625-pass', finish: true }));

    // (a) red when the passed guard is not named, or the prompt stalls instead of offering the
    //     step behind the guard; (b) prints what the prompt printed after the gate.
    expect(afterTheGate().slice(0, 3)).toEqual([
      "  Guard step 'check' passed.",
      '  ✓ → running\n',
      '→ [agent] finish: Finish',
    ]);
    expect(code).toBe(0);
    expect(errored()).toEqual([]);
  }, 30_000);

  describe("a late answer — this process's own timer enacted the expiry while the prompt was open", () => {
    it('SAME choice: the expiry sentence, then `✗ not recorded — … → running`; never `✓ →` for the answer', async () => {
      answerPrompts('approve', { afterExpiry: true });

      const code = await run(
        workflowYaml({ id: 'prompt-625-late-same', finish: true, expiresTo: 'approve' }),
      );

      // The timer's own line reports the guard its write settled; the answer's lines follow.
      // (a) red when the late answer prints `✓ → running` (it reads as recorded), or the expiry
      //     sentence is missing; (b) prints what the prompt printed after the gate.
      expect(afterTheGate().slice(0, 4)).toEqual([
        `⏰ gate '${gateId()}' on run '${runId()}' expired — enacted via the attending-process timer (enacted_via: timer). Guard step 'check' passed.`,
        `  ${LATE_SAME_CHOICE}`,
        "  ✗ not recorded — gate settled by timeout with choice 'approve' → running\n",
        '→ [agent] finish: Finish',
      ]);
      expect(code).toBe(0);
      expect(errored()).toEqual([]);
    }, 30_000);

    it('DIFFERENT choice: the refusal and `✗ not recorded — … → running` on stderr; the run goes on', async () => {
      answerPrompts('reject', { afterExpiry: true });

      const code = await run(
        workflowYaml({ id: 'prompt-625-late-diff', finish: true, expiresTo: 'approve' }),
      );

      // (a) red when the refused late answer prints only the bare refusal — the person who
      //     wanted the other choice is not told what the gate settled or where the run is;
      //     (b) prints stderr.
      expect(errored()).toEqual([
        `  Gate '${gateId()}' was already resolved with choice 'approve' — your choice 'reject' was not recorded.`,
        "  ✗ not recorded — gate settled by timeout with choice 'approve' → running\n",
      ]);
      // stdout: the timer's line, then straight on to the next step — no `✓ →` for the answer.
      // (a) red when a state line claiming success is printed for the refused answer;
      //     (b) prints what the prompt printed after the gate.
      expect(afterTheGate().slice(0, 2)).toEqual([
        `⏰ gate '${gateId()}' on run '${runId()}' expired — enacted via the attending-process timer (enacted_via: timer). Guard step 'check' passed.`,
        '→ [agent] finish: Finish',
      ]);
      expect(code).toBe(0);
    }, 30_000);
  });
  describe('C146 follow-up — the answer carries out the expiry before the attending timer fires', () => {
    /** The line this prompt's answer prints first: `run` names `realm workflow run`. */
    const runCarriedOut = (did: string): string =>
      `  ⚠ gate '${gateId()}' on 'confirm' had expired — this run call first carried out its declared ${did} (enacted_via: run).`;

    it('DIFFERENT choice: `⚠ … this run call first carried out …` once, then the refusal and `✗ not recorded`, on stderr', async () => {
      claimGates215();
      answerPrompts('reject', { pastDeadlineFirst: true });

      const code = await run(
        workflowYaml({ id: 'prompt-625-race-diff', finish: true, expiresTo: 'approve' }),
      );

      // (a) red when the composer drops the line, prints it twice, or names another call (the
      //     timer's `⏰` line would mean the race was not reached); (b) prints stderr.
      expect(errored().slice(0, 4)).toEqual([
        runCarriedOut("settle_default: the default choice 'approve' was recorded"),
        `  Gate '${gateId()}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
        "  Guard step 'check' passed.",
        "  ✗ not recorded — gate settled by timeout with choice 'approve' → running\n",
      ]);
      expect([...logged(), ...errored()].filter((l) => l.includes('had expired'))).toHaveLength(1);
      expect(logged().some((l) => l.startsWith('⏰'))).toBe(false);
      expect(code).toBe(0);
    }, 30_000);

    it('SAME choice: the line once, then the same-choice sentence and `✗ not recorded`, on stdout', async () => {
      claimGates215();
      answerPrompts('approve', { pastDeadlineFirst: true });

      const code = await run(
        workflowYaml({ id: 'prompt-625-race-same', finish: true, expiresTo: 'approve' }),
      );

      // (a) red when the same-choice arm drops the line or prints it twice; (b) prints stdout.
      expect(afterTheGate().slice(0, 4)).toEqual([
        runCarriedOut("settle_default: the default choice 'approve' was recorded"),
        `  ${LATE_SAME_CHOICE}`,
        "  Guard step 'check' passed.",
        "  ✗ not recorded — gate settled by timeout with choice 'approve' → running\n",
      ]);
      expect([...logged(), ...errored()].filter((l) => l.includes('had expired'))).toHaveLength(1);
      expect(code).toBe(0);
      expect(errored()).toEqual([]);
    }, 30_000);

    it('abort: the line once, then the refusal and `✗ not recorded → aborted`, on stderr', async () => {
      claimGates215();
      answerPrompts('approve', { pastDeadlineFirst: true });

      const code = await run(workflowYaml({ id: 'prompt-625-race-abort', aborts: true }));

      // (a) red when the abort arm prints only the bare refusal (no line, no state); (b) prints
      //     stderr.
      expect(errored().slice(0, 3)).toEqual([
        runCarriedOut('abort: the run ended'),
        `  Gate '${gateId()}' on 'confirm' expired and the run aborted per the workflow's declared on_expiry — your choice was NOT recorded.`,
        '  ✗ not recorded → aborted\n',
      ]);
      expect([...logged(), ...errored()].filter((l) => l.includes('had expired'))).toHaveLength(1);
      // `realm workflow run` exits 1 for a run that ended aborted (as realm-run-acting.md says).
      expect(code).toBe(1);
    }, 30_000);
  });

  describe('C158, W2-Y2 — the prompt closes when its question is settled by anything else, and says what settled it', () => {
    /**
     * The gate's prompt as readline answers it: it waits (nothing is typed) and, when the signal it
     * was handed aborts, rejects with readline's AbortError. `whileWaiting` runs once the prompt is
     * open (another process acting on the run). Every other prompt is answered empty.
     */
    function waitAtPrompt(whileWaiting?: () => Promise<void>): { choicePrompts: () => number } {
      let asked = 0;
      mocks.question.mockImplementation((prompt: string, opts?: { signal?: AbortSignal }) => {
        if (prompt.startsWith('  Choice ')) {
          asked += 1;
          return new Promise<string>((_resolve, reject) => {
            const signal = opts?.signal;
            if (signal === undefined) return; // no close: the cell's timeout says so
            signal.addEventListener(
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
            if (whileWaiting !== undefined) void whileWaiting();
          });
        }
        if (prompt.startsWith('  Mock output') || prompt.startsWith('  Agent output')) {
          return Promise.resolve('');
        }
        return Promise.reject(new Error(`fixture: an unexpected prompt: ${prompt}`));
      });
      return { choicePrompts: () => asked };
    }

    it('the attending timer settles the default while the prompt waits: the prompt closes, prints the answer the expiry recorded, and the run goes on — no `was not recorded`', async () => {
      claimWorkflowPage(PROMPT_CLOSES);
      const prompts = waitAtPrompt();

      const code = await run(
        workflowYaml({ id: 'prompt-625-c158-timer', finish: true, expiresTo: 'approve' }),
      );

      const after = afterTheGate();
      // (a) red when the prompt stays open after the timer's write (no close line, or a refused
      //     answer), or the line names another answer; (b) prints what the prompt printed.
      expect(after.filter((l) => l.startsWith('  This prompt is closed:'))).toEqual([
        "  This prompt is closed: the question on 'confirm' is no longer open — Answer: approve · settled by the gate's expiry (no answer in time).",
      ]);
      expect(after.findIndex((l) => l.startsWith('⏰ gate '))).toBeLessThan(
        after.findIndex((l) => l.startsWith('  This prompt is closed:')),
      );
      expect(
        [...after, ...errored()].filter(
          (l) => l.includes('was not recorded') || l.includes('not recorded —'),
        ),
      ).toEqual([]);
      expect(prompts.choicePrompts()).toBe(1);
      expect((await readRecord()).run_phase).toBe('completed');
      expect(code).toBe(0);
    }, 30_000);

    it('another process answers while the prompt waits: the prompt closes and prints that answer — never re-asks, never refuses', async () => {
      claimWorkflowPage(PROMPT_CLOSES);
      const prompts = waitAtPrompt(async () => {
        const { JsonFileStore, loadWorkflowFromString, submitHumanResponse } =
          await import('@sensigo/realm');
        const def = loadWorkflowFromString(
          workflowYaml({ id: 'prompt-625-c158-other', finish: true }),
        );
        const reply = await submitHumanResponse(new JsonFileStore(), def, {
          runId: runId(),
          gateId: gateId(),
          choice: 'approve',
          caller: 'respond',
        });
        if (reply.status !== 'ok')
          throw new Error(`fixture: the other answer was refused: ${reply.errors.join(', ')}`);
      });

      const code = await run(workflowYaml({ id: 'prompt-625-c158-other', finish: true }));

      const after = afterTheGate();
      // (a) red when the prompt does not watch the record (it would wait forever: the cell times
      //     out), or prints no close line; (b) prints what the prompt printed.
      const closed = after.filter((l) => l.startsWith('  This prompt is closed:'));
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatch(
        /^ {2}This prompt is closed: the question on 'confirm' is no longer open — Answer: approve · answered by .+\.$/,
      );
      expect([...after, ...errored()].filter((l) => l.includes('not recorded'))).toEqual([]);
      expect(prompts.choicePrompts()).toBe(1);
      expect((await readRecord()).run_phase).toBe('completed');
      expect(code).toBe(0);
    }, 30_000);

    it('C158, finding 10: with the watch neutralised, the attending timer’s own write closes the prompt at once — onApplied is the closer', async () => {
      claimWorkflowPage(PROMPT_CLOSES);
      // The watch reads the record once an hour here: only the timer's `onApplied` can close the prompt.
      const restoreWatch = setQuestionWatchIntervalForTests(3_600_000);
      let closedAt: number | undefined;
      let expiresAt: number | undefined;
      let fellBack = false;
      mocks.question.mockImplementation((prompt: string, opts?: { signal?: AbortSignal }) => {
        if (prompt.startsWith('  Choice ')) {
          void readRecord().then((r) => {
            expiresAt = new Date(r.pending_gate!.expires_at!).getTime();
          });
          return new Promise<string>((resolve, reject) => {
            // Without a close, an answer comes 4 s later — the late-answer path, not a close.
            const fallback = setTimeout(() => {
              fellBack = true;
              resolve('reject');
            }, 4_000);
            opts?.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(fallback);
                closedAt = Date.now();
                reject(
                  Object.assign(new Error('The operation was aborted'), {
                    name: 'AbortError',
                    code: 'ABORT_ERR',
                  }),
                );
              },
              { once: true },
            );
          });
        }
        if (prompt.startsWith('  Mock output') || prompt.startsWith('  Agent output')) {
          return Promise.resolve('');
        }
        return Promise.reject(new Error(`fixture: an unexpected prompt: ${prompt}`));
      });
      try {
        await run(
          workflowYaml({ id: 'prompt-625-c158-applied', finish: true, expiresTo: 'approve' }),
        );
      } finally {
        restoreWatch();
      }
      // (a) red when the timer does not tell the prompt it carried the expiry out (s8: `run.ts` stops
      //     passing `onApplied`) — the prompt then waits for the answer that comes 4 s later; (b)
      //     prints when it closed.
      expect(fellBack).toBe(false);
      expect([closedAt === undefined, expiresAt === undefined]).toEqual([false, false]);
      expect(closedAt! - expiresAt!).toBeLessThan(1_000);
      expect(afterTheGate().filter((l) => l.startsWith('  This prompt is closed:'))).toEqual([
        "  This prompt is closed: the question on 'confirm' is no longer open — Answer: approve · settled by the gate's expiry (no answer in time).",
      ]);
    }, 30_000);

    it('the attending timer carries out an abort while the prompt waits: the prompt closes and says no answer was recorded, the run aborted', async () => {
      claimWorkflowPage(PROMPT_CLOSES);
      claimWorkflowPage(
        "When no answer was recorded (an `on_expiry: abort`), the line ends `— no answer was recorded; the run is 'aborted'.`",
      );
      const prompts = waitAtPrompt();

      const code = await run(workflowYaml({ id: 'prompt-625-c158-abort', aborts: true }));

      const after = afterTheGate();
      // (a) red when the prompt stays open after the abort, or the line claims an answer; (b) prints
      //     what the prompt printed.
      expect(after.filter((l) => l.startsWith('  This prompt is closed:'))).toEqual([
        "  This prompt is closed: the question on 'confirm' is no longer open — no answer was recorded; the run is 'aborted'.",
      ]);
      expect(prompts.choicePrompts()).toBe(1);
      expect(code).toBe(1);
    }, 30_000);
  });
});
