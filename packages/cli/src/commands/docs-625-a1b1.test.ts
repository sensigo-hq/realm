// docs-625-a1b1.test.ts — issue #625 PR-2b (A1b-1): the words a user reads about how a run ended,
// each pinned word for word on its page and tied to the cell that executes it (guardrail 9); and
// the release rule: A1b-1 and A1b-2 (the CLI screens) ship in one release.
//
// A1b-1 gives each ending one sentence, read from the run's record only, and an abandoned run no
// longer says "an operator ended" it. These cells check that each page says what A1b-1 made true,
// and that the cell each sentence names as its proof is still there. Every assertion carries (a)
// the change that turns it red and (b) what it prints.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** A cell: the test file (from the repository root) and the start of its title. */
type Cell = readonly [file: string, title: string];

const MCP = 'packages/mcp-server/src/ending-a1b1.test.ts';
const CLI = 'packages/cli/src/commands/operator-ending-625.test.ts';
const EVERY_ENDING: Cell = [MCP, 'check 1 — %s'];
const NO_SEAL: Cell = [MCP, 'check 1 — a record with no seal'];
const NO_ACTOR: Cell = [MCP, 'check 2 — no actor'];
const TWO_FAILED: Cell = [MCP, 'check 3 — two failed steps'];
const GUARD_MESSAGE: Cell = [MCP, 'check 4 — guard_abort with a message'];
const HOW_KNOWN: Cell = [MCP, 'check 5 — how known'];
const ENDED_BEFORE: Cell = [MCP, 'check 6 — on a run already ended'];
const OWN_ACT: Cell = [MCP, 'check 6 — this call’s own act'];
const M1: Cell = [MCP, 'check 6 (M1)'];
const M2: Cell = [MCP, 'check 6 (ii) and M2'];
const ZOMBIE: Cell = [MCP, 'check 6 — the zombie refusal'];
const WAY_OUT: Cell = [MCP, 'check 7 — the way out'];
const D5: Cell = [MCP, 'check 8 (D5)'];
const SECOND_ANSWER: Cell = [MCP, 'correction 1 (WK-08)'];
const CLI_ADVANCE: Cell = [CLI, 'realm run advance: the ended reason goes on'];
const CLI_RUN: Cell = [CLI, 'realm workflow run’s hand-back'];
const CLI_AGENT: Cell = [CLI, 'realm agent whose run an operator ends during the drive'];

const TOOLS = 'docs/reference/mcp/tools.md';

/** A1b-1's CHANGELOG lines, as the prompt writes them. */
const CHANGED =
  "- **`execute_step`, `advance_run`, `start_run` and `submit_human_response`, on a run that had already ended, say how it ended, from the record only.** One sentence per ending: which steps failed, which step or guard aborted it, a question's time-limit default or abort, 'realm run cleanup', the reason an abandon was given, or a record whose ending was worked out without a seal. An abandoned run no longer says an operator ended it: the record does not say who. (#625)";
const UPGRADING =
  '**3. `advance_run` (and `advanceRun` in the library) on a run that had already ended now returns `agent_action` / `intrinsic_action` `stop` (it had none).**';

/** The page's sentences, each with the cells that execute it. */
const WORDS: ReadonlyArray<{ page: string; words: string; cells: readonly Cell[] }> = [
  {
    page: TOOLS,
    words:
      "When someone other than the call ended the run — it had ended before the call, or another program ended it during the call — the ways back in come after one sentence of how it ended, read from the run's record only; a reply whose own step, chained step or answer ended the run says so in its own words instead (added after version 0.50.0",
    cells: [ENDED_BEFORE, M1, M2, OWN_ACT],
  },
  {
    page: TOOLS,
    words:
      "How a run ended is one sentence, and never says who ended it (added after version 0.50.0): `It completed.`; `The answer on step '<step>' completed the run.`; `Guard step '<step>' passed and completed the run.`; `The question on step '<step>' reached its time limit, and its declared default completed the run.`; `Step '<step>' failed.` (`Steps '<a>', '<b>' failed.` for several);",
    cells: [EVERY_ENDING, TWO_FAILED],
  },
  {
    page: TOOLS,
    words:
      "`Guard step '<step>' aborted the run: \"<message>\".` (`Guard step '<step>' aborted the run.` when the guard has no message); `Gate '<step>' expired and the run aborted per the workflow's declared on_expiry.`; `It was abandoned, with the reason \"<reason>\".` (`It was abandoned; no reason was given.` when none was given); `'realm run cleanup' marked it abandoned.`;",
    cells: [EVERY_ENDING, GUARD_MESSAGE, NO_ACTOR],
  },
  {
    page: TOOLS,
    words:
      "`Its ending was worked out from its record (phase '<phase>'); no seal was written.` A seal `realm run migrate` wrote adds ` (classified when its record was migrated)` before the sentence's full stop.",
    cells: [NO_SEAL, HOW_KNOWN],
  },
  {
    page: TOOLS,
    words:
      '`ok` with `agent_action: "stop"` (added after version 0.50.0, which gave none): `Run \'<id>\' is already terminal (<phase>); nothing ran.`, then how the run ended (added after version 0.50.0)',
    cells: [D5, ENDED_BEFORE],
  },
  {
    page: TOOLS,
    words:
      'saying how the run ended, then the way out for that kind of ending (the sentence of how it ended, and these words, added after version 0.50.0): `Nothing is owed.` for a completed run,',
    cells: [WAY_OUT, ENDED_BEFORE],
  },
  {
    page: TOOLS,
    words:
      "`To run the work again, start a new run; 'realm run purge <id>' previews what it would remove.` for an abandoned one (never `realm run resume`, which would erase its ending and its reason);",
    cells: [WAY_OUT],
  },
  {
    page: TOOLS,
    words:
      'and its `context_hint` is the refusal that another gate ID gets (added after version 0.49.0), without the sentence of how the run ended, which its time limit already says (added after version 0.50.0).',
    cells: [ZOMBIE],
  },
  {
    page: TOOLS,
    words: 'On a run that has ended, both then say how it ended (added after version 0.50.0).',
    cells: [SECOND_ANSWER],
  },
  {
    page: 'docs/reference/cli/realm-workflow.md',
    words:
      'When the run was abandoned, that line says how it ended and the way on: `  Ended:     It was abandoned, with the reason "<reason>". To run the work again, start a new run.`',
    cells: [CLI_RUN],
  },
  {
    page: 'docs/reference/cli/realm-agent.md',
    words:
      'When the run was abandoned, that line says how it ended and the way on: `  Ended:     It was abandoned, with the reason "<reason>". To run the work again, start a new run.`',
    cells: [CLI_AGENT],
  },
  {
    page: 'docs/reference/cli/realm-run-acting.md',
    words:
      'when it was abandoned, it goes on `. It was abandoned, with the reason "<reason>". To run the work again, start a new run.`',
    cells: [CLI_ADVANCE],
  },
  {
    page: 'docs/concepts/evidence.md',
    words: 'The run was abandoned, with `realm run abandon` or `abandon_run`.',
    cells: [NO_ACTOR],
  },
  {
    page: 'docs/concepts/workflows-steps-and-runs.md',
    words: 'The run was abandoned (`realm run abandon`, `abandon_run` or `realm run cleanup`).',
    cells: [NO_ACTOR],
  },
  {
    page: 'CHANGELOG.md',
    words: CHANGED,
    cells: [EVERY_ENDING, ENDED_BEFORE, NO_ACTOR],
  },
  {
    page: 'CHANGELOG.md',
    words: UPGRADING,
    cells: [D5],
  },
];

describe('#625 A1b-1 — the pages say how a run ended, each sentence tied to its cell', () => {
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

describe('#625 A1b-1 — the release rule: A1b-1 and A1b-2 ship in one release', () => {
  it('A1b-1’s CHANGELOG lines stay under the literal [Unreleased] heading until A1b-2 has landed', () => {
    // A1b-2 creates this file, and deletes this cell.
    if (existsSync(join(ROOT, 'packages/cli/src/commands/docs-625-a1b2.test.ts'))) return;
    const text = read('CHANGELOG.md');
    const start = text.indexOf('\n## [Unreleased]\n');
    const end = start === -1 ? -1 : text.indexOf('\n## [', start + 1);
    const section = start === -1 ? '' : text.slice(start, end === -1 ? undefined : end);
    // (a) red when a release renames [Unreleased] (or moves A1b-1's lines out of it) before A1b-2
    //     has landed; read without the house CHANGELOG reader, which reads every section above
    //     [0.49.0] and would stay green; (b) prints the rule.
    expect(
      section.includes(CHANGED) && section.includes(UPGRADING),
      '#625 A1b-1 and A1b-2 ship in one release; A1b-2 has not landed: cut from before A1b-1, or wait',
    ).toBe(true);
  });
});
