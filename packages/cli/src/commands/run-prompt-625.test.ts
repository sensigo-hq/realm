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

import { runCommand, setQuestionWatchIntervalForTests, setInFlightWatchForTests } from './run.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import { quotedForTerminal } from '../lib/holder-render.js';

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
  "A gate's prompt closes when its question is settled while it waits: by its time running out, when the gate declares an `on_expiry` (this process carries the expiry out and prints its own `⏰` line), or by another process — `realm run respond` from another terminal, `realm run advance`, `realm run drain --expired` or `realm listen`.";
/** C173: the wait for a step another process holds (realm-workflow.md). */
const IN_FLIGHT_WAIT =
  "While another process holds a step and nothing else is ready, it waits for that process, as `realm agent` does, and says so: `• Step '<step>' is in flight, taken by <program> since <time>: waiting up to 60s for the run's record to change.` When the record changes it runs what is ready; when the record has not changed for 60 seconds it prints `• Step '<step>' has been in flight since <time>, taken by <program>; the record has not changed for 60s. If the program that took it is gone: realm run reclaim <run> --step <step> --force` and hands the run back at that step, with the ways on that fit a step another program is still running: `realm run advance`, once the step is no longer in flight, runs what the engine then owes and names an agent step or a question that is ready.";
/** C167, C175, C176: the question on the gate's prompt (realm-workflow.md). */
const QUESTION_LINES =
  "The gate's prompt shows the question before its choices: the gate's `message`, or the step's `prompt` when the gate has no `message`, rendered as the reply that opened the gate renders it. Each of its lines is printed as written, with any other control character written as the escape `realm run inspect` writes in its `Message:` line (a tab as `\\t`, an escape character as `\\u001b`): `Question: Ship it?` for one line, and for more, `Question:` with each line indented below it.";
/** C176: (a) red when the human-gates guide no longer holds the sentence; (b) prints it. */
function claimGuidePage(sentence: string): void {
  const page = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/guides/human-gates.md'),
    'utf8',
  ).replace(/\s+/g, ' ');
  expect(page, `human-gates.md no longer says: ${sentence}`).toContain(sentence);
}
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
  /** decision C179: `finish` as an `auto` step (an agent step's prompt holds its claim). */
  finishAuto?: boolean;
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
      ? [
          '  finish:',
          '    description: Finish',
          `    execution: ${opts.finishAuto === true ? 'auto' : 'agent'}`,
          '    depends_on: [check]',
        ]
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
        // decision C178: the expiry recorded the winning choice, and the refusal says so.
        `  Gate '${gateId()}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
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

    it('C158, finding 10: with the watch neutralised, the attending timer’s own write closes the prompt — onApplied is the only closer', async () => {
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
            // Without a close, an answer comes 8 s later — the late-answer path, not a close. With the
            // watch neutralised, only `onApplied` can close the prompt before it: that is the proof. (A
            // bound on how soon is not asserted: under a loaded suite the timer's callback itself was
            // measured 1.5 s late.)
            const fallback = setTimeout(() => {
              fellBack = true;
              resolve('reject');
            }, 8_000);
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
      //     passing `onApplied`) — the prompt then waits for the answer that comes 8 s later; (b)
      //     prints when it closed.
      expect(fellBack).toBe(false);
      expect([closedAt === undefined, expiresAt === undefined]).toEqual([false, false]);
      // It closed after the question's time was up, and well before the fallback.
      expect(closedAt! - expiresAt!).toBeGreaterThanOrEqual(0);
      expect(closedAt! - expiresAt!).toBeLessThan(7_000);
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

  describe('round 21 — C165, C167: a step’s prompt closes when another process runs the step; the gate prompt shows the question', () => {
    it('C165, W1-Y2: another process runs the step while its prompt waits — the prompt closes and names who ran it; never ✓ for that work', async () => {
      claimWorkflowPage(
        "An `auto` step's prompt closes the same way when another process takes or runs that step while the prompt waits (`realm run advance`, `realm agent`, an `execute_step` call): it prints `This prompt is closed: step '<step>' was taken by <program>, and completed; not run here.`, or `… was taken by <program>; not run here.` while the other process still holds it, and goes on.",
      );
      let stepPrompts = 0;
      // decision C179: `finish` is an `auto` step here — an agent step's prompt holds its claim.
      let gateDone = false;
      mocks.question.mockImplementation((prompt: string, opts?: { signal?: AbortSignal }) => {
        if (prompt.startsWith('  Choice ')) {
          gateDone = true;
          return Promise.resolve('approve');
        }
        if (prompt.startsWith('  Mock output') && gateDone) {
          stepPrompts += 1;
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
            // Another process runs `finish` while this prompt waits.
            void (async () => {
              const { JsonFileStore, loadWorkflowFromString, executeStep } =
                await import('@sensigo/realm');
              const def = loadWorkflowFromString(
                workflowYaml({ id: 'prompt-625-c165', finish: true, finishAuto: true }),
              );
              await executeStep(new JsonFileStore(), def, {
                runId: runId(),
                command: 'finish',
                input: { done: true },
                dispatcher: async () => ({ done: true }),
                driver: { by: 'other-terminal', by_source: 'stated', channel: 'agent' },
              });
            })();
          });
        }
        if (prompt.startsWith('  Mock output')) return Promise.resolve('');
        return Promise.reject(new Error(`fixture: an unexpected prompt: ${prompt}`));
      });

      const code = await run(
        workflowYaml({ id: 'prompt-625-c165', finish: true, finishAuto: true }),
      );

      const out = logged();
      // (a) red when the step's prompt stays open (the cell then times out), or prints ✓ for the
      //     other process's work, or names no program; (b) prints stdout.
      expect(out.filter((l) => l.startsWith('  This prompt is closed: step'))).toEqual([
        "  This prompt is closed: step 'finish' was taken by other-terminal (as stated, via agent), and completed; not run here.\n",
      ]);
      expect(out.filter((l) => l.includes('✓ → completed'))).toEqual([]);
      expect([stepPrompts, (await readRecord()).run_phase, code]).toEqual([1, 'completed', 0]);
    }, 30_000);

    it('C165: an answer read after another process ended the run reaches no step — `Not run here:` and the engine’s words, never ✓', async () => {
      let stepPrompts = 0;
      let gateDone = false;
      mocks.question.mockImplementation(async (prompt: string) => {
        if (prompt.startsWith('  Choice ')) {
          gateDone = true;
          return 'approve';
        }
        if (prompt.startsWith('  Mock output') && gateDone) {
          stepPrompts += 1;
          // The other process runs `finish` (the run completes) before this answer is handed back —
          // inside the watch's half second, so the prompt never sees it close.
          const { JsonFileStore, loadWorkflowFromString, executeStep } =
            await import('@sensigo/realm');
          const def = loadWorkflowFromString(
            workflowYaml({ id: 'prompt-625-c165-late', finish: true, finishAuto: true }),
          );
          await executeStep(new JsonFileStore(), def, {
            runId: runId(),
            command: 'finish',
            input: { done: true },
            dispatcher: async () => ({ done: true }),
          });
          return '{"late": true}';
        }
        return '';
      });

      const code = await run(
        workflowYaml({ id: 'prompt-625-c165-late', finish: true, finishAuto: true }),
      );

      const out = logged();
      // (a) red when the ended run's refusal prints ✓ (with `hash: n/a`); (b) prints stdout.
      expect(out.filter((l) => l.startsWith('  Not run here: '))).toEqual([
        `  Not run here: Run '${runId()}' is already terminal (completed); no steps executed.\n`,
      ]);
      expect(out.filter((l) => l.includes('hash: n/a'))).toEqual([]);
      expect([stepPrompts, code]).toEqual([1, 0]);
    }, 30_000);

    it.each([
      [
        'another process holds the step',
        "  This prompt is closed: step 'finish' was taken by other-terminal (as stated, via agent); not run here.\n",
      ],
      [
        'another process ended the run',
        "  This prompt is closed: step 'finish' no longer waits for an answer — the run is 'abandoned'.\n",
      ],
    ] as const)(
      'C165 (the sweep’s members): %s while the step’s prompt waits — the prompt closes and says so',
      async (kase, line) => {
        claimWorkflowPage(
          "it prints `This prompt is closed: step '<step>' was taken by <program>, and completed; not run here.`, or `… was taken by <program>; not run here.` while the other process still holds it, and goes on.",
        );
        let gateDone = false;
        mocks.question.mockImplementation((prompt: string, opts?: { signal?: AbortSignal }) => {
          if (prompt.startsWith('  Choice ')) {
            gateDone = true;
            return Promise.resolve('approve');
          }
          if (prompt.startsWith('  Mock output') && gateDone) {
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
              void (async () => {
                const { JsonFileStore, loadWorkflowFromString, abandonRun } =
                  await import('@sensigo/realm');
                const store = new JsonFileStore();
                if (kase === 'another process holds the step') {
                  const def = loadWorkflowFromString(
                    workflowYaml({ id: 'prompt-625-c165-hold', finish: true, finishAuto: true }),
                  );
                  await store.claimStep(runId(), 'finish', def, {
                    by: 'other-terminal',
                    by_source: 'stated',
                    channel: 'agent',
                  });
                } else {
                  await abandonRun(store, runId());
                }
              })();
            });
          }
          return Promise.resolve('');
        });
        // decision C173: a held step is waited for; this holder never lets go, so the watch is cut
        // short (its own cell below shows the wait going on when the holder finishes).
        const restore = setInFlightWatchForTests(1_500);
        let code: number;
        try {
          code = await run(
            workflowYaml({
              id:
                kase === 'another process holds the step'
                  ? 'prompt-625-c165-hold'
                  : 'prompt-625-c165-end',
              finish: true,
              finishAuto: true,
            }),
          );
        } finally {
          restore();
        }
        // (a) red when the prompt stays open (the cell times out) or says another thing; (b) prints stdout.
        expect(logged().filter((l) => l.startsWith('  This prompt is closed: step'))).toEqual([
          line,
        ]);
        if (kase === 'another process holds the step') {
          // C173: (a) red when a step held for the whole watch is not named with its way out, or the
          //     run is not handed back; (b) prints stderr and the exit code.
          // C188: handed back at the held step, never "stalled".
          expect([
            errored().filter((l) => l.startsWith('• Step ')),
            errored().some((l) =>
              l.startsWith(`Stopped waiting — detached from run '${runId()}' at step 'finish'`),
            ),
            code,
          ]).toEqual([
            [
              expect.stringMatching(
                new RegExp(
                  `^• Step 'finish' has been in flight since .+, taken by other-terminal \\(as stated, via agent\\); the record has not changed for 2s\\. If the program that took it is gone: realm run reclaim ${runId()} --step finish --force$`,
                ),
              ),
            ],
            true,
            1,
          ]);
        }
      },
      30_000,
    );

    it('C167, W1-Y4 (C175): the gate prompt prints the question before its choices, a control character written as an escape', async () => {
      claimWorkflowPage(QUESTION_LINES);
      mocks.question.mockImplementation(async (prompt: string) => {
        if (prompt.startsWith('  Choice ')) return 'approve';
        return '';
      });
      const yaml = workflowYaml({ id: 'prompt-625-c167' }).replace(
        '      choices: [approve, reject]\n',
        '      choices: [approve, reject]\n      message: "Ship it?\\u001b[31m"\n',
      );
      await run(yaml);
      const out = logged();
      const at = out.findIndex((l) => l.startsWith('  ⏸  Gate: confirm'));
      // (a) red when the question is not shown, shown raw (the escape sequence reaching the
      //     terminal), or after the choices; (b) prints stdout.
      expect(out.slice(at + 1, at + 3)).toEqual([
        '  Question: Ship it?\\u001b[31m',
        '  Preview: {}',
      ]);
    }, 30_000);
  });
  describe('round 22 — C173, C175, C176: a step another process holds; the question from every source, line by line', () => {
    /** `finish` (agent) → `last` (agent): what "goes on" reaches after the held step. */
    const withLast = (id: string): string =>
      `${workflowYaml({ id, finish: true, finishAuto: true })}  last:\n    description: Last\n    execution: agent\n    depends_on: [finish]\n`;

    it.each([
      [
        'takes the step and holds it past the prompt’s re-read, then completes it',
        1_500,
        'was taken by ',
      ],
      [
        'takes the step and completes it before the prompt reads the record',
        0,
        ', and completed; not run here.',
      ],
    ] as const)(
      'C173, W1-1: another process %s — the prompt closes, waits for it, and goes on to what is ready; never "stalled"',
      async (_order, holdMs, closeWords) => {
        claimWorkflowPage(IN_FLIGHT_WAIT);
        let stepPrompts = 0;
        let gateDone = false;
        mocks.question.mockImplementation((prompt: string, opts?: { signal?: AbortSignal }) => {
          if (prompt.startsWith('  Choice ')) {
            gateDone = true;
            return Promise.resolve('approve');
          }
          // `finish` (auto, after the gate) waits; `last` (agent) is answered at once.
          if (prompt.startsWith('  Agent output')) {
            stepPrompts += 1;
            return Promise.resolve('');
          }
          if (prompt.startsWith('  Mock output') && gateDone) {
            stepPrompts += 1;
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
              // Another process runs `finish`; its work takes `holdMs`, during which it holds the
              // step (as `realm run advance` holds a step whose handler takes that long).
              void (async () => {
                const { JsonFileStore, loadWorkflowFromString, executeStep } =
                  await import('@sensigo/realm');
                const def = loadWorkflowFromString(withLast('prompt-625-c173'));
                await executeStep(new JsonFileStore(), def, {
                  runId: runId(),
                  command: 'finish',
                  input: {},
                  dispatcher: async () => {
                    await new Promise((resolve) => setTimeout(resolve, holdMs));
                    return { done: true };
                  },
                  driver: { by: 'other-terminal', by_source: 'stated', channel: 'agent' },
                });
              })();
            });
          }
          if (prompt.startsWith('  Mock output')) return Promise.resolve('');
          return Promise.reject(new Error(`fixture: an unexpected prompt: ${prompt}`));
        });

        const code = await run(withLast('prompt-625-c173'));
        // decision C182: while the other process holds the step, the prompt says what it waits for
        //     and who holds it — once. (a) red when the wait is silent, or said more than once;
        //     (b) prints stdout.
        if (holdMs > 0) {
          expect(
            logged()
              .filter((l) => l.includes(': waiting up to '))
              .map((l) => l.replace(/ since \S+Z:/, ' since <t>:')),
          ).toEqual([
            "  • Step 'finish' is in flight, taken by other-terminal (as stated, via agent) since <t>: waiting up to 60s for the run's record to change.",
          ]);
        }

        const out = logged();
        const closed = out.filter((l) => l.startsWith("  This prompt is closed: step 'finish'"));
        // (a) red when the prompt says the run stalled while the other process holds the step, or
        //     does not go on to `last` once it completed; (b) prints stdout, stderr and the exit.
        expect({
          closed: closed.length === 1 && closed[0]!.includes(closeWords),
          last: out.some((l) => l.startsWith('→ [agent] last: Last')),
          stalled: errored().filter((l) => l.includes('stalled')),
          code,
          stepPrompts,
        }).toEqual({ closed: true, last: true, stalled: [], code: 0, stepPrompts: 2 });
        expect((await readRecord()).run_phase).toBe('completed');
      },
      30_000,
    );

    it('C175, W2-3: a question of several lines prints each line as written, indented under `Question:`', async () => {
      claimWorkflowPage(QUESTION_LINES);
      mocks.question.mockImplementation(async (prompt: string) => {
        if (prompt.startsWith('  Choice ')) return 'approve';
        return '';
      });
      const yaml = workflowYaml({ id: 'prompt-625-c175' }).replace(
        '      choices: [approve, reject]\n',
        '      choices: [approve, reject]\n      message: "Subject: OFFICE CLOSED\\nThe office is closed.\\nSay \\"approve\\" to send it.\\n"\n',
      );
      await run(yaml);
      const out = logged();
      const at = out.findIndex((l) => l.startsWith('  ⏸  Gate: confirm'));
      // (a) red when the lines print as one escaped line (`\n`, `\"`), or the trailing line break
      //     prints an empty line; (b) prints stdout.
      expect(out.slice(at + 1, at + 6)).toEqual([
        '  Question:',
        '    Subject: OFFICE CLOSED',
        '    The office is closed.',
        '    Say "approve" to send it.',
        '  Preview: {}',
      ]);
    }, 30_000);

    it.each([
      [
        'the step’s `prompt` (the gate has no `message`)',
        '    prompt: "Approve order {{ context.resources.confirm.n }}?"\n',
        ['  Question: Approve order 7?'],
      ],
      ['neither (no `message`, no `prompt`)', '', []],
    ] as const)(
      'C176, W2-4: the question’s text from %s',
      async (_source, promptLine, question) => {
        claimWorkflowPage(QUESTION_LINES);
        claimGuidePage(
          '**At the `realm workflow run` prompt, the gate shows `Preview:` but no `Question:` line.** The gate has no `message` and its step has no `prompt`, so there is no question to show. Add a `message`. Up to version 0.46.0 the hand-run prompt showed no question for any gate.',
        );
        mocks.question.mockImplementation(async (prompt: string) => {
          if (prompt.startsWith('  Choice ')) return 'approve';
          if (prompt.startsWith('  Mock output')) return '{"n": 7}';
          return '';
        });
        const yaml = workflowYaml({ id: 'prompt-625-c176' }).replace(
          '    trust: human_confirmed\n',
          `    trust: human_confirmed\n${promptLine}`,
        );
        await run(yaml);
        const out = logged();
        const at = out.findIndex((l) => l.startsWith('  ⏸  Gate: confirm'));
        const preview = out.findIndex((l) => l.startsWith('  Preview:'));
        // (a) red when a prompt-sourced question is not shown, or a line is shown with neither
        //     source; (b) prints stdout.
        expect(out.slice(at + 1, preview)).toEqual([...question]);
      },
      30_000,
    );
  });

  describe('round 23 — C179, C183: an agent step’s prompt holds its claim; one escape for a control character', () => {
    const HOLDS =
      "While an agent step's prompt waits, the command holds the step's claim, so no other driver does the step's work: `realm run inspect` shows the step taken by this program (`via run`), `realm agent` waits for it and asks no model, and an `execute_step` call is refused with `Step '<step>' cannot be called now: it is in flight (claimed by another call).`";
    const LETS_GO =
      "The command lets the claim go when you answer (the engine then takes it for the answer), when you leave the prompt, and when it is ended by SIGHUP, SIGINT or SIGTERM (it then exits with 128 plus the signal's number);";
    const abortError = (): Error =>
      Object.assign(new Error('The operation was aborted'), {
        name: 'AbortError',
        code: 'ABORT_ERR',
      });
    /** `finish` (agent) → `last` (agent): a run that goes on after `finish`. */
    const withLast = (id: string): string =>
      `${workflowYaml({ id, finish: true })}  last:\n    description: Last\n    execution: agent\n    depends_on: [finish]\n`;
    const OTHER = { by: 'other-terminal', by_source: 'stated', channel: 'agent' } as const;

    it('C179, W1-1: the prompt holds the step’s claim while it waits (holder via run); another driver’s call is refused, does no work; the typed answer completes the step', async () => {
      claimWorkflowPage(HOLDS);
      claimWorkflowPage(LETS_GO);
      let atPrompt: unknown;
      let otherCall: unknown;
      let views: unknown;
      claimWorkflowPage(
        'Like any claim on an agent step, it has no time limit: `realm run list --stuck` lists the run (`<step>=claim_unknown_age`) while the prompt waits.',
      );
      mocks.question.mockImplementation(async (prompt: string) => {
        if (prompt.startsWith('  Choice ')) return 'approve';
        if (prompt.startsWith('  Agent output')) {
          const { JsonFileStore, loadWorkflowFromString, executeStep } =
            await import('@sensigo/realm');
          const record = await readRecord();
          atPrompt = {
            inProgress: record.in_progress_steps,
            channel: record.claims?.['finish']?.holder?.channel,
          };
          let ran = false;
          const r = await executeStep(
            new JsonFileStore(),
            loadWorkflowFromString(workflowYaml({ id: 'prompt-625-c179', finish: true })),
            {
              runId: runId(),
              command: 'finish',
              input: { by: 'other' },
              dispatcher: async () => {
                ran = true;
                return { by: 'other' };
              },
              driver: OTHER,
            },
          );
          otherCall = { status: r.status, hint: r.context_hint, ran };
          // What `realm run inspect` and `realm run list --stuck` show meanwhile (the built CLI).
          const { spawnSync } = await import('node:child_process');
          const cli = join(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
          const env = { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' };
          const show = (args: string[]) =>
            spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' }).stdout;
          views = {
            inspect: /^\s*finish: taken by .+, via run\), \d+m ago$/m.test(
              show(['run', 'inspect', runId()]),
            ),
            stuck: show(['run', 'list', '--stuck']).includes('finish=claim_unknown_age'),
          };
          return '{"by": "person"}';
        }
        return '';
      });
      const code = await run(workflowYaml({ id: 'prompt-625-c179', finish: true }));
      const record = await readRecord();
      const ev = record.evidence.find((e) => e.step_id === 'finish');
      // (a) red when the prompt holds no claim (the other call then runs the step: the walk's double
      //     answer), the claim names another program, or the answer is not recorded after the claim
      //     is let go; (b) prints what the record and the other call showed.
      expect({
        atPrompt,
        otherCall,
        views,
        afterwards: {
          phase: record.run_phase,
          answer: ev?.output_summary,
          by: ev?.driven_by?.channel,
          claims: record.claims?.['finish'],
        },
        code,
      }).toEqual({
        atPrompt: { inProgress: ['finish'], channel: 'run' },
        otherCall: {
          status: 'blocked',
          hint: "Step 'finish' cannot be called now: it is in flight (claimed by another call).",
          ran: false,
        },
        views: { inspect: true, stuck: true },
        afterwards: { phase: 'completed', answer: { by: 'person' }, by: 'run', claims: undefined },
        code: 0,
      });
    }, 30_000);

    it('C179: leaving the agent step’s prompt (Ctrl+D) lets the claim go — the detach map’s `Drive it` line finds the step ready', async () => {
      claimWorkflowPage(LETS_GO);
      mocks.question.mockImplementation(async (prompt: string) => {
        if (prompt.startsWith('  Choice ')) return 'approve';
        if (prompt.startsWith('  Agent output')) throw abortError();
        return '';
      });
      const code = await run(workflowYaml({ id: 'prompt-625-c179-cancel', finish: true }));
      const record = await readRecord();
      // (a) red when the cancel leaves the claim (the step then reads as in flight, and `realm agent`
      //     waits on a prompt that is gone); (b) prints the record's claim state and stderr.
      expect({
        inProgress: record.in_progress_steps,
        claim: record.claims?.['finish'],
        drive: errored().some((l) => l.includes('  Drive it:  realm agent --run-id')),
        code,
      }).toEqual({ inProgress: [], claim: undefined, drive: true, code: 1 });
    }, 30_000);

    it.each([
      ['SIGHUP', 129],
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const)(
      'C179: %s while the agent step’s prompt waits lets the claim go and exits %i (128 + the signal’s number)',
      async (signal, code) => {
        claimWorkflowPage(LETS_GO);
        // A listener of the cell's own, so that a signal no handler of the command takes is a red
        // cell, not a test process killed (a dependency's signal-exit handler re-raises a signal it
        // is the only listener of).
        const keep = (): void => {};
        process.on(signal, keep);
        const listenersBefore = process.listenerCount(signal);
        exitSpy.mockImplementation((() => undefined) as never);
        let afterSignal: unknown;
        mocks.question.mockImplementation(async (prompt: string) => {
          if (prompt.startsWith('  Choice ')) return 'approve';
          if (prompt.startsWith('  Agent output')) {
            const held = (await readRecord()).in_progress_steps;
            process.emit(signal, signal);
            const deadline = Date.now() + 5_000;
            while (exitSpy.mock.calls.length === 0 && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            const record = await readRecord();
            afterSignal = {
              held,
              inProgress: record.in_progress_steps,
              claim: record.claims?.['finish'],
              exits: exitSpy.mock.calls.map((c: unknown[]) => c[0]),
            };
            // End the command: exits throw again, and the prompt is left.
            exitSpy.mockImplementation(((): never => {
              throw new Error('process.exit');
            }) as never);
            throw abortError();
          }
          return '';
        });
        let listenersAfter: number;
        try {
          await run(workflowYaml({ id: `prompt-625-c179-${signal.toLowerCase()}`, finish: true }));
          listenersAfter = process.listenerCount(signal);
        } finally {
          process.removeListener(signal, keep);
        }
        // (a) red when the signal leaves the claim, or the exit code is another; (b) prints the state.
        expect(afterSignal).toEqual({
          held: ['finish'],
          inProgress: [],
          claim: undefined,
          exits: [code],
        });
        // The handlers are removed once the claim is let go: (a) red when a listener stays behind.
        expect(listenersAfter).toBe(listenersBefore);
      },
      30_000,
    );

    it('C201 (walk c11 YELLOW 5): Ctrl+C typed at the prompt is a key — the hand-back, exit 1; a SIGINT sent to the command prints nothing and exits 130', async () => {
      claimWorkflowPage(
        "Ctrl+C typed at a prompt is a key the prompt reads, so it leaves the prompt as above, with exit code 1. A signal sent to the command, SIGINT (`kill -INT <pid>`) or SIGTERM, is not read by the prompt: the command ends at once and prints nothing, none of the lines above. The run is kept; the `Run ID:` line the command printed when it started names it. A shell shows 128 plus the signal's number as the command's exit code (130 for SIGINT).",
      );
      claimWorkflowPage(
        "or if there was no terminal. A signal sent to the command gives 128 plus the signal's number, as above.",
      );
      // Ctrl+C at the prompt: readline rejects the question with ABORT_ERR (the pty transcript's
      // error, constructed as this file does).
      mocks.question.mockImplementation(async (prompt: string) => {
        if (prompt.startsWith('  Choice ')) return 'approve';
        if (prompt.startsWith('  Agent output')) throw abortError();
        return '';
      });
      const keyCode = await run(workflowYaml({ id: 'prompt-625-c201-key', finish: true }));
      const keyLines = [...logged(), ...errored()];
      // (a) red when Ctrl+C at the prompt no longer prints the hand-back or exits 1; (b) prints them.
      expect({
        code: keyCode,
        handBack: keyLines.some((l) => l.startsWith('Prompt cancelled — detached from run')),
        runId: keyLines.some((l) => l.startsWith('Run ID: ')),
      }).toEqual({ code: 1, handBack: true, runId: true });

      // A SIGINT sent to the command while the prompt waits.
      logSpy.mockClear();
      errSpy.mockClear();
      exitSpy.mockClear();
      const keep = (): void => {};
      process.on('SIGINT', keep);
      exitSpy.mockImplementation((() => undefined) as never);
      let afterSignal: unknown;
      mocks.question.mockImplementation(async (prompt: string) => {
        if (prompt.startsWith('  Choice ')) return 'approve';
        if (prompt.startsWith('  Agent output')) {
          const before = logged().length + errored().length;
          process.emit('SIGINT', 'SIGINT');
          const deadline = Date.now() + 5_000;
          while (exitSpy.mock.calls.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          afterSignal = {
            printed: [...logged(), ...errored()].slice(before),
            exits: exitSpy.mock.calls.map((c: unknown[]) => c[0]),
            phase: (await readRecord()).run_phase,
          };
          exitSpy.mockImplementation(((): never => {
            throw new Error('process.exit');
          }) as never);
          throw abortError();
        }
        return '';
      });
      try {
        await run(workflowYaml({ id: 'prompt-625-c201-signal', finish: true }));
      } finally {
        process.removeListener('SIGINT', keep);
      }
      // (a) red when the signal prints anything before the command exits, the exit code is not 130,
      //     or the run is not kept; (b) prints them.
      expect(afterSignal).toEqual({ printed: [], exits: [130], phase: 'running' });
    }, 30_000);

    it('C179: a claim the prompt left behind (the command killed outright) is released by `realm run reclaim --step --force`', async () => {
      claimWorkflowPage(
        'a command killed outright (SIGKILL) leaves it, and `realm run reclaim <run> --step <step> --force` releases it.',
      );
      // The record a killed prompt leaves: the agent step's claim, holder via `run`, no time limit.
      const { JsonFileStore, loadWorkflowFromString } = await import('@sensigo/realm');
      const def = loadWorkflowFromString(
        workflowYaml({ id: 'prompt-625-c179-killed', finish: true }),
      );
      const store = new JsonFileStore();
      const { run: created } = await store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await store.update({ ...created, completed_steps: ['confirm', 'check'] });
      await store.claimStep(created.id, 'finish', def, {
        by: 'person-at-t1',
        by_source: 'stated',
        channel: 'run',
      });
      const { spawnSync } = await import('node:child_process');
      const cli = join(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
      const env = { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' };
      const reclaim = spawnSync(
        process.execPath,
        [cli, 'run', 'reclaim', created.id, '--step', 'finish', '--force'],
        { env, encoding: 'utf8' },
      );
      const after = await store.get(created.id);
      // (a) red when the left claim cannot be released this way; (b) prints the command's output.
      expect(
        {
          code: reclaim.status,
          inProgress: after.in_progress_steps,
          claim: after.claims?.['finish'],
        },
        reclaim.stdout + reclaim.stderr,
      ).toEqual({ code: 0, inProgress: [], claim: undefined });
    }, 30_000);

    it('C179: another process removed the claim while the prompt waited — the prompt closes, says so, and asks again', async () => {
      claimWorkflowPage(
        "The agent step's prompt closes when another process removed its claim (`This prompt is closed: the claim it held on step '<step>' was removed by another process, and the step has not run.`; the step is asked for again if it is still ready) or the run ended.",
      );
      let stepPrompts = 0;
      mocks.question.mockImplementation((prompt: string, opts?: { signal?: AbortSignal }) => {
        if (prompt.startsWith('  Choice ')) return Promise.resolve('approve');
        if (prompt.startsWith('  Agent output')) {
          stepPrompts += 1;
          if (stepPrompts > 1) return Promise.resolve('{"second": true}');
          return new Promise<string>((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => reject(abortError()), { once: true });
            void (async () => {
              // `realm run reclaim --force`'s effect: the claim and the in-flight mark removed.
              const { JsonFileStore } = await import('@sensigo/realm');
              const store = new JsonFileStore();
              const record = await store.get(runId());
              const { finish: _gone, ...claims } = record.claims ?? {};
              await store.update({ ...record, in_progress_steps: [], claims });
            })();
          });
        }
        return Promise.resolve('');
      });
      const code = await run(workflowYaml({ id: 'prompt-625-c179-removed', finish: true }));
      // (a) red when the prompt stays open on a claim it no longer holds, or says another thing;
      //     (b) prints stdout.
      expect({
        closed: logged().filter((l) => l.startsWith('  This prompt is closed:')),
        stepPrompts,
        phase: (await readRecord()).run_phase,
        code,
      }).toEqual({
        closed: [
          "  This prompt is closed: the claim it held on step 'finish' was removed by another process, and the step has not run.\n",
        ],
        stepPrompts: 2,
        phase: 'completed',
        code: 0,
      });
    }, 30_000);

    it.each(['agent', 'auto'] as const)(
      'C179: another process runs the step between the typed answer and the engine’s claim (%s step) — `Not run here:`, the answer not recorded; never ✓, never `✗ blocked: `',
      async (kind) => {
        claimWorkflowPage(
          "When another process takes or runs the step between your answer and the engine's claim for it, the answer is not recorded: `Not run here: step '<step>' was taken by <program>, and completed; the answer typed here was not recorded.` (or `… was taken by <program>; …` while that process holds it)",
        );
        const yaml =
          kind === 'agent'
            ? withLast('prompt-625-c179-between')
            : `${workflowYaml({ id: 'prompt-625-c179-between', finish: true, finishAuto: true })}  last:\n    description: Last\n    execution: agent\n    depends_on: [finish]\n`;
        // The watch is neutralised: only the moment between the answer and the engine's claim is in play.
        const restore = setQuestionWatchIntervalForTests(60_000);
        let gateDone = false;
        let finishPrompts = 0;
        mocks.question.mockImplementation(async (prompt: string) => {
          if (prompt.startsWith('  Choice ')) {
            gateDone = true;
            return 'approve';
          }
          const isFinish =
            gateDone &&
            finishPrompts === 0 &&
            (kind === 'agent'
              ? prompt.startsWith('  Agent output')
              : prompt.startsWith('  Mock output'));
          if (!isFinish) return '';
          finishPrompts += 1;
          const { JsonFileStore, loadWorkflowFromString, executeStep } =
            await import('@sensigo/realm');
          const store = new JsonFileStore();
          if (kind === 'agent') {
            // The prompt's claim is removed first (as `realm run reclaim --force` would) …
            const record = await store.get(runId());
            const { finish: _gone, ...claims } = record.claims ?? {};
            await store.update({ ...record, in_progress_steps: [], claims });
          }
          // … then another process runs the step, before the typed answer reaches the engine.
          const r = await executeStep(store, loadWorkflowFromString(yaml), {
            runId: runId(),
            command: 'finish',
            input: { by: 'other' },
            dispatcher: async () => ({ by: 'other' }),
            driver: OTHER,
          });
          expect(r.status).toBe('ok');
          return '{"by": "person"}';
        });
        let code: number;
        try {
          code = await run(yaml);
        } finally {
          restore();
        }
        const out = logged();
        const at = out.findIndex((l) => l.startsWith('→ [') && l.includes('] finish: Finish'));
        // (a) red when the refused answer prints `✗ blocked: ` with no reason, or `✓`, or names no
        //     program; (b) prints stdout from `finish`'s line on.
        expect({ after: out.slice(at + 1, at + 3), code }).toEqual({
          after: [
            "  Not run here: step 'finish' was taken by other-terminal (as stated, via agent), and completed; the answer typed here was not recorded.\n",
            '→ [agent] last: Last',
          ],
          code: 0,
        });
        expect(errored().filter((l) => l.includes('✗ blocked'))).toEqual([]);
        const ev = (await readRecord()).evidence.find((e) => e.step_id === 'finish');
        expect(ev?.output_summary).toEqual({ by: 'other' });
      },
      30_000,
    );

    it('C179: another process takes the agent step between the loop’s read and the prompt’s claim — said as taken, no prompt; the loop waits for it', async () => {
      const { JsonFileStore } = await import('@sensigo/realm');
      const original = JsonFileStore.prototype.claimStep;
      let raced = false;
      // The other process's claim lands first, in the moment before this prompt's own claim.
      vi.spyOn(JsonFileStore.prototype, 'claimStep').mockImplementation(async function (
        this: InstanceType<typeof JsonFileStore>,
        ...args: Parameters<typeof original>
      ) {
        const [id, step, def, claimant] = args;
        if (!raced && step === 'finish' && claimant?.channel === 'run') {
          raced = true;
          await original.call(this, id, step, def, OTHER);
        }
        return original.apply(this, args);
      });
      let stepPrompts = 0;
      mocks.question.mockImplementation(async (prompt: string) => {
        if (prompt.startsWith('  Choice ')) return 'approve';
        if (prompt.startsWith('  Agent output')) stepPrompts += 1;
        return '';
      });
      const restore = setInFlightWatchForTests(1_500);
      let code: number;
      try {
        code = await run(workflowYaml({ id: 'prompt-625-c179-raced', finish: true }));
      } finally {
        restore();
      }
      const out = logged().map((l) => l.replace(/ (at|since) \S+Z/, ' $1 <t>'));
      // (a) red when the loop prompts for a step another process took, says nothing, or calls it
      //     stalled at once; (b) prints stdout, the prompts and the exit.
      expect({
        raced,
        stepPrompts,
        taken: out.filter((l) => l.startsWith("• Step 'finish' was taken")),
        waiting: out.filter((l) => l.includes(': waiting up to ')),
        code,
      }).toEqual({
        raced: true,
        stepPrompts: 0,
        taken: [
          "• Step 'finish' was taken by other-terminal (as stated, via agent) at <t>; not run here.\n",
        ],
        waiting: [
          "  • Step 'finish' is in flight, taken by other-terminal (as stated, via agent) since <t>: waiting up to 2s for the run's record to change.",
        ],
        code: 1,
      });
    }, 30_000);

    it('C183, W2-c: a tab in the question prints as `\\t` at the prompt — the escape `realm run inspect` writes in its `Message:` line', async () => {
      claimWorkflowPage(QUESTION_LINES);
      mocks.question.mockImplementation(async (prompt: string) => {
        if (prompt.startsWith('  Choice ')) return 'approve';
        return '';
      });
      const yaml = workflowYaml({ id: 'prompt-625-c183' }).replace(
        '      choices: [approve, reject]\n',
        '      choices: [approve, reject]\n      message: "tab\\there \\u001b[31mred\\u0007"\n',
      );
      await run(yaml);
      const out = logged();
      const at = out.findIndex((l) => l.startsWith('  ⏸  Gate: confirm'));
      // (a) red when the prompt and inspect write a control character two ways (`\u0009` and `\t`);
      //     (b) prints the prompt's line and inspect's quote of the same text.
      expect({
        prompt: out[at + 1],
        inspect: quotedForTerminal('tab\there \u001b[31mred\u0007'),
      }).toEqual({
        prompt: '  Question: tab\\there \\u001b[31mred\\u0007',
        inspect: '"tab\\there \\u001b[31mred\\u0007"',
      });
    }, 30_000);
  });

  describe('round 24 — C188: the hand-back after the watch on a step another process holds', () => {
    /** The walk's W4b: agent `a`, then `sleep` (auto) that another process holds; `extra` steps after. */
    const walkYaml = (id: string, extra: string[]): string[] => [
      `id: ${id}`,
      `name: ${id}`,
      'version: 1',
      'steps:',
      '  a:',
      '    description: Note a.',
      '    execution: agent',
      '  sleep:',
      '    description: Slow step.',
      '    execution: auto',
      ...extra,
      '',
    ];
    const autoAfter = (name: string, deps: string[]): string[] => [
      `  ${name}:`,
      `    description: ${name}.`,
      '    execution: auto',
      `    depends_on: [${deps.join(', ')}]`,
    ];
    /** The program `realm run advance` writes on the claim it holds (the page's screen names it). */
    const ADVANCE = { by: 'mihai@host', by_source: 'derived', channel: 'advance' } as const;
    const ADVANCE_WORDS = 'mihai@host (from the OS user, via advance)';
    const PAGE_RUN = '7d1f0c2e-5a8b-4c36-9e21-3b6f8d0a4c17';
    const PAGE_SINCE = '2026-10-08T12:34:50.336Z';

    /**
     * Another process (as `realm run advance` does) takes each of `steps` and holds it until
     * `release()`; `done` settles when it has run them all. Resolves once every claim is on the record.
     */
    async function holdElsewhere(
      yaml: string,
      steps: string[],
    ): Promise<{ release: () => void; done: Promise<void> }> {
      const { JsonFileStore, loadWorkflowFromString, executeStep } = await import('@sensigo/realm');
      const def = loadWorkflowFromString(yaml);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // One at a time, each claim on the record before the next is taken: the record lists them in
      // this order.
      const settled: Array<Promise<void>> = [];
      for (const step of steps) {
        settled.push(
          executeStep(new JsonFileStore(), def, {
            runId: runId(),
            command: step,
            input: {},
            dispatcher: async () => {
              await gate;
              return { slept: true };
            },
            driver: ADVANCE,
          }).then((r) => {
            expect(r.status, JSON.stringify(r)).toBe('ok');
          }),
        );
        const deadline = Date.now() + 10_000;
        while ((await readRecord()).claims?.[step] === undefined) {
          if (Date.now() > deadline)
            throw new Error(`fixture: the other process never took ${step}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      const done = Promise.all(settled).then(() => undefined);
      return { release, done };
    }

    /** `realm run advance <run>` from the built CLI, the workflow registered first (advance reads it). */
    async function advance(yaml: string): Promise<string[]> {
      const { JsonWorkflowStore, loadWorkflowFromString } = await import('@sensigo/realm');
      const store = new JsonWorkflowStore();
      const def = loadWorkflowFromString(yaml);
      if ((await store.list()).every((w) => w.id !== def.id)) await store.register(def);
      const { spawnSync } = await import('node:child_process');
      const cli = join(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
      const r = spawnSync(process.execPath, [cli, 'run', 'advance', runId()], {
        cwd: home,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: home,
          NO_COLOR: '1',
          REALM_OPERATOR: 'tester',
        },
        encoding: 'utf8',
      });
      return `${r.stdout}${r.stderr}`
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => l.split(runId()).join('<run>'));
    }

    /** The page's screen of the hand-back (realm-workflow.md), its values put in place. */
    function pageScreen(since: string, watchWords: string): string[] {
      const text = readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '../../../../docs/reference/cli/realm-workflow.md',
        ),
        'utf8',
      );
      const blocks = text.split(/^```[a-z]*\n/m).filter((_, i) => i % 2 === 1);
      const found = blocks.find((b) => b.includes('Stopped waiting — detached from run'));
      if (found === undefined) throw new Error('realm-workflow.md has no hand-back screen');
      return found
        .replace(/\n```[\s\S]*$/, '')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) =>
          l
            .split(PAGE_RUN)
            .join(runId())
            .split(PAGE_SINCE)
            .join(since)
            .split('mihai@host (from the OS user, via advance)')
            .join(ADVANCE_WORDS)
            .replace('changed for 60s', `changed for ${watchWords}`),
        );
    }

    /** Answers each prompt by its step; at `a`'s prompt another process takes `held` first. */
    function answerHolding(
      yaml: string,
      held: string[],
      onHeld?: (h: { release: () => void; done: Promise<void> }) => void,
    ): string[] {
      const asked: string[] = [];
      mocks.question.mockImplementation(async (prompt: string) => {
        asked.push(prompt);
        if (prompt.startsWith('  Agent output') && asked.length === 1) {
          onHeld?.(await holdElsewhere(yaml, held));
        }
        return '';
      });
      return asked;
    }

    const errLines = (): string[] =>
      errored()
        .flatMap((l) => l.split('\n'))
        .filter((l) => l !== '');

    it('C188, W4-R1 (the walk’s case): the watch ends unchanged — the in-flight line, then the run handed back at the held step: no "stalled", no map at the last prompted step, no `Drive it`; exit 1; `realm run advance` runs what is owed once the step is done', async () => {
      claimWorkflowPage(IN_FLIGHT_WAIT);
      claimWorkflowPage(
        '1 if it ended in any other way, if nothing else could run, if it stopped waiting for a step another program holds,',
      );
      const yaml = walkYaml('prompt-625-c188', autoAfter('done', ['a', 'sleep'])).join('\n');
      let holder: { release: () => void; done: Promise<void> } | undefined;
      const asked = answerHolding(yaml, ['sleep'], (h) => {
        holder = h;
      });
      const restore = setInFlightWatchForTests(1_500);
      let code: number;
      try {
        code = await run(yaml);
      } finally {
        restore();
      }
      const since = (await readRecord()).claims!['sleep']!.since!;
      // (a) red when the hand-back says the run stalled, names the last prompted step `a` (completed)
      //     rather than the held `sleep`, offers `Drive it` (no agent step is ready) or `Discard`, or
      //     differs from the page's screen; (b) prints stderr, the prompts and the exit.
      expect({
        asked: asked.map((p) => p.trim().split(' ')[0]),
        err: errLines(),
        code,
      }).toEqual({
        asked: ['Agent'],
        err: pageScreen(since, '2s'),
        code: 1,
      });
      expect(errored().filter((l) => /stalled|Drive it|Discard/.test(l))).toEqual([]);
      // The way on: while `sleep` is held, advance runs nothing and says why; once it is done,
      // advance runs what the engine then owes (`done`). (a) red when the hand-back's way on does not
      // do what the page says; (b) prints both runs' last lines.
      const whileHeld = await advance(yaml);
      holder!.release();
      await holder!.done;
      const after = await advance(yaml);
      expect({ whileHeld: whileHeld.at(-1), after: after.slice(-2) }).toEqual({
        whileHeld:
          "The engine can run nothing now: 'sleep' is in flight in another program — wait for it, or see realm run inspect <run>.",
        after: ['→ done', "Run <run>: phase 'completed'"],
      });
    }, 30_000);

    it.each([
      [
        'an agent step',
        ['  later:', '    description: Later.', '    execution: agent', '    depends_on: [sleep]'],
        [
          "Nothing is owed to the engine: an agent step is ready: 'later' — drive it with realm agent --run-id <run> --provider <provider> --model <model>.",
          'If a realm workflow run or realm agent is still waiting on this run, it goes on by itself; the line above is for when none is.',
        ],
      ],
      [
        'a question',
        [
          '  review:',
          '    description: Review.',
          '    execution: auto',
          '    trust: human_confirmed',
          '    depends_on: [sleep]',
          '    gate:',
          '      choices: [send, hold]',
        ],
        [
          '→ review',
          expect.stringMatching(
            /^Stopped: a question is open — realm run respond <run> --gate \S+ --choice <one of: send, hold>$/,
          ),
          "Run <run>: phase 'gate_waiting'",
        ],
      ],
    ] as const)(
      'C188: the hand-back’s way on, once the held step is done, names %s that is then ready',
      async (_kase, extra, tail) => {
        const yaml = walkYaml('prompt-625-c188-next', [...extra]).join('\n');
        let holder: { release: () => void; done: Promise<void> } | undefined;
        answerHolding(yaml, ['sleep'], (h) => {
          holder = h;
        });
        const restore = setInFlightWatchForTests(1_500);
        let code: number;
        try {
          code = await run(yaml);
        } finally {
          restore();
        }
        holder!.release();
        await holder!.done;
        const after = await advance(yaml);
        // (a) red when the run is not handed back at the held step, or advance after it does not
        //     name what is then ready; (b) prints the hand-back, the exit and advance's last lines.
        expect({
          handBack: errLines().filter((l) => l.startsWith('Stopped waiting')),
          code,
          tail: after.slice(-tail.length),
        }).toEqual({
          handBack: [
            `Stopped waiting — detached from run '${runId()}' at step 'sleep' (phase: running). The run is saved.`,
          ],
          code: 1,
          tail: [...tail],
        });
      },
      30_000,
    );

    it('C188: an agent step ready beside the held step is asked for at this prompt — the loop never reaches the hand-back with one, so the hand-back offers no `Drive it`', async () => {
      const yaml = walkYaml('prompt-625-c188-beside', [
        '  b:',
        '    description: Note b.',
        '    execution: agent',
        ...autoAfter('done', ['a', 'sleep', 'b']),
      ]).join('\n');
      let holder: { release: () => void; done: Promise<void> } | undefined;
      const asked = answerHolding(yaml, ['sleep'], (h) => {
        holder = h;
      });
      const restore = setInFlightWatchForTests(1_500);
      let code: number;
      try {
        code = await run(yaml);
      } finally {
        restore();
        holder?.release();
        await holder?.done;
      }
      const out = logged();
      const bAt = out.findIndex((l) => l.startsWith('→ [agent] b: Note b.'));
      const waitAt = out.findIndex((l) => l.includes(': waiting up to '));
      // (a) red when the ready agent step is not asked for before the wait, or the hand-back offers
      //     `Drive it`; (b) prints the prompts, where `b` and the wait are, stderr and the exit.
      expect({
        asked: asked.map((p) => p.trim().split(' ')[0]),
        bBeforeTheWait: bAt !== -1 && waitAt > bAt,
        drive: errored().filter((l) => l.includes('Drive it')),
        handBack: errLines().filter((l) => l.startsWith('Stopped waiting')).length,
        code,
      }).toEqual({
        asked: ['Agent', 'Agent'],
        bBeforeTheWait: true,
        drive: [],
        handBack: 1,
        code: 1,
      });
    }, 30_000);

    it('C188: the held step completes inside the watch — the record changes, the loop goes on (as before); no hand-back', async () => {
      const yaml = walkYaml('prompt-625-c188-changed', autoAfter('done', ['a', 'sleep'])).join(
        '\n',
      );
      answerHolding(yaml, ['sleep'], (h) => {
        setTimeout(h.release, 300);
      });
      const restore = setInFlightWatchForTests(5_000);
      let code: number;
      try {
        code = await run(yaml);
      } finally {
        restore();
      }
      // (a) red when a change inside the watch is handed back, or the loop does not go on to `done`;
      //     (b) prints stdout's step lines, stderr and the exit.
      expect({
        steps: logged().filter((l) => l.startsWith('→ ')),
        err: errLines(),
        code,
        phase: (await readRecord()).run_phase,
      }).toEqual({
        steps: ['→ [agent] a: Note a.', '→ [auto] done: done.'],
        err: [],
        code: 0,
        phase: 'completed',
      });
    }, 30_000);

    it('C188: a change that lands after the watch’s last read and before the hand-back — the last read sees it and the loop goes on; no hand-back', async () => {
      const yaml = walkYaml('prompt-625-c188-last-read', autoAfter('done', ['a', 'sleep'])).join(
        '\n',
      );
      let holder: { release: () => void; done: Promise<void> } | undefined;
      let armedAt: number | undefined;
      const asked: string[] = [];
      mocks.question.mockImplementation(async (prompt: string) => {
        asked.push(prompt);
        if (prompt.startsWith('  Agent output')) {
          holder = await holdElsewhere(yaml, ['sleep']);
          armedAt = Date.now();
        }
        return '';
      });
      const { JsonFileStore } = await import('@sensigo/realm');
      const original = JsonFileStore.prototype.get;
      let fired = false;
      // The first read 1.5 s (the watch) after the answer is the watch's last: it returns the record
      // it read, and the other process completes `sleep` before that read's caller sees it.
      vi.spyOn(JsonFileStore.prototype, 'get').mockImplementation(async function (
        this: InstanceType<typeof JsonFileStore>,
        ...args: Parameters<typeof original>
      ) {
        const r = await original.apply(this, args);
        if (!fired && armedAt !== undefined && Date.now() - armedAt >= 1_500) {
          fired = true;
          holder!.release();
          await holder!.done;
        }
        return r;
      });
      const restoreWatch = setInFlightWatchForTests(1_500);
      const restoreReads = setQuestionWatchIntervalForTests(1_000);
      let code: number;
      try {
        code = await run(yaml);
      } finally {
        restoreWatch();
        restoreReads();
      }
      // (a) red when the hand-back uses the watch's record without a last read (the run handed back
      //     though the step is done), or the change never landed after the watch; (b) prints all.
      expect({
        fired,
        steps: logged().filter((l) => l.startsWith('→ ')),
        handBack: errLines().filter((l) => l.startsWith('Stopped waiting')),
        code,
      }).toEqual({
        fired: true,
        steps: ['→ [agent] a: Note a.', '→ [auto] done: done.'],
        handBack: [],
        code: 0,
      });
    }, 30_000);

    it('C188: two held steps — both in-flight lines, then the run handed back at both, in the plural', async () => {
      const yaml = walkYaml('prompt-625-c188-two', [
        '  nap:',
        '    description: Another slow step.',
        '    execution: auto',
        ...autoAfter('done', ['a', 'sleep', 'nap']),
      ]).join('\n');
      let holder: { release: () => void; done: Promise<void> } | undefined;
      answerHolding(yaml, ['sleep', 'nap'], (h) => {
        holder = h;
      });
      const restore = setInFlightWatchForTests(1_500);
      let code: number;
      try {
        code = await run(yaml);
      } finally {
        restore();
        holder?.release();
        await holder?.done;
      }
      // (a) red when a held step is left out, or the plural is wrong; (b) prints stderr and the exit.
      expect({
        inFlight: errLines()
          .filter((l) => l.startsWith('• Step '))
          .map((l) => /^• Step '(\w+)' has been in flight/.exec(l)?.[1]),
        handBack: errLines().filter((l) => !l.startsWith('• Step ')),
        code,
      }).toEqual({
        inFlight: ['sleep', 'nap'],
        handBack: [
          `Stopped waiting — detached from run '${runId()}' at steps 'sleep', 'nap' (phase: running). The run is saved.`,
          `  Go on:     once 'sleep', 'nap' are no longer in flight, realm run advance ${runId()}`,
          `  Inspect:   realm run inspect ${runId()}`,
        ],
        code: 1,
      });
    }, 30_000);
  });
});
