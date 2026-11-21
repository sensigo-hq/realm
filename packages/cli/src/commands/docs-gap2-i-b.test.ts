// docs-gap2-i-b.test.ts — gap 2, unit (i-b), check 13: each sentence this unit changes, pinned where
// the repo pins such words, and the old one gone. Pages are compared with their whitespace collapsed
// (prettier pads table cells). The behaviour each sentence claims is executed in
// retries-provider-g2ib.test.ts, retries-drive-g2ib.test.ts and retry-notice-g2ib.test.ts.
//
// Each cell carries (a) the break that turns it red and (b) what it prints.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const flat = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');
const RETRY = 'docs/reference/workflow/retry-and-timeouts.md';
const FIELDS = 'docs/reference/workflow/step-fields.md';
const LOADER = 'docs/reference/workflow/loader-diagnostics.md';
const CONTROLS = 'docs/reference/workflow/agent-step-controls.md';
const AGENT = 'docs/reference/cli/realm-agent.md';
const RECORD = 'docs/reference/run-record-and-export.md';

/** Which of `sentences` `rel` holds, and which of `gone` it still holds. */
function check(rel: string, sentences: string[], gone: string[] = []) {
  const text = flat(rel);
  return {
    missing: sentences.filter((s) => !text.includes(s.replace(/\s+/g, ' '))),
    stillThere: gone.filter((s) => text.includes(s.replace(/\s+/g, ' '))),
  };
}
const CLEAN = { missing: [], stillThere: [] };

describe('gap 2, unit (i-b) — check 13: the words', () => {
  it('retry-and-timeouts.md (Words 3)', () => {
    // (a) red when a sentence is missing or the old text stays; (b) prints which.
    expect(
      check(
        RETRY,
        [
          '`retry` is a block on an `auto` step, and on an agent step that `realm agent` or `realm listen` drives. It has six keys.',
          '| `retry.max_attempts` | How many times the step is tried. | `auto`, `agent` | 1 |',
          '| `retry.total_timeout_seconds` | All attempts together, with the waits between them. | `auto`; `agent`, with `retry` |',
          // Correction 1, Words 5 and 7.
          'Whether a timed-out attempt is tried again. On an agent step, a timed-out try is sent again unless this is `false`; `true` does not load there. |',
          'so these are its only tries. The re-sends Realm already makes, once each, when a request fails on its strict mode, its cache fields or its cache question, come on top of these tries.',
          '### On an agent step',
          'A request is tried again only after a failure another try can fix: a 408, 409, 429 or 5xx answer, a timeout, or a lost connection.',
          'When it declares none of `backoff`, `base_delay_ms` and `max_delay_ms`, it waits as the model client did: 500 ms, doubling, at most 8 s.',
          'otherwise `max_attempts` times the timeout of one try (`llm_timeout_seconds`, `--llm-timeout`, or 600 s), plus the waits, plus 60 s. A wait that would pass the limit is not taken: the drive stops at once.',
          'so a tool the model already called never runs again.',
          'After the last try, the drive stops and the run stays open, as after any failed model call.',
          '`retry` never asks the model again after it gave an answer that was refused; that is `--schema-retries`.',
          'For a module that does not, Realm tries its whole call again on a step without tools, and tries nothing again on a step with tools; the drive then says so once.',
          'A run an assistant drives over MCP makes no model call through Realm, so `retry` on an agent step does nothing there.',
          "| `retry` on a guard step | `'retry' is inert on execution: 'guard' steps — …` |",
        ],
        [
          '`retry` is a block on an `auto` step. It has six keys.',
          '| `retry` on an agent or guard step |',
          'On an agent step, only false loads, and then a timed-out try is not sent again.',
        ],
      ),
    ).toEqual(CLEAN);
  });

  it('step-fields.md and loader-diagnostics.md (Words 4, 5)', () => {
    // (a) red when a sentence is missing or the old text stays; (b) prints which.
    expect({
      fields: check(
        FIELDS,
        [
          '| `retry` | yes | yes | – | no |',
          // Correction 1, Words 9.
          'Tries the step again after an error marked as retryable; on an agent step under realm agent or realm listen, a model request that failed for a reason another try can fix.',
          'For example, `retry` on a guard step:',
          "⚠ Step 's': 'retry' is inert on execution: 'guard' steps — a guard's evaluation never traverses the dispatch path",
        ],
        [
          '| `retry` | yes | – | – | no |',
          "'retry' is inert on execution: 'agent' steps",
          'on an agent step under realm agent, a model request',
        ],
      ),
      loader: check(
        LOADER,
        [
          '`retry` is on a guard step, where it does nothing.',
          '`retry.total_timeout_seconds` is on a guard step, where it does nothing.',
        ],
        [
          '`retry` is on an agent or guard step, where it does nothing.',
          '`retry.total_timeout_seconds` is on a step that is not an `auto` step.',
        ],
      ),
    }).toEqual({ fields: CLEAN, loader: CLEAN });
  });

  it('the CHANGELOG: an Upgrading item and a Changed line (Words 6)', () => {
    const log = flat('CHANGELOG.md');
    const unreleased = log.slice(log.indexOf('## [Unreleased]'), log.indexOf('## [0.'));
    const upgrading = unreleased.slice(0, unreleased.indexOf('### Added'));
    const added = unreleased.slice(
      unreleased.indexOf('### Added'),
      unreleased.indexOf('### Changed'),
    );
    const changed = unreleased.slice(
      unreleased.indexOf('### Changed'),
      unreleased.indexOf('### Fixed'),
    );
    // (a) red when either is missing, reworded, or under another heading, or the (i-a) item still
    //     says Realm fills none in (correction 1, Words 4); (b) prints which.
    expect({
      added: [
        added.includes(
          ", the member that carries them (`realm agent` and `realm listen` fill them in for an agent step that declares `retry`; see Changed); core's",
        ),
        added.includes('Realm fills none of them in yet'),
      ],
      upgrading: upgrading.includes(
        "**6. `retry` on an agent step now takes effect under `realm agent` and `realm listen`.** A step that declares it is tried up to `max_attempts` times per model request (once when `max_attempts` is absent) on a failure another try can fix (a 408, 409, 429 or 5xx, a timeout or a lost connection), in place of the model client's own up to 3 tries.",
      ),
      grammar: upgrading.includes(
        'A strict request answered "503 grammar compilation unavailable" is sent without strict after one try, where the model client tried it up to 3 times with strict first.',
      ),
      changed: changed.includes(
        '- `realm agent` and `realm listen` now write `model_attempts` for an agent step that declares `retry`: on its evidence entry when it succeeds after a failed try, and on its drive-failure entry when the run is left open.',
      ),
      names: [
        '`LlmClock`',
        '`ModelRetryPolicy`',
        '`ProviderCapabilities`',
        '`handlesRetries`',
      ].filter((n) => !changed.includes(n)),
    }).toEqual({ added: [true, false], upgrading: true, grammar: true, changed: true, names: [] });
  });

  it('run-record-and-export.md (Words 9)', () => {
    // (a) red when a row is missing or the old sentence stays; (b) prints which.
    expect(
      check(
        RECORD,
        [
          '`realm agent` and `realm listen` write it for a step that declares `retry`, and a program that embeds the engine can still pass its own in `StepMeta.modelAttempts`.',
          '| `model_attempts` | No | The failed tries of the model requests this failure covers, as on an evidence entry: written by `realm agent` and `realm listen` for a step that declares `retry`. |',
        ],
        [
          'Realm writes none yet; a program that embeds the engine can pass them in `StepMeta.modelAttempts`.',
        ],
      ),
    ).toEqual(CLEAN);
  });

  it('realm-agent.md and agent-step-controls.md (Words 10, 11)', () => {
    // (a) red when a sentence is missing or the old one stays; (b) prints which.
    expect({
      agent: check(
        AGENT,
        [
          "When a step declares `retry`, the clock its call is given (`opts.llmClock`) carries `retry`: the step's `retry` block, `capMs` (the longest one model request may take with all its tries, waits and re-sends) and `mayResend()`, which says whether another send is allowed.",
          'A module that does this declares `handlesRetries: true` in its `capabilities()`, and calls `mayResend()` before each re-send',
          "Without `handlesRetries`, Realm tries the module's whole call again on a step without tools; on a step with tools it tries nothing again, and says so once",
          // Correction 1, Words 8.
          "A request that times out is tried again by the provider's client; on a step that declares `retry`, Realm tries it again instead, as the block says.",
        ],
        [
          "A request that times out is tried again by the provider's client, or by Realm, as its block says, on a step that declares retry.",
        ],
      ),
      controls: check(CONTROLS, [
        'sent again, up to three times in all; on a step that declares retry, up to its max_attempts (see [Retry and timeouts](retry-and-timeouts.md#on-an-agent-step)).',
        'which Realm works out from it; on a step that declares retry, the cap of its tries.',
      ]),
    }).toEqual({ agent: CLEAN, controls: CLEAN });
  });

  it('the "never honors" sweep and the public JSDoc of total_timeout_seconds (Words 12)', () => {
    const files = [
      'packages/cli/src/agent/providers/agent-utils.ts',
      'packages/cli/src/agent/providers/anthropic-provider.ts',
      'packages/core/src/types/run-record.ts',
    ];
    const jsdoc = flat('packages/core/src/types/workflow-definition.ts').replace(/ \* /g, ' ');
    // (a) red when a "never honors" comment comes back, or the JSDoc says inert on agent steps;
    //     (b) prints the files that still say it and the check.
    expect({
      neverHonors: files.filter((f) => /never honou?r/i.test(flat(f))),
      cap: jsdoc.includes(
        'On an agent step that declares `retry`, it is the cap on each model request with all its tries, waits and re-sends, under `realm agent` and `realm listen` (gap 2, unit (i-b)). Inert on a guard step (W5 warns).',
      ),
      oldInert: jsdoc.includes("Inert on a non-`execution: 'auto'` step (W5 warns)"),
    }).toEqual({ neverHonors: [], cap: true, oldInert: false });
  });

  it('correction 1, Words 1–3 and 6: the public JSDoc of model_attempts and the inspect comment', () => {
    const jsdoc = (rel: string) => flat(rel).replace(/ \* /g, ' ');
    const record = jsdoc('packages/core/src/types/run-record.ts');
    const loop = jsdoc('packages/core/src/engine/execution-loop.ts');
    const inspect = jsdoc('packages/cli/src/commands/inspect.ts');
    // (a) red when a sentence is missing or an old one stays; (b) prints which.
    expect({
      evidence: record.includes(
        'Each entry is closed at the write to its eight members. `realm agent` and `realm listen` write it for an agent step that declares `retry` (gap 2, unit (i-b)); a program that embeds the engine can still pass its own in `StepMeta.modelAttempts`. Absent means no tries were recorded for the entry, as on every entry written by Realm 0.50.0 or earlier. No surface fills it in.',
      ),
      failure: record.includes(
        'with no text and no usage. `realm agent` and `realm listen` write it for an agent step that declares `retry` (gap 2, unit (i-b)). Absent means Realm recorded no tries',
      ),
      meta: loop.includes(
        '`realm agent` and `realm listen` pass it for an agent step that declares `retry` (gap 2, unit (i-b)).',
      ),
      inspect: inspect.includes('`realm run export` and get_run_state carry the full entries.'),
      old: [
        record.includes('Realm writes none'),
        loop.includes('Realm does not pass it yet.'),
        inspect.includes('`--json` and get_run_state carry the full entries.'),
      ],
    }).toEqual({
      evidence: true,
      failure: true,
      meta: true,
      inspect: true,
      old: [false, false, false],
    });
  });
});
