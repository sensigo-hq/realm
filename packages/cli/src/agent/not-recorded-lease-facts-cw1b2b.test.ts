// not-recorded-lease-facts-cw1b2b.test.ts — issue #729, the claim window, unit CW-1b part 2b,
// correction 1: `realm agent`'s not-recorded line for its answer reads the lease fact of the claim
// another program holds, from the snapshot the drive holds — never the "not checked" a line reads
// when its caller leaves the snapshot out.
//   - answer: while the model answers an agent step, another program takes the step under a lease it
//     holds, and the run ends. The engine runs nothing for the answer, and `answerNotRecordedLine`
//     says the step was taken.
// The lines' words are the same with or without the fact (lease words are CW-4's), so each cell reads
// the lease argument the line gives `describeClaimHolder` (`@sensigo/realm` wrapped, everything else
// the real module): the last call before the line is printed.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@sensigo/realm', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sensigo/realm')>();
  return { ...real, describeClaimHolder: vi.fn(real.describeClaimHolder) };
});

import {
  createDefaultRegistry,
  describeClaimHolder,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  type ClaimRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, createLeaseDouble } from '@sensigo/realm-testing';
import { runAgent } from './run-agent.js';
import { LlmProvider } from './providers/llm-provider.js';

const LEASE = 'lease-cw1b2b-c1';
const PAST = '2020-01-02T03:04:05.000Z';
const HELD = { state: 'held', basis: 'kernel_lock' };

/** A store whose lease port is the double, with `LEASE` held by a program that runs. */
function leasedStore(): InMemoryStore {
  const double = createLeaseDouble();
  double.set(LEASE, 'live');
  return new InMemoryStore({ leases: double });
}

/** Another program's claim of `step`, naming `LEASE`. */
const otherClaim = (step: string): ClaimRecord => ({
  deadline: PAST,
  token: `other-${step}`,
  since: PAST,
  lease: { id: LEASE },
});

/** Writes, through the store's own `update`, another program's claim of `step` under `LEASE`. */
async function takeUnderLease(store: InMemoryStore, runId: string, step: string): Promise<void> {
  const { record } = await store.get(runId);
  await store.update({
    ...record,
    in_progress_steps: [...record.in_progress_steps.filter((s) => s !== step), step],
    claims: { ...record.claims, [step]: otherClaim(step) },
  });
}

/** The lease arguments `describeClaimHolder` was given for the other program's claim of `step`. */
const leasesFor = (step: string): unknown[] =>
  vi
    .mocked(describeClaimHolder)
    .mock.calls.filter(
      ([claim]) => claim?.since === PAST && (claim as ClaimRecord).token === `other-${step}`,
    )
    .map(([, , lease]) => lease);

const workflowStoreOf = (def: WorkflowDefinition) => ({
  async register() {},
  async get() {
    return def;
  },
  async list() {
    return [def];
  },
});

describe('#729 CW-1b part 2b, correction 1 — realm agent’s not-recorded lines read the lease fact', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(describeClaimHolder).mockClear();
  });

  it('answer: the run ended while the model answered, another program holding the step under a held lease — the line reads held', async () => {
    const def: WorkflowDefinition = {
      id: 'wf-cw1b2b-c1-answer',
      name: 'cw1b2b c1 answer',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { write: { description: 'Write.', execution: 'agent', depends_on: [] } },
    };
    const store = leasedStore();
    const { record: run } = await store.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    // While the model answers, another program takes `write` under the held lease, and the run ends
    // (a failure elsewhere: an ending other than an abandon leaves the claims in place).
    const provider = new (class extends LlmProvider {
      async callStep(): Promise<Record<string, unknown>> {
        await takeUnderLease(store, run.id, 'write');
        const { record } = await store.get(run.id);
        await store.update({
          ...record,
          run_phase: 'failed',
          terminal_state: true,
          sealed_by: { arm: 'step_failure' },
        });
        return { from: 'model' };
      }
    })();
    let atLine: unknown = 'no line';
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      const line = a.map(String).join(' ');
      lines.push(line);
      if (line.startsWith("• Step 'write' was taken") && line.includes('answer was not recorded'))
        atLine = vi.mocked(describeClaimHolder).mock.calls.at(-1)?.[2];
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runAgent(
      { store, workflowStore: workflowStoreOf(def), provider, registry: createDefaultRegistry() },
      {
        definition: def,
        existingRunId: run.id,
        params: {},
        inFlightPollMs: 5,
        inFlightWatchMs: 20,
      },
    );
    // (1) red when the answer's not-recorded line, or the test of whether it has one, is given no
    //     snapshot (the claim then reads not_checked); (2) prints every lease read for the claim, the
    //     printed line's, and the drive's lines.
    expect({ every: leasesFor('write'), atLine, lines }).toEqual({
      every: [HELD, HELD],
      atLine: HELD,
      lines,
    });
  });
});
