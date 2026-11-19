// docs-729-cw4b.test.ts — issue #729, the claim window, unit CW-4b: the words the unit adds to the pages
// and the CHANGELOG, each held to its page word for word (spaces folded, as a table's padding moves) with
// the cell that executes what it says named beside it (guardrail 9). Some of these sentences sit inside
// paragraphs other files pin whole (docs-922-p2, docs-729-cw3a, docs-pages-625-acting,
// answer-not-recorded-625, run-prompt-625); each new sentence is pinned here as well, with its cells.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const READING = 'docs/reference/cli/realm-run-reading.md';
const AGENT = 'docs/reference/cli/realm-agent.md';
const WORKFLOW = 'docs/reference/cli/realm-workflow.md';
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (1) red when the page no longer holds the sentence word for word; (2) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** The section that holds this unit's entry: `[Unreleased]` until a release renames it. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.50.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

describe('#729 CW-4b — the holder lines’ words', () => {
  it('realm-run-acting.md: advance’s In flight: line for a leased claim', () => {
    // holder-lines-cw4b check 1 (each state's inFlightItems, both forms) and check 2 (a) (nothing
    // owed, no question: no lease on In flight:), (b) (a question open: the lease in brackets) and
    // (e) (work owed: the lease in brackets).
    claim(
      ACTING,
      "For a claim that names a lease it reads `In flight: '<step>' was taken by <program> at <time>.`, and, when work is owed or a question is open, `In flight: '<step>' was taken by <program> at <time> (<what the lease check found>).`: no held line below says the lease then (added after version 0.50.0).",
    );
  });

  it('realm-run-acting.md: advance’s not-recorded line for a leased claim', () => {
    // holder-lines-cw4b check 1 (outcomeNotRecordedLine, held_elsewhere, each state).
    claim(
      ACTING,
      "(for a claim that names a lease, `…; <what the lease check found>; this program's outcome for it was not recorded.`, added after version 0.50.0)",
    );
  });

  it('realm-run-acting.md: resume’s two rows for a leased claim', () => {
    // holder-lines-cw4b check 1 ("resume's and purge's refusals": absent and unknown, and held).
    claim(
      ACTING,
      "`Step '<step>' was taken by <program> at <time>; <what the lease check found>, so resume does not release it, with or without --force.`",
    );
    claim(
      ACTING,
      "| A step is in progress under a lease its program held when it was checked, also with `--force` (added after version 0.50.0) | `Step '<step>' was taken by <program> at <time>; its program held the claim's lease when it was checked, so resume does not release it, with or without --force.` |",
    );
  });

  it('realm-run-acting.md: --all selects a claim whose lease no program held (the flag row, the rule sentence, the header and its line)', () => {
    // holder-lines-cw4b check 1 (--all selects a not-held leased claim of an idempotent step) and
    // check 4 (the header: today's words with no leased claim selected).
    claim(
      ACTING,
      '| `--all` | Selects, across all runs, every step that is past its time, or whose lease no program held when it was checked, is declared `idempotent: true`, and is not waiting at a gate. |',
    );
    claim(
      ACTING,
      '`--all` frees only claims past their deadline, or whose lease no program held when it was checked, whose steps are declared `idempotent: true`,',
    );
    claim(
      ACTING,
      "When a selected claim names a lease, the header reads `… (idempotent ∧ (past its deadline with no lease, or no program held its lease) ∧ non-gated):` and its line `(taken at <time>; no program held the claim's lease when it was checked)` (added after version 0.50.0).",
    );
  });

  it('realm-run-acting.md: the dry run’s header and footer for a leased claim', () => {
    // holder-lines-cw4b check 1 (the dry run's header, each state) and check 4 (the footer, both
    // forms).
    claim(
      ACTING,
      'A step whose claim names a lease is listed by that lease, with `(taken at <time>)` after its state in place of its deadline:',
    );
    claim(
      ACTING,
      'When a step listed names a lease, the footer says that `--all` lists the claims past their deadline, or whose lease no program held when it was checked, whose steps are idempotent.',
    );
  });

  it('realm-run-reading.md: inspect’s holder line for a leased claim', () => {
    // holder-lines-cw4b check 2 (f) (a run that has ended: the holder line says the lease) and (d)
    // (with the lines under the step: once, not on the holder line).
    claim(
      READING,
      'For a claim that names a lease, the line ends `; <what the lease check found>` when no lines under the step say it: on a run that has ended, or whose workflow cannot be read (added after version 0.50.0).',
    );
  });

  it('realm-agent.md and realm-workflow.md: the drive’s not-recorded line and the closed prompt', () => {
    // holder-lines-cw4b check 1 (answerNotRecordedLine, the in-progress and held_elsewhere arms, and
    // stepClosedLine, each state).
    claim(
      AGENT,
      "(for a claim that names a lease, `…; <what the check found>; this drive's answer was not recorded.`, added after version 0.50.0)",
    );
    claim(
      WORKFLOW,
      '(for a claim that names a lease, `…; <what the check found>; not run here.`, added after version 0.50.0)',
    );
  });

  it('the CHANGELOG line', () => {
    // holder-lines-cw4b checks 1 to 4 (every line it names, per state; once per read; the --all
    // header and the footer); "no Realm command does yet": the claim lease's source witness
    // (claim-lease-witness-cw1: no command calls claimStepForDrive).
    claimChangelog(
      '- **The lines that name who holds a step say what its claim\'s lease showed.** For a step another program took under a lease, `realm run advance`\'s `In flight:` line and `realm run reclaim`\'s dry-run header say when it was taken (the first also by whom, and what the lease check found when work is owed or a question is open) instead of "in flight" or its deadline. The waiting, taken and not-recorded lines of `realm agent` and `realm workflow run`, `realm workflow run`\'s closed prompt, `realm run inspect` on a run that has ended or whose workflow cannot be read, `realm run reclaim --all`, and the refusals of `realm run resume` and `realm run purge` say what the lease check found, instead of a deadline or "a live runner". Only a program calling `claimStepForDrive` (`@beta`) makes such a claim; no Realm command does yet. (#729)',
    );
  });
});
