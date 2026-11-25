// goes-on-drive-g2iib3.test.ts — gap 2, unit (ii-b3): `realm agent` goes on after a failed step.
//
// A step that fails during a drive used to stop it, with exit code 1 and the run left open when a
// step could still run on the failure; a second `realm agent --run-id` ran that step. Now the drive
// prints the failure's line and goes on with whatever became ready, in the same drive: a
// `one_failed` or `all_done` step, other branches. Its exit is still 1 whenever a step failed during
// the drive, and a completed run's last line says so. A step left open (a give-back, a capability
// block, the schema wedge) still stops it, and so does a failure whose own reply ended the run. The
// cells drive `runAgent` with a provider of the test's own, or with Realm's Anthropic provider over a
// scripted `fetch` (fake keys only), and read what a person sees (stdout, stderr, the result) and
// what the run's record keeps.
//
// Every cell carries (a) the break that turns it red and (b) what it prints.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import {
  advanceRun,
  classifyRunHealth,
  createDefaultRegistry,
  loadWorkflowFromString,
  type ExtensionRegistry,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent, type AgentDeps } from './run-agent.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { LlmProvider } from './providers/llm-provider.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

type Wire = () => Response;
let script: Wire[] = [];
let wires = 0;
let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  script = [];
  wires = 0;
  out = [];
  err = [];
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-fake-g2iib3-0000');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      wires += 1;
      const next = script.shift();
      if (next === undefined) throw new Error('the test scripted no further answer');
      return next();
    }),
  );
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) =>
    out.push(a.map(String).join(' ')),
  );
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) =>
    err.push(a.map(String).join(' ')),
  );
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) =>
    err.push(a.map(String).join(' ')),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const JSONH = { 'content-type': 'application/json' };
const reply =
  (answer: string): Wire =>
  () =>
    new Response(
      JSON.stringify({
        id: 'msg_fake_g2iib3',
        type: 'message',
        role: 'assistant',
        model: 'claude-test-1',
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: JSONH },
    );
const fail =
  (status: number, type = 'api_error', message = 'overloaded (fake)'): Wire =>
  () =>
    new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
      status,
      headers: JSONH,
    });

/** A provider of the test's own: each call's answer from `answer`, by the step its prompt names. */
class Scripted extends LlmProvider {
  readonly asked: string[] = [];
  constructor(private readonly answer: (step: string) => Record<string, unknown>) {
    super();
  }
  async callStep(prompt: string): Promise<Record<string, unknown>> {
    const step = /STEP:(\w+)/.exec(prompt)?.[1] ?? '?';
    this.asked.push(step);
    // A drive that loops on a step ends here, never in a hang.
    if (this.asked.length > 20) throw new Error('the drive looped: more than 20 model calls');
    return this.answer(step);
  }
}
const ok = () => new Scripted(() => ({ ok: true }));

function registry(handlers: Record<string, () => Promise<unknown>> = {}): ExtensionRegistry {
  const r = createDefaultRegistry();
  const all: Record<string, () => Promise<unknown>> = {
    boom: async () => {
      throw new Error('the filing system is down');
    },
    noted: async () => ({ data: { noted: true } }),
    ...handlers,
  };
  for (const [id, execute] of Object.entries(all)) {
    r.register('handler', id, { id, execute } as never);
  }
  return r;
}

const wf = (yaml: string): WorkflowDefinition => loadWorkflowFromString(yaml);

/** One `realm agent --run-id` drive of `def` on a run of its own (or `runId`'s). */
async function drive(
  def: WorkflowDefinition,
  provider: LlmProvider,
  extra: { store?: InMemoryStore; runId?: string; registry?: ExtensionRegistry } = {},
): Promise<{ result: unknown; run: RunRecord; store: InMemoryStore }> {
  const store = extra.store ?? new InMemoryStore({ leases: createLeaseDouble() });
  const runId =
    extra.runId ??
    (await store.create({ workflowId: def.id, workflowVersion: 1, params: {} })).record.id;
  const result = await runAgent(
    {
      store,
      workflowStore: { register: async () => {}, get: async () => def, list: async () => [def] },
      provider,
      registry: extra.registry ?? registry(),
    } as unknown as AgentDeps,
    { existingRunId: runId, definition: def, params: {} },
  ).catch((thrown: unknown) => thrown);
  return { result, run: (await store.get(runId)).record, store };
}

const WORDS3 = (steps: string) =>
  `\n✗ The run completed, but a step failed during this drive (${steps}); realm agent exits with code 1.`;
const crosses = () => err.filter((l) => l.includes('✗'));
const resumes = () => err.filter((l) => l.includes('Resume:'));
const findings = async (store: InMemoryStore, runId: string) =>
  classifyRunHealth(await store.get(runId)).map((f) => f.kind);

// ─── Check 1: an `auto` step the drive called fails; a `one_failed` auto step after it ─────────

describe('gap 2 (ii-b3), check 1 — an auto step the drive called fails, and its one_failed step runs in the same drive', () => {
  it('the ✗ line, the branch, Run complete, then the line that says a step failed; exit 1', async () => {
    const def = wf(`id: g2iib3-c1
name: c1
version: 1
steps:
  pay:
    description: Take the payment.
    execution: auto
    handler: boom
  notify:
    description: Tell a person the payment failed.
    execution: auto
    handler: noted
    depends_on: [pay]
    trigger_rule: one_failed
`);
    const { result, run, store } = await drive(def, ok());
    // (a) red when the drive stops after the failure (the old `return`: notify not run, the run
    //     open), or when the completed end returns as before (exit 0, no closing line); (b) prints
    //     the result, the record, the findings and every ✗ and Resume line.
    expect({
      result,
      phase: run.run_phase,
      failed: run.failed_steps,
      completed: run.completed_steps,
      findings: (await findings(store, run.id)).includes('completed_with_failed_steps'),
      crosses: crosses(),
      resumes: resumes(),
      complete: out.includes(`\nRun complete: ${run.id}`),
      last: err.at(-1),
    }).toEqual({
      result: 'failed',
      phase: 'completed',
      failed: ['pay'],
      completed: ['notify'],
      findings: true,
      crosses: [
        "\n✗ Step 'pay' failed: Handler 'boom' threw: the filing system is down",
        WORDS3('pay'),
      ],
      resumes: [],
      complete: true,
      last: WORDS3('pay'),
    });
  });
});

// ─── Check 2: the engine runs a chained `auto` step that fails; a `one_failed` agent step after it

describe('gap 2 (ii-b3), check 2 — a chained auto step fails, and the one_failed agent step runs in the same drive', () => {
  it('the engine-ran-after ✗ line, the agent step is asked, the run completes; exit 1', async () => {
    const def = wf(`id: g2iib3-c2
name: c2
version: 1
steps:
  ask:
    description: Classify the ticket.
    execution: agent
    prompt: 'STEP:ask Classify the ticket.'
  pay:
    description: Take the payment.
    execution: auto
    handler: boom
    depends_on: [ask]
  help:
    description: Tell the customer.
    execution: agent
    prompt: 'STEP:help Tell the customer the payment failed.'
    depends_on: [pay]
    trigger_rule: one_failed
`);
    const provider = ok();
    const { result, run } = await drive(def, provider);
    // (a) red when the drive stops after the chained failure (help is never asked, the run open),
    //     or the completed end returns as before; (b) prints the steps asked, the record, the lines.
    expect({
      result,
      asked: provider.asked,
      phase: run.run_phase,
      failed: run.failed_steps,
      completed: run.completed_steps,
      crosses: crosses(),
      resumes: resumes(),
    }).toEqual({
      result: 'failed',
      asked: ['ask', 'help'],
      phase: 'completed',
      failed: ['pay'],
      completed: ['ask', 'help'],
      crosses: [
        "\n✗ Step 'pay' (run by the engine after 'ask' finished) failed: Handler 'boom' threw: the filing system is down",
        WORDS3('pay'),
      ],
      resumes: [],
    });
  });
});

// ─── Check 3: #1304's member, then a `one_failed` agent step that reads failure_kind ────────────

describe("gap 2 (ii-b3), check 3 — on_model_failure: fail, and the route's agent step runs in the same drive", () => {
  it('the bullet line, no Resume line, the route asked, the run completes; exit 1', async () => {
    // Two 503s use up the step's tries (transient); the third wire answers the route's step.
    script = [fail(503), fail(503), reply('{"noted":true}')];
    const def = wf(`id: g2iib3-c3
name: c3
version: 1
steps:
  s:
    description: Answer with JSON.
    execution: agent
    on_model_failure: fail
    retry: { max_attempts: 2, backoff: fixed, base_delay_ms: 1 }
  after:
    description: Note the failure.
    execution: agent
    depends_on: [s]
    trigger_rule: one_failed
    when: "$settlement.s.failure_kind == 'transient'"
`);
    const { result, run } = await drive(def, new AnthropicProvider('claude-test-1'));
    // (a) red when the member's own `return` stops the drive (after not run, the run open, a
    //     Resume line); (b) prints the wires, the record and the stderr lines.
    expect({
      result,
      wires,
      phase: run.run_phase,
      failed: run.failed_steps,
      completed: run.completed_steps,
      bullet: err.filter((l) => l.startsWith('• Step ')),
      resumes: resumes(),
      last: err.at(-1),
    }).toEqual({
      result: 'failed',
      wires: 3,
      phase: 'completed',
      failed: ['s'],
      completed: ['after'],
      bullet: [
        "• Step 's' failed (STEP_RETRY_EXHAUSTED): its model request failed, and the step has on_model_failure: fail.",
      ],
      resumes: [],
      last: WORDS3('s'),
    });
  });
});

// ─── Check 4: #220's validation_exhaustion mode fail on two independent steps, and a finalizer ───

describe('gap 2 (ii-b3), check 4 — two agent steps fail on their answers; both are asked, and the finalizer runs', () => {
  it('both lines, the finalizer ran, the run ended failed, the end lines once; exit 1', async () => {
    const def = wf(`id: g2iib3-c4
name: c4
version: 1
steps:
  a:
    description: Summarize A.
    execution: agent
    prompt: 'STEP:a Summarize A.'
    input_schema:
      type: object
      required: [summary]
      properties: { summary: { type: string } }
    validation_exhaustion: { threshold: 1, mode: fail }
  b:
    description: Summarize B.
    execution: agent
    prompt: 'STEP:b Summarize B.'
    input_schema:
      type: object
      required: [summary]
      properties: { summary: { type: string } }
    validation_exhaustion: { threshold: 1, mode: fail }
  close:
    description: Record that the run failed.
    execution: finalizer
    handler: noted
    on_outcome: fail
`);
    const provider = new Scripted(() => ({ wrong: true }));
    const { result, run } = await drive(def, provider);
    // (a) red when the drive stops at a (b never asked, the run open, the finalizer not run); (b)
    //     prints the steps asked, the record and the stderr lines.
    expect({
      result,
      asked: provider.asked,
      phase: run.run_phase,
      failed: run.failed_steps,
      finalizer: run.evidence.some((e) => e.step_id === 'close' && e.status === 'success'),
      failures: err.filter((l) => l.startsWith("\n✗ Step '")).map((l) => l.split(' failed')[0]),
      ended: err.filter((l) => l.includes('Run ended in phase') || l.includes('Ended:')),
      resumes: resumes().map((l) => l.replace(run.id, '<run>')),
      words3: err.filter((l) => l.includes('The run completed, but')),
    }).toEqual({
      result: 'failed',
      asked: ['a', 'b'],
      phase: 'failed',
      failed: ['a', 'b'],
      finalizer: true,
      failures: ["\n✗ Step 'a'", "\n✗ Step 'b'"],
      ended: [],
      resumes: ['  Resume:    realm run resume <run> --from <one of: a, b>'],
      words3: [],
    });
  });
});

// ─── Check 5: a failure that ends the run stops as before ───────────────────────────────────────

describe('gap 2 (ii-b3), check 5 — a failure whose own reply ended the run stops as before', () => {
  it('its line, the Resume line, no Run ended in phase line; exit 1', async () => {
    const def = wf(`id: g2iib3-c5
name: c5
version: 1
steps:
  pay:
    description: Take the payment.
    execution: auto
    handler: boom
`);
    const { result, run } = await drive(def, ok());
    // (a) red when the drive goes on past a failure that ended the run (a `Run ended in phase:`
    //     line follows); (b) prints the record and every stderr line.
    expect({
      result,
      phase: run.run_phase,
      err: err.map((l) => l.replace(run.id, '<run>')),
    }).toEqual({
      result: 'failed',
      phase: 'failed',
      err: [
        "\n✗ Step 'pay' failed: Handler 'boom' threw: the filing system is down",
        '  Resume:    realm run resume <run> --from pay',
      ],
    });
  });
});

// ─── Check 6: two failures in one drive ─────────────────────────────────────────────────────────

describe('gap 2 (ii-b3), check 6 — two branches fail, and an all_done step lets the run complete', () => {
  it('both lines; the closing line names both; exit 1', async () => {
    const def = wf(`id: g2iib3-c6
name: c6
version: 1
steps:
  p1:
    description: Pay one.
    execution: auto
    handler: boom
  p2:
    description: Pay two.
    execution: auto
    handler: boom
  done:
    description: Close out.
    execution: auto
    handler: noted
    depends_on: [p1, p2]
    trigger_rule: all_done
`);
    const { result, run } = await drive(def, ok());
    // (a) red when the drive stops at the first failure, or the closing line drops a step; (b)
    //     prints the record and the ✗ lines.
    expect({
      result,
      phase: run.run_phase,
      failed: run.failed_steps,
      completed: run.completed_steps,
      crosses: crosses(),
    }).toEqual({
      result: 'failed',
      phase: 'completed',
      failed: ['p1', 'p2'],
      completed: ['done'],
      crosses: [
        "\n✗ Step 'p1' failed: Handler 'boom' threw: the filing system is down",
        "\n✗ Step 'p2' failed: Handler 'boom' threw: the filing system is down",
        WORDS3('p1, p2'),
      ],
    });
  });
});

// ─── Check 7: what still stops ──────────────────────────────────────────────────────────────────

describe('gap 2 (ii-b3), check 7 — a step left open still stops the drive', () => {
  it('a give-back (a 401 under on_model_failure: fail): the drive stops, the other step is not asked', async () => {
    script = [fail(401, 'authentication_error', 'invalid x-api-key (fake)')];
    const def = wf(`id: g2iib3-c7a
name: c7a
version: 1
steps:
  s:
    description: Answer with JSON.
    execution: agent
    on_model_failure: fail
  other:
    description: Answer with JSON too.
    execution: agent
`);
    const { result, run } = await drive(def, new AnthropicProvider('claude-test-1'));
    // (a) red when the drive goes on after the give-back (a second wire); (b) prints the wires,
    //     the record, the give-back line and the ✗ lines.
    expect({
      result,
      wires,
      ended: run.terminal_state,
      failed: run.failed_steps,
      completed: run.completed_steps,
      giveBack: out.filter((l) => l.includes('let its claim go')),
      words3: err.filter((l) => l.includes('The run completed, but')),
    }).toEqual({
      result: 'failed',
      wires: 1,
      ended: false,
      failed: [],
      completed: [],
      giveBack: [
        "• Step 's': this drive let its claim go (its step failed), so the step can run again.",
      ],
      words3: [],
    });
  });

  it('a missing handler: the ⚠ line, the run open; exit 1', async () => {
    const def = wf(`id: g2iib3-c7b
name: c7b
version: 1
steps:
  file:
    description: File the ticket.
    execution: auto
    handler: file_ticket
`);
    const { result, run } = await drive(def, ok());
    // (a) red when a capability block is taken for a failure (the drive goes on, a closing line);
    //     (b) prints the record and the stderr lines.
    expect({
      result,
      ended: run.terminal_state,
      failed: run.failed_steps,
      blocked: err.filter((l) => l.includes("⚠ Step 'file' is blocked")).length,
      words3: err.filter((l) => l.includes('The run completed, but')),
    }).toEqual({ result: 'failed', ended: false, failed: [], blocked: 1, words3: [] });
  });

  it('a capability block on a step the engine runs after an agent step: the ⚠ line, the run open; exit 1', async () => {
    const def = wf(`id: g2iib3-c7c
name: c7c
version: 1
steps:
  ask:
    description: Classify the ticket.
    execution: agent
    prompt: 'STEP:ask Classify the ticket.'
  file:
    description: File the ticket.
    execution: auto
    handler: file_ticket
    depends_on: [ask]
  help:
    description: Tell the customer.
    execution: agent
    prompt: 'STEP:help Tell the customer.'
    depends_on: [file]
    trigger_rule: one_failed
`);
    const provider = ok();
    const { result, run } = await drive(def, provider);
    // (a) red when the block is taken for a failure (help asked); (b) prints the steps asked, the
    //     record and the stderr lines.
    expect({
      result,
      asked: provider.asked,
      ended: run.terminal_state,
      failed: run.failed_steps,
      blocked: err.filter((l) => l.includes("⚠ Step 'file'") && l.includes('is blocked')).length,
    }).toEqual({ result: 'failed', asked: ['ask'], ended: false, failed: [], blocked: 1 });
  });

  it('the schema wedge: the model always answers wrong; the drive stops after --schema-retries + 1 calls, the run open', async () => {
    const def = wf(`id: g2iib3-c7d
name: c7d
version: 1
steps:
  x:
    description: Summarize.
    execution: agent
    prompt: 'STEP:x Summarize.'
    input_schema:
      type: object
      required: [summary]
      properties: { summary: { type: string } }
  other:
    description: Summarize again.
    execution: agent
    prompt: 'STEP:other Summarize again.'
`);
    const provider = new Scripted(() => ({ wrong: true }));
    const { result, run } = await drive(def, provider);
    // (a) red when the drive goes on after the wedge's error reply (x asked again and again, or
    //     other asked); (b) prints the steps asked, the record and the ✗ lines.
    expect({
      result,
      asked: provider.asked,
      ended: run.terminal_state,
      failed: run.failed_steps,
      crosses: crosses(),
    }).toEqual({
      result: 'failed',
      asked: ['x', 'x', 'x'],
      ended: false,
      failed: [],
      crosses: ["\n✗ Step 'x' failed: Invalid input for step 'x' after 2 schema-repair attempts"],
    });
  }, 15_000);
});

// ─── Check 7b: an earlier drive's failure is not this drive's ───────────────────────────────────

describe("gap 2 (ii-b3), check 7b — a failure on the record from an earlier drive is not this drive's", () => {
  it('realm run advance fails the step; realm agent then completes the run: no closing line, exit 0', async () => {
    const def = wf(`id: g2iib3-c7e
name: c7e
version: 1
steps:
  pay:
    description: Take the payment.
    execution: auto
    handler: boom
  help:
    description: Tell the customer.
    execution: agent
    prompt: 'STEP:help Tell the customer the payment failed.'
    depends_on: [pay]
    trigger_rule: one_failed
`);
    const store = new InMemoryStore({ leases: createLeaseDouble() });
    const runId = (await store.create({ workflowId: def.id, workflowVersion: 1, params: {} }))
      .record.id;
    const advanced = await advanceRun(store, def, {
      runId,
      caller: 'advance',
      registry: registry(),
    });
    const before = (await store.get(runId)).record;
    const { result, run } = await drive(def, ok(), { store, runId });
    // (a) red when the exit is read from the record (its failed step makes it 1); (b) prints the
    //     earlier call's status, the record before and after, and the closing line.
    expect({
      advanced: advanced.status,
      before: { failed: before.failed_steps, ended: before.terminal_state },
      result,
      phase: run.run_phase,
      completed: run.completed_steps,
      words3: err.filter((l) => l.includes('The run completed, but')),
    }).toEqual({
      advanced: 'error',
      before: { failed: ['pay'], ended: false },
      result: 'completed',
      phase: 'completed',
      completed: ['help'],
      words3: [],
    });
  });
});

// ─── Check 8: no failure ────────────────────────────────────────────────────────────────────────

describe('gap 2 (ii-b3), check 8 — a run that completes with no failure is as before', () => {
  it('Run complete, no ✗ line, exit 0', async () => {
    const def = wf(`id: g2iib3-c8
name: c8
version: 1
steps:
  ask:
    description: Classify the ticket.
    execution: agent
    prompt: 'STEP:ask Classify the ticket.'
  note:
    description: Note it.
    execution: auto
    handler: noted
    depends_on: [ask]
`);
    const { result, run } = await drive(def, ok());
    // (a) red when the closing line or exit 1 is given with no failure; (b) prints the result, the
    //     phase and every stderr line.
    expect({
      result,
      phase: run.run_phase,
      complete: out.includes(`\nRun complete: ${run.id}`),
      err,
    }).toEqual({ result: 'completed', phase: 'completed', complete: true, err: [] });
  });
});

// ─── Words 2: order-and-routing.md's run three, in one drive ────────────────────────────────────

/** The yaml block of `page` that starts with `first`, loaded (its `extensions:` line dropped). */
function workflowOf(page: string, first: string): WorkflowDefinition {
  const block = readFileSync(join(ROOT, page), 'utf8')
    .split('```yaml\n')
    .slice(1)
    .map((b) => b.split('\n```')[0]!)
    .find((b) => b.startsWith(first));
  if (block === undefined) throw new Error(`${page}: no yaml block starts with ${first}`);
  return loadWorkflowFromString(
    block
      .split('\n')
      .filter((l) => !l.startsWith('extensions:'))
      .join('\n'),
  );
}

describe("gap 2 (ii-b3), Words 2 — order-and-routing.md's run three: realm agent runs the steps the failure allowed", () => {
  it('assess answers low risk and 500; pay fails; open_ticket and flag_large run in the same drive; exit 1', async () => {
    const def = workflowOf('docs/concepts/order-and-routing.md', 'id: refund');
    const provider = new Scripted(() => ({ risk: 'low', amount: 500 }));
    const { result, run } = await drive(def, provider, {
      registry: registry({
        // The page's module: `pay` fails for amounts over 100.
        pay: async () => {
          throw new Error('payment provider declined 500');
        },
        note: async () => ({ data: { noted: true } }),
      }),
    });
    // (a) red when the drive stops after pay's failure (open_ticket and flag_large not run, the run
    //     open); (b) prints the record and the closing line.
    expect({
      result,
      asked: provider.asked.length,
      phase: run.run_phase,
      completed: [...run.completed_steps].sort(),
      failed: run.failed_steps,
      skipped: run.skipped_steps,
      last: err.at(-1),
    }).toEqual({
      result: 'failed',
      asked: 1,
      phase: 'completed',
      completed: ['assess', 'close_books', 'flag_large', 'only_low_risk', 'open_ticket'],
      failed: ['pay'],
      skipped: ['send_receipt'],
      last: WORDS3('pay'),
    });
  });
});
