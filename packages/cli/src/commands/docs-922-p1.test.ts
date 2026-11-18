// docs-922-p1.test.ts — #922 P1a (prompt fix-922-p1-reclaim-way.md, "Words a user reads", items 10
// and 13; checks 10 and 14; guardrail 9): every sentence P1a writes for a person, each with the cell
// that executes what it says — the condition words of the one table, the MCP person block's reclaim
// line printed through the CLI's own operator route (the words before the command, B b7f72a42), the
// CHANGELOG's lines — and the release rule: #922 P1 and P2 ship in one release.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the page
// and the sentence, the words, or the cell that is missing.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CURRENT_WORKFLOW_SCHEMA_VERSION,
  InMemoryTraceBufferStore,
  reclaimConditionWords,
  type WorkflowDefinition,
} from '@sensigo/realm';
import { InMemoryStore, settableClock } from '@sensigo/realm-testing';
import { createRealmMcpServer } from '@sensigo/realm-mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cliOperatorRoute } from './ways-renderer.js';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');

/** The CHANGELOG's `[Unreleased]` section (#871's form): `[Unreleased]` until a release renames it,
 *  then the first section (the release's). */
function unreleased(): string {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  return text.slice(start, text.indexOf('\n## [', start + 1));
}

/** P1a's CHANGELOG lines, word for word (the Upgrading item without its number, which a merge moves). */
const UPGRADING =
  'On MCP, `agent_action` is `report_to_user` and `until` is never a past held deadline when every blocker is a step past its deadline.';
const CHANGED =
  "**Each held step carries a `reclaim` way for a person, with its conditions.** In the library, `WAY_VERBS` gains `reclaim`, and `WayOn` the new `ReclaimWay`; `Cond` gains the conditions `claim_deadline_ahead`, `override_claim_unknown_age` and `rerun_not_idempotent`; `UNAVAILABLE_CODES` and `FactsByCode` gain the codes `not_held`, `store_keeps_no_claims`, `fence_required` and `claim_changed`, and `held_elsewhere`'s facts gain the claim's stamp (`claimed_at`) and, for a deadline that cannot be read, `{ absent: 'unparseable_stamp' }`. `WayRenderer` and `LIBRARY_WORDS` gain `reclaim` with the list: a program that writes the full `WayRenderer` itself adds a `reclaim` function, and one built with `withLibraryWords` renders it in Realm's words.";

/** P1b's CHANGELOG lines, word for word (the Upgrading item without its number). */
const UPGRADING_P1B =
  '`realm run reclaim` asks for `--claimed-at <stamp>` when the claim carries a stamp and its deadline is ahead or unknown, and prints the command to run; on a claim past its deadline the old form still works. `not_a_step` and `claim_changed` exit 1.';
const ADDED_P1B =
  "**`realm run reclaim --claimed-at`** `<stamp>`: with `--step`, the time the step's claim was taken. The step is freed only while that is still its claim, and a reclaim refused for want of it prints the command to run.";
const CHANGED_P1B =
  "**`reclaimStep` takes optional `definition`, `force` and `claimed_at` (beta), and judges a reclaim as the reply offered it.** With `force: true` it frees a step only as its `reclaim` way was offered: a stamped claim whose deadline is ahead or unknown needs its `claimed_at`, a stamp that is not the claim's is refused and nothing is removed, and the reclaim record names the `conditions_discharged`. Every refusal but a step not held is thrown as a `WorkflowError` carrying `refusal` (beta, also on `WorkflowErrorOptions`); `ReclaimResult` gains `conditionsDischarged` and `refusal` (beta), and `ReclaimStepOptions` the three members. A call without them behaves as before.";

/** A cell, by its file and (part of) its title. */
type Cell = readonly [file: string, title: string];
const MCP_C1: Cell = [
  'packages/mcp-server/src/held-reply-922.test.ts',
  'get_run_state: report_to_user, no until — judged at the reading of the record (snap.at)',
];
const MCP_C2C: Cell = [
  'packages/mcp-server/src/held-reply-922.test.ts',
  'every hold past its deadline: report_to_user',
];
const P1B = 'packages/cli/src/commands/reclaim-922-p1b.test.ts';
const JUDGE = 'packages/core/src/engine/reclaim-judge-922.test.ts';
const PAST: Cell = [P1B, 'a claim past its deadline: the old form frees it'];
const WINDOW: Cell = [
  P1B,
  'a stamped claim inside its window: refused with the conditions and the command',
];
const UNSTAMPED: Cell = [P1B, 'a claim that records no stamp'];
const WRONG_STAMP: Cell = [
  P1B,
  'a stamp that is not the claim’s: refused, nothing removed, exit 1',
];
const REFUSALS: Cell = [P1B, 'not_a_step exits 1; not_held exits 0 and says so'];
const FLAG_RULES: Cell = [P1B, '`--claimed-at` without `--step`, or with `--all`: refused, exit 1'];
const NO_DEFINITION: Cell = [P1B, 'a run of a workflow this home does not hold'];
const RACE: Cell = [
  JUDGE,
  'the claim re-taken between the read and the write: claim_changed, nothing removed',
];
const ORDER: Cell = [JUDGE, 'one cell per refusal: its code, facts, act and words'];
const OLD_CALL: Cell = [JUDGE, 'every claim shape: reclaimed as before'];
const CORE_WAY: Cell = [
  'packages/core/src/engine/held-state-922.test.ts',
  'every held state × idempotent or not: the conditions that hold, the stamp when the claim has one',
];

function cellExists([file, title]: Cell): boolean {
  return existsSync(join(ROOT, file)) && read(file).includes(title);
}

describe('#922 P1a — the release rule (item 13, check 14)', () => {
  it('#922 P1 and P2 ship in one release: until docs-922-p2.test.ts exists, P1’s lines sit between the literal `## [Unreleased]` heading and the next section', () => {
    // NOT #871's form: after a release renames [Unreleased], that form reads the release's section,
    // so a gate written with it never fails. P2 deletes this cell.
    if (existsSync(join(HERE, 'docs-922-p2.test.ts'))) return;
    const text = read('CHANGELOG.md');
    const at = text.indexOf('\n## [Unreleased]\n');
    const section = at < 0 ? '' : text.slice(at, text.indexOf('\n## [', at + 1));
    const missing = [UPGRADING, CHANGED, UPGRADING_P1B, ADDED_P1B, CHANGED_P1B].filter(
      (line) => !flat(section).includes(flat(line)),
    );
    // (a) red when a release commit renames [Unreleased] (or moves P1's lines under a version) before
    //     P2 lands; (b) prints the rule and the lines not found under the literal heading.
    expect(
      missing,
      '#922 P1 and P2 ship in one release; P2 has not landed: cut from before P1, or wait',
    ).toEqual([]);
  });
});

describe('#922 P1a — the CHANGELOG lines, each with the cell that executes it', () => {
  it('Upgrading: the MCP reply on a run whose every blocker is a step past its deadline', () => {
    // (a) red when the line is dropped or reworded, or its executing cells are gone; (b) prints it.
    expect(flat(unreleased()).includes(flat(UPGRADING)), UPGRADING).toBe(true);
    expect([MCP_C1, MCP_C2C].filter((c) => !cellExists(c))).toEqual([]);
  });

  it('Changed: the reclaim way and the public rows it changes', () => {
    // (a) red when the line is dropped or reworded, or its executing cell is gone; (b) prints it.
    expect(flat(unreleased()).includes(flat(CHANGED)), CHANGED).toBe(true);
    expect(cellExists(CORE_WAY)).toBe(true);
  });
});

describe('#922 P1a — the condition words: one table, read by every place that prints a reclaim (R13)', () => {
  it('each condition’s words, as the prompt writes them (the owner’s B for the window)', () => {
    const T = '2030-01-01T12:01:00.000Z';
    // (a) red when a condition's words change, or the unreadable or no-record words say "no
    //     deadline"; (b) prints every condition's words.
    expect([
      reclaimConditionWords({ code: 'claim_deadline_ahead', deadline: T }),
      reclaimConditionWords({ code: 'override_claim_unknown_age', state: 'unknown_age' }),
      reclaimConditionWords({ code: 'override_claim_unknown_age', state: 'unreadable' }),
      reclaimConditionWords({ code: 'override_claim_unknown_age', state: 'no_claim_record' }),
      reclaimConditionWords({ code: 'rerun_not_idempotent', basis: 'not_declared' }),
      reclaimConditionWords({ code: 'rerun_not_idempotent', basis: 'definition_absent' }),
    ]).toEqual([
      `Its deadline is ahead (${T}); if its program is still running, the step runs twice.`,
      'Its claim has no deadline, so whether its program still runs is not known; if it does, the step runs twice.',
      "Its claim's deadline cannot be read, so whether its program still runs is not known; if it does, the step runs twice.",
      'It is held with no claim record, so whether its program still runs is not known; if it does, the step runs twice.',
      'It is not declared idempotent, so running it again may repeat its effects.',
      'Its workflow definition is not available here, so whether running it again is safe is not known.',
    ]);
  });
});

const handles: TempHome[] = [];
afterEach(async () => {
  for (const h of handles.splice(0).reverse()) await h.cleanup();
});

describe('#922 P1a — check 10: the MCP person block says the conditions before the command', () => {
  it('a held step inside its window, not declared idempotent: the line names both conditions, then the command the CLI route prints', async () => {
    const start = new Date('2030-01-01T12:00:00.000Z');
    const deadline = new Date(start.getTime() + 60_000).toISOString();
    const since = new Date(start.getTime() - 3_600_000).toISOString();
    const def = {
      id: 'docs-922-p1',
      name: 'docs-922-p1',
      version: 1,
      schema_version: CURRENT_WORKFLOW_SCHEMA_VERSION,
      steps: { a: { description: 'a', execution: 'agent', depends_on: [] } },
    } as WorkflowDefinition;
    const runStore = new InMemoryStore({ clock: settableClock(start) });
    const h = await makeTempHome();
    handles.push(h);
    await h.home.workflowStore.register(def);
    const server = createRealmMcpServer({
      gateAnswers: 'permitted',
      runStore,
      workflowStore: h.home.workflowStore,
      traceBufferStore: new InMemoryTraceBufferStore(runStore),
      failedAttemptStore: h.home.failedAttemptStore,
      operatorRoute: cliOperatorRoute('realm mcp'),
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'docs-922-p1', version: '0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { record } = await runStore.create({
      workflowId: def.id,
      workflowVersion: 1,
      params: {},
    });
    await runStore.update({
      ...record,
      in_progress_steps: ['a'],
      claims: { a: { deadline, token: 'other', since } },
    });
    const raw = (await client.callTool({
      name: 'get_run_state',
      arguments: { run_id: record.id },
    })) as { content: Array<{ text: string; annotations?: { audience?: string[] } }> };
    const agentJson = JSON.parse(raw.content[0]!.text) as {
      elsewhere?: Array<{ verb: string; human_readable: string }>;
    };
    const person = raw.content.find((c) => c.annotations?.audience?.includes('user'))?.text ?? '';
    const words =
      `An operator can free step 'a', outside this conversation. Its deadline is ahead (${deadline}); ` +
      'if its program is still running, the step runs twice. It is not declared idempotent, so ' +
      'running it again may repeat its effects.';
    // (a) red when elsewhereWords has no reclaim arm (the line then names no condition), or the
    //     command comes before the words; (b) prints the person block and the agent's entry.
    expect({
      person: person.split('\n').filter((l) => l.includes('realm run reclaim')),
      agent: agentJson.elsewhere?.filter((e) => e.verb === 'reclaim').map((e) => e.human_readable),
    }).toEqual({
      person: [
        `${words} The operator's command: realm run reclaim ${record.id} --step a --claimed-at ${since} --force`,
      ],
      agent: [words],
    });
  });
});

const ACTING = 'docs/reference/cli/realm-run-acting.md';
/** (a) red when the page no longer holds the sentence word for word; (b) prints the page and it. */
function claimPage(page: string, sentence: string): void {
  expect(flat(read(page)).includes(flat(sentence)), `${page} no longer says: ${sentence}`).toBe(
    true,
  );
}

describe('#922 P1b — the CHANGELOG lines and realm-run-acting.md’s reclaim section, each with the cells that execute it', () => {
  it('the CHANGELOG: Upgrading, Added and Changed', () => {
    // (a) red when a line is dropped or reworded, or its executing cells are gone; (b) prints it.
    for (const line of [UPGRADING_P1B, ADDED_P1B, CHANGED_P1B]) {
      expect(flat(unreleased()).includes(flat(line)), line).toBe(true);
    }
    expect([PAST, WINDOW, REFUSALS, ORDER, RACE, OLD_CALL].filter((c) => !cellExists(c))).toEqual(
      [],
    );
  });

  it('the reclaim section: the per-step form, the conditions, the fence, the refusals and the exit codes', () => {
    const page: [string, Cell[]][] = [
      ['realm run reclaim <run-id> --step <name> [--claimed-at <stamp>] --force', [WINDOW]],
      [
        "| `--claimed-at <stamp>`    | With `--step`: the time the step's claim was taken, as the command `reclaim` prints shows it. See below.",
        [WINDOW],
      ],
      [
        '`--step`, `--claimed-at` and `--workflow` refuse a value that starts with `-`, except a lone `-`; write `--option=value` for one.',
        [FLAG_RULES],
      ],
      [
        'With `--step` and `--force`, `reclaim` first judges the claim the step holds now, and prints nothing before it is admitted. Once the step is freed, it says each condition that held, then that it is done:',
        [PAST, WINDOW],
      ],
      [
        "Reclaimed step 'fetch' of run 70f9528e-4f45-4806-8690-c4e92a31760d: it can run again.",
        [PAST],
      ],
      [
        "`Its workflow definition is not available here, so whether running it again is safe is not known.` (when the run's workflow cannot be read; the reclaim still runs.)",
        [NO_DEFINITION],
      ],
      [
        "The run's record keeps an entry for the step that says it was reclaimed, with the state and the time it had, and the conditions it was freed under.",
        [OLD_CALL],
      ],
      [
        'A claim that records when it was taken, and whose deadline is ahead or of unknown age, is freed only with `--claimed-at` set to that time: inside its window, its program may still be running. Without it, nothing is freed, and the command says what holds and the command to run:',
        [WINDOW],
      ],
      [
        "Step 'fetch' is claimed since 2026-10-01T23:00:36.957Z. Its deadline is ahead (2026-10-01T23:15:36.957Z); if its program is still running, the step runs twice. It is not declared idempotent, so running it again may repeat its effects. To reclaim this claim, run: realm run reclaim 70f9528e-4f45-4806-8690-c4e92a31760d --step fetch --claimed-at 2026-10-01T23:00:36.957Z --force",
        [WINDOW],
      ],
      [
        'With `--claimed-at`, the step is freed only while that is still its claim. If another program took the step since, nothing is removed:',
        [WRONG_STAMP, RACE],
      ],
      [
        "Step 'fetch' is claimed since 2026-10-01T23:20:02.114Z, not since 2026-10-01T23:00:36.957Z as the command says; nothing was removed. See: realm run inspect 70f9528e-4f45-4806-8690-c4e92a31760d",
        [WRONG_STAMP],
      ],
      [
        'A claim past its deadline, or one that records no time it was taken, is freed without `--claimed-at`.',
        [PAST, UNSTAMPED],
      ],
      [
        "A step that is not in progress is not freed: `Step 'fetch' is not held; nothing to reclaim.`, followed by the run's ways on. A name the run's workflow does not have is refused: `Step 'fecth' is not a step of workflow 'w'; nothing was reclaimed.`, followed by the run's ways on. A step the workflow no longer names, still in progress from an older version, is freed with `Reclaimed step 'fetch' of run <id>. The workflow definition read here has no step named 'fetch'.`",
        [REFUSALS],
      ],
      [
        "**Exit code:** 0 when the step is freed, also when there is nothing to free. 1 when the reclaim is refused (a name the workflow does not have, a claim that needs `--claimed-at`, a `--claimed-at` that is not the claim's, the step a question is open on, a run that has ended), and for a combination that cannot be used:",
        [REFUSALS, WINDOW, WRONG_STAMP, ORDER],
      ],
      [
        '--claimed-at requires --step <name>.\n--claimed-at is a per-step flag; it cannot be combined with --all.',
        [FLAG_RULES],
      ],
    ];
    // (a) red when the page drops or rewords a sentence, or a cell that executes it is gone;
    //     (b) prints the sentence and the missing cells.
    for (const [sentence, cells] of page) {
      claimPage(ACTING, sentence);
      expect(
        cells.filter((c) => !cellExists(c)),
        sentence,
      ).toEqual([]);
    }
  });
});
