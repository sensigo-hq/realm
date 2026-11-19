// Gap 1, unit B — check 11: the words. Each sentence this unit wrote for a reader (the docs, the
// CHANGELOG, the help) is on its page word for word. The inspect lines themselves are pinned by the
// cells of model-text-inspect-b.test.ts, which print them from real runs; the page's example is
// pinned there too, against what inspect prints for the same run.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectCommand } from './inspect.js';
import { listenCommand } from './listen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** #871's form: the section that holds this unit's entry — `[Unreleased]` until a release renames
 *  it, then the first release section above `[0.50.0]`, never a fixed heading. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.50.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

const READING = 'docs/reference/cli/realm-run-reading.md';
const AGENT = 'docs/reference/cli/realm-agent.md';
const LISTEN = 'docs/reference/cli/realm-listen.md';

describe('gap 1, unit B — the words (check 11)', () => {
  it('realm-run-reading.md: the --verbose row and the section after its example', () => {
    // The row's cells: model-text-inspect-b.test.ts checks 1–6 (what is printed, and why none).
    claim(
      READING,
      "| `--verbose` | Under each tool call, also prints the arguments it was given and what it returned. Under each attempt of an agent step and under each drive failure, prints the text of its model requests: each message once, numbered, what each request sent and got back, its tool list, the cut and masking marks, and whether its system text, prompt and tool list are the ones that were sent, as far as Realm's hashes reach (a prompt built from a template, up to its first run value); or says why there is no text (added after version 0.50.0). |",
    );
    // The paragraph's cells: check 3 (matches, first <n> characters match, the empty start, the
    // final extraction's missing hashes, differs on an edit) and check 4.
    claim(
      READING,
      "A part that `matches` is the part Realm sent: Realm keeps a hash of each answered request's system text, tool list and prompt, taken as it sent it (Anthropic's last request in a tool loop has none), and inspect hashes the stored text again. For a prompt built from a template, Realm hashed only its text up to the first value the run fills in, so inspect says `first <n> characters match`, or `not checked (only its empty start was hashed)` when the template starts with a value: the rest, which holds the run's values, has no hash. Replies and a tool loop's later messages have no hash either. `differs` means the text on the record is not the text that was sent. The hashes are kept on the same record, so an edit that changes both a text and its hash is not caught by this check.",
    );
    claim(
      READING,
      'An agent step that `realm agent` drove with `--provider openai`, with `--verbose` (added after version 0.50.0). Its prompt is a template, `Classify this ticket: {{ run.params.ticket }}`, so its text up to the first value is its first 22 characters:',
    );
  });

  it('realm-agent.md: the flag row, the count and the re-attach sentence', () => {
    // The row's and the re-attach sentence's cells: model-text-drive-a1.test.ts check 6.
    claim(
      AGENT,
      "| `--no-record-model-text` | Off | Do not keep the text of each model call on the run's record. The step notes that recording was off (added after version 0.50.0). |",
    );
    claim(AGENT, 'This page lists its 18 flags,');
    claim(
      AGENT,
      'It also repeats `--no-record-model-text` when the drive was given it (added after version 0.50.0).',
    );
  });

  it('realm-listen.md: the flag row, the count and the agent’s flags', () => {
    // The cells: model-text-drive-a1.test.ts check 6 (listen passes the flag to its drives).
    claim(
      LISTEN,
      "| `--no-record-model-text` | Off | Do not keep the text of each model call on the run's record. The step notes that recording was off. Passed to each `realm agent` it starts (added after version 0.50.0). |",
    );
    claim(LISTEN, 'This page lists its argument and 19 flags (13 in version 0.49.0),');
    claim(
      LISTEN,
      '`--llm-timeout`, `--prompt-cache`, `--cache-diagnostics` and `--no-record-model-text` when `realm listen` was given them',
    );
  });

  it('run-record-and-export.md: the evidence entry’s masking sentence', () => {
    // Pinned by A1's mask cells: model-text-a1.test.ts check 3 (i) and (iii) (a declared secret's
    // fake value stored as [REDACTED], counted by `hidden`, masked before the cut) and
    // model-text-drive-a1.test.ts check 7 (a module's reported text kept masked).
    claim(
      'docs/reference/run-record-and-export.md',
      '`realm agent` and `realm listen` replace each known secret value in a text with `[REDACTED]`',
    );
  });

  it('the CHANGELOG lines', () => {
    // The Added line's cells: model-text-inspect-b.test.ts checks 1–10; A1's and A2b's for the
    // record. The Changed line is true on the base (CR-AUB-22).
    claimChangelog(
      "- **The text of each model call is kept on the run's record** (gap 1). Under `realm agent` and `realm listen`, each model request a step makes that gets an answer keeps the text Realm sent, its tool list and the reply, on the step's evidence entry (`model_text`). A drive that fails keeps, on its drive-failure entry, the requests its failure covers, including a last request that got no answer. Known secret values are replaced by `[REDACTED]`. Each text is cut at 64 KB, and a failure keeps at most 64 KB in all, each cut marked with the text's full size. `realm run inspect --verbose` prints the texts under each step and failure, says why there are none, and checks each request's system text, tool list and prompt against the hashes Realm kept when it sent it (for a prompt built from a template, its text up to the first value the run fills in). On by default; `realm agent --no-record-model-text` or `realm listen --no-record-model-text` turns it off. `get_run_state` never shows the texts, and a listing of runs leaves them out.",
    );
    claimChangelog(
      "- For a `--provider-module` provider, `@sensigo/realm-cli/agent` exports `ModelTextReport`: a provider returns `modelText`, one report per entry of `usage`, to have its calls' text kept, masked and cut as Realm's own; one that returns none gets `provider_did_not_report`.",
    );
  });

  it('the help: inspect’s --verbose and listen’s --no-record-model-text', () => {
    // (a) red when a help sentence is missing or reworded; (b) prints each check.
    expect({
      inspect: flat(inspectCommand.helpInformation()).includes(
        '--verbose Show full tool call args and results, and the text of each model call with its check against what was sent',
      ),
      listen: flat(listenCommand.helpInformation()).includes(
        "Do not keep the text of each model call on the run's record. The step notes that recording was off. Passed to each `realm agent` it starts.",
      ),
    }).toEqual({ inspect: true, listen: true });
  });
});
