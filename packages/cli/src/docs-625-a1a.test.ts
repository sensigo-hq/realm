// docs-625-a1a.test.ts — issue #625 PR-2b (A1a): the words a user reads about `own_act`, each
// pinned word for word on its page and tied to the cell that executes it (guardrail 9).
//
// A1a adds `own_act` to a reply that did an act and then ran the chain, opens that reply's text
// with the act's words, and has `realm agent` and `realm workflow run` print the act's own ✓. These
// cells check that each page still says what A1a made true, and that the cell each sentence names
// as its proof is still there. Every assertion carries (a) the change that turns it red and (b)
// what it prints.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ExtensionRegistry,
  WorkflowError,
  loadWorkflowFromString,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { makeTempHome, type TempHome } from './test-support/temp-home.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** A cell: the test file (from the repository root) and the start of its title. */
type Cell = readonly [file: string, title: string];

const MCP = 'packages/mcp-server/src/own-act-a1a.test.ts';
const CORE = 'packages/core/src/engine/own-act-a1a.test.ts';
const AGENT = 'packages/cli/src/agent/own-act-a1a.test.ts';
const RUN = 'packages/cli/src/commands/own-act-run-a1a.test.ts';

const CHECK_1: Cell = [MCP, 'check 1 — the real harm'];
const CHECK_7: Cell = [MCP, 'check 7 — start_run: a run whose second auto step fails'];
const GUARD_EXAMPLE: Cell = [MCP, 'tools.md’s guard example'];
const CHECK_2: Cell = [CORE, 'check 2 — the chained `send` fails'];
const CHECK_5: Cell = [CORE, 'check 5 (RF-06)'];
const CHECK_6: Cell = [CORE, 'check 6 — a race with no step after the act'];
const NOT_RECORDED: Cell = [CORE, 'item 7 — onNotRecorded is forwarded'];
const AGENT_GATE: Cell = [AGENT, 'an agent step, then an auto step, then a gate'];
const AGENT_TAKEN: Cell = [AGENT, 'a chained step another process took'];
const RUN_HASH: Cell = [RUN, 'after a chain, the ✓ shows the agent step’s own hash'];
const RUN_GATE: Cell = [RUN, 'a chain that stops at a question'];
const RUN_OWN_GATE: Cell = [RUN, 'a step waiting at its own question'];
const HERE_FILE = 'packages/cli/src/docs-625-a1a.test.ts';
const EX_REFUND: Cell = [HERE_FILE, 'the refund example: execute_step on assess'];
const EX_PRICE: Cell = [HERE_FILE, 'the price example: start_run with a quantity of -1'];
const EX_SYNC: Cell = [HERE_FILE, 'the sync example: start_run where fetch fails'];
const EX_GATE: Cell = [
  'packages/mcp-server/src/tools/docs-pages-625-guides.test.ts',
  '#729 PR-0 correction (C2): human-gates.md',
];

/** The page's sentences, each with the cells that execute it. */
const WORDS: ReadonlyArray<{ page: string; words: string; cells: readonly Cell[] }> = [
  {
    page: 'docs/reference/mcp/tools.md',
    words:
      'On an `execute_step` reply whose step was recorded and whose reply is then another\'s — a step the engine ran after it (completed, failed, blocked or opened a question), a guard its answer made end the run, a step another program took meanwhile, or the chain\'s own error — and on `start_run` when the run was created and a step it ran then failed or stopped it: `{ "command": …, "recorded": true }`. Added after version 0.49.0.',
    cells: [CHECK_1, CHECK_7, GUARD_EXAMPLE],
  },
  {
    page: 'docs/reference/mcp/tools.md',
    words:
      "The step you called finished and its answer was recorded, so do not send it again. `own_act` says so, and the reply's text opens with it.",
    cells: [CHECK_1],
  },
  {
    page: 'docs/reference/mcp/tools.md',
    words:
      "From `execute_step`, when the step you called completed, `context_hint` opens with `Step '<step>' completed.` before it (added after version 0.49.0).",
    cells: [GUARD_EXAMPLE, CHECK_5],
  },
  {
    page: 'docs/reference/mcp/tools.md',
    words: `"context_hint": "Step 'assess' completed. Guard step 'only_low_risk' aborted the run.",`,
    cells: [GUARD_EXAMPLE],
  },
  {
    page: 'docs/reference/mcp/tools.md',
    words: '"own_act": { "command": "assess", "recorded": true }',
    cells: [GUARD_EXAMPLE],
  },
  {
    page: 'docs/reference/core-library.md',
    words:
      "After a chain, `data` and `evidence` are the last step's; `own_act.evidence` is the called step's own entry.",
    cells: [CHECK_5, CHECK_2],
  },
  {
    page: 'docs/reference/core-library.md',
    words:
      "`executeChain` only: `advanceRun`'s step callbacks, called for each step it runs after the named one; `onGuard` also for the guards the named step's own answer decided. Added after version 0.49.0.",
    cells: [CHECK_2, CHECK_5, CHECK_6, NOT_RECORDED],
  },
  {
    page: 'docs/reference/cli/realm-agent.md',
    words:
      "When the engine runs `auto` steps right after an agent step's answer, the agent step's `✓ → running` is printed as the first of them starts, then each as `→ [auto] <step>`, its own `✓` as the next one starts; a step another program took gets the line that says so, and no `✓`. Added after version 0.49.0, which printed one `✓` after the whole chain, none when it stopped at a question, and no `→ [auto]` line for its steps.",
    cells: [AGENT_GATE, AGENT_TAKEN],
  },
  {
    page: 'docs/reference/cli/realm-workflow.md',
    words:
      "When the engine runs steps after the step you answered, that step's `✓` line shows the step's own hash, not the last step's, and when they stop at a question its `✓` line comes before `Gate opened for '<step>'.` A step that waits at its own question prints `Gate opened for '<step>'.` only. Added after version 0.49.0, whose `✓` line showed the last step's hash, and which printed no `✓` before a question the engine's steps reached.",
    cells: [RUN_HASH, RUN_GATE, RUN_OWN_GATE],
  },
  {
    page: 'docs/concepts/order-and-routing.md',
    words:
      "Step 'assess' completed. Step 'pay' failed. Recovery steps are available in next_actions.",
    cells: [EX_REFUND],
  },
  {
    page: 'docs/concepts/step-kinds.md',
    words:
      "Step 'assess' completed. Step 'pay' failed. Recovery steps are available in next_actions.",
    cells: [EX_REFUND],
  },
  {
    page: 'docs/concepts/step-kinds.md',
    words:
      "The first line opens with the step the call answered, `Step 'assess' completed.`, after version 0.49.0.",
    cells: [EX_REFUND],
  },
  {
    page: 'docs/guides/step-handlers.md',
    words:
      "The first line opens with the run's creation after version 0.49.0. The run ends as `failed`, unless the workflow has a step that handles the failure.",
    cells: [EX_PRICE],
  },
  {
    page: 'docs/guides/handle-failure.md',
    words:
      "Run 'e2f4a6b8-1c3d-4e5f-8a7b-9c0d1e2f3a4b' created for workflow 'sync'. Step 'fetch' failed. Run is terminated.",
    cells: [EX_SYNC],
  },
  {
    page: 'docs/guides/human-gates.md',
    words:
      "The line opens with `Step 'draft' completed.`, the step the call answered, after version 0.49.0.",
    cells: [EX_GATE],
  },
  {
    page: 'CHANGELOG.md',
    words:
      "**A reply that ran a chain after your step says your step was recorded.** `execute_step`, `start_run` and `executeChain` keep `status`, `errors`, `error_code`, `agent_action` and `stopped_step` as before, and add `own_act` (`EngineReply`, beta): the called step, or the run's creation, was recorded, and the reply's text opens with it. `realm agent` prints the agent step's own ✓ and the chained steps' `→ [auto]` lines, and `realm workflow run` the agent step's own ✓, after its chain. `executeChain` takes `advanceRun`'s step callbacks (`ExecuteChainOptions`). (#625)",
    cells: [CHECK_1, CHECK_7, AGENT_GATE, RUN_HASH, CHECK_2],
  },
];

// ── Correction 1 (MA 2's review of #1224, RD-03…05): the examples a chained reply changed ───────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** A text with every run id put as `<id>`, its white space flattened. */
const idless = (text: string): string => flat(text).replace(UUID, '<id>');

/** The page's yaml block that starts with `first`, its `extensions:` line left out (each cell
 *  registers the handlers the page's code module would). */
function workflowOf(page: string, first: string): WorkflowDefinition {
  const blocks = read(page)
    .split('```yaml\n')
    .slice(1)
    .map((b) => b.split('\n```')[0]!);
  const block = blocks.find((b) => b.startsWith(first));
  if (block === undefined) throw new Error(`${page}: no yaml block starts with ${first}`);
  return loadWorkflowFromString(
    block
      .split('\n')
      .filter((l) => !l.startsWith('extensions:'))
      .join('\n'),
  );
}

/** The lines of the page's `text` blocks, each block one string, run ids put as `<id>`. */
const textBlocks = (page: string): string[] =>
  read(page)
    .split('```text\n')
    .slice(1)
    .map((b) => idless(b.split('\n```')[0]!));

const homes: TempHome[] = [];
afterEach(async () => {
  for (const h of homes.splice(0).reverse()) await h.cleanup();
});

/** A real MCP server on a home of its own, `def` registered, `registry` its handlers. */
async function serve(def: WorkflowDefinition, registry: ExtensionRegistry) {
  const h = await makeTempHome();
  homes.push(h);
  await h.home.workflowStore.register(def);
  const server = createRealmMcpServer({
    runStore: h.home.runStore,
    traceBufferStore: h.home.traceBufferStore,
    failedAttemptStore: h.home.failedAttemptStore,
    workflowStore: h.home.workflowStore,
    registry,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'docs-625-a1a', version: '0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const raw = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: 600_000,
    })) as { content: Array<{ text: string }> };
    return JSON.parse(raw.content[0]!.text) as Record<string, unknown>;
  };
}

/** A registry holding `handlers`, each `id → execute`. */
function registryOf(handlers: Record<string, () => Promise<unknown>>): ExtensionRegistry {
  const r = new ExtensionRegistry();
  for (const [id, execute] of Object.entries(handlers)) {
    r.register('handler', id, { id, execute } as never);
  }
  return r;
}

const note = async () => ({ data: { noted: true } });

describe('#625 A1a correction 1 — each changed example, executed', () => {
  it('the refund example: execute_step on assess, whose chained pay fails — the reply opens with assess (order-and-routing.md, step-kinds.md)', async () => {
    const def = workflowOf('docs/concepts/order-and-routing.md', 'id: refund');
    const call = await serve(
      def,
      registryOf({
        // The page's module: `pay` fails for amounts over 100.
        pay: async () => {
          throw new Error('payment provider declined 500');
        },
        note,
      }),
    );
    const started = await call('start_run', { workflow_id: def.id, params: {} });
    const r = await call('execute_step', {
      run_id: started['run_id'],
      command: 'assess',
      params: { risk: 'low', amount: 500 },
    });
    // (a) red when the chained failure's hint does not open with the called step, or the pages show
    //     another text; (b) prints the hint and the error.
    expect({ hint: r['context_hint'], error: (r['errors'] as string[])[0] }).toEqual({
      hint: "Step 'assess' completed. Step 'pay' failed. Recovery steps are available in next_actions.",
      error: "Handler 'pay' threw: payment provider declined 500",
    });
    for (const page of ['docs/concepts/order-and-routing.md', 'docs/concepts/step-kinds.md']) {
      expect(flat(read(page)), page).toContain(flat(String(r['context_hint'])));
    }
  });

  it("the price example: start_run with a quantity of -1 — the reply opens with the run's creation (step-handlers.md)", async () => {
    const page = 'docs/guides/step-handlers.md';
    const def = workflowOf(page, 'id: price');
    const call = await serve(
      def,
      registryOf({
        order_total: async () => {
          throw new Error('quantity must be a positive number, got -1');
        },
      }),
    );
    const r = await call('start_run', { workflow_id: def.id, params: { quantity: -1 } });
    const shown = textBlocks(page).find((b) => b.includes("Step 'total' failed."));
    // (a) red when start_run's failure reply does not open with the creation sentence, or the page's
    //     block is not that reply's first line and its code line; (b) prints both.
    expect({
      hint: idless(String(r['context_hint'])).startsWith(
        "Run '<id>' created for workflow 'price'. Step 'total' failed. Run is terminated.",
      ),
      shown,
    }).toEqual({
      hint: true,
      shown: idless(
        `Run '<id>' created for workflow 'price'. Step 'total' failed. Run is terminated. ${String(r['error_code'])}: ${(r['errors'] as string[])[0]}`,
      ),
    });
  });

  it("the sync example: start_run where fetch fails — a handler error, every retry, a timeout — each reply opens with the run's creation (handle-failure.md)", async () => {
    const page = 'docs/guides/handle-failure.md';
    const def = workflowOf(page, 'id: sync');
    const opening =
      "Run '<id>' created for workflow 'sync'. Step 'fetch' failed. Run is terminated.";
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        'an ordinary error',
        async () => {
          throw new Error('upstream returned 503 (attempt 1)');
        },
      ],
      [
        'a retryable error, every attempt',
        async () => {
          throw new WorkflowError('upstream returned 503', {
            code: 'SERVICE_RATE_LIMITED',
            category: 'SERVICE',
            agentAction: 'wait_and_proceed',
            retryable: true,
          });
        },
      ],
      ['a fetch slower than its limit', () => new Promise((r) => setTimeout(r, 2_500))],
    ];
    const replies: string[] = [];
    for (const [, fetch] of cases) {
      const call = await serve(def, registryOf({ fetch_record: fetch, note }));
      const r = await call('start_run', { workflow_id: def.id, params: {} });
      replies.push(
        `${idless(String(r['context_hint']))} | ${String(r['error_code'])}: ${(r['errors'] as string[])[0]}`,
      );
    }
    const shown = textBlocks(page).filter((b) => b.includes("Step 'fetch' failed."));
    // (a) red when a start_run failure reply does not open with the creation sentence, or a page
    //     block is not its reply's first line and code line; (b) prints the replies and the blocks.
    expect({
      opened: replies.map((r) => r.startsWith(opening)),
      codes: replies.map((r) => r.split(' | ')[1]),
      shown,
    }).toEqual({
      opened: [true, true, true],
      codes: [
        "ENGINE_HANDLER_FAILED: Handler 'fetch_record' threw: upstream returned 503 (attempt 1)",
        "STEP_RETRY_EXHAUSTED: Step 'fetch' failed after 3 attempts",
        "STEP_TIMEOUT: Step 'fetch' timed out after 1000ms",
      ],
      shown: [
        `${opening} ENGINE_HANDLER_FAILED: Handler 'fetch_record' threw: upstream returned 503 (attempt 1)`,
        `${opening} STEP_RETRY_EXHAUSTED: Step 'fetch' failed after 3 attempts`,
        `${opening} STEP_TIMEOUT: Step 'fetch' timed out after 1000ms`,
      ],
    });
  }, 30_000);
});

describe('#625 A1a — the pages say what own_act made true, each tied to its cell', () => {
  it.each(WORDS.map((w) => [w.page, w.words.slice(0, 60), w] as const))(
    '%s: “%s…”',
    (_page, _start, w) => {
      // (a) red when the page no longer holds the sentence word for word; (b) prints the sentence.
      expect(flat(read(w.page)), `${w.page} no longer says: ${w.words}`).toContain(flat(w.words));
      // (a) red when a cell the sentence names as its proof is renamed or removed; (b) prints the
      //     cells that are not there.
      const missing = w.cells.filter(([file, title]) => !read(file).includes(title));
      expect(missing).toEqual([]);
    },
  );
});
