// guard-cascade-625.test.ts — issue #625 (PR-1): what `realm run respond` and
// `realm run drain --expired` PRINT, and exit with, once the write that records an answer (or
// enacts an expiry) also settles the guards it makes eligible.
//
// In-process, through the real command (`respondCommand`) and the real drain action
// (`runDrainAction`), against real stores under a scratch HOME. Every cell that asserts a screen
// asserts the WHOLE screen — both streams — and the exit code. The child-process cells (real MCP
// stdio, kill rounds, two answering processes, `realm agent --run-id`) live in
// `guard-cascade-625-journeys.test.ts`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JsonFileStore,
  JsonWorkflowStore,
  ExtensionRegistry,
  executeStep,
  drainFinalizers,
  captureEvidence,
  DRAIN_LEASE_MAX,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type {
  CreateRunOptions,
  RunRecord,
  RunStore,
  StepDefinition,
  StepHandler,
  WorkflowDefinition,
} from '@sensigo/realm';
import { respondCommand, respondToGate } from './respond.js';
import { runDrainAction, type DrainRuntimeDeps } from './drain.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';

const DRAIN_DEPS: DrainRuntimeDeps = {
  drainFinalizers,
  captureEvidence,
  drainLeaseMax: DRAIN_LEASE_MAX,
};

const LATE_SAME_CHOICE =
  'the outcome matches your choice, but it was settled by timeout; your response was not recorded.';

type GateConfig = NonNullable<StepDefinition['gate']>;

/** gate `confirm` → guard `check` (aborts unless the answer is `approve`) [→ more steps]. */
function gateThenGuard(
  id: string,
  opts?: {
    gate?: Partial<GateConfig>;
    guard?: Partial<StepDefinition>;
    more?: Record<string, StepDefinition>;
  },
): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      confirm: {
        description: 'Confirm',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: { choices: ['approve', 'reject'], ...opts?.gate },
      },
      check: {
        description: 'Check',
        execution: 'guard',
        depends_on: ['confirm'],
        abort_unless: ["confirm.choice == 'approve'"],
        ...opts?.guard,
      },
      ...opts?.more,
    },
  };
}

const FINISH: Record<string, StepDefinition> = {
  finish: { description: 'Finish', execution: 'agent', depends_on: ['check'] },
};
const NOT_APPROVED = 'Not approved — stopping the run.';

/** A gate that settles `defaultChoice` when it expires. */
const expiring = (defaultChoice: string): Partial<GateConfig> => ({
  timeout_seconds: 3600,
  on_expiry: 'settle_default',
  default_choice: defaultChoice,
});

describe('issue #625 — what the answer ended, on `realm run respond` and `realm run drain --expired`', () => {
  let home: string;
  let project: string;
  let savedHome: string | undefined;
  let runStore: JsonFileStore;
  let workflowStore: JsonWorkflowStore;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearProjectExtensionsCache();
    home = mkdtempSync(join(tmpdir(), 'realm-625-home-'));
    project = mkdtempSync(join(tmpdir(), 'realm-625-project-'));
    mkdirSync(join(home, '.realm', 'workflows'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    // Constructed AFTER the scratch HOME is live — both resolve `homedir()` in their constructor.
    runStore = new JsonFileStore();
    workflowStore = new JsonWorkflowStore();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  /** Everything printed on stdout, one entry per `console.log` call. */
  const stdout = (): string[] => logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
  /** Everything printed on stderr, split into lines. */
  const stderr = (): string[] =>
    errSpy.mock.calls.flatMap((c: unknown[]) => String(c[0]).split('\n'));

  /** Registers the workflow, creates a run and opens the gate on `confirm`. */
  async function openGate(def: WorkflowDefinition): Promise<{ runId: string; gateId: string }> {
    await workflowStore.register(def);
    const { run } = await runStore.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(runStore, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') {
      throw new Error(`fixture: the gate did not open (status ${opened.status})`);
    }
    return { runId: run.id, gateId: opened.gate!.gate_id };
  }

  /**
   * Moves the open gate's frozen expiry into the past, so the commands' own clock (`new Date()`)
   * sees it expired without the test waiting an hour. Everything else on the gate is what the
   * engine minted.
   */
  async function expireGate(runId: string): Promise<RunRecord> {
    const run = await runStore.get(runId);
    return runStore.update({
      ...run,
      pending_gate: {
        ...run.pending_gate!,
        opened_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-01T01:00:00.000Z',
      },
    });
  }

  /** Runs `realm run respond <run> --gate <gate> --choice <choice>`; returns the exit code. */
  async function respond(runId: string, gateId: string, choice: string): Promise<number> {
    try {
      await respondCommand.parseAsync(
        [runId, '--gate', gateId, '--choice', choice, '--project', project],
        { from: 'user' },
      );
      return 0;
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
      return Number(exitSpy.mock.calls[0]?.[0]);
    }
  }

  // -------------------------------------------------------------------------
  // respond — an answer that was recorded
  // -------------------------------------------------------------------------

  it('respond, the guard ABORTS: the ending and its Reason are printed before `Responded:`, exit 0', async () => {
    const def = gateThenGuard('r625-abort', { guard: { abort_message: NOT_APPROVED } });
    const { runId, gateId } = await openGate(def);

    const code = await respond(runId, gateId, 'reject');

    // (a) red when respond prints only `Responded:` for an answer that ended the run, drops the
    //     Reason line, or reorders the lines; (b) prints the whole stdout.
    expect(stdout()).toEqual([
      "Guard step 'check' aborted the run.",
      `Reason: ${NOT_APPROVED}`,
      `Responded: ${runId} | choice 'reject' | new state 'aborted'`,
    ]);
    // An applied answer exits 0 even though the run it ended is aborted.
    // (a) red when the exit code follows the run's phase instead of the reply's status;
    //     (b) prints the code and stderr.
    expect(code).toBe(0);
    expect(stderr()).toEqual([]);
  });

  it('respond, the guard PASSES and the run goes on: one passed line before `Responded:`, exit 0', async () => {
    const def = gateThenGuard('r625-pass', { more: FINISH });
    const { runId, gateId } = await openGate(def);

    const code = await respond(runId, gateId, 'approve');

    // (a) red when the passed guard is not named, or is named after `Responded:`;
    //     (b) prints the whole stdout.
    expect(stdout()).toEqual([
      "Guard step 'check' passed.",
      `Responded: ${runId} | choice 'approve' | new state 'running'`,
    ]);
    expect(code).toBe(0);
    expect(stderr()).toEqual([]);
  });

  it('respond, the guard PASSES and completes the run: the completing sentence, no Reason line', async () => {
    const def = gateThenGuard('r625-complete');
    const { runId, gateId } = await openGate(def);

    const code = await respond(runId, gateId, 'approve');

    // (a) red when a Reason line is invented for a completing pass, or the sentence is reworded;
    //     (b) prints the whole stdout.
    expect(stdout()).toEqual([
      "Guard step 'check' passed and completed the run.",
      `Responded: ${runId} | choice 'approve' | new state 'completed'`,
    ]);
    expect(code).toBe(0);
  });

  it('respondToGate: the lines carry each finalizer outcome after the ending, by rank', async () => {
    const def = gateThenGuard('r625-finalizer', {
      guard: { abort_message: NOT_APPROVED },
      more: {
        notify: {
          description: 'Notify',
          execution: 'finalizer',
          on_outcome: 'abort',
          handler: 'notify-handler',
        },
      },
    });
    const handler: StepHandler = { id: 'notify-handler', execute: async () => ({ data: {} }) };
    const registry = new ExtensionRegistry();
    registry.register('handler', 'notify-handler', handler);
    const { runId, gateId } = await openGate(def);

    const outcome = await respondToGate(
      runId,
      { gate: gateId, choice: 'reject' },
      runStore,
      workflowStore,
      registry,
    );

    // (a) red when the finalizer's outcome is not printed (its failure would then read as
    //     success), or is printed before the ending; (b) prints the lines.
    expect(outcome.lines).toEqual([
      "Guard step 'check' aborted the run.",
      `Reason: ${NOT_APPROVED}`,
      "finalizer 'notify': completed",
    ]);
    expect(outcome.recorded).toBe(true);
    expect(outcome.lastLine).toBe(`Responded: ${runId} | choice 'reject' | new state 'aborted'`);
  });

  // -------------------------------------------------------------------------
  // respond — a late answer on an expired gate never reads as recorded
  // -------------------------------------------------------------------------

  describe('a late answer on an expired gate', () => {
    it('SAME choice × the guard ends the run: expiry sentence, ending, Reason, `Not recorded:` — stdout, exit 0, never `Responded:`', async () => {
      const def = gateThenGuard('r625-late-same-abort', {
        gate: expiring('reject'),
        guard: { abort_message: NOT_APPROVED },
      });
      const { runId, gateId } = await openGate(def);
      await expireGate(runId);

      const code = await respond(runId, gateId, 'reject');

      // (a) red when respond prints `Responded:` for an answer the expiry beat, joins the expiry
      //     sentence and the guard's on one line, or drops any of the four; (b) prints stdout.
      expect(stdout()).toEqual([
        LATE_SAME_CHOICE,
        "Guard step 'check' aborted the run.",
        `Reason: ${NOT_APPROVED}`,
        `Not recorded: ${runId} | gate settled by timeout with choice 'reject' | state 'aborted'`,
      ]);
      // The exit code follows the reply's status: the call succeeded.
      // (a) red when a late same-choice answer exits non-zero; (b) prints the code and stderr.
      expect(code).toBe(0);
      expect(stderr()).toEqual([]);
    });

    it('SAME choice × the guard passes: expiry sentence, passed line, `Not recorded:` with the running state — stdout, exit 0', async () => {
      const def = gateThenGuard('r625-late-same-pass', { gate: expiring('approve'), more: FINISH });
      const { runId, gateId } = await openGate(def);
      await expireGate(runId);

      const code = await respond(runId, gateId, 'approve');

      // (a) red when the expiry sentence is printed only when a guard ended the run, or
      //     `Responded:` is printed; (b) prints stdout.
      expect(stdout()).toEqual([
        LATE_SAME_CHOICE,
        "Guard step 'check' passed.",
        `Not recorded: ${runId} | gate settled by timeout with choice 'approve' | state 'running'`,
      ]);
      expect(code).toBe(0);
      expect(stderr()).toEqual([]);
    });

    it('DIFFERENT choice × the guard ends the run: refusal, ending, Reason, `Not recorded:` — all on stderr, exit 1', async () => {
      const def = gateThenGuard('r625-late-diff-abort', {
        gate: expiring('reject'),
        guard: { abort_message: NOT_APPROVED },
      });
      const { runId, gateId } = await openGate(def);
      await expireGate(runId);

      const code = await respond(runId, gateId, 'approve');

      // (a) red when the refused late answer does not say the run ended, drops `guards` from the
      //     refused reply, or omits the state line; (b) prints stderr.
      expect(stderr()).toEqual([
        `Gate '${gateId}' was settled by timeout with choice 'reject' — your choice 'approve' was not recorded.`,
        "Guard step 'check' aborted the run.",
        `Reason: ${NOT_APPROVED}`,
        `Not recorded: ${runId} | gate settled by timeout with choice 'reject' | state 'aborted'`,
      ]);
      // (a) red when a refused answer exits 0, or part of it goes to stdout; (b) prints both.
      expect(code).toBe(1);
      expect(stdout()).toEqual([]);
    });

    it('DIFFERENT choice × the guard passes: refusal, passed line, `Not recorded:` with the running state — stderr, exit 1', async () => {
      const def = gateThenGuard('r625-late-diff-pass', { gate: expiring('approve'), more: FINISH });
      const { runId, gateId } = await openGate(def);
      await expireGate(runId);

      const code = await respond(runId, gateId, 'reject');

      // (a) red when the refused expiry reply drops `guards` — a person who wanted the other
      //     choice would not learn the guard passed and the run goes on; (b) prints stderr.
      expect(stderr()).toEqual([
        `Gate '${gateId}' was settled by timeout with choice 'approve' — your choice 'reject' was not recorded.`,
        "Guard step 'check' passed.",
        `Not recorded: ${runId} | gate settled by timeout with choice 'approve' | state 'running'`,
      ]);
      expect(code).toBe(1);
      expect(stdout()).toEqual([]);
    });

    it('after `drain --expired --force` enacted the expiry: the same-choice answer prints the expiry sentence and `Not recorded:` — never `Responded:`', async () => {
      const def = gateThenGuard('r625-late-after-drain', {
        gate: expiring('approve'),
        more: FINISH,
      });
      const { runId, gateId } = await openGate(def);
      await expireGate(runId);
      await runDrainAction(
        runId,
        { expired: true, force: true },
        runStore,
        workflowStore,
        DRAIN_DEPS,
      );
      logSpy.mockClear();

      const code = await respond(runId, gateId, 'approve');

      // The drain's own write reported the guard; this answer's reply carries none.
      // (a) red when the already-resolved reply for a gate its expiry settled is not marked —
      //     respond would print `Responded:`; (b) prints stdout.
      expect(stdout()).toEqual([
        LATE_SAME_CHOICE,
        `Not recorded: ${runId} | gate settled by timeout with choice 'approve' | state 'running'`,
      ]);
      expect(code).toBe(0);
      expect(stderr()).toEqual([]);
    });

    it('an expiry that ABORTS the run settled no choice: the refusal as before, exit 1, no `Not recorded:` line', async () => {
      const def = gateThenGuard('r625-late-abort-disposition', {
        gate: { timeout_seconds: 3600, on_expiry: 'abort' },
      });
      const { runId, gateId } = await openGate(def);
      await expireGate(runId);

      const code = await respond(runId, gateId, 'approve');

      // (a) red when a `Not recorded:` line with an invented choice is printed for a gate whose
      //     expiry settled none; (b) prints stderr.
      expect(stderr()).toEqual([
        `Gate '${gateId}' on 'confirm' expired and the run aborted per the workflow's declared on_expiry — your choice was NOT recorded.`,
      ]);
      expect(code).toBe(1);
      expect(stdout()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // drain --expired
  // -------------------------------------------------------------------------

  describe('realm run drain --expired', () => {
    /** A store that does NOT declare `settleStep` — the legacy shape. */
    class NoSettleStepStore implements RunStore {
      readonly persistsClaims: boolean;
      constructor(private readonly inner: JsonFileStore) {
        this.persistsClaims = inner.persistsClaims;
      }
      create(options: CreateRunOptions): Promise<{ run: RunRecord; created: boolean }> {
        return this.inner.create(options);
      }
      get(runId: string): Promise<RunRecord> {
        return this.inner.get(runId);
      }
      update(record: RunRecord): Promise<RunRecord> {
        return this.inner.update(record);
      }
      list(workflowId?: string): Promise<RunRecord[]> {
        return this.inner.list(workflowId);
      }
      claimStep(runId: string, stepName: string, def: WorkflowDefinition): Promise<RunRecord> {
        return this.inner.claimStep(runId, stepName, def);
      }
    }

    it("--force, the default unlocks a guard that ABORTS: the guard is settled in the expiry's own write, and the ending and its Reason follow `✓ gate enacted`", async () => {
      const def = gateThenGuard('d625-abort', {
        gate: expiring('reject'),
        guard: { abort_message: NOT_APPROVED },
      });
      const { runId } = await openGate(def);
      const expired = await expireGate(runId);

      await runDrainAction(
        runId,
        { expired: true, force: true },
        runStore,
        workflowStore,
        DRAIN_DEPS,
      );

      // (a) red when drain prints only "✓ gate enacted" for an expiry whose guard ended the run,
      //     does not name the choice it enacted, or drops the Reason; (b) prints stdout.
      expect(stdout()).toEqual([
        "✓ gate enacted (settle_default 'reject').",
        "Guard step 'check' aborted the run.",
        `Reason: ${NOT_APPROVED}`,
        `Run '${runId}' has no pending finalizers. Nothing to drain.`,
      ]);
      const record = await runStore.get(runId);
      // ONE write: the expiry and the guard's settlement share one version bump.
      // (a) red when the guard is settled by a second write, or left eligible; (b) prints the
      //     version and the record's facts.
      expect(record.version).toBe(expired.version + 1);
      expect(record.skipped_steps).toContain('check');
      expect(record.sealed_by).toEqual({ arm: 'guard_abort', step: 'check' });
      expect(record.settled?.['confirm']).toMatchObject({
        choice: 'reject',
        resolved_by: 'timeout',
      });
    });

    it('--force, the default unlocks a guard that PASSES: the passed line follows `✓ gate enacted`', async () => {
      const def = gateThenGuard('d625-pass', { gate: expiring('approve'), more: FINISH });
      const { runId } = await openGate(def);
      await expireGate(runId);

      await runDrainAction(
        runId,
        { expired: true, force: true },
        runStore,
        workflowStore,
        DRAIN_DEPS,
      );

      // (a) red when a passing guard is not named, or the choice is not named; (b) prints stdout.
      expect(stdout()).toEqual([
        "✓ gate enacted (settle_default 'approve').",
        "Guard step 'check' passed.",
        `Run '${runId}' is not terminal (phase: 'running') — nothing further to drain.`,
      ]);
    });

    it('the DRY RUN predicts an aborting default — names the choice, the guard and its reason — and writes nothing', async () => {
      const def = gateThenGuard('d625-dry-abort', {
        gate: expiring('reject'),
        guard: { abort_message: NOT_APPROVED },
      });
      const { runId } = await openGate(def);
      const expired = await expireGate(runId);

      await runDrainAction(runId, { expired: true }, runStore, workflowStore, DRAIN_DEPS);

      // (a) red when the dry run says only "would enact settle_default", always predicts
      //     "would pass", or drops the reason; (b) prints stdout.
      expect(stdout()).toHaveLength(1);
      expect(stdout()[0]).toMatch(
        new RegExp(
          `^Run '${runId}': gate expired \\d+d \\d+h ago — would enact settle_default 'reject'; ` +
            `guard 'check' would then abort the run \\(${NOT_APPROVED}\\) on --force\\.$`,
        ),
      );
      // A prediction: the record and its version are untouched.
      // (a) red when the dry run persists what it computed; (b) prints the version and the gate.
      const record = await runStore.get(runId);
      expect(record.version).toBe(expired.version);
      expect(record.pending_gate?.gate_id).toBe(expired.pending_gate?.gate_id);
    });

    it('the DRY RUN predicts a passing default, and a pass that would complete the run', async () => {
      const goesOn = gateThenGuard('d625-dry-pass', { gate: expiring('approve'), more: FINISH });
      const { runId: goesOnId } = await openGate(goesOn);
      await expireGate(goesOnId);
      await runDrainAction(goesOnId, { expired: true }, runStore, workflowStore, DRAIN_DEPS);
      // (a) red when a passing guard is not predicted, or is predicted to end the run;
      //     (b) prints the line.
      expect(stdout()[0]).toMatch(
        /— would enact settle_default 'approve'; guard 'check' would pass on --force\.$/,
      );

      logSpy.mockClear();
      const completes = gateThenGuard('d625-dry-complete', { gate: expiring('approve') });
      const { runId: completesId } = await openGate(completes);
      await expireGate(completesId);
      await runDrainAction(completesId, { expired: true }, runStore, workflowStore, DRAIN_DEPS);
      // (a) red when a completing pass is predicted as a plain pass; (b) prints the line.
      expect(stdout()[0]).toMatch(
        /— would enact settle_default 'approve'; guard 'check' would pass and complete the run on --force\.$/,
      );
    });

    it('the DRY RUN predicts a guard that would FAIL the run, and an abort with no authored message carries no parenthesis', async () => {
      const fails = gateThenGuard('d625-dry-fail', {
        gate: expiring('approve'),
        guard: { abort_unless: ['nope.field == true'] },
      });
      const { runId: failsId } = await openGate(fails);
      await expireGate(failsId);
      await runDrainAction(failsId, { expired: true }, runStore, workflowStore, DRAIN_DEPS);
      // (a) red when a resolution error is predicted as an abort, or its reason is dropped;
      //     (b) prints the line.
      expect(stdout()[0]).toMatch(
        /; guard 'check' would then fail the run \(Guard resolution error: unresolvable path 'nope\.field' \(condition: nope\.field == true\)\) on --force\.$/,
      );

      logSpy.mockClear();
      const silent = gateThenGuard('d625-dry-no-message', { gate: expiring('reject') });
      const { runId: silentId } = await openGate(silent);
      await expireGate(silentId);
      await runDrainAction(silentId, { expired: true }, runStore, workflowStore, DRAIN_DEPS);
      // (a) red when an empty parenthesis or an invented reason is printed; (b) prints the line.
      expect(stdout()[0]).toMatch(
        /— would enact settle_default 'reject'; guard 'check' would then abort the run on --force\.$/,
      );
    });

    it('the DRY RUN adds nothing when the registered workflow copy cannot be read, and nothing on a store without settleStep', async () => {
      const def = gateThenGuard('d625-dry-unreadable', {
        gate: expiring('reject'),
        guard: { abort_message: NOT_APPROVED },
      });
      const { runId } = await openGate(def);
      await expireGate(runId);

      // An empty registry: the copy cannot be read.
      const emptyRegistry = new JsonWorkflowStore(join(home, 'no-such-registry'));
      await runDrainAction(runId, { expired: true }, runStore, emptyRegistry, DRAIN_DEPS);
      // (a) red when the dry run crashes or guesses when it cannot read the definition;
      //     (b) prints the line.
      expect(stdout()[0]).toMatch(/— would enact settle_default 'reject' on --force\.$/);

      logSpy.mockClear();
      // On a store without `settleStep`, `--force` settles no guard in the expiry's write — so
      // none is predicted.
      await runDrainAction(
        runId,
        { expired: true },
        new NoSettleStepStore(runStore),
        workflowStore,
        DRAIN_DEPS,
      );
      // (a) red when the dry run predicts a guard `--force` would not settle; (b) prints the line.
      expect(stdout()[0]).toMatch(/— would enact settle_default 'reject' on --force\.$/);
    });

    it('--all --expired: the dry-run listing is unchanged; --force prints what the guards did under each run', async () => {
      const def = gateThenGuard('d625-batch', {
        gate: expiring('reject'),
        guard: { abort_message: NOT_APPROVED },
      });
      const { runId } = await openGate(def);
      await expireGate(runId);

      await runDrainAction(
        undefined,
        { all: true, expired: true },
        runStore,
        workflowStore,
        DRAIN_DEPS,
      );
      // (a) red when the batch listing changes shape; (b) prints the listing line.
      expect(stdout()[1]).toMatch(
        new RegExp(`^  • ${runId}: gate expired \\d+d \\d+h ago — would enact settle_default$`),
      );

      logSpy.mockClear();
      await runDrainAction(
        undefined,
        { all: true, expired: true, force: true },
        runStore,
        workflowStore,
        DRAIN_DEPS,
      );
      // (a) red when the batch reports "gate enacted" alone for a run a guard ended;
      //     (b) prints stdout.
      expect(stdout()).toEqual([
        `  ✓ ${runId}: gate enacted`,
        "    Guard step 'check' aborted the run.",
        `    Reason: ${NOT_APPROVED}`,
        'Drained 1/1 run(s).',
      ]);
    });
  });
});
