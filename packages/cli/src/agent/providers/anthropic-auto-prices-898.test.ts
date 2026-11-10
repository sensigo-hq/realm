// anthropic-auto-prices-898.test.ts — issue #898: the Anthropic provider ships its lifetimes, never a
// price (B.1). Caching 3-M D-3: its `auto` choice is never pending, so the settle, and the factory's
// answer that offered it, went with the cells that pinned them (S7, S8). Beside the cell: (a) the
// change that turns it red; (b) what it prints when it fails.
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_CACHE_TIERS } from './anthropic-provider.js';

describe('#898 B.1 — the provider ships its lifetimes, never a price', () => {
  // (a) red when a read or write multiple returns to the constant; (b) prints the constant.
  it('ANTHROPIC_CACHE_TIERS holds the two lifetimes and nothing else', () => {
    expect(ANTHROPIC_CACHE_TIERS).toEqual({
      short: { lifetime_s: 300 },
      long: { lifetime_s: 3600 },
    });
  });
});
