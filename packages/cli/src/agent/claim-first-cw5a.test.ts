// claim-first-cw5a.test.ts — #729 CW-5a (prompt feat-729-cw5a-claim-first.md): `realm agent` claims an
// agent step under a lease before its model is called, holds it while the model and tools run, saves
// under it, and closes the hold every time; a drive that stops without saving gives the claim back and
// says so. Checks 1, 2, 4, 5 (G2–G4), 6 (H1), 7 (N-b, a wrapped port), 9 (two drives on one step), 11
// (line (i) when this drive's claim does not land), 12 (one note), and the two refusal stops.
//
// Each cell runs the real `runAgent` on `InMemoryStore` with the lease double as its port, unless it
// says otherwise. `claimStepForDrive` and `takeBackStep` are wrapped (everything else is the real
// module): a cell can replace the claim's answer, or act just after a take-back.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it: (1) the
// change that turns it red; (2) what it prints when it fails.
import { describe, it, expect, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  /**
   * Runs at each claim (its number, from 1): its answer replaces the claim's, or `undefined` for the
   * real one (after anything it did).
   */
  claimAnswer: undefined as undefined | ((call: number) => unknown),
  claimCalls: 0,
  /** Runs after `takeBackStep` answered `taken_back`. */
  afterTakeBack: undefined as undefined | (() => Promise<void>),
  /** Runs after the real claim answered. */
  afterClaim: undefined as undefined | ((answer: { kind: string }) => void),
}));
vi.mock('@sensigo/realm', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sensigo/realm')>();
  return {
    ...real,
    claimStepForDrive: async (...args: Parameters<typeof real.claimStepForDrive>) => {
      hooks.claimCalls += 1;
      const replaced = await hooks.claimAnswer?.(hooks.claimCalls);
      if (replaced !== undefined) return replaced;
      const answer = await real.claimStepForDrive(...args);
      hooks.afterClaim?.(answer);
      return answer;
    },
    takeBackStep: async (...args: Parameters<typeof real.takeBackStep>) => {
      const answer = await real.takeBackStep(...args);
      if (answer.kind === 'taken_back') await hooks.afterTakeBack?.();
      return answer;
    },
  };
});

import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  advanceRun,
  claimStepForDrive,
  createDefaultRegistry,
  executeStep,
  reclaimStep,
  takeBackStep,
  type Attributed,
  type LeasePort,
  type PendingGate,
  type RunRecord,
  type StepDefinition,
  type WorkflowDefinition,
  submitHumanResponse,
} from '@sensigo/realm';
import { InMemoryStore, createLeaseDouble, type LeaseDouble } from '@sensigo/realm-testing';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';
import { writerTestSeams } from '../output/writer.js';

const registry = createDefaultRegistry();
const shown = (t: string): string => writerTestSeams.visible(t);
const prog = (by: string): Attributed => ({ by, by_source: 'stated', channel: 'agent' });
const A = prog('drive-a');
const B = prog('drive-b');
const C = prog('drive-c');
const words = (who: Attributed): string => `${who.by} (as stated, via agent)`;

const agent = (over: Partial<StepDefinition> = {}): StepDefinition =>
  ({
    description: 'An agent step.',
    execution: 'agent',
    depends_on: [],
    ...over,
  }) as StepDefinition;
const gated = (over: Partial<StepDefinition> = {}): StepDefinition =>
  agent({ trust: 'human_confirmed', gate: { choices: ['ok', 'no'] }, ...over } as never);
const wf = (id: string, steps: Record<string, StepDefinition>): WorkflowDefinition =>
  ({ id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps }) as never;
const S = wf('claim-first-cw5a', { s: agent() });

interface Fixture {
  store: InMemoryStore;
  double: LeaseDouble;
  runId: string;
  def: WorkflowDefinition;
}
async function fixture(def: WorkflowDefinition = S, store?: InMemoryStore): Promise<Fixture> {
  const double = createLeaseDouble();
  const s = store ?? new InMemoryStore({ leases: double });
  const { record } = await s.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  hooks.claimAnswer = undefined;
  hooks.claimCalls = 0;
  hooks.afterTakeBack = undefined;
  hooks.afterClaim = undefined;
  return { store: s, double: (s.leases as LeaseDouble | null) ?? double, runId: record.id, def };
}
const record = async (f: Fixture): Promise<RunRecord> => (await f.store.get(f.runId)).record;

/** What the model is told and answers: `answer(call, prompt)` (throw to fail the call). */
type Answer = (call: number, prompt: string) => Promise<Record<string, unknown>>;

/** One `realm agent` drive of the fixture's run, under `driver` (B by default). */
async function drive(
  f: Fixture,
  o: {
    driver?: Attributed;
    answer?: Answer;
    gateHandler?: (runId: string, gate: PendingGate) => Promise<void>;
    watchMs?: number;
    lines?: string[];
  } = {},
): Promise<{ result: string; calls: number; prompts: string[]; lines: string[] }> {
  const lines = o.lines ?? [];
  const prompts: string[] = [];
  let calls = 0;
  const provider = new (class extends LlmProvider {
    async callStep(prompt: string): Promise<Record<string, unknown>> {
      calls += 1;
      prompts.push(prompt);
      return o.answer !== undefined ? o.answer(calls, prompt) : { ok: true };
    }
  })();
  const result = await runAgent(
    {
      store: f.store,
      workflowStore: {
        async register() {},
        async get() {
          return f.def;
        },
        async list() {
          return [f.def];
        },
      },
      provider,
      registry,
      driver: o.driver ?? B,
      ...(o.gateHandler !== undefined ? { gateHandler: o.gateHandler } : {}),
    },
    {
      definition: f.def,
      existingRunId: f.runId,
      params: {},
      inFlightPollMs: 10,
      inFlightWatchMs: o.watchMs ?? 300,
      pollIntervalMs: 10,
    },
  );
  return { result, calls, prompts, lines };
}

/** Captures the drives' lines (stdout plain, stderr marked) while `body` runs. */
async function captured<T>(
  body: (lines: string[]) => Promise<T>,
): Promise<T & { lines: string[] }> {
  const lines: string[] = [];
  const keep =
    (prefix: string) =>
    (...a: unknown[]): void => {
      lines.push(prefix + shown(a.map(String).join(' ')));
      if (lines.length > 400) throw new Error('runaway drive');
    };
  vi.spyOn(console, 'log').mockImplementation(keep(''));
  vi.spyOn(console, 'error').mockImplementation(keep('err: '));
  vi.spyOn(console, 'warn').mockImplementation(keep('warn: '));
  try {
    return { ...(await body(lines)), lines };
  } finally {
    vi.restoreAllMocks();
  }
}

const bullets = (lines: string[]): string[] =>
  lines.map((l) => l.replace(/^err: \n?/, 'err: ')).filter((l) => /^(err: )?• /.test(l));
const GAVE_BACK = (step: string, why: string): string =>
  `• Step '${step}': this drive let its claim go (${why}), so the step can run again.`;

describe('#729 CW-5a — check 1, check 2: the claim comes first, and the model gets that step’s brief', () => {
  it('check 1: while the model works the record holds this drive’s claim under its lease; the save is under it, and the hold closes', async () => {
    const f = await fixture();
    const seen: Array<Record<string, unknown>> = [];
    const d = await captured(() =>
      drive(f, {
        answer: async () => {
          const r = await record(f);
          const claim = r.claims?.['s'];
          seen.push({
            inFlight: r.in_progress_steps,
            holder: claim?.holder,
            lease: claim?.lease !== undefined ? f.double.state(claim.lease.id) : undefined,
          });
          return { ok: true };
        },
      }),
    );
    const run = await record(f);
    // (1) red when the drive claims at its save (the record names no claim during the call), saves
    //     under another claim, or leaves the hold open (the lease not removed); (2) prints the record.
    expect(
      {
        seen,
        result: d.result,
        completed: run.completed_steps,
        claim: run.claims?.['s'],
        evidence: run.evidence.map((e) => [e.step_id, e.status, e.driven_by]),
        lease: f.double.state('lease-double-1'),
      },
      d.lines.join('\n'),
    ).toEqual({
      seen: [{ inFlight: ['s'], holder: B, lease: 'live' }],
      result: 'completed',
      completed: ['s'],
      claim: undefined,
      evidence: [['s', 'success', B]],
      lease: 'removed',
    });
  });

  it('check 2: of two ready steps, the model gets the brief of the one claimed — never the other’s', async () => {
    const f = await fixture(
      wf('claim-first-brief', {
        a: agent({ description: 'Write the A part.' }),
        b: agent({ description: 'Write the B part.' }),
      }),
    );
    const d = await captured(() => drive(f));
    // (1) red when the brief is composed from a read where the claimed step reads as held (the model
    //     then gets the other step's brief); (2) prints the prompts.
    expect({ result: d.result, prompts: d.prompts.map((p) => p.split('\n')[0]) }).toEqual({
      result: 'completed',
      prompts: ['Write the A part.', 'Write the B part.'],
    });
  });
});

describe('#729 CW-5a — check 4: no give-back between repair attempts', () => {
  it('a repairable output rejection keeps the claim; the next attempt saves under it', async () => {
    const f = await fixture(
      wf('claim-first-repair', {
        s: agent({
          output_schema: {
            type: 'object',
            required: ['category'],
            properties: { category: { type: 'string' } },
          },
        } as never),
      }),
    );
    const leases: Array<string | undefined> = [];
    const d = await captured(() =>
      drive(f, {
        answer: async (call) => {
          leases.push((await record(f)).claims?.['s']?.lease?.id);
          return call === 1 ? { nope: 1 } : { category: 'x' };
        },
      }),
    );
    const run = await record(f);
    // (1) red when the drive gives the claim back after the rejected reply (the second attempt then
    //     runs under no claim, or another lease, and its save is refused), or the repair is lost;
    //     (2) prints the leases seen, the lines and the record.
    expect(
      {
        result: d.result,
        calls: d.calls,
        leases,
        gaveBack: d.lines.filter((l) => l.includes('let its claim go')),
        completed: run.completed_steps,
      },
      d.lines.join('\n'),
    ).toEqual({
      result: 'completed',
      calls: 2,
      leases: ['lease-double-1', 'lease-double-1'],
      gaveBack: [],
      completed: ['s'],
    });
  });
});

describe('#729 CW-5a — check 5: G2–G4, the give-back by the record', () => {
  it('G2: the model call fails (the drive’s snapshot is from before its claim) — the drive-failure entry, then the give-back; the hold closes after it', async () => {
    const f = await fixture();
    const order: string[] = [];
    const realSettle = f.store.settleStep!.bind(f.store);
    f.store.settleStep = async (...a: Parameters<NonNullable<InMemoryStore['settleStep']>>) => {
      if (a[1].kind === 'release_step') order.push('give-back');
      return realSettle(...a);
    };
    const realUpdate = f.store.update.bind(f.store);
    f.store.update = async (...a: Parameters<InMemoryStore['update']>) => {
      if ((a[0].drive_failures?.entries.length ?? 0) > 0 && !order.includes('drive failure'))
        order.push('drive failure');
      return realUpdate(...a);
    };
    const leasesAtClose: Array<string> = [];
    const realHold = f.double.hold.bind(f.double);
    f.double.hold = async () => {
      const made = await realHold();
      if (!('held' in made)) return made;
      const held = made.held;
      return {
        held: {
          id: held.id,
          close: (newest?: RunRecord) => {
            leasesAtClose.push(newest?.claims?.['s']?.lease?.id ?? 'none named');
            order.push('close');
            held.close(newest);
          },
        },
      };
    };
    const d = await captured(() =>
      drive(f, {
        answer: async () => {
          throw new Error('the provider is down');
        },
      }),
    );
    const run = await record(f);
    // (1) red when the drive gives back from its own pre-claim snapshot (it then closes the hold
    //     with the claim still named, or gives nothing back), writes the drive-failure entry after
    //     the give-back, or prints no give-back line; (2) prints the order, the lines and the record.
    expect(
      {
        result: d.result,
        order,
        leasesAtClose,
        line: bullets(d.lines),
        claim: run.claims?.['s'],
        inFlight: run.in_progress_steps,
        failures: run.drive_failures?.entries.length,
      },
      d.lines.join('\n'),
    ).toEqual({
      result: 'failed',
      order: ['drive failure', 'give-back', 'close'],
      leasesAtClose: ['none named'],
      line: [GAVE_BACK('s', 'its step failed')],
      claim: undefined,
      inFlight: [],
      failures: 1,
    });
  });

  it('G2: another program claims the step at this drive’s claim: the drive closes its own hold and asks no model', async () => {
    const f = await fixture();
    let other: Awaited<ReturnType<typeof claimStepForDrive>> | undefined;
    hooks.claimAnswer = async (call) => {
      if (call !== 1) return undefined;
      other = await claimStepForDrive(f.store, f.runId, 's', {
        definition: f.def,
        registry,
        driver: A,
      });
      return undefined;
    };
    const d = await captured(() => drive(f, { watchMs: 50 }));
    if (other?.kind !== 'claimed') throw new Error(`fixture: ${JSON.stringify(other)}`);
    // (1) red when the refused claim keeps its hold open (its lease stays live) or the model is
    //     asked; (2) prints the leases and the lines.
    expect(
      {
        calls: d.calls,
        a: f.double.state('lease-double-1'),
        b: f.double.state('lease-double-2'),
      },
      d.lines.join('\n'),
    ).toEqual({ calls: 0, a: 'live', b: 'removed' });
    other.hold.close();
  });

  it('G3 (gate_mismatch): another step’s gate opens during the held call and the step’s own answer opens a gate — given back at once, the line names no holder, then the drive waits at the gate', async () => {
    // `b` first, so the drive picks it; `a` is answered by another program while b's model works.
    const f = await fixture(wf('claim-first-g3', { b: gated(), a: gated() }));
    let opened = false;
    const answered: string[] = [];
    const d = await captured(() =>
      drive(f, {
        answer: async (call) => {
          if (call === 1 && !opened) {
            opened = true;
            const r = await executeStep(f.store, f.def, {
              runId: f.runId,
              command: 'a',
              input: { by: 'other' },
              dispatcher: async (_s, input) => ({ ...input }),
              driver: A,
            });
            if (r.status !== 'confirm_required') throw new Error(`fixture: ${JSON.stringify(r)}`);
          }
          return { by: 'b' };
        },
        gateHandler: async (runId, gate) => {
          answered.push(gate.step_name);
          await submitHumanResponse(f.store, f.def, {
            runId,
            gateId: gate.gate_id,
            choice: 'ok',
          });
        },
      }),
    );
    const run = await record(f);
    const gaveBackAt = d.lines.indexOf(GAVE_BACK('b', "the engine refused the step's result"));
    // (1) red when the reply is judged on its own record, where the claim is still this drive's (the
    //     line then names this drive as b's holder and the drive waits on itself), when the drive
    //     does not give b back, or b is taken back automatically; (2) prints the lines and record.
    expect(
      {
        gaveBack: gaveBackAt >= 0,
        selfHolder: d.lines.filter((l) => l.includes(`taken by ${words(B)}`)),
        firstLease: f.double.state('lease-double-1'),
        takeBacks: run.evidence.filter((e) => e.output_summary?.['reason'] === 'lease_not_held')
          .length,
        answered,
        result: d.result,
        completed: [...run.completed_steps].sort(),
      },
      d.lines.join('\n'),
    ).toEqual({
      gaveBack: true,
      selfHolder: [],
      firstLease: 'removed',
      takeBacks: 0,
      answered: ['a', 'b'],
      result: 'completed',
      completed: ['a', 'b'],
    });
  });

  it('G4: a give-back that throws below the cap — the line, the lease kept with no program holding it, and the next drive takes the step back once', async () => {
    const f = await fixture();
    const realSettle = f.store.settleStep!.bind(f.store);
    let thrown = false;
    f.store.settleStep = async (...a: Parameters<NonNullable<InMemoryStore['settleStep']>>) => {
      if (a[1].kind === 'release_step' && !thrown) {
        thrown = true;
        throw new Error('the store write failed');
      }
      return realSettle(...a);
    };
    const d = await captured(() =>
      drive(f, {
        answer: async () => {
          throw new Error('the provider is down');
        },
      }),
    );
    const kept = f.double.state('lease-double-1');
    f.store.settleStep = realSettle;
    const next = await captured(() => drive(f, { driver: C }));
    const run = await record(f);
    // (1) red when a thrown give-back deletes the lease file (the step then reads absent and no drive
    //     can take it back), prints no line, or the next drive cannot take the step back; (2) prints
    //     both drives' lines and the take-back entries.
    expect(
      {
        line: bullets(d.lines),
        kept,
        next: next.result,
        takeBacks: run.evidence
          .filter((e) => e.output_summary?.['reason'] === 'lease_not_held')
          .map((e) => e.driven_by),
      },
      [...d.lines, '---', ...next.lines].join('\n'),
    ).toEqual({
      line: [
        "• Step 's': this drive could not let its claim go (the store failed); the next drive of this run can take the step back, once.",
      ],
      kept: 'closed_kept',
      next: 'completed',
      takeBacks: [C],
    });
  });

  it('G4: a give-back that throws at the cap — a person decides, with what frees it', async () => {
    const f = await fixture();
    // The step was taken back automatically once before this drive's claim.
    const first = await claimStepForDrive(f.store, f.runId, 's', {
      definition: f.def,
      registry,
      driver: A,
    });
    if (first.kind !== 'claimed') throw new Error(`fixture: ${JSON.stringify(first)}`);
    f.double.set(first.hold.id, 'dead');
    const token = (await record(f)).claims!['s']!.token!;
    const back = await takeBackStep(f.store, f.runId, 's', { expectToken: token, drivenBy: C });
    if (back.kind !== 'taken_back') throw new Error(`fixture: ${JSON.stringify(back)}`);
    const realSettle = f.store.settleStep!.bind(f.store);
    f.store.settleStep = async (...a: Parameters<NonNullable<InMemoryStore['settleStep']>>) => {
      if (a[1].kind === 'release_step') throw new Error('the store write failed');
      return realSettle(...a);
    };
    const d = await captured(() =>
      drive(f, {
        answer: async () => {
          throw new Error('the provider is down');
        },
      }),
    );
    const since = (await record(f)).claims?.['s']?.since;
    // (1) red when the at-cap form names the next drive's take-back (none is left), or drops the
    //     freeing parts; (2) prints the lines.
    expect(bullets(d.lines), d.lines.join('\n')).toEqual([
      `• Step 's': this drive could not let its claim go (the store failed), and it was already taken back automatically once, so a person decides. It is not declared idempotent, so running it again may repeat its effects. To free it, run: realm run reclaim ${f.runId} --step s --claimed-at ${since} --force`,
    ]);
  });
});

describe('#729 CW-5a — the give-back’s other forms', () => {
  it('a store read that fails after the claim (a throw): the drive-failure entry, then “this drive stopped on an error”', async () => {
    const f = await fixture();
    // The first read after the claim (the attempt's own) fails; the give-back's read works.
    let failNext = false;
    hooks.afterClaim = (answer) => {
      if (answer.kind === 'claimed') failNext = true;
    };
    const realGet = f.store.get.bind(f.store);
    f.store.get = async (id: string) => {
      if (failNext) {
        failNext = false;
        throw new Error('the store read failed');
      }
      return realGet(id);
    };
    const d = await captured(async () =>
      drive(f).then(
        (r) => r,
        (err: unknown) => ({
          result: `threw: ${(err as Error).message}`,
          calls: 0,
          prompts: [],
          lines: [],
        }),
      ),
    );
    f.store.get = realGet;
    const run = await record(f);
    // (1) red when a throw gives nothing back (the claim stays, held by no program), writes the
    //     drive-failure entry after it, or names another cause; (2) prints the lines and record.
    expect(
      {
        result: d.result,
        line: bullets(d.lines),
        claim: run.claims?.['s'],
        failures: run.drive_failures?.entries.length,
      },
      d.lines.join('\n'),
    ).toEqual({
      result: 'threw: the store read failed',
      line: [GAVE_BACK('s', 'this drive stopped on an error')],
      claim: undefined,
      failures: 1,
    });
  });

  it('a person reclaimed the claim during the model call, and the call then failed: “its claim was removed while this drive held it (a reclaim)”', async () => {
    const f = await fixture();
    const d = await captured(() =>
      drive(f, {
        answer: async () => {
          const since = (await record(f)).claims?.['s']?.since;
          await reclaimStep(f.store, f.runId, 's', {
            definition: f.def,
            force: true,
            ...(since !== undefined ? { claimed_at: since } : {}),
          });
          throw new Error('the provider is down');
        },
      }),
    );
    // (1) red when the drive says it let the claim go (it did not: a person removed it), or names
    //     no reclaim; (2) prints the lines.
    expect(bullets(d.lines), d.lines.join('\n')).toEqual([
      "• Step 's': its claim was removed while this drive held it (a reclaim).",
    ]);
  });

  it('a person reclaims the claim at the moment the drive gives it back: “its claim was removed while this drive held it”', async () => {
    const f = await fixture();
    const realSettle = f.store.settleStep!.bind(f.store);
    let raced = false;
    f.store.settleStep = async (...a: Parameters<NonNullable<InMemoryStore['settleStep']>>) => {
      if (a[1].kind === 'release_step' && !raced) {
        raced = true;
        const since = (await record(f)).claims?.['s']?.since;
        await reclaimStep(f.store, f.runId, 's', {
          definition: f.def,
          force: true,
          ...(since !== undefined ? { claimed_at: since } : {}),
        });
      }
      return realSettle(...a);
    };
    const d = await captured(() =>
      drive(f, {
        answer: async () => {
          throw new Error('the provider is down');
        },
      }),
    );
    // (1) red when a release the store refused is said as this drive's; (2) prints the lines.
    expect({ raced, lines: bullets(d.lines) }, d.lines.join('\n')).toEqual({
      raced: true,
      lines: ["• Step 's': its claim was removed while this drive held it."],
    });
  });
});

describe('#729 CW-5a — check 6: H1, a sibling’s gate during the held call', () => {
  it('another step’s gate opens while the model works: the held step is saved with its answer, one call, no give-back', async () => {
    const f = await fixture(wf('claim-first-h1', { b: agent(), a: gated() }));
    let opened = false;
    const d = await captured(() =>
      drive(f, {
        answer: async (call) => {
          if (call === 1 && !opened) {
            opened = true;
            const r = await executeStep(f.store, f.def, {
              runId: f.runId,
              command: 'a',
              input: { by: 'other' },
              dispatcher: async (_s, input) => ({ ...input }),
              driver: A,
            });
            if (r.status !== 'confirm_required') throw new Error(`fixture: ${JSON.stringify(r)}`);
          }
          return { by: 'b' };
        },
        gateHandler: async (runId, gate) => {
          await submitHumanResponse(f.store, f.def, { runId, gateId: gate.gate_id, choice: 'ok' });
        },
      }),
    );
    const run = await record(f);
    // (1) red when a question open on another step refuses the held save (the paid answer is then
    //     lost and asked for again); (2) prints the lines and the record.
    expect(
      {
        calls: d.calls,
        gaveBack: d.lines.filter((l) => l.includes('let its claim go')),
        b: run.evidence.filter((e) => e.step_id === 'b').map((e) => [e.status, e.driven_by]),
        result: d.result,
      },
      d.lines.join('\n'),
    ).toEqual({ calls: 1, gaveBack: [], b: [['success', B]], result: 'completed' });
  });
});

describe('#729 CW-5a — check 7: N-b, the lease cannot be taken', () => {
  it('a port whose hold() is refused: the line with no folder, no claim, no model call, the drive stops', async () => {
    const port: LeasePort = {
      hold: async () => ({ unavailable: 'permission' }),
      probe: async () => ({ state: 'absent', basis: 'kernel_lock' }),
    };
    const f = await fixture(S, new InMemoryStore({ leases: port }));
    const d = await captured(() => drive(f));
    const run = await record(f);
    // (1) red when the drive calls the model without a claim, claims with no lease, or names a folder
    //     it does not know; (2) prints the lines and the record.
    expect(
      {
        result: d.result,
        calls: d.calls,
        lines: bullets(d.lines),
        claim: run.claims?.['s'],
      },
      d.lines.join('\n'),
    ).toEqual({
      result: 'failed',
      calls: 0,
      lines: [
        "err: • Step 's' was not started: this drive could not take a lease (this program cannot write there); nothing was claimed and the model was not called.",
      ],
      claim: undefined,
    });
  });
});

describe('#729 CW-5a — the claim’s refusals', () => {
  it('refused twice on an unchanged record: the drive stops with the code, asking no model', async () => {
    const f = await fixture();
    hooks.claimAnswer = () => ({ kind: 'refused', code: 'refused_before_claim' });
    const d = await captured(() => drive(f));
    // (1) red when the drive loops on the refusal, or asks the model; (2) prints the lines.
    expect(
      { result: d.result, calls: d.calls, claims: hooks.claimCalls, stop: d.lines.at(-1) },
      d.lines.join('\n'),
    ).toEqual({
      result: 'failed',
      calls: 0,
      claims: 2,
      stop: "err: \n✗ The drive stops: 's' cannot run (refused_before_claim).",
    });
  });

  it('an answer this drive does not know: it stops, naming it', async () => {
    const f = await fixture();
    hooks.claimAnswer = () => ({ kind: 'over_limit' });
    const d = await captured(() => drive(f));
    // (1) red when an unknown answer is taken for a claim (the model is asked) or loops; (2) prints
    //     the lines.
    expect({ result: d.result, calls: d.calls, stop: d.lines.at(-1) }, d.lines.join('\n')).toEqual({
      result: 'failed',
      calls: 0,
      stop: "err: \n✗ The drive stops: claiming 's' answered 'over_limit', which this drive does not know.",
    });
  });
});

describe('#729 CW-5a — check 9: two realm agents on one step', () => {
  /** Drive A, whose model waits for `release` (the one it gets), and a promise of its first call. */
  function slowA(f: Fixture, outcome: 'complete' | 'fail') {
    let started!: () => void;
    const inCall = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const done = drive(f, {
      driver: A,
      answer: async () => {
        started();
        await released;
        if (outcome === 'fail') throw new Error("A's provider is down");
        return { by: 'a' };
      },
    });
    return { inCall, release, done };
  }

  it('A holds S: B waits on it and asks no model; when A completes S, B makes no call for S and goes on to the run’s end', async () => {
    const f = await fixture();
    const run = await captured(async (lines) => {
      const a = slowA(f, 'complete');
      await a.inCall;
      let bCalls = 0;
      const b = drive(f, {
        lines,
        watchMs: 5_000,
        answer: async () => {
          bCalls += 1;
          return { by: 'b' };
        },
      });
      // B says it waits on A's claim; A then completes S.
      for (let i = 0; i < 200 && !lines.some((l) => l.includes('Waiting up to')); i++)
        await new Promise((r) => setTimeout(r, 10));
      const callsWhileHeld = bCalls;
      a.release();
      const [ra, rb] = await Promise.all([a.done, b]);
      return { ra: ra.result, rb: rb.result, callsWhileHeld, bCalls };
    });
    const r = await record(f);
    // (1) red when the drives claim at their save (both then call the model for S); (2) prints the
    //     lines and who ran S.
    expect(
      {
        callsWhileHeld: run.callsWhileHeld,
        waiting: run.lines.filter((l) => l.includes('Waiting up to')).length > 0,
        s: r.evidence.filter((e) => e.step_id === 's').map((e) => e.driven_by),
        bCalls: run.bCalls,
        rb: run.rb,
        bResult: run.lines.filter((l) => l.includes('not by this drive')),
      },
      run.lines.join('\n'),
    ).toEqual({
      callsWhileHeld: 0,
      waiting: true,
      s: [A],
      bCalls: 0,
      rb: 'completed',
      bResult: [`\nResult (s) — given by ${words(A)}, not by this drive:`],
    });
  });

  it('A holds S and its model call fails: A gives S back, and B claims S and runs it (one call by B)', async () => {
    const f = await fixture();
    const run = await captured(async (lines) => {
      const a = slowA(f, 'fail');
      await a.inCall;
      let bCalls = 0;
      const b = drive(f, {
        lines,
        watchMs: 5_000,
        answer: async () => {
          bCalls += 1;
          return { by: 'b' };
        },
      });
      for (let i = 0; i < 200 && !lines.some((l) => l.includes('Waiting up to')); i++)
        await new Promise((r) => setTimeout(r, 10));
      const callsWhileHeld = bCalls;
      a.release();
      const [ra, rb] = await Promise.all([a.done, b]);
      return { ra: ra.result, rb: rb.result, callsWhileHeld, bCalls };
    });
    const r = await record(f);
    // (1) red when A keeps S after its failure (B then waits it out), or B calls the model while A
    //     holds S; (2) prints the lines and who ran S.
    expect(
      {
        callsWhileHeld: run.callsWhileHeld,
        ra: run.ra,
        rb: run.rb,
        bCalls: run.bCalls,
        s: r.evidence.filter((e) => e.step_id === 's').map((e) => [e.status, e.driven_by]),
        gaveBack: run.lines.filter((l) => l === GAVE_BACK('s', 'its step failed')).length,
      },
      run.lines.join('\n'),
    ).toEqual({
      callsWhileHeld: 0,
      ra: 'failed',
      rb: 'completed',
      bCalls: 1,
      s: [['success', B]],
      gaveBack: 1,
    });
  });
});

describe('#729 CW-5a — check 11: line (i) when this drive’s claim does not land', () => {
  /** A's claim of `s`, its lease then held by no program; its stamp. */
  async function deadA(f: Fixture): Promise<string> {
    const a = await claimStepForDrive(f.store, f.runId, 's', {
      definition: f.def,
      registry,
      driver: A,
    });
    if (a.kind !== 'claimed') throw new Error(`fixture: ${JSON.stringify(a)}`);
    f.double.set(a.hold.id, 'dead');
    return (await record(f)).claims!['s']!.since!;
  }
  /** C claims `s` (through the real entry); its stamp and its hold. */
  async function cClaims(f: Fixture) {
    const c = await claimStepForDrive(f.store, f.runId, 's', {
      definition: f.def,
      registry,
      driver: C,
    });
    if (c.kind !== 'claimed') throw new Error(`fixture: ${JSON.stringify(c)}`);
    return { since: (await record(f)).claims!['s']!.since!, hold: c.hold };
  }
  const tookBack = (since: string): string =>
    `• Step 's' was taken by ${words(A)} at ${since}; no program held the claim's lease when it was checked, so this drive took it back (this step's one automatic take-back until a person reclaims it)`;

  it('another program claims the step at this drive’s own claim, after its take-back: the not-landed line, then the drive waits on that claim', async () => {
    const f = await fixture();
    const aSince = await deadA(f);
    let c: Awaited<ReturnType<typeof cClaims>> | undefined;
    let tookIt = false;
    hooks.afterTakeBack = async () => {
      tookIt = true;
    };
    // This drive's first claim comes after its take-back; C's lands first.
    let acting = false;
    hooks.claimAnswer = async () => {
      // C's own claim comes through this hook too: it acts once.
      if (tookIt && !acting) {
        acting = true;
        c = await cClaims(f);
      }
      return undefined;
    };
    const d = await captured(() => drive(f, { watchMs: 50 }));
    c?.hold.close();
    // (1) red when line (i) prints at the take-back (the drive then says it runs the step, and does
    //     not), or the drive does not wait on the new claim; (2) prints the lines.
    expect({ calls: d.calls, lines: bullets(d.lines).slice(0, 2) }, d.lines.join('\n')).toEqual({
      calls: 0,
      lines: [
        `${tookBack(aSince)}, but it is now taken by ${words(C)} at ${c?.since}; not run here.`,
        `• Step 's' was taken by ${words(C)} at ${c?.since}; its program held the claim's lease when it was checked. Waiting up to 0s for the run's record to change.`,
      ],
    });
  });

  it('another program claims the step before this drive picks it again: the drive waits on it, and stops with the take-back line ending "it was not run here"', async () => {
    const f = await fixture();
    const aSince = await deadA(f);
    let c: Awaited<ReturnType<typeof cClaims>> | undefined;
    hooks.afterTakeBack = async () => {
      c = await cClaims(f);
    };
    const d = await captured(() => drive(f, { watchMs: 50 }));
    c?.hold.close();
    // (1) red when line (i) prints at the take-back, or is never said; (2) prints the lines.
    expect(
      { calls: d.calls, first: bullets(d.lines)[0], last: d.lines.at(-1) },
      d.lines.join('\n'),
    ).toEqual({
      calls: 0,
      first: `• Step 's' was taken by ${words(C)} at ${c?.since}; its program held the claim's lease when it was checked. Waiting up to 0s for the run's record to change.`,
      last: `${tookBack(aSince)}; it was not run here.`,
    });
  });
});

describe('#729 CW-5a — check 12: the run’s ending is said once', () => {
  // `s` this drive's; `p` another program's; `f`, after `p`, a handler that aborts the run — so the
  // run ends while this drive holds `s`, with `s`'s claim still on the record (an end does not clear
  // another step's claim).
  const ENDS = wf('claim-first-ends', {
    s: agent(),
    p: agent(),
    f: { description: 'f', execution: 'auto', depends_on: ['p'], handler: 'ends' } as never,
  });
  const ending = new ExtensionRegistry();
  ending.register('handler', 'ends', {
    id: 'ends',
    execute: async () => ({ data: {}, abort: { message: 'the other branch ended the run' } }),
  } as never);
  async function endTheRun(f: Fixture): Promise<void> {
    const r = await executeStep(f.store, f.def, {
      runId: f.runId,
      command: 'p',
      input: {},
      dispatcher: async () => ({}),
      driver: A,
    });
    if (r.status !== 'ok') throw new Error(`fixture: ${JSON.stringify(r)}`);
    await advanceRun(f.store, f.def, { runId: f.runId, registry: ending });
    const run = await record(f);
    if (run.terminal_state !== true || run.claims?.['s']?.lease === undefined)
      throw new Error(`fixture: the run did not end with s held: ${JSON.stringify(run.claims)}`);
  }

  it('the run ends while the model works: the not-recorded line, no give-back line, the run’s end once', async () => {
    const f = await fixture(ENDS);
    const d = await captured(() =>
      drive(f, {
        answer: async () => {
          await endTheRun(f);
          return { by: 'b' };
        },
      }),
    );
    // (1) red when a give-back line is printed for the ended run, or the ending is said twice;
    //     (2) prints the lines.
    expect(
      {
        ended: d.lines.filter((l) => l.includes('the run ended')),
        gaveBack: d.lines.filter((l) => l.includes('claim go') || l.includes('held it.')),
        phase: d.lines.filter((l) => l.includes('Run ended in phase')).length,
      },
      d.lines.join('\n'),
    ).toEqual({
      ended: [
        "• Step 's' was not run: the run ended (aborted) before this drive's answer reached it; the answer was not recorded.",
      ],
      gaveBack: [],
      phase: 1,
    });
  });

  it('the run ends, then the model call fails (releaseDriveClaim answers run_terminal): the ended-while-held line, once, and no give-back line', async () => {
    const f = await fixture(ENDS);
    const d = await captured(() =>
      drive(f, {
        answer: async () => {
          await endTheRun(f);
          throw new Error('the provider is down');
        },
      }),
    );
    // (1) red when `run_terminal` prints a give-back line, or the ending is said twice or not at all;
    //     (2) prints the lines.
    expect(
      {
        ended: d.lines.filter((l) => l.includes('the run ended')),
        gaveBack: d.lines.filter((l) => l.includes('claim go')),
      },
      d.lines.join('\n'),
    ).toEqual({
      ended: ["• Step 's' was not run: the run ended (aborted) while this drive held it."],
      gaveBack: [],
    });
  });
});
