// below-cap-words-cw5c.test.ts — #729 CW-5c (prompt feat-729-cw5c-below-cap-words.md): a `realm agent`
// drive killed mid-call leaves its step's claim with a lease no program holds; the next `realm agent`
// takes it back, once. Every CLI screen that shows such a step now names that command after the
// person's way — check 2, one cell per place, below the cap (the sentence) and at the cap (today's
// words) — and `realm workflow run`'s Go-on line names it when it fits every step to be freed (check
// 3). `realm workflow run`'s two places are holder-lines-cw4b's (it cannot join a run it did not
// start, so they run in process there).
//
// Each cell runs the built `realm` on a SQLite home whose leases are real files: the drive's claim is
// taken through `claimStepForDrive`, as `realm agent` takes it, and its hold closed, as a killed
// drive's lock is let go. At the cap, the step was taken back once since (`takeBackStep`, as the
// next drive's watch takes it) and that drive was killed too.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it: (1) the
// change that turns it red; (2) what it prints when it fails.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  claimStepForDrive,
  composeWaysAt,
  createDefaultRegistry,
  executeStep,
  takeBackStep,
  type LeaseHold,
  type RealmWorkflowRegistrar,
  type RunStore,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createTestHome, type TestHome } from '@sensigo/realm-testing';
import { makeTempHome } from '../test-support/temp-home.js';
import { PLAIN } from '../output/writer.js';
import { goOnLine, stepsTakenBack } from '../lib/holder-render.js';
import { heldEntriesOf } from './ways-renderer.js';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
if (!existsSync(CLI)) throw new Error(`cli dist not built — run \`npm run build\` first (${CLI})`);

const DRIVE = { by: 'drive-a', by_source: 'stated', channel: 'agent' } as const;
const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition => ({
  id,
  name: id,
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps,
});
const agent = (deps: string[] = []): StepDefinition => ({
  description: 'Write.',
  execution: 'agent',
  depends_on: deps,
});
const auto = (deps: string[] = []): StepDefinition => ({
  description: 'Pack.',
  execution: 'auto',
  depends_on: deps,
});
const gate = (expiry = false): StepDefinition => ({
  description: 'Decide.',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on: [],
  gate: {
    choices: ['approve', 'reject'],
    ...(expiry
      ? { timeout_seconds: 1, on_expiry: 'settle_default' as const, default_choice: 'approve' }
      : {}),
  },
});

/** The sentence a screen ends a step's held lines with where a `realm agent` drive takes it back. */
const sentence = (id: string): string =>
  `Or let realm agent --run-id ${id} --provider <provider> --model <model> take it back and run it (this step's one automatic take-back until a person reclaims it).`;
/** Whether the screen names `realm agent` for a step at all. */
const namesAgent = (lines: readonly string[]): boolean =>
  lines.some((l) => l.includes('Or let realm agent'));

interface Home {
  root: string;
  path: string;
  runs: RunStore;
  workflows: RealmWorkflowRegistrar;
  clock: TestHome['clock'];
  cleanup: () => Promise<void>;
}
/** A SQLite home with a test clock that this handle and a spawned `realm` read (cannot-go-on-625's). */
async function home(): Promise<Home> {
  const owned = mkdtempSync(join(tmpdir(), 'realm-cw5c-'));
  const th = await createTestHome({ start: new Date(), root: join(owned, '.realm') });
  const h = await makeTempHome({ home: th.root });
  return {
    root: owned,
    path: h.path,
    runs: h.home.runStore,
    workflows: h.home.workflowStore,
    clock: th.clock,
    cleanup: async () => {
      await h.cleanup();
      await th.remove();
      rmSync(owned, { recursive: true, force: true });
    },
  };
}

/** The built `realm`, its exit and its lines (stdout, stderr). */
function realm(h: Home, args: string[]): { code: number | null; out: string[]; err: string[] } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { PATH: process.env['PATH'] ?? '', HOME: h.root, NO_COLOR: '1', REALM_NO_NUDGE: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const lines = (t: string): string[] => t.split('\n').filter((l) => l !== '');
  return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
}

/**
 * `step` taken by a `realm agent` drive that was killed (its claim stays, its lease held by no
 * program); at the cap, taken back once since by the next drive's watch, and that drive killed too.
 * `open` keeps a drive's hold open instead (its program still runs).
 */
async function killedDrive(
  h: Home,
  def: WorkflowDefinition,
  runId: string,
  step: string,
  state: 'below' | 'cap' | 'running',
): Promise<LeaseHold | undefined> {
  const claim = async (): Promise<LeaseHold> => {
    const a = await claimStepForDrive(h.runs, runId, step, {
      definition: def,
      registry: createDefaultRegistry(),
      driver: DRIVE,
    });
    if (a.kind !== 'claimed') throw new Error(`fixture: ${step} not claimed: ${JSON.stringify(a)}`);
    return a.hold;
  };
  const first = await claim();
  if (state === 'running') return first;
  first.close((await h.runs.get(runId)).record);
  if (state === 'below') return undefined;
  const token = (await h.runs.get(runId)).record.claims?.[step]?.token;
  const back = await takeBackStep(h.runs, runId, step, {
    expectToken: token!,
    drivenBy: DRIVE,
  });
  if (back.kind !== 'taken_back') throw new Error(`fixture: not taken back: ${back.kind}`);
  const second = await claim();
  second.close((await h.runs.get(runId)).record);
  return undefined;
}

/** A run of `def`, registered on `h`. */
async function runOf(h: Home, def: WorkflowDefinition): Promise<string> {
  await h.workflows.register(def);
  const { record } = await h.runs.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  return record.id;
}

const STATES = [
  ['below', 'below the cap: the sentence after the reclaim command'],
  ['cap', 'at the cap: today’s words'],
] as const;

// each cell starts the built CLI once or twice: 30 s a cold start, the budget on the block
describe(
  '#729 CW-5c — check 2: each place names `realm agent` below the cap',
  { timeout: 180_000 },
  () => {
    for (const [state, title] of STATES) {
      it(`realm run inspect, ${title}`, async () => {
        const h = await home();
        try {
          const def = wf('cw5c-inspect', { a: agent() });
          const id = await runOf(h, def);
          await killedDrive(h, def, id, 'a', state);
          const r = realm(h, ['run', 'inspect', id]);
          const under = r.out.map((l) => l.trim());
          // (1) red when inspect passes no steps to its held lines (no sentence below the cap), or the
          //     sentence is printed at the cap; (2) prints the screen.
          expect(
            {
              sentence: under.includes(sentence(id)),
              other: namesAgent(r.out) && !under.includes(sentence(id)),
              reclaim: under.some((l) =>
                l.startsWith(`To free it, run: realm run reclaim ${id} --step a`),
              ),
            },
            r.out.join('\n'),
          ).toEqual({ sentence: state === 'below', other: false, reclaim: true });
        } finally {
          await h.cleanup();
        }
      });

      it(`the reclaim dry run, ${title}`, async () => {
        const h = await home();
        try {
          const def = wf('cw5c-dry', { a: agent() });
          const id = await runOf(h, def);
          await killedDrive(h, def, id, 'a', state);
          const r = realm(h, ['run', 'reclaim', id]);
          const under = r.out.map((l) => l.trim());
          // (1) red when the dry run passes no steps (or no definition) to its held lines; (2) prints it.
          expect(
            {
              sentence: under.includes(sentence(id)),
              other: namesAgent(r.out) && !under.includes(sentence(id)),
            },
            r.out.join('\n'),
          ).toEqual({ sentence: state === 'below', other: false });
        } finally {
          await h.cleanup();
        }
      });

      it(`realm run advance with nothing owed, ${title}`, async () => {
        const h = await home();
        try {
          const def = wf('cw5c-advance', { a: agent() });
          const id = await runOf(h, def);
          await killedDrive(h, def, id, 'a', state);
          const r = realm(h, ['run', 'advance', id]);
          const last = r.out.at(-1) ?? '';
          // (1) red when advance's first stop reasons get no steps; (2) prints the screen.
          expect(
            {
              code: r.code,
              ends:
                state === 'below'
                  ? last.endsWith(`--force ${sentence(id)}`)
                  : last.endsWith('--force') && !namesAgent(r.out),
            },
            r.out.join('\n'),
          ).toEqual({ code: 1, ends: true });
        } finally {
          await h.cleanup();
        }
      });

      it(`realm run advance after it ran owed work, ${title}`, async () => {
        const h = await home();
        try {
          const def = wf('cw5c-advance-after', { a: agent(), z: auto() });
          const id = await runOf(h, def);
          await killedDrive(h, def, id, 'a', state);
          const r = realm(h, ['run', 'advance', id]);
          const held = r.out.find((l) => l.includes("'a' was claimed")) ?? '';
          // (1) red when advance's stop reasons after its call get no steps; (2) prints the screen.
          expect(
            {
              ranZ: r.out.some((l) => l.includes('z')),
              ends:
                state === 'below'
                  ? held.endsWith(`--force ${sentence(id)}`)
                  : held.endsWith('--force') && !namesAgent(r.out),
            },
            r.out.join('\n'),
          ).toEqual({ ranZ: true, ends: true });
        } finally {
          await h.cleanup();
        }
      });

      it(`realm run respond, ${title}`, async () => {
        const h = await home();
        try {
          const def = wf('cw5c-respond', {
            confirm: gate(),
            pack: agent(),
            done: auto(['confirm', 'pack']),
          });
          const id = await runOf(h, def);
          // The drive took `pack` before the question opened (a claim is refused while one is open).
          await killedDrive(h, def, id, 'pack', state);
          const opened = await executeStep(h.runs, def, {
            runId: id,
            command: 'confirm',
            input: {},
            dispatcher: async () => ({}),
          });
          const r = realm(h, [
            'run',
            'respond',
            id,
            '--gate',
            opened.gate!.gate_id,
            '--choice',
            'approve',
          ]);
          const last = r.out.at(-1) ?? '';
          // (1) red when respond's in-flight reasons get no steps; (2) prints the screen.
          expect(
            {
              code: r.code,
              ends:
                state === 'below'
                  ? last.endsWith(`--force ${sentence(id)}`)
                  : last.endsWith('--force') && !namesAgent(r.out),
            },
            [...r.out, ...r.err].join('\n'),
          ).toEqual({ code: 0, ends: true });
        } finally {
          await h.cleanup();
        }
      });

      it(`realm run drain's refusal, ${title}`, async () => {
        const h = await home();
        try {
          const def = wf('cw5c-drain', { a: agent() });
          const id = await runOf(h, def);
          await killedDrive(h, def, id, 'a', state);
          const r = realm(h, ['run', 'drain', id]);
          const first = r.out[0] ?? '';
          // (1) red when drain's way on gets no steps; (2) prints the screen.
          expect(
            {
              refusal: first.startsWith(
                `Run '${id}' is not terminal (phase: 'running') — nothing to drain.`,
              ),
              ends:
                state === 'below'
                  ? first.endsWith(`--force ${sentence(id)}`)
                  : first.endsWith('--force') && !namesAgent(r.out),
            },
            r.out.join('\n'),
          ).toEqual({ refusal: true, ends: true });
        } finally {
          await h.cleanup();
        }
      });

      it(`realm run drain --expired after the expiry, ${title}`, async () => {
        const h = await home();
        try {
          const def = wf('cw5c-drain-expired', { decide: gate(true), a: agent() });
          const id = await runOf(h, def);
          // As above: the drive took `a` before the question opened.
          await killedDrive(h, def, id, 'a', state);
          await executeStep(h.runs, def, {
            runId: id,
            command: 'decide',
            input: {},
            dispatcher: async () => ({}),
          });
          await h.clock.advance(1300);
          const r = realm(h, ['run', 'drain', id, '--expired', '--force']);
          const held = r.out.find((l) => l.includes("'a' was claimed")) ?? '';
          // (1) red when drain's way on after `--expired` gets no steps; (2) prints the screen.
          expect(
            {
              enacted: r.out.some((l) => l.startsWith('✓ gate enacted')),
              ends:
                state === 'below'
                  ? held.endsWith(`--force ${sentence(id)}`)
                  : held.endsWith('--force') && !namesAgent(r.out),
            },
            [...r.out, ...r.err].join('\n'),
          ).toEqual({ enacted: true, ends: true });
        } finally {
          await h.cleanup();
        }
      });
    }
  },
);

describe('#729 CW-5c — check 3: the Go-on line', { timeout: 60_000 }, () => {
  /** The Go-on line `realm workflow run` hands the run back with, from the run's own read. */
  async function goOn(h: Home, def: WorkflowDefinition, id: string): Promise<string> {
    const read = await h.runs.get(id);
    const held = heldEntriesOf(
      composeWaysAt(read.record, read.at, {
        definition: def,
        persistsClaims: true,
        lease_facts: read.lease_facts,
      }),
    );
    return goOnLine(
      held,
      id,
      `realm run advance ${id}`,
      PLAIN,
      stepsTakenBack(read.record, def, held),
    );
  }

  it('`w` still running elsewhere, `a` below the cap: the line opens with `realm agent` for `a`', async () => {
    const h = await home();
    const holds: LeaseHold[] = [];
    try {
      const def = wf('cw5c-go-on-1', { w: agent(), a: agent() });
      const id = await runOf(h, def);
      holds.push((await killedDrive(h, def, id, 'w', 'running'))!);
      await killedDrive(h, def, id, 'a', 'below');
      // (1) red when the first part is not printed, or names a step still running elsewhere; (2)
      //     prints the line.
      expect(await goOn(h, def, id)).toBe(
        `  Go on:     let realm agent --run-id ${id} --provider <provider> --model <model> take 'a' back, or once 'w' is no longer in flight and 'a' is freed (realm run reclaim ${id} prints its command), realm run advance ${id}`,
      );
    } finally {
      for (const hold of holds) hold.close();
      await h.cleanup();
    }
  });

  it('`a` below the cap, `b` at the cap: today’s line (realm agent takes `a` back, never `b`)', async () => {
    const h = await home();
    try {
      const def = wf('cw5c-go-on-2', { a: agent(), b: agent() });
      const id = await runOf(h, def);
      await killedDrive(h, def, id, 'a', 'below');
      await killedDrive(h, def, id, 'b', 'cap');
      // (1) red when the first part is built from every step to be freed (it then names `b`, which
      //     only a person can free); (2) prints the line.
      expect(await goOn(h, def, id)).toBe(
        `  Go on:     once 'a', 'b' are freed (realm run reclaim ${id} prints their commands), realm run advance ${id}`,
      );
    } finally {
      await h.cleanup();
    }
  });
});
