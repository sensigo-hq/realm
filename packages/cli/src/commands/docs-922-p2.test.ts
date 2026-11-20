// docs-922-p2.test.ts — #922 P2-2 (prompt fix-922-p2-2-cli-doors.md, "Words a user reads", item 10;
// guardrail 9): every sentence P2-2 writes for a person, on the docs pages and in the CHANGELOG, each
// with the cell that executes what it says, and the dry run's screen on the page held to the built
// `realm`'s own output. This file's existence is #922's release rule: P1a's cell held P1's lines under
// `[Unreleased]` until it existed (P1 and P2 ship in one release); it is deleted with this unit.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure: the page
// and the sentence, or the cells that are missing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkflowFromString } from '@sensigo/realm';
import { makeTempHome, type TempHome } from '../test-support/temp-home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const CLI = join(HERE, '../../dist/index.js');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');

const ACTING = 'docs/reference/cli/realm-run-acting.md';
const READING = 'docs/reference/cli/realm-run-reading.md';
const AGENT = 'docs/reference/cli/realm-agent.md';
const WORKFLOW = 'docs/reference/cli/realm-workflow.md';
const SERVE = 'docs/reference/cli/realm-mcp-and-serve.md';
const GUIDE = 'docs/guides/operate-runs.md';

/** The CHANGELOG's `[Unreleased]` section (#871's form). */
function unreleased(): string {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  return text.slice(start, text.indexOf('\n## [', start + 1));
}

/** A cell, by its file and (part of) its title. */
type Cell = readonly [file: string, title: string];
const cellExists = ([file, title]: Cell): boolean =>
  existsSync(join(ROOT, file)) && read(file).includes(title);

const LINE = 'packages/cli/src/commands/held-line-922-p22.test.ts';
const DOORS = 'packages/cli/src/commands/held-doors-922-p22.test.ts';
const LEASE = 'packages/cli/src/commands/lease-facts-reach-hosts-cw1b2b.test.ts';
const STATES: Cell = [LINE, 'each state: its opening, its conditions, then the command'];
const IDEMPOTENT: Cell = [LINE, 'an idempotent step past its deadline: no condition'];
const B: Cell = [LINE, '"runs twice" exactly where the deadline is ahead or the age unknown'];
const HEADER: Cell = [LINE, 'the header words are the three documented ones'];
const EXIT_RULE: Cell = [LINE, 'past only → 1; past beside a step that can still finish → 0'];
const HAND_BACK: Cell = [LINE, 'past alone, two past, past beside one that can still finish'];
// #729 CW-3a: P2-2's lease branch is removed; the lease states' renderer cell, and CW-3a's door cells
const LEASE_BRANCH: Cell = [LINE, 'the lease states at the CLI’s renderer'];
const CW3A = 'packages/cli/src/commands/held-lease-cw3a.test.ts';
const LEASE_ADVANCE: Cell = [CW3A, 'check 1, held: advance prints the lease_held line'];
const LEASE_NOT_HELD: Cell = [CW3A, 'check 2, not held: advance prints the not-held line'];
const RULE_10: Cell = [LINE, 'the CLI’s held words over every state'];
const BUG: Cell = [DOORS, 'check 1, the bug’s screen'];
const MIXES: Cell = [DOORS, 'check 2, the mixes'];
const REAL_STATES: Cell = [DOORS, 'check 3, each real state'];
const AS_PRINTED: Cell = [DOORS, 'the dry run’s command, run from another folder, frees each'];
const DRAIN: Cell = [DOORS, 'drain: its held line, then the way out'];
const RESPOND: Cell = [DOORS, 'respond: an answer that leaves only a step past its deadline'];
const DRY_RUN: Cell = [
  DOORS,
  'every held step’s lines: a past one leads with its deadline-passed line',
];
const DRY_NO_DEF: Cell = [DOORS, 'a run whose workflow this home does not hold: the commands'];
const NO_DEF: Cell = [DOORS, 'drain and inspect point at the dry run in place of the held lines'];
const GATE: Cell = [DOORS, 'a step waiting at its question gets the answer command'];
const ALL: Cell = [DOORS, 'a pick whose claim changed between selection and write'];
const INSPECT: Cell = [DOORS, 'a held step: its deadline-passed line, its conditions, the command'];
const HISTORY: Cell = [DOORS, 'a step with entries [reclaim, re-run]'];
const OLD_FORM: Cell = [DOORS, 'the YAML loader’s warning, `--step`’s help and the refusal'];
const DRY_LEASE: Cell = [LEASE, '(d) realm run reclaim: a claim whose lease the home holds'];
const WATCH_LEASE: Cell = [LEASE, '(h) realm workflow run, the lease %s'];
const AGENT_PAST: Cell = [
  'packages/cli/src/agent/agent-loop-pins-625.test.ts',
  'a claim past its deadline: its deadline passed and no result is recorded',
];
const AGENT_WATCH: Cell = [
  'packages/cli/src/agent/answer-not-recorded-625.test.ts',
  'a step still held when the watch ends: the in-flight line',
];
const WORKFLOW_WATCH: Cell = [
  'packages/cli/src/commands/run-prompt-625.test.ts',
  'C188, W4-R1 (the walk’s case): the watch ends unchanged',
];
const KILLED_PROMPT: Cell = [
  'packages/cli/src/commands/run-prompt-625.test.ts',
  'C179: a claim the prompt left behind (the command killed outright)',
];
const SERVE_CUT: Cell = ['packages/cli/src/commands/serve-stop-960.test.ts', 'B13'];
// #729 CW-4a: a lease the check could not answer for (the lease file absent; each result on the MCP).
const CW4A_ADVANCE: Cell = [
  'packages/cli/src/commands/lease-words-cw4a.test.ts',
  'realm run advance: the held line says what the check found',
];
const CW4A_UNDER: Cell = [
  'packages/cli/src/commands/lease-words-cw4a.test.ts',
  'the dry run and inspect: the lines under the step carry the condition',
];
const CW4A_RULE_10: Cell = [
  'packages/cli/src/commands/held-line-922-p22.test.ts',
  '#729 CW-4a: the CLI’s held line and the lines under a held step',
];

/** A sentence a page or the CHANGELOG says, with the cells that execute it. */
const SENTENCES: readonly { page: string; sentence: string; cells: readonly Cell[] }[] = [
  {
    page: ACTING,
    sentence:
      "A step another program holds gets one line, by the state of its claim, ending with the command that frees it (for an agent step whose claim's lease no program held, then the `realm agent` sentence below; added after version 0.50.0, which printed `'<step>' is in flight in another program — wait for it, or see realm run inspect <id>` for each):",
    cells: [STATES, REAL_STATES],
  },
  {
    page: ACTING,
    sentence:
      "- Its deadline is ahead: `'<step>' is held; wait for it.`, then `Its deadline is ahead (<time>); if its program is still running, the step runs twice.`, and `To free it anyway, run:` before the command.",
    cells: [STATES, REAL_STATES],
  },
  {
    page: ACTING,
    sentence:
      "- Its deadline has passed: `'<step>' was claimed and its deadline passed at <time>; no result is recorded for it.`, and `To free it, run:` before the command. Nothing says to wait for it.",
    cells: [STATES, BUG],
  },
  {
    page: ACTING,
    sentence:
      "- Its claim has no deadline, its deadline cannot be read, or the run keeps no claim record for it: `'<step>' is held since <time>; wait for it, or free it if its program has stopped.` (no `since <time>` when the claim records no time), then `Its claim has no deadline, so whether its program still runs is not known; if it does, the step runs twice.` (`Its claim's deadline cannot be read, so …`, `It is held with no claim record, so …`), and `To free it, run:` before the command.",
    cells: [STATES, REAL_STATES],
  },
  {
    page: ACTING,
    sentence:
      '- A step not declared `idempotent: true` adds `It is not declared idempotent, so running it again may repeat its effects.` before the command.',
    cells: [IDEMPOTENT, B],
  },
  {
    page: ACTING,
    sentence:
      "The command is the one [`reclaim`](#reclaim) takes: `realm run reclaim <id> --step <step> --claimed-at <time> --force`, with the time the claim was taken, or with no `--claimed-at` when the claim records none. A step whose claim names a lease is read by that lease, as it was when checked. One whose program held it reads `'<step>' is held; wait for it.`, then `Its program held the claim's lease when it was checked; if that program is still running, the step runs twice.`, and `To free it anyway, run:` before the command. One whose lease no program held reads `'<step>' was claimed, and no program held the claim's lease when it was checked; no result is recorded for it.`, and `To free it, run:` before the command; for the exit code it counts as a step past its deadline. For an agent step that `realm agent` has not taken back since a person last reclaimed it, the lines end with `Or let realm agent --run-id <run> --provider <provider> --model <model> take it back and run it (this step's one automatic take-back until a person reclaims it).` (added after version 0.50.0). One whose lease is absent, or could not be checked, reads `'<step>' is held since <time>; wait for it, or free it if its program has stopped.`, then what the check found among its conditions (the words listed under [`reclaim`](#reclaim)), and `To free it, run:` before the command. No line says that the program holding a step has stopped.",
    cells: [
      STATES,
      AS_PRINTED,
      LEASE_BRANCH,
      LEASE_ADVANCE,
      LEASE_NOT_HELD,
      WATCH_LEASE,
      RULE_10,
      CW4A_ADVANCE,
      CW4A_RULE_10,
    ],
  },
  {
    page: ACTING,
    sentence:
      'Exit code 1 when a `Stopped:` line gives a step that failed or a refusal, when a step cannot run, or when every step it waits on is held by a claim whose deadline has passed (added after version 0.50.0), else 0.',
    cells: [BUG, MIXES, EXIT_RULE],
  },
  {
    page: ACTING,
    sentence:
      "A step in flight in another program gets its held line, as `realm run advance` prints it (added after version 0.50.0). When the run's workflow cannot be read, its held steps get `Its workflow definition cannot be read here; realm run reclaim <id> lists each held step's command.` (added after version 0.50.0).",
    cells: [DRAIN, NO_DEF],
  },
  {
    page: ACTING,
    sentence:
      "Under each step, for one past its deadline, `Its deadline passed at <time>; no result is recorded for it.` comes first; then each condition that holds, in the words listed below; then `To free it, run: <command>`, or `To free it anyway, run: <command>` while its deadline is ahead. The command carries `--claimed-at` with the time the claim was taken, when the claim records one. A step whose claim names a lease is listed by that lease, with `(taken at <time>)` after its state in place of its deadline: `healthy` when its program held it when it was checked, with `Its program held the claim's lease when it was checked; if that program is still running, the step runs twice.` among its conditions and `To free it anyway, run:` before its command; `claim_stale` when no program held it, led by `No program held the claim's lease when it was checked; no result is recorded for it.`; `claim_unknown_age` when it is absent or cannot be checked, with what the check found among its conditions. For an agent step whose claim's lease no program held, and which `realm agent` has not taken back since a person last reclaimed it, the lines end with `Or let realm agent --run-id <run> --provider <provider> --model <model> take it back and run it (this step's one automatic take-back until a person reclaims it).` (added after version 0.50.0). When a step listed names a lease, the footer says that `--all` lists the claims past their deadline with no lease, or whose lease no program held when it was checked, whose steps are idempotent. The footer leaves out `Run a step's command above to free it.` when no step above has a command, as for a run whose only step in progress waits at its question (changed after version 0.50.0). When the run's workflow cannot be read here, each step is listed all the same, with `Its workflow definition is not available here, so whether running it again is safe is not known.` among its conditions. Added after version 0.50.0, which listed a command only for a step that was not `healthy`, as `reclaim: realm run reclaim <id> --step <step> --force`.",
    cells: [DRY_RUN, DRY_NO_DEF, HEADER, DRY_LEASE, LEASE_NOT_HELD, GATE, CW4A_UNDER],
  },
  {
    page: ACTING,
    sentence:
      "| `healthy`           | The step's time has not passed, or its program held the claim's lease when it was checked; its program may still be running it.",
    cells: [HEADER],
  },
  {
    page: ACTING,
    sentence:
      'Also a time that cannot be read, and a step the run keeps no claim record for (added after version 0.50.0, which listed a time that cannot be read as `healthy`).',
    cells: [HEADER],
  },
  {
    page: ACTING,
    sentence:
      'A step that is waiting at a gate is listed with `open gate — answer it, not reclaim: realm run respond <run-id> --gate <gate-id> --choice <one of: …>`.',
    cells: [GATE],
  },
  {
    page: ACTING,
    sentence:
      "Each selected claim is freed only while it is still the claim `--all` read when it selected it, judged with the workflow definition it read then (added after version 0.50.0). One that another program took since is not freed, and the others go on: `✗ <run-id> / '<step>': claimed since <time>, not since <time> when selected; nothing was removed.` Any other refusal reads `✗ <run-id> / '<step>': <why>`. `--all` frees only claims past their deadline, or whose lease no program held when it was checked, whose steps are declared `idempotent: true`, and it holds a claim to the one it read only from its selection to its write.",
    cells: [ALL],
  },
  {
    page: ACTING,
    sentence:
      "Refusing to reclaim 'fetch' without --force. See realm run reclaim 70f9528e-4f45-4806-8690-c4e92a31760d, which prints each held step's command.",
    cells: [OLD_FORM],
  },
  {
    page: READING,
    sentence:
      "Under a step another program holds come the lines [`realm run reclaim <run-id>`](realm-run-acting.md#reclaim) prints for it, indented four spaces: for a step past its deadline `Its deadline passed at <time>; no result is recorded for it.` first, then each condition that holds, then `To free it, run: <command>` (`To free it anyway, run:` while its deadline is ahead), the command with the time the claim was taken, to the millisecond. A step whose claim names a lease is read by that lease: one whose lease no program held when it was checked leads with `No program held the claim's lease when it was checked; no result is recorded for it.`, one whose program held it has `Its program held the claim's lease when it was checked; if that program is still running, the step runs twice.` among its conditions, then `To free it anyway, run:`; and one whose lease is absent, or could not be checked, has what the check found among its conditions (in the words [`realm run reclaim`](realm-run-acting.md#reclaim) lists), then `To free it, run:`. For an agent step whose claim's lease no program held, and which `realm agent` has not taken back since a person last reclaimed it, the lines end with `Or let realm agent --run-id <run> --provider <provider> --model <model> take it back and run it (this step's one automatic take-back until a person reclaims it).` (added after version 0.50.0). When the run's workflow cannot be read, one line takes their place: `Its workflow definition cannot be read here; realm run reclaim <run-id> lists each held step's command.` Added after version 0.50.0.",
    cells: [INSPECT, NO_DEF, LEASE_BRANCH, CW4A_UNDER],
  },
  {
    page: READING,
    sentence:
      "When `realm run reclaim` freed a step, the step's history has a line of its own under its name, `Reclaimed at <time>: its claim was removed so the step could run again.`, which is not an attempt: the attempts are counted without it, and the step's output and cost are its attempts' own. A step whose only entry is a reclaim shows its name and that line. Added after version 0.50.0, which listed the reclaim as an attempt.",
    cells: [HISTORY],
  },
  {
    page: AGENT,
    sentence:
      "followed by the step's held line, the one [`realm run advance`](realm-run-acting.md#advance) prints: its claim's state, each condition, then the command that frees it (added after version 0.50.0, which ended `If the program that took it is gone: realm run reclaim <run> --step <step> --force`).",
    cells: [AGENT_WATCH, AGENT_PAST],
  },
  {
    page: AGENT,
    sentence:
      "or, for a step whose deadline has passed or whose claim's lease no program held and this drive could not take it back (it has no program name, the step is not an agent step, or it was already taken back automatically since a person last reclaimed it), `  Go on:     once '<step>' is freed (realm run reclaim <run> prints its command), realm agent --run-id <run> <flags>` (added after version 0.50.0)",
    cells: [AGENT_PAST, HAND_BACK],
  },
  {
    page: WORKFLOW,
    sentence:
      "for a step whose deadline has passed, once it is freed, and `realm run reclaim <run>` prints its command; for an agent step whose claim's lease no program held, and which `realm agent` has not taken back since a person last reclaimed it, the line opens `let realm agent --run-id <run> --provider <provider> --model <model> take '<step>' back, or` (added after version 0.50.0).",
    cells: [WATCH_LEASE, HAND_BACK],
  },
  {
    page: WORKFLOW,
    sentence:
      'a command killed outright (SIGKILL) leaves it, and the command `realm run reclaim <run>` prints for the step releases it (with `--claimed-at`, the time the claim was taken: added after version 0.50.0).',
    cells: [KILLED_PROMPT],
  },
  {
    page: WORKFLOW,
    sentence:
      "followed by the step's held line, the one [`realm run advance`](realm-run-acting.md#advance) prints (added after version 0.50.0, which ended `If the program that took it is gone: realm run reclaim <run> --step <step> --force`)",
    cells: [WORKFLOW_WATCH],
  },
  {
    page: SERVE,
    sentence:
      "(`realm run reclaim <run>` shows it healthy, with its deadline and the command that frees it). That command, run as printed, frees it, after saying that its deadline is ahead and the step runs twice if its program is still running (changed after version 0.50.0: the command carries the claim's time, `--claimed-at <time>`, and `realm run reclaim <run> --step <step> --force` without it is refused inside the claim's window);",
    cells: [AS_PRINTED, SERVE_CUT],
  },
  {
    page: GUIDE,
    sentence:
      '**A step was started and never finished**, for example because the process running it was killed. `realm run reclaim <run-id>` lists such steps, each with what holds for it and the command that makes it runnable again.',
    cells: [DRY_RUN, AS_PRINTED],
  },
];

describe('#922 P2-2 — every sentence it writes for a person, each with the cell that executes it', () => {
  it('each page sentence is on its page, and each of its cells exists', () => {
    const missing = SENTENCES.flatMap(({ page, sentence, cells }) => [
      ...(flat(read(page)).includes(flat(sentence)) ? [] : [`${page}: ${sentence}`]),
      ...cells.filter((c) => !cellExists(c)).map((c) => `${page}: no cell ${c.join(' — ')}`),
    ]);
    // (a) red when a sentence is reworded or dropped, or a cell it names is gone or renamed; (b)
    //     prints each sentence or cell that is missing.
    expect(missing).toEqual([]);
  });

  it('the CHANGELOG’s lines, under [Unreleased], each with its cells', () => {
    const upgrading =
      "`realm run advance` exits 1 when every step it waits on is held by a claim whose deadline has passed (it exited 0). On exit 1, `realm run reclaim <run-id>` lists each held step's command.";
    const changed =
      "**The CLI says each held step's state and how to free it.** `realm run advance`, `realm run drain`, `realm run respond`, `realm agent`, `realm workflow run` and `realm run inspect` say whether a held step's deadline is ahead or passed, or that its claim has none. They say to wait where it can still finish, then each condition, then the `realm run reclaim` command with the claim's stamp. The reclaim dry run lists every held step's command, and `realm run reclaim --all` frees only the claims it read. No held-step line says a program died.";
    const cells: readonly Cell[] = [
      BUG,
      MIXES,
      REAL_STATES,
      DRAIN,
      RESPOND,
      AGENT_PAST,
      WORKFLOW_WATCH,
      INSPECT,
      DRY_RUN,
      ALL,
      RULE_10,
    ];
    // (a) red when a line is dropped, reworded or moved out of [Unreleased], or its cells are gone;
    //     (b) prints the lines not found and the cells missing.
    expect({
      lines: [upgrading, changed].filter((l) => !flat(unreleased()).includes(flat(l))),
      cells: cells.filter((c) => !cellExists(c)),
    }).toEqual({ lines: [], cells: [] });
  });
});

describe(
  '#922 P2-2 — the dry run’s screen on the page, from the built realm',
  { timeout: 120_000 },
  () => {
    let h: TempHome & { readonly root: string };
    let elsewhere: string;
    beforeEach(async () => {
      h = await makeTempHome();
      elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'realm-922-p2-docs-')));
    });
    afterEach(async () => {
      await h.cleanup();
      rmSync(elsewhere, { recursive: true, force: true });
    });

    it('a claim past its deadline, written with the page’s own instants: the page’s block, the run id put in place', async () => {
      const def = loadWorkflowFromString(
        [
          'id: docs-922-p2',
          'name: docs-922-p2',
          'version: 1',
          'steps:',
          '  fetch:',
          '    description: fetch.',
          '    execution: auto',
          '',
        ].join('\n'),
      );
      await h.home.workflowStore.register(def);
      const { record } = await h.home.runStore.create({
        workflowId: def.id,
        workflowVersion: 1,
        params: {},
      });
      await h.home.runStore.update({
        ...record,
        in_progress_steps: ['fetch'],
        claims: {
          fetch: {
            deadline: '2026-10-01T23:15:36.957Z',
            token: 't',
            since: '2026-10-01T23:00:36.957Z',
          },
        },
      });
      const text = read(ACTING);
      const blocks = text.split(/^```[a-z]*\n/m).filter((_, i) => i % 2 === 1);
      const page = blocks
        .find((b) => b.includes('— in-progress claims:'))!
        .replace(/\n```[\s\S]*$/, '')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => l.replaceAll('70f9528e-4f45-4806-8690-c4e92a31760d', record.id));
      const r = spawnSync(process.execPath, [CLI, 'run', 'reclaim', record.id], {
        cwd: elsewhere,
        env: { PATH: process.env['PATH'] ?? '', HOME: h.root, NO_COLOR: '1', REALM_NO_NUDGE: '1' },
        encoding: 'utf8',
        timeout: 60_000,
      });
      // (a) red when the dry run's lines and the page's block differ; (b) prints both.
      expect(r.stdout.split('\n').filter((l) => l !== '')).toEqual(page);
    });
  },
);
