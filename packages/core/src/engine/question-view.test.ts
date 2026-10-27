// question-view.test.ts — #729 PR-4 (01; 04 "The composer", "The budget", "The digest"): the ONE
// question composer, as pure functions — the read (`composeQuestionView` over a gate PR-3's law has
// disclosed), the mint's cuts (`mintSubstitutions` through renderTemplate's hook, `mintQuestionView`),
// the round trip, and the digest. The mint through the engine is `execution-loop.test.ts`'s
// "#729 PR-4" block. Every value is a fake (`CANARY-…`). Each assertion names (a) the change that
// turns it red and (b) what it prints when it fails: texts, lengths, counts and booleans.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
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
  const message =
    template !== undefined
      ? renderTemplate(
          template,
          { evidenceByStep: {}, runParams: params },
          {
            strict: true,
            ...(substitutions?.onSubstitution !== undefined
              ? { onSubstitution: substitutions.onSubstitution }
              : {}),
          },
        )
      : undefined;
  return mintQuestionView({
    message,
    ...(substitutions !== undefined ? { substitutions } : {}),
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

  it('(b) counts a filtered placeholder: `{{ x | truncate: 5 }}` and `{{ y }}` are two, so `y` gets half the room', () => {
    const template = '{{ run.params.x | truncate: 5 }}{{ run.params.y }}';
    const m = mint(template, { x: 'xxxxxxxx', y: 'y'.repeat(5000) }, { summary: 's' });
    const shown = Number(
      /…\[cut at mint: (\d+) of 5000 characters\]/.exec(m.resolved_message!)![1],
    );
    const reserve = 2 + CUT_SENTENCE(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).length;
    const share = Math.floor((VIEW_BUDGET - reserve) / 2);
    // (a) red when the count uses a regex that misses the filtered placeholder (n = 1: y's share
    //     doubles); (b) prints the shown count and the share.
    expect({ shown, under: shown < share, overHalf: shown > share - 60 }).toEqual({
      shown,
      under: true,
      overHalf: true,
    });
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
});

describe("#729 PR-4 — the mint under PR-3's law (Q7)", () => {
  it('masked before cut: a declared value in a substitution past its share is stored as `[REDACTED]`, never its prefix', () => {
    const m = mint(
      'Approve {{ run.params.token }} for release {{ run.params.pad }}',
      { token: FAKE, pad: 'p'.repeat(5000) },
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
    // (a) red when the mint digests a shaped view (the two digests equal); (b) prints booleans.
    expect({
      frozen: m.digest === viewDigest({ run_id: 'r-1', gate_id: 'g-1', step: 'review' }, m.view),
      differs: viewDigest({ run_id: 'r-1', gate_id: 'g-1', step: 'review' }, shaped) !== m.digest,
    }).toEqual({ frozen: true, differs: true });
  });
});
