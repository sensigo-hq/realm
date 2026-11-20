// docs-729-cw5a.test.ts — #729 CW-5a (prompt feat-729-cw5a-claim-first.md): the words the unit adds or
// rewrites for a person, each held to its page word for word (spaces folded, as a table's padding
// moves), with the cell that executes what the sentence says named beside it (guardrail 9). The lines
// realm-agent.md quotes are also held to the renderer: the page's line, its placeholders filled in, is
// the line `realm agent` prints. Rewritten sentences that other files already pin are named there.
//
// Each assertion carries the two questions of `~/.claude/TESTING-RULES.md` rule 8 next to it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RunRecord } from '@sensigo/realm';
import {
  endedWhileHeldLine,
  giveBackLine,
  giveBackThrownLine,
  leaseUnavailableLine,
  takenBackNotLandedLine,
  takenBackNotRunLine,
} from '../lib/holder-render.js';
import { writerTestSeams } from '../output/writer.js';
import { reclaimCommand } from './reclaim.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const AGENT = 'docs/reference/cli/realm-agent.md';
const ACTING = 'docs/reference/cli/realm-run-acting.md';
const STATE = 'docs/reference/mcp/run-state-and-health.md';
const FILES = 'docs/reference/environment-and-files.md';
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

const GIVE_BACK_PARAGRAPH =
  "When the drive stops without saving an agent step it holds (its model call or tools failed, the engine refused the step's result, a store failed, or it was stopped by Ctrl-C, SIGTERM or SIGHUP), it gives the step's claim back first and says so: `• Step '<step>': this drive let its claim go (<why>), so the step can run again.`, where `<why>` is `its step failed`, `the engine refused the step's result`, `this drive stopped on an error` or `it was stopped by SIGINT` (or `SIGTERM`, `SIGHUP`). During the save, it waits for the step's save, at most 5 seconds, then gives the claim back if the step was not saved. A second signal ends it at once, and the step is left for the next drive to take back. When the claim was already gone, the line is `• Step '<step>': its claim was removed while this drive held it.`, with ` (a reclaim)` before the full stop when a person reclaimed it; when the run ended meanwhile, it is `• Step '<step>' was not run: the run ended (<phase>) while this drive held it.`, unless a line already said how the run ended. When giving the claim back fails, the claim stays, with a lease no program holds once the drive ends: `• Step '<step>': this drive could not let its claim go (<reason>); the next drive of this run can take the step back, once.`, or, when the step was already taken back automatically once, `• Step '<step>': this drive could not let its claim go (<reason>), and it was already taken back automatically once, so a person decides.` followed by each condition and the command that frees it. When the drive cannot take a lease in the home's `claim-leases/` folder, it claims nothing and does not call the model: `• Step '<step>' was not started: this drive could not take a lease in <folder> (<why>); nothing was claimed and the model was not called.`, on stderr, where `<why>` is `this program cannot write there`, `the disk is full`, `too many files are open` or `writing there failed`; the drive stops with exit code 1. A step the drive took back whose claim another program takes before this drive's own claim lands gets `… so this drive took it back (this step's one automatic take-back until a person reclaims it), but it is now taken by <program> at <time>; not run here.` in place of the take-back line, and the drive waits for that claim; when the drive stops before it claims the step, the line ends `…; it was not run here.` All added after version 0.50.0.";

describe('#729 CW-5a — realm-agent.md', () => {
  it('the give-back paragraph', () => {
    // "its model call or tools failed": claim-first-cw5a G2 and claim-first-sqlite's MCP arm; "the
    // engine refused the step's result": agent-refused-625's precondition cell and G3; "this drive
    // stopped on an error": "a store read that fails after the claim"; "it was stopped by SIGINT"
    // (SIGTERM, SIGHUP): claim-first-sqlite check 8. Correction 1's "During the save … at most 5
    // seconds … A second signal ends it at once": claim-first-cw5a correction 1's check 1 cells (the
    // chain not waited for, the 5 s bound, the second SIGINT) and claim-first-sqlite's "SIGINT during
    // the save". "its claim was removed … (a reclaim)": the two
    // removed cells. "the run ended (<phase>) while this drive held it … unless a line already said":
    // check 12. The two thrown lines: G4, below and at the cap. `lease_unavailable`: check 7 (a
    // wrapped port, and the SQLite folder at 0500, exit 1). The not-landed line and "…; it was not run
    // here.": check 11's two cells.
    claim(AGENT, GIVE_BACK_PARAGRAPH);
  });

  it('the holds sentence, the What it prints rows, When it stops, the exit codes and the provider module', () => {
    // The holds sentence: answer-not-recorded-625 C190 (claims it) and claim-first-cw5a check 1; "a
    // second realm agent … waits": check 9.
    claim(
      AGENT,
      "The drive holds the agent step it works on, too: before it calls the model, it claims the step under a lease in the home's `claim-leases/` folder, and it keeps the claim until it saves the step's answer, so a second `realm agent`, or a prompt `realm workflow run` opens for the step, waits for it instead of running it beside the drive (added after version 0.50.0, which held nothing while the model worked: a prompt opened during the model call took the step, and the model's answer was not recorded).",
    );
    claim(
      AGENT,
      "| `• Step '<step>' was taken by <program> at <time>; no program held the claim's lease when it was checked, so this drive took it back …` | The drive takes back an agent step whose claim's lease no program holds | That it takes the step back and runs it, or, with `but it is now taken by …; not run here.`, that another program took it first. See below. Added after version 0.50.0. |",
    );
    claim(
      AGENT,
      "| `• Step '<step>': this drive let its claim go (<why>), so the step can run again.`, or another give-back line | The drive stops without saving an agent step it holds | That it gave the step's claim back, or why it could not. See below. Added after version 0.50.0. |",
    );
    claim(
      AGENT,
      "| `• Step '<step>' was not started: this drive could not take a lease …` | The drive cannot take a lease for an agent step | Why; nothing was claimed and the model was not called. See [When it stops](#when-it-stops). Added after version 0.50.0. |",
    );
    // claim-first-sqlite check 7 (the folder named, HOME not a secret as the docs' examples are made).
    claim(
      AGENT,
      "| A lease cannot be taken in the home's `claim-leases/` folder | `• Step 'classify' was not started: this drive could not take a lease in /home/dana/.realm/claim-leases (this program cannot write there); nothing was claimed and the model was not called.` |",
    );
    // claim-first-sqlite check 8: each signal's death, and the shell loop that stops; correction 1:
    // the pipe loop (check 4) and the save's bound and second signal (claim-first-cw5a check 1).
    claim(
      AGENT,
      "| 128 + n | The drive was ended by SIGINT (130), SIGTERM (143) or SIGHUP (129). When it held an agent step, it gave the step's claim back first, then ended by that signal, so a shell running it in a loop stops (added after version 0.50.0). During the save, it waits for the step's save, at most 5 seconds, then gives the claim back if the step was not saved. A second signal ends it at once, and the step is left for the next drive to take back. |",
    );
    // claim-first-sqlite "a provider module that opens a lease file".
    claim(
      AGENT,
      "The module runs inside the process that holds the step's claim: a module that opens a file under the home's `claim-leases/` folder can let a second drive take the step while this one works, and both are paid (added after version 0.50.0).",
    );
  });

  it('each line the page quotes, its placeholders filled in, is the line realm agent prints', () => {
    const shown = writerTestSeams.visible;
    const holder = { by: 'drive-a', by_source: 'stated' as const, channel: 'agent' as const };
    const described = {
      holder,
      since: '2026-11-19T00:00:00.000Z',
      lease: { state: 'not_held' as const, basis: 'kernel_lock' as const },
    };
    const page = flat(read(AGENT));
    /** The page's quoted line that starts `head`, up to its closing backtick. */
    const quoted = (head: string): string => {
      const at = page.indexOf(`\`${head}`);
      if (at < 0) return `<no line starting ${head}>`;
      return page.slice(at + 1, page.indexOf('`', at + 1));
    };
    // An ended run as a handler's abort seals it.
    const ended = {
      run_phase: 'aborted',
      terminal_state: true,
      terminal_reason: "Handler 'f' aborted the run: stop",
      aborted_at: { step_id: 'f', abort_message: 'stop' },
      sealed_by: { arm: 'handler_abort', step: 'f' },
      evidence: [],
      completed_steps: [],
      failed_steps: [],
      skipped_steps: [],
      in_progress_steps: [],
    } as unknown as RunRecord;
    const fill = (line: string, values: Record<string, string>): string =>
      Object.entries(values).reduce((l, [k, v]) => l.split(`<${k}>`).join(v), line);
    // (1) red when a quoted line is not the line printed (either changed); (2) prints both.
    expect({
      released: shown(giveBackLine('s', { kind: 'released', cause: 'step_failed' })),
      removed: shown(giveBackLine('s', { kind: 'removed', byReclaim: false })),
      ended: shown(endedWhileHeldLine('s', ended)),
      below: shown(giveBackThrownLine('s', 'the store failed', undefined)),
      atCap: shown(giveBackThrownLine('s', 'the store failed', { held: undefined, runId: 'r' })),
      lease: shown(leaseUnavailableLine('s', 'permission', '/h/claim-leases')),
      notLanded: shown(takenBackNotLandedLine('s', described, { holder, since: 't1' })),
      notRun: shown(takenBackNotRunLine('s', described)),
    }).toEqual({
      released: fill(quoted("• Step '<step>': this drive let its claim go"), {
        step: 's',
        why: 'its step failed',
      }),
      removed: fill(quoted("• Step '<step>': its claim was removed"), { step: 's' }),
      ended: fill(quoted("• Step '<step>' was not run: the run ended (<phase>) while"), {
        step: 's',
        phase: 'aborted',
      }),
      below: fill(quoted("• Step '<step>': this drive could not let its claim go (<reason>);"), {
        step: 's',
        reason: 'the store failed',
      }),
      atCap: `${fill(quoted("• Step '<step>': this drive could not let its claim go (<reason>),"), { step: 's', reason: 'the store failed' })} Run realm run reclaim r to see how to free it.`,
      lease: fill(
        quoted("• Step '<step>' was not started: this drive could not take a lease in <folder>"),
        {
          step: 's',
          folder: '/h/claim-leases',
          why: 'this program cannot write there',
        },
      ),
      notLanded: `• Step 's' was taken by drive-a (as stated, via agent) at 2026-11-19T00:00:00.000Z; no program held the claim's lease when it was checked, so this drive took it back (this step's one automatic take-back until a person reclaims it), but it is now taken by drive-a (as stated, via agent) at t1; not run here.`,
      notRun: `• Step 's' was taken by drive-a (as stated, via agent) at 2026-11-19T00:00:00.000Z; no program held the claim's lease when it was checked, so this drive took it back (this step's one automatic take-back until a person reclaims it); it was not run here.`,
    });
    // The page's not-landed and not-run endings are these lines' endings.
    expect([
      page.includes(
        "… so this drive took it back (this step's one automatic take-back until a person reclaims it), but it is now taken by <program> at <time>; not run here.",
      ),
      page.includes('the line ends `…; it was not run here.`'),
    ]).toEqual([true, true]);
    // Each reason's words, as the page lists them.
    const reasons = (['permission', 'no_space', 'too_many_files', 'io_error'] as const).map(
      (r) => /\(([^)]+)\); nothing was claimed/.exec(leaseUnavailableLine('s', r, undefined))?.[1],
    );
    expect(reasons).toEqual([
      'this program cannot write there',
      'the disk is full',
      'too many files are open',
      'writing there failed',
    ]);
  });
});

describe('#729 CW-5a — the waiting and in-flight lines for a leased claim', () => {
  it('realm-agent.md and realm-workflow.md: the two lines for a claim that names a lease', () => {
    // realm agent: take-back-watch-cw5b W2 (the held waiting line, word for word) and W4 (the
    // in-flight line); realm workflow run: holder-lines-cw4b check 2 (g) (its waiting line for a
    // claim taken through claimStepForDrive) and the in-flight line it shares with realm agent.
    const LINES =
      "the two lines read `• Step '<step>' was taken by <program> at <time>; <what the lease check found>. Waiting up to 60s for the run's record to change.` and `• Step '<step>' was taken by <program> at <time>; the record has not changed for 60s.` (added after version 0.50.0).";
    claim(AGENT, `For a claim that names a lease, as every \`realm agent\` drive's does, ${LINES}`);
    claim(
      'docs/reference/cli/realm-workflow.md',
      `For a claim that names a lease, as a \`realm agent\` drive's does, ${LINES}`,
    );
  });
});

describe('#729 CW-5a — the other pages', () => {
  it('run-state-and-health.md: the rows for a step a realm agent drive holds', () => {
    // mcp-server run-state-lease-cw5a: held — no finding; not held — claim_stale (status, finding,
    // stuck claim); the lease file gone — claim_unknown_age.
    claim(
      STATE,
      "| `claim_stale` | A step was started, did not finish, and is past its time, or no program held its claim's lease when it was checked (added after version 0.50.0).",
    );
    claim(
      STATE,
      "| `stale_claim` | A step is in progress past its time, or for an unknown time, or no program held its claim's lease when it was checked, and the run is in `running`.",
    );
    claim(
      STATE,
      'When Realm has no time limit for the step and its claim names no lease, `reason` and `evidence.state` are `claim_unknown_age`, `deadline` is `null`, and the finding is there from the start. A step a `realm agent` drive holds names a lease: there is no finding while its program holds the lease, `claim_stale` once no program holds it, and `claim_unknown_age` when its lease file is gone or the lease could not be checked (added after version 0.50.0).',
    );
  });

  it('realm-run-acting.md: the reclaim states (the cleanup sentence is docs-715b’s, the fence docs-922-p1’s, healthy docs-922-p2’s)', () => {
    // held-lease-cw3a check 2 (the not-held claim's dry-run state claim_stale) and claim-first-sqlite
    // check 13 (a gone lease file: claim_unknown_age with the no-lease-file words).
    claim(
      ACTING,
      "| `claim_stale` | The step's time has passed, or no program held the claim's lease when it was checked.",
    );
    claim(
      ACTING,
      "| `claim_unknown_age` | No time was recorded, and the claim names no lease, or its lease file is gone or could not be checked. This is so for an agent step a prompt or an MCP call took (`realm agent`'s own claims name a lease, added after version 0.50.0), and for every step of a workflow that has cleanup steps.",
    );
  });

  it('realm run reclaim --help: --claimed-at', () => {
    // "unless no program held its lease": held-lease-cw3a "lease_not_held: freed with the old form";
    // the rest is docs-922-p1's (its WINDOW cells).
    // (1) red when the option's help no longer says it; (2) prints the help.
    expect(reclaimCommand.options.find((o) => o.long === '--claimed-at')?.description).toBe(
      "With --step: the claim's stamp, as the offered command shows it (required for a claim whose deadline is ahead or unknown, unless no program held its lease)",
    );
  });

  it('environment-and-files.md: the claim-leases/ row', () => {
    // "deletes it when it saves the step or gives it back": claim-first-sqlite check 3 (G1) and its
    // signal cells (the folder empty); "a drive that was killed leaves its file; the next drive takes
    // the step back, and the file stays after that": check 10 (one file left after the take-back).
    // Correction 1, claim-first-sqlite "the lease files that stay": a run that ended while held keeps
    // its file, named `<id>.lease` for the id `realm run export` shows, also after `realm run purge`;
    // once no claim names it, deleting it changes nothing (cleanup's dry run). "Deleting a file … no
    // lease file": check 13. "only a person can recover it": take-back-watch-cw5b W3 (a lease file
    // gone is not taken back). "purge refuses that run, with or without --force": held-lease-cw3a
    // "resume and purge, absent and unknown". The mount clause is the design's caution about file
    // locks (not executed: no such mount here).
    claim(
      FILES,
      "| `claim-leases/` | One small file per agent step a `realm agent` drive holds, which the operating system keeps locked while that drive runs. The drive deletes it when it saves the step or gives it back. Two cases leave it. A drive that was killed leaves its file; the next drive takes the step back, and the file stays after that. A run that ended while a drive held its step keeps the claim, so the file stays, also after `realm run purge`. A file that no run's claim names is safe to delete. `realm run export` shows the lease id a claim names, and the file is named `<id>.lease`. Deleting a file that a run's claim still names makes the step read \"no lease file\" to every other program. If its drive is still running and is then killed before it finishes the step, only a person can recover it, and `realm run purge` refuses that run, with or without `--force`. The leases rely on the operating system's file locks: on a mount that does not keep them as a local disk does (some network and synchronised folders), the words that say a program held the claim's lease can name a program that is gone. Made by the first `realm agent` drive (added after version 0.50.0). |",
    );
  });

  it('the CHANGELOG line', () => {
    // check 1 (claims before the model call, holds until the save), check 9 (a second drive waits);
    // the give-back's causes and lines as above, the signal's death and the shell loop (check 8);
    // check 10 (a killed drive taken back once); check 7 (the folder); store-sqlite's index exports
    // `claimLeasesFolder` (agent.ts imports it).
    claimChangelog(
      "- **`realm agent` holds its step under a lease while its model works.** A drive now claims an agent step before it calls the model, under a kernel lease in the home's `claim-leases/` folder, and holds it until it saves the result. A second `realm agent`, or a `realm workflow run` prompt, waits instead of running the step beside it; before, both could call the model. A drive that stops without finishing the step gives the claim back first and says so. That covers a failed step, a result the engine refused, and Ctrl-C, SIGTERM or SIGHUP. On a signal, it then ends by that signal (a second one ends it at once), so a script loop over runs stops, also when its output goes through a pipe. A killed drive leaves a lease no program holds, which `realm agent` takes back once (see the line above). A drive whose `claim-leases/` folder cannot be written stops before the model call, saying why. `@sensigo/realm-store-sqlite` exports the folder's location (`claimLeasesFolder`). (#729)",
    );
  });
});
