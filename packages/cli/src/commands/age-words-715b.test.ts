// age-words-715b.test.ts — issue #715 (b) 03 §B.2 (D-27; D6-70, D6-72): each age and
// time-to-deadline the CLI prints is built by ONE formatter, at the reading of the snapshot it
// describes, with its instant beside it. One executed cell per row, the at-stake branch first:
//   A2/A3 `inspect`'s Gate line (opened …; EXPIRED …), A8/A9 `list`'s gate row, A13 `reclaim --all`'s
//   dry run, and E: `realm agent`'s question block names the question's deadline.
// The store's clock is a settable one in 2030 (or the dates are years in the past), so a formatter
// judging at the host's clock would print other words.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  JsonFileStore,
  JsonWorkflowStore,
  createDefaultRegistry,
  submitHumanResponse,
  stripSpanMarks,
  type PendingGate,
  type RunRecord,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { inspectRun } from './inspect.js';
import { listRuns } from './list.js';
import { runAgent } from '../agent/run-agent.js';
import { LlmProvider } from '../agent/providers/llm-provider.js';

const T = Date.parse('2030-01-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const GATED: WorkflowDefinition = {
  id: 'age-words-715b',
  name: 'age-words-715b',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    q: {
      description: 'Q.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], timeout_seconds: 60, on_expiry: 'abort' },
    },
  },
};

const workflowStore = {
  async register() {},
  async get() {
    return GATED;
  },
  async list() {
    return [GATED];
  },
};

/** A run waiting at `q`, its question opened at T and due at T + 60 s, on a store whose clock reads `readAt`. */
async function waitingAt(readAt: number) {
  const clock = settableClock(new Date(T));
  const store = new InMemoryStore({ clock });
  const { record } = await store.create({ workflowId: GATED.id, workflowVersion: 1, params: {} });
  const gate: PendingGate = {
    gate_id: 'g-715b',
    step_name: 'q',
    preview: {},
    choices: ['approve', 'reject'],
    opened_at: iso(T),
    expires_at: iso(T + 60_000),
    on_expiry: 'abort',
  };
  await store.update({
    ...record,
    run_phase: 'gate_waiting',
    in_progress_steps: ['q'],
    pending_gate: gate,
  } as RunRecord);
  await clock.set(new Date(readAt));
  return { store, runId: record.id };
}

describe('#715 (b) 03 §B.2 — inspect and list say each age with its instant, at the store’s reading', () => {
  it('A2/A3 inspect, the question past its deadline (the at-stake branch): opened 1m 30s before the reading, EXPIRED 30s ago, each with its instant', async () => {
    // (a) red when the Gate line judges at the host's clock (years later: days, not 1m/30s), drops an
    //     instant, or keeps the old `formatGateAge` words; (b) prints the Gate line.
    const { store, runId } = await waitingAt(T + 90_000);
    const out = stripSpanMarks(await inspectRun(runId, store, workflowStore));
    expect(out.split('\n').find((l) => l.startsWith('Gate: ')) ?? '(no Gate line)').toBe(
      'Gate: q (gate g-715b, opened 1m ago (2030-01-01T00:00:00Z)) — EXPIRED 30s ago (2030-01-01T00:01:00Z)',
    );
  });

  it('A2 inspect, the question still open: opened 10s ago, and no EXPIRED', async () => {
    // (a) red when an open question reads as expired, or its age is not the reading's; (b) prints it.
    const { store, runId } = await waitingAt(T + 10_000);
    const out = stripSpanMarks(await inspectRun(runId, store, workflowStore));
    expect(out.split('\n').find((l) => l.startsWith('Gate: ')) ?? '(no Gate line)').toBe(
      'Gate: q (gate g-715b, opened 10s ago (2030-01-01T00:00:00Z))',
    );
  });

  it('A8/A9 list, the question past its deadline: `gate: q opened 1m ago (…)  EXPIRED 30s ago (…)`; the time column is the stored UTC instant', async () => {
    // (a) red when the row judges at the host's clock, drops an instant, or prints the local-zone
    //     time; (b) prints the row.
    const { store, runId } = await waitingAt(T + 90_000);
    const row = (await listRuns(undefined, store)).split('\n').find((l) => l.includes(runId));
    expect(stripSpanMarks(row ?? '(no row)').replace(/^\S+ {2}\S+ v1 {2}\S+ {2}/, '')).toBe(
      '2030-01-01T00:00:00.000Z  0 step(s)  gate: q opened 1m ago (2030-01-01T00:00:00Z)  EXPIRED 30s ago (2030-01-01T00:01:00Z)',
    );
  });
});

describe('#715 (b) 03 §B.2 A13 — reclaim --all’s dry run says how far past its deadline a claim is, beside the stored deadline', () => {
  it('a claim past its deadline: `(deadline <stored>, EXPIRED <words> ago (<instant>))` — never `Nm past`', async () => {
    // (a) red when the line keeps the hand-rolled `${ageMin}m past`, or the words lose the instant;
    //     (b) prints the dry run's line.
    const home = await mkdtemp(join(tmpdir(), 'realm-715b-reclaim-'));
    const def: WorkflowDefinition = {
      id: 'reclaim-715b',
      name: 'reclaim-715b',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        fetch: { description: 'Fetch.', execution: 'agent', idempotent: true, depends_on: [] },
      },
    };
    await new JsonWorkflowStore(join(home, '.realm', 'workflows')).register(def);
    const runs = new JsonFileStore(join(home, '.realm', 'runs'));
    const { record } = await runs.create({ workflowId: def.id, workflowVersion: 1, params: {} });
    const deadline = '2020-01-01T00:00:00.123Z';
    await runs.update({
      ...record,
      in_progress_steps: ['fetch'],
      claims: { fetch: { deadline, token: 't' } },
    } as RunRecord);
    const cli = join(dirname(fileURLToPath(import.meta.url)), '../../dist/index.js');
    const r = spawnSync(process.execPath, [cli, 'run', 'reclaim', '--all'], {
      env: { PATH: process.env['PATH'] ?? '', HOME: home, NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 25_000,
    });
    const line = r.stdout.split('\n').find((l) => l.includes(record.id)) ?? `(no line) ${r.stderr}`;
    expect(line.replace(/EXPIRED \d+d \d+h ago/, 'EXPIRED <years> ago')).toBe(
      `  • ${record.id} / fetch  (deadline ${deadline}, EXPIRED <years> ago (2020-01-01T00:00:00Z))`,
    );
  }, 30_000);
});

describe('#715 (b) 03 §B.2 E — realm agent’s question block names the deadline', () => {
  it('a question with a deadline a minute after the store’s reading: `   Deadline: in 1m (<instant>)` under the ⏸ line', async () => {
    // (a) red when the block prints no deadline, or judges it at the host's clock (years later:
    //     EXPIRED); (b) prints the lines of the block.
    const clock = settableClock(new Date(T));
    const store = new InMemoryStore({ clock });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(stripSpanMarks(a.join(' ')));
    });
    const gateHandler = vi.fn(async (runId: string, gate: PendingGate) => {
      await submitHumanResponse(store, GATED, { runId, gateId: gate.gate_id, choice: 'approve' });
    });
    try {
      await runAgent(
        {
          store,
          workflowStore,
          // The workflow has no agent step: the provider is never called.
          provider: new (class extends LlmProvider {
            callStep = vi.fn();
          })(),
          registry: createDefaultRegistry(),
          gateHandler,
        },
        { definition: GATED, params: {} },
      );
    } finally {
      vi.restoreAllMocks();
    }
    const block = lines.join('\n').split('\n');
    const at = block.findIndex((l) => l.startsWith('⏸  Gate: q'));
    expect(block.slice(at, at + 2)).toEqual([
      expect.stringMatching(/^⏸ {2}Gate: q \| ID: /),
      '   Deadline: in 1m (2030-01-01T00:01:00Z)',
    ]);
  });
});
