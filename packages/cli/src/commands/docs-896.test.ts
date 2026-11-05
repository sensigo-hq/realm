// docs-896.test.ts — #896 unit A (guardrail 7(f), 9): each docs and CHANGELOG sentence the unit adds is
// quoted here word for word and asserted to be on its page, read from the repository. The behaviour
// each states is executed by the cell named beside it (`openai-explicit-cache-896.test.ts`, checks
// 1–10). Each assertion names (a) the change that turns it red and (b) what it prints when it fails:
// the sentence, never a record or an environment.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const flat = (t: string): string => t.replace(/\s+/g, ' ');
const read = (page: string): string => readFileSync(join(ROOT, page), 'utf8');
/** (a) red when the page no longer holds the sentence word for word; (b) prints the sentence. */
function claim(page: string, sentence: string): void {
  expect(flat(read(page)), `${page} no longer says: ${sentence}`).toContain(flat(sentence));
}
/** The section that holds this unit's entry: `[Unreleased]` until a release renames it. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.48.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

const AGENT_REF = 'docs/reference/cli/realm-agent.md';
const LISTEN_REF = 'docs/reference/cli/realm-listen.md';

describe('#896 unit A — the docs sentences', () => {
  it('realm agent: the --prompt-cache row and the Caching paragraph', () => {
    // The ask, the lifetime and off: checks 1, 5; the start line's words: check 10.
    claim(
      AGENT_REF,
      "On GPT-5.6 and later at OpenAI's own address, Realm also asks OpenAI to cache the fixed part of each step without tools for 30 minutes, the one lifetime Realm can ask OpenAI for (`short` and `long` alike), and `off` turns OpenAI's caching off (added after version 0.48.0).",
    );
    claim(
      AGENT_REF,
      "With OpenAI on GPT-5.6 and later at OpenAI's own address, it is `Caching: OpenAI is asked to cache each step's fixed instructions and the stable start of its prompt for 30 minutes, the one lifetime Realm can ask OpenAI for (set by --prompt-cache long).`; when an agent step calls tools, it ends `A step that calls tools is left to OpenAI's own caching, which reuses each turn at the next.`; when every agent step calls tools, it is `Caching: every agent step calls tools, so each is left to OpenAI's own caching, which reuses each turn at the next; Realm sends a cache key (set by --prompt-cache long).`; with `off` it is `Caching: off; OpenAI is asked to cache nothing (set by --prompt-cache off).` (added after version 0.48.0). On other OpenAI models, it is",
    );
  });

  it('realm listen: the --prompt-cache row and the listen: caching paragraph', () => {
    // Check 10 (listen's openai value in the set, off and not off); checks 1 and 5 (the request).
    claim(
      LISTEN_REF,
      "On GPT-5.6 and later at OpenAI's own address, the agent also asks OpenAI to cache the fixed part of each step without tools for 30 minutes, and `off` turns OpenAI's caching off (added after version 0.48.0).",
    );
    claim(
      LISTEN_REF,
      'When `--model` is GPT-5.6 or later and the endpoint is OpenAI\'s own, the openai value reads `"30 minutes, the one lifetime Realm can ask OpenAI for, and a cache key"`, and `"off: OpenAI is asked to cache nothing"` with off (added after version 0.48.0).',
    );
  });

  it('the realm agent guide: the Caching sentence and what the model is sent', () => {
    // Check 1 (the two marks, 30 minutes, explicit mode); check 10 (the start line).
    claim(
      'docs/guides/realm-agent.md',
      "The `Caching:` line says what `realm agent` asks Anthropic, or OpenAI on GPT-5.6 and later at OpenAI's own address, to cache, or whether it sends another OpenAI model a cache key,",
    );
    claim(
      'docs/guides/realm-agent.md',
      "On OpenAI GPT-5.6 and later at OpenAI's own address, Realm marks the same two parts with OpenAI's own marks, for 30 minutes, and asks OpenAI to write only up to them (added after version 0.48.0).",
    );
  });

  it('the record, run state and run-reading pages', () => {
    // The record's ask: checks 1 and 5; inspect's words: check 1.
    for (const page of [
      'docs/reference/run-record-and-export.md',
      'docs/reference/mcp/run-state-and-health.md',
    ]) {
      claim(
        page,
        "On OpenAI, `lifetime` and `off` are recorded for GPT-5.6 and later at OpenAI's own address (added after version 0.48.0).",
      );
    }
    claim(
      'docs/reference/run-record-and-export.md',
      'With `lifetime`: the lifetime asked, in seconds (`300`, `1800` or `3600`).',
    );
    claim(
      'docs/reference/run-record-and-export.md',
      "Anthropic's default, 5 minutes, is not sent; OpenAI's 30 minutes always is (added after version 0.48.0).",
    );
    claim(
      'docs/reference/run-record-and-export.md',
      '`system`, `prompt` (Anthropic, and OpenAI on GPT-5.6 and later) or `key` (OpenAI)',
    );
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      "(Anthropic's default, 5 minutes, is not sent; OpenAI's 30 minutes always is)",
    );
    claim(
      'docs/reference/cli/realm-run-reading.md',
      "On OpenAI GPT-5.6 and later at OpenAI's own address, a step without tools reads `asked for 30 minutes (sent as 30 minutes; …)` under every setting but `off` (added after version 0.48.0).",
    );
  });

  it('realm workflow: the words on the provider lines', () => {
    // Checks 1 and 6 (marks on a step without tools only); the once-line: validate-cacheability.
    claim(
      'docs/reference/cli/realm-workflow.md',
      "On GPT-5.6 and later at OpenAI's own address, the drive also marks the fixed part of each step without tools, for 30 minutes (added after version 0.48.0).",
    );
  });

  it('no docs page still shows validate’s old OpenAI words in a transcript', () => {
    // The transcripts were re-derived by running validate; `docs-pr5-cacheability.test.ts`'s example
    // cell runs realm-workflow.md's commands but finds each printed line anywhere on the page, so one
    // transcript put back to the old words would pass it while another holds the new ones.
    const pages = (dir: string): string[] =>
      readdirSync(join(ROOT, dir)).flatMap((name) => {
        const rel = join(dir, name);
        if (statSync(join(ROOT, rel)).isDirectory()) return pages(rel);
        return name.endsWith('.md') ? [rel] : [];
      });
    const old = [
      "openai: realm sends no cache marker; the provider's own rules decide",
      "— above the floor (200, your --floor): within the provider's own rules (realm sends no marker)",
    ];
    // (a) red when a transcript holds the old once-line or the old above-the-floor clause; (b)
    //     prints each page with the old words it holds.
    expect(
      pages('docs').flatMap((page) =>
        old.filter((w) => flat(read(page)).includes(flat(w))).map((w) => `${page}: ${w}`),
      ),
    ).toEqual([]);
  });

  it('CHANGELOG: one bullet per behaviour and the breaking shape', () => {
    for (const lead of [
      "**OpenAI GPT-5.6 and later cache only each step's fixed part.**",
      "**`--prompt-cache off` turns OpenAI's caching off on GPT-5.6 and later**",
      '**BREAKING: on those models the record and `capabilities()` state the ask:**',
    ])
      claimChangelog(lead);
  });
});
