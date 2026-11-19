// docs-729-cw5b.test.ts — #729 CW-5b (prompt feat-729-cw5b-watcher-take-back.md): the words the unit
// adds, each held to the page word for word (spaces folded, as a table's padding moves), with the cell
// that executes what the sentence says named beside it (guardrail 9). The lines a page quotes are also
// held to the renderer: the page's line, its placeholders filled in, is the line `realm agent` prints.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { noDriverTakeBackLine, takeBackAtCapLine, takenBackLine } from '../lib/holder-render.js';
import { writerTestSeams } from '../output/writer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const AGENT = 'docs/reference/cli/realm-agent.md';
const READING = 'docs/reference/cli/realm-run-reading.md';
const RECORD = 'docs/reference/run-record-and-export.md';
const STATE = 'docs/reference/mcp/run-state-and-health.md';
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

/** The three lines realm-agent.md quotes, each with its placeholders. */
const LINE_I =
  "• Step '<step>' was taken by <program> at <time>; no program held the claim's lease when it was checked, so this drive took it back (this step's one automatic take-back until a person reclaims it). Its model and tools run here, so any side effects of the first program's calls may repeat.";
const AT_CAP =
  "• Step '<step>' was taken by <program> at <time>; no program held the claim's lease when it was checked, and it was already taken back automatically once (at <time>, by <program>), so a person decides.";
const NO_DRIVER =
  "• Step '<step>' was taken by <program> at <time>; no program held the claim's lease when it was checked, but this drive has no program name, so it cannot take the step back (set REALM_OPERATOR to name it). Waiting up to 60s for the run's record to change.";

describe('#729 CW-5b — the take-back’s words', () => {
  it('realm-agent.md: the watch takes back once, says so, and otherwise names the cap or the missing name', () => {
    // "taken back once and run here, after the line …": take-back-watch-cw5b W1 and W2, and
    // take-back-sqlite-cw5b (a real kernel lease, its drive killed). "when it was already taken back
    // automatically since a person last reclaimed it … takes nothing back … does not wait for that
    // step (with no other step to wait on, it stops at once with the `Go on:` line)": W5. "a drive with
    // no program name takes nothing back and waits after …": check 7's no-driver cells.
    claim(
      AGENT,
      `An agent step whose claim's lease no program holds, for example because the drive that took it was killed, is taken back once and run here, after the line \`${LINE_I}\`; when it was already taken back automatically since a person last reclaimed it, the drive takes nothing back and prints \`${AT_CAP}\` followed by each condition and the command that frees it, and does not wait for that step (with no other step to wait on, it stops at once with the \`Go on:\` line); and a drive with no program name takes nothing back and waits after \`${NO_DRIVER}\` (added after version 0.50.0).`,
    );
  });

  it('realm-agent.md: each quoted line, its placeholders filled in, is the line realm agent prints', () => {
    const holder = { by: 'drive-a', by_source: 'stated' as const, channel: 'agent' as const };
    const described = {
      holder,
      since: '2026-11-19T00:00:00.000Z',
      lease: { state: 'not_held' as const, basis: 'kernel_lock' as const },
    };
    const fill = (line: string, times: string[], programs: string[]): string => {
      let i = 0;
      let j = 0;
      return line
        .replace(/<step>/g, 's')
        .replace(/<time>/g, () => times[i++]!)
        .replace(/<program>/g, () => programs[j++]!);
    };
    const shown = writerTestSeams.visible;
    const A = 'drive-a (as stated, via agent)';
    const C = 'drive-c (as stated, via agent)';
    const t0 = '2026-11-19T00:00:01.000Z';
    // (1) red when a line the page quotes is not the line printed (either changed); (2) prints both.
    expect({
      i: shown(takenBackLine('s', described)),
      cap: shown(
        takeBackAtCapLine(
          's',
          described,
          { at: t0, driven_by: { by: 'drive-c', by_source: 'stated', channel: 'agent' } },
          undefined,
        ),
      ),
      noDriver: shown(noDriverTakeBackLine('s', described, 60_000)),
    }).toEqual({
      i: fill(LINE_I, [described.since], [A]),
      cap: fill(AT_CAP, [described.since, t0], [A, C]),
      noDriver: fill(NO_DRIVER, [described.since], [A]),
    });
  });

  it('realm-run-reading.md: inspect’s take-back line', () => {
    // The line: inspect.ts's take-back branch, executed by inspect-take-back-cw3b (the taker and the
    // holder, each read through core's reader) and take-back-watch-cw5b check 8 ("not an attempt":
    // the attempt keeps its Taken by: line and its cost). "a program whose name was not recorded is
    // left out with its by or from": inspect-take-back-cw3b's cell for a missing name.
    claim(
      READING,
      "A step [`realm agent`](realm-agent.md) took back automatically, because no program held its claim's lease, has the line `Taken back at <time> by <program> from <program>: no program held the claim's lease when it was checked, so its claim was removed and the step could run again.` in the same place, which is not an attempt either: the first program is the drive that took it back, the second the one whose claim it was, and a program whose name was not recorded is left out with its `by` or `from` (added after version 0.50.0).",
    );
  });

  it('run-record-and-export.md: `driven_by` on an automatic take-back’s entry, none on a person’s reclaim', () => {
    // "on an automatic take-back's audit entry, the drive that took the step back": take-back-watch-
    // cw5b W1 (`driven_by` B) and take-back-sqlite-cw5b (the REALM_OPERATOR name). "Not written on …
    // a person's reclaim": reclaim-step.ts's manual entry passes no driver (core's reclaim cells).
    claim(
      RECORD,
      "Written on the entries where a program's code ran: a step's result and a cleanup step; on a gate answer, the program that recorded it (added after version 0.47.0); and on an automatic take-back's audit entry, the drive that took the step back (added after version 0.50.0). Not written on the entries Realm makes itself (an expiry, a guard, a person's reclaim).",
    );
  });

  it('run-state-and-health.md: a reclaim’s audit entry is not an attempt', () => {
    // mcp-server's reclaim-not-attempt-cw5b: one attempt and one unmeasured after a take-back and a
    // person's reclaim; a step with only reclaims has no entry and is named in `warnings`.
    claim(
      STATE,
      "A reclaim's audit entry (a person's `realm run reclaim`, or `realm agent` taking a step back) is not an attempt: it is not in `attempts` and `run_cost` does not count it, and a step whose only entries are reclaims has no entry in `steps`, so naming it in `step_names` puts it in `warnings` (added after version 0.50.0, which counted each as an attempt).",
    );
  });

  it('the CHANGELOG lines', () => {
    // "takes it back and runs it, saying so first, instead of waiting 60 s and stopping": W1, W2 and
    // take-back-sqlite-cw5b; "once per step until a person reclaims it. After that, it stops and prints
    // the reclaim command with its conditions": W5; "A drive with no program name takes nothing back
    // and says how to name it": check 7. "only a program calling `claimStepForDrive` (`@beta`) makes
    // such a claim": no production file calls it (claim-lease-witness-cw1's DRIVE_ENTRY_CALLERS).
    claimChangelog(
      "- **`realm agent` takes back, once, a step whose claim's lease no program holds.** When the agent step `realm agent` waits on was taken under a lease that no program holds any more (for example, because its drive was killed), `realm agent` takes it back and runs it, saying so first, instead of waiting 60 s and stopping. It does this once per step until a person reclaims it. After that, it stops and prints the reclaim command with its conditions. A drive with no program name takes nothing back and says how to name it. Until `realm agent` claims under a lease itself, only a program calling `claimStepForDrive` (`@beta`) makes such a claim. (#729)",
    );
    // mcp-server's reclaim-not-attempt-cw5b and take-back-watch-cw5b check 8.
    claimChangelog(
      "### Fixed\n\n- get_run_state's steps page and the run's cost count no longer count a reclaim's audit entry as an attempt.",
    );
  });
});
