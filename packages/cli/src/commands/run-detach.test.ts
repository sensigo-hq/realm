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
  describe('exit codes that tell the truth (issue #468)', () => {
    const errLines = (): string[] => errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    const logged = (): string => logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    /** The persisted record, read the way c POSITIVE's mock reads it (the #285 idiom: the store
     *  is constructed AFTER the scratch HOME is live). */
    const readRecord = async (): Promise<RunRecord> => {
      const { JsonFileStore } = await import('@sensigo/realm');
      const store = new JsonFileStore();
      const files = readdirSync(runsDir()).filter((f) => f.endsWith('.json'));
      return store.get(files[0]!.replace('.json', ''));
    };

    it("B1 a typo'd gate choice re-prompts the live gate instead of dying silently", async () => {
      // Red-first on main (built dist, pty, paced per prompt): the ✗ line then SILENCE — the
      // process exits 0 with the gate still pending, live. `{}` opens the gate through
      // executeChain's confirm_required (NOT via planting — that idiom is c POSITIVE's, purpose-
      // built for the catch route). Chain: mock output opens the gate, a typo'd choice, the real
      // choice.
      writeFileSync(
        join(dir, 'workflow.yaml'),
        `id: detach-wf
name: Detach WF
version: 1
steps:
  a:
    description: gated
    execution: auto
    trust: human_confirmed
    gate:
      choices: [approve, reject]
`,
        'utf8',
      );
      mocks.question
        .mockImplementationOnce(async () => '{}')
        .mockImplementationOnce(async () => 'aprove')
        .mockImplementationOnce(async () => 'approve');

      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });

      expect(mocks.question).toHaveBeenCalledTimes(3);
      expect(mocks.question).toHaveBeenLastCalledWith('  Choice [approve/reject]: ');
      const lines = errLines();
      expect(lines.filter((l) => l.includes("Choice 'aprove' is not valid"))).toHaveLength(1);
      expect(logged()).toContain('Run complete. Phase: completed');
      expect(exitSpy).not.toHaveBeenCalled();
      const rec = await readRecord();
      expect(rec.run_phase).toBe('completed');
    }, 20_000);

    it('B2 leg 1: one schema-violating answer re-prompts the still-eligible step', async () => {
      // Red-first on main: the ✗ line then SILENCE — exit 0, the record shows `rejections: {s1:
      // 1}` (the #220 counting fired) yet the session died on a retryable step. output_schema
      // forces validation; execution: agent is required — countRejection only counts agent steps.
      writeFileSync(
        join(dir, 'workflow.yaml'),
        `id: detach-wf
name: Detach WF
version: 1
steps:
  s1:
    description: s1
    execution: agent
    output_schema:
      type: object
      required: [ok]
      properties:
        ok: { type: boolean }
`,
        'utf8',
      );
      mocks.question
        .mockImplementationOnce(async () => '{"wrong":1}')
        .mockImplementationOnce(async () => '{"ok":true}');

      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });

      expect(mocks.question).toHaveBeenCalledTimes(2);
      expect(errLines().filter((l) => l.includes('Output validation failed'))).toHaveLength(1);
      expect(logged()).toContain('Run complete. Phase: completed');
      expect(exitSpy).not.toHaveBeenCalled();
    }, 20_000);

    it('B2 bound leg: exactly six violations terminalize the run, and the exit says so', async () => {
      // The forcing cell for decisions 1 AND 3 together. Red-first (main, literal deliverable):
      // unconstructible — a bare continue never sees the terminalization, the loop asks a
      // SEVENTH question, the mock chain (exactly six answers) is exhausted, and the #459 helper
      // rejects on `undefined.trim()` — that rejection is the artifact this fix removes, not the
      // pin. Post-fix, MA/lane-executed transcript: five `Output validation failed` + one
      // `exhausted its validation-rejection budget (6/6)`, phase failed, sealed_by step_failure.
      // The tail sits AFTER the finally, so the mocked exit's throw rejects parseAsync DIRECTLY —
      // no catch sits between; rl is already closed.
      writeFileSync(
        join(dir, 'workflow.yaml'),
        `id: detach-wf
name: Detach WF
version: 1
steps:
  s1:
    description: s1
    execution: agent
    output_schema:
      type: object
      required: [ok]
      properties:
        ok: { type: boolean }
`,
        'utf8',
      );
      for (let i = 0; i < 6; i++) {
        mocks.question.mockImplementationOnce(async () => '{"wrong":1}');
      }

      await expect(
        runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(mocks.question).toHaveBeenCalledTimes(6);
      const lines = errLines();
      expect(lines.filter((l) => l.includes('Output validation failed'))).toHaveLength(5);
      expect(lines.some((l) => l.includes('exhausted its validation-rejection budget (6/6)'))).toBe(
        true,
      );
      expect(logged()).toContain('Run complete. Phase: failed');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const rec = await readRecord();
      expect(rec.terminal_state).toBe(true);
      expect(rec.run_phase).toBe('failed');
    }, 20_000);

    it("B3 a stall hands the run back with a TRUTHFUL map — never 'Prompt cancelled'", async () => {
      // Red-first on main: the stall line alone, exit 0, no map, live run. First-iteration stall
      // (an unsatisfiable `when`) asks no question at all — the else-fork map with the
      // '(step unknown)' fallback, already pinned as a renderer unit at :139.
      //
      // MULTIPLE stderr calls here by design (the stall line + the map) — never copy c
      // POSITIVE's toHaveLength(1) channel pin.
      writeFileSync(
        join(dir, 'workflow.yaml'),
        `id: detach-wf
name: Detach WF
version: 1
steps:
  a:
    description: a
    execution: agent
    when:
      - 'run.params.never_true == true'
`,
        'utf8',
      );

      await expect(
        runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }),
      ).rejects.toThrow('process.exit');

      expect(mocks.question).not.toHaveBeenCalled();
      const text = stderr();
      expect(text).toContain('Workflow stalled — detached from run');
      // The route-separation tooth: a default-headline regression reds this — the map's own
      // ELSE-fork line is the same one a1's unit already pins, so what discriminates HERE is
      // that it is NOT the cancel route's claim.
      expect(text).not.toContain('Prompt cancelled');
      expect(text).toContain('realm run inspect');
      expect(text).toContain("at step '(step unknown)'");
      expect(exitSpy).toHaveBeenCalledWith(1);
    }, 20_000);

    it("B5 the CHOICE arm's fresh read: a run terminalized externally during a bad choice converges honestly", async () => {
      // The per-member tooth for the CHOICE ✗ arm's read (decision 1 has TWO reads — the gate arm
      // and the step arm; B2's bound leg pins only the step arm's). Interpose idiom, c POSITIVE's
      // own precedent: the SECOND question call side-effects on the stored record before
      // returning, so the state the choice arm's fresh read must see is one the loop's own `run`
      // snapshot never observed.
      writeFileSync(
        join(dir, 'workflow.yaml'),
        `id: detach-wf
name: Detach WF
version: 1
steps:
  a:
    description: gated
    execution: auto
    trust: human_confirmed
    gate:
      choices: [approve, reject]
`,
        'utf8',
      );
      mocks.question
        .mockImplementationOnce(async () => '{}')
        .mockImplementationOnce(async () => {
          const { JsonFileStore } = await import('@sensigo/realm');
          const store = new JsonFileStore();
          const files = readdirSync(runsDir()).filter((f) => f.endsWith('.json'));
          const id = files[0]!.replace('.json', '');
          const fresh = await store.get(id);
          // Strip the gate by destructuring — never `pending_gate: undefined`, a TS2412 under this
          // repo's exactOptionalPropertyTypes.
          const { pending_gate: _gone, ...rest } = fresh;
          await store.update({
            ...rest,
            terminal_state: true,
            run_phase: 'completed',
            sealed_by: { arm: 'complete' },
            completed_steps: [...rest.completed_steps, 'a'],
          } as RunRecord);
          // Then a BAD choice, on the now-terminal run.
          return 'aprove';
        });

      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });

      expect(mocks.question).toHaveBeenCalledTimes(2);
      expect(stderr()).toContain("Run '");
      expect(stderr()).toContain(
        "is terminal; cannot submit a gate response — 'realm run resume' clears a stale pending gate on a resumable run, or 'realm run purge' removes the record entirely.",
      );
      expect(logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain(
        'Run complete. Phase: completed',
      );
      expect(exitSpy).not.toHaveBeenCalled();
    }, 20_000);
  });

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
      // Also the #468 completed-arm control (B4): a completed run resolves parseAsync bare and
      // never calls process.exit — the seam an explicit process.exit(0) would break.
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

    it("R3 Enter alone still means {} — and so does whitespace: the default arm's two members", async () => {
      // Near-control: on main `''` already yields `{}` (executed: `hash: 44136fa3…`, output `{}`), and
      // so does `'   '` — the helper preserves both. Its red-first is mutant (iv) — the `''` arm
      // dropped, `JSON.parse('')` throws.
      //
      // TWO members, one cell: the arm keys on `trimmed === ''`, and a `raw === ''` regression keeps
      // the empty answer defaulting while a whitespace-only answer re-prompts (`JSON.parse('')` →
      // `Unexpected end of JSON input`). The MA's executed mutant left every cell green with only the
      // empty member pinned; this cell is the arm's only per-member tooth. Under that mutant the
      // whitespace answer re-prompts, the two-answer chain is exhausted, and the third question's
      // `undefined.trim()` REJECTS the parse — the red is that rejection, not a conjunct below.
      writeFileSync(
        join(dir, 'workflow.yaml'),
        `id: detach-wf
name: Detach WF
version: 1
steps:
  s1:
    description: s1
    execution: agent
  s2:
    description: s2
    execution: agent
    depends_on: [s1]
`,
        'utf8',
      );
      mocks.question
        .mockImplementationOnce(async () => '')
        .mockImplementationOnce(async () => '   ');

      await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });

      expect(mocks.question).toHaveBeenCalledTimes(2);
      expect(reprompts()).toHaveLength(0);
      expect(logged()).toContain('Run complete. Phase: completed');
      const rec = await readRecord();
      expect(rec.evidence.find((e) => e.step_id === 's1')!.output_summary).toEqual({});
      expect(rec.evidence.find((e) => e.step_id === 's2')!.output_summary).toEqual({});
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
