// realm run gc — the --heal flag-composition cells (issue #293) — ACTION-level tests.
//
// gc.ts has a TOP-LEVEL VALUE import of `@sensigo/realm` (`WorkflowError`/`deleteIfExists`) —
// merely importing `gc.js`, even dynamically, eagerly evaluates `@sensigo/realm`'s module graph,
// including `JsonFileStore`'s module-load-time `DEFAULT_RUNS_DIR = join(homedir(), ...)` capture
// (the #285 leak class — gc.ts is on that census, per the #293 prompt's own note; NOT converted
// here). A STATIC top-of-file `import { gcCommand } from './gc.js'` would therefore freeze the
// REAL $HOME before `beforeAll` ever runs. `gcCommand` is imported dynamically instead, INSIDE
// `beforeAll`, strictly AFTER `process.env['HOME']` is overridden — mirroring
// list-status-aborted-action.test.ts's own documented ordering discipline.
//
// CRITICAL: this file's OWN fixture helper also needs `JsonFileStore`/`atomicWriteFile` — those
// MUST be dynamically imported too, in the SAME `beforeAll`, for the SAME reason. A static
// top-of-file `import { JsonFileStore } from '@sensigo/realm'` freezes `DEFAULT_RUNS_DIR` to the
// REAL, unmodified `$HOME` BEFORE `beforeAll` ever runs — module evaluation order doesn't care
// which binding you import; importing ANYTHING from `@sensigo/realm` evaluates its whole graph.
// (This was caught the hard way: an earlier draft imported these statically, and `gcCommand`'s own
// `new JsonFileStore()` — the no-arg construction inside `.action()` — silently resolved to the
// REAL `~/.realm/runs` instead of this file's temp dir. It surfaced immediately as a thrown error
// reading a REAL run record's `failed_steps`, before any write — no real data was touched, but it
// would have been a live-user-data mutation on a less lucky record shape. Never repeat this.)
//
// issue #285 (2026-08-13): the capture itself is now fixed at the root — `DEFAULT_RUNS_DIR` no
// longer exists; the default resolves at CONSTRUCTION time (drain.ts's header has the full
// account). Historicized here only — the lazy-import workaround above stays (still correct, no
// longer load-bearing against this specific hazard, not worth the churn to simplify).
//
// The pure sweep functions (`sweepOrphans`/`sweepOrphanArtifacts`/`sweepStalePhases`) and
// `gcExitCode` are already unit-tested directly against real tmp dirs in gc.test.ts — this file
// tests ONLY the `.action()` wiring these unit tests cannot reach: the three flag-composition
// cells (bare `gc` refuses; `--heal` alone runs only the heal pass; `--heal --older-than` composes
// both) and that each cell's reporting/exit-code behavior matches.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { JsonFileStore as JsonFileStoreType, RunRecord } from '@sensigo/realm';

let home: string;
let runsDir: string;
let originalHome: string | undefined;
let gcCommand: Command;
let JsonFileStore: typeof JsonFileStoreType;
let atomicWriteFile: (path: string, data: string) => Promise<void>;

describe('realm run gc --heal — flag composition (issue #293) — action-level', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'gc-heal-composition-cli-'));
    runsDir = join(home, '.realm', 'runs');
    await mkdir(runsDir, { recursive: true });
    originalHome = process.env['HOME'];
    process.env['HOME'] = home; // set before EITHER dynamic '@sensigo/realm' import, below
    ({ gcCommand } = await import('./gc.js'));
    ({ JsonFileStore, atomicWriteFile } = await import('@sensigo/realm'));
  });

  afterAll(async () => {
    if (originalHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('process.exit');
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function stdoutText(): string {
    return logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }
  function stderrText(): string {
    return errSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
  }

  /** Seeds a #282-class stale-phase record directly into the DEFAULT ($HOME-derived) runs dir —
   *  mirrors gc.test.ts's own `writeStalePhaseFixture`, duplicated here (not imported) since this
   *  file's whole point is exercising the real DEFAULT-path `new JsonFileStore()` construction
   *  inside `.action()`, not an explicit-dir store instance. */
  async function seedStalePhaseRecord(): Promise<string> {
    const store = new JsonFileStore(runsDir);
    const { run } = await store.create({
      workflowId: 'wf-293-cli',
      workflowVersion: 1,
      params: {},
    });
    const stale: RunRecord = {
      ...run,
      completed_steps: ['a'],
      terminal_state: true,
      terminal_reason: 'Workflow completed.',
      pending_gate: {
        gate_id: 'zombie-cli',
        step_name: 'a',
        preview: {},
        choices: ['approve'],
        opened_at: '2026-01-01T00:00:00.000Z',
      },
      run_phase: 'gate_waiting', // stale
    };
    await atomicWriteFile(join(runsDir, `${run.id}.json`), JSON.stringify(stale, null, 2));
    return run.id;
  }

  async function clearRunsDir(): Promise<void> {
    await rm(runsDir, { recursive: true, force: true });
    await mkdir(runsDir, { recursive: true });
  }

  it('cell 1: bare `gc` (neither --older-than nor --heal) still refuses, naming --older-than, exit 1', async () => {
    await expect(gcCommand.parseAsync([], { from: 'user' })).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrText()).toContain('--older-than');
    expect(stderrText()).toContain('not specified');
  });

  it('cell 2: `gc --heal` alone runs ONLY the heal pass — no temp/artifact section, no --older-than error', async () => {
    await clearRunsDir();
    const staleId = await seedStalePhaseRecord();

    await gcCommand.parseAsync(['--heal'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const out = stdoutText();
    expect(out).toContain('stale-phase record(s) WOULD be healed');
    expect(out).toContain(staleId);
    // The temp/artifact sections never even print "nothing found" — they never ran.
    expect(out).not.toContain('orphaned .tmp file');
    expect(out).not.toContain('orphaned WAL/sidecar artifact');
  });

  it('cell 2b: `gc --heal --force` alone actually heals (no --older-than needed)', async () => {
    await clearRunsDir();
    const staleId = await seedStalePhaseRecord();

    await gcCommand.parseAsync(['--heal', '--force'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const out = stdoutText();
    expect(out).toContain('Healed 1 stale-phase record');
    expect(out).toContain(staleId);

    const healed = JSON.parse(
      await readFile(join(runsDir, `${staleId}.json`), 'utf8'),
    ) as RunRecord;
    expect(healed.run_phase).toBe('completed');
  });

  it('cell 3: `gc --heal --older-than 6h --force` composes BOTH passes — heal AND temp/artifact sections both print', async () => {
    await clearRunsDir();
    const staleId = await seedStalePhaseRecord();
    // A trivially reapable orphan .tmp so the temp-file section has something to say too.
    const tempPath = join(runsDir, 'orphan.json.999.0.tmp');
    await writeFile(tempPath, 'x');
    const veryOld = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await utimes(tempPath, veryOld, veryOld);

    await gcCommand.parseAsync(['--heal', '--older-than', '6h', '--force'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const out = stdoutText();
    expect(out).toContain('Healed 1 stale-phase record');
    expect(out).toContain(staleId);
    expect(out).toContain('Reaped 1 orphaned .tmp file');
  });

  it('cell 3b (a fourth, control cell): `gc --older-than 6h --force` WITHOUT --heal never mentions healing at all — byte-stable', async () => {
    await clearRunsDir();
    await seedStalePhaseRecord(); // present, but --heal was never requested — must stay untouched.

    await gcCommand.parseAsync(['--older-than', '6h', '--force'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const out = stdoutText();
    expect(out).not.toContain('stale-phase');
    expect(out).not.toContain('heal');
  });
});
