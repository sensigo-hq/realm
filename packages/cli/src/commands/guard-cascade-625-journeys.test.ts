// guard-cascade-625-journeys.test.ts — issue #625 (PR-1): the cells that need a real second
// process.
//
//   1. CROWN — realm's own MCP server, spawned over stdio: one `submit_human_response` call
//      settles the guard the answer makes eligible.
//   2. KILL — the built CLI answers a gate and is SIGKILLed at a varying point: no surviving
//      record is "gate answered ∧ a guard still eligible".
//   3. TWO ANSWERERS — two MCP server processes answer one gate: one answer, one guard evidence
//      entry, the loser told the phase the record has.
//   7. `realm agent --run-id` on a run an external answer moved past its guard.
//
// Every process gets a scratch HOME; nothing here reads or writes the real `~/.realm`.
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  JsonFileStore,
  JsonWorkflowStore,
  classifyRunHealth,
  deriveRunPhase,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
} from '@sensigo/realm';
import type { RunRecord, WorkflowDefinition } from '@sensigo/realm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolveMcpServerEntry } from '../agent/test-support/mcp-server-entry.js';
import { makeJourneyHome } from '../agent/test-support/composed-journey.js';

/** The built CLI. THREE `..`: commands → src → cli. */
const CLI_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
if (!existsSync(CLI_ENTRY)) {
  throw new Error(`cli dist not built — run \`npm run build\` first (looked for: ${CLI_ENTRY})`);
}

/** `write` (agent) → `confirm` (gate) → `check` (guard, aborts unless approved) [→ `finish`]. */
function journeyWorkflow(id: string, opts?: { finish?: boolean }): WorkflowDefinition {
  return {
    id,
    name: id,
    version: 1,
    schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
    steps: {
      write: { description: 'Write a draft.', execution: 'agent', depends_on: [] },
      confirm: {
        description: 'Confirm the draft.',
        execution: 'auto',
        trust: 'human_confirmed',
        depends_on: ['write'],
        gate: { choices: ['approve', 'reject'] },
      },
      check: {
        description: 'Abort unless approved.',
        execution: 'guard',
        depends_on: ['confirm'],
        abort_unless: ["confirm.choice == 'approve'"],
        abort_message: 'not approved',
      },
      ...(opts?.finish === true
        ? {
            finish: {
              description: 'Wrap up.',
              execution: 'agent' as const,
              depends_on: ['check'],
            },
          }
        : {}),
    },
  };
}

const storesOf = (home: string): { runs: JsonFileStore; workflows: JsonWorkflowStore } => ({
  runs: new JsonFileStore(join(home, '.realm', 'runs')),
  workflows: new JsonWorkflowStore(join(home, '.realm', 'workflows')),
});

type Reply = Record<string, unknown> & {
  status: string;
  run_phase?: string;
  context_hint?: string;
  gate?: { gate_id: string };
  errors?: string[];
};

/** One realm MCP server child over stdio, with its own scratch HOME. */
async function mcpClient(home: string, name: string): Promise<Client> {
  const client = new Client({ name, version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolveMcpServerEntry()],
      env: { ...process.env, HOME: home } as Record<string, string>,
    }),
  );
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
  };
  const text = result.content[0]?.text ?? '';
  try {
    return JSON.parse(text) as Reply;
  } catch {
    throw new Error(`${name} did not return a reply: ${text}`);
  }
}

/** Starts a run through the MCP server and drives it to the open gate. Returns the gate id. */
async function parkAtGate(
  client: Client,
  workflowId: string,
): Promise<{ runId: string; gateId: string }> {
  const started = await call(client, 'start_run', { workflow_id: workflowId, params: {} });
  const runId = started['run_id'];
  if (typeof runId !== 'string') {
    throw new Error(`fixture: start_run created no run: ${JSON.stringify(started)}`);
  }
  const wrote = await call(client, 'execute_step', {
    run_id: runId,
    command: 'write',
    params: { text: 'a draft' },
  });
  if (wrote.status !== 'confirm_required' || wrote.gate === undefined) {
    throw new Error(`fixture: the gate did not open: ${JSON.stringify(wrote)}`);
  }
  return { runId, gateId: wrote.gate.gate_id };
}

/** True when the guard `check` is on the record as settled — whatever its outcome. */
const guardSettled = (run: RunRecord): boolean =>
  run.completed_steps.includes('check') ||
  (run.skipped_steps ?? []).includes('check') ||
  (run.failed_steps ?? []).includes('check');

// ---------------------------------------------------------------------------
// 1. Crown
// ---------------------------------------------------------------------------

describe('issue #625 crown — gate → guard over real MCP stdio', () => {
  it('approve: ONE submit_human_response returns the guard as passed and the run completes — no call ever names the guard', async () => {
    const home = makeJourneyHome('realm-625-crown-approve-');
    const def = journeyWorkflow('crown-625-approve');
    await storesOf(home).workflows.register(def);
    const client = await mcpClient(home, 'crown-625-approve');
    try {
      const { runId, gateId } = await parkAtGate(client, def.id);

      const answered = await call(client, 'submit_human_response', {
        run_id: runId,
        gate_id: gateId,
        choice: 'approve',
      });

      // (a) red when the answer's write does not settle the guard it makes eligible — `guards`
      //     absent, the run left `running` with a guard nothing can run (the #625 dead end);
      //     (b) prints the reply's status, guards, ended_by, phase and sentence.
      expect({
        status: answered.status,
        guards: answered['guards'],
        ended_by: answered['ended_by'],
        run_phase: answered.run_phase,
        context_hint: answered.context_hint,
      }).toEqual({
        status: 'ok',
        guards: [{ step: 'check', outcome: 'pass' }],
        ended_by: { arm: 'guard_pass_complete', step: 'check' },
        run_phase: 'completed',
        context_hint: "Guard step 'check' passed and completed the run.",
      });

      const run = await storesOf(home).runs.get(runId);
      // (a) red when the stored run is not complete after the one call; (b) prints the derived
      //     phase and the completed steps.
      expect({
        phase: deriveRunPhase(run),
        completed_steps: run.completed_steps,
      }).toEqual({ phase: 'completed', completed_steps: ['write', 'confirm', 'check'] });
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('reject: the guard aborts in the same call — ended_by, the abort sentence, status ok, phase aborted', async () => {
    const home = makeJourneyHome('realm-625-crown-reject-');
    const def = journeyWorkflow('crown-625-reject');
    await storesOf(home).workflows.register(def);
    const client = await mcpClient(home, 'crown-625-reject');
    try {
      const { runId, gateId } = await parkAtGate(client, def.id);

      const answered = await call(client, 'submit_human_response', {
        run_id: runId,
        gate_id: gateId,
        choice: 'reject',
      });

      // (a) red when the answer's reply does not say the guard ended the run, names the gate
      //     step instead of the guard, or turns the applied answer into a non-ok status;
      //     (b) prints the same five fields.
      expect({
        status: answered.status,
        guards: answered['guards'],
        ended_by: answered['ended_by'],
        run_phase: answered.run_phase,
        context_hint: answered.context_hint,
      }).toEqual({
        status: 'ok',
        guards: [{ step: 'check', outcome: 'abort' }],
        ended_by: { arm: 'guard_abort', step: 'check', reason: 'not approved' },
        run_phase: 'aborted',
        context_hint: "Guard step 'check' aborted the run.",
      });

      const run = await storesOf(home).runs.get(runId);
      // (a) red when the record is not sealed by the guard; (b) prints the derived phase and the
      //     seal.
      expect({ phase: deriveRunPhase(run), sealed_by: run.sealed_by }).toEqual({
        phase: 'aborted',
        sealed_by: { arm: 'guard_abort', step: 'check' },
      });
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. Kill
// ---------------------------------------------------------------------------

describe('issue #625 kill — no surviving record is "gate answered ∧ a guard eligible"', () => {
  /** The law is checked on every round; the search runs at least this many. */
  const MIN_ROUNDS = 60;
  /** The search gives up here: the non-vacuity assertion then FAILS, printing every batch. */
  const MAX_ROUNDS = 240;
  const BATCH = 6;
  /** No batch starts once the search has run this long (with that batch's longest delay added). */
  const SEARCH_BUDGET_MS = 150_000;
  /** A batch's delays run from 0.1× to 1.6× its scale; the scale stays inside these bounds. */
  const MIN_SCALE_MS = 10;
  const MAX_SCALE_MS = 20_000;

  /** Spawns `realm run respond` for one run. */
  function answerer(home: string, runId: string, gateId: string, choice: string) {
    return spawn(
      process.execPath,
      [CLI_ENTRY, 'run', 'respond', runId, '--gate', gateId, '--choice', choice, '--project', home],
      { env: { ...process.env, HOME: home }, cwd: home, stdio: 'ignore' },
    );
  }

  it(`at least ${MIN_ROUNDS} rounds: the built CLI answers and is SIGKILLed at a varying point`, async () => {
    const home = makeJourneyHome('realm-625-kill-');
    const def = journeyWorkflow('kill-625', { finish: true });
    const { runs, workflows } = storesOf(home);
    await workflows.register(def);
    const client = await mcpClient(home, 'kill-625');
    try {
      // Calibration: how long an answer takes on THIS box under THIS cell's own concurrency — the
      // first batch's scale. Its runs are a control: an answerer nobody kills settles the guard.
      const calibration: Array<{ runId: string; gateId: string }> = [];
      for (let i = 0; i < BATCH; i++) calibration.push(await parkAtGate(client, def.id));
      const startedAt = Date.now();
      await Promise.all(
        calibration.map(
          ({ runId, gateId }) =>
            new Promise<void>((resolve) =>
              answerer(home, runId, gateId, 'approve').once('exit', () => resolve()),
            ),
        ),
      );
      const answerMs = Date.now() - startedAt;
      for (const { runId } of calibration) {
        const run = await runs.get(runId);
        // (a) red when an answerer left alone does not settle the guard; (b) prints the run's
        //     completed steps.
        expect(run.completed_steps).toEqual(['write', 'confirm', 'check']);
      }

      // The search. The machine's load can change between the calibration and any later batch, so
      // each batch is steered by what the RECORD says the previous batch did (was the answer
      // written), never by comparing clocks: no kill landed after the write ⇒ the next batch waits
      // twice as long; every kill did ⇒ half as long. It stops once both kinds are seen and at
      // least MIN_ROUNDS have run, or at the cap.
      let scale = Math.min(Math.max(answerMs, MIN_SCALE_MS), MAX_SCALE_MS);
      let rounds = 0;
      let answered = 0;
      let unanswered = 0;
      const batches: string[] = [];
      const violations: string[] = [];
      const searchStartedAt = Date.now();
      while (
        (rounds < MIN_ROUNDS || answered === 0 || unanswered === 0) &&
        rounds < MAX_ROUNDS &&
        Date.now() - searchStartedAt + 1.6 * scale < SEARCH_BUDGET_MS
      ) {
        const delays = Array.from({ length: BATCH }, (_, i) =>
          Math.round(scale * (0.1 + (1.5 * i) / (BATCH - 1))),
        );
        const parked: Array<{ runId: string; gateId: string; choice: string; delayMs: number }> =
          [];
        for (let i = 0; i < BATCH; i++) {
          const { runId, gateId } = await parkAtGate(client, def.id);
          parked.push({
            runId,
            gateId,
            choice: (rounds + i) % 2 === 0 ? 'approve' : 'reject',
            delayMs: delays[i]!,
          });
        }
        let batchAnswered = 0;
        await Promise.all(
          parked.map(async ({ runId, gateId, choice, delayMs }) => {
            const child = answerer(home, runId, gateId, choice);
            const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            child.kill('SIGKILL');
            await exited;
            const run = await runs.get(runId);
            const gateAnswered = run.settled?.['confirm'] !== undefined;
            if (gateAnswered) {
              answered += 1;
              batchAnswered += 1;
            } else {
              unanswered += 1;
            }
            const awaiting = classifyRunHealth(run, {
              now: new Date(),
              definition: def,
            }).some((f) => f.kind === 'guard_awaiting_settlement');
            if ((gateAnswered && !guardSettled(run)) || awaiting) {
              violations.push(`${runId} (choice ${choice}, killed at ${delayMs} ms)`);
            }
          }),
        );
        rounds += BATCH;
        batches.push(`${delays[0]}–${delays[BATCH - 1]} ms: ${batchAnswered} of ${BATCH} answered`);
        if (batchAnswered === 0) scale = Math.min(scale * 2, MAX_SCALE_MS);
        else if (batchAnswered === BATCH) scale = Math.max(scale / 2, MIN_SCALE_MS);
      }

      // The law, over every round. (a) red when the answer and the guard's settlement land in two
      //     writes — a kill between them leaves the gate answered and the guard undecided;
      //     (b) prints the violating run ids with their choice and kill delay.
      expect(violations).toEqual([]);
      // Non-vacuity, both directions. (a) red when the search reached its cap without seeing both
      //     a kill before the write and a kill after it (the law above was then not exercised);
      //     (b) prints the whole search on one line: the counts, the calibrated answer time and
      //     each batch's delay range with how many of its answers were written.
      const search = { answered, unanswered, rounds, answerMs, batches };
      expect(
        answered > 0 && unanswered > 0,
        `the search ended without seeing both a kill before the write and one after it: ${JSON.stringify(search)}`,
      ).toBe(true);
    } finally {
      await client.close();
      rmSync(home, { recursive: true, force: true });
    }
    // Worst case: the calibration, SEARCH_BUDGET_MS of batches, and one last batch (its parking
    // plus at most 1.6 × MAX_SCALE_MS) — this timeout leaves room for all of them, so a search that
    // fails reports its own message, not vitest's timeout.
  }, 300_000);
});

// ---------------------------------------------------------------------------
// 3. Two answerers
// ---------------------------------------------------------------------------

describe('issue #625 two answerers — one answer, one guard entry, the loser told the true phase', () => {
  it('10 rounds: two MCP server processes answer one gate with different choices', async () => {
    const home = makeJourneyHome('realm-625-two-');
    const def = journeyWorkflow('two-625', { finish: true });
    const { runs, workflows } = storesOf(home);
    await workflows.register(def);
    const first = await mcpClient(home, 'two-625-a');
    const second = await mcpClient(home, 'two-625-b');
    try {
      for (let round = 0; round < 10; round++) {
        const { runId, gateId } = await parkAtGate(first, def.id);
        // Alternate which process sends which choice, so neither is always first on the wire.
        const [approveBy, rejectBy] = round % 2 === 0 ? [first, second] : [second, first];
        const replies = await Promise.all([
          call(approveBy, 'submit_human_response', {
            run_id: runId,
            gate_id: gateId,
            choice: 'approve',
          }),
          call(rejectBy, 'submit_human_response', {
            run_id: runId,
            gate_id: gateId,
            choice: 'reject',
          }),
        ]);
        const run = await runs.get(runId);
        const phase = deriveRunPhase(run);
        const winners = replies.filter((r) => r.status === 'ok');
        const losers = replies.filter((r) => r.status !== 'ok');

        // (a) red when both answers are recorded, the guard is evaluated twice, or neither
        //     process is refused; (b) prints the counts for the round.
        expect({
          round,
          gateResponses: run.evidence.filter((e) => e.kind === 'gate_response').length,
          guardEntries: run.evidence.filter((e) => e.step_id === 'check').length,
          winners: winners.length,
          losers: losers.length,
        }).toEqual({ round, gateResponses: 1, guardEntries: 1, winners: 1, losers: 1 });
        // The winner's reply reports the guard its own write settled.
        // (a) red when the winning answer's write did not settle the guard; (b) prints its
        //     guards.
        expect((winners[0]!['guards'] as unknown[] | undefined)?.length).toBe(1);
        // Both are told the phase the record has — the loser is not told `gate_waiting` or
        // `running` for a run the winner's guard aborted.
        // (a) red when the loser's refusal carries a phase read before the winner's write;
        //     (b) prints both replies' phases beside the record's.
        expect({
          round,
          winner: winners[0]!.run_phase,
          loser: losers[0]!.run_phase,
        }).toEqual({ round, winner: phase, loser: phase });
        // The loser's reply reports no guard of its own — it wrote nothing.
        // (a) red when a refused answer claims a guard settlement; (b) prints its guards.
        expect(losers[0]!['guards']).toBeUndefined();
      }
    } finally {
      await first.close();
      await second.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 7. `realm agent --run-id` after an external answer
// ---------------------------------------------------------------------------

describe('issue #625 `realm agent --run-id` on a run an external answer moved past its guard', () => {
  /** No model is reachable: the base URL is a closed local port. */
  const agent = (home: string, runId: string) =>
    spawnSync(
      process.execPath,
      [
        CLI_ENTRY,
        'agent',
        '--run-id',
        runId,
        '--provider',
        'openai',
        '--base-url',
        'http://127.0.0.1:9',
      ],
      {
        env: { ...process.env, HOME: home, OPENAI_API_KEY: 'not-a-key' },
        cwd: home,
        encoding: 'utf8',
      },
    );

  it('gate → guard → agent step: the guard is already settled, and the agent reaches the agent step', async () => {
    const home = makeJourneyHome('realm-625-agent-on-');
    const def = journeyWorkflow('agent-625-on', { finish: true });
    const { runs, workflows } = storesOf(home);
    await workflows.register(def);
    const client = await mcpClient(home, 'agent-625-on');
    let runId: string;
    try {
      const parked = await parkAtGate(client, def.id);
      runId = parked.runId;
      await call(client, 'submit_human_response', {
        run_id: runId,
        gate_id: parked.gateId,
        choice: 'approve',
      });
    } finally {
      await client.close();
    }

    const out = agent(home, runId);
    const screen = `${out.stdout}\n${out.stderr}`;

    // No model is reachable, so the call itself fails; what is pinned is that the agent step
    // was REACHED. (a) red when the answer left the guard undecided — the agent finds nothing
    // it can drive and prints "Run ended in phase: running"; (b) prints the agent's whole
    // output.
    expect(screen).toContain('→ [agent] finish');
    expect(screen).not.toContain('Run ended in phase: running');
    // (a) red when the guard was not settled before the agent attached; (b) prints the record's
    //     completed steps.
    expect((await runs.get(runId)).completed_steps).toEqual(['write', 'confirm', 'check']);
    rmSync(home, { recursive: true, force: true });
  }, 120_000);

  it('a run the guard ended: the existing terminal-state refusal naming the phase, exit 1 — never "phase: running"', async () => {
    const home = makeJourneyHome('realm-625-agent-ended-');
    const def = journeyWorkflow('agent-625-ended');
    const { runs, workflows } = storesOf(home);
    await workflows.register(def);
    const client = await mcpClient(home, 'agent-625-ended');
    let runId: string;
    try {
      const parked = await parkAtGate(client, def.id);
      runId = parked.runId;
      await call(client, 'submit_human_response', {
        run_id: runId,
        gate_id: parked.gateId,
        choice: 'reject',
      });
    } finally {
      await client.close();
    }

    const out = agent(home, runId);
    const screen = `${out.stdout}\n${out.stderr}`;

    // (a) red when the answer left the run `running` with its guard undecided (the agent then
    //     attaches, finds nothing and prints "Run ended in phase: running"); (b) prints the exit
    //     code and the whole output.
    expect({ status: out.status, screen }).toMatchObject({ status: 1 });
    expect(screen).toContain(`Run ${runId} is already in terminal state: aborted`);
    expect(screen).not.toContain('Run ended in phase: running');
    expect(deriveRunPhase(await runs.get(runId))).toBe('aborted');
    rmSync(home, { recursive: true, force: true });
  }, 120_000);
});
