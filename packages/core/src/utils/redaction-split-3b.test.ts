// redaction-split-3b.test.ts — caching 3-B, Part A4 (C2, M5, D4.6-5; MA 1's conditions (c) and (d),
// as amended by MA1-3B-01 and MA 2's F2 ruling): `discloseSplit` cuts `disclose` in two from its one
// marking pass; `discloseSplitSize` gives the pieces' sizes and nothing of their text; `discloseLeaf`
// is the walk's leaf. Inputs: the A0 fixture's corpus (PR3R1-06's shapes on core's full pattern set
// and member forms, at four audience × tier cells) and the disclosure-law generator corpus. A failing
// cell prints cuts, lengths, booleans and names — never a text.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  compileDisclosure,
  disclose,
  discloseSplit,
  discloseSplitSize,
  tierFor,
  type DisclosedSplitSize,
  type DisclosureEntry,
  type DisclosureTier,
} from './redaction.js';
import { discloseLeaf, discloseValue } from './disclosure-walk.js';
import { NAMED_SHAPES, generateTexts } from '../test-support/disclosure-law/generator.js';

interface Case {
  name: string;
  audience: 'agent' | 'private';
  tier: DisclosureTier;
  text: string;
  expected: { text: string };
}
const fixture = JSON.parse(
  readFileSync(new URL('./__fixtures__/disclose-differential.json', import.meta.url), 'utf8'),
) as { entries: DisclosureEntry[]; cases: Case[] };
const setFor = (audience: 'agent' | 'private') =>
  compileDisclosure(fixture.entries, { declared: 'resolved', audience, environment: 'swept' }).set;

/** Every hidden value the corpus plants (members and pattern hits), for the no-proper-prefix check. */
const HIDDEN = [
  ...fixture.entries.map((e) => e.value),
  'FAKE.TOKEN-1A2B3C',
  'RkFLRTpGQUtF==',
  'FAKE-Q-1',
  'FAKE-URL-PW',
  'FAKE-PW-1',
  'FAKE-K-2',
  'FAKE\\"S-3',
  'MIIEFAKEbody0729',
  'FAKE-D-1',
  'FAKE.TOKEN-ABCDEF12',
  'FAKE.TOKEN-AAAA1111',
  'FAKE.TOKEN-BBBB2222',
  'FAKE-Ü-9',
  'FAKE-E-1',
  'FAKE-T-77',
  'FAKE-UP',
];

describe('caching 3-B A4 — the split law, at every cut', () => {
  it('head + tail is disclose’s text, the counts add up, and the head holds no proper prefix of a hidden value', () => {
    const broken: {
      index: number;
      name: string;
      cut: number;
      joined: boolean;
      counts: boolean;
      prefix: boolean;
      sizes: boolean;
    }[] = [];
    let cuts = 0;
    let moved = 0;
    fixture.cases.forEach((c, index) => {
      const set = setFor(c.audience);
      const whole = disclose(c.text, set, c.tier);
      const hiddenHere = HIDDEN.filter((h) => c.text.includes(h) && !whole.text.includes(h));
      for (let cut = 0; cut <= c.text.length; cut++) {
        cuts++;
        const s = discloseSplit(c.text, cut, set, c.tier);
        if (s.cutSent !== cut) moved++;
        const joined = s.head + s.tail === whole.text;
        const counts =
          s.hiddenHead.declared + s.hiddenTail.declared === whole.hidden.declared &&
          s.hiddenHead.environment + s.hiddenTail.environment === whole.hidden.environment &&
          s.hiddenHead.pattern + s.hiddenTail.pattern === whole.hidden.pattern;
        // No hidden value is cut: no occurrence of one has the cut strictly inside it (where it
        // occurs, the text is hidden, so the head would end with its proper prefix).
        const prefix = hiddenHere.some((h) => {
          for (let p = c.text.indexOf(h); p !== -1; p = c.text.indexOf(h, p + 1)) {
            if (p < s.cutSent && s.cutSent < p + h.length) return true;
          }
          return false;
        });
        const size = discloseSplitSize(c.text, cut, set, c.tier);
        let ascii = 0;
        for (const ch of s.head) if (ch.charCodeAt(0) < 0x80) ascii += ch.length;
        const sizes =
          size.headChars === s.head.length &&
          size.tailChars === s.tail.length &&
          size.headAsciiChars === ascii;
        if (!joined || !counts || prefix || !sizes) {
          broken.push({ index, name: c.name, cut, joined, counts, prefix, sizes });
        }
      }
    });
    // (a) red when the cut is not moved back across a marked run (a run then emits twice and the
    //     counts gain one), or the size helper measures something else; (b) prints each broken
    //     input's index, name and cut with four booleans.
    expect(broken.slice(0, 10)).toEqual([]);
    // The corpus does reach the move: some cuts fell inside a hidden run.
    expect({ cuts: cuts > 1000, moved: moved > 0 }).toEqual({ cuts: true, moved: true });
  });

  it('the cut is clamped, and a cut that lands on a run boundary is kept', () => {
    const set = setFor('agent');
    const text = 'abc password=FAKE-PW-1 xyz';
    const start = text.indexOf('FAKE');
    // (a) red when a boundary cut moves, a negative cut is not clamped, or a cut past the end is;
    //     (b) prints the cuts sent.
    expect({
      negative: discloseSplit(text, -5, set, 'all').cutSent,
      past: discloseSplit(text, 999, set, 'all').cutSent,
      atRunStart: discloseSplit(text, start, set, 'all').cutSent,
      insideRun: discloseSplit(text, start + 3, set, 'all').cutSent,
      atRunEnd: discloseSplit(text, start + 'FAKE-PW-1'.length, set, 'all').cutSent,
    }).toEqual({
      negative: 0,
      past: text.length,
      atRunStart: start,
      insideRun: start,
      atRunEnd: start + 'FAKE-PW-1'.length,
    });
  });
});

describe('caching 3-B A4 — who may call discloseSplit, and what the size helper returns (source cells)', () => {
  const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory())
        return name === 'node_modules' || name === 'dist' ? [] : sources(path);
      return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')
        ? [path]
        : [];
    });
  const productionFiles = ['core', 'cli', 'mcp-server', 'testing'].flatMap((p) =>
    sources(join(PACKAGES, p, 'src')),
  );

  it('(i) the callers of discloseSplit are exactly the named ones', () => {
    const callers: string[] = [];
    for (const file of productionFiles) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bdiscloseSplit\(/g)) {
        // The function the call sits in: the nearest `function <name>(` before it.
        const before = text.slice(0, m.index);
        if (/export function $/.test(before.slice(-16)) || /function $/.test(before.slice(-9)))
          continue;
        const fn = [...before.matchAll(/function (\w+)\(/g)].at(-1)?.[1] ?? '(top level)';
        callers.push(`${relative(PACKAGES, file)}: ${fn}`);
      }
    }
    // (a) red when a caller is added (a print path, the writer) or one is removed; (b) prints the
    //     callers found.
    expect(callers.sort()).toEqual([
      'cli/src/agent/providers/agent-utils.ts: discloseForAgentSplit',
      'core/src/utils/redaction.ts: discloseSplitSize',
      'mcp-server/src/render-reply.ts: stablePrefixOf',
    ]);
  });

  it("(ii) the describer's files size the head with discloseSplitSize, and never hold its text", () => {
    const describer = ['cli/src/agent/providers/request-layout.ts', 'cli/src/lib/cacheability.ts'];
    // The text-returning helpers (MA1-3B-01; MA 2, 2026-11-04): `discloseSplit`, and the CLI's
    // `discloseForAgentSplit` and `discloseForAgent`.
    const refused = /\b(discloseSplit|discloseForAgentSplit|discloseForAgent)\b(?!Size)/;
    // (a) red when the describer imports or calls a text-returning helper (it may hold only
    //     sizes), or stops sizing the head with discloseSplitSize; (b) prints each file's verdict.
    expect({
      refused: describer.map((f) => [f, refused.test(readFileSync(join(PACKAGES, f), 'utf8'))]),
      sizes: /\bdiscloseSplitSize\(/.test(
        readFileSync(join(PACKAGES, 'cli/src/lib/cacheability.ts'), 'utf8'),
      ),
    }).toEqual({ refused: describer.map((f) => [f, false]), sizes: true });
  });

  it("(iii) discloseSplitSize's return type, DisclosedSplitSize, holds numbers only", () => {
    type StringKeys<T> = { [K in keyof T]-?: T[K] extends number ? never : K }[keyof T];
    // (a) a key that is not a number turns this line into a type error under `npm run
    //     typecheck:tests`; (b) tsc prints the key.
    const onlyNumbers: [StringKeys<DisclosedSplitSize>] extends [never] ? true : false = true;
    const set = setFor('agent');
    // (a) red when a field is added to or removed from the value; (b) prints the keys and types.
    expect({
      onlyNumbers,
      fields: Object.entries(discloseSplitSize('a Bearer FAKE.TOKEN-1A2B3C b', 4, set, 'all'))
        .map(([k, v]) => `${k}:${typeof v}`)
        .sort(),
    }).toEqual({
      onlyNumbers: true,
      fields: ['headAsciiChars:number', 'headChars:number', 'tailChars:number'],
    });
  });
});

describe('caching 3-B A4 (F-B1) — discloseLeaf IS the walk’s leaf', () => {
  it('equals the walk’s value leaf over the disclosure-law corpus, on the agent and private audiences', () => {
    const texts = [...NAMED_SHAPES, ...generateTexts(20261104, 1500)];
    const differ: { index: number; shape: string; audience: string; lengths: [number, number] }[] =
      [];
    texts.forEach((t, index) => {
      for (const audience of ['agent', 'private'] as const) {
        const set = compileDisclosure(t.entries, {
          declared: 'resolved',
          audience,
          environment: 'swept',
        }).set;
        const leaf = discloseLeaf(t.text, set, tierFor(audience));
        const walked = discloseValue(t.text, set, audience).value as string;
        if (leaf !== walked) {
          differ.push({
            index,
            shape: t.shape ?? 'generated',
            audience,
            lengths: [leaf.length, walked.length],
          });
        }
      }
    });
    // (a) red when discloseLeaf transforms a leaf another way than the walk does (another tier than
    //     the audience's, say), or the walk's leaf changes; no input here reaches the escaped-spelling
    //     check, so the D2-6 cell below pins that one; (b) prints the differing inputs' index, shape
    //     name, audience and the two lengths.
    expect(differ.slice(0, 10)).toEqual([]);
  });

  it('on #901’s D2-6 input (four backslashes, decoded three times) the leaf hides what disclose shows', () => {
    const BS = '\\';
    const four = `pa${BS}${BS}${BS}${BS}nss-word1`;
    const thrice = JSON.parse(
      `"${JSON.parse(`"${JSON.parse(`"${four}"`) as string}"`) as string}"`,
    ) as string;
    const set = compileDisclosure([{ value: four, source: 'declared:FAKE_SECRET' }], {
      declared: 'resolved',
      audience: 'agent',
      environment: 'swept',
    }).set;
    const text = `before ${thrice} after`;
    const leaf = discloseLeaf(text, set, 'all');
    // (a) red when discloseLeaf drops the escaped-spelling check; (b) prints the lengths and whether
    //     each equals the walk's leaf.
    expect({
      leafLength: leaf.length,
      discloseLength: disclose(text, set, 'all').text.length,
      equalsWalk: leaf === discloseValue(text, set, 'agent').value,
    }).toEqual({ leafLength: 10, discloseLength: 24, equalsWalk: true });
  });
});
