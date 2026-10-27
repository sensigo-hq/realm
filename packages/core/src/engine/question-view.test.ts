// question-view.test.ts — #729 PR-4 (01; 04 "The composer", "The budget", "The digest"): the ONE
// question composer, as pure functions — the read (`composeQuestionView` over a gate PR-3's law has
// disclosed), the mint's cuts (`mintSubstitutions` through renderTemplate's hook, `mintQuestionView`),
// the round trip, and the digest. The mint through the engine is `execution-loop.test.ts`'s
// "#729 PR-4" block. Every value is a fake (`CANARY-…`). Each assertion names (a) the change that
// turns it red and (b) what it prints when it fails: texts, lengths, counts and booleans.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  composeQuestionView,
  mintQuestionView,
  mintSubstitutions,
  renderDisplay,
  stripSpanMarks,
  viewDigest,
  CUT_SENTENCE,
  endsWithCutSentence,
  VIEW_BUDGET,
  type QuestionView,
} from './question-view.js';
import { renderTemplate } from './render-template.js';
import { canonicalJson } from '../store/params-hash.js';
import { buildDisclosureSet, type DisclosureAudience } from '../utils/redaction.js';
import { discloseGate } from '../utils/disclosure-tables.js';
import type { PendingGate } from '../types/run-record.js';

const FAKE = 'CANARY-declared-4f2a-0123456789abcdef'; // 37 characters, declared
const ENV_FAKE = 'CANARY-env-9c1e-planted-value'; // an environment member
const setFor = (
  audience: DisclosureAudience,
  declaredState: 'resolved' | 'partial' = 'resolved',
  extra: { declaredCause?: 'manifest_changed' } = {},
) =>
  buildDisclosureSet({
    env: { REALM_TEST_TOKEN: ENV_FAKE },
    declared: { SECRET_X: FAKE },
    declaredState,
    ...extra,
    audience,
  }).set;
const gate = (over: Partial<PendingGate> = {}): PendingGate => ({
  gate_id: 'g-1',
  step_name: 'review',
  preview: { summary: 'short' },
  choices: ['approve', 'reject'],
  opened_at: '2026-10-26T10:00:00.000Z',
  ...over,
});
const read = (g: PendingGate, display?: string, audience: DisclosureAudience = 'private') =>
  composeQuestionView(discloseGate(stripSpanMarks(g), setFor(audience), audience), display);
/** The mint as the engine runs it: the message rendered through the hook, then minted. */
function mint(
  template: string | undefined,
  params: Record<string, unknown>,
  preview: Record<string, unknown>,
  opts: { set?: ReturnType<typeof setFor> | undefined; display?: string } = {},
) {
  const set = 'set' in opts ? opts.set : setFor('private');
  const substitutions = template !== undefined ? mintSubstitutions(template, set) : undefined;
  const render = (onSubstitution?: (rendered: string, path: string) => string) =>
    renderTemplate(
      template!,
      { evidenceByStep: {}, runParams: params },
      { strict: true, ...(onSubstitution !== undefined ? { onSubstitution } : {}) },
    );
  const message = template !== undefined ? render(substitutions?.onSubstitution) : undefined;
  return mintQuestionView({
    message,
    ...(substitutions !== undefined ? { substitutions, rerender: render } : {}),
    preview,
    choices: ['approve', 'reject'],
    ...(opts.display !== undefined ? { display: opts.display } : {}),
    set,
    ids: { run_id: 'r-1', gate_id: 'g-1', step: 'review' },
  });
}
/** A view's rendered units: the question, the blank line when both parts show, the preview. */
const viewLength = (v: QuestionView) =>
  v.question_text.length +
  (v.question_text !== '' && v.preview_text !== '' ? 2 : 0) +
  v.preview_text.length;

describe('#729 PR-4 — the composer (read)', () => {
  it('display is honoured with a message present: the question is the message, the preview the display rendering', () => {
    const v = read(gate({ resolved_message: 'Ship it?' }), 'Summary: {{ summary }}');
    // (a) red when `display` is ignored whenever a message exists (the chain's JSON shows); (b)
    //     prints the two texts.
    expect([v.question_text, v.preview_text]).toEqual(['Ship it?', 'Summary: short']);
  });

  it('(f): a gate with no message has no question; its body is the output', () => {
    const v = read(gate({ preview: { headline: 'H' } }));
    // (a) red when a question is invented for a message-less gate; (b) prints the two texts.
    expect([v.question_text, v.preview_text]).toEqual(['', 'H']);
  });

  it('the chain: headline and message joined; {} is (no output); anything else its JSON', () => {
    const texts = [
      read(gate({ preview: { headline: 'H', message: 'M' } })).preview_text,
      read(gate({ preview: {} })).preview_text,
      read(gate({ preview: { a: 1 } })).preview_text,
    ];
    // (a) red when an arm of the chain changes (the join, the empty word, the JSON's indentation);
    //     (b) prints the three texts.
    expect(texts).toEqual(['H\n\nM', '(no output)', '{\n  "a": 1\n}']);
    expect(read(gate({ preview: { a: 1 } })).preview_format).toBe('json');
  });

  it('renderDisplay: a dot path resolves; a missing path is empty; a value that is not a string is its JSON', () => {
    const vars = { a: { b: 'deep' }, n: 3, o: { k: 1 } };
    // (a) red when a rule changes (a missing path printed `undefined`, a number stringified some
    //     other way); (b) prints the three renderings.
    expect([
      renderDisplay('[{{ a.b }}]', vars),
      renderDisplay('[{{ a.zz }}]', vars),
      renderDisplay('[{{ n }}|{{ o }}]', vars),
    ]).toEqual(['[deep]', '[]', '[3|{"k":1}]']);
  });

  it('an old gate (control): a stored question past the budget with no sentence is shown as stored; `cut` from the preview fit only', () => {
    const long = 'Q'.repeat(VIEW_BUDGET + 50);
    const preview = { summary: 'x'.repeat(40) };
    const v = read(gate({ resolved_message: long, preview }));
    const previewLength = JSON.stringify(preview, null, 2).length;
    // (a) red when the read cuts or appends the stored question; (b) prints booleans and the cut.
    expect({
      same: v.question_text === long,
      sentence: endsWithCutSentence(v.question_text),
      preview: v.preview_text,
      cut: v.cut,
    }).toEqual({
      same: true,
      sentence: false,
      preview: '',
      cut: { shown: long.length, total: long.length + previewLength },
    });
  });

  it('type: a raw gate does not compile into composeQuestionView — only a ShownGate', () => {
    // @ts-expect-error — a PendingGate is not a ShownGate: only discloseGate mints one.
    const compose = () => composeQuestionView(gate());
    expect(typeof compose).toBe('function');
  });
});

describe('#729 PR-4 — the budget (the mint)', () => {
  it('(b) per substitution: two 5,000-character values each cut to its share with its marker, the fixed text whole; the sentence appended although the view then fits', () => {
    const m = mint(
      'First: {{ run.params.a }} / second: {{ run.params.b }} — end.',
      { a: 'a'.repeat(5000), b: 'b'.repeat(5000) },
      { summary: 'short' },
    );
    const q = m.resolved_message!;
    // (a) red when the cut takes the fixed text, a value is cut without its marker, `cut` is absent
    //     on a (b)-only cut, or the sentence is missing; (b) prints booleans, the markers, the cut.
    expect({
      fixed: q.startsWith('First: ') && q.includes(' / second: ') && q.includes(' — end.'),
      markers: [...q.matchAll(/…\[cut at mint: (\d+) of 5000 characters\]/g)].length,
      sentence: endsWithCutSentence(q),
      cut: m.view.cut !== undefined,
      within: viewLength(m.view) <= VIEW_BUDGET,
      stored: m.view.question_text === q,
    }).toEqual({ fixed: true, markers: 2, sentence: true, cut: true, within: true, stored: true });
  });

  it('(b) counts a filtered placeholder: `{{ x | truncate: 5 }}` is a substitution, so the fixed text is 0 and `y` takes the room less `x`’s rendering', () => {
    const template = '{{ run.params.x | truncate: 5 }}{{ run.params.y }}';
    const preview = { summary: 's' };
    const m = mint(template, { x: 'xxxxxxxx', y: 'y'.repeat(5000) }, preview);
    const shown = Number(
      /…\[cut at mint: (\d+) of 5000 characters\]/.exec(m.resolved_message!)![1],
    );
    const x = 'xxxxx…'.length; // truncate keeps 5 and appends its ellipsis
    const total = x + 5000 + JSON.stringify(preview, null, 2).length;
    const room = VIEW_BUDGET - (2 + CUT_SENTENCE(total, total).length);
    const expected = room - x - '…[cut at mint: 5000 of 5000 characters]'.length;
    // (a) red when the fixed text is counted with a regex that misses the filtered placeholder (its
    //     32 characters counted as fixed: y's cap 32 smaller); (b) prints the two counts.
    expect({ shown, expected }).toEqual({ shown: expected, expected });
  });

  it('(b) leaves refusal intact: an unresolved placeholder never passes the hook', () => {
    const seen: string[] = [];
    const out = renderTemplate(
      'x'.repeat(500) + '{{ $settlement.s.f }}'.repeat(50),
      { evidenceByStep: {}, runParams: {} },
      {
        strict: true,
        onSubstitution: (v) => {
          seen.push(v);
          return v.slice(0, 3);
        },
      },
    );
    // (a) red when the hook is applied to an unresolved return (the placeholder cut, the gate's
    //     refusal scan blinded); (b) prints the hook's calls and whether the placeholders stayed.
    expect({ calls: seen.length, kept: out.split('{{ $settlement.s.f }}').length - 1 }).toEqual({
      calls: 0,
      kept: 50,
    });
  });

  it('(a) the preview first: a short question and a 50k preview — the preview fitted with its marker, the question whole with the sentence', () => {
    const m = mint('Approve the change?', {}, { blob: 'z'.repeat(50_000) });
    // (a) red when the preview is left uncut (the view past the budget) or the question is cut; (b)
    //     prints booleans, the cut and the view's length.
    expect({
      question: m.view.question_text.startsWith(
        'Approve the change?\n\n[Cut when this question opened',
      ),
      marker: /…\[cut: \d+ of \d+ characters\]$/.test(m.view.preview_text),
      within: viewLength(m.view) <= VIEW_BUDGET,
      cut: m.view.cut !== undefined && m.view.cut.total > 50_000,
      stored: m.resolved_message === m.view.question_text,
    }).toEqual({ question: true, marker: true, within: true, cut: true, stored: true });
  });

  it("the budget counts the disclosed text: a 37-character declared value counts as `[REDACTED]`'s 10", () => {
    // The question shows as `Approve [REDACTED]?` (19), so a 579-character preview fits exactly
    // (19 + 2 + 579 = 600); counted at the value's raw length (46), it would not.
    const fits = VIEW_BUDGET - ('Approve [REDACTED]?'.length + 2);
    const m = mint(
      'Approve {{ run.params.token }}?',
      { token: FAKE },
      { summary: 's'.repeat(fits) },
      { display: '{{ summary }}' },
    );
    // (a) red when the raw length is counted (the preview cut by 27 characters, the sentence
    //     appended); (b) prints the question, the preview's length and the cut.
    expect({
      question: m.view.question_text,
      preview: m.view.preview_text.length,
      cut: m.view.cut,
    }).toEqual({ question: 'Approve [REDACTED]?', preview: fits, cut: undefined });
    // On `broadcast`, a shaped leaf counts at its shape's length.
    const shaped = read(gate({ preview: { note: 'n'.repeat(26) } }), '{{ note }}', 'broadcast');
    expect(shaped.preview_text).toBe('‹string, 26 characters›');
  });

  it('(a) the question overflows alone: cut with the sentence, the preview empty; the sentence names no command', () => {
    const m = mint('W'.repeat(VIEW_BUDGET + 200), {}, { summary: 'x' });
    // (a) red when the question is not cut, the preview is still shown, or the sentence names a
    //     command; (b) prints booleans and the view's length.
    expect({
      sentence: endsWithCutSentence(m.view.question_text),
      preview: m.view.preview_text,
      within: viewLength(m.view) <= VIEW_BUDGET,
      command: /realm |inspect/.test(m.view.question_text),
    }).toEqual({ sentence: true, preview: '', within: true, command: false });
  });

  it('(a) a no-message gate is cut on its body: the marker and the sentence on the body, no question; the read reproduces it', () => {
    const m = mint(undefined, {}, { blob: 'b'.repeat(50_000) });
    const again = read(gate({ preview: { blob: 'b'.repeat(50_000) } }));
    // (a) red when the sentence is placed in `question_text` or the body is left uncut; (b) prints
    //     booleans.
    expect({
      question: m.view.question_text,
      marker: m.view.preview_text.includes('…[cut: '),
      sentence: endsWithCutSentence(m.view.preview_text),
      within: viewLength(m.view) <= VIEW_BUDGET,
      same: JSON.stringify(again) === JSON.stringify(m.view),
    }).toEqual({ question: '', marker: true, sentence: true, within: true, same: true });
  });

  it('fits: a view under the budget is not cut', () => {
    const m = mint('Ship {{ run.params.v }}?', { v: '1.2.3' }, { summary: 'ok' });
    // (a) red when the sentence is appended to a view that fits; (b) prints the question and cut.
    expect({ question: m.resolved_message, cut: m.view.cut }).toEqual({
      question: 'Ship 1.2.3?',
      cut: undefined,
    });
  });

  describe('(b) fires only on overflow, water-filled (rev 8)', () => {
    // 200 fixed characters around two substitutions; the preview `{}` reads `(no output)`.
    const template =
      'F'.repeat(100) + '{{ run.params.a }}' + 'G'.repeat(100) + '{{ run.params.b }}';
    const marker = (total: number) => `…[cut at mint: ${total} of ${total} characters]`;
    const capFor = (lengths: number[]) => {
      const total = 200 + lengths[0]! + lengths[1]! + '(no output)'.length;
      return VIEW_BUDGET - (2 + CUT_SENTENCE(total, total).length) - 200;
    };

    it('300 + 40 + 200 fixed = 540 fits: nothing cut, no marker, no sentence (a flat share of 200 would cut the 300)', () => {
      const m = mint(template, { a: 'a'.repeat(300), b: 'b'.repeat(40) }, {});
      // (a) red when (b) cuts a message that fits (the flat share restored); (b) prints booleans
      //     and the cut.
      expect({
        whole:
          m.resolved_message ===
          'F'.repeat(100) + 'a'.repeat(300) + 'G'.repeat(100) + 'b'.repeat(40),
        cut: m.view.cut,
      }).toEqual({ whole: true, cut: undefined });
    });

    it('500 + 40 + 200 fixed = 740 overflows: the 40 kept whole, the 500 cut to the water-filled cap; the sentence appended whole, nothing chopped', () => {
      const m = mint(template, { a: 'a'.repeat(500), b: 'b'.repeat(40) }, {});
      const q = m.resolved_message!;
      // The cap: (600 − the reserved sentence − 200 fixed) − 40. The reservation is the blank line
      // and the sentence at this view's total (751): 2 + 184 = 186, so the cap is 174.
      const cap = capFor([500, 40]) - 40;
      const shown = cap - marker(500).length;
      const head =
        'F'.repeat(100) +
        'a'.repeat(shown) +
        `…[cut at mint: ${shown} of 500 characters]` +
        'G'.repeat(100) +
        'b'.repeat(40) +
        '\n\n';
      // (a) red when the flat share is restored, the long value is cut to the even share, or the
      //     sentence's reservation is dropped from (b)'s room ((a) then chops the tail, the marker
      //     with it); (b) prints booleans, the cap and the sentence's length.
      expect({
        head: q.startsWith(head),
        sentence: q.slice(head.length).startsWith('[Cut when') && endsWithCutSentence(q),
        sentenceLength: CUT_SENTENCE(751, 751).length,
        cap,
      }).toEqual({ head: true, sentence: true, sentenceLength: 184, cap: 174 });
    });

    it('two values of 500: each cut to the even share (the flat case)', () => {
      const m = mint(template, { a: 'a'.repeat(500), b: 'b'.repeat(500) }, {});
      const even = Math.floor(capFor([500, 500]) / 2);
      const shown = [
        ...m.resolved_message!.matchAll(/…\[cut at mint: (\d+) of 500 characters\]/g),
      ].map((x) => Number(x[1]));
      // (a) red when the shares are not even for two equal values; (b) prints the shown counts.
      expect(shown).toEqual([even - marker(500).length, even - marker(500).length]);
    });
  });

  describe('no fragment survives a cut: the uncut assembly is checked first (rev 8, item 18)', () => {
    const pad = '.'.repeat(400);
    const fragmentFree = (q: string) =>
      [FAKE.slice(0, 8), FAKE.slice(-8), FAKE.slice(10, 18), FAKE.slice(18, 26)].every(
        (part) => !q.includes(part),
      );

    it('(i) a member split between a value’s TAIL and the fixed text: (b) skipped, `[REDACTED]` at 400, no fragment, no mint marker', () => {
      const m = mint(
        `{{ run.params.x }}${FAKE.slice(-8)}{{ run.params.y }}`,
        { x: pad + FAKE.slice(0, -8), y: pad },
        {},
      );
      const q = m.resolved_message!;
      // (a) red when the M1 === R1 comparison is skipped (always (b): x's tail is cut away and the
      //     fixed 8 stand in clear); (b) prints booleans and the position.
      expect({
        at: q.indexOf('[REDACTED]'),
        fragmentFree: fragmentFree(q),
        mintMarker: q.includes('…[cut at mint:'),
        sentence: endsWithCutSentence(q),
      }).toEqual({ at: 400, fragmentFree: true, mintMarker: false, sentence: true });
    });

    it('(ii) a member split across two adjacent substitutions: the same', () => {
      const m = mint(
        '{{ run.params.a }}{{ run.params.b }}',
        { a: pad + FAKE.slice(0, 18), b: FAKE.slice(18) + pad },
        {},
      );
      const q = m.resolved_message!;
      // (a) red when the comparison is skipped (b's leading characters of the fake stand in clear);
      //     (b) prints booleans and the position.
      expect({
        at: q.indexOf('[REDACTED]'),
        fragmentFree: fragmentFree(q),
        mintMarker: q.includes('…[cut at mint:'),
        sentence: endsWithCutSentence(q),
      }).toEqual({ at: 400, fragmentFree: true, mintMarker: false, sentence: true });
    });

    it('(iii) control: no member anywhere and two long substitutions — (b) cuts as before, with its markers', () => {
      const m = mint('{{ run.params.a }} and {{ run.params.b }}', { a: pad, b: pad }, {});
      // (a) red when the comparison is inverted (always (a): no mint markers); (b) prints the count.
      expect(
        [...m.resolved_message!.matchAll(/…\[cut at mint: \d+ of 400 characters\]/g)].length,
      ).toBe(2);
    });
  });
});

describe("#729 PR-4 — the mint under PR-3's law (Q7)", () => {
  it('masked before cut: a declared value in a substitution past its share is stored as `[REDACTED]`, never its prefix', () => {
    const m = mint(
      'Approve {{ run.params.token }} for release {{ run.params.pad }}',
      // The value straddles its cap's cut point (about 156 characters shown): masked first it shows
      // whole as `[REDACTED]` at 140; cut first, its first characters would stand in clear.
      { token: `${'y'.repeat(140)}${FAKE}${'y'.repeat(3000)}`, pad: 'p'.repeat(3000) },
      { summary: 's' },
    );
    // (a) red when the hook cuts before it masks (a prefix of the value stored); (b) prints
    //     booleans, never the value.
    expect({
      redacted: m.resolved_message!.includes('[REDACTED]'),
      prefix: m.resolved_message!.includes(FAKE.slice(0, 8)),
    }).toEqual({ redacted: true, prefix: false });
  });

  it('a planted mark cannot split the match (B1): a LONE U+E000, U+E001 or U+E002 inside the value — `[REDACTED]`, never a prefix', () => {
    const split = (mark: string) => FAKE.slice(0, 12) + mark + FAKE.slice(12);
    const stored = ['\uE000', '\uE001', '\uE002'].map(
      (mark) => mint('Key {{ run.params.k }}', { k: split(mark) }, { s: 1 }).resolved_message,
    );
    // (a) red when the strip is skipped, or taken from an envelope-aware strip that leaves a lone
    //     U+E000 or U+E001 (the value stays split and unmasked); (b) prints the stored questions —
    //     each `Key [REDACTED]` when it holds, else the split fake (a fake, never a secret).
    expect(stored).toEqual(['Key [REDACTED]', 'Key [REDACTED]', 'Key [REDACTED]']);
    // The control: the core strip removes the three marks singly and nothing else.
    expect(stripSpanMarks('a\uE000b\uE001c\uE002d')).toBe('abcd');
    expect(stripSpanMarks({ ['k\uE000']: ['v\uE002'] })).toEqual({ k: ['v'] });
  });

  it('no cut without a complete set (S2): a partial set, and a withheld one, store the question whole', () => {
    const long = 'L'.repeat(VIEW_BUDGET + 100);
    const partial = mint(long, {}, { s: 1 }, { set: setFor('private', 'partial') });
    const withheld = mint(
      long,
      {},
      { s: 1 },
      {
        set: setFor('private', 'resolved', { declaredCause: 'manifest_changed' }),
      },
    );
    const none = mint(long, {}, { s: 1 }, { set: undefined });
    // (a) red when the cut is applied under a partial or withheld set (a prefix a complete manifest
    //     could later match stored); (b) prints booleans.
    expect({
      partial: partial.resolved_message === long,
      withheld: withheld.resolved_message === long,
      none: none.resolved_message === long,
      sentence: endsWithCutSentence(partial.resolved_message!),
    }).toEqual({ partial: true, withheld: true, none: true, sentence: false });
  });

  it('the fixed text is masked too, and a member that straddles fixed text and a substitution (m6)', () => {
    const fixed = mint(`Token ${FAKE} here`, {}, { s: 1 });
    const straddle = mint(
      `Token ${FAKE.slice(0, 10)}{{ run.params.rest }}!`,
      { rest: FAKE.slice(10) },
      {
        s: 1,
      },
    );
    // (a) red when only substitutions are masked (the fixed fake stored), or the one pass over the
    //     assembled text is skipped (the straddling fake stored); (b) prints the two questions.
    expect([fixed.resolved_message, straddle.resolved_message]).toEqual([
      'Token [REDACTED] here',
      'Token [REDACTED]!',
    ]);
  });

  it('the round trip on `private`: mint → store → read gives the identical view and digest, for a view that fits and one cut', () => {
    for (const preview of [{ s: 'fits' }, { blob: 'q'.repeat(40_000) }]) {
      const m = mint('Approve {{ run.params.v }}?', { v: 'v1' }, preview);
      const stored = gate({ resolved_message: m.resolved_message!, preview });
      const again = composeQuestionView(
        discloseGate(stripSpanMarks(stored), setFor('private'), 'private'),
      );
      // (a) red when the read applies (a) to the stored question (a second sentence) or fits the
      //     preview differently from the mint; (b) prints booleans.
      expect({
        view: JSON.stringify(again) === JSON.stringify(m.view),
        digest: viewDigest({ run_id: 'r-1', gate_id: 'g-1', step: 'review' }, again) === m.digest,
      }).toEqual({ view: true, digest: true });
    }
  });

  it("idempotence at read (S1): the stored question is byte-identical at `agent`; the environment's hides show in the PREVIEW only", () => {
    const stored = gate({
      resolved_message: `Approve [REDACTED] and ${ENV_FAKE}?`,
      preview: { note: ENV_FAKE },
    });
    const agent = read(stored, undefined, 'agent');
    const broadcast = read(stored, undefined, 'broadcast');
    // (a) red when the question is re-masked at `all` (the law changed: P-9 keeps the question at
    //     the declared tier); (b) prints booleans.
    expect({
      question: agent.question_text === stored.resolved_message,
      previewHidden: !agent.preview_text.includes(ENV_FAKE),
      broadcastShaped: broadcast.preview_text.includes('‹string,'),
    }).toEqual({ question: true, previewHidden: true, broadcastShaped: true });
  });
});

describe('#729 PR-4 — the digest', () => {
  const literal = {
    v: 1,
    step: 's',
    run_id: 'r',
    question_text: 'q',
    preview: 'p',
    gate_id: 'g',
    choices: ['a', 'b'],
  };
  it('canonicalJson of an unsorted literal equals the hand-written RFC 8785 string, keys by code unit', () => {
    // (a) red when keys sort by locale (`Z` after `a`) or the literal's order leaks; (b) prints the
    //     strings.
    expect(canonicalJson(literal)).toBe(
      '{"choices":["a","b"],"gate_id":"g","preview":"p","question_text":"q","run_id":"r","step":"s","v":1}',
    );
    expect(canonicalJson({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
  });

  it('the vector: the digest equals the hex `printf %s <that string> | sha256sum` printed outside the test', () => {
    const view: QuestionView = {
      question_text: 'q',
      preview_text: 'p',
      preview_format: 'text',
      choices: ['a', 'b'],
    };
    // (a) red when canonicalJson is replaced by JSON.stringify over the literal's own order; (b)
    //     prints the hex.
    expect(viewDigest({ run_id: 'r', gate_id: 'g', step: 's' }, view)).toBe(
      '25744891c40a59a1501083254c2b354f8a66f8f016fd7c8d9f30b9109cbd36ae',
    );
    expect(createHash('sha256').update(canonicalJson(literal)).digest('hex')).toBe(
      '25744891c40a59a1501083254c2b354f8a66f8f016fd7c8d9f30b9109cbd36ae',
    );
  });

  it('a changed preview, a changed cut, a changed choice order each change the digest; the same view gives the same', () => {
    const ids = { run_id: 'r', gate_id: 'g', step: 's' };
    const base: QuestionView = {
      question_text: 'q',
      preview_text: 'p',
      preview_format: 'text',
      choices: ['a', 'b'],
    };
    const d = (v: QuestionView) => viewDigest(ids, v);
    // (a) red when a field is dropped from the digest's object (the digest unchanged); (b) prints
    //     booleans.
    expect({
      preview: d({ ...base, preview_text: 'p2' }) !== d(base),
      cut: d({ ...base, question_text: `q\n\n${CUT_SENTENCE(1, 2)}` }) !== d(base),
      order: d({ ...base, choices: ['b', 'a'] }) !== d(base),
      same: d({ ...base }) === d(base),
    }).toEqual({ preview: true, cut: true, order: true, same: true });
  });

  it('the frozen view only: the mint digests its `private` view; the broadcast view of the same gate digests differently', () => {
    const m = mint(undefined, {}, { note: 'visible-value-xyz' });
    const shaped = read(gate({ preview: { note: 'visible-value-xyz' } }), undefined, 'broadcast');
    // The source: `viewDigest(` is called in the mint's return only (and in tests) — no surface
    // digests the view it composed for its own audience.
    const packages = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const callers = ['core', 'cli', 'mcp-server', 'testing'].flatMap((pkg) =>
      (readdirSync(join(packages, pkg, 'src'), { recursive: true }) as string[])
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .filter((f) =>
          readFileSync(join(packages, pkg, 'src', f), 'utf8')
            .split('\n')
            .some((line) => /viewDigest\(/.test(line) && !/function viewDigest\(/.test(line)),
        )
        .map((f) => `${pkg}/${f}`),
    );
    // (a) red when the mint digests a shaped view (the two digests equal), or another surface
    //     digests its own view; (b) prints booleans and the calling files.
    expect({
      frozen: m.digest === viewDigest({ run_id: 'r-1', gate_id: 'g-1', step: 'review' }, m.view),
      differs: viewDigest({ run_id: 'r-1', gate_id: 'g-1', step: 'review' }, shaped) !== m.digest,
      callers,
    }).toEqual({ frozen: true, differs: true, callers: ['core/engine/question-view.ts'] });
  });
});
