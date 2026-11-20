// docs-729-cw3a.test.ts — #729 CW-3a (prompt feat-729-cw3a-held-state-lease.md, "Words a user reads";
// guardrail 9): the sentences CW-3a writes outside #922's paragraphs (those are docs-922-p2's), each
// with the cell that executes what it says — resume's refusal row and its `--force`, in the reference
// and the command's help, and the CHANGELOG's line.
//
// Every assertion carries (a) the change that turns it red and (b) what it prints on failure.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resumeCommand } from './resume.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');
const ACTING = 'docs/reference/cli/realm-run-acting.md';

/** The CHANGELOG's `[Unreleased]` section (#871's form). */
function unreleased(): string {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  return text.slice(start, text.indexOf('\n## [', start + 1));
}

type Cell = readonly [file: string, title: string];
const cellExists = ([file, title]: Cell): boolean =>
  existsSync(join(ROOT, file)) && read(file).includes(title);
const CLI = 'packages/cli/src/commands/held-lease-cw3a.test.ts';
const CORE = 'packages/core/src/engine/held-lease-cw3a.test.ts';
const MCP = 'packages/mcp-server/src/held-lease-cw3a.test.ts';
const RESUME_PURGE: Cell = [CLI, 'resume and purge, absent and unknown: their refusals'];
const CLEANUP: Cell = [CORE, 'cleanup keeps a run whose leased claim is held, absent or unknown'];
const STATE: Cell = [CORE, 'held → lease_held, not held → lease_not_held'];
const JUDGE: Cell = [CLI, 'lease_held: refused without the stamp (fence_required)'];
const NOT_HELD: Cell = [MCP, 'report_to_user; the operator entry leads with the not-held line'];

describe('#729 CW-3a — resume’s refusal of a lease that cannot be checked', () => {
  it('the reference’s row and its --force line, and the command’s help, each with its cell', () => {
    const row =
      "| A step is in progress under a lease whose state cannot be checked, also with `--force` (added after version 0.50.0) | `Step '<step>' was taken by <program> at <time>; <what the lease check found>. Resume does not release it, with or without --force.` |";
    const flag =
      'Resumes even though another step of the run is marked in progress and Realm cannot tell how long it has been; never for a step claimed under a lease whose state cannot be checked (added after version 0.50.0).';
    const help = resumeCommand.options.find((o) => o.long === '--force')?.description;
    // (a) red when a sentence is reworded or dropped, the help says --force overrides it, or the
    //     executing cell is gone; (b) prints what is missing.
    expect({
      row: flat(read(ACTING)).includes(flat(row)),
      flag: flat(read(ACTING)).includes(flat(flag)),
      help,
      cell: cellExists(RESUME_PURGE),
    }).toEqual({
      row: true,
      flag: true,
      help: 'Override the claim_unknown_age refusal ONLY (never a healthy claim, a claim under a lease whose state is not known, or an unexpired drain lease)',
      cell: true,
    });
  });
});

describe('#729 CW-3a — the CHANGELOG’s line', () => {
  it('Added, under [Unreleased], with its cells', () => {
    const line =
      "**A held step's state reads its claim's lease.** `Cond` gains `lease_held`: a claim whose lease its program holds, which `force` discharges. A claim whose lease no program holds is reported like a claim past its deadline. `realm run cleanup` keeps, and `realm run resume` and `realm run purge` refuse even with `--force`, a run whose leased claim's lease cannot be checked. `realm agent` takes a leased claim for every agent step it drives (see \"`realm agent` holds its step under a lease while its model works\"). (#729)";
    // (a) red when the line is dropped, reworded or moved out of [Unreleased], or a cell is gone;
    //     (b) prints the line's presence and the cells missing.
    expect({
      line: flat(unreleased()).includes(flat(line)),
      cells: [STATE, JUDGE, NOT_HELD, CLEANUP, RESUME_PURGE].filter((c) => !cellExists(c)),
    }).toEqual({ line: true, cells: [] });
  });
});
