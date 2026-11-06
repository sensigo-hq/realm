// docs-600-3b.test.ts — caching 3-B (guardrail 7(f), 9): each docs and CHANGELOG sentence 3-B adds or
// rewrites is quoted here word for word and asserted to be on its page, read from the repository. The
// behaviour each states is pinned in the cell named beside it. Each assertion names (a) the change that
// turns it red and (b) what it prints when it fails: the sentence, never a record or an environment.
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
 *  it, then the first release section above `[0.48.0]`. */
function claimChangelog(sentence: string): void {
  const text = read('CHANGELOG.md');
  const start = text.includes('## [Unreleased]')
    ? text.indexOf('## [Unreleased]')
    : text.indexOf('\n## [') + 1;
  const section = text.slice(start, text.indexOf('\n## [0.48.0]'));
  expect(flat(section), `the CHANGELOG no longer says: ${sentence}`).toContain(flat(sentence));
}

const MCP_GUIDE = 'docs/guides/cache-an-mcp-step-prompt.md';

describe('caching 3-B Part B — the MCP door’s stable_prefix (B6)', () => {
  it('the guide: what the field is and holds', () => {
    // The field on a run_step entry: mcp-server `stable-prefix-3b.test.ts` (f), (g).
    claim(
      MCP_GUIDE,
      'When Realm hands an MCP client a step to run (a `run_step` entry in `next_actions`), the entry can say where that fixed start ends, so the client can cache it with its own model provider (added after version 0.48.0).',
    );
    // UTF-16 code units of the received prompt; SHA-256 of the UTF-8 bytes, 64 lowercase hex:
    // `stable-prefix-3b.test.ts` (a), (d), (g) (a client cuts and hashes).
    claim(
      MCP_GUIDE,
      "`chars`: how long the fixed start is in the `prompt` you received, in UTF-16 code units (a JavaScript string's length).",
    );
    claim(
      MCP_GUIDE,
      "`sha256`: the SHA-256 of that start's UTF-8 bytes, as 64 lowercase hexadecimal characters.",
    );
    // Where the start ends: core `render-boundary-3b.test.ts` (A2's boundary, A3's rule).
    claim(
      MCP_GUIDE,
      "The start ends at the prompt's first placeholder whose value can differ between runs.",
    );
    // Hashed after hiding; never cut inside a hidden value: `stable-prefix-3b.test.ts` (a) (the cut
    // moves back), core `redaction-split-3b.test.ts` (the law at every cut).
    claim(
      MCP_GUIDE,
      'Realm hashes the start after it has hidden every secret in the prompt. A hidden value is never cut: when one would cross the boundary, the boundary moves back to where the hidden value starts.',
    );
  });

  it('the guide: when the field is absent', () => {
    // No prompt: core `render-boundary-3b.test.ts` (stepBrief, none without a prompt). Withheld:
    // `stable-prefix-3b.test.ts` (c). Changed beyond the secret: (b), #901's D2-6 input.
    claim(
      MCP_GUIDE,
      '`stable_prefix` is absent when the step has no prompt. It is also absent when Realm cannot vouch that the prompt you received starts with that head: when the server could not read the declared secrets (the reply then withholds values), or when hiding a secret changed more of the prompt than the secret itself.',
    );
  });

  it('tools.md: the run_step entry’s stable_prefix row, and the guide is registered', () => {
    claim(
      'docs/reference/mcp/tools.md',
      "| `stable_prefix` | Where the `prompt`'s fixed start ends, so a client can cache it: `chars` (UTF-16 code units of the `prompt` you received), `unit` (`utf16`) and `sha256` (the SHA-256 of that start's UTF-8 bytes). Absent when Realm cannot vouch for it. See [Cache a step's prompt over MCP](../../guides/cache-an-mcp-step-prompt.md) (added after version 0.48.0). |",
    );
    claim(
      'docs/README.md',
      "- [Cache a step's prompt over MCP](guides/cache-an-mcp-step-prompt.md)",
    );
    claim('website/src/data/docs-sidebar.mjs', "'docs/guides/cache-an-mcp-step-prompt',");
  });
});

const AGENT_GUIDE = 'docs/guides/realm-agent.md';

describe('caching 3-B Part C — the head on Anthropic (rows 8, 9, A3, B8)', () => {
  it('row 8: the fixed part names the start of the step prompt', () => {
    // The head block beside the system block: `anthropic-provider-head-3b.test.ts` (two blocks).
    claim(
      AGENT_GUIDE,
      "The system prompt is the fixed part of the request, with the start of the step's prompt: both are the same for every request of the step.",
    );
  });

  it('row 9 (the head), A3’s author guidance and B8', () => {
    // Its own marked block, the rest after it: `anthropic-provider-head-3b.test.ts` (shapes);
    // where it ends: core `render-boundary-3b.test.ts` (A2, A3); a request without the split:
    // `anthropic-provider-head-3b.test.ts` (off; no cachePrefixChars).
    for (const sentence of [
      "On a step without tools, the start of the step's prompt is cached too: Realm sends it as a block of its own, marked the same way, and the rest of the prompt after it (added after version 0.48.0).",
      "The cached start of a step's prompt ends at its first placeholder whose value can differ between runs; put fixed text first.",
      "A request sent without the split — under `--prompt-cache off`, or when Realm withholds it — never reads a split head's cache. That is expected.",
    ]) {
      claim(AGENT_GUIDE, sentence);
    }
  });

  it('row 10: the start-line transcripts carry row 2’s words, and none keeps the old ones', () => {
    // Row 2's words: `start-line-600.test.ts` (FIX), `prompt-cache-600.test.ts` :243, :263. The
    // guide shows the line twice (:51, :154), so a transcript put back to the old words leaves the
    // new words on the page: the absence of the old words is what turns that one red.
    for (const page of [
      AGENT_GUIDE,
      'docs/reference/cli/realm-agent.md',
      'docs/reference/cli/realm-listen.md',
    ]) {
      claim(
        page,
        "Caching: Anthropic is asked to cache each step's fixed instructions and the stable start of its prompt for",
      );
      // (a) red when any transcript on the page holds the old words; (b) prints the page and words.
      expect(
        flat(read(page)).includes(
          "Caching: Anthropic is asked to cache each step's fixed instructions for",
        ),
        `${page} still has a start-line transcript in the old words`,
      ).toBe(false);
    }
  });

  it('the guide’s Caching-line sentence names the OpenAI key (a Q5 member, :67)', () => {
    // The start line's OpenAI words: `openai-endpoint-3b.test.ts` (D4).
    claim(
      AGENT_GUIDE,
      "The `Caching:` line says what `realm agent` asks Anthropic, or OpenAI on GPT-5.6 and later at OpenAI's own address, to cache, or whether it sends another OpenAI model a cache key, and where the setting came from;",
    );
  });
});

const AGENT_REF = 'docs/reference/cli/realm-agent.md';
const LISTEN_REF = 'docs/reference/cli/realm-listen.md';
const OPENAI_KEY_WORDS =
  "With `--provider openai`, Realm sends a cache key, a hint: to OpenAI's own endpoint under every setting but `off`, and to another endpoint only for a setting you state other than `off`.";
/** #896: each flag row's GPT-5.6 sentence sits between 3-B's OpenAI sentence and the last one
 *  (`docs-896.test.ts` pins its words). */
const OPENAI_WORDS = (gpt56: string): string =>
  `${OPENAI_KEY_WORDS} ${gpt56} (added after version 0.48.0). Other providers' own caching applies.`;
/** (a) red when the page holds the old words again; (b) prints them. */
function gone(page: string, words: string): void {
  expect(flat(read(page)).includes(flat(words)), `${page} still says: ${words}`).toBe(false);
}

describe('caching 3-B Part D — OpenAI’s cache key (rows 3, 4, 5, 9, 11–15, 19, 20)', () => {
  it('rows 3, 11, 14: the flag rows name the key, and the one refusal left', () => {
    // The key's rule: `openai-cache-key-3b.test.ts` (D2); G18 stays: `prompt-cache-600.test.ts`.
    claim(
      AGENT_REF,
      `${OPENAI_WORDS("On GPT-5.6 and later at OpenAI's own address, Realm also asks OpenAI to cache the fixed part of each step without tools for 30 minutes, the one lifetime Realm can ask OpenAI for (`short` and `long` alike); on a drive realm listen starts, `auto` chooses between that and no caching, as for Anthropic, and without usable prices asks for 30 minutes when a recent gap is under 27 minutes; `off` turns OpenAI's caching off")} See [What a run costs](../../guides/realm-agent.md#what-a-run-costs). Refused with \`--provider-module\`, and for a workflow with no agent step.`,
    );
    claim(
      LISTEN_REF,
      `\`off\`. ${OPENAI_WORDS("On GPT-5.6 and later at OpenAI's own address, the agent also asks OpenAI to cache the fixed part of each step without tools for 30 minutes (under `auto`, 30 minutes or no caching for each workflow, by the gaps between its recent triggers and the prices in runner.cache.economics; without usable prices, 30 minutes when a recent gap is under 27 minutes), and `off` turns OpenAI's caching off")} Added after version 0.47.0.`,
    );
  });

  it('rows 4, 5, 19, 20: the refusals 3-B deletes are gone from the pages', () => {
    // Accepted now: `prompt-cache-600.test.ts` G17, G19.
    gone(AGENT_REF, '`--prompt-cache` with a provider Realm asks for no caching');
    gone(LISTEN_REF, '`--prompt-cache` with `--provider openai` (added after version 0.47.0)');
    gone(LISTEN_REF, 'It also refuses `--prompt-cache` with `--provider openai`');
    claim(
      AGENT_REF,
      'The `--prompt-cache` refusal and the `--cache-gaps` one end the same way (added after version 0.47.0);',
    );
  });

  it('row 12: the Caching line on OpenAI, per endpoint and setting', () => {
    // Each line: `openai-endpoint-3b.test.ts` (D4, per branch).
    claim(
      AGENT_REF,
      "On other OpenAI models, it is `Caching: OpenAI caches by its own rules; Realm sends a cache key that helps repeated steps reach the same cache (OpenAI treats it as a hint). Realm cannot set OpenAI's lifetime or turn its caching off.`, and with `--prompt-cache short` or `long` stated it adds `--prompt-cache long sets no lifetime on OpenAI.`; with `off` it is `Caching: off; Realm sends OpenAI no cache key. OpenAI's own caching, if any, applies.`",
    );
    claim(
      AGENT_REF,
      'On another endpoint (`--base-url` or `OPENAI_BASE_URL`) it says `this endpoint` in place of `OpenAI`, and Realm sends the key only for a setting you state: without one it is `Caching: this endpoint caches by its own rules; Realm sends it no cache key (state --prompt-cache to send one).`, and with `off` it is `Caching: off; Realm sends this endpoint no cache key. Its own caching, if any, applies.` (added after version 0.48.0).',
    );
  });

  it('row 13: a provider module may declare provider', () => {
    // `openai-endpoint-3b.test.ts` (D4, the module branch).
    claim(
      AGENT_REF,
      "and for `'provider'` — the service caches by its own rules — `Caching: this provider caches by its own rules.` (added after version 0.48.0).",
    );
  });

  it('row 14: the listen caching line names the key', () => {
    // `listen.test.ts` (listenCachingFacts).
    claim(
      LISTEN_REF,
      'With `--provider openai`, it is `listen: caching {"openai":"sends a cache key on OpenAI\'s own endpoint","anthropic":"not used"}` (added after version 0.48.0).',
    );
  });

  it('row 14 (MA 1’s wording list): the listen caching line’s openai value per endpoint and setting', () => {
    // Each value is executed by `listen.test.ts` (the five branch cells, "3-B — the openai value on
    // …") and, with OPENAI_BASE_URL, by the built listen in `no-default-model-676.test.ts`.
    for (const sentence of [
      "Both quotes show OpenAI's own endpoint with a setting other than `off`.",
      'With `--prompt-cache off` it reads `"off: no cache key on OpenAI\'s own endpoint"`; when `OPENAI_BASE_URL` names another endpoint, it reads `"sends a cache key to the custom endpoint"` for a stated setting, `"no cache key to the custom endpoint (state --prompt-cache to send one)"` without one, and `"off: no cache key to the custom endpoint"` with off.',
    ]) {
      claim(LISTEN_REF, sentence);
    }
  });

  it('row 15: provider_rules with cache_key_sent, on the three pages', () => {
    // The fact: `openai-cache-key-3b.test.ts`; inspect's words: `inspect-split-3b.test.ts`.
    claim(
      'docs/reference/run-record-and-export.md',
      "`provider_rules` (Realm asked for nothing; the provider's own caching, if any, applies); with `cache_key_sent`, Realm also sent a cache key (added after version 0.48.0).",
    );
    claim(
      'docs/reference/cli/realm-run-reading.md',
      "with `cache_key_sent`, Realm also sent a cache key, and the words are `asked for nothing but a cache key, a hint (the provider's own caching applies)` (added after version 0.48.0).",
    );
    claim(
      'docs/reference/mcp/run-state-and-health.md',
      'with `cache_key_sent`, Realm also sent a cache key, and the entry has `key_sent: true` (added after version 0.48.0).',
    );
  });

  it('row 9 (OpenAI): the guide says OpenAI caches by its own rules and when the key goes out', () => {
    // `openai-cache-key-3b.test.ts` (D2).
    claim(
      AGENT_GUIDE,
      "OpenAI caches by its own rules: Realm cannot set its lifetime or turn its caching off. On OpenAI's own endpoint Realm sends a cache key with each request whose prompt has a fixed start, a hint that helps repeated steps reach the same cache, under every setting but `off`; on another endpoint, only for a setting you state (added after version 0.48.0).",
    );
  });
});

describe('caching 3-B Part E — the gateway rule (rows 21, 23)', () => {
  it('row 21: ANTHROPIC_BASE_URL on both pages', () => {
    // The retry, the memory and inspect's words: `gateway-rule-3b.test.ts`, `inspect-split-3b.test.ts`.
    const sentence =
      "A service there that refuses the request to cache with a 400 saying `cache_control` is not allowed is sent that request again without Realm's cache fields; when that works, every later request of the drive goes without them, and `realm run inspect` says so. A refusal in other words still makes each agent step fail: use `--prompt-cache off` (added after version 0.47.0).";
    claim(AGENT_REF, sentence);
    claim('docs/reference/environment-and-files.md', sentence);
  });

  it('row 23: the refusal replaces the gateway clause, with its words and one real sample', () => {
    // The suppression and the words: `inspect-split-3b.test.ts` (M10 cross cell; E4).
    claim(
      'docs/reference/cli/realm-run-reading.md',
      "When the endpoint's refusal of the cache fields was recorded, that clause is not printed, and the step's cache line says instead `the endpoint refused the cache fields (400); sent without them for the rest of the drive — to stop sending them: --prompt-cache off` (added after version 0.48.0), as in `cache: not engaged — read 0, wrote 0 (provider-reported, 1 request); asked for 5 minutes (the provider's default lifetime; realm agent's default); the endpoint refused the cache fields (400); sent without them for the rest of the drive — to stop sending them: --prompt-cache off`.",
    );
    claim(
      'docs/reference/run-record-and-export.md',
      "When the endpoint's refusal of the cache fields was recorded (`cache_controls_rejected`), that clause is not printed, and `realm run inspect` says the endpoint refused the cache fields instead (added after version 0.48.0).",
    );
  });
});

describe('caching 3-B Part F — the reference text, the describer and the CHANGELOG', () => {
  it('row 16 and F2: the fixed part counts the prompt’s stable start; different starts share nothing', () => {
    // `validate-head-3b.test.ts` (a)–(c); core `cacheability-size-3b.test.ts`.
    claim(
      'docs/reference/cli/realm-workflow.md',
      "An agent step sends the same text ahead of its input on every call: its profile, Realm's instructions, its schema and the start of its prompt, up to the prompt's first placeholder whose value can differ between runs (the prompt's start added after version 0.48.0).",
    );
    claim(
      'docs/reference/cli/realm-workflow.md',
      "The start of each step's prompt is part of the fixed part, so two steps whose prompts start differently share no whole fixed part (added after version 0.48.0).",
    );
  });

  it('the record page lists the split’s facts, and the store contract holds them', () => {
    // The facts: `anthropic-provider-head-3b.test.ts`, `openai-cache-key-3b.test.ts`,
    // `gateway-rule-3b.test.ts`; the contract: testing `usage-record-law-600.test.ts`.
    claim(
      'docs/reference/run-record-and-export.md',
      'A request whose step prompt Realm split at its stable start (its head) also carries the split’s facts (added after version 0.48.0):'.replace(
        '’',
        "'",
      ),
    );
    claim(
      'docs/reference/testing-package.md',
      "It also comes back with the split's facts: `prefix_sha256`, `prefix_chars`, `prefix_parts`, `cache_marked`, `request_strict_sent`, `cache_controls_rejected` and `cache_key_sent` (added after version 0.48.0).",
    );
  });

  it('core-library.md names the four new exports', () => {
    // core `redaction-split-3b.test.ts`, `split-facts-3b.test.ts` (A5).
    for (const name of [
      '`renderStepPromptWithBoundary(definition, step)`',
      '`discloseSplit(text, cut, set, tier)`',
      '`discloseSplitSize(text, cut, set, tier)`',
      '`discloseLeaf(text, set, tier)`',
    ])
      claim('docs/reference/core-library.md', `| ${name} |`);
  });

  it('CHANGELOG: one bullet per behaviour and per widened shape', () => {
    for (const lead of [
      "**`realm agent` caches the stable start of each agent step's prompt on Anthropic.**",
      '**OpenAI gets a cache key.**',
      "**An MCP `run_step` entry carries `stable_prefix`: `{ chars, unit: 'utf16', sha256 }`.**",
      "**On a custom endpoint, a 400 that names Realm's cache fields drops them.**",
      '**Each request whose prompt was split records the split:**',
      "**`ProviderCapabilities.promptCache` may be `'provider'`**",
      '**`callStepWithMeta` and `callStepWithTools` take `cachePrefixChars`,**',
      '**`McpNextAction` gains `stable_prefix`.**',
      '**The composed cost view gains `CostView.cache_head` and `CostView.cache_fields_refused`, and `CacheRequestedEntry.key_sent`.**',
      '**BREAKING: `--prompt-cache` with `--provider openai` is accepted**',
      "**`realm workflow validate`, `register` and `watch` count the stable start of each step's prompt in its fixed part**",
    ])
      claimChangelog(lead);
    // MA2-3B-IA1-12: a request sent without the cache fields records no ask (#899's rule):
    // `gateway-rule-3b.test.ts` (the single-shot request, the tool step's turns).
    claimChangelog('on Anthropic such a request records no ask, since it asked for nothing');
  });
});
