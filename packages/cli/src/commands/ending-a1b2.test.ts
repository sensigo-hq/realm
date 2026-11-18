// ending-a1b2.test.ts — issue #625 PR-2b (A1b-2): the CLI says how a run ended, from the record
// only, exactly once. `realm agent --run-id` refuses an ended run with the one ending composer's
// sentence (checks 1 and 2); `realm workflow run` says the ending on its `Ended:` line only when no
// line it printed already said it — the owner's one-note rule (check 3); `realm run advance` says it
// for a run that had already ended, or that another program ended during the call (check 4);
// `realm run respond` says it after an answer another person's answer beat on an ended run (check 6).
// `realm agent`'s drive cells are in `../agent/ending-a1b2-agent.test.ts`.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  abandonRun,
  advanceRun,
  createDefaultRegistry,
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  executeChain,
  submitHumanResponse,
  type ExtensionRegistry,
  type RunStore,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore } from '@sensigo/realm-testing';
import { makeTempHome, type TempHome, runIds } from '../test-support/temp-home.js';
import { declared } from '../test-support/declared.js';

const mocks = vi.hoisted(() => ({ question: vi.fn(), close: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: mocks.question, close: mocks.close })),
}));

import { runCommand } from './run.js';
import { advanceRunFromShell } from './run-advance.js';
import { writerTestSeams } from '../output/writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '../../dist/index.js');
const shown = (a: unknown): string => writerTestSeams.visible(String(a));

/** A registry whose handler `name` runs `run` (a throw fails the step). */
function registryWith(handlers: Record<string, () => Promise<unknown>>): ExtensionRegistry {
  const registry = createDefaultRegistry();
  for (const [name, run] of Object.entries(handlers)) {
    registry.register('handler', name, {
      id: name,
      execute: async () => ({ data: (await run()) as Record<string, unknown> }),
    } as never);
  }
  return registry;
}

/** gate `approve` → guard `check` (aborts unless approved, with a message) → agent step `fin`. */
const GATED: WorkflowDefinition = {
  id: 'a1b2-gated',
  name: 'a1b2 gated',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    approve: {
      description: 'Approve.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'] },
    },
    check: {
      description: 'Check.',
      execution: 'guard',
      depends_on: ['approve'],
      abort_unless: ["approve.choice == 'approve'"],
      abort_message: 'Not approved.',
    },
    fin: { description: 'Fin.', execution: 'agent', depends_on: ['check'] },
  },
};

/** Two parallel `auto` steps whose handlers throw. */
const TWO_FAIL: WorkflowDefinition = {
  id: 'a1b2-two-fail',
  name: 'a1b2 two fail',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    a: { description: 'A.', execution: 'auto', depends_on: [], handler: 'boom_a' },
    b: { description: 'B.', execution: 'auto', depends_on: [], handler: 'boom_b' },
  },
};
const BOOMS = registryWith({
  boom_a: async () => {
    throw new Error('a broke');
  },
  boom_b: async () => {
    throw new Error('b broke');
  },
});

/** A gate whose time limit is 1 s and whose expiry aborts the run. */
const EXPIRING: WorkflowDefinition = {
  id: 'a1b2-expiring',
  name: 'a1b2 expiring',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: {
    approve: {
      description: 'Approve.',
      execution: 'auto',
      trust: 'human_confirmed',
      depends_on: [],
      gate: { choices: ['approve', 'reject'], timeout_seconds: 1, on_expiry: 'abort' },
    },
    fin: { description: 'Fin.', execution: 'agent', depends_on: ['approve'] },
  },
} as never;

const ONE: WorkflowDefinition = {
  id: 'a1b2-one',
  name: 'a1b2 one',
  version: 1,
  schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
  steps: { a: { description: 'A.', execution: 'agent', depends_on: [] } },
};

async function create(store: RunStore, def: WorkflowDefinition): Promise<string> {
  return (await store.create({ workflowId: def.id, workflowVersion: 1, params: {} })).record.id;
}

/** Opens GATED's gate and answers it `choice` through the engine. */
async function answered(store: RunStore, choice: string): Promise<string> {
  const id = await create(store, GATED);
  await advanceRun(store, GATED, { runId: id });
  const gate = (await store.get(id)).record.pending_gate!;
  await submitHumanResponse(store, GATED, { runId: id, gateId: gate.gate_id, choice });
  return id;
}

describe('#625 A1b-2 — checks 1 and 2: realm agent --run-id refuses an ended run with how it ended', () => {
  let h: TempHome & { readonly root: string };
  beforeEach(async () => {
    h = await makeTempHome();
    for (const def of [GATED, TWO_FAIL, EXPIRING, ONE]) await h.home.workflowStore.register(def);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  /** `realm agent --run-id <id>` from the built CLI: its exit and its stderr lines. */
  function refusal(runId: string): { code: number | null; err: string[] } {
    const r = spawnSync(
      process.execPath,
      [CLI, 'agent', '--run-id', runId, '--model', 'anthropic:fake-model-a1b2'],
      {
        cwd: h.root,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: h.root,
          NO_COLOR: '1',
          ANTHROPIC_API_KEY: 'fake-key-a1b2',
        },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    return { code: r.status, err: r.stderr.split('\n').filter((l) => l !== '') };
  }

  it('check 1 — abandoned with a reason, and with none: the sentence, never an operator, and no Reason: line (check 2)', async () => {
    const withReason = await create(h.home.runStore, ONE);
    await abandonRun(h.home.runStore, withReason, 'wrong run');
    const none = await create(h.home.runStore, ONE);
    await abandonRun(h.home.runStore, none, '');
    // (a) red when the refusal says who ended the run (`: an operator ended it`), or keeps the
    //     `Reason:` line beside the sentence that says the reason (said twice); (b) prints stderr.
    expect({ reason: refusal(withReason), none: refusal(none) }).toEqual({
      reason: {
        code: 1,
        err: [
          `Error: Run ${withReason} has already ended (abandoned). It was abandoned, with the reason "wrong run".`,
        ],
      },
      none: {
        code: 1,
        err: [
          `Error: Run ${none} has already ended (abandoned). It was abandoned; no reason was given.`,
        ],
      },
    });
  }, 120_000);

  it("check 1 — a run 'realm run cleanup' marked abandoned", async () => {
    const id = await create(h.home.runStore, ONE);
    const { record } = await h.home.runStore.get(id);
    await h.home.runStore.settleStep(id, {
      kind: 'seal_run',
      arm: 'cleanup_sweep',
      reason: 'Marked abandoned by realm cleanup',
      expected_version: record.version,
      release_claims: true,
    } as never);
    // (a) red when the refusal says an operator ended it, or prints the cleanup's stored reason on
    //     a `Reason:` line; (b) prints stderr.
    expect(refusal(id)).toEqual({
      code: 1,
      err: [
        `Error: Run ${id} has already ended (abandoned). 'realm run cleanup' marked it abandoned.`,
      ],
    });
  }, 60_000);

  it('check 1 — two failed steps: both named, never the step sealed last alone; check 2 — the step failure keeps its Reason: line', async () => {
    const id = await create(h.home.runStore, TWO_FAIL);
    // One call stops at the first failed step; the second fails the other, and the run ends.
    await advanceRun(h.home.runStore, TWO_FAIL, { runId: id, registry: BOOMS });
    await advanceRun(h.home.runStore, TWO_FAIL, { runId: id, registry: BOOMS });
    const { record } = await h.home.runStore.get(id);
    const r = refusal(id);
    // (a) red when the refusal names only `sealed_by.step` (`: step 'b' failed`), or drops the
    //     stored reason the sentence does not say; (b) prints stderr and the fixture's record.
    expect({ arm: record.sealed_by?.arm, failed: [...record.failed_steps].sort(), ...r }).toEqual({
      arm: 'step_failure',
      failed: ['a', 'b'],
      code: 1,
      err: [
        `Error: Run ${id} has already ended (failed). Steps 'a', 'b' failed.`,
        `Reason: ${JSON.stringify(record.terminal_reason)}`,
      ],
    });
  }, 60_000);

  it('check 1 — a guard abort with its message', async () => {
    const id = await answered(h.home.runStore, 'reject');
    // (a) red when the refusal names the guard without its message (`: guard 'check' ended it`);
    //     (b) prints stderr.
    expect(refusal(id)).toEqual({
      code: 1,
      err: [
        `Error: Run ${id} has already ended (aborted). Guard step 'check' aborted the run: "Not approved.".`,
      ],
    });
  }, 60_000);

  it("check 1 — a gate expiry's abort; check 2 — its Reason: line is left out (its stored reason is the sentence)", async () => {
    const id = await create(h.home.runStore, EXPIRING);
    await advanceRun(h.home.runStore, EXPIRING, { runId: id });
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await advanceRun(h.home.runStore, EXPIRING, { runId: id });
    const { record } = await h.home.runStore.get(id);
    // (a) red when the refusal keeps the `Reason:` line (the same words twice), or says the old
    //     clause; (b) prints stderr and the fixture's seal.
    expect({ arm: record.sealed_by?.arm, ...refusal(id) }).toEqual({
      arm: 'gate_expiry_abort',
      code: 1,
      err: [
        `Error: Run ${id} has already ended (aborted). Gate 'approve' expired and the run aborted per the workflow's declared on_expiry.`,
      ],
    });
  }, 60_000);
});

describe('#625 A1b-2 — check 3: realm workflow run says how the run ended exactly once (the one-note rule)', () => {
  let h: TempHome & { readonly root: string };
  let dir: string;
  let savedHome: string | undefined;
  let savedTTY: boolean | undefined;
  let out: string[];

  beforeEach(async () => {
    h = await makeTempHome();
    dir = mkdtempSync(join(tmpdir(), 'realm-a1b2-'));
    mkdirSync(join(h.root, '.realm'), { recursive: true });
    savedHome = process.env['HOME'];
    process.env['HOME'] = h.root;
    savedTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    out = [];
    for (const m of ['log', 'error', 'warn'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        out.push(...a.map(shown).join(' ').split('\n'));
      });
    }
    vi.spyOn(process, 'exit').mockImplementation(((c: number) => {
      throw new Error(`process.exit(${c})`);
    }) as never);
    mocks.question.mockReset();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedTTY === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
    else process.stdin.isTTY = savedTTY;
    if (savedHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = savedHome;
    await h.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs `realm workflow run` on `yaml`; the lines from the drive's last `→`/`⏸` on, trimmed. */
  async function drive(yaml: string): Promise<string[]> {
    writeFileSync(join(dir, 'workflow.yaml'), yaml, 'utf8');
    await runCommand.parseAsync([join(dir, 'workflow.yaml')], { from: 'user' }).catch(() => {});
    return out.map((l) => l.trimEnd()).filter((l) => l !== '');
  }
  const runId = async (): Promise<string> => (await runIds(h.home.runStore))[0]!;
  /** The lines that say the ending, from `Run complete` on. */
  const tail = (lines: string[]): string[] =>
    lines.slice(lines.findIndex((l) => l.startsWith('Run complete.')));
  const waitClosed = (opts?: { signal?: AbortSignal }): Promise<string> =>
    new Promise((_res, rej) => {
      if (opts?.signal?.aborted === true) rej(new Error('closed'));
      opts?.signal?.addEventListener('abort', () => rej(new Error('closed')));
    });

  it('check 3 — another program abandons the run while the prompt waits: Ended: with the sentence, then the way on', async () => {
    mocks.question.mockImplementation(async () => {
      await abandonRun(h.home.runStore, await runId(), 'wrong run');
      return '{}';
    });
    const lines = await drive(`id: w-abandon
name: w
version: 1
steps:
  a:
    description: a
    execution: agent
`);
    // (a) red when the line is left out, or says an operator ended the run; (b) prints the tail.
    expect(tail(lines)).toEqual([
      'Run complete. Phase: abandoned',
      '  Ended:     It was abandoned, with the reason "wrong run". To run the work again, start a new run.',
    ]);
  });

  it('check 3 — another program fails the run while the drive waits: Ended: names the failed step, then Resume:', async () => {
    let n = 0;
    mocks.question.mockImplementation((_q: string, opts?: { signal?: AbortSignal }) => {
      n += 1;
      if (n === 1) return Promise.resolve('{}');
      return (async () => {
        const id = await runId();
        const def = {
          id: 'w-fail',
          name: 'w',
          version: 1,
          steps: {
            approve: {
              description: 'approve',
              execution: 'auto',
              depends_on: [],
              trust: 'human_confirmed',
              gate: { choices: ['approve', 'reject'] },
            },
            b: { description: 'b', execution: 'auto', depends_on: ['approve'], handler: 'boom_b' },
          },
        } as unknown as WorkflowDefinition;
        const gate = (await h.home.runStore.get(id)).record.pending_gate!;
        await submitHumanResponse(h.home.runStore, def, {
          runId: id,
          gateId: gate.gate_id,
          choice: 'approve',
        });
        await advanceRun(h.home.runStore, def, { runId: id, registry: BOOMS });
        return waitClosed(opts);
      })();
    });
    const lines = await drive(`id: w-fail
name: w
version: 1
steps:
  approve:
    description: approve
    execution: auto
    trust: human_confirmed
    gate:
      choices: [approve, reject]
  b:
    description: b
    execution: auto
    depends_on: [approve]
    handler: boom_b
`);
    const id = await runId();
    // (a) red when the drive says only the phase and `Resume:` (the ending said nowhere), or says
    //     it twice; (b) prints the tail.
    expect(tail(lines)).toEqual([
      'Run complete. Phase: failed',
      "  Ended:     Step 'b' failed.",
      `  Resume:    realm run resume ${id} --from b`,
    ]);
  }, 20_000);

  it("check 3 — this drive's own chain: the guard after its step aborts (today only `✓ → aborted`): Ended: with the guard's sentence", async () => {
    mocks.question.mockImplementation(async () => '{"verdict":"stop"}');
    const lines = await drive(`id: w-chain
name: w
version: 1
steps:
  a:
    description: a
    execution: agent
  g:
    description: g
    execution: guard
    depends_on: [a]
    abort_unless: ["a.verdict == 'go'"]
    abort_message: 'not go'
  b:
    description: b
    execution: agent
    depends_on: [g]
`);
    // (a) red when the drive says only `✓ → aborted` and the phase (the ending said nowhere);
    //     (b) prints the tail.
    expect(tail(lines)).toEqual([
      'Run complete. Phase: aborted',
      `  Ended:     Guard step 'g' aborted the run: "not go".`,
    ]);
  });

  it("check 3 — this drive's answer: its guard aborts the run: the guard lines once, no Ended:", async () => {
    mocks.question
      .mockImplementationOnce(async () => '{}')
      .mockImplementation(async () => 'reject');
    const lines = await drive(`id: w-answer
name: w
version: 1
steps:
  approve:
    description: approve
    execution: auto
    trust: human_confirmed
    gate:
      choices: [approve, reject]
  check:
    description: check
    execution: guard
    depends_on: [approve]
    abort_unless: ["approve.choice == 'approve'"]
    abort_message: 'Not approved.'
  fin:
    description: fin
    execution: agent
    depends_on: [check]
`);
    // (a) red when the answer's guard lines do not set the note (the ending said twice), or the
    //     line prints on every ended run; (b) prints every line.
    expect({
      guard: lines.filter((l) => l.includes("Guard step 'check' aborted the run")),
      tail: tail(lines),
    }).toEqual({
      guard: ["  Guard step 'check' aborted the run."],
      tail: ['Run complete. Phase: aborted'],
    });
  });

  it("check 3 — the attending timer's ⏰ line ends the run: no Ended:", async () => {
    mocks.question
      .mockImplementationOnce(async () => '{}')
      .mockImplementation((_q: string, opts?: { signal?: AbortSignal }) => waitClosed(opts));
    const lines = await drive(`id: w-timer
name: w
version: 1
steps:
  approve:
    description: approve
    execution: auto
    trust: human_confirmed
    gate:
      choices: [approve, reject]
      timeout_seconds: 1
      on_expiry: abort
  fin:
    description: fin
    execution: agent
    depends_on: [approve]
`);
    // (a) red when the timer's line does not set the note (the expiry said twice); (b) prints
    //     every line.
    expect({
      timer: lines.filter((l) => l.startsWith('⏰') && l.includes('the run ended')).length,
      tail: tail(lines),
    }).toEqual({ timer: 1, tail: ['Run complete. Phase: aborted'] });
  }, 20_000);

  it("check 3 — this drive's step fails and ends the run: its ✗ line, then Resume: only, no Ended:", async () => {
    mocks.question.mockImplementation(async () => '{}');
    const lines = await drive(`id: w-fail-own
name: w
version: 1
steps:
  a:
    description: a
    execution: agent
    output_schema:
      type: object
      required: [x]
      properties:
        x: { type: string }
`);
    const id = await runId();
    // (a) red when the step's `✗` line does not set the note (the failure said twice); (b) prints
    //     the tail.
    expect(tail(lines)).toEqual([
      'Run complete. Phase: failed',
      `  Resume:    realm run resume ${id} --from a`,
    ]);
  }, 20_000);

  it('check 3 — a plainly completed run: no Ended:', async () => {
    mocks.question.mockImplementation(async () => '{}');
    const lines = await drive(`id: w-done
name: w
version: 1
steps:
  a:
    description: a
    execution: agent
`);
    // (a) red when a completed run gets an `Ended:` line; (b) prints the tail.
    expect(tail(lines)).toEqual(['Run complete. Phase: completed']);
  });
});

describe('#625 A1b-2 — check 4: realm run advance says how the run ended once', () => {
  /** `realm run advance <id>` in this process, over `store`: its lines and exit code. */
  async function advance(
    store: RunStore,
    def: WorkflowDefinition,
    id: string,
    registry?: ExtensionRegistry,
  ): Promise<{ code: 0 | 1; lines: string[] }> {
    const lines: string[] = [];
    const code = await advanceRunFromShell(
      id,
      {},
      store,
      declared({ get: async () => def }) as never,
      undefined,
      (line) => lines.push(...shown(line).split('\n')),
      registry ?? createDefaultRegistry(),
    );
    return { code, lines };
  }
  const endedLine = (lines: string[]): string[] =>
    lines.filter((l) => l.includes('the run has ended ('));

  it('check 4 — a run that had already ended, per ending: the sentence once, the resume command last', async () => {
    const store = new InMemoryStore();
    const abandoned = await create(store, ONE);
    await abandonRun(store, abandoned, 'wrong run');
    const failed = await create(store, TWO_FAIL);
    await advanceRun(store, TWO_FAIL, { runId: failed, registry: BOOMS });
    await advanceRun(store, TWO_FAIL, { runId: failed, registry: BOOMS });
    const aborted = await answered(store, 'reject');
    const completed = await create(store, ONE);
    await executeChain(store, ONE, {
      runId: completed,
      command: 'a',
      input: {},
      dispatcher: async (_c, i) => i,
    });
    // (a) red when only an abandon says how it ended (the old branch), the resume command is not
    //     last, or a plainly completed run gets a sentence; (b) prints each ended line.
    expect({
      abandoned: endedLine((await advance(store, ONE, abandoned)).lines),
      failed: endedLine((await advance(store, TWO_FAIL, failed, BOOMS)).lines),
      aborted: endedLine((await advance(store, GATED, aborted)).lines),
      completed: endedLine((await advance(store, ONE, completed)).lines),
    }).toEqual({
      abandoned: [
        'Nothing is owed to the engine: the run has ended (abandoned). It was abandoned, with the reason "wrong run". To run the work again, start a new run.',
      ],
      failed: [
        `Nothing is owed to the engine: the run has ended (failed). Steps 'a', 'b' failed. To make a failed step runnable again: realm run resume ${failed} --from <one of: a, b>`,
      ],
      aborted: [
        `Nothing is owed to the engine: the run has ended (aborted). Guard step 'check' aborted the run: "Not approved.".`,
      ],
      completed: ['Nothing is owed to the engine: the run has ended (completed).'],
    });
  });

  it('check 4 — another program ends the run during the call: the sentence once', async () => {
    const def: WorkflowDefinition = {
      id: 'a1b2-during',
      name: 'during',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'slow' },
        p: { description: 'P.', execution: 'agent', depends_on: [] },
        q: {
          description: 'Q.',
          execution: 'guard',
          depends_on: ['p'],
          abort_unless: ['p.go == true'],
          abort_message: 'p says stop',
        },
        t: { description: 'T.', execution: 'agent', depends_on: ['s', 'q'] },
      },
    };
    const store = new InMemoryStore();
    const id = await create(store, def);
    // While this call's `s` runs, another program answers `p`, and the guard its chain settles
    // aborts the run.
    const registry = registryWith({
      slow: async () => {
        await executeChain(store, def, {
          runId: id,
          command: 'p',
          input: { go: false },
          dispatcher: async (_c, i) => i,
        });
        return {};
      },
    });
    const { lines } = await advance(store, def, id, registry);
    const abandoned = await create(store, ONE);
    const { lines: abandonLines } = await advance(
      store,
      {
        ...ONE,
        steps: { s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'quit' } },
      },
      abandoned,
      registryWith({
        quit: async () => {
          await abandonRun(store, abandoned, 'stop now');
          return {};
        },
      }),
    );
    // (a) red when the run another program ended says only its phase (the old operator-only branch),
    //     or the sentence twice; (b) prints every line.
    expect(
      {
        guard: lines.filter((l) => l.includes("Guard step 'q' aborted the run")),
        abandoned: abandonLines.filter((l) => l.includes('It was abandoned')),
      },
      `${lines.join('\n')}\n---\n${abandonLines.join('\n')}`,
    ).toEqual({
      guard: [
        `Stopped: the run has ended (aborted). Guard step 'q' aborted the run: "p says stop".`,
      ],
      abandoned: [
        'Stopped: the run has ended (abandoned). It was abandoned, with the reason "stop now". To run the work again, start a new run.',
      ],
    });
  });

  it("check 4 — this call's own guard ends the run: its own lines, no second sentence", async () => {
    const store = new InMemoryStore();
    const def: WorkflowDefinition = {
      id: 'a1b2-own-guard',
      name: 'own guard',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: {
        x: { description: 'X.', execution: 'auto', depends_on: [], handler: 'nogo' },
        g: {
          description: 'G.',
          execution: 'guard',
          depends_on: ['x'],
          abort_unless: ['x.go == true'],
          abort_message: 'no go',
        },
        y: { description: 'Y.', execution: 'agent', depends_on: ['g'] },
      },
    };
    const id = await create(store, def);
    const { lines } = await advance(
      store,
      def,
      id,
      registryWith({ nogo: async () => ({ go: false }) }),
    );
    // (a) red when the call's own guard ending also gets the sentence on its `Stopped:` line (said
    //     twice), or no line says it; (b) prints every line.
    expect(
      {
        sentences: lines.filter((l) => l.includes("Guard step 'g' aborted the run")).length,
        stopped: lines.filter((l) => l.startsWith('Stopped: the run has ended')),
      },
      lines.join('\n'),
    ).toEqual({ sentences: 1, stopped: ['Stopped: the run has ended (aborted)'] });
  });

  it('check 4 — a run that completes during the call: no Stopped: line', async () => {
    const store = new InMemoryStore();
    const def: WorkflowDefinition = {
      id: 'a1b2-completes',
      name: 'completes',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { s: { description: 'S.', execution: 'auto', depends_on: [], handler: 'ok' } },
    };
    const id = await create(store, def);
    const { lines } = await advance(store, def, id, registryWith({ ok: async () => ({}) }));
    // (a) red when C37's filter compares the reason's string and the completed ending prints a
    //     `Stopped:` line; (b) prints every line.
    expect(
      lines.filter((l) => l.startsWith('Stopped:')),
      lines.join('\n'),
    ).toEqual([]);
  });
});

describe('#625 A1b-2 — check 6: realm run respond on a run that has ended', () => {
  let h: TempHome & { readonly root: string };
  beforeEach(async () => {
    h = await makeTempHome();
    await h.home.workflowStore.register(GATED);
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("check 6 — a second realm run respond on a run whose earlier answer's guard aborted it says the ending once", async () => {
    const id = await create(h.home.runStore, GATED);
    await advanceRun(h.home.runStore, GATED, { runId: id });
    const gate = (await h.home.runStore.get(id)).record.pending_gate!;
    await submitHumanResponse(h.home.runStore, GATED, {
      runId: id,
      gateId: gate.gate_id,
      choice: 'reject',
    });
    const respond = (choice: string) => {
      const r = spawnSync(
        process.execPath,
        [CLI, 'run', 'respond', id, '--gate', gate.gate_id, '--choice', choice],
        {
          cwd: h.root,
          env: { PATH: process.env['PATH'] ?? '', HOME: h.root, NO_COLOR: '1' },
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      return `${r.stdout}${r.stderr}`;
    };
    const other = respond('approve');
    const same = respond('reject');
    const sentence = `Guard step 'check' aborted the run: "Not approved.".`;
    const count = (text: string): number => text.split(sentence).length - 1;
    // (a) red when the already-answered lines leave how the run ended out, or say it twice; (b)
    //     prints both outputs.
    expect({ other: count(other), same: count(same) }, `${other}\n---\n${same}`).toEqual({
      other: 1,
      same: 1,
    });
  }, 120_000);
});
