// failure-text-iv-b1.test.ts — gap 2, unit (iv-b1): the MCP door's failure-text setting, on the MCP
// side.
//
// An operator who runs Realm's MCP server for an assistant can choose that the assistant never reads
// a failure's words in `get_run_state`: the text a provider, a handler or an adapter put in a
// failure, which can carry the data the request held. Under `hidden` each such field shows its
// length, `‹string, N characters›`; Realm's own words, the step, its code, category or class stay;
// the record keeps the words. Every cell runs the real server in process (`createRealmMcpServer`
// over `InMemoryTransport`) on runs ended by their real writers (the engine's own calls), a seeded
// record only for a run sealed before arms were recorded and for one whose arm cannot be placed.
// Every assertion carries (a) the change that turns it red and (b) what it prints.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  ExtensionRegistry,
  WorkflowError,
  abandonRun,
  advanceRun,
  executeChain,
  executeStep,
  type Attributed,
  type RunRecord,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { plantRegistryRow } from '@sensigo/realm-store-sqlite/test-support';
import { createRealmMcpServer } from './server.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const RUN_STATE = 'docs/reference/mcp/run-state-and-health.md';
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. Each
 *  sentence is pinned in the cell that executes it. */
function claim(page: string, sentence: string): void {
  const flat = (t: string): string => t.replace(/\s+/g, ' ');
  expect(
    flat(readFileSync(join(ROOT, page), 'utf8')),
    `${page} no longer says: ${sentence}`,
  ).toContain(flat(sentence));
}

const def = (id: string, steps: Record<string, unknown>): WorkflowDefinition =>
  ({ id, name: id, version: 1, schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION, steps }) as never;

const homes: TempHome[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of homes.splice(0).reverse()) await h.cleanup();
});

/** The words a handler's failure carries: none of them may reach an assistant under `hidden`. */
const SECRET_WORDS = 'the customer card 4242 is on fire';
const LONG_WORDS = `order 1234: ${'x'.repeat(600)}`;
const ABORT_WORDS = 'Nothing to do for account 99.';

/** A registry with `ok`, `boom` and `long` (throw), `quit` (aborts) and `fin-boom` (a finalizer
 *  that throws). */
function handlers(): ExtensionRegistry {
  const r = new ExtensionRegistry();
  const thrower = (id: string, words: string) =>
    ({
      id,
      execute: async () => {
        throw new Error(words);
      },
    }) as never;
  r.register('handler', 'ok', { id: 'ok', execute: async () => ({ data: { ok: true } }) } as never);
  r.register('handler', 'boom', thrower('boom', SECRET_WORDS));
  r.register('handler', 'long', thrower('long', LONG_WORDS));
  r.register('handler', 'fin-boom', thrower('fin-boom', SECRET_WORDS));
  // A failure another try can fix: the step's `retry` tries it again, then Realm's wrapper ends it.
  r.register('handler', 'flaky', {
    id: 'flaky',
    execute: async () => {
      throw new WorkflowError(SECRET_WORDS, {
        code: 'SERVICE_HTTP_5XX',
        category: 'SERVICE',
        agentAction: 'report_to_user',
        retryable: true,
      });
    },
  } as never);
  r.register('handler', 'quit', {
    id: 'quit',
    execute: async () => ({ abort: { message: ABORT_WORDS } }),
  } as never);
  return r;
}

const GATE = (extra: Record<string, unknown> = {}) => ({
  description: 'Q.',
  execution: 'auto',
  trust: 'human_confirmed',
  depends_on: [],
  gate: { choices: ['ok', 'no'], ...extra },
});

const D = {
  complete: def('ft-complete', {
    s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'ok' },
  }),
  failure: def('ft-failure', {
    s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'boom' },
  }),
  retried: def('ft-retried', {
    s: {
      description: 'S.',
      execution: 'auto',
      depends_on: [],
      handler: 'flaky',
      retry: { max_attempts: 2, backoff_ms: 1 },
    },
  }),
  long: def('ft-long', {
    s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'long' },
  }),
  twoFailed: def('ft-two-failed', {
    a: { description: 'A.', execution: 'auto', depends_on: [], handler: 'boom' },
    b: {
      description: 'B.',
      execution: 'auto',
      depends_on: ['a'],
      trigger_rule: 'one_failed',
      handler: 'boom',
    },
  }),
  handlerAbort: def('ft-handler-abort', {
    s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'quit' },
  }),
  guardTwo: def('ft-guard-two', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'agent', depends_on: [] },
    g: {
      description: 'G.',
      execution: 'guard',
      depends_on: ['a'],
      abort_unless: ['a.missing == true'],
    },
  }),
  guardOne: def('ft-guard-one', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    g: {
      description: 'G.',
      execution: 'guard',
      depends_on: ['a'],
      abort_unless: ['a.missing == true'],
    },
  }),
  finalizer: def('ft-finalizer', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    fin: {
      description: 'Fin.',
      execution: 'finalizer',
      on_outcome: 'fail',
      handler: 'fin-boom',
    },
  }),
  guardAbort: def('ft-guard-abort', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    g: {
      description: 'G.',
      execution: 'guard',
      depends_on: ['a'],
      abort_unless: ['a.ok == true'],
      abort_message: 'Not ok: the amount is over the limit.',
    },
  }),
  expiryAbort: def('ft-expiry-abort', { q: GATE({ timeout_seconds: 60, on_expiry: 'abort' }) }),
  pair: def('ft-pair', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    b: { description: 'B.', execution: 'agent', depends_on: [] },
  }),
  chain: def('ft-chain', {
    a: { description: 'A.', execution: 'agent', depends_on: [] },
    s: { description: 'S.', execution: 'auto', depends_on: ['a'], handler: 'boom' },
  }),
};
const ALL = Object.values(D);

const DRIVER: Attributed = { by: 'nightly-cleanup', by_source: 'stated', channel: 'mcp-stdio' };

/** An in-memory run store on a settable clock, beside a temp home's other stores. */
async function world(defs: WorkflowDefinition[] = ALL) {
  const h = await makeTempHome();
  homes.push(h);
  const clock = settableClock(new Date('2026-11-21T00:00:00Z'));
  const runStore = new InMemoryStore({ clock });
  const registry = handlers();
  for (const d of defs) await h.stores.workflowStore.register(d);
  const fresh = async (d: WorkflowDefinition): Promise<string> =>
    (await runStore.create({ workflowId: d.id, workflowVersion: 1, params: {} })).record.id;
  const record = async (id: string): Promise<RunRecord> => (await runStore.get(id)).record;
  /** The real server in process over this world's stores, with the failure-text option given. */
  const connect = async (failureText?: 'shown' | 'hidden') => {
    const server = createRealmMcpServer({
      ...h.stores,
      runStore: runStore as RunStore,
      registry,
      driver: DRIVER,
      ...(failureText !== undefined ? { failureText } : {}),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'failure-text-iv-b1', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const raw = (await client.callTool({ name, arguments: args })) as {
        content: Array<{ text?: string }>;
      };
      const text = raw.content[0]?.text ?? '{}';
      return { text, reply: JSON.parse(text) as Record<string, unknown> };
    };
    return {
      client,
      call,
      state: (runId: string) => call('get_run_state', { run_id: runId }),
    };
  };
  return { h, runStore, clock, registry, fresh, record, connect };
}
type World = Awaited<ReturnType<typeof world>>;

const shape = (n: number): string => `‹string, ${n} character${n === 1 ? '' : 's'}›`;
/** The last recorded error text of `step` (the text `failures[]` and the several-failures sentence
 *  read). */
const errorOf = (run: RunRecord, step: string): string =>
  run.evidence.filter((e) => e.step_id === step && typeof e.error === 'string').at(-1)!.error!;
const failuresOf = (reply: Record<string, unknown>) =>
  reply['failures'] as Array<Record<string, unknown>>;
const receipt = (reply: Record<string, unknown>) => reply['disclosure'] as Record<string, unknown>;

/** Ends a fresh run of each kind by its real writer; returns the run id. */
async function endBy(w: World, kind: string): Promise<string> {
  const s = w.runStore;
  const echo = async (_n: string, i: Record<string, unknown>) => ({ ...i });
  const fail = (words: string) => async (): Promise<Record<string, unknown>> => {
    throw new Error(words);
  };
  switch (kind) {
    case 'one failed step': {
      const id = await w.fresh(D.failure);
      await advanceRun(s, D.failure, { runId: id, registry: w.registry });
      return id;
    }
    case 'a retried step': {
      const id = await w.fresh(D.retried);
      await advanceRun(s, D.retried, { runId: id, registry: w.registry });
      return id;
    }
    case 'a message over 500 characters': {
      const id = await w.fresh(D.long);
      await advanceRun(s, D.long, { runId: id, registry: w.registry });
      return id;
    }
    case 'several failed steps': {
      // One advance runs `a` (it fails); the next runs `b`, which waits for `a` to fail.
      const id = await w.fresh(D.twoFailed);
      await advanceRun(s, D.twoFailed, { runId: id, registry: w.registry });
      await advanceRun(s, D.twoFailed, { runId: id, registry: w.registry });
      return id;
    }
    case "a handler's abort": {
      const id = await w.fresh(D.handlerAbort);
      await advanceRun(s, D.handlerAbort, { runId: id, registry: w.registry });
      return id;
    }
    case "a guard's resolution error with two failed steps": {
      const id = await w.fresh(D.guardTwo);
      await executeStep(s, D.guardTwo, {
        runId: id,
        command: 'b',
        input: {},
        dispatcher: fail(SECRET_WORDS),
      });
      await executeChain(s, D.guardTwo, { runId: id, command: 'a', input: {}, dispatcher: echo });
      return id;
    }
    case "a guard's resolution error with one failed step": {
      const id = await w.fresh(D.guardOne);
      await executeChain(s, D.guardOne, { runId: id, command: 'a', input: {}, dispatcher: echo });
      return id;
    }
    case "a finalizer's failure after a failed seal": {
      const id = await w.fresh(D.finalizer);
      await executeStep(s, D.finalizer, {
        runId: id,
        command: 'a',
        input: {},
        dispatcher: fail(SECRET_WORDS),
        registry: w.registry,
      });
      return id;
    }
    case "a guard's abort": {
      const id = await w.fresh(D.guardAbort);
      await executeChain(s, D.guardAbort, {
        runId: id,
        command: 'a',
        input: { ok: false },
        dispatcher: echo,
      });
      return id;
    }
    case "a gate's expiry": {
      const id = await w.fresh(D.expiryAbort);
      await executeStep(s, D.expiryAbort, { runId: id, command: 'q', input: {}, dispatcher: echo });
      await w.clock.set(new Date('2026-11-21T00:05:00Z'));
      await advanceRun(s, D.expiryAbort, { runId: id, registry: w.registry });
      return id;
    }
    case 'a completed run': {
      const id = await w.fresh(D.complete);
      await advanceRun(s, D.complete, { runId: id, registry: w.registry });
      return id;
    }
    case 'spawn_failed':
    case 'extensions_load_failed': {
      // The run-level arms, through the store's seal_run with each writer's exact arm and reason.
      const id = await w.fresh(D.pair);
      const run = await w.record(id);
      await s.settleStep!(id, {
        kind: 'seal_run',
        arm: kind === 'spawn_failed' ? 'spawn_failure' : 'extensions_load_failure',
        reason: kind,
        expected_version: run.version,
        release_claims: false,
      });
      return id;
    }
    case "a person's abandon reason": {
      const id = await w.fresh(D.pair);
      await abandonRun(s, id, `wrong customer: ${SECRET_WORDS}`);
      return id;
    }
    case 'a legacy seal without an arm': {
      // A record written before seals existed: a step failure, its reason in Realm's words.
      const id = await w.fresh(D.failure);
      await advanceRun(s, D.failure, { runId: id, registry: w.registry });
      const { sealed_by: _seal, ...legacy } = await w.record(id);
      void _seal;
      s.seed(legacy as RunRecord);
      return id;
    }
    case 'an arm that cannot be placed': {
      // A record with no arm whose reason the legacy classifier cannot place: a free sentence, an
      // abort marker neither a handler's nor a gate's.
      const id = await w.fresh(D.pair);
      const run = await w.record(id);
      s.seed({
        ...run,
        terminal_state: true,
        run_phase: 'aborted',
        terminal_reason: `The night shift stopped it: ${SECRET_WORDS}`,
        aborted_at: { step_id: 'a', abort_message: SECRET_WORDS },
      } as RunRecord);
      return id;
    }
    default:
      throw new Error(`no writer for ${kind}`);
  }
}

describe('gap 2 (iv-b1), check 2 — each field of get_run_state that carries a failure’s words is shaped under hidden', () => {
  it('failures[].message: the shape of the record’s text; every field beside it unchanged; the words appear nowhere', async () => {
    claim(
      RUN_STATE,
      "| `failures[].message` | `‹string, N characters›`, N the recorded text's length, also when it is over 500 characters | `step`, `code`, `category`, `stop_reason`, `agent_action`, `failure_kind`, `attempt` and `unknown` |",
    );
    claim(RUN_STATE, "The run's record and `realm run inspect` keep the words.");
    const w = await world();
    const id = await endBy(w, 'one failed step');
    const run = await w.record(id);
    const hidden = await (await w.connect('hidden')).state(id);
    const shown = await (await w.connect('shown')).state(id);
    const { message: hiddenMessage, ...hiddenRest } = failuresOf(hidden.reply)[0]!;
    const { message: shownMessage, ...shownRest } = failuresOf(shown.reply)[0]!;
    // (a) red when failures[].message is left as recorded under hidden (the break), or another key
    //     of the entry changes; (b) prints both messages and both entries' other keys.
    expect({
      hiddenMessage,
      shownMessage,
      rest: hiddenRest,
      words: hidden.text.includes(SECRET_WORDS),
      kept: errorOf(await w.record(id), 's').includes(SECRET_WORDS),
    }).toEqual({
      hiddenMessage: shape(errorOf(run, 's').length),
      shownMessage: errorOf(run, 's'),
      rest: shownRest,
      words: false,
      kept: true,
    });
  });

  it('a message over 500 characters: N is the record’s length, never the cut’s', async () => {
    const w = await world();
    const id = await endBy(w, 'a message over 500 characters');
    const run = await w.record(id);
    const length = errorOf(run, 's').length;
    const hidden = await (await w.connect('hidden')).state(id);
    const shown = await (await w.connect('shown')).state(id);
    // (a) red when N is measured after core's 500-character cut (the shape of the marker) or the
    //     message is left as it is; (b) prints both messages and the record's length.
    expect({
      length: length > 500,
      hidden: failuresOf(hidden.reply)[0]!['message'],
      shown: failuresOf(shown.reply)[0]!['message'],
    }).toEqual({
      length: true,
      hidden: shape(length),
      shown: `‹${length} characters, not kept›`,
    });
  });

  it('abort_context.abort_message under a handler’s abort: shaped, step_id beside it unchanged', async () => {
    claim(
      RUN_STATE,
      '| `abort_context.abort_message` | `‹string, N characters›` when a handler aborted the run | `step_id` |',
    );
    const w = await world();
    const id = await endBy(w, "a handler's abort");
    const hidden = await (await w.connect('hidden')).state(id);
    // (a) red when the abort message is left as the handler wrote it; (b) prints the field.
    expect(hidden.reply['abort_context']).toEqual({
      step_id: 's',
      abort_message: shape(ABORT_WORDS.length),
    });
    expect(hidden.text.includes(ABORT_WORDS)).toBe(false);
  });
});

/** A live run whose last drive failed on `a`: the record as `realm agent` writes it (the type's own
 *  fields), seeded, since the drive is the CLI's. */
async function driveFailing(w: World): Promise<{ id: string; message: string }> {
  const id = await w.fresh(D.pair);
  const run = await w.record(id);
  const message = `401 Unauthorized: ${SECRET_WORDS}`;
  w.runStore.seed({
    ...run,
    drive_failures: {
      first_failed_at: '2026-11-20T23:58:00.000Z',
      total: 1,
      entries: [
        {
          at: '2026-11-20T23:58:00.000Z',
          step: 'a',
          provider: 'anthropic',
          error_class: 'api_status',
          message,
          evidence_count: 0,
          attempts_sdk: 3,
          elapsed_ms: 1200,
          last_observed_status: 401,
        },
      ],
    },
  } as RunRecord);
  return { id, message };
}

describe('gap 2 (iv-b1), checks 2 and 5 — the drive failures and the drive_failing reason', () => {
  it('drive_failures.entries[].message: shaped; the provider, the class, the status and the attempts unchanged', async () => {
    claim(
      RUN_STATE,
      '| `drive_failures.entries[].message` | `‹string, N characters›` | The time, the step, the provider, `error_class`, the status, the attempts and what was billed |',
    );
    const w = await world();
    const { id, message } = await driveFailing(w);
    const hidden = await (await w.connect('hidden')).state(id);
    const shown = await (await w.connect('shown')).state(id);
    const entry = (r: Record<string, unknown>) =>
      (r['drive_failures'] as { entries: Array<Record<string, unknown>> }).entries[0]!;
    const { message: hiddenMessage, ...hiddenRest } = entry(hidden.reply);
    const { message: _shownMessage, ...shownRest } = entry(shown.reply);
    void _shownMessage;
    // (a) red when the entry's message is left as recorded under hidden; (b) prints the message and
    //     the entry's other keys.
    expect({ hiddenMessage, rest: hiddenRest }).toEqual({
      hiddenMessage: shape(message.length),
      rest: shownRest,
    });
  });

  it('a startup_failure entry (Q1 unit c: a drive that died at startup, before any step): its message shaped like every class', async () => {
    const w = await world();
    const id = await w.fresh(D.pair);
    const run = await w.record(id);
    // The entry as unit c's `startupFailureEntry` writes it (cli/src/agent/startup-failure.ts): no
    // step, the death's message sanitized and capped, no evidence count. Cast through unknown: on
    // this branch's base the class is not yet in the type.
    const message = `the project's extensions could not be loaded: ${SECRET_WORDS}`;
    w.runStore.seed({
      ...run,
      drive_failures: {
        first_failed_at: '2026-11-20T23:58:00.000Z',
        total: 1,
        entries: [
          {
            at: '2026-11-20T23:58:00.000Z',
            step: '',
            provider: 'anthropic',
            error_class: 'startup_failure',
            message,
            elapsed_ms: 40,
          },
        ],
      },
    } as unknown as RunRecord);
    const hidden = await (await w.connect('hidden')).state(id);
    const entry = (hidden.reply['drive_failures'] as { entries: Array<Record<string, unknown>> })
      .entries[0]!;
    // (a) red when the entry's message is left as recorded (Realm's startup sentence holds the load
    //     error's words); (b) prints the class and the message shown.
    expect({ cls: entry['error_class'], message: entry['message'] }).toEqual({
      cls: 'startup_failure',
      message: shape(message.length),
    });
    expect(hidden.text.includes(SECRET_WORDS)).toBe(false);
  });

  it('check 5 — the drive_failing reason keeps Realm’s words; the message is one shape, never a shape of a shape', async () => {
    claim(
      RUN_STATE,
      "| The `drive_failing` finding's `reason` in `run_health` | Realm's sentence, with the message as its shape: `the last drive attempt failed <when> (<error_class>): ‹string, N characters›` | The finding's `evidence` |",
    );
    const w = await world();
    const { id, message } = await driveFailing(w);
    const reasonOf = (r: Record<string, unknown>) =>
      (r['run_health'] as Array<{ kind: string; reason: string }>).find(
        (f) => f.kind === 'drive_failing',
      )?.reason;
    const hidden = reasonOf((await (await w.connect('hidden')).state(id)).reply);
    const shown = reasonOf((await (await w.connect('shown')).state(id)).reply);
    // (a) red when the reason is shaped whole (the walk's way: Realm's words lost), left with the
    //     message, or shaped twice; (b) prints both reasons.
    expect({
      shown: shown?.includes(message),
      hidden,
      shapes: hidden?.split('‹string,').length,
    }).toEqual({
      shown: true,
      hidden: shown?.replace(message, shape(message.length)),
      shapes: 2,
    });
    expect(hidden?.startsWith('the last drive attempt failed')).toBe(true);
  });
});

describe('gap 2 (iv-b1), check 3 — terminal_reason by the seal arm', () => {
  it('one failed step: Step ‘s’ failed: <shape>, N the length of the recorded text after Realm’s words', async () => {
    // The row's three forms: this cell, the handler's abort's and the several failures' execute them.
    claim(
      RUN_STATE,
      "| `terminal_reason` | Realm's words, with the failure's as their shape: `Step '<step>' failed: ‹string, N characters›`; `Handler '<step>' aborted the run: ‹string, N characters›`; with more than one failed step, `<count> steps failed: <step> (\"‹string, N characters›\"), …`, each step's message shaped | `sealed_by_arm`, `failed_steps` and `failures` |",
    );
    const w = await world();
    const id = await endBy(w, 'one failed step');
    const run = await w.record(id);
    const head = "Step 's' failed: ";
    const hidden = await (await w.connect('hidden')).state(id);
    // (a) red when the arm check is gone and the reason is shaped whole or left whole; (b) prints the
    //     reason shown and the recorded one's start.
    expect({
      recorded: run.terminal_reason!.startsWith(head),
      shown: hidden.reply['terminal_reason'],
    }).toEqual({
      recorded: true,
      shown: `${head}${shape(run.terminal_reason!.length - head.length)}`,
    });
  });

  it('a retried step: Realm’s wrapper inside the reason is shaped with the rest; failures[].message is the handler’s text, shaped', async () => {
    // The guard's half of the sentence: the one-failed-step guard cell below.
    claim(
      RUN_STATE,
      "Inside these fields, Realm's own words are shaped with the failure's: in `terminal_reason`, a retried step's `Step '<step>' failed after <N> attempts`; in `failures[].message`, a guard's `Guard resolution error: unresolvable path …`.",
    );
    const w = await world();
    const id = await endBy(w, 'a retried step');
    const run = await w.record(id);
    const head = "Step 's' failed: ";
    const wrapper = "Step 's' failed after 2 attempts";
    const hidden = await (await w.connect('hidden')).state(id);
    // (a) red when Realm's own words inside a listed field are kept (the field is the unit), or the
    //     handler's text is left in failures[]; (b) prints the recorded reason and both fields.
    expect({
      recorded: run.terminal_reason,
      reason: hidden.reply['terminal_reason'],
      message: failuresOf(hidden.reply)[0]!['message'],
    }).toEqual({
      recorded: `${head}${wrapper}`,
      reason: `${head}${shape(wrapper.length)}`,
      message: shape(SECRET_WORDS.length),
    });
  });

  it("a handler's abort: Handler ‘s’ aborted the run: <shape>", async () => {
    const w = await world();
    const id = await endBy(w, "a handler's abort");
    const hidden = await (await w.connect('hidden')).state(id);
    // (a) red when the abort's words are left in the reason; (b) prints the reason.
    expect(hidden.reply['terminal_reason']).toBe(
      `Handler 's' aborted the run: ${shape(ABORT_WORDS.length)}`,
    );
  });

  it('several failed steps: the several-failures sentence with each step’s message as a shape', async () => {
    const w = await world();
    const id = await endBy(w, 'several failed steps');
    const run = await w.record(id);
    const hidden = await (await w.connect('hidden')).state(id);
    // (a) red when the stored sentence (with the words) is shown, or the sentence is shaped whole;
    //     (b) prints the reason and the record's failed steps.
    expect({ failed: run.failed_steps, reason: hidden.reply['terminal_reason'] }).toEqual({
      failed: ['a', 'b'],
      reason: `2 steps failed: a ("${shape(errorOf(run, 'a').length)}"), b ("${shape(errorOf(run, 'b').length)}").`,
    });
  });

  it("a guard's resolution error with two failed steps: the several-failures sentence, the guard's own sentence shaped with the rest", async () => {
    const w = await world();
    const id = await endBy(w, "a guard's resolution error with two failed steps");
    const run = await w.record(id);
    const hidden = await (await w.connect('hidden')).state(id);
    // (a) red when this arm keeps its stored reason; (b) prints the arm, the failed steps and the
    //     reason.
    expect({
      arm: run.sealed_by?.arm,
      failed: [...run.failed_steps].sort(),
      reason: hidden.reply['terminal_reason'],
    }).toEqual({
      arm: 'guard_resolution_error',
      failed: ['b', 'g'],
      reason: `2 steps failed: b ("${shape(errorOf(run, 'b').length)}"), g ("${shape(errorOf(run, 'g').length)}").`,
    });
  });

  it("a finalizer's failure after a failed seal: the re-rendered sentence, shaped", async () => {
    const w = await world();
    const id = await endBy(w, "a finalizer's failure after a failed seal");
    const run = await w.record(id);
    const hidden = await (await w.connect('hidden')).state(id);
    // (a) red when the re-rendered sentence (with the words) is shown; (b) prints the arm, the
    //     failed steps and the reason.
    expect({
      arm: run.sealed_by?.arm,
      failed: run.failed_steps,
      reason: hidden.reply['terminal_reason'],
    }).toEqual({
      arm: 'step_failure',
      failed: ['a', 'fin'],
      reason: `2 steps failed: a ("${shape(errorOf(run, 'a').length)}"), fin ("${shape(errorOf(run, 'fin').length)}").`,
    });
  });

  it('a legacy seal without an arm: judged by the legacy classifier, shaped as its arm', async () => {
    claim(
      RUN_STATE,
      'Which sentence `terminal_reason` holds is read from how the run ended (`sealed_by_arm`); a run sealed before Realm recorded that is placed by the form of its reason.',
    );
    const w = await world();
    const id = await endBy(w, 'a legacy seal without an arm');
    const run = await w.record(id);
    const head = "Step 's' failed: ";
    const hidden = await (await w.connect('hidden')).state(id);
    // (a) red when a record with no arm is shown as it is; (b) prints the seal and the reason.
    expect({ seal: run.sealed_by, reason: hidden.reply['terminal_reason'] }).toEqual({
      seal: undefined,
      reason: `${head}${shape(run.terminal_reason!.length - head.length)}`,
    });
  });

  it('an arm that cannot be placed: the whole reason shaped', async () => {
    // Its abort message: check 4's unplaceable cell.
    claim(
      RUN_STATE,
      'A reason Realm cannot place is shaped whole, and so is its `abort_context.abort_message`.',
    );
    const w = await world();
    const id = await endBy(w, 'an arm that cannot be placed');
    const run = await w.record(id);
    const hidden = await (await w.connect('hidden')).state(id);
    // (a) red when an unplaceable reason is shown as it is; (b) prints the reason.
    expect(hidden.reply['terminal_reason']).toBe(shape(run.terminal_reason!.length));
  });

  // A guard's abort records no terminal_reason (its words are abort_context's, check 4), so it has no
  // cell here: none could fail.
  it.each([
    'a completed run',
    "a person's abandon reason",
    "a gate's expiry",
    "a guard's resolution error with one failed step",
    'spawn_failed',
    'extensions_load_failed',
  ])('unchanged: %s', async (kind) => {
    claim(
      RUN_STATE,
      "A `terminal_reason` that holds no failure's words stays as it is: a completed run, a run abandoned with a person's reason, a gate's expiry, a guard's resolution error with one failed step, `spawn_failed` and `extensions_load_failed`.",
    );
    const w = await world();
    const id = await endBy(w, kind);
    const run = await w.record(id);
    const hidden = await (await w.connect('hidden')).state(id);
    // (a) red when the arm check is removed and every non-fixed reason is shaped (the break); (b)
    //     prints the arm and both reasons.
    expect({
      arm: run.sealed_by?.arm,
      recorded: typeof run.terminal_reason,
      reason: hidden.reply['terminal_reason'],
    }).toEqual({
      arm: run.sealed_by?.arm,
      recorded: 'string',
      reason: run.terminal_reason,
    });
    if (kind === "a guard's resolution error with one failed step") {
      // The guard's own sentence in failures[].message is Realm's text inside a listed field: shaped.
      // (a) red when failures[].message keeps it; (b) prints the recorded text's start and the field.
      expect({
        recorded: errorOf(run, 'g').startsWith('Guard resolution error: unresolvable path'),
        message: failuresOf(hidden.reply)[0]!['message'],
      }).toEqual({ recorded: true, message: shape(errorOf(run, 'g').length) });
    }
  });
});

describe('gap 2 (iv-b1), check 4 — the abort message, by the seal arm', () => {
  it.each([
    ["a handler's abort", 'shaped'],
    ['an arm that cannot be placed', 'shaped'],
    ["a guard's abort", 'kept'],
    ["a gate's expiry", 'kept'],
  ] as const)('%s: %s', async (kind, want) => {
    claim(RUN_STATE, "A guard's abort message is the workflow author's own, and stays.");
    const w = await world();
    const id = await endBy(w, kind);
    const run = await w.record(id);
    const recorded = run.aborted_at!.abort_message!;
    const hidden = await (await w.connect('hidden')).state(id);
    const shownMessage = (hidden.reply['abort_context'] as Record<string, unknown>)[
      'abort_message'
    ];
    // (a) red when the message is shaped whatever the arm (the break: a guard's message is the
    //     author's, a gate's Realm's), or left whole under a handler's abort; (b) prints the arm and
    //     the message shown.
    expect({ arm: run.sealed_by?.arm, shown: shownMessage }).toEqual({
      arm: run.sealed_by?.arm,
      shown: want === 'shaped' ? shape(recorded.length) : recorded,
    });
  });
});

describe('gap 2 (iv-b1), check 6 — the receipt says failure text was withheld, only where something was shaped', () => {
  it('a failed run lists terminal_reason and failures[0].message; a live run lists the drive failure and the drive_failing reason', async () => {
    claim(
      RUN_STATE,
      'A reply in which something was shaped says so in its `disclosure` receipt: `failure_text: "withheld"`, with the shaped fields\' paths in `shaped`. A run with no failures carries neither.',
    );
    const w = await world();
    const ended = await endBy(w, 'one failed step');
    const { id: live } = await driveFailing(w);
    const hidden = await w.connect('hidden');
    const endedReceipt = receipt((await hidden.state(ended)).reply);
    const liveReceipt = receipt((await hidden.state(live)).reply);
    // (a) red when the receipt's word is removed, or a rebuilt path is not listed; (b) prints the
    //     word and the paths of each receipt.
    expect({
      ended: [endedReceipt['failure_text'], endedReceipt['shaped']],
      live: [liveReceipt['failure_text'], liveReceipt['shaped']],
    }).toEqual({
      // In the reply's order, as the walk meets them.
      ended: ['withheld', ['failures[0].message', 'terminal_reason']],
      live: ['withheld', ['drive_failures.entries[0].message', 'run_health[0].reason']],
    });
  });

  // Gap 2, unit (iv-b2a): the execute_step half of this cell (its reply kept the words, as (iv-b1)
  // covered get_run_state only) moved to failure-text-replies-iv-b2a, where that reply is shaped.
  it('a run with no failures carries neither', async () => {
    const w = await world();
    const hidden = await w.connect('hidden');
    const quiet = await w.fresh(D.pair);
    const stateReceipt = receipt((await hidden.state(quiet)).reply);
    // (a) red when the word or `shaped` is set with nothing shaped; (b) prints the receipt's two keys.
    expect([stateReceipt['failure_text'], stateReceipt['shaped']]).toEqual([undefined, undefined]);
  });
});

describe('gap 2 (iv-b1), check 7 — under shown, get_run_state is today’s reply', () => {
  it.each(['one failed step', "a handler's abort", 'several failed steps'])(
    '%s: the reply with shown equals the reply with no setting, words and all',
    async (kind) => {
      claim(
        RUN_STATE,
        "When a step or a drive fails, `get_run_state` shows the words the failure came with: a provider's error message, the text a handler threw, an adapter's reply.",
      );
      const w = await world();
      const id = await endBy(w, kind);
      const run = await w.record(id);
      const shown = await (await w.connect('shown')).state(id);
      const unset = await (await w.connect()).state(id);
      // (a) red when `shown` is treated as `hidden` (the words go, the receipt says withheld) or the
      //     two replies differ; (b) prints the reason, whether the reply holds the recorded words, and
      //     the receipt's word.
      expect({
        same: shown.text === unset.text,
        reason: shown.reply['terminal_reason'],
        words: shown.text.includes(SECRET_WORDS) || shown.text.includes(ABORT_WORDS),
        word: receipt(shown.reply)['failure_text'],
      }).toEqual({ same: true, reason: run.terminal_reason, words: true, word: undefined });
    },
  );
});

describe('gap 2 (iv-b1), check 8 — fields that are not a failure’s words stay under hidden', () => {
  it('sealed_by_actor.by stays whole on a run with a shaped failure', async () => {
    const w = await world();
    const hidden = await w.connect('hidden');
    const id = await w.fresh(D.pair);
    await executeStep(w.runStore, D.pair, {
      runId: id,
      command: 'a',
      input: {},
      dispatcher: async () => {
        throw new Error(SECRET_WORDS);
      },
    });
    await hidden.call('abandon_run', { run_id: id, reason: 'duplicate order' });
    const state = await hidden.state(id);
    // (a) red when the walk shapes every bounded field (the withhold precedent): the program's name
    //     goes; (b) prints the actor and whether a failure was shaped in the same reply.
    expect({
      actor: state.reply['sealed_by_actor'],
      shaped: receipt(state.reply)['shaped'],
    }).toEqual({
      actor: DRIVER,
      shaped: ['failures[0].message'],
    });
  });

  it('a load warning and a definition_unresolvable reason stay whole on a run with a shaped failure', async () => {
    const w = await world();
    const id = await w.fresh(D.pair);
    await executeStep(w.runStore, D.pair, {
      runId: id,
      command: 'a',
      input: {},
      dispatcher: async () => {
        throw new Error(SECRET_WORDS);
      },
    });
    const shownBefore = await (await w.connect('shown')).state(id);
    await plantRegistryRow(w.h.path, { id: D.pair.id, text: '{ not json' });
    const shown = await (await w.connect('shown')).state(id);
    const hidden = await (await w.connect('hidden')).state(id);
    const unresolvable = (r: Record<string, unknown>) =>
      (r['run_health'] as Array<{ kind: string; reason: string }>).find(
        (f) => f.kind === 'definition_unresolvable',
      )?.reason;
    // (a) red when the walk shapes every bounded field: the loader's text in the finding and the
    //     warnings goes; (b) prints both replies' finding and warnings, and the receipt's paths.
    expect({
      before: shownBefore.reply['next_actions_status'],
      reason: unresolvable(hidden.reply),
      warnings: hidden.reply['warnings'],
      shaped: receipt(hidden.reply)['shaped'],
    }).toEqual({
      before: 'ok',
      reason: unresolvable(shown.reply),
      warnings: shown.reply['warnings'],
      shaped: ['failures[0].message'],
    });
    expect(typeof unresolvable(hidden.reply)).toBe('string');
  });
});

describe('gap 2 (iv-b1), check 1 (library) — the sources, hidden wins, a bad value refuses', () => {
  /** The value and source kind the server advertises, built with these options and this variable. */
  async function advertised(
    opts: { failureText?: string; failureTextFlag?: string },
    env?: string,
  ): Promise<unknown> {
    vi.stubEnv('REALM_MCP_FAILURE_TEXT', env ?? '');
    const h = await makeTempHome();
    homes.push(h);
    const server = createRealmMcpServer({ ...h.stores, ...(opts as object) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'failure-text-iv-b1', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client.getServerCapabilities()?.experimental?.['realm/failure_text'];
  }

  it('each source sets hidden alone; the default is shown', async () => {
    // The bins' halves (the flag, the variable on each command): the CLI's cells and the bin cells below.
    claim(
      RUN_STATE,
      "A server started with `--failure-text hidden` (`realm mcp`, `realm serve`), with `REALM_MCP_FAILURE_TEXT=hidden`, or by a program that passes `failureText: 'hidden'` to `createRealmMcpServer` shows an assistant those words' length in their place, as `‹string, N characters›`, N the length of the text on the record. The default is `shown`; when more than one is set, `hidden` wins. Added after version 0.50.0.",
    );
    // (a) red when a source is not read (the variable read only by the bins), or the default is not
    //     shown; (b) prints each capability.
    expect({
      flag: await advertised({ failureTextFlag: 'hidden' }),
      env: await advertised({}, 'hidden'),
      option: await advertised({ failureText: 'hidden' }),
      none: await advertised({}),
    }).toEqual({
      flag: { value: 'hidden', source_kind: 'flag' },
      env: { value: 'hidden', source_kind: 'env' },
      option: { value: 'hidden', source_kind: 'option' },
      none: { value: 'shown', source_kind: 'default' },
    });
  });

  it('hidden wins across each pair of sources, whichever holds it', async () => {
    // (a) red when the combination rule is reversed (shown wins) or a tie goes to the wrong source;
    //     (b) prints each pair's capability.
    expect({
      flagEnv: await advertised({ failureTextFlag: 'shown' }, 'hidden'),
      envFlag: await advertised({ failureTextFlag: 'hidden' }, 'shown'),
      flagOption: await advertised({ failureTextFlag: 'shown', failureText: 'hidden' }),
      optionFlag: await advertised({ failureTextFlag: 'hidden', failureText: 'shown' }),
      envOption: await advertised({ failureText: 'shown' }, 'hidden'),
      optionEnv: await advertised({ failureText: 'hidden' }, 'shown'),
    }).toEqual({
      flagEnv: { value: 'hidden', source_kind: 'env' },
      envFlag: { value: 'hidden', source_kind: 'flag' },
      flagOption: { value: 'hidden', source_kind: 'option' },
      optionFlag: { value: 'hidden', source_kind: 'flag' },
      envOption: { value: 'hidden', source_kind: 'env' },
      optionEnv: { value: 'hidden', source_kind: 'option' },
    });
  });

  it('a value that is neither refuses: no server is built, with its sentence', async () => {
    const h = await makeTempHome();
    homes.push(h);
    const refusal = (build: () => unknown): string => {
      try {
        build();
        return 'built';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };
    const option = refusal(() =>
      createRealmMcpServer({ ...h.stores, failureText: 'hiden' as 'hidden' }),
    );
    vi.stubEnv('REALM_MCP_FAILURE_TEXT', 'nope');
    const env = refusal(() => createRealmMcpServer({ ...h.stores }));
    // (a) red when a misspelt value builds a server (it would start shown); (b) prints both lines.
    expect({ option, env }).toEqual({
      option:
        "createRealmMcpServer: invalid failureText option value 'hiden': expected shown or hidden — refused: no server is built while it is set, because a misspelt value would show an assistant a failure's words when you believe they are hidden. Fix the value where this program reads it, or remove it; a program that reads its environment only at start must be restarted.",
      env: "createRealmMcpServer: invalid REALM_MCP_FAILURE_TEXT value 'nope': expected shown or hidden — refused: no server is built while it is set, because a misspelt value would show an assistant a failure's words when you believe they are hidden. Fix the value where this program reads it, or remove it; a program that reads its environment only at start must be restarted.",
    });
  });
});

describe('gap 2 (iv-b1), check 10 — an embedder that passes only the stores gets the variable', () => {
  it('createRealmMcpServer with the four stores and REALM_MCP_FAILURE_TEXT=hidden: get_run_state is shaped', async () => {
    vi.stubEnv('REALM_MCP_FAILURE_TEXT', 'hidden');
    const h = await makeTempHome();
    homes.push(h);
    await h.stores.workflowStore.register(D.pair);
    const { record } = await h.stores.runStore.create({
      workflowId: D.pair.id,
      workflowVersion: 1,
      params: {},
    });
    await executeStep(h.stores.runStore, D.pair, {
      runId: record.id,
      command: 'a',
      input: {},
      dispatcher: async () => {
        throw new Error(SECRET_WORDS);
      },
    });
    const server = createRealmMcpServer({ ...h.stores });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'failure-text-iv-b1', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const raw = (await client.callTool({
      name: 'get_run_state',
      arguments: { run_id: record.id },
    })) as { content: Array<{ text?: string }> };
    const text = raw.content[0]?.text ?? '{}';
    const reply = JSON.parse(text) as Record<string, unknown>;
    // (a) red when only the bins read the variable (the server's own read removed); (b) prints the
    //     receipt's word and whether the words are in the reply.
    expect({
      word: receipt(reply)['failure_text'],
      words: text.includes(SECRET_WORDS),
    }).toEqual({ word: 'withheld', words: false });
  });
});

// These cells start the built bin as a child process (`spawnSync`, its own limit 20 s); the budget
// is set above the child's limit, as door-627's are.
describe('gap 2 (iv-b1), checks 1 and 9 — the realm-mcp bin', { timeout: 30_000 }, () => {
  const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
  /** The built bin with only these variables; stdin closed, so a started server exits after its
   *  lines. */
  const run = async (env: Record<string, string>) => {
    const home = await mkdtemp(join(tmpdir(), 'realm-failure-text-bin-'));
    const r = spawnSync(process.execPath, [bin], {
      env: { PATH: process.env['PATH'] ?? '', HOME: home, ...env },
      input: '',
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { code: r.status, lines: r.stderr.trim().split('\n') };
  };

  it('REALM_MCP_FAILURE_TEXT=hidden: the failure-text line follows the gate-answers line on stderr; none under shown', async () => {
    const hidden = await run({ REALM_MCP_FAILURE_TEXT: 'hidden' });
    const shown = await run({ REALM_MCP_FAILURE_TEXT: 'shown' });
    // (a) red when the bin prints no failure-text line under hidden, or prints one under shown;
    //     (b) prints each run's stderr lines after the first.
    expect({ hidden: hidden.lines.slice(1), shown: shown.lines.slice(1) }).toEqual({
      hidden: [
        "Failure text over MCP: hidden (from REALM_MCP_FAILURE_TEXT). In get_run_state and in the replies to its own calls, an assistant sees the step and its code, category or class, not the failure's words, except where a step copies them into its own output; realm run inspect still shows them.",
      ],
      shown: [],
    });
  });

  it('a bad REALM_MCP_FAILURE_TEXT refuses the start: one line naming the variable, exit 1', async () => {
    const r = await run({ REALM_MCP_FAILURE_TEXT: 'nope' });
    // (a) red when the bin starts on a misspelt value; (b) prints the exit and the lines.
    expect({ code: r.code, lines: r.lines }).toEqual({
      code: 1,
      lines: [
        "realm-mcp: invalid REALM_MCP_FAILURE_TEXT value 'nope': expected shown or hidden — refused at start: this server does not start while it is set, because a misspelt value would show an assistant a failure's words when you believe they are hidden. Fix the value or remove it. The server starts as soon as it is valid.",
      ],
    });
  });
});
