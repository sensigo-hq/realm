// Caching 3-B, Part A0 (MA 1's condition (a)): `disclose`'s marking pass moved into the module-private
// `markText`, and `disclose` became its emit loop. The refactor's only evidence is this differential:
// `__fixtures__/disclose-differential.json` holds `disclose`'s results captured from the code BEFORE
// A0 (main 941bc877, `plans/llm-prompt-caching/pr3/build-ia1/probes/capture-a0-fixture.mjs`), over
// PR3R1-06's shapes on core's full pattern set (Bearer/Basic, `token=`, a URL's user part, a
// credential name's value, PEM, `Authorization`) and member forms, each at four audience × tier
// cells. Every result must stay byte-identical: text, `hidden`, `members` and `unchecked`.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { compileDisclosure, disclose } from './redaction.js';
import type { DisclosureEntry, DisclosureTier } from './redaction.js';

interface Case {
  name: string;
  audience: 'agent' | 'private';
  tier: DisclosureTier;
  text: string;
  expected: {
    text: string;
    hidden: { declared: number; environment: number; pattern: number };
    unchecked: number;
    members?: string[];
  };
}

const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/disclose-differential.json', import.meta.url), 'utf8'),
) as { entries: DisclosureEntry[]; cases: Case[] };

describe('caching 3-B A0 — disclose after the markText split equals disclose before it', () => {
  it('every captured input gives the same text, hidden, members and unchecked', () => {
    const differ: {
      index: number;
      name: string;
      cell: string;
      field: string;
      lengths: [number, number];
    }[] = [];
    fixture.cases.forEach((c, index) => {
      const { set } = compileDisclosure(fixture.entries, {
        declared: 'resolved',
        audience: c.audience,
        environment: 'swept',
      });
      const got = disclose(c.text, set, c.tier);
      const cell = `${c.audience}/${c.tier}`;
      const note = (field: string, a: number, b: number) =>
        differ.push({ index, name: c.name, cell, field, lengths: [a, b] });
      if (got.text !== c.expected.text) note('text', c.expected.text.length, got.text.length);
      if (JSON.stringify(got.hidden) !== JSON.stringify(c.expected.hidden))
        note(
          'hidden',
          Object.values(c.expected.hidden).reduce((s, v) => s + v, 0),
          Object.values(got.hidden).reduce((s, v) => s + v, 0),
        );
      if (JSON.stringify(got.members) !== JSON.stringify(c.expected.members))
        note('members', c.expected.members?.length ?? -1, got.members?.length ?? -1);
      if (got.unchecked !== c.expected.unchecked)
        note('unchecked', c.expected.unchecked, got.unchecked);
    });
    // (a) red when `markText` marks differently from the pass it replaced (a dropped pattern, a
    //     member loop that skips a form) or the emit loop changes; (b) prints each differing input's
    //     index, name, cell and field with the two lengths (or counts), never a text.
    expect(differ).toEqual([]);
    // The fixture is not empty, and it exercises hiding and the private surface's member names.
    expect({
      cases: fixture.cases.length,
      hidesSomething: fixture.cases.some((c) => c.expected.text !== c.text),
      namesMembers: fixture.cases.some((c) => (c.expected.members?.length ?? 0) > 0),
    }).toEqual({ cases: 104, hidesSomething: true, namesMembers: true });
  });
});
