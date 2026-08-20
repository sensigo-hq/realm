// gc-heal-note.test.ts — issue #367: the retention-clock note prints on EVERY heal branch.
//
// This is the defect this file exists for: the note first shipped INSIDE the nothing-to-heal
// branch, so it printed only when nothing was at stake and stayed silent in the `--force` branch
// that actually rewrites records and resets `updated_at` — the clock retention reads. A note
// asserted only on the nothing-at-stake branch is the defect, not the pin.
//
// Driven against the BUILT CLI with a redirected $HOME, matching this command's own convention
// (gc.test.ts unit-tests the pure sweeps; the report-formatting layer is exercised end to end).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const CLI = join(process.cwd(), 'dist', 'index.js');

/** The sentence every heal branch must carry. */
const NOTE = 'Note (issue #367)';

let home: string;
let runsDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'realm-gc-note-home-'));
  runsDir = join(home, '.realm', 'runs');
  await mkdir(runsDir, { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A terminal record whose PERSISTED phase disagrees with what the engine derives — heal's target. */
async function seedStalePhaseRecord(id: string): Promise<void> {
  const now = new Date().toISOString();
  await writeFile(
    join(runsDir, `${id}.json`),
    JSON.stringify(
      {
        id,
        workflow_id: 'wf',
        workflow_version: 1,
        completed_steps: ['a'],
        in_progress_steps: [],
        failed_steps: [],
        skipped_steps: [],
        skip_details: {},
        claims: {},
        run_phase: 'running', // STALE: the record below derives 'completed'
        version: 1,
        params: {},
        evidence: [],
        created_at: now,
        updated_at: now,
        terminal_state: true,
        terminal_reason: 'Workflow completed.',
      },
      null,
      2,
    ),
  );
}

async function gc(args: string[]): Promise<string> {
  const { stdout, stderr } = await run(process.execPath, [CLI, 'run', 'gc', ...args], {
    env: { ...process.env, HOME: home },
  });
  return stdout + stderr;
}

describe('gc --heal prints the retention-clock note on every branch (issue #367)', () => {
  it('the --force branch — THE at-stake one, where updated_at is actually reset', async () => {
    await seedStalePhaseRecord('stale-force');
    const out = await gc(['--heal', '--force']);
    expect(out).toContain('Healed 1 stale-phase record(s)'); // non-vacuity: it really healed
    expect(out).toContain(NOTE);
    expect(out).toContain('resets updated_at');
  });

  it('the dry-run-with-candidates branch — the operator deciding whether to run --force', async () => {
    await seedStalePhaseRecord('stale-dry');
    const out = await gc(['--heal']);
    expect(out).toContain('WOULD be healed'); // non-vacuity: candidates were found
    expect(out).toContain(NOTE);
  });

  it('the nothing-to-heal branch — where it already printed, kept', async () => {
    const out = await gc(['--heal']);
    expect(out).toContain('No stale-phase records found to heal.');
    expect(out).toContain(NOTE);
  });
});
