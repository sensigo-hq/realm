// docs-625-a1a.test.ts — issue #625 PR-2b (A1a): the words a user reads about `own_act`, each
// pinned word for word on its page and tied to the cell that executes it (guardrail 9).
//
// A1a adds `own_act` to a reply that did an act and then ran the chain, opens that reply's text
// with the act's words, and has `realm agent` and `realm workflow run` print the act's own ✓. These
// cells check that each page still says what A1a made true, and that the cell each sentence names
// as its proof is still there. Every assertion carries (a) the change that turns it red and (b)
// what it prints.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    page: 'CHANGELOG.md',
    words:
      "**A reply that ran a chain after your step says your step was recorded.** `execute_step`, `start_run` and `executeChain` keep `status`, `errors`, `error_code`, `agent_action` and `stopped_step` as before, and add `own_act` (`EngineReply`, beta): the called step, or the run's creation, was recorded, and the reply's text opens with it. `realm agent` prints the agent step's own ✓ and the chained steps' `→ [auto]` lines, and `realm workflow run` the agent step's own ✓, after its chain. `executeChain` takes `advanceRun`'s step callbacks. (#625)",
    cells: [CHECK_1, CHECK_7, AGENT_GATE, RUN_HASH, CHECK_2],
  },
];

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
