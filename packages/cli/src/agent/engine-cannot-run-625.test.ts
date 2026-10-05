// engine-cannot-run-625.test.ts — issue #625 PR-2a, decisions C23 and C31: ONE class, "an engine
// step that cannot run" — refused before its claim (trust, precondition, input schema; `cannot run`)
// or capability-blocked (`cannot run here`, decision C36). In `realm agent` it is named once per drive
// and the loop goes on with the ready agent steps, on every drive (a capability block's reply from the
// loop-top `advanceRun` is HELD). When no agent step is ready, no engine step can run, and an owed
// engine step cannot run, the drive stops on the FIRST such step (definition order):
//   - a refusal before the claim (decision C31) prints no `→ [auto]` line and never enters the
//     dispositions: one write-free call reads the engine's refusal, the drive failure is recorded as
//     #401's chokepoint 4 records it (input schema only), and ONE closing line names the stop;
//   - a capability block keeps the block's own exit (`→ [auto]`, then `⚠ … re-attach`).
// Two cells per member:
//   - the other branch: the step is named once, the agent step on the other branch runs, then the exit;
//   - a single branch: the screen after the named line, the result, and the `drive_failures` entries.
//     The record equals what `d2f0b3cf` (before #625) recorded on the SAME fixture, and so does the
//     capability member's screen (captured by running `d2f0b3cf`'s built `runAgent` on these fixtures,
//     `.claude/worktrees/wt-pr2a-base`). Before #625 a refusal before the claim printed
//     `→ [auto] x` / `✗ Step 'x' failed` (trust, input schema) or re-ran the step forever
//     (precondition); none of those lines is true of a step that does not run.
// Plus MR-14: with two such steps the exit names the first in definition order.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryStore } from '@sensigo/realm-testing';
import {
  advanceRun,
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type StepDefinition,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

type Member = 'trust' | 'precondition' | 'input_schema' | 'capability_first' | 'capability_later';
const MEMBERS: Member[] = [
  'trust',
  'precondition',
  'input_schema',
  'capability_first',
  'capability_later',
];

// decision C49: the view's trust refusal is #508's read-time voice (`finding`), never the dispatch
// voice — nothing was dispatched, and the agent step beside it runs.
const TRUST_REFUSAL =
  "'trust: \"bogus_value\"' is not a recognized value — the engine will refuse this step at dispatch (VALIDATION_TRUST_VALUE). Accepts auto, human_confirmed, human_reviewed — correct the value and 'realm workflow register <path>'.";
const PRECONDITION_REFUSAL =
  "Precondition failed for step 'x'. Precondition failed: 'nothing.ok == true'. Resolved value: undefined.";
// decision C37: the view's input-schema refusal names the field and what it must be; the engine's own
// message (the drive failure's) stays `Invalid input for step 'x'`.
const INPUT_REFUSAL = "Invalid input for step 'x': the input must have required property 'must'";
const CAPABILITY_WARN =
  "warn: ⚠ Step 'x' needs handler 'missing_h', which is not registered in this runner. If reached it will block recoverably (not fail) until a runner that provides this handler executes it — load the missing extension or run on a capable runner.";
const CAPABILITY_EXIT =
  "error: \n⚠ Step 'x' is blocked: handler 'missing_h' is not registered in this runner. The run is NOT failed — add handler 'missing_h' and re-attach (`realm agent --run-id <run> --provider <provider> --model <model>`).";

/** The line each member prints, once per drive (decision C36: `here` for capability only). */
const CANNOT_LINE: Record<Member, string> = {
  trust: `log: • Step 'x' cannot run (trust): ${TRUST_REFUSAL}`,
  precondition: `log: • Step 'x' cannot run (precondition): ${PRECONDITION_REFUSAL}`,
  input_schema: `log: • Step 'x' cannot run (input_schema): ${INPUT_REFUSAL}`,
  capability_first:
    "log: • Step 'x' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it",
  capability_later:
    "log: • Step 'x' cannot run here (capability): handler 'missing_h' is not registered here — load the missing extension, or run the step on a runner that has it",
};

const HEADER = ['log: \nRealm Agent — c23 v1', 'log: Run ID: <run>\n'];

type PreClaimMember = 'trust' | 'precondition' | 'input_schema';
const PRE_CLAIM: readonly Member[] = ['trust', 'precondition', 'input_schema'];

/** decision C31: the ONE closing line of a drive that stops on a step refused before its claim. */
const stopLine = (check: PreClaimMember | string, step = 'x'): string =>
  `error: \n✗ The drive stops: nothing else can run, and '${step}' cannot run (${check}). Run <run> stays open (phase 'running'): correct the workflow, register it again, then realm run advance <run>; or end it: realm run abandon <run>.`;

/** `d2f0b3cf`'s screen for a capability block on the single-branch fixture (captured). */
const BASE_CAPABILITY_LINES: Record<'capability_first' | 'capability_later', string[]> = {
  capability_first: [CAPABILITY_WARN, ...HEADER, 'log: → [auto] x', CAPABILITY_EXIT],
  capability_later: [...HEADER, 'log: → [auto] x', CAPABILITY_EXIT],
};

/** `d2f0b3cf`'s `drive_failures` entries on the single-branch fixture, without `at`/`elapsed_ms`. */
const BASE_DRIVE_FAILURES: Record<Member, unknown[]> = {
  trust: [],
  precondition: [],
  input_schema: [
    {
      step: 'x',
      provider: 'unknown',
      error_class: 'validation_rejected',
      message: "Invalid input for step 'x'",
    },
  ],
  capability_first: [],
  capability_later: [],
};

function stepX(member: Member): StepDefinition {
  const x: StepDefinition = { description: 'X', execution: 'auto', depends_on: [] };
  if (member === 'trust') (x as { trust?: unknown }).trust = 'bogus_value';
  if (member === 'precondition') x.preconditions = ['nothing.ok == true'];
  if (member === 'input_schema') {
    x.input_schema = {
      type: 'object',
      required: ['must'],
      properties: { must: { type: 'string' } },
    };
  }
  if (member.startsWith('capability')) x.handler = 'missing_h';
  return x;
}

/** Single branch: `review` waits on `x`. Other branch: `review` is ready beside `x`. */
function fixture(member: Member, otherBranch: boolean): WorkflowDefinition {
  return {
    id: 'c23-wf',
    name: 'c23',
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      x: stepX(member),
      review: {
        description: 'Review.',
        execution: 'agent',
        depends_on: otherBranch ? [] : ['x'],
      },
    },
  };
}

interface Drive {
  result: string;
  lines: string[];
  calls: number;
  runId: string;
  store: InMemoryStore;
}

/**
 * One `realm agent` drive on the fixture; for `capability_later` the run first gets its
 * `capability_blocks` marker from an earlier `advanceRun` (what an earlier drive's attempt leaves).
 */
async function drive(member: Member, otherBranch: boolean): Promise<Drive> {
  const def = fixture(member, otherBranch);
  const store = new InMemoryStore();
  const registry = createDefaultRegistry();
  let attachId: string | undefined;
  if (member === 'capability_later') {
    const { run } = await store.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    await advanceRun(store, def, { runId: run.id, registry });
    expect((await store.get(run.id)).capability_blocks?.['x']).toBeDefined();
    attachId = run.id;
  }
  const provider = new (class extends LlmProvider {
    callStep = vi.fn().mockResolvedValue({});
  })();
  const lines: string[] = [];
  for (const kind of ['log', 'error', 'warn'] as const) {
    vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
      lines.push(`${kind}: ${a.join(' ')}`);
    });
  }
  // Every member but `capability_later` drives a run the drive creates itself (so a missing
  // handler's preflight warning is part of the screen); `capability_later` attaches to the marked run.
  const result = await runAgent(
    {
      store,
      workflowStore: {
        async register() {},
        async get() {
          return def;
        },
        async list() {
          return [def];
        },
      },
      provider,
      registry,
    },
    {
      definition: def,
      params: {},
      ...(attachId !== undefined ? { existingRunId: attachId } : {}),
      inFlightPollMs: 5,
      inFlightWatchMs: 20,
    },
  );
  vi.restoreAllMocks();
  const runId = attachId ?? (await store.list())[0]!.id;
  return {
    result,
    lines: lines.map((l) => l.split(runId).join('<run>')),
    calls: provider.callStep.mock.calls.length,
    runId,
    store,
  };
}

const withoutTimes = (entries: Array<Record<string, unknown>> | undefined) =>
  (entries ?? []).map(({ at: _at, elapsed_ms: _ms, ...rest }) => rest);

describe('#625 PR-2a, decision C23 — an engine step that cannot run here', () => {
  describe('the other branch: named once, the agent step beside it runs, then today’s exit', () => {
    for (const member of MEMBERS) {
      it(`${member}`, async () => {
        const d = await drive(member, true);
        expect(d.result).toBe('failed');
        expect(d.lines.filter((l) => l === CANNOT_LINE[member])).toHaveLength(1);
        // The agent step on the other branch ran — one model call — and settled.
        expect(d.calls).toBe(1);
        const run = await d.store.get(d.runId);
        expect(run.completed_steps).toEqual(['review']);
        const tail = d.lines.slice(d.lines.indexOf('log: \n→ [agent] review') + 1);
        if (PRE_CLAIM.includes(member)) {
          // decision C31: the drive stops with ONE line — no attempt line, no `failed`, no
          // `Run ended in phase:` (the run did not end), and the step was never taken up again.
          expect(tail.at(-1)).toBe(stopLine(member));
          const all = d.lines.join('\n');
          expect(all).not.toContain('→ [auto] x');
          expect(all).not.toContain("✗ Step 'x' failed");
          expect(all).not.toContain('Run ended in phase:');
        } else {
          // capability: the block's own exit (decision C23), which is true.
          expect(tail).toContain(CAPABILITY_EXIT);
        }
        // #401's chokepoint-4 record and the drive_failing finding: as before, for the input-schema
        // member only.
        expect(withoutTimes(run.drive_failures?.entries as never)).toEqual(
          BASE_DRIVE_FAILURES[member],
        );
        // A held capability reply is the exit — the drive attempts the step once, never twice.
        if (member === 'capability_first') {
          expect(d.lines.filter((l) => l === 'log: → [auto] x')).toHaveLength(1);
        }
      });
    }
  });

  describe('a single branch: after the cannot-run line, the screen and the record are d2f0b3cf’s', () => {
    for (const member of MEMBERS) {
      it(`${member}`, async () => {
        const d = await drive(member, false);
        expect(d.result).toBe('failed');
        expect(d.calls).toBe(0);
        expect(d.lines.filter((l) => l === CANNOT_LINE[member])).toHaveLength(1);
        if (PRE_CLAIM.includes(member)) {
          // decision C31: after the named line, ONE closing line and nothing else.
          expect(d.lines).toEqual([...HEADER, CANNOT_LINE[member], stopLine(member)]);
          // The one write-free call claimed nothing and wrote nothing but the drive failure.
          const run = await d.store.get(d.runId);
          expect(run.in_progress_steps).toEqual([]);
          expect(run.completed_steps).toEqual([]);
          expect(run.evidence).toEqual([]);
        } else {
          const rest = d.lines.filter((l) => l !== CANNOT_LINE[member]);
          expect(rest).toEqual(BASE_CAPABILITY_LINES[member as 'capability_first']);
        }
        const run = await d.store.get(d.runId);
        expect(withoutTimes(run.drive_failures?.entries as never)).toEqual(
          BASE_DRIVE_FAILURES[member],
        );
      });
    }
  });

  it('MR-14: two steps that cannot run — the drive stops on the FIRST in definition order', async () => {
    // `zeta` comes first in the definition and last by name, so neither the name order nor the
    // order the checks run in can pass for definition order.
    const def: WorkflowDefinition = {
      id: 'c23-wf',
      name: 'c23',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        zeta: {
          description: 'Z',
          execution: 'auto',
          depends_on: [],
          preconditions: ['nothing.ok == true'],
        },
        alpha: {
          description: 'A',
          execution: 'auto',
          depends_on: [],
          input_schema: {
            type: 'object',
            required: ['must'],
            properties: { must: { type: 'string' } },
          },
        },
        review: { description: 'Review.', execution: 'agent', depends_on: ['zeta', 'alpha'] },
      },
    };
    const store = new InMemoryStore();
    const lines: string[] = [];
    for (const kind of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, kind).mockImplementation((...a: unknown[]) => {
        lines.push(`${kind}: ${a.join(' ')}`);
      });
    }
    const result = await runAgent(
      {
        store,
        workflowStore: {
          async register() {},
          async get() {
            return def;
          },
          async list() {
            return [def];
          },
        },
        provider: new (class extends LlmProvider {
          callStep = vi.fn().mockResolvedValue({});
        })(),
        registry: createDefaultRegistry(),
      },
      { definition: def, params: {}, inFlightPollMs: 5, inFlightWatchMs: 20 },
    );
    vi.restoreAllMocks();
    const runId = (await store.list())[0]!.id;
    expect(result).toBe('failed');
    expect(lines.at(-1)!.split(runId).join('<run>')).toBe(stopLine('precondition', 'zeta'));
    // Both are named, in definition order; only the first is the stop.
    const named = lines.filter((l) => l.startsWith('log: • Step '));
    expect(named.map((l) => l.slice('log: • Step '.length).split(' ')[0])).toEqual([
      "'zeta'",
      "'alpha'",
    ]);
    // The stop is zeta's: a precondition records no drive failure (alpha's input refusal would).
    expect((await store.get(runId)).drive_failures?.entries ?? []).toEqual([]);
  });
});
