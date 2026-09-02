// issue #447 — cancelling a dev-run prompt prints a detach map instead of a stack.
//
// PTY CAVEAT, stated once for the whole file. `AbortError` is Node-internal and TTY-only: a
// readline over a PassThrough never settles on an abort, so no in-process cell can produce the
// real rejection. These cells throw a CONSTRUCTED error mirroring the pty transcript exactly —
// `Object.assign(new Error('Aborted with Ctrl+D'), { code: 'ABORT_ERR' })` — which is what a real
// terminal was observed to produce:
//
//     $ printf '\004' | script -qec "node probe.mjs" /dev/null
//     REJECTED name=AbortError code="ABORT_ERR" message="Aborted with Ctrl+D"
//
// The pty journey itself is the reviewer's crown, never a suite cell (the #426 precedent).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '@sensigo/realm';
import { runCommands, topLevelCommands } from '../commands-registry.js';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand, renderDetachMap } from './run.js';

/** A minimal non-terminal record; overrides shape each fork. */
function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run_abc',
    workflow_id: 'wf',
    workflow_version: 1,
    version: 1,
    run_phase: 'running',
    terminal_state: false,
    params: {},
    completed_steps: [],
    failed_steps: [],
    evidence: [],
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  } as RunRecord;
}

describe('renderDetachMap — the fork is on the record (issue #447)', () => {
  it('a1 the ELSE fork offers all three remedies', () => {
    const map = renderDetachMap(record(), 'summarise');

    expect(map).toContain("detached from run 'run_abc' at step 'summarise'");
    expect(map).toContain('(phase: running)');
    expect(map).toContain('The run is saved.');
    expect(map).toContain('realm agent --run-id run_abc');
    expect(map).toContain('realm run inspect run_abc');
    expect(map).toContain('realm run abandon run_abc');
  });

  it('a2 the GATE fork offers respond + inspect, and never the refused remedies', () => {
    // No Discard line by design: `realm run abandon` REFUSES a run with a pending gate
    // (STATE_TRANSITION_DENIED) and says to resolve the gate first. Printing a command that will
    // be rejected is worse than printing nothing.
    const map = renderDetachMap(
      record({
        pending_gate: {
          gate_id: 'g-1',
          step_name: 'approve_it',
          choices: ['approve', 'reject'],
          preview: {},
          opened_at: '2026-09-01T00:00:00.000Z',
        },
      } as Partial<RunRecord>),
      'approve_it',
    );

    expect(map).toContain('realm run respond run_abc --gate g-1 --choice approve|reject');
    expect(map).toContain('realm run inspect run_abc');
    // The COMMANDS, not the bare words — see a3 for why the loose form is a trap.
    expect(map).not.toContain('realm run abandon');
    expect(map).not.toContain('realm agent --run-id');
    expect(map).toContain("at step 'approve_it'");
  });

  it('a3 the TERMINAL fork offers inspect ALONE', () => {
    // Both other remedies refuse a terminal run, by two different mechanisms: abandon throws
    // STATE_RUN_TERMINAL, and `agent --run-id` refuses through an uncoded check in
    // resolveRunAttach. Reachable for real — an external respond or an expiry enactment can
    // terminalize this run while the process sits on the prompt.
    const map = renderDetachMap(
      record({
        terminal_state: true,
        run_phase: 'completed',
        completed_steps: ['a'],
        sealed_by: { arm: 'complete' },
      } as Partial<RunRecord>),
      'a',
    );

    expect(map).toContain('(phase: completed)');
    expect(map).toContain('realm run inspect run_abc');
    // The COMMANDS, not the bare words: a terminal record's derived phase can be `abandoned`,
    // and `not.toContain('abandon')` matches that phase name rather than the remedy line — an
    // assertion that reds on correct code and would have been "fixed" in the wrong direction.
    expect(map).not.toContain('realm run abandon');
    expect(map).not.toContain('realm agent --run-id');
    expect(map).not.toContain('realm run respond');
  });

  it('b the phase is DERIVED, not read off the record (the #432 class)', () => {
    // Persisted `completed`, but the seal's arm says the run failed — arm wins. A composer
    // reading record.run_phase names the wrong phase and sends the operator to the wrong remedy.
    const map = renderDetachMap(
      record({
        terminal_state: true,
        run_phase: 'completed',
        sealed_by: { arm: 'step_failure' },
      } as Partial<RunRecord>),
      'a',
    );

    expect(map).toContain('(phase: failed)');
    expect(map).not.toContain('(phase: completed)');
  });

  it('the step falls back through the gate name, then to a literal', () => {
    const withGate = renderDetachMap(
      record({
        pending_gate: {
          gate_id: 'g-9',
          step_name: 'from_the_gate',
          choices: ['ok'],
          preview: {},
          opened_at: '2026-09-01T00:00:00.000Z',
        },
      } as Partial<RunRecord>),
      undefined,
    );
    expect(withGate).toContain("at step 'from_the_gate'");

    expect(renderDetachMap(record(), undefined)).toContain("at step '(step unknown)'");
  });
});

describe('the cancel path (issue #447)', () => {
  let home: string;
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'realm-detach-home-'));
    dir = mkdtempSync(join(tmpdir(), 'realm-detach-wf-'));
    mkdirSync(join(home, '.realm'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = home;
    // Without this the #426 non-TTY guard refuses before the loop, and exit(1) fires for
    // entirely the wrong reason.
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    writeFileSync(
      join(dir, 'workflow.yaml'),
      `id: detach-wf
name: Detach WF
version: 1
steps:
  a:
    description: a
    execution: agent
`,
      'utf8',
    );
    // Captured since issue #459: `Run complete. Phase:` prints on console.log, which stderr()
    // cannot see.
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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

  const stderr = (): string => errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  const runsDir = (): string => join(home, '.realm', 'runs');

  it('c POSITIVE — the map is composed from a FRESH read, and names the real step', async () => {
    // The question plants a pending gate on the stored record BEFORE rejecting, so the state the
    // map must fork on is one the loop's own `run` snapshot has never seen.
    //
    // The planted gate's step_name is DELIBERATELY different from the real questioned step: with
    // the two coincident, the fallback chain's operands produce identical text and a mutant that
    // never assigns promptStep is invisible.
    mocks.question.mockImplementation(async () => {
      const { JsonFileStore } = await import('@sensigo/realm');
      const store = new JsonFileStore();
      const files = readdirSync(runsDir()).filter((f) => f.endsWith('.json'));
      const id = files[0]!.replace('.json', '');
      const rec = await store.get(id);
      await store.update({
        ...rec,
        pending_gate: {
          gate_id: 'g-1',
          step_name: 'planted-gate-step',
          choices: ['approve', 'reject'],
          preview: {},
          opened_at: '2026-09-01T00:00:00.000Z',
        },
      } as RunRecord);
      throw Object.assign(new Error('Aborted with Ctrl+D'), { code: 'ABORT_ERR' });
    });

    await expect(
      runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = stderr();
    // The REAL questioned step, not the planted gate's name — the conjunct that makes a
    // never-assigned promptStep observable.
    expect(text).toContain("at step 'a'");
    // And the RESPOND fork with the planted gate id: only a fresh read can see this. A compose
    // from the loop's stale snapshot prints the agent fork instead.
    expect(text).toContain('realm run respond');
    expect(text).toContain('--gate g-1');
    expect(exitSpy).toHaveBeenCalledWith(1);
    // ONE call for the whole map — the channel is a single pin, not per line.
    expect(errSpy.mock.calls).toHaveLength(1);
  }, 20_000);

  it('c NEGATIVE — a non-abort error still rethrows, loudly', async () => {
    // Re-homed by issue #459. A SyntaxError from JSON.parse — the shape this cell used to ride —
    // now RE-PROMPTS (operator input is handled where it is read), so it can no longer stand in
    // for "a non-abort error". What this pin guards is the residual rethrow population: anything
    // that is neither an abort nor operator input — here an I/O failure from the question itself,
    // with no `code` — still propagates through the #447 catch's rethrow arm, loudly.
    //
    // The old body against the new helper did not fail an assertion, and did not hit the 20 s
    // timeout either: a persistent bad answer re-prompts forever, and with the mock resolving as
    // a microtask the loop never yields to the timer — the worker died of heap exhaustion at
    // ~145 s (observed). That death was the flip.
    mocks.question.mockImplementation(async () => {
      throw new Error('EIO: i/o error, read');
    });

    await expect(
      runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }),
    ).rejects.toThrow(/EIO/);

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr()).not.toContain('Prompt cancelled');
  }, 20_000);

  it('c DEGRADED — a record that vanished mid-prompt still exits cleanly', async () => {
    // The same concurrent-writer reality that makes the fresh read necessary can make it FAIL:
    // a record purged from another terminal while this one waits. Without the degradation arm
    // the new cancel path crashes with exactly the stack this feature removes.
    mocks.question.mockImplementation(async () => {
      for (const f of readdirSync(runsDir()).filter((x) => x.endsWith('.json'))) {
        unlinkSync(join(runsDir(), f));
      }
      throw Object.assign(new Error('Aborted with Ctrl+D'), { code: 'ABORT_ERR' });
    });

    await expect(
      runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }),
    ).rejects.toThrow('process.exit');

    const text = stderr();
    expect(text).toContain('Prompt cancelled — detached from run');
    expect(text).toContain('could not be re-read');
    expect(text).toContain('realm run inspect');
    expect(text).not.toContain('    at ');
    expect(exitSpy).toHaveBeenCalledWith(1);
  }, 20_000);

  // NESTED here on purpose: the harness beforeEach/afterEach — scratch HOME, isTTY, the throwing
  // exit spy — are scoped to this describe. A sibling would run against the REAL ~/.realm with a
  // REAL process.exit in the worker (mechanics lane, #459).
  describe('re-prompt on bad answers (issue #459)', () => {
    const errLines = (): string[] => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const logged = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    const reprompts = (): string[] =>
      errLines().filter((l) => l.includes('Not valid JSON:') || l.includes('Not a JSON object'));
    /** The persisted record, read the way c POSITIVE's mock reads it (the #285 idiom: the store is
     *  constructed AFTER the scratch HOME is live). */
    const readRecord = async (): Promise<RunRecord> => {
      const { JsonFileStore } = await import('@sensigo/realm');
      const store = new JsonFileStore();
      const files = readdirSync(runsDir()).filter((f) => f.endsWith('.json'));
      return store.get(files[0]!.replace('.json', ''));
    };

    it('R1 the agent site: bad JSON and every non-object re-ask, then the object settles', async () => {
      // Red-first on main (built dist, pty, paced per prompt): `{broken` → an UNCAUGHT SyntaxError
      // with Node's own crash footer, the run wedged mid-step. `42` and `[1]` → the run COMPLETED
      // with a number / a list sealed as the step's output (`hash: 73475cb4…` — a type-lie in the
      // evidence record). `null` → the ENGINE crashed (`TypeError: Cannot convert undefined or
      // null to object` at executeStep's `_debug` check), the run wedged. One chain, all arms.
      mocks.question
        .mockImplementationOnce(async () => '{broken')
        .mockImplementationOnce(async () => '42')
        .mockImplementationOnce(async () => 'null')
        .mockImplementationOnce(async () => '[1]')
        .mockImplementationOnce(async () => '{"ok":true}');

      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });

      expect(mocks.question).toHaveBeenCalledTimes(5);
      expect(mocks.question).toHaveBeenLastCalledWith('  Agent output JSON (Enter for {}): ');
      const lines = errLines();
      expect(lines.filter((l) => l.includes('Not valid JSON:'))).toHaveLength(1);
      // Three, one per arm — number, null, array: the predicate's three disjuncts, each pinned.
      expect(lines.filter((l) => l.includes('Not a JSON object'))).toHaveLength(3);
      expect(logged()).toContain('Run complete. Phase: completed');
      // output_summary, NOT input_summary: dev-run feeds userOutput as both, so the wrong field
      // passes coincidentally and pins nothing about what the dispatcher returned.
      expect((await readRecord()).evidence[0]!.output_summary).toEqual({ ok: true });
      expect(exitSpy).not.toHaveBeenCalled();
    }, 20_000);

    it('R2 the auto/mock site is wired too — the per-member pin', async () => {
      // The file has no auto fixture, so this cell writes its own: bare `execution: auto`, no
      // handler — loader-legal; it prompts `  Mock output (auto) — JSON (Enter for {}): ` and
      // settles through the dispatcher else-arm (probe-confirmed on the built dist). Red-first on
      // main: `{bad` at that prompt is the agent site's uncaught SyntaxError, same shape.
      writeFileSync(
        join(dir, 'workflow.yaml'),
        `id: detach-wf
name: Detach WF
version: 1
steps:
  m:
    description: m
    execution: auto
`,
        'utf8',
      );
      mocks.question
        .mockImplementationOnce(async () => '{bad')
        .mockImplementationOnce(async () => '{"n":1}');

      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });

      expect(mocks.question).toHaveBeenCalledTimes(2);
      expect(mocks.question).toHaveBeenLastCalledWith(
        '  Mock output (auto) — JSON (Enter for {}): ',
      );
      expect(errLines().filter((l) => l.includes('Not valid JSON:'))).toHaveLength(1);
      expect(logged()).toContain('Run complete. Phase: completed');
      expect((await readRecord()).evidence[0]!.output_summary).toEqual({ n: 1 });
    }, 20_000);

    it("R3 Enter alone still means {} — the default is the helper's now", async () => {
      // Near-control: on main `''` already yields `{}` (executed: `hash: 44136fa3…`, output `{}`).
      // Its red-first is mutant (iv) — the `''` arm dropped, `JSON.parse('')` throws.
      mocks.question.mockImplementationOnce(async () => '');

      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });

      expect(mocks.question).toHaveBeenCalledTimes(1);
      expect(reprompts()).toHaveLength(0);
      expect(logged()).toContain('Run complete. Phase: completed');
      expect((await readRecord()).evidence[0]!.output_summary).toEqual({});
    }, 20_000);

    it('R4 a re-prompt then a cancel: the #447 map still fires — the helper swallows nothing else', async () => {
      // The composition of #459 with #447. `rl.question` sits OUTSIDE the helper's try, so the
      // constructed ABORT_ERR (the file's pty-mirroring idiom, header) propagates to the #447
      // catch exactly as before. TWO stderr calls here by design — the re-prompt line and the
      // map — so c POSITIVE's single-call channel pin does not apply.
      mocks.question
        .mockImplementationOnce(async () => 'nope{')
        .mockImplementationOnce(async () => {
          throw Object.assign(new Error('Aborted with Ctrl+D'), { code: 'ABORT_ERR' });
        });

      await expect(
        runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(mocks.question).toHaveBeenCalledTimes(2);
      expect(errLines().filter((l) => l.includes('Not valid JSON:'))).toHaveLength(1);
      const text = stderr();
      expect(text).toContain('Prompt cancelled — detached from run');
      expect(text).toContain("at step 'a'");
      expect(text).toContain('realm agent --run-id');
      expect(text).not.toContain('    at ');
      expect(exitSpy).toHaveBeenCalledWith(1);
    }, 20_000);
  });
});

describe('d the map names commands that exist (issue #447)', () => {
  it('respond, inspect and abandon are run subcommands; agent is top-level', () => {
    // The map hands an operator four command strings. A rename anywhere reds this, rather than
    // the map quietly pointing at something that no longer exists.
    const runNames = runCommands.map((c) => c.name());
    expect(runNames).toContain('respond');
    expect(runNames).toContain('inspect');
    expect(runNames).toContain('abandon');
    expect(topLevelCommands.map((c) => c.name())).toContain('agent');
  });
});
