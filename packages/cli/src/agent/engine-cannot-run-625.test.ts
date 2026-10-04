// engine-cannot-run-625.test.ts — issue #625 PR-2a, decision C23: ONE class, "an engine step that
// cannot run HERE" — refused before its claim (trust, precondition, input schema) or
// capability-blocked. In `realm agent` it is named once per drive and the loop goes on with the ready
// agent steps, on every drive (a capability block's reply from the loop-top `advanceRun` is HELD).
// When no agent step is ready, no engine step can run, and an owed engine step cannot run here, the
// drive's exit is today's: the first such step takes the existing dispositions with the engine's own
// reply. Two cells per member:
//   - the other branch: the step is named once, the agent step on the other branch runs, then today's
//     exit;
//   - a single branch: after the new `cannot run here` line, the drive's screen and its
//     `drive_failures` entries equal what `d2f0b3cf` (before #625) printed and recorded on the SAME
//     fixture. The base lines below were captured by running `d2f0b3cf`'s built `runAgent` on these
//     fixtures (`.claude/worktrees/wt-pr2a-base`); the precondition member is the exception — before
//     #625 the drive re-ran that step forever (`→ [auto] x` / `✓ → running`, repeated), so there is no
//     base exit to equal, and the cell pins the build's.
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

const TRUST_REFUSAL =
  "Step 'x': 'trust: \"bogus_value\"' is not a recognized value — refused at dispatch: no gate opens and this step does not run; this run is now parked, non-terminal, until the value is corrected, and any step depending on this one returns 'blocked' in the meantime. A step's 'trust' accepts auto, human_confirmed, human_reviewed. Correct the value, then 'realm workflow register <path>' and retry this step — this run picks up the corrected definition.";
const PRECONDITION_REFUSAL =
  "Precondition failed for step 'x'. Precondition failed: 'nothing.ok == true'. Resolved value: undefined.";
const CAPABILITY_WARN =
  "warn: ⚠ Step 'x' needs handler 'missing_h', which is not registered in this runner. If reached it will block recoverably (not fail) until a runner that provides this handler executes it — load the missing extension or run on a capable runner.";
const CAPABILITY_EXIT =
  "error: \n⚠ Step 'x' is blocked: handler 'missing_h' is not registered in this runner. The run is NOT failed — add handler 'missing_h' and re-attach (`realm agent --run-id <run>`).";

/** The `cannot run here` line each member prints, once per drive. */
const CANNOT_LINE: Record<Member, string> = {
  trust: `log: • Step 'x' cannot run here (trust): ${TRUST_REFUSAL}`,
  precondition: `log: • Step 'x' cannot run here (precondition): ${PRECONDITION_REFUSAL}`,
  input_schema: "log: • Step 'x' cannot run here (input_schema): Invalid input for step 'x'",
  capability_first:
    "log: • Step 'x' cannot run here (capability): handler 'missing_h' is not registered here",
  capability_later:
    "log: • Step 'x' cannot run here (capability): handler 'missing_h' is not registered here",
};

const HEADER = ['log: \nRealm Agent — c23 v1', 'log: Run ID: <run>\n'];

/** `d2f0b3cf`'s screen on the single-branch fixture (captured; the run id normalised to `<run>`). */
const BASE_LINES: Record<Exclude<Member, 'precondition'>, string[]> = {
  trust: [...HEADER, 'log: → [auto] x', `error: \n✗ Step 'x' failed: ${TRUST_REFUSAL}`],
  input_schema: [
    ...HEADER,
    'log: → [auto] x',
    "error: \n✗ Step 'x' failed: Invalid input for step 'x'",
  ],
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
        // The exit is the first such step's own reply through the existing dispositions.
        const tail = d.lines.slice(d.lines.indexOf('log: \n→ [agent] review') + 1);
        if (member === 'trust') {
          expect(tail).toContain(`error: \n✗ Step 'x' failed: ${TRUST_REFUSAL}`);
        } else if (member === 'input_schema') {
          expect(tail).toContain("error: \n✗ Step 'x' failed: Invalid input for step 'x'");
        } else if (member === 'precondition') {
          expect(tail.at(-1)).toBe('error: \nRun ended in phase: running');
          expect(tail.join('\n')).not.toContain("✗ Step 'x'");
        } else {
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
        const rest = d.lines.filter((l) => l !== CANNOT_LINE[member]);
        if (member === 'precondition') {
          // d2f0b3cf re-ran this step forever (`→ [auto] x` then `✓ → running`, repeated): its
          // `blocked` reply has no exit in the dispositions. The drive now ends after its one attempt.
          expect(rest).toEqual([
            ...HEADER,
            'log: → [auto] x',
            'error: \nRun ended in phase: running',
          ]);
        } else {
          expect(rest).toEqual(BASE_LINES[member]);
        }
        const run = await d.store.get(d.runId);
        expect(withoutTimes(run.drive_failures?.entries as never)).toEqual(
          BASE_DRIVE_FAILURES[member],
        );
      });
    }
  });
});
