// docs-625-a1b1.test.ts — issue #625 PR-2b (A1b-1): the words a user reads about how a run ended,
// each pinned word for word on its page and tied to the cell that executes it (guardrail 9). The
// release rule's cell (A1b-1 and A1b-2 ship in one release) left with A1b-2, which pins the CLI's
// sentences in docs-625-a1b2.test.ts.
//
// A1b-1 gives each ending one sentence, read from the run's record only, and an abandoned run no
// longer says "an operator ended" it. These cells check that each page says what A1b-1 made true,
// and that the cell each sentence names as its proof is still there. Every assertion carries (a)
// the change that turns it red and (b) what it prints.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, ' ');

/** A cell: the test file (from the repository root) and the start of its title. */
type Cell = readonly [file: string, title: string];

const MCP = 'packages/mcp-server/src/ending-a1b1.test.ts';
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
// #625 PR-2b, the actor unit: the sentences that name who ended the run.
const ACTOR_CORE = 'packages/core/src/engine/actor-who-ended-625.test.ts';
const ACTOR_DOORS: Cell = [ACTOR_CORE, 'check 1 — the door × reason cells'];
const ACTOR_NO_DOOR: Cell = [ACTOR_CORE, 'check 1 — no door'];
const ACTOR_MASKED: Cell = [
  'packages/mcp-server/src/actor-who-ended-625.test.ts',
  'check 4 — abandon_run records the driver and door abandon_run',
];

const TOOLS = 'docs/reference/mcp/tools.md';

/** A1b-1's CHANGELOG lines, as the prompt writes them. */
const CHANGED =
  "- **`execute_step`, `advance_run`, `start_run` and `submit_human_response`, on a run that had already ended, say how it ended, from the record only.** One sentence per ending: which steps failed, which step or guard aborted it, a question's time-limit default or abort, 'realm run cleanup', the reason an abandon was given, or a record whose ending was worked out without a seal. An abandoned run no longer says an operator ended it; it names the program that ended it, when that program's name is known (see \"A run's ending says who ended it\"). (#625)";
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
      "How a run ended is one sentence (added after version 0.50.0): `It completed.`; `The answer on step '<step>' completed the run.`; `Guard step '<step>' passed and completed the run.`; `The question on step '<step>' reached its time limit, and its declared default completed the run.`; `Step '<step>' failed.` (`Steps '<a>', '<b>' failed.` for several);",
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
      "when the record names the program that ended the run (added after version 0.50.0), `It was abandoned with 'realm run abandon', by <name> (<how>), with the reason \"<reason>\".`, `It was abandoned with the assistant's 'abandon_run' tool, on the Realm server running as <name> (<how>), with the reason \"<reason>\".`, for a caller with one of `realm serve`'s named keys `It was abandoned with the assistant's 'abandon_run' tool, by <name> (from the server's key), with the reason \"<reason>\".` (each ending `; no reason was given.` when none was given), `'realm run cleanup', run by <name> (<how>), marked it abandoned.`, and, from a program that named no command or tool, `It was abandoned by <name> (<how>, via <channel>), with the reason \"<reason>\".` and `'realm run cleanup', run by <name> (<how>, via <channel>), marked it abandoned.`, where `<how>` is `from REALM_OPERATOR`, `from the OS user` or `named by the program that runs Realm` and the name is masked as environment values are (the part of it that matches an environment value of 8 characters or more, such as a long OS user name, shows as `[REDACTED]`, and REALM_OPERATOR's own value is not counted);",
    cells: [ACTOR_DOORS, ACTOR_NO_DOOR, ACTOR_MASKED],
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
