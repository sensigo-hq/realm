// inspect-take-back-cw3b.test.ts — issue #729, the claim window, unit CW-3b (item 5): `realm run
// inspect`'s step history prints an automatic take-back's entry on its own line — who took the step
// back and from whom — beside a manual reclaim's line, neither counted as an attempt. The entries are
// real: the home's own lease, closed while its claim still names it (no program holds it), and core's
// `takeBackStep`; then `reclaimStep`, a person's reclaim.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reclaimStep,
  takeBackStep,
  type Attributed,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');

const DEF: WorkflowDefinition = {
  id: 'inspect-take-back-cw3b',
  name: 'inspect take-back',
  version: 1,
  steps: { a: { description: 'a.', execution: 'agent', depends_on: [] } },
};
const HOLDER: Attributed = { by: 'holder-program', by_source: 'stated', channel: 'agent' };
const TAKER: Attributed = { by: 'taker-program', by_source: 'stated', channel: 'agent' };
const OTHER: Attributed = { by: 'other@host', by_source: 'derived', channel: 'advance' };
/** How `describeProgram` prints a program: its name, how the name is known, the door. */
const shown = (a: Attributed, source: string): string => `${a.by} (${source}, via ${a.channel})`;

let h: TempHome & { readonly root: string };
let runStore: RunStore;
let elsewhere: string;

beforeEach(async () => {
  h = await makeTempHome();
  runStore = h.home.runStore;
  await h.home.workflowStore.register(DEF);
  elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'realm-cw3b-inspect-')));
});
afterEach(async () => {
  await h.cleanup();
  rmSync(elsewhere, { recursive: true, force: true });
});

/** The built `realm`, run from a folder that is not the home's nor a project's. */
function realm(args: string[]): string[] {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: elsewhere,
    env: { PATH: process.env['PATH'] ?? '', HOME: h.root, NO_COLOR: '1', REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return r.stdout.split('\n').filter((l) => l !== '');
}

/** Step `a` of a new run claimed under the home's own lease, by `holder`; the lease then closed. */
async function notHeldClaim(holder?: Attributed): Promise<{ runId: string; token: string }> {
  const { record: run } = await runStore.create({
    workflowId: DEF.id,
    workflowVersion: 1,
    params: {},
  });
  const made = await runStore.leases!.hold();
  if (!('held' in made))
    throw new Error(`fixture: the home could not hold a lease: ${made.unavailable}`);
  const { record } = await runStore.claimStep(run.id, 'a', DEF, holder, made.held);
  // closed: the claim stays, naming a lease file nothing holds (CW-1's L5)
  made.held.close(record);
  return { runId: run.id, token: record.claims!['a']!.token! };
}

/** Takes step `a` back as TAKER; the fixture fails if it was not taken back. */
async function takeBack(runId: string, token: string): Promise<void> {
  const answer = await takeBackStep(runStore, runId, 'a', { expectToken: token, drivenBy: TAKER });
  expect(answer.kind, 'fixture: the take-back').toBe('taken_back');
}

/** When each reclaim entry of step `a` says it was written, in the record's order. */
async function reclaimedAt(runId: string): Promise<string[]> {
  return (await runStore.get(runId)).record.evidence
    .filter((e) => e.step_id === 'a' && e.output_summary?.['reclaimed'] === true)
    .map((e) => String(e.output_summary['reclaimed_at']));
}

/** inspect's block for step `a`: its heading and the lines under it. */
function block(runId: string): string[] {
  const out = realm(['run', 'inspect', runId]);
  const from = out.findIndex((l) => /^ {2}\d+\. a\b/.test(l));
  const to = out.findIndex((l, n) => n > from && (/^ {2}\d+\. /.test(l) || !l.startsWith(' ')));
  return out.slice(from, to < 0 ? undefined : to);
}

const takenLine = (at: string, from: string): string =>
  `     Taken back at ${at} by ${shown(TAKER, 'as stated')}${from}: no program held the claim's lease when it was checked, so its claim was removed and the step could run again.`;
const manualLine = (at: string): string =>
  `     Reclaimed at ${at}: its claim was removed so the step could run again.`;

describe(
  '#729 CW-3b — check 4: inspect prints an automatic take-back on its own line',
  { timeout: 120_000 },
  () => {
    it('an automatic entry and a manual one on one step: each on its own line, neither an attempt', async () => {
      const { runId, token } = await notHeldClaim(HOLDER);
      await takeBack(runId, token);
      await runStore.claimStep(runId, 'a', DEF, OTHER);
      expect((await reclaimStep(runStore, runId, 'a')).outcome, 'fixture: the reclaim').toBe(
        'reclaimed',
      );
      const [automatic, manual] = await reclaimedAt(runId);
      // (1) red when the automatic entry prints the manual line, the taker or the holder is not named,
      //     or either entry is shown as an attempt; (2) prints the step's block.
      const lines = block(runId);
      expect(lines).toEqual([
        '  1. a',
        takenLine(automatic!, ` from ${shown(HOLDER, 'as stated')}`),
        manualLine(manual!),
      ]);
      // (1) red when the take-back's line guesses at the program instead of stating the lease fact
      //     (a word of the deny list); (2) prints the line and the words found in it.
      const deny = ['died', 'dead', 'alive', 'live runner', 'presumed', 'probably', 'likely'];
      expect(
        deny.filter((w) => lines[1]!.toLowerCase().includes(w)),
        lines[1],
      ).toEqual([]);
    });

    it('an automatic entry whose claim had no holder: the "from" clause is left out', async () => {
      const { runId, token } = await notHeldClaim();
      await takeBack(runId, token);
      const [automatic] = await reclaimedAt(runId);
      // (1) red when the line names a holder the claim did not record, or prints a word in its
      //     place; (2) prints the step's block.
      expect(block(runId)).toEqual(['  1. a', takenLine(automatic!, '')]);
    });
  },
);
