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
    // (a) the grandchild masked; (h) the bound and the drain line; (h3) the line under --log-mode;
    // (x8) "is stopped": the program holding the output is gone once the command returns. Unit 2:
    // the four doors, (s1)–(s4) of `four-doors-relay-u1b2.test.ts`; "did not wait for" (amendment
    // B1): (h-s), its released program stopped at the bound, its kept program waited for.
    claim(
      'docs/guides/operate-runs.md',
      "When the output goes to a file or a pipe, what a program started by a step's handler writes there is hidden as the handler's own prints are — under `realm agent`, `realm run drain`, `realm run advance`, `realm run respond` and `realm workflow run`. After the command's work ends, the log keeps what reached it within five seconds; a program the command did not wait for that still holds the output open then is stopped, and Realm says so on its error output.",
    );
  });

  it('realm-agent.md, by the `--log-mode` row: two processes, `kill`, the receipt’s two clauses', () => {
    // (a), (k-i) two processes; (f) `kill` (SIGTERM) on the first stops both; (x7) "a drive still
    // running ten seconds after Ctrl-C or `kill` is killed", by `kill`; (e) the line is the relay's;
    // (e3) an abrupt end's walks clause; (e2) the standing before any piece; (e5) the clause is
    // scoped to an abrupt end (a clean drive without a manifest reads as today).
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
    // (a), (b) the grandchild masked; (h) the five seconds and the line; (x8) "is stopped". Unit 2:
    // the four doors, (s1)–(s4); "did not wait for" (B1): (h-s).
    claimChangelog(
      "- Hardening: when the output goes to a file or a pipe, what a program started by a step's handler prints there is hidden as the handler's own prints are: `realm agent`, `realm run drain`, `realm run advance`, `realm run respond` and `realm workflow run` run their work in a second process and keep the first to do the hiding. A program the command did not wait for that still holds the output open five seconds after the command's work ends is stopped, and Realm says so on its error output.",
    );
  });
});

/** U1b Unit 2's sentence for `realm run <name>` on the acting page. */
const actingSentence = (name: string): string =>
  `When its output goes to a file or a pipe, \`realm run ${name}\` runs its work in a second process and keeps the first to mask what reaches the file or pipe, as \`realm agent\` does; \`kill\` on the first process stops both.`;

describe('U1b Unit 2 — the docs say what the four doors do', () => {
  it.each([
    ['respond', '(s3)'],
    ['advance', '(s2)'],
    ['drain', '(s1), (t-s)'],
  ] as const)('realm-run-acting.md, the last paragraph of the `%s` section: %s', (name) => {
    // The masking: (s1)–(s3) of `four-doors-relay-u1b2.test.ts`; on a terminal, today's path:
    // (t-s); the `kill` clause: Unit 1's (f), the forward these doors reuse.
    claim('docs/reference/cli/realm-run-acting.md', actingSentence(name));
  });

  it('realm-workflow.md, the last paragraph of the `realm workflow run` section', () => {
    // (s4) the masking and the prompt on the terminal; (sig-s) `kill` on the first process; (z)
    // and (z2) Ctrl-Z and `fg`.
    claim(
      'docs/reference/cli/realm-workflow.md',
      'When its output goes to a file or a pipe, `realm workflow run` runs its work in a second process and keeps the first to mask what reaches the file or pipe, as `realm agent` does; `kill` on the first process stops both. Its prompts still reach your terminal when your error output is one; with both outputs in a file you type without seeing the prompt, as before. Ctrl-Z at a prompt and `fg` work as on a terminal.',
    );
  });

  it('the CHANGELOG’s Ctrl-Z line', () => {
    // (z2): on a terminal the prompt takes keys after `fg` (red on the base); (z) in log mode.
    claimChangelog(
      '- `realm workflow run`: after Ctrl-Z and `fg` at a prompt, the prompt takes keys again (it was redrawn but took none).',
    );
  });
});
