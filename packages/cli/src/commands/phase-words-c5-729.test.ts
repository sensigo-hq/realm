// #729 PR-3 correction 5 (J-2, J-3, J-4): realm's own phase words and fixed sentences print whole
// at every line that prints a run's phase — while a shell variable holds the same word (the
// environment route: words of 8 or more characters, `completed`, `abandoned`, `gate_waiting`) or a
// declared value equals it (the declared route: `running`, `aborted`, `failed`, on a command that
// loads the project's manifest). One cell per spanned line; each cell's break is the span removed
// at its line (the red-first log names it). Run against the BUILT CLI, piped, in a fresh HOME —
// except the lines only a race or an interactive prompt reaches, which run their composer
// in-process with the writer installed and read what stdout would show.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  advanceRun,
  executeStep,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';

const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const AT = '2026-01-01T00:00:00.000Z';

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'realm-c5-words-'));
  home = join(root, 'home');
  mkdirSync(join(home, '.realm', 'runs'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The built CLI, piped, in a fresh process, from outside any project. */
function piped(args: string[], env: Record<string, string>, cwd: string = root) {
  const r = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd,
    env: { PATH: process.env['PATH'] ?? '', NO_COLOR: '1', HOME: home, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: r.status,
    out: `${r.stdout}${r.stderr}`,
    lines: `${r.stdout}${r.stderr}`.split('\n'),
  };
}

/** A run record written verbatim into HOME's store (the sanctioned legacy channel). */
function seed(id: string, fields: Record<string, unknown>): string {
  const record = {
    id,
    workflow_id: 'c5wf',
    workflow_version: 1,
    completed_steps: [],
    in_progress_steps: [],
    failed_steps: [],
    skipped_steps: [],
    skip_details: {},
    claims: {},
    run_phase: 'running',
    version: 1,
    params: {},
    evidence: [],
    created_at: AT,
    updated_at: AT,
    terminal_state: false,
    ...fields,
  };
  writeFileSync(join(home, '.realm', 'runs', `${id}.json`), JSON.stringify(record, null, 2));
  return id;
}

const COMPLETED = {
  run_phase: 'completed',
  terminal_state: true,
  completed_steps: ['a'],
  terminal_reason: 'Workflow completed.',
  sealed_by: { arm: 'complete' },
};
const GATE_WAITING = {
  run_phase: 'gate_waiting',
  pending_gate: {
    gate_id: 'g-c5',
    step_name: 'a',
    preview: {},
    choices: ['yes', 'no'],
    opened_at: AT,
  },
};

/** The first line of `out` that contains `marker`. */
const lineWith = (lines: string[], marker: string): string | undefined =>
  lines.find((l) => l.includes(marker));

describe('#729 PR-3 correction 5 (J-2) — the sweep commands print the phase whole', () => {
  it('resume.ts — `is in phase …, which is not resumable`', () => {
    const id = seed('c5-resume', COMPLETED);
    const r = piped(['run', 'resume', id, '--from', 'a'], { STATUS_X: 'completed' });
    // (a) red when the phase prints as plain text (`'[REDACTED]'`); (b) prints the line.
    expect(lineWith(r.lines, 'not resumable')).toBe(
      `Run ${id} is in phase 'completed', which is not resumable.`,
    );
  }, 60_000);

  it('reclaim.ts — `is terminal (…)`', () => {
    const id = seed('c5-reclaim-ended', COMPLETED);
    const r = piped(['run', 'reclaim', id], { STATUS_X: 'completed' });
    // (a) red when the phase prints as plain text; (b) prints the line.
    expect(lineWith(r.lines, 'is terminal')).toBe(
      `Run '${id}' is terminal (completed); it has no reclaimable claim.`,
    );
  }, 60_000);

  it('reclaim.ts — `(…) has no in-progress claims`', () => {
    const id = seed('c5-reclaim-none', GATE_WAITING);
    const r = piped(['run', 'reclaim', id], { STATUS_X: 'gate_waiting' });
    // (a) red when the phase prints as plain text; (b) prints the line.
    expect(lineWith(r.lines, 'no in-progress claims')).toBe(
      `Run '${id}' (gate_waiting) has no in-progress claims. Nothing to reclaim.`,
    );
  }, 60_000);

  it('reclaim.ts — `(…) — in-progress claims:`', () => {
    const id = seed('c5-reclaim-held', {
      ...GATE_WAITING,
      in_progress_steps: ['b'],
      claims: { b: { claimed_at: AT } },
    });
    const r = piped(['run', 'reclaim', id], { STATUS_X: 'gate_waiting' });
    // (a) red when the phase prints as plain text; (b) prints the line.
    expect(lineWith(r.lines, 'in-progress claims:')).toBe(
      `Run '${id}' (gate_waiting) — in-progress claims:`,
    );
  }, 60_000);

  it('export.ts — `is still …` (the best-effort snapshot line)', () => {
    const id = seed('c5-export', GATE_WAITING);
    const r = piped(
      ['run', 'export', id, '--out', join(root, 'b.json'), '--accept-partial-disclosure'],
      { STATUS_X: 'gate_waiting' },
    );
    const line = lineWith(r.lines, 'best-effort snapshot') ?? '';
    // (a) red when the phase prints as plain text; (b) prints the line up to its first `;`.
    expect(line.slice(0, line.indexOf(';'))).toBe(
      `⚠ best-effort snapshot: run '${id}' is still gate_waiting`,
    );
  }, 60_000);

  it('purge.ts — `not terminal (phase: …)` (the single-run refusal)', () => {
    const id = seed('c5-purge-live', GATE_WAITING);
    const r = piped(['run', 'purge', id], { STATUS_X: 'gate_waiting' });
    // (a) red when the phase prints as plain text; (b) prints the exit code and the line.
    expect([r.status, lineWith(r.lines, 'Refusing to purge')]).toEqual([
      1,
      `Refusing to purge '${id}': not terminal (phase: 'gate_waiting').`,
    ]);
  }, 60_000);

  it('purge.ts — `• <id>  (…, <size>)` (the dry-run list)', () => {
    const id = seed('c5-purge-old', COMPLETED);
    const r = piped(['run', 'purge', '--older-than', '1m'], { STATUS_X: 'completed' });
    const line = lineWith(r.lines, `• ${id}`) ?? '';
    // (a) red when the phase prints as plain text; (b) prints the line up to its size.
    expect(line.slice(0, line.indexOf(','))).toBe(`  • ${id}  (completed`);
  }, 60_000);

  it('drain.ts — `is not terminal (phase: …) — nothing to drain` (the dry run)', () => {
    const id = seed('c5-drain-dry', GATE_WAITING);
    const r = piped(['run', 'drain', id], { STATUS_X: 'gate_waiting' });
    const line = lineWith(r.lines, 'nothing to drain') ?? '';
    // (a) red when the phase prints as plain text; (b) prints the line up to its way out.
    expect(line.slice(0, line.indexOf(' — '))).toBe(
      `Run '${id}' is not terminal (phase: 'gate_waiting')`,
    );
  }, 60_000);

  it('drain.ts — `is not terminal (phase: …) — nothing to drain` (--force)', () => {
    const id = seed('c5-drain-force', GATE_WAITING);
    const r = piped(['run', 'drain', id, '--force'], { STATUS_X: 'gate_waiting' });
    const line = lineWith(r.lines, 'nothing to drain') ?? '';
    // (a) red when the phase prints as plain text; (b) prints the exit code and the line's start.
    expect([r.status, line.slice(0, line.indexOf(' — '))]).toEqual([
      1,
      `Run '${id}' is not terminal (phase: 'gate_waiting')`,
    ]);
  }, 60_000);

  it('drain.ts — `(…) — pending finalizers, rank order:`', () => {
    const id = seed('c5-drain-fin', {
      ...COMPLETED,
      finalizer_ledger: { fin: { status: 'pending', rank: 0 } },
    });
    const r = piped(['run', 'drain', id], { STATUS_X: 'completed' });
    // (a) red when the phase prints as plain text; (b) prints the line.
    expect(lineWith(r.lines, 'pending finalizers, rank order')).toBe(
      `Run '${id}' (completed) — pending finalizers, rank order:`,
    );
  }, 60_000);

  /** A terminal record whose PERSISTED phase (`abandoned`) is not the one it derives (`completed`). */
  const STALE = { ...COMPLETED, run_phase: 'abandoned', sealed_by: undefined };

  it('gc.ts — `persisted … → derived …` (the dry run)', () => {
    const id = seed('c5-gc-dry', STALE);
    const r = piped(['run', 'gc', '--heal'], { STATUS_X: 'completed', STATUS_Y: 'abandoned' });
    // (a) red when either phase prints as plain text; (b) prints the line.
    expect(lineWith(r.lines, `• ${id}:`)).toBe(
      `  • ${id}: persisted 'abandoned' → derived 'completed'`,
    );
  }, 60_000);

  it('gc.ts — `persisted … → derived …` (--force)', () => {
    const id = seed('c5-gc-force', STALE);
    const r = piped(['run', 'gc', '--heal', '--force'], {
      STATUS_X: 'completed',
      STATUS_Y: 'abandoned',
    });
    // (a) red when either phase prints as plain text; (b) prints the line.
    expect(lineWith(r.lines, `• ${id}:`)).toBe(
      `  • ${id}: persisted 'abandoned' → derived 'completed'`,
    );
  }, 60_000);

  it('run-migrate.ts — `(phase …)` in the incoherent bucket (phaseLabel)', () => {
    const id = seed('c5-migrate-incoherent', {
      run_phase: 'abandoned',
      terminal_state: true,
      terminal_reason: 'Abandoned by the operator',
      abandoned_at: AT,
      sealed_by: { arm: 'complete' },
    });
    const r = piped(['run', 'migrate', '--stamp-seals'], {
      STATUS_X: 'completed',
      STATUS_Y: 'abandoned',
    });
    // (a) red when either phase prints as plain text; (b) prints the line.
    expect(lineWith(r.lines, `• ${id}:`)).toBe(
      `  • ${id}: recorded arm 'complete' (phase completed), but the record's own markers/prose read as 'abandon_requested' (phase abandoned)`,
    );
  }, 60_000);

  it('run-migrate.ts — `(phase … → …)` in the stamped bucket', () => {
    const id = seed('c5-migrate-stamp', {
      run_phase: 'completed',
      terminal_state: true,
      terminal_reason: 'Abandoned by the operator',
      abandoned_at: AT,
    });
    // The other branch: a record whose phase the stamp keeps prints the one word.
    const same = seed('c5-migrate-same', {
      run_phase: 'abandoned',
      terminal_state: true,
      terminal_reason: 'Abandoned by the operator',
      abandoned_at: AT,
    });
    const r = piped(['run', 'migrate', '--stamp-seals'], {
      STATUS_X: 'completed',
      STATUS_Y: 'abandoned',
    });
    // (a) red when a phase prints as plain text on either branch; (b) prints both lines.
    expect([lineWith(r.lines, `• ${id}:`), lineWith(r.lines, `• ${same}:`)]).toEqual([
      `  • ${id}: abandon_requested (phase completed → abandoned)`,
      `  • ${same}: abandon_requested (phase abandoned)`,
    ]);
  }, 60_000);
});

describe("#729 PR-3 correction 5 (J-3) — migrate prints an unclassifiable record's fixed sentence whole", () => {
  it('a fixed sentence whole while a variable holds its word; a templated reason stays a bounded value', () => {
    const fixed = seed('c5-migrate-fixed', {
      run_phase: 'abandoned',
      terminal_state: true,
      terminal_reason: 'Abandoned via realm run abandon',
    });
    const templated = seed('c5-migrate-templated', {
      run_phase: 'abandoned',
      terminal_state: true,
      terminal_reason: 'Abandoned via realm run abandon FAKE-C5-J3-CANARY',
    });
    const r = piped(['run', 'migrate', '--stamp-seals'], {
      STATUS_X: 'Abandoned',
      APP_CANARY: 'FAKE-C5-J3-CANARY',
    });
    // (a) red when the fixed sentence prints as a value (`[REDACTED] via realm run abandon`), or a
    //     templated reason prints its canary; (b) prints both lines (fake text and a marker).
    expect([lineWith(r.lines, `• ${fixed}:`), lineWith(r.lines, `• ${templated}:`)]).toEqual([
      `  • ${fixed}: terminal reason "Abandoned via realm run abandon" matches no known seal shape`,
      `  • ${templated}: terminal reason "[REDACTED] via realm run abandon [REDACTED]" matches no known seal shape`,
    ]);
  }, 60_000);
});

describe('#729 PR-3 correction 5 (J-2, J-4) — list and abandon', () => {
  it("list.ts — `--status`'s refusal prints every phase whole", () => {
    const r = piped(['run', 'list', '--status', 'bogus'], { STATUS_X: 'completed' });
    // (a) red when a phase prints as plain text; (b) prints the exit code and the line.
    expect([r.status, lineWith(r.lines, 'Valid values:')]).toEqual([
      1,
      "Invalid --status value 'bogus'. Valid values: running, gate_waiting, completed, failed, abandoned, aborted",
    ]);
  }, 60_000);

  it("abandon.ts — the verb `abandoned` in `Run '…' abandoned (phase: …)`", () => {
    const id = seed('c5-abandon', {});
    const r = piped(['run', 'abandon', id], { STATUS_X: 'abandoned' });
    const first = lineWith(r.lines, `Run '${id}'`) ?? '';
    // (a) red when the verb prints as plain text (`Run '…' [REDACTED] (phase: …`); (b) prints the
    //     line up to its reason.
    expect(first.slice(0, first.indexOf(').') + 2)).toBe(
      `Run '${id}' abandoned (phase: 'abandoned').`,
    );
  }, 60_000);
});

describe('#729 PR-3 correction 5 (J-4) — help text is printed before the writer installs', () => {
  // MA 1's ruling (2026-10-22): commander prints help before the `preAction` hook installs the
  // writer, so help never passes the masking. These cells guard that: a change that installs the
  // writer before the parse must span the help's words first. Their break: the writer installed
  // before the parse (red: `[REDACTED]`).
  it("`realm run list --help` prints every phase in `--status`'s help whole", () => {
    const r = piped(['run', 'list', '--help'], { STATUS_X: 'completed' });
    const at = r.out.indexOf('Filter by run phase');
    // (a) red when the help passes the writer (`[REDACTED]`); (b) prints the help's two lines.
    expect(r.out.slice(at, r.out.indexOf(')', at) + 1).replace(/\s+/g, ' ')).toBe(
      'Filter by run phase (running, gate_waiting, completed, failed, abandoned, aborted)',
    );
  }, 60_000);

  it("`realm run --help` prints `abandoned` whole in abandon's and cleanup's descriptions", () => {
    const r = piped(['run', '--help'], { STATUS_X: 'abandoned' });
    const flat = r.out.replace(/\s+/g, ' ');
    // (a) red when the help passes the writer; (b) prints two booleans.
    expect({
      abandon: flat.includes('(marks it terminal with phase "abandoned")'),
      cleanup: flat.includes('Mark idle non-terminal runs as abandoned'),
    }).toEqual({ abandon: true, cleanup: true });
  }, 60_000);

  it("`realm run abandon --help` prints its description's `abandoned` whole", () => {
    const r = piped(['run', 'abandon', '--help'], { STATUS_X: 'abandoned' });
    // (a) red when the help passes the writer; (b) prints the description line.
    expect(lineWith(r.lines, 'Abandon a non-terminal run')).toBe(
      'Abandon a non-terminal run (marks it terminal with phase "abandoned")',
    );
  }, 60_000);
});

/** A workflow registered in HOME's store from a definition (no project folder). */
async function registered(steps: Record<string, unknown>): Promise<WorkflowDefinition> {
  const def = {
    id: 'c5wf',
    name: 'c5wf',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps,
  } as unknown as WorkflowDefinition;
  await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(def);
  return def;
}

/** A project folder whose `realm.yaml` declares one secret, `value` (the declared route). */
function declaring(value: string): string {
  const dir = join(root, 'project');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'realm.yaml'),
    'version: 1\nadapters:\n  svc:\n    use: github\n    config: { token: "${secret:C5_PIN}" }\n',
  );
  writeFileSync(join(dir, '.env'), `C5_PIN=${value}\n`);
  return dir;
}

const A_AUTO = { a: { description: 'A.', execution: 'auto', depends_on: [] } };

describe('#729 PR-3 correction 5 (J-2) — `realm run advance` prints the phase whole', () => {
  it("run-advance.ts — an operator's ending: `the run has ended (…). An operator ended this run`", async () => {
    await registered(A_AUTO);
    const id = seed('c5-adv-abandoned', {
      run_phase: 'abandoned',
      terminal_state: true,
      terminal_reason: 'Held.',
      abandoned_at: AT,
      sealed_by: { arm: 'abandon_requested' },
    });
    const r = piped(['run', 'advance', id], { STATUS_X: 'abandoned' });
    const line = lineWith(r.lines, 'Nothing is owed to the engine:') ?? '';
    // (a) red when the phase prints as plain text; (b) prints the line up to its sentence.
    expect(line.slice(0, line.indexOf('. ') + 1)).toBe(
      'Nothing is owed to the engine: the run has ended (abandoned).',
    );
  }, 60_000);

  /** A run that ended with step `a` failed — `realm run resume` takes it. */
  async function failedRun(): Promise<string> {
    await registered(A_AUTO);
    return seed('c5-adv-failed', {
      run_phase: 'failed',
      terminal_state: true,
      failed_steps: ['a'],
      terminal_reason: "Step 'a' failed: boom",
      sealed_by: { arm: 'step_failure', step: 'a' },
    });
  }

  it('run-advance.ts — a failed run: `the run has ended (…) — to make … runnable again` (the declared route: `failed`)', async () => {
    const id = await failedRun();
    const r = piped(['run', 'advance', id], {}, declaring('failed'));
    const line = lineWith(r.lines, 'Nothing is owed to the engine:') ?? '';
    // (a) red when the phase prints as plain text; (b) prints the line up to its command.
    expect(line.slice(0, line.indexOf(': realm'))).toBe(
      "Nothing is owed to the engine: the run has ended (failed) — to make 'a' runnable again",
    );
  }, 60_000);

  it("run-advance.ts — the cross cell: the failed run's reason gets its way back in (`reason === ended`, both spanned)", async () => {
    const id = await failedRun();
    const r = piped(['run', 'advance', id], {}, declaring('failed'));
    // (a) red when one side of the equality is not spanned (the reason prints without its way);
    //     (b) prints one boolean.
    expect(r.out.includes(`runnable again: realm run resume ${id} --from a`)).toBe(true);
  }, 60_000);

  it('run-advance.ts — decision C37: a run the call completes gets no `Stopped:` line, while a variable holds `completed`', async () => {
    await registered(A_AUTO);
    const id = seed('c5-adv-completes', {});
    const r = piped(['run', 'advance', id], { STATUS_X: 'completed' });
    // (a) red when the filter compares the plain sentence with the spanned reason (`Stopped: the run
    //     has ended (completed)` printed); (b) prints the Stopped lines and the last line.
    expect([
      r.lines.filter((l) => l.startsWith('Stopped:')),
      r.lines.filter((l) => l !== '').at(-1),
    ]).toEqual([[], `Run ${id}: phase 'completed'`]);
  }, 60_000);
});

describe('#729 PR-3 correction 5 (J-2) — `realm run respond` prints the phase whole', () => {
  /** `confirm` (a question, default `approve` on expiry), then — `withAfter` — `after`, a bare
   *  `auto` step; a run at the question, its expiry in the past when `expired`. */
  async function question(
    expired: boolean,
    withAfter: boolean,
  ): Promise<{ def: WorkflowDefinition; runId: string; gateId: string; runs: JsonFileStore }> {
    const def = await registered({
      confirm: {
        description: 'Confirm.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: [],
        gate: {
          choices: ['approve', 'reject'],
          timeout_seconds: 3600,
          on_expiry: 'settle_default',
          default_choice: 'approve',
        },
      },
      ...(withAfter
        ? { after: { description: 'After.', execution: 'auto', depends_on: ['confirm'] } }
        : {}),
    });
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const { run } = await runs.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const opened = await executeStep(runs, def, {
      runId: run.id,
      command: 'confirm',
      input: {},
      dispatcher: async () => ({}),
    });
    if (opened.status !== 'confirm_required') throw new Error(`fixture: ${opened.status}`);
    if (expired) {
      const record: RunRecord = await runs.get(run.id);
      await runs.update({
        ...record,
        pending_gate: {
          ...record.pending_gate!,
          opened_at: '2020-01-01T00:00:00.000Z',
          expires_at: '2020-01-01T01:00:00.000Z',
        },
      });
    }
    return { def, runId: run.id, gateId: opened.gate!.gate_id, runs };
  }

  it("respond.ts — `Responded: … | new state '…'`", async () => {
    // The question is the only step: the answer completes the run.
    const { runId, gateId } = await question(false, false);
    const r = piped(['run', 'respond', runId, '--gate', gateId, '--choice', 'approve'], {
      STATUS_X: 'completed',
    });
    // (a) red when the phase prints as plain text; (b) prints the line.
    expect(lineWith(r.lines, 'Responded:')).toBe(
      `Responded: ${runId} | choice 'approve' | new state 'completed'`,
    );
  }, 60_000);

  it("respond.ts — a late answer: `Not recorded: … | state '…'`", async () => {
    const { def, runId, gateId, runs } = await question(true, true);
    // Another call carries the expiry out first: the default completes the run.
    await advanceRun(runs, def, { runId });
    const r = piped(['run', 'respond', runId, '--gate', gateId, '--choice', 'reject'], {
      STATUS_X: 'completed',
    });
    // (a) red when the phase prints as plain text; (b) prints the exit code and the line.
    expect([r.status, lineWith(r.lines, 'Not recorded:')]).toEqual([
      1,
      `Not recorded: ${runId} | gate settled by timeout with choice 'approve' | state 'completed'`,
    ]);
  }, 60_000);
});
