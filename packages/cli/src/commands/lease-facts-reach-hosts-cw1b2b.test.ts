// lease-facts-reach-hosts-cw1b2b.test.ts — issue #729, the claim window, unit CW-1b part 2b: the lease
// facts a store returns reach the CLI's judges, one cell per path (part 2's check 1 (a)–(d), (h)).
//   (a) `realm run inspect`, (b) `realm run list --stuck`, (c) `resume` and (d) `realm run reclaim`:
//       another program's claim names a lease that is held, and its deadline has passed. Only the
//       lease branch makes the claim `healthy`: without the fact it reads `not_checked`, so
//       `claim_unknown_age` (the judgement a path that drops the facts gives).
//       (a)–(c) take a store: `InMemoryStore` with the lease double, the lease `live` (the workflow
//       store is a SQLite home's). (d)'s action
//       opens the SQLite home itself, so its lease is taken through the home's own lease port, in this
//       process, and stays held while the command runs.
//   (h) `realm agent`'s and `realm workflow run`'s in-flight watchers: the claim's lease is not held,
//       so the watch's last line says the claim is stale. A `held` lease reads `healthy` and a dropped
//       fact `claim_unknown_age`: neither says stale, so only `not_held` tells the paths apart.
//       `realm agent` takes a store (the lease double's `dead` state); `realm workflow run` opens the
//       SQLite home itself, so its lease is taken through the home's own port, written on the claim,
//       then closed: the file stays and reads `not_held` (CW-1's L5).
//
// `realm workflow run` runs in-process through the real command, with `node:readline/promises` mocked
// (the #447 harness of run-prompt-625.test.ts): each prompt is answered by its own text.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  createDefaultRegistry,
  loadWorkflowFromString,
  type ClaimRecord,
  type LeaseHold,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import { inspectRun } from './inspect.js';
import { listRuns } from './list.js';
import { resumeRun } from './resume.js';
import { reclaimCommand } from './reclaim.js';
import { runCommand, setInFlightWatchForTests } from './run.js';
import { runAgent } from '../agent/run-agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';
import { clearProjectExtensionsCache } from '../extensions/load-project-extensions.js';
import { makeTempHome, runIds, type TempHome } from '../test-support/temp-home.js';

const LEASE = 'lease-cw1b2b-host';
/** A deadline long passed: by its deadline alone, the claim is stale. */
const PAST = '2020-01-02T03:04:05.000Z';
/**
 * #729 CW-3a: the watchers' last line (`inFlightLine`) for a claim whose lease is held — wait for it,
 * then `lease_held`'s words and the command after "To free it anyway" (P2-2's no-command branch is
 * removed). Without the lease fact the claim is judged by its deadline alone (PAST): its
 * deadline-passed words.
 */
const LEASE_HELD =
  "Its program held the claim's lease when it was checked; if that program is still running, the step runs twice.";
const waits = (step: string): string => `'${step}' is held; wait for it. ${LEASE_HELD}`;

/** Another program's claim of a step, naming the lease `id`, its deadline passed. */
const claimNaming = (id: string, step: string): ClaimRecord => ({
  deadline: PAST,
  token: `other-${step}`,
  since: PAST,
  lease: { id },
});

/** Takes one lease through `store`'s own lease port (a fixture: a port that cannot hold throws). */
async function holdLease(store: Pick<RunStore, 'leases'>): Promise<LeaseHold> {
  const taken = await store.leases!.hold();
  if (!('held' in taken))
    throw new Error(`fixture: the home could not hold a lease: ${taken.unavailable}`);
  return taken.held;
}

/** A store whose lease port is the double, with `LEASE` in `state`. */
function leasedStore(state: 'live' | 'dead'): InMemoryStore {
  const double = createLeaseDouble();
  double.set(LEASE, state);
  return new InMemoryStore({ leases: double });
}

const AGENT: WorkflowDefinition = {
  id: 'wf-cw1b2b-agent',
  name: 'cw1b2b agent',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { a: { description: 'A', execution: 'agent', depends_on: [] } },
};

/** A running run whose step `a` another program holds under `LEASE`, past its deadline. */
async function seedHeld(store: InMemoryStore): Promise<RunRecord> {
  const { record: run } = await store.create({
    workflowId: AGENT.id,
    workflowVersion: 1,
    params: {},
  });
  const { record } = await store.update({
    ...run,
    in_progress_steps: ['a'],
    claims: { a: claimNaming(LEASE, 'a') },
  });
  return record;
}

describe('#729 CW-1b part 2b — the lease facts reach the CLI’s judges', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('with a SQLite home of the cell’s own (the one a command that opens its own home opens)', () => {
    let h: TempHome & { readonly root: string };
    let savedHome: string | undefined;
    beforeEach(async () => {
      clearProjectExtensionsCache();
      h = await makeTempHome();
      savedHome = process.env['HOME'];
      // The command's own door opens `$HOME/.realm`: this handle's home (one handle per home).
      process.env['HOME'] = h.root;
    });
    afterEach(async () => {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      await h.cleanup();
    });

    it('(a) realm run inspect: a claim whose lease is held makes no run-health finding, past its deadline', async () => {
      const store = leasedStore('live');
      const run = await seedHeld(store);
      await h.home.workflowStore.register(AGENT);
      const out = await inspectRun(run.id, store, h.home.workflowStore);
      // (1) red when inspect judges its read without the read's facts (the claim then reads
      //     claim_unknown_age: a `stale_claim` finding); (2) prints the run-health lines it printed.
      expect(
        out.split('\n').filter((l) => l.startsWith('Run Health') || l.includes('stale_claim')),
      ).toEqual([]);
    });

    it('(b) realm run list --stuck: a run whose one claim holds a held lease is not stuck', async () => {
      const store = leasedStore('live');
      const run = await seedHeld(store);
      const out = await listRuns(undefined, store, undefined, true);
      // (1) red when the listing judges each row without its snapshot's facts (the run is then listed
      //     with a stale claim); (2) prints the listing.
      expect({ listed: out.includes(run.id), out }).toEqual({ listed: false, out });
    });

    it('(c) resume: a claim whose lease is held refuses resume, even with --force', async () => {
      const def: WorkflowDefinition = {
        ...AGENT,
        steps: { 'step-one': { description: 'One', execution: 'auto' } },
      };
      const store = leasedStore('live');
      const { record: run } = await store.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await store.update({
        ...run,
        run_phase: 'failed',
        failed_steps: ['step-one'],
        terminal_state: true,
        sealed_by: { arm: 'step_failure' },
        in_progress_steps: ['other-step'],
        claims: { 'other-step': claimNaming(LEASE, 'other-step') },
      });
      await h.home.workflowStore.register(def);
      const outcome = await resumeRun(run.id, 'step-one', store, h.home.workflowStore, {
        force: true,
      }).then(
        () => 'resumed',
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      // (1) red when resume judges the claim without the read's facts (claim_unknown_age, which
      //     --force overrides: the run is resumed and the claim released); (2) prints the outcome.
      expect(outcome).toMatch(/^Step 'other-step' has a HEALTHY claim/);
    });

    it('(d) realm run reclaim: a claim whose lease the home holds reads healthy, past its deadline', async () => {
      const store = h.home.runStore;
      const held = await holdLease(store);
      try {
        const { record: run } = await store.create({
          workflowId: AGENT.id,
          workflowVersion: 1,
          params: {},
        });
        await store.update({
          ...run,
          in_progress_steps: ['a'],
          claims: { a: claimNaming(held.id, 'a') },
        });
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        await reclaimCommand.parseAsync([run.id], { from: 'user' });
        const lines = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
        // (1) red when reclaim's dry run judges its read without the read's facts (the claim then
        //     reads claim_unknown_age); (2) prints the claim lines it printed.
        expect(lines.filter((l) => l.startsWith('  • '))).toEqual([
          `  • a: healthy  (deadline: ${PAST})`,
        ]);
        // #729 CW-3a: under a claim whose lease is held, lease_held's words first and the command
        //     after "To free it anyway". (1) red when the held lease is offered no command, or read by
        //     its deadline (the past line); (2) prints its lines.
        const under = lines.filter((l) => l.startsWith('      '));
        expect({
          first: under[0],
          last: under.at(-1)?.startsWith('      To free it anyway, run:'),
        }).toEqual({
          first: `      ${LEASE_HELD}`,
          last: true,
        });
      } finally {
        held.close();
      }
    }, 60_000);

    // #922 P2-2 (MA 2, WO922-P22-MA2-03): the lease held, the watch says to wait (no command); closed
    // (not held), the claim is judged by its deadline: the past line and the command that frees it.
    it.each(['held', 'closed'] as const)(
      '(h) realm workflow run, the lease %s: the watch reads the claim’s lease fact (#922 P2-2)',
      async (lease) => {
        const dir = mkdtempSync(join(tmpdir(), 'realm-cw1b2b-wf-'));
        const savedTTY = process.stdin.isTTY;
        // Without this the non-TTY guard refuses before the loop.
        process.stdin.isTTY = true;
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
          throw new Error('process.exit');
        }) as never);
        const yaml = [
          'id: wf-cw1b2b-watch',
          'name: wf-cw1b2b-watch',
          'version: 1',
          'steps:',
          '  a:',
          '    description: Note a.',
          '    execution: agent',
          '  sleep:',
          '    description: Slow step.',
          '    execution: auto',
          '',
        ].join('\n');
        const def = loadWorkflowFromString(yaml);
        const store = h.home.runStore;
        // At `a`'s prompt, another program has taken `sleep` under a lease it still holds while the
        // command runs (#922 P2-2: the held lease is what the watch reads); closed after the command.
        let held: LeaseHold | undefined;
        let runId = '';
        mocks.question.mockImplementation(async (prompt: string) => {
          if (prompt.startsWith('  Agent output')) {
            runId = (await runIds(store))[0]!;
            const { record } = await store.claimStep(runId, 'sleep', def);
            held = await holdLease(store);
            const { record: named } = await store.update({
              ...record,
              // #729 CW-3a (check 2): a claim with no deadline, as a drive's claim of an agent step
              claims: {
                ...record.claims,
                sleep: { ...claimNaming(held.id, 'sleep'), deadline: null },
              },
            });
            // closed: the claim stays, naming a lease file nothing holds (CW-1's L5)
            if (lease === 'closed') held.close(named);
          }
          return '';
        });
        writeFileSync(join(dir, 'workflow.yaml'), yaml, 'utf8');
        const restore = setInFlightWatchForTests(200);
        let code: number;
        try {
          await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' });
          code = 0;
        } catch (err) {
          if (!(err instanceof Error) || err.message !== 'process.exit') throw err;
          code = Number(exitSpy.mock.calls[0]?.[0]);
        } finally {
          restore();
          held?.close();
          if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
          else process.stdin.isTTY = savedTTY;
          mocks.question.mockReset();
          rmSync(dir, { recursive: true, force: true });
        }
        const errLines = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
        const inFlight = errLines.filter((l) => l.startsWith("• Step 'sleep' has been in flight"));
        // #922 P2-2 (item 4): the hand-back's way on — wait while the lease is held; free it once not.
        const goOn = errLines.flatMap((l) => l.split('\n')).find((l) => l.startsWith('  Go on:'));
        expect(goOn).toBe(
          lease === 'held'
            ? `  Go on:     once 'sleep' is no longer in flight, realm run advance ${runId}`
            : `  Go on:     once 'sleep' is freed (realm run reclaim ${runId} prints its command), realm run advance ${runId}`,
        );
        // (1) red when the watch's last read is judged without its facts (a held lease, with no
        //     deadline, then reads as a claim of unknown age, not as held), or a closed one is still
        //     waited for; (2) prints the in-flight lines and the exit.
        expect({
          lines: inFlight.map((l) => ({
            waits: l.includes(waits('sleep')) && l.includes('To free it anyway, run:'),
            past: l.endsWith(
              `'sleep' was claimed, and no program held the claim's lease when it was checked; no result is recorded for it. It is not declared idempotent, so running it again may repeat its effects. To free it, run: realm run reclaim ${runId} --step sleep --claimed-at ${PAST} --force`,
            ),
          })),
          code,
        }).toEqual({
          lines: [{ waits: lease === 'held', past: lease === 'closed' }],
          code: 1,
        });
      },
      60_000,
    );
  });

  it('(h) realm agent: the watch on a step whose claim’s lease is held says to wait for it, with lease_held’s words and the command after “anyway” (#729 CW-3a)', async () => {
    const store = leasedStore('live');
    const run = await seedHeld(store);
    const provider = new (class extends LlmProvider {
      callStep = vi.fn();
    })();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runAgent(
      {
        store,
        workflowStore: {
          async register() {},
          async get() {
            return AGENT;
          },
          async list() {
            return [AGENT];
          },
        },
        provider,
        registry: createDefaultRegistry(),
      },
      {
        definition: AGENT,
        existingRunId: run.id,
        params: {},
        inFlightPollMs: 10,
        inFlightWatchMs: 50,
      },
    );
    const inFlight = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((l) => l.startsWith("• Step 'a' has been in flight"));
    // (1) red when the watch's last read is judged without its facts (the claim then reads past its
    //     deadline); (2) prints the in-flight lines.
    expect(
      inFlight.map((l) => ({
        waits: l.includes(waits('a')),
        anyway: l.includes('To free it anyway, run: realm run reclaim'),
      })),
    ).toEqual([{ waits: true, anyway: true }]);
  });
});
