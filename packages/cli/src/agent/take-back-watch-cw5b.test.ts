// take-back-watch-cw5b.test.ts — #729 CW-5b (prompt feat-729-cw5b-watcher-take-back.md): `realm agent`'s
// in-flight watch takes back, once, an agent step whose claim's lease no program holds, and says so;
// it takes nothing back otherwise. Checks W1–W6 and 7.
//
// Each cell runs the real `runAgent` on `InMemoryStore` with the lease double as its port. The other
// program takes the step through `claimStepForDrive`, as a drive takes it; a lease the double reads
// `dead` is one whose program ended without closing it (killed mid-step), which a probe reads not
// held. `takeBackStep` is wrapped (everything else is the real module): a cell's hook acts between the
// watch's read and the function's own read, and the function's answers are kept.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it: (1) the
// change that turns it red; (2) what it prints when it fails.
import { describe, it, expect, vi } from 'vitest';

const tb = vi.hoisted(() => ({
  /** Runs before the function's own read, with the call's number (1 for the first). */
  before: undefined as undefined | ((call: number) => Promise<void>),
  /** Runs after the function answered. */
  after: undefined as undefined | (() => void),
  calls: 0,
  answers: [] as Array<{ kind: string; reason?: string; unknown?: string }>,
  real: undefined as undefined | typeof import('@sensigo/realm').takeBackStep,
}));
vi.mock('@sensigo/realm', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sensigo/realm')>();
  tb.real = real.takeBackStep;
  return {
    ...real,
    takeBackStep: async (...args: Parameters<typeof real.takeBackStep>) => {
      tb.calls += 1;
      await tb.before?.(tb.calls);
      try {
        const answer = await real.takeBackStep(...args);
        tb.answers.push({
          kind: answer.kind,
          ...('reason' in answer ? { reason: answer.reason } : {}),
          ...('unknown' in answer ? { unknown: answer.unknown } : {}),
        });
        return answer;
      } finally {
        tb.after?.();
      }
    },
  };
});

import {
  claimStepForDrive,
  createDefaultRegistry,
  declareReleaseLine,
  executeChain,
  reclaimStep,
  releaseDriveClaim,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type Attributed,
  type LeaseHold,
  type PriceSource,
  type RunRecord,
  type UsageRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, createLeaseDouble, type LeaseDouble } from '@sensigo/realm-testing';
import { runAgent } from './run-agent.js';
import { LlmProvider, type CallStepWithMetaResult } from './providers/llm-provider.js';
import { writerTestSeams } from '../output/writer.js';
import { inspectRun } from '../commands/inspect.js';

const registry = createDefaultRegistry();
const shown = (t: string): string => writerTestSeams.visible(t);
const WATCH_MS = 1000;

const prog = (by: string): Attributed => ({ by, by_source: 'stated', channel: 'agent' });
const A = prog('drive-a');
const A2 = prog('drive-a2');
const B = prog('drive-b');
const C = prog('drive-c');
const X = prog('drive-x');
const words = (who: Attributed): string => `${who.by} (as stated, via agent)`;

/** `s`, an agent step not declared idempotent (its reclaim carries a condition); `x`, an auto step. */
const DEF: WorkflowDefinition = {
  id: 'take-back-cw5b',
  name: 'take-back-cw5b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { s: { description: 's', execution: 'agent', depends_on: [] } },
} as WorkflowDefinition;
/** `s`, then `t` after it: completing `s` does not end the run. */
const TWO_DEF: WorkflowDefinition = {
  ...DEF,
  id: 'take-back-cw5b-two',
  steps: {
    s: { description: 's', execution: 'agent', depends_on: [] },
    t: { description: 't', execution: 'agent', depends_on: ['s'] },
  },
} as WorkflowDefinition;
const AUTO_DEF: WorkflowDefinition = {
  ...DEF,
  id: 'take-back-cw5b-auto',
  steps: { x: { description: 'x', execution: 'auto', depends_on: [] } },
} as WorkflowDefinition;

const NOT_HELD = "no program held the claim's lease when it was checked";
/** Line (i), word for word as the prompt gives it. */
const takenBack = (who: Attributed, at: string): string =>
  `• Step 's' was taken by ${words(who)} at ${at}; ${NOT_HELD}, so this drive took it back (this step's one automatic take-back until a person reclaims it). Its model and tools run here, so any side effects of the first program's calls may repeat.`;

interface Fixture {
  store: InMemoryStore;
  double: LeaseDouble;
  runId: string;
  def: WorkflowDefinition;
}
async function fixture(def: WorkflowDefinition = DEF): Promise<Fixture> {
  const double = createLeaseDouble();
  const store = new InMemoryStore({ leases: double });
  const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
  tb.before = undefined;
  tb.after = undefined;
  tb.calls = 0;
  tb.answers = [];
  return { store, double, runId: record.id, def };
}

/** `who` takes `step` under a lease, as a drive takes it: its hold, and its claim's stamp and token. */
async function take(
  f: Fixture,
  who: Attributed,
  step = 's',
): Promise<{ hold: LeaseHold; since: string; token: string }> {
  const answer = await claimStepForDrive(f.store, f.runId, step, {
    definition: f.def,
    registry,
    driver: who,
  });
  if (answer.kind !== 'claimed') throw new Error(`fixture: not claimed: ${JSON.stringify(answer)}`);
  const claim = (await f.store.get(f.runId)).record.claims![step]!;
  return { hold: answer.hold, since: claim.since!, token: claim.token! };
}

/** Another drive (`who`) takes the step back through the real function. */
async function takeBackAs(f: Fixture, who: Attributed, token: string): Promise<void> {
  const answer = await tb.real!(f.store, f.runId, 's', { expectToken: token, drivenBy: who });
  if (answer.kind !== 'taken_back') throw new Error(`fixture: ${JSON.stringify(answer)}`);
}

/** A person reclaims the step (`realm run reclaim … --force`, with the claim's stamp). */
async function reclaimAsPerson(f: Fixture, since: string): Promise<void> {
  await reclaimStep(f.store, f.runId, 's', { definition: f.def, force: true, claimed_at: since });
}

const record = async (f: Fixture): Promise<RunRecord> => (await f.store.get(f.runId)).record;
const takeBacks = (run: RunRecord) =>
  run.evidence.filter(
    (e) =>
      e.output_summary?.['reclaimed'] === true && e.output_summary['reason'] === 'lease_not_held',
  );

/** The fixture's workflow store: its one definition, on this realm's release line. */
const workflowsOf = (f: Fixture) => {
  const store = {
    async register() {},
    async get() {
      return f.def;
    },
    async list() {
      return [f.def];
    },
  };
  declareReleaseLine(store);
  return store;
};

/** One model request's usage, as a provider reports it. */
const USAGE: UsageRecord = {
  request_index: 0,
  request_start: '2026-01-01T00:00:00.000Z',
  model: 'cw5b-model',
  prompt_tokens: 100,
  output_tokens: 10,
} as UsageRecord;

/**
 * One `realm agent` drive of the fixture's run, its model answering `{ ok: true }` (with `usage`, one
 * request's usage too). `driver` is B by default (`null`: none). `onLine` sees each stdout line as it
 * prints; `onGet` each store read.
 */
async function drive(
  f: Fixture,
  o: {
    driver?: Attributed | null;
    usage?: boolean;
    onLine?: (line: string) => void;
    onGet?: () => void;
  } = {},
): Promise<{ result: string; calls: number; lines: string[]; ms: number }> {
  const lines: string[] = [];
  let calls = 0;
  const provider = new (class extends LlmProvider {
    async callStep(): Promise<Record<string, unknown>> {
      calls += 1;
      return { ok: true };
    }
    override async callStepWithMeta(): Promise<CallStepWithMetaResult> {
      calls += 1;
      return { output: { ok: true }, ...(o.usage === true ? { usage: [USAGE] } : {}) };
    }
  })();
  const keep =
    (prefix: string) =>
    (...a: unknown[]): void => {
      const line = shown(a.map(String).join(' '));
      lines.push(prefix + line);
      // A drive that repeats itself is stopped, so a break that loops fails its cell, not the run.
      if (lines.length > 300) throw new Error('runaway drive');
      if (prefix === '') o.onLine?.(line);
    };
  vi.spyOn(console, 'log').mockImplementation(keep(''));
  vi.spyOn(console, 'error').mockImplementation(keep('err: '));
  vi.spyOn(console, 'warn').mockImplementation(keep('warn: '));
  const realGet = f.store.get.bind(f.store);
  if (o.onGet !== undefined) {
    f.store.get = async (id: string) => {
      o.onGet!();
      return realGet(id);
    };
  }
  const driver = o.driver === undefined ? B : o.driver;
  const started = performance.now();
  try {
    const result = await runAgent(
      {
        store: f.store,
        workflowStore: workflowsOf(f),
        provider,
        registry,
        ...(driver !== null ? { driver } : {}),
      },
      {
        definition: f.def,
        existingRunId: f.runId,
        params: {},
        inFlightPollMs: 10,
        inFlightWatchMs: WATCH_MS,
      },
    );
    return { result, calls, lines, ms: performance.now() - started };
  } finally {
    vi.restoreAllMocks();
    f.store.get = realGet;
  }
}

/** The lines that say something about step `s` (each starts with `• `), in order. */
const bullets = (lines: string[]): string[] => lines.filter((l) => l.startsWith('• '));

describe('#729 CW-5b — W1, W2: a lease no program holds is taken back once, and the step runs here', () => {
  it('W1: A’s lease is not held before B starts — line (i), no waiting line, one model call, the step completed, one take-back entry', async () => {
    const f = await fixture();
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    const d = await drive(f);
    const run = await record(f);
    // (1) red when the watch checks the lease only after an unchanged watch (a waiting line first,
    //     the take-back after the watch time), or takes nothing back; (2) prints the drive's lines,
    //     its calls and the record's take-back entries.
    expect(
      {
        result: d.result,
        calls: d.calls,
        bullets: bullets(d.lines),
        waiting: d.lines.filter((l) => l.includes('Waiting up to')),
        takeBacks: takeBacks(run).map((e) => e.driven_by),
        completed: run.completed_steps,
        withinTheWatch: d.ms < WATCH_MS,
      },
      d.lines.join('\n'),
    ).toEqual({
      result: 'completed',
      calls: 1,
      bullets: [takenBack(A, a.since)],
      waiting: [],
      takeBacks: [B],
      completed: ['s'],
      withinTheWatch: true,
    });
  });

  it('W2: B waits on A’s held lease, then A’s lease is not held — line (i) within 3 polls, no in-flight line, one model call', async () => {
    const f = await fixture();
    const a = await take(f, A);
    const events: string[] = [];
    const d = await drive(f, {
      onGet: () => events.push('read'),
      onLine: (line) => {
        events.push(line);
        // A is killed once B says it waits.
        if (line.includes('Waiting up to')) f.double.set(a.hold.id, 'dead');
      },
    });
    const waitAt = events.findIndex((l) => l.includes('Waiting up to'));
    const backAt = events.indexOf(takenBack(A, a.since));
    // Each poll is one read; the take-back's own read is one more.
    const readsBetween = events.slice(waitAt + 1, backAt).filter((e) => e === 'read').length;
    // (1) red when the watch checks the lease only on the read before its waiting line (B then waits
    //     the whole watch and prints the in-flight line), or takes nothing back; (2) prints the lines,
    //     the reads between the two lines and the calls.
    expect(
      {
        result: d.result,
        calls: d.calls,
        bullets: bullets(d.lines),
        inFlight: d.lines.filter((l) => l.includes('has not changed')),
        withinThreePolls: waitAt >= 0 && backAt > waitAt && readsBetween <= 3 + 1,
      },
      `${d.lines.join('\n')}\nreads between: ${readsBetween}`,
    ).toEqual({
      result: 'completed',
      calls: 1,
      bullets: [
        `• Step 's' was taken by ${words(A)} at ${a.since}; its program held the claim's lease when it was checked. Waiting up to 1s for the run's record to change.`,
        takenBack(A, a.since),
      ],
      inFlight: [],
      withinThreePolls: true,
    });
  });
});

describe('#729 CW-5b — the function’s second write race', () => {
  it('another write lands under both of the function’s writes: it throws, the drive reads the run again from the loop’s top, and its next take-back runs the step', async () => {
    const f = await fixture();
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    const realUpdate = f.store.update.bind(f.store);
    tb.before = async (call) => {
      if (call !== 1) return;
      // Another program's write (the record as it stands, written again) lands just before each of
      // the function's two writes, so each is at a version that moved: a second mismatch is thrown.
      let races = 0;
      f.store.update = async (...args: Parameters<typeof realUpdate>) => {
        if (races < 2) {
          races += 1;
          await realUpdate((await f.store.get(f.runId)).record);
        }
        return realUpdate(...args);
      };
    };
    tb.after = () => {
      f.store.update = realUpdate;
    };
    const d = await drive(f);
    const run = await record(f);
    // (1) red when the thrown race is not caught (the drive fails) or the drive does not read the run
    //     again (no second take-back); (2) prints the answers and the lines.
    expect(
      {
        calls: tb.calls,
        answers: tb.answers,
        result: d.result,
        model: d.calls,
        bullets: bullets(d.lines),
        takeBacks: takeBacks(run).length,
        completed: run.completed_steps,
      },
      d.lines.join('\n'),
    ).toEqual({
      calls: 2,
      answers: [{ kind: 'taken_back' }],
      result: 'completed',
      model: 1,
      bullets: [takenBack(A, a.since)],
      takeBacks: 1,
      completed: ['s'],
    });
  });
});

describe('#729 CW-5b — W3, W4: no take-back unless the function’s own read finds the lease not held', () => {
  it('W3: the watch reads the lease not held, the function’s own read absent, then unknown (permission) — nothing taken back; B stops at the watch time, the step still A’s', async () => {
    const f = await fixture();
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    tb.before = async (call) => {
      f.double.set(
        a.hold.id,
        call === 1
          ? 'removed'
          : { forced: { state: 'unknown', basis: 'kernel_lock', reason: 'permission' } },
      );
    };
    tb.after = () => f.double.set(a.hold.id, 'dead');
    const d = await drive(f);
    const run = await record(f);
    // (1) red when a lease the function reads absent or unknown is taken back (line (i), an entry,
    //     a model call); (2) prints the function's first two answers, the lines and the claim.
    expect(
      {
        answers: tb.answers.slice(0, 2),
        result: d.result,
        calls: d.calls,
        takenBack: d.lines.filter((l) => l.includes('took it back')),
        takeBacks: takeBacks(run).length,
        claim: run.claims?.['s']?.token,
        last: d.lines.at(-1),
        atTheWatchTime: d.ms >= WATCH_MS,
      },
      d.lines.join('\n'),
    ).toEqual({
      answers: [
        { kind: 'not_taken', reason: 'lease_absent' },
        { kind: 'not_taken', reason: 'lease_unknown', unknown: 'permission' },
      ],
      result: 'failed',
      calls: 0,
      takenBack: [],
      takeBacks: 0,
      claim: a.token,
      last: `  Go on:     once 's' is freed (realm run reclaim ${f.runId} prints its command), realm agent --run-id ${f.runId} --provider <provider> --model <model>`,
      atTheWatchTime: true,
    });
  });

  it('W4 (regression): A holds for the whole watch — the in-flight line with the held words, then the go-on line, exit as today', async () => {
    const f = await fixture();
    const a = await take(f, A);
    const d = await drive(f);
    const run = await record(f);
    // (1) red when a held lease is taken back (line (i), an entry, a model call) or the watch's end
    //     changes; (2) prints the lines.
    expect(
      {
        result: d.result,
        calls: d.calls,
        tail: d.lines.slice(-2),
        takeBacks: takeBacks(run).length,
        claim: run.claims?.['s']?.token,
      },
      d.lines.join('\n'),
    ).toEqual({
      result: 'failed',
      calls: 0,
      tail: [
        `• Step 's' was taken by ${words(A)} at ${a.since}; the record has not changed for 1s. 's' is held; wait for it. Its program held the claim's lease when it was checked; if that program is still running, the step runs twice. It is not declared idempotent, so running it again may repeat its effects. To free it anyway, run: realm run reclaim ${f.runId} --step s --claimed-at ${a.since} --force`,
        `  Go on:     once 's' is no longer in flight, realm agent --run-id ${f.runId} --provider <provider> --model <model>`,
      ],
      takeBacks: 0,
      claim: a.token,
    });
  });
});

describe('#729 CW-5b — W5: at the cap, a person decides', () => {
  it('W5: the step was taken back automatically once; a second holder’s lease is not held — the at-cap line with that take-back and the held entry’s freeing parts, and B stops', async () => {
    const f = await fixture();
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    await takeBackAs(f, C, a.token);
    const t0 = takeBacks(await record(f))[0]!.output_summary['reclaimed_at'] as string;
    const a2 = await take(f, A2);
    f.double.set(a2.hold.id, 'dead');
    const d = await drive(f);
    const run = await record(f);
    // (1) red when the function's `at_cap` is ignored (B watches, then the in-flight line), the line
    //     names another take-back, or its freeing parts are dropped; (2) prints the answers and lines.
    expect(
      {
        answers: tb.answers,
        result: d.result,
        calls: d.calls,
        bullets: bullets(d.lines),
        last: d.lines.at(-1),
        takeBacks: takeBacks(run).length,
        claim: run.claims?.['s']?.token,
        // With no other step to wait on, B stops at once: no watch.
        atOnce: d.ms < WATCH_MS,
      },
      d.lines.join('\n'),
    ).toEqual({
      answers: [{ kind: 'not_taken', reason: 'at_cap' }],
      result: 'failed',
      calls: 0,
      bullets: [
        `• Step 's' was taken by ${words(A2)} at ${a2.since}; ${NOT_HELD}, and it was already taken back automatically once (at ${t0}, by ${words(C)}), so a person decides. It is not declared idempotent, so running it again may repeat its effects. To free it, run: realm run reclaim ${f.runId} --step s --claimed-at ${a2.since} --force`,
      ],
      last: `  Go on:     once 's' is freed (realm run reclaim ${f.runId} prints its command), realm agent --run-id ${f.runId} --provider <provider> --model <model>`,
      takeBacks: 1,
      claim: a2.token,
      atOnce: true,
    });
  });
});

describe('#729 CW-5b — W6: another took the step between B’s read and the function’s own (line (iii))', () => {
  it('W6 automatic: C took it back, then claimed it — "taken back by C at <t>; it is now taken by C at <since>", then B watches C’s claim', async () => {
    const f = await fixture();
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    let c: Awaited<ReturnType<typeof take>> | undefined;
    tb.before = async (call) => {
      if (call !== 1) return;
      await takeBackAs(f, C, a.token);
      c = await take(f, C);
    };
    const d = await drive(f);
    const run = await record(f);
    const t = takeBacks(run)[0]!.output_summary['reclaimed_at'] as string;
    // (1) red when B takes the step too, prints line (i), or names no taker; (2) prints the lines.
    expect(
      {
        answers: tb.answers.slice(0, 1),
        result: d.result,
        calls: d.calls,
        bullets: bullets(d.lines).slice(0, 2),
        takeBacks: takeBacks(run).map((e) => e.driven_by),
        claim: run.claims?.['s']?.token,
      },
      d.lines.join('\n'),
    ).toEqual({
      answers: [{ kind: 'changed' }],
      result: 'failed',
      calls: 0,
      bullets: [
        `• Step 's' was taken back by ${words(C)} at ${t}; it is now taken by ${words(C)} at ${c!.since}, not by this drive.`,
        `• Step 's' was taken by ${words(C)} at ${c!.since}; its program held the claim's lease when it was checked. Waiting up to 1s for the run's record to change.`,
      ],
      takeBacks: [C],
      claim: c!.token,
    });
  });

  it('W6 manual: a person reclaimed A’s claim — "reclaimed at <t>, not by this drive", then B runs the step', async () => {
    const f = await fixture();
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    tb.before = async (call) => {
      if (call === 1) await reclaimAsPerson(f, a.since);
    };
    const d = await drive(f);
    const run = await record(f);
    const manual = run.evidence.find((e) => e.output_summary?.['reason'] === 'manual reclaim')!;
    // (1) red when B takes the step back too, prints line (i), or the line names no reclaim; (2)
    //     prints the lines.
    expect(
      {
        answers: tb.answers,
        result: d.result,
        calls: d.calls,
        bullets: bullets(d.lines),
        takeBacks: takeBacks(run).length,
        completed: run.completed_steps,
      },
      d.lines.join('\n'),
    ).toEqual({
      answers: [{ kind: 'not_taken', reason: 'not_in_progress' }],
      result: 'completed',
      calls: 1,
      bullets: [
        `• Step 's' was reclaimed at ${manual.output_summary['reclaimed_at'] as string}, not by this drive.`,
      ],
      takeBacks: 0,
      completed: ['s'],
    });
  });

  /** A run whose step was reclaimed by a person before A claimed it: an older entry on the record. */
  async function reclaimedBefore(
    def: WorkflowDefinition = DEF,
  ): Promise<{ f: Fixture; a: Awaited<ReturnType<typeof take>> }> {
    const f = await fixture(def);
    const x = await take(f, X);
    f.double.set(x.hold.id, 'dead');
    await reclaimAsPerson(f, x.since);
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    return { f, a };
  }

  it('W6 let go: A’s program let the claim go and C claimed — "let go by its program and is now taken by C", the older reclaim not named', async () => {
    const { f, a } = await reclaimedBefore();
    let c: Awaited<ReturnType<typeof take>> | undefined;
    tb.before = async (call) => {
      if (call !== 1) return;
      const released = await releaseDriveClaim(f.store, f.runId, 's', {
        definition: f.def,
        hold: a.hold,
      });
      if (released.kind !== 'released') throw new Error(`fixture: ${JSON.stringify(released)}`);
      c = await take(f, C);
    };
    const d = await drive(f);
    // (1) red when B takes it back too, prints line (i), or names the reclaim made before A's claim;
    //     (2) prints the lines.
    expect(
      {
        answers: tb.answers.slice(0, 1),
        calls: d.calls,
        first: bullets(d.lines)[0],
        reclaimed: d.lines.filter((l) => l.includes('reclaimed at') || l.includes('took it back')),
      },
      d.lines.join('\n'),
    ).toEqual({
      answers: [{ kind: 'changed' }],
      calls: 0,
      first: `• Step 's' was let go by its program and is now taken by ${words(C)} at ${c!.since}, not by this drive.`,
      reclaimed: [],
    });
  });

  it('W6 no line: A’s program completed the step meanwhile (the run goes on) — no line (iii), and the drive goes on with the next step', async () => {
    // Two steps, so completing `s` leaves the run open: the function answers `not_in_progress`.
    const { f, a } = await reclaimedBefore(TWO_DEF);
    tb.before = async (call) => {
      if (call !== 1) return;
      const reply = await executeChain(f.store, f.def, {
        runId: f.runId,
        command: 's',
        input: { ok: true },
        dispatcher: async (_step, input) => ({ ...input }),
        registry,
        driver: A,
        heldClaim: { hold: a.hold },
      });
      if (reply.status !== 'ok') throw new Error(`fixture: ${JSON.stringify(reply)}`);
    };
    const d = await drive(f);
    const run = await record(f);
    // (1) red when B takes it back too, prints line (i), or prints a line naming the reclaim made
    //     before A's claim; (2) prints the lines.
    expect(
      {
        answers: tb.answers,
        result: d.result,
        calls: d.calls,
        bullets: bullets(d.lines),
        completed: run.completed_steps,
      },
      d.lines.join('\n'),
    ).toEqual({
      answers: [{ kind: 'not_taken', reason: 'not_in_progress' }],
      result: 'completed',
      calls: 1,
      bullets: [],
      completed: ['s', 't'],
    });
  });
});

describe('#729 CW-5b — check 7: no program name, and a step that is not an agent step', () => {
  it('no driver, below the cap: the no-driver line in place of the waiting line, nothing taken back', async () => {
    const f = await fixture();
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    const d = await drive(f, { driver: null });
    const run = await record(f);
    // (1) red when a drive with no program name takes the step back, or says the waiting line; (2)
    //     prints the lines.
    expect(
      {
        result: d.result,
        calls: d.calls,
        first: bullets(d.lines)[0],
        waiting: d.lines.filter((l) => l.includes("Waiting up to 1s for the run's record")).length,
        takeBacks: takeBacks(run).length,
        claim: run.claims?.['s']?.token,
      },
      d.lines.join('\n'),
    ).toEqual({
      result: 'failed',
      calls: 0,
      first: `• Step 's' was taken by ${words(A)} at ${a.since}; ${NOT_HELD}, but this drive has no program name, so it cannot take the step back (set REALM_OPERATOR to name it). Waiting up to 1s for the run's record to change.`,
      waiting: 1,
      takeBacks: 0,
      claim: a.token,
    });
  });

  it('#729 CW-5c check 4: no driver, below the cap — its in-flight line and its Go-on line name no realm agent take-back, as on the base', async () => {
    const f = await fixture();
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    const d = await drive(f, { driver: null });
    // (1) red when realm agent passes its own in-flight line or Go-on the steps a drive takes back (a
    //     drive with no program name takes nothing back, so the sentence or the Go-on's first part
    //     would promise what it cannot do); (2) prints the lines.
    expect(
      {
        inFlight: d.lines.find((l) => l.includes('the record has not changed for')),
        goOn: d.lines.at(-1),
      },
      d.lines.join('\n'),
    ).toEqual({
      inFlight: `• Step 's' was taken by ${words(A)} at ${a.since}; the record has not changed for 1s. 's' was claimed, and ${NOT_HELD}; no result is recorded for it. It is not declared idempotent, so running it again may repeat its effects. To free it, run: realm run reclaim ${f.runId} --step s --claimed-at ${a.since} --force`,
      goOn: `  Go on:     once 's' is freed (realm run reclaim ${f.runId} prints its command), realm agent --run-id ${f.runId} --provider <provider> --model <model>`,
    });
  });

  it('no driver, the lease turns not held during the watch: the no-driver line on the poll that reads it, after the waiting line; nothing taken back', async () => {
    const f = await fixture();
    const a = await take(f, A);
    const d = await drive(f, {
      driver: null,
      onLine: (line) => {
        // A is killed once B says it waits.
        if (line.includes('its program held')) f.double.set(a.hold.id, 'dead');
      },
    });
    const run = await record(f);
    // (1) red when the watch checks a drive with no program name only before its waiting line (the
    //     line never comes), or that drive takes the step back; (2) prints the lines.
    expect(
      {
        result: d.result,
        calls: tb.calls,
        bullets: bullets(d.lines).slice(0, 2),
        takeBacks: takeBacks(run).length,
        claim: run.claims?.['s']?.token,
      },
      d.lines.join('\n'),
    ).toEqual({
      result: 'failed',
      calls: 0,
      bullets: [
        `• Step 's' was taken by ${words(A)} at ${a.since}; its program held the claim's lease when it was checked. Waiting up to 1s for the run's record to change.`,
        `• Step 's' was taken by ${words(A)} at ${a.since}; ${NOT_HELD}, but this drive has no program name, so it cannot take the step back (set REALM_OPERATOR to name it). Waiting up to 1s for the run's record to change.`,
      ],
      takeBacks: 0,
      claim: a.token,
    });
  });

  it('no driver, at the cap: the at-cap line, never the REALM_OPERATOR advice', async () => {
    const f = await fixture();
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    await takeBackAs(f, C, a.token);
    const t0 = takeBacks(await record(f))[0]!.output_summary['reclaimed_at'] as string;
    const a2 = await take(f, A2);
    f.double.set(a2.hold.id, 'dead');
    const d = await drive(f, { driver: null });
    // (1) red when the at-cap drive with no name names REALM_OPERATOR (naming it would not let it
    //     take the step back), or calls the take-back; (2) prints the lines.
    expect(
      {
        result: d.result,
        calls: tb.calls,
        bullets: bullets(d.lines),
        operator: d.lines.filter((l) => l.includes('REALM_OPERATOR')),
      },
      d.lines.join('\n'),
    ).toEqual({
      result: 'failed',
      calls: 0,
      bullets: [
        `• Step 's' was taken by ${words(A2)} at ${a2.since}; ${NOT_HELD}, and it was already taken back automatically once (at ${t0}, by ${words(C)}), so a person decides. It is not declared idempotent, so running it again may repeat its effects. To free it, run: realm run reclaim ${f.runId} --step s --claimed-at ${a2.since} --force`,
      ],
      operator: [],
    });
  });

  it('not an agent step: an auto step whose claim’s lease no program holds is watched as today, never taken back', async () => {
    const f = await fixture(AUTO_DEF);
    const a = await take(f, A, 'x');
    f.double.set(a.hold.id, 'dead');
    const d = await drive(f);
    const run = await record(f);
    // (1) red when the watch takes back a step that is not an agent step; (2) prints the lines.
    expect(
      {
        result: d.result,
        calls: tb.calls,
        takenBack: d.lines.filter((l) => l.includes('took it back')),
        entries: run.evidence.filter((e) => e.output_summary?.['reclaimed'] === true).length,
        claim: run.claims?.['x']?.token,
      },
      d.lines.join('\n'),
    ).toEqual({ result: 'failed', calls: 0, takenBack: [], entries: 0, claim: a.token });
  });
});

/** Every request priced at 0.25 from an economics file. */
const PRICES: PriceSource = {
  price: (input) => ({
    priced: { total: 0.25, uncached_counterfactual: 0.25 },
    priced_by: {
      source_class: 'economics',
      source_ref: '/srv/prices.yaml',
      matched_model: input.model,
      date_basis: 'current',
    },
  }),
};

describe('#729 CW-5b — check 8: inspect, a reclaim’s audit entry is not an attempt', () => {
  it('a person’s reclaim, then B takes the step back and runs it: the attempt keeps its Taken by: line and its cost, and no reclaim is counted with no usage figures', async () => {
    const f = await fixture();
    const x = await take(f, X);
    f.double.set(x.hold.id, 'dead');
    await reclaimAsPerson(f, x.since);
    const a = await take(f, A);
    f.double.set(a.hold.id, 'dead');
    const d = await drive(f, { usage: true });
    if (d.result !== 'completed') throw new Error(`fixture: ${d.lines.join('\n')}`);
    const out = shown(
      await inspectRun(f.runId, f.store, workflowsOf(f), { priceSource: PRICES }),
    ).split('\n');
    const step = out.slice(out.findIndex((l) => /^\s+1\. s\s/.test(l)));
    // (1) red when a reclaim's entry is an attempt (the attempt line then reads the reclaim's, with
    //     its taker and no cost) or inspect drops attempts by position (the run's one attempt loses its
    //     Taken by: line and its cost); (2) prints inspect's output.
    expect(
      {
        reclaimLines: step.filter((l) => /^\s+(Reclaimed|Taken back) at /.test(l)).length,
        takenBy: step.filter((l) => l.includes('Taken by:')).map((l) => l.trim()),
        noUsage: out.filter((l) => l.includes('no usage figures')),
        attemptCost: step
          .filter((l) => l.trim().startsWith('Diagnostics:'))
          .map((l) => l.split(' | ').at(-1)),
        runCost: out.find((l) => l.startsWith('Cost:')),
      },
      out.join('\n'),
    ).toEqual({
      reclaimLines: 2,
      takenBy: [`Taken by: ${words(B)}`],
      noUsage: [],
      attemptCost: ['$0.25 (your economics file; current price)'],
      runCost: 'Cost: $0.25 (your economics file; current price; 1 of 1 requests priced)',
    });
  });
});
