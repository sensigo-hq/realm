// failures-592b.test.ts — Q1 (#592) unit b (prompt q1-b-one-composer-two-carriers.md): the two
// carriers of core's one failure composer — `get_run_state`'s `failures[]` and `realm run
// inspect`'s line per failed step under `Failed:`. Checks 2 (parity, read from inspect's real
// output), 3 (an unknown word on both carriers), 4 (the crown: a failed sibling on an open fan-out
// run, before and after the seal), 8 (a run with nothing failed prints the base's lines) and 9's
// realm-run-reading.md example line, pinned by running inspect on the guide's own case.
//
// Every assertion names (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleGetRunState } from '@sensigo/realm-mcp/dist/tools/get-run-state.js';
import {
  ExtensionRegistry,
  WorkflowError,
  executeChain,
  executeStep,
  loadWorkflowFromString,
  type EvidenceSnapshot,
  type FailureView,
  type RunRecord,
  type RunStore,
  type StepHandler,
  type WorkflowDefinition,
  type WorkflowRegistrar,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { declared } from '../test-support/declared.js';
import { inspectRun } from './inspect.js';
import {
  doubleClock,
  noSettle,
  snap,
  neverPurges,
  scanning,
} from '../test-support/snapshot-double.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const workflowStoreOf = (def: WorkflowDefinition): WorkflowRegistrar =>
  declared({ register: async () => {}, get: async () => def, list: async () => [def] });

/** A run store over one hand-built record. */
const storeOver = (run: RunRecord): RunStore =>
  declared({
    persistsClaims: true,
    clock: doubleClock,
    settleStep: noSettle,
    get: async () => snap(run),
    create: async () => ({ ...snap(run), created: true }),
    update: async () => snap(run),
    scan: scanning(() => [run]),
    ...neverPurges,
    claimStep: async () => {
      throw new Error('claimStep is not used here');
    },
  });

/** The lines inspect prints under `Failed:`, up to the next line that is not indented. */
function failedBlock(out: string): string[] {
  const lines = out.split('\n');
  const at = lines.findIndex((l) => l.startsWith('Failed: '));
  if (at < 0) return [`(no Failed: line in: ${out})`];
  const block = [lines[at]!];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith('  ')) break;
    block.push(line);
  }
  return block;
}

/** The prompt's line shape, built from a reply's entry: what inspect must print for it. */
function lineOf(v: FailureView): string {
  if ('absent' in v) {
    if (v.absent === 'entry_not_found') return `  ${v.step}: no failed entry on the record`;
    const attempt = v.attempt !== undefined ? ` (attempt ${v.attempt})` : '';
    return `  ${v.step}: ${v.message}${attempt} (words not recorded: written by Realm 0.50.0 or earlier)`;
  }
  const u = (k: string) =>
    (v.unknown as string[] | undefined)?.includes(k) ? ' (unknown word)' : '';
  const clauses = [
    ...(v.stop_reason !== undefined ? [`stopped: ${v.stop_reason}${u('stop_reason')}`] : []),
    // Gap 2, unit (ii-b1): the failure's kind, between the stop reason and the action word.
    ...(v.failure_kind !== undefined ? [`kind: ${v.failure_kind}${u('failure_kind')}`] : []),
    ...(v.agent_action !== undefined ? [`next: ${v.agent_action}${u('agent_action')}`] : []),
  ];
  return (
    `  ${v.step}: ${v.code}${u('code')}` +
    (v.category !== undefined ? ` (${v.category}${u('category')})` : '') +
    (clauses.length > 0 ? ` — ${clauses.join('; ')}` : '') +
    (v.attempt !== undefined ? ` (attempt ${v.attempt})` : '') +
    ` — ${v.message}`
  );
}

const DEF: WorkflowDefinition = {
  id: 'wf-592b',
  name: 'wf 592b',
  version: 1,
  steps: {
    pay: { description: 'Pay.', execution: 'auto', depends_on: [] },
    fetch: { description: 'Fetch.', execution: 'auto', depends_on: [] },
  },
};
const entry = (over: Partial<EvidenceSnapshot> & Record<string, unknown>): EvidenceSnapshot =>
  ({
    started_at: '2026-11-21T00:00:00.000Z',
    completed_at: '2026-11-21T00:00:01.000Z',
    duration_ms: 1,
    input_summary: {},
    output_summary: {},
    status: 'error',
    evidence_hash: 'abc123def456789012345678901234567890abcd',
    ...over,
  }) as EvidenceSnapshot;
/** A failed run whose `failed_steps` are `pay` then `fetch`, with the entries given. */
const failedRun = (evidence: EvidenceSnapshot[]): RunRecord => ({
  id: 'run_592b',
  workflow_id: DEF.id,
  workflow_version: 1,
  run_phase: 'failed',
  terminal_reason: '2 steps failed.',
  completed_steps: [],
  in_progress_steps: [],
  failed_steps: ['pay', 'fetch'],
  skipped_steps: [],
  version: 1,
  params: {},
  evidence,
  created_at: '2026-11-21T00:00:00.000Z',
  updated_at: '2026-11-21T00:00:01.000Z',
  terminal_state: true,
});

async function bothCarriers(run: RunRecord) {
  const runStore = storeOver(run);
  const workflowStore = workflowStoreOf(DEF);
  const reply = await handleGetRunState(
    { run_id: run.id },
    { runStore, workflowStore: workflowStore as never },
  );
  const out = await inspectRun(run.id, runStore, workflowStore);
  return { failures: reply.failures, block: failedBlock(out) };
}

describe('Q1 (#592) unit b — check 2: one derivation, two carriers', () => {
  it('a record with a failed step that has its words and one written before them: the reply and inspect carry the same words, attempt and message', async () => {
    const { failures, block } = await bothCarriers(
      failedRun([
        entry({
          step_id: 'pay',
          error: "Handler 'pay' threw: payment provider declined 500",
          error_code: 'ENGINE_HANDLER_FAILED',
          error_category: 'ENGINE',
          agent_action: 'stop',
          stop_reason: 'no_retry_policy',
          attempt: 1,
        }),
        entry({ step_id: 'fetch', error: 'upstream returned 503', attempt: 2 }),
      ]),
    );
    // (a) red when inspect derives a line from anything but the composer's view, or the reply's
    //     view differs from the record; (b) prints the reply's failures and inspect's block.
    expect({ failures, block }).toEqual({
      failures: [
        {
          step: 'pay',
          code: 'ENGINE_HANDLER_FAILED',
          category: 'ENGINE',
          stop_reason: 'no_retry_policy',
          agent_action: 'stop',
          attempt: 1,
          message: "Handler 'pay' threw: payment provider declined 500",
        },
        {
          step: 'fetch',
          absent: 'written_before_failure_words',
          message: 'upstream returned 503',
          attempt: 2,
        },
      ],
      block: ['Failed: pay, fetch', ...failures.map(lineOf)],
    });
    expect(block.slice(1)).toEqual([
      "  pay: ENGINE_HANDLER_FAILED (ENGINE) — stopped: no_retry_policy; next: stop (attempt 1) — Handler 'pay' threw: payment provider declined 500",
      '  fetch: upstream returned 503 (attempt 2) (words not recorded: written by Realm 0.50.0 or earlier)',
    ]);
  });

  it('a clause whose word the entry lacks is left out, and a name with no failed entry says so', async () => {
    const { failures, block } = await bothCarriers(
      failedRun([entry({ step_id: 'pay', error: 'boom', error_code: 'ENGINE_INTERNAL' })]),
    );
    // (a) red when a missing word prints as undefined or a clause shell, or the absent entry is
    //     not named; (b) prints the block.
    expect(block.slice(1)).toEqual([
      '  pay: ENGINE_INTERNAL — boom',
      '  fetch: no failed entry on the record',
    ]);
    expect(block.slice(1)).toEqual(failures.map(lineOf));
  });
});

describe('Q1 (#592) unit b — check 3: an unknown word on both carriers', () => {
  it('a stop word outside the list: the reply carries it as recorded with unknown; inspect prints it with (unknown word)', async () => {
    const { failures, block } = await bothCarriers(
      failedRun([
        entry({
          step_id: 'pay',
          error: 'boom',
          error_code: 'ENGINE_INTERNAL',
          error_category: 'ENGINE',
          agent_action: 'stop',
          stop_reason: 'budget_spent' as never,
        }),
        entry({ step_id: 'fetch', error: 'old' }),
      ]),
    );
    // (a) red when the word is dropped or replaced on either carrier, or not marked unknown; (b)
    //     prints the reply's entry and inspect's line.
    expect([failures[0], block[1]]).toEqual([
      {
        step: 'pay',
        code: 'ENGINE_INTERNAL',
        category: 'ENGINE',
        stop_reason: 'budget_spent',
        agent_action: 'stop',
        message: 'boom',
        unknown: ['stop_reason'],
      },
      '  pay: ENGINE_INTERNAL (ENGINE) — stopped: budget_spent (unknown word); next: stop — boom',
    ]);
  });
});

describe('Q1 (#592) unit b — check 4: the crown — a failed sibling on an open fan-out run shows before the seal', () => {
  it('one of two independent steps fails, the other is still open: both carriers list it, the run running and unsealed; after the other completes, the run seals complete and the entry stays', async () => {
    const def: WorkflowDefinition = {
      id: 'fanout-592b',
      name: 'Fan-out',
      version: 1,
      steps: {
        fail_a: { description: 'A', execution: 'agent', depends_on: [] },
        fail_b: { description: 'B', execution: 'agent', depends_on: [] },
      },
    };
    const store = new InMemoryStore();
    const workflowStore = workflowStoreOf(def);
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeStep(store, def, {
      runId: record.id,
      command: 'fail_a',
      input: {},
      dispatcher: async () => {
        throw new Error('fail_a boom');
      },
    });
    const open = await handleGetRunState(
      { run_id: record.id },
      { runStore: store, workflowStore: workflowStore as never },
    );
    const openBlock = failedBlock(await inspectRun(record.id, store, workflowStore));
    await executeStep(store, def, {
      runId: record.id,
      command: 'fail_b',
      input: {},
      dispatcher: async () => ({}),
    });
    const sealed = await handleGetRunState(
      { run_id: record.id },
      { runStore: store, workflowStore: workflowStore as never },
    );
    const failure = {
      step: 'fail_a',
      code: 'ENGINE_INTERNAL',
      category: 'ENGINE',
      stop_reason: 'no_retry_policy',
      agent_action: 'stop',
      attempt: 1,
      message: 'Dispatcher failed: fail_a boom',
    };
    // (a) red when an open run's failed sibling is a name only on either carrier, or the seal
    //     changes, or the entry leaves at the seal; (b) prints both replies' parts and the block.
    expect({
      open: [open.run_phase, open.terminal_reason, open.failures],
      openBlock,
      sealed: [sealed.run_phase, sealed.sealed_by_arm, sealed.terminal_reason, sealed.failures],
    }).toEqual({
      open: ['running', undefined, [failure]],
      openBlock: [
        'Failed: fail_a',
        '  fail_a: ENGINE_INTERNAL (ENGINE) — stopped: no_retry_policy; next: stop (attempt 1) — Dispatcher failed: fail_a boom',
      ],
      sealed: ['completed', 'complete', 'Workflow completed.', [failure]],
    });
  });
});

describe('Q1 (#592) unit b — check 8: nothing failed, nothing new', () => {
  it('a run with Failed: (none) prints no detail line under it; the reply carries failures: []', async () => {
    const run: RunRecord = {
      ...failedRun([]),
      run_phase: 'completed',
      terminal_reason: 'Workflow completed.',
      failed_steps: [],
      completed_steps: ['pay', 'fetch'],
    };
    const { failures, block } = await bothCarriers(run);
    // (a) red when a line is printed under `Failed: (none)` or the key is missing; (b) prints both.
    expect({ failures, block }).toEqual({ failures: [], block: ['Failed: (none)'] });
  });
});

describe("Q1 (#592) unit b — check 9: realm-run-reading.md's example line, from the guide's own case", () => {
  it("handle-failure.md's sync workflow, fetch failing on every retry: inspect prints the line the page shows", async () => {
    const page = readFileSync(join(ROOT, 'docs/guides/handle-failure.md'), 'utf8');
    const yaml = /```yaml\n(id: sync[\s\S]*?)```/.exec(page)?.[1] ?? '';
    const def = loadWorkflowFromString(yaml.replace(/^extensions: .*\n/m, ''));
    const handler = (execute: StepHandler['execute']) => ({ id: 'h', execute }) as StepHandler;
    const registry = new ExtensionRegistry();
    registry.register(
      'handler',
      'fetch_record',
      handler(async () => {
        throw new WorkflowError('upstream returned 503', {
          code: 'SERVICE_RATE_LIMITED',
          category: 'SERVICE',
          agentAction: 'wait_and_proceed',
          retryable: true,
        });
      }),
    );
    registry.register(
      'handler',
      'note',
      handler(async () => ({ data: { noted: true } })),
    );
    const store = new InMemoryStore();
    const { record } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await executeStep(store, def, { runId: record.id, command: 'fetch', input: {}, registry });
    const line = failedBlock(await inspectRun(record.id, store, workflowStoreOf(def)))[1];
    const reading = readFileSync(join(ROOT, 'docs/reference/cli/realm-run-reading.md'), 'utf8');
    // (a) red when inspect prints another line for the guide's case, or the page's example is not
    //     that line; (b) prints the line and whether the page holds it.
    expect([line, reading.replace(/\s+/g, ' ').includes(`\`${line!.trim()}\``)]).toEqual([
      '  fetch: SERVICE_RATE_LIMITED (SERVICE) — stopped: attempts; next: report_to_user (attempt 3) — upstream returned 503',
      true,
    ]);
  }, 30_000);
});

describe('gap 2 (ii-b1), check 5 — the failure’s kind on both carriers', () => {
  const MODEL_DEF: WorkflowDefinition = {
    id: 'wf-g2iib1',
    name: 'wf g2iib1',
    version: 1,
    steps: {
      classify: {
        description: 'Classify.',
        execution: 'agent',
        depends_on: [],
        retry: { max_attempts: 3 },
      },
    },
  };
  /** A run whose `classify` took its failure path, through `executeChain`'s `modelFailure`. */
  async function modelFailed(
    failure: NonNullable<Parameters<typeof executeChain>[2]['modelFailure']>,
  ): Promise<{ store: InMemoryStore; runId: string }> {
    const store = new InMemoryStore();
    const { record } = await store.create({
      workflowId: MODEL_DEF.id,
      workflowVersion: 1,
      params: {},
    });
    await executeChain(store, MODEL_DEF, {
      runId: record.id,
      command: 'classify',
      input: {},
      dispatcher: async () => ({}),
      modelFailure: failure,
    });
    return { store, runId: record.id };
  }
  async function carriers(store: RunStore, runId: string) {
    const workflowStore = workflowStoreOf(MODEL_DEF);
    const reply = await handleGetRunState(
      { run_id: runId },
      { runStore: store, workflowStore: workflowStore as never },
    );
    return {
      failures: reply.failures,
      block: failedBlock(await inspectRun(runId, store, workflowStore)),
    };
  }
  const TRANSIENT = {
    kind: 'transient',
    stop_reason: 'attempts',
    message: 'Anthropic 529: overloaded (fake)',
    attempt: 3,
    error_class: 'api_status',
    status: 529,
  } as const;
  const PERMANENT = {
    kind: 'permanent',
    stop_reason: 'non_retryable',
    message: 'Anthropic 400: messages: bad (fake)',
    attempt: 1,
    error_class: 'api_status',
    status: 400,
  } as const;

  it('a transient failure written through modelFailure: the reply carries failure_kind, inspect prints `kind: transient` between stopped and next', async () => {
    const { store, runId } = await modelFailed(TRANSIENT);
    const { failures, block } = await carriers(store, runId);
    // (a) red when the composer does not read the entry's diagnostics.failure_kind (both carriers
    //     lose it), or inspect drops the clause; (b) prints the reply's entry and inspect's line.
    expect({ failures, line: block[1] }).toEqual({
      failures: [
        {
          step: 'classify',
          code: 'STEP_RETRY_EXHAUSTED',
          category: 'ENGINE',
          stop_reason: 'attempts',
          agent_action: 'report_to_user',
          failure_kind: 'transient',
          attempt: 3,
          message: 'Anthropic 529: overloaded (fake)',
        },
      ],
      line: '  classify: STEP_RETRY_EXHAUSTED (ENGINE) — stopped: attempts; kind: transient; next: report_to_user (attempt 3) — Anthropic 529: overloaded (fake)',
    });
    expect(block.slice(1)).toEqual(failures.map(lineOf));
  });

  // Under `--failure-text hidden` the kind stays: the MCP package's failures-592b.test.ts, check 5.
  it('a permanent failure written through modelFailure: `kind: permanent` on both carriers', async () => {
    const { store, runId } = await modelFailed(PERMANENT);
    const shown = await carriers(store, runId);
    // (a) red when the composer does not read the kind, or inspect drops the clause; (b) prints the
    //     reply's entry and inspect's line.
    expect({ shown: shown.failures, line: shown.block[1] }).toEqual({
      shown: [
        {
          step: 'classify',
          code: 'MODEL_REQUEST_FAILED',
          category: 'SERVICE',
          stop_reason: 'non_retryable',
          agent_action: 'report_to_user',
          failure_kind: 'permanent',
          attempt: 1,
          message: 'Anthropic 400: messages: bad (fake)',
        },
      ],
      line: '  classify: MODEL_REQUEST_FAILED (SERVICE) — stopped: non_retryable; kind: permanent; next: report_to_user (attempt 1) — Anthropic 400: messages: bad (fake)',
    });
    expect(shown.block.slice(1)).toEqual(shown.failures.map(lineOf));
  });

  it('a kind outside transient and permanent (`setup`, written by hand): kept as recorded and named in unknown; inspect prints `kind: setup (unknown word)`', async () => {
    const { failures, block } = await bothCarriers(
      failedRun([
        entry({
          step_id: 'pay',
          error: 'boom',
          error_code: 'MODEL_REQUEST_FAILED',
          error_category: 'SERVICE',
          stop_reason: 'non_retryable',
          agent_action: 'report_to_user',
          attempt: 1,
          diagnostics: {
            input_token_estimate: 0,
            precondition_trace: [],
            // A word outside the type: what a newer Realm, or a program, could have written.
            failure_kind: 'setup' as never,
          },
        }),
        entry({ step_id: 'fetch', error: 'old' }),
      ]),
    );
    // (a) red when the closure is removed (the word is not named in unknown, or is dropped), or
    //     inspect prints it without the mark; (b) prints the reply's entry and inspect's line.
    expect([failures[0], block[1]]).toEqual([
      {
        step: 'pay',
        code: 'MODEL_REQUEST_FAILED',
        category: 'SERVICE',
        stop_reason: 'non_retryable',
        agent_action: 'report_to_user',
        failure_kind: 'setup',
        attempt: 1,
        message: 'boom',
        unknown: ['failure_kind'],
      },
      '  pay: MODEL_REQUEST_FAILED (SERVICE) — stopped: non_retryable; kind: setup (unknown word); next: report_to_user (attempt 1) — boom',
    ]);
  });

  it('the words: realm-run-reading.md and the CHANGELOG say what the two cells above print', () => {
    const flat = (t: string): string => t.replace(/\s+/g, ' ');
    const reading = flat(
      readFileSync(join(ROOT, 'docs/reference/cli/realm-run-reading.md'), 'utf8'),
    );
    const changelog = flat(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'));
    // (a) red when either sentence is the old text or is removed; (b) prints whether each page holds
    //     its sentence.
    expect([
      reading.includes(
        "the error code and its category, why Realm stopped retrying, the failure's kind (`transient` or `permanent`) when the step took its failure path after a failed model request, the action word on its entry, the attempt, and the error's message",
      ),
      changelog.includes(
        "- **A failed step's kind shows where operators and assistants read a failure.** `get_run_state`'s `failures[]` gains `failure_kind` (`transient` or `permanent`) on a step that took its failure path after a failed model request, also under `--failure-text hidden`; `realm run inspect`'s line under `Failed:` gains a `kind:` clause between `stopped:` and `next:`. A failure without it shows as before.",
      ),
    ]).toEqual([true, true]);
  });
});
