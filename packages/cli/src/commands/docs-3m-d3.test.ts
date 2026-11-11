// docs-3m-d3.test.ts — caching 3-M piece D-3, check 8 (guardrail 7(f), 9): each docs and CHANGELOG
// sentence D-3 adds or rewrites that no older pin quotes is quoted here word for word and asserted to
// be on its page, read from the repository. The sentences older pins already quote, in their new
// words, stay in their files (`docs-600-3b`, `docs-896`, `docs-896b`, `docs-898`). The behaviour each
// states is pinned in the cell named beside it. A passage D-3 deletes is asserted gone. Each assertion
// names (a) the change that turns it red and (b) what it prints when it fails: the page and the
// sentence, never a record or an environment.
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
/** (a) red when the page holds the sentence a different number of times; (b) prints it and the count. */
function claimTimes(page: string, sentence: string, times: number): void {
  const count = flat(read(page)).split(flat(sentence)).length - 1;
  expect(count, `${page} holds ${String(count)} times: ${sentence}`).toBe(times);
}
/** (a) red when the page holds the words again; (b) prints them. */
function gone(page: string, words: string): void {
  expect(flat(read(page)).includes(flat(words)), `${page} still says: ${words}`).toBe(false);
}

const AGENT_REF = 'docs/reference/cli/realm-agent.md';
const LISTEN_REF = 'docs/reference/cli/realm-listen.md';
const GUIDE = 'docs/guides/realm-agent.md';
const READING = 'docs/reference/cli/realm-run-reading.md';
const AGENT_LINE =
  "Caching: Anthropic is asked to cache each step's fixed instructions and the stable start of its prompt for 5 minutes, 1 hour or not at all, as auto chooses per step from that step's own earlier runs (realm agent's default; turn it off with --prompt-cache off).";
/** What `realm run inspect` says of a step's first run under `auto` (`step_gaps`, no gap). */
const FIRST_RUN = 'auto: Realm found no earlier request of this step from the last 7 days)';

describe('caching 3-M D-3 check 8 — the docs say auto chooses per step, from its own runs', () => {
  it('realm-agent.md: the example start line; the hidden option and its refusal are gone', () => {
    // The line: D-3 check 1 (`agent/start-line-600.test.ts`, "auto: steps without tools only, realm
    // agent's default"). The page shows it in the example and in the Caching paragraph (docs-898).
    claim(AGENT_REF, `Run ID: 50e31961-baec-4e4e-ae6a-ef0af3754761\n${AGENT_LINE}`);
    // No cell for the option: commander refuses an unknown option (A3MD3-13).
    gone(AGENT_REF, '--cache-gaps');
    gone(AGENT_REF, 'no trigger history');
  });

  it('realm-agent.md and handlers.md: the re-attach command repeats no gaps, since listen passes none', () => {
    // A stated auto is repeated, a default is not: `agent.test.ts` cell 9 and
    // `agent/reattach-commands-676.test.ts` cell 9; listen passes no gaps: D-3 check 4.
    for (const page of [AGENT_REF, 'docs/reference/handlers.md']) {
      claim(
        page,
        'It also repeats `--prompt-cache` when the drive was given it and its provider applies it, `auto` included, never the default (added after version 0.47.0).',
      );
      gone(page, 'never the trigger gaps');
    }
  });

  it('realm-listen.md: each agent chooses per step; a drive you start; the measuring is gone', () => {
    // The gaps: D-2 check 1 (`core/src/economics/cache-lifetime.test.ts`, stepCacheGaps) and check 2
    // (`agent/step-cache-choices-3m.test.ts`, each step's own gaps).
    claim(
      LISTEN_REF,
      "With `--prompt-cache auto`, or none, each agent chooses a lifetime for each step without tools from that step's own earlier runs, read from the store when the drive starts: the gaps between up to six runs from the last 7 days that recorded the step, and the pause since the last of them (at most five gaps, in whole seconds).",
    );
    // No earlier run: D-2 check 4 (`commands/agent-auto-per-step-3m.test.ts`, the realm listen row)
    // and D-2 check 6 (`commands/openai-auto-896b.test.ts`). A tool step: D-2 check 5
    // (`agent/step-cache-choices-3m.test.ts`); on OpenAI, check 7 there and D-1 check 8. The line:
    // D-3 check 1.
    claim(
      LISTEN_REF,
      "A step with no earlier run in those 7 days asks Anthropic for 1 hour, and OpenAI for its 30 minutes. A step that calls tools asks Anthropic for 5 minutes: its own turns reuse what the turn before wrote. On OpenAI it is left to OpenAI's own caching. The agent's `Caching:` line, in `realm listen`'s output, says that `auto` chooses per step; what each step asked for, and why, is on the run:",
    );
    // D-2 check 4, the realm agent row.
    claim(
      LISTEN_REF,
      "A drive you start uses `realm agent`'s default: `auto` chooses for each step from its own earlier runs, and a step with no earlier run asks Anthropic for 5 minutes, unless you give `--prompt-cache` (added after version 0.48.0).",
    );
    // D-3 check 4 (`commands/listen.test.ts`).
    gone(LISTEN_REF, '--cache-gaps');
    gone(LISTEN_REF, 'no trigger history');
  });

  it('the guide: the two start lines, the first run and a later run of the same workflow', () => {
    // D-3 check 1.
    claimTimes(GUIDE, AGENT_LINE, 2);
    // The first run: D-3's `inspect-auto-prices-898.test.ts` "no kept gaps" row (the words).
    claimTimes(GUIDE, FIRST_RUN, 2);
    // A later run, 2 minutes on, no price file: D-2r check 2 (`agent-auto-per-step-3m.test.ts`).
    claimTimes(
      GUIDE,
      "asked for 1 hour (sent as 1 hour; realm agent's default; auto: the last gap between this step's runs was about 2 minutes; no price file (runner.cache.economics is not set), so 1 hour without prices)",
      2,
    );
    // The prior: D-2 check 4, the realm agent row.
    claim(
      GUIDE,
      'keep it for 5 minutes (`--prompt-cache auto`, the default, on a drive you start, for a step with no earlier run):',
    );
    gone(GUIDE, 'no trigger history');
  });

  it("realm-run-reading.md: the first run's auto clause", () => {
    // As the guide's first run.
    claimTimes(READING, FIRST_RUN, 2);
    gone(READING, 'no trigger history');
    gone(READING, 'price source not recorded');
  });

  it('run-record-and-export.md and run-state-and-health.md: the four bases, and an older record', () => {
    // The list: D-3 check 6's break (`commands/inspect-auto-bases-3m-d3.test.ts`); the producers:
    // D-2 checks 2, 5 and 7; `no_measurement`'s words: D-3 check 7. The older record: D-3 check 6.
    claim(
      'docs/reference/run-record-and-export.md',
      "`basis` is `step_gaps` (`gaps_s` holds the step's gaps between its earlier runs, in seconds, at most five; an empty list means no earlier request of the step from the last 7 days), `step_gaps_unreadable` (the earlier runs could not be read), `tool_step` (a step that calls tools asks for 5 minutes on Anthropic; `auto` does not choose for it) or `no_measurement` (no gaps were measured), added after version 0.48.0.",
    );
    claim(
      'docs/reference/run-record-and-export.md',
      'A record from an earlier version whose `basis` named `realm listen` keeps that word in the record and in `realm run export`; `realm run inspect` and `get_run_state` show no `auto` for it.',
    );
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "`basis` (`step_gaps`, with `gaps_s`, the step's gaps between its earlier runs in seconds, at most five — an empty list means no earlier request of the step from the last 7 days; `step_gaps_unreadable`, the earlier runs could not be read; `tool_step`, a step that calls tools asks for 5 minutes on Anthropic, and `auto` does not choose for it; `no_measurement`, no gaps were measured; added after version 0.48.0)",
    );
    // The example, a step's first run: D-2 check 4 (the record's `cache_auto`).
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      '"auto": { "basis": "step_gaps", "gaps_s": [] }',
    );
    gone('docs/reference/mcp/run-state-and-health.md', "{ from: 'not_recorded' }");
  });

  it('the CHANGELOG entries', () => {
    // Per step: D-2 checks 2, 4, 5 and 12; listen measures nothing: D-3 check 4. The option: D-1's
    // checks (`agent/providers/cache-choice-per-call-3m.test.ts`). Upgrading: D-2r check 2, D-2
    // check 4, and D-3 check 6 (the two words read as no `auto`); its restart sentence (correction
    // 1): the earlier listen's `buildAgentArgv` and `process.argv[1]`, read on be67eb3f, and
    // commander's unknown-option refusal, run on the built CLI (registry 3MD3C1-IA-04).
    const text = read('CHANGELOG.md');
    const start = text.includes('## [Unreleased]')
      ? text.indexOf('## [Unreleased]')
      : text.indexOf('\n## [') + 1;
    const section = flat(text.slice(start, text.indexOf('\n## [0.48.0]')));
    for (const sentence of [
      '- **`--prompt-cache auto` chooses per step.** Each step without tools takes the lifetime its own earlier runs pay for, read from the store when the drive starts, so a drive you start yourself gets a measured choice too. A step that calls tools asks Anthropic for 5 minutes. `realm listen` no longer measures gaps of its own. (#600)',
      '- **`callStepWithMeta` and `callStepWithTools` take `cacheChoice`,** a cache lifetime chosen for that call; a provider module that ignores it sends what it always sent. (#600)',
      '- **BREAKING — restart a `realm listen` that is already running when you upgrade; a drive you start yourself asked for 5 minutes every time; a step without tools that has earlier runs now asks for what its gaps pay for, and with no price file for 1 hour when a recent gap is under 54 minutes, else for no caching. `cache_auto.basis` no longer has `listen_trigger_gaps` or `listen_gaps_unreadable`. Restart a `realm listen` that is already running when you upgrade: if it is on `auto` (its default), it still passes `--cache-gaps` to its agents, which `realm agent` now refuses. (#600)',
    ]) {
      // (a) red when the entry is gone or reworded; (b) prints the sentence.
      expect(section, `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
    }
  });
});
