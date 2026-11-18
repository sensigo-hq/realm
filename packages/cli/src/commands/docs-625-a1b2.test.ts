// docs-625-a1b2.test.ts — issue #625 PR-2b (A1b-2): the words a user reads about how the CLI says a
// run ended, each pinned word for word on its page and tied to the cell that executes it (guardrail
// 9). Its existence also ends A1b-1's release hold: A1b-1 and A1b-2 ship in one release, and A1b-1's
// release cell (deleted by this unit) held the release until this file existed.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** A cell: the test file (from the repository root) and the start of its title. */
type Cell = readonly [file: string, title: string];

const CMD = 'packages/cli/src/commands/ending-a1b2.test.ts';
const AGENT = 'packages/cli/src/agent/ending-a1b2-agent.test.ts';
const REFUSAL_ABANDON: Cell = [CMD, 'check 1 — abandoned with a reason, and with none'];
const REFUSAL_CLEANUP: Cell = [CMD, "check 1 — a run 'realm run cleanup' marked abandoned"];
const REFUSAL_FAILED: Cell = [CMD, 'check 1 — two failed steps'];
const REFUSAL_GUARD: Cell = [CMD, 'check 1 — a guard abort with its message'];
const REFUSAL_EXPIRY: Cell = [CMD, "check 1 — a gate expiry's abort"];
const I11: Cell = [
  'packages/cli/src/commands/records-disclosure-729.test.ts',
  "I-11: `realm agent --run-id` reads an ended run's manifest before its refusal",
];
const RUN_ABANDON: Cell = [
  CMD,
  'check 3 — another program abandons the run while the prompt waits',
];
const RUN_FAILED: Cell = [CMD, 'check 3 — another program fails the run while the drive waits'];
const RUN_CHAIN: Cell = [CMD, "check 3 — this drive's own chain"];
const RUN_ANSWER: Cell = [CMD, "check 3 — this drive's answer"];
const RUN_TIMER: Cell = [CMD, "check 3 — the attending timer's ⏰ line"];
const RUN_DONE: Cell = [CMD, 'check 3 — a plainly completed run'];
const MAP_FAILED: Cell = [
  'packages/cli/src/commands/docs-pages-625-workflow-reading.test.ts',
  'the run ended with a failed step while the prompt waited',
];
const MAP_UNITS: Cell = [
  'packages/cli/src/commands/run-detach.test.ts',
  'an ended run: `Resume:` names the failed steps',
];
const RUN_FAIL_OWN: Cell = [CMD, "check 3 — this drive's step fails and ends the run"];
const AGENT_CHAIN: Cell = [AGENT, "check 3 — the engine's work"];
const AGENT_A6: Cell = [AGENT, 'check 3 (A6)'];
const AGENT_FAIL: Cell = [AGENT, 'check 3 — a step the chain runs after this drive’s step fails'];
const AGENT_TIMER: Cell = [AGENT, "check 3 — the terminal fallback's ⏰ line"];
const AGENT_SLACK_OWN: Cell = [AGENT, 'check 3 — a Slack answer of its own'];
const AGENT_SLACK_OTHER: Cell = [AGENT, 'check 3 — a Slack answer refused'];
const ADV_ENDED: Cell = [CMD, 'check 4 — a run that had already ended'];
const ADV_DURING: Cell = [CMD, 'check 4 — another program ends the run during the call'];
const ADV_OWN: Cell = [CMD, "check 4 — this call's own guard"];
const ADV_DONE: Cell = [CMD, 'check 4 — a run that completes during the call'];
const RESPOND: Cell = [CMD, 'check 6 — a second realm run respond'];
const INSPECT: Cell = [
  'packages/cli/src/commands/operator-ending-625.test.ts',
  'realm run inspect: the Resumable: line',
];

/** The `Ended:` sentence, the same on both drives' pages. */
const ENDED =
  "When the run did not complete and nothing the command printed has said how it ended — another program ended it, or a guard after a step ended it — a line says it, read from the run's record only, once: `  Ended:     <how it ended>`, such as `  Ended:     Step '<step>' failed.` or `  Ended:     Guard step '<step>' aborted the run: \"<message>\".`; for an abandoned run with the way on, `  Ended:     It was abandoned, with the reason \"<reason>\". To run the work again, start a new run.` (`It was abandoned; no reason was given.` when none was given), never `realm run resume`, which would erase that ending and its reason. A line above that already said it — the step's `✗` line, the guard's lines after an answer, the `⏰` or `⚠` line of a question whose time limit ended the run — means no `Ended:` line (added after version 0.50.0, which gave the line for an abandoned run only, and said an operator ended it).";

/** A1b-2's CHANGELOG line, as the prompt writes it. */
const CHANGED =
  "- **The CLI says how a run ended, from the record only.** `realm agent --run-id` refuses an ended run with the sentence for how it ended, naming the steps that failed, and never says an operator ended it. The `Ended:` line of `realm workflow run` and `realm agent` says it for every ending the command had not already printed, once (before, only an abandon), so `realm workflow run` no longer shows \"aborted\" without why. `realm run advance`'s `Stopped:` line says it for a run that had already ended or that another program ended during the call, whatever the ending (before, only an abandon), and `realm run respond` says it when the question's run has ended. `realm run inspect` no longer calls an abandon an operator's ending. (#625)";

/** The pages' sentences, each with the cells that execute it. */
const WORDS: ReadonlyArray<{ page: string; words: string; cells: readonly Cell[] }> = [
  {
    page: 'docs/reference/cli/realm-listen.md',
    words:
      "`realm agent --run-id` refuses it with `Error: Run <run-id> has already ended (<phase>).`, then one sentence of how it ended, read from the run's record only — `Steps '<a>', '<b>' failed.`, `Guard step '<step>' aborted the run: \"<message>\".`, `It was abandoned, with the reason \"<reason>\".`, and so on, none for a run that simply completed (added after version 0.50.0, which said who ended it instead, such as `: an operator ended it`)",
    cells: [REFUSAL_ABANDON, REFUSAL_CLEANUP, REFUSAL_FAILED, REFUSAL_GUARD, REFUSAL_EXPIRY],
  },
  {
    page: 'docs/reference/cli/realm-listen.md',
    words:
      'for a run that failed or was aborted, `Reason: "<reason>"` on its own line — the run\'s recorded end reason, as written — when the sentence does not already say it;',
    cells: [REFUSAL_FAILED, REFUSAL_EXPIRY, REFUSAL_ABANDON],
  },
  {
    page: 'docs/reference/cli/realm-agent.md',
    words:
      "For any other ending, one sentence of how it ended follows on the same line, from the record only (added after version 0.50.0). A `Reason:` line follows when the sentence does not say the stored reason: a step's failure, a handler's abort, a guard's resolution error, or a failed or aborted record with no seal; for an abandoned run the reason is inside the sentence. Either way it is stored text, masked like the record's values, and shown as its type and size while",
    cells: [REFUSAL_ABANDON, REFUSAL_FAILED, REFUSAL_GUARD, I11],
  },
  {
    page: 'docs/reference/cli/realm-agent.md',
    words: ENDED,
    cells: [AGENT_CHAIN, AGENT_FAIL, AGENT_A6, AGENT_TIMER, AGENT_SLACK_OWN, AGENT_SLACK_OTHER],
  },
  {
    page: 'docs/reference/cli/realm-workflow.md',
    words: ENDED,
    cells: [RUN_ABANDON, RUN_FAILED, RUN_CHAIN, RUN_ANSWER, RUN_TIMER, RUN_FAIL_OWN, RUN_DONE],
  },
  {
    page: 'docs/reference/cli/realm-workflow.md',
    words:
      'Before them, an `Ended:` line says how the run ended, as the last line does below, when nothing the command printed has said it (added after version 0.50.0).',
    cells: [MAP_FAILED, MAP_UNITS],
  },
  {
    page: 'docs/reference/cli/realm-run-acting.md',
    words:
      "when the run had already ended as the command read it, or another program ended it during the call, it goes on with one sentence of how it ended, read from the run's record only — `. Step '<step>' failed.`, `. Guard step '<step>' aborted the run.`, `. It was abandoned, with the reason \"<reason>\".` (`It was abandoned; no reason was given.` when none was given), and so on, none for a run that simply completed — then, for an abandoned run, ` To run the work again, start a new run.`, never `realm run resume`, which would erase that ending and its reason, and, for a failed run with a step `realm run resume` takes, ` To make '<step>' runnable again: realm run resume <id> --from <step>` (added after version 0.50.0, which said how it ended only for an abandoned run, and said an operator ended it); when this call's own step, guard or expiry ended the run, its own lines above say how",
    cells: [ADV_ENDED, ADV_DURING, ADV_OWN, ADV_DONE],
  },
  {
    page: 'docs/reference/cli/realm-run-reading.md',
    words:
      "For an abandoned run, the `Resumable:` line goes on `— resuming erases this ending and its reason, and records no one and no reason for the undo` (added after version 0.50.0, which said `the operator's ending`).",
    cells: [INSPECT],
  },
  {
    page: 'CHANGELOG.md',
    words: CHANGED,
    cells: [
      REFUSAL_FAILED,
      RUN_CHAIN,
      RUN_ABANDON,
      AGENT_CHAIN,
      ADV_ENDED,
      ADV_DURING,
      RESPOND,
      INSPECT,
    ],
  },
];

describe('#625 A1b-2 — the pages say how the CLI says a run ended, each sentence tied to its cell', () => {
  it.each(WORDS.map((w) => [w.page, w.words.slice(0, 60), w] as const))(
    '%s: “%s…”',
    (_page, _start, w) => {
      // (a) red when the page no longer holds the sentence word for word; (b) prints it.
      expect(flat(read(w.page)), `${w.page} no longer says: ${w.words}`).toContain(flat(w.words));
      // (a) red when a cell the sentence names as its proof is renamed or removed; (b) prints the
      //     cells that are not there.
      const missing = w.cells.filter(([file, title]) => !read(file).includes(title));
      expect(missing).toEqual([]);
    },
  );
});
