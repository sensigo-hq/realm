// docs-u1b.test.ts — U1b Unit 1 (guardrail 7(f), 9): each docs and CHANGELOG sentence U1b adds is
// quoted here word for word and asserted to be on its page, read from the repository. The behaviour
// each states is pinned by the cells of `agent-relay-u1b.test.ts` named beside it. Each assertion
// names (a) the change that turns it red and (b) what it prints when it fails: the sentence, never a
// record or an environment.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** #871's form: the section that holds this unit's entry — `[Unreleased]` until a release renames
 *  it, then the first release section above `[0.49.0]`. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.49.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

describe('U1b Unit 1 — the docs say what the relay does', () => {
  it('operate-runs.md, "What the output hides": a handler’s programs are hidden; the five seconds', () => {
    // (a) the grandchild masked; (h) the bound and the drain line; (h3) the line under --log-mode.
    claim(
      'docs/guides/operate-runs.md',
      "When the output goes to a file or a pipe, what a program started by a step's handler writes there is hidden as the handler's own prints are — under `realm agent`. After the command's work ends, the log keeps what reached it within five seconds; a program that still holds the output open then is stopped, and Realm says so on its error output.",
    );
  });

  it('realm-agent.md, by the `--log-mode` row: two processes, `kill`, the receipt’s two clauses', () => {
    // (a), (k-i) two processes; (f) `kill` (SIGTERM) on the first stops both; (e) the line is the
    // relay's; (e3) an abrupt end's walks clause; (e2) the standing before any piece; (e5) the
    // clause is scoped to an abrupt end (a clean drive without a manifest reads as today).
    claim(
      'docs/reference/cli/realm-agent.md',
      "When its output goes to a file or a pipe, or with `--log-mode`, `realm agent` runs the drive in a second process and keeps the first to mask what reaches the file or pipe, including what the programs a handler starts print; `kill` on the first process stops both, and a drive still running ten seconds after Ctrl-C or `kill` is killed. With both streams sent to one place (`2>&1`), whole lines from the two streams can arrive in a different order than they were printed; each stream keeps its own order. The `Disclosure:` line is the first process's. When the drive ends by a signal (a kill, or a crash that ends it by one), the line reads `values shown as their type and size: not counted (the drive ended before it said)`, and `declared values unknown (the drive ended before it said)` when it had not yet said what the manifest declares.",
    );
  });

  it('run-record-and-export.md, the `agent_pid` row: the relay, and the three signals', () => {
    // (j) the drives listen starts relay (always a log); (f) SIGTERM, (f2) SIGINT and SIGHUP reach
    // the worker.
    claim(
      'docs/reference/run-record-and-export.md',
      "This process relays and masks the drive's output (the drives `realm listen` starts always print as a log); the drive itself runs in a child of it, and Ctrl-C's, `kill`'s and `kill -HUP`'s signal to `agent_pid` reaches both.",
    );
  });

  it('the CHANGELOG entry', () => {
    // (a), (b) the grandchild masked; (h) the five seconds and the line.
    claimChangelog(
      "- Hardening: when the output goes to a file or a pipe, what a program started by a step's handler prints there is hidden as the handler's own prints are: `realm agent` runs its drive in a second process and keeps the first to do the hiding. A program that still holds the output open five seconds after the drive's work ends is stopped, and Realm says so on its error output.",
    );
  });
});
