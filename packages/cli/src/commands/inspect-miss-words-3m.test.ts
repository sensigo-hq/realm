// inspect-miss-words-3m.test.ts — caching 3-M A-2b2: the sentence a miss line ends in, one per
// cause and scope, and the words for the pause before a missed request. Each row is a `CostMiss` as
// core composes it for its real case (its `gap_s`, and the lifetime pair where the request it is
// compared with records one). On failure each row prints the `CostMiss` and the sentence; no row
// holds prompt text or a digest.
import { describe, expect, it } from 'vitest';
import type { CostMiss } from '@sensigo/realm';
import { gapWords, missSentence } from './inspect.js';

type Derived = CostMiss['derived'];
const REFERENCE = { from: 'reference' } as const;
const list = (at: number): Derived['predecessor'] => ({ from: 'list', at });
/** A miss whose counts the sentence does not read: only its cause, scope, gap and lifetime matter. */
const miss = (
  derived: Omit<Derived, 'expected_tokens' | 'shortfall_tokens' | 'rule'> & {
    rule?: Derived['rule'];
  },
): CostMiss => ({
  position: 1,
  derived: { rule: 'exact', expected_tokens: 7000, shortfall_tokens: 7000, ...derived },
});
const ANTHROPIC_5M = { lifetime_s: 300, lifetime_from: 'written' } as const;

describe('caching 3-M A-2b2 — the sentence for each cause and scope', () => {
  // Can fail: two map entries swapped; the scope ignored for tools, model_changed or
  // cache_settings; lifetime_from ignored; {prev} always `request <k>` (the reference rows); k taken
  // as `at`; the gap printed for every cause; the lifetime clause keyed on `lifetime_s` rather than
  // the cause. Prints the CostMiss and the sentence.
  it.each<[string, CostMiss, string]>([
    [
      // A-2a2r (a): drive 2 on OpenAI against an Anthropic reference through a gateway, 20 minutes on.
      'provider_changed, against the reference',
      miss({
        cause: 'provider_changed',
        rule: 'tolerance',
        predecessor: REFERENCE,
        gap_s: 1200,
        ...ANTHROPIC_5M,
      }),
      "the provider differs from an earlier drive's request (another --provider, the API key that chose the provider when none was given, or an o1 model, which has its own provider)",
    ],
    [
      // A-2a2r (b): OpenAI at its own address against its reference through --base-url.
      'endpoint_changed, against the reference',
      miss({ cause: 'endpoint_changed', rule: 'tolerance', predecessor: REFERENCE, gap_s: 600 }),
      "the address moved between the provider's own and another one since an earlier drive's request (--base-url, ANTHROPIC_BASE_URL or OPENAI_BASE_URL)",
    ],
    [
      // A-2a2r (c): inside one list, a gateway's fallback model answered the second turn.
      'model_changed, inside one list',
      miss({ cause: 'model_changed', rule: 'tolerance', predecessor: list(0), gap_s: 2 }),
      'a different model answered than for request 1 (the endpoint answered from another model)',
    ],
    [
      // A-2a2r (e): drive 2 ran with another --model, on Anthropic.
      'model_changed, against the reference',
      miss({ cause: 'model_changed', predecessor: REFERENCE, gap_s: 600, ...ANTHROPIC_5M }),
      "a different model answered than for an earlier drive's request (another --model, or the endpoint answered from another model)",
    ],
    [
      // A-2a2 correction 1 (b): inside one list, another writer's request with no parts.
      'parts_not_recorded',
      miss({ cause: 'parts_not_recorded', predecessor: list(0), gap_s: 1, ...ANTHROPIC_5M }),
      'the record holds no fingerprint of what one of the two requests sent, so the parts sent could not be compared',
    ],
    [
      // A-2a2s 1 (a): OpenAI's final request after a strict tool step's turns.
      'final_request, inside one list',
      miss({ cause: 'final_request', rule: 'tolerance', predecessor: list(1), gap_s: 2 }),
      "Realm's own final request of a tool step sends no tools, so its start differs from what request 2 cached",
    ],
    [
      // A-2a2s 2 (a): OpenAI's #313 ladder dropped strict between two turns.
      'strict_ladder, inside one list',
      miss({ cause: 'strict_ladder', rule: 'tolerance', predecessor: list(1), gap_s: 2 }),
      'Realm switched strict output on or off after request 2 (its own retries)',
    ],
    [
      // A-2a2s 2 (b): drive 2 through the same --base-url without drive 1's --strict-base-url.
      'strict_changed, against the reference',
      miss({ cause: 'strict_changed', rule: 'tolerance', predecessor: REFERENCE, gap_s: 3600 }),
      "strict output was sent on only one of this request and an earlier drive's request (--strict-base-url, a workflow edit, or Realm's own retries in either drive)",
    ],
    [
      // A-2a2 3 (a): the MCP server listed different tools before a repair opener.
      'tools, inside one list',
      miss({ cause: 'tools', predecessor: list(0), gap_s: 30, ...ANTHROPIC_5M }),
      'the tools differ from request 1 (the MCP server listed different tools)',
    ],
    [
      // A-2a2 3 (e): an Anthropic schema and profile edit between the drives.
      'tools, against the reference',
      miss({ cause: 'tools', predecessor: REFERENCE, gap_s: 1200, ...ANTHROPIC_5M }),
      "the tools differ from an earlier drive's request (the MCP server listed different tools, or the workflow changed: the step's tools, or on Anthropic its schema, which Realm sends as its answer tool)",
    ],
    [
      // A-2a2 3 (c): a profile edit between the drives.
      'system, against the reference',
      miss({ cause: 'system', predecessor: REFERENCE, gap_s: 1200, ...ANTHROPIC_5M }),
      "the system text differs from an earlier drive's request (the agent profile, the step's schema, or another Realm version)",
    ],
    [
      // A-2a2s 3 (a): an Anthropic repair opener's feedback under a marked conversation.
      'repair_feedback, inside one list',
      miss({ cause: 'repair_feedback', predecessor: list(0), gap_s: 20, ...ANTHROPIC_5M }),
      "Realm's own repair feedback, added after a rejected answer, changed the prompt request 1 cached",
    ],
    [
      // A-2a2 1 (b): a workflow edit of the text before the step's first placeholder.
      'prompt, against the reference',
      miss({ cause: 'prompt', predecessor: REFERENCE, gap_s: 1200, ...ANTHROPIC_5M }),
      "the prompt differs from an earlier drive's request (the step's input, the workflow file, or that drive's repair feedback)",
    ],
    [
      // A-2a2 3 (d): JSON mode moved with --base-url between the drives, on a gateway.
      'format, against the reference',
      miss({ cause: 'format', rule: 'tolerance', predecessor: REFERENCE, gap_s: 1800 }),
      "the answer format differs from an earlier drive's request (JSON mode moved with --base-url)",
    ],
    [
      // Inside one list: the endpoint refused OpenAI's cache key, and Realm stopped sending it.
      'cache_settings, inside one list',
      miss({ cause: 'cache_settings', rule: 'tolerance', predecessor: list(0), gap_s: 2 }),
      "Realm stopped sending OpenAI's cache key after the endpoint refused it",
    ],
    [
      // A-2a2 4: drive 2 ran under --prompt-cache off, so no key went out.
      'cache_settings, against the reference',
      miss({ cause: 'cache_settings', rule: 'tolerance', predecessor: REFERENCE, gap_s: 1200 }),
      "what was marked for caching differs from an earlier drive's request (--prompt-cache, Realm dropping OpenAI's cache key after an endpoint refused it, or an edit that moved where the prompt's fixed start ends)",
    ],
    [
      // A-2b1 1 (b) position 4: turn 4, 420 s after turn 3's 5-minute write.
      'possibly_expired, a written lifetime',
      miss({ cause: 'possibly_expired', predecessor: list(3), gap_s: 420, ...ANTHROPIC_5M }),
      'possibly expired: it started 7 minutes after request 4, longer than the 5 minutes the provider granted',
    ],
    [
      // A-2a3 1 (d): GPT-5.6 explicit, 45 minutes after a 30-minute ask.
      'possibly_expired, an asked lifetime',
      miss({
        cause: 'possibly_expired',
        rule: 'tolerance',
        predecessor: REFERENCE,
        gap_s: 2700,
        lifetime_s: 1800,
        lifetime_from: 'asked',
      }),
      "possibly expired: it started 45 minutes after an earlier drive's request, longer than the 30 minutes Realm asked for",
    ],
    [
      // Against a reference whose start is not before this one (two hosts' clocks): no gap.
      'unexplained, no gap',
      miss({ cause: 'unexplained', predecessor: REFERENCE }),
      "nothing the cache covers differs on the record from an earlier drive's request; the provider may have dropped the entry",
    ],
    [
      // A-2b1 1 (c): a GPT-5.6 tool step (provider_rules, no lifetime) a day after its reference.
      'unexplained, a gap and no lifetime',
      miss({ cause: 'unexplained', rule: 'tolerance', predecessor: REFERENCE, gap_s: 86400 }),
      "nothing the cache covers differs on the record from an earlier drive's request; the provider may have dropped the entry; it started about 24 hours after that request",
    ],
    [
      // A-2b1 1 (d) position 2: 1.386 s after a 5-minute write; the lifetime is not printed.
      'unexplained, a gap and a lifetime',
      miss({ cause: 'unexplained', predecessor: list(1), gap_s: 1.386, ...ANTHROPIC_5M }),
      'nothing the cache covers differs on the record from request 2; the provider may have dropped the entry; it started 2 seconds after that request',
    ],
  ])('%s', (_label, value, sentence) => {
    expect(missSentence(value), JSON.stringify(value)).toBe(sentence);
  });
});

describe("caching 3-M A-2b2 — the gap's words", () => {
  // Can fail: the seconds rounded down (the 1.386 and 420.25 rows), no carry of 60 seconds (the
  // 179.5 row reads "2 minutes 60 seconds"), no day unit (the 172800 row). 1.386 is live-899's
  // drive_a, positions 1 to 2. Prints the seconds and the words.
  it.each<[number, string]>([
    [1.386, '2 seconds'],
    [59, '59 seconds'],
    [60, '60 seconds'],
    [179.5, '3 minutes'],
    [301, '5 minutes 1 second'],
    [420.25, '7 minutes 1 second'],
    [3599, '59 minutes 59 seconds'],
    [3601, '60 minutes 1 second'],
    [7200, 'about 2 hours'],
    [86400, 'about 24 hours'],
    [172800, 'about 2 days'],
  ])('%s seconds read "%s"', (seconds, words) => {
    expect(gapWords(seconds), `seconds=${String(seconds)}`).toBe(words);
  });
});
