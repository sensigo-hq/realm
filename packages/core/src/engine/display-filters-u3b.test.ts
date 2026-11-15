// display-filters-u3b.test.ts — fix 1, piece 3b: a step's `display` template applies template
// filters, by the approval question's own chain (`parseFilters`, `applyFilter`, `'stored'` time),
// over values its callers have already disclosed. Every state of a placeholder: a path that finds
// nothing, a filter that succeeds, a filter that fails or throws, a value shown as a marker or a
// shape. The callers' disclosure (the result line, the gate print, Slack) is the CLI's
// `display-filters-u3b.test.ts`. Each assertion names (a) the change that turns it red and (b) what
// it prints when it fails.
import { describe, it, expect } from 'vitest';
import { displayPaths, renderDisplay } from './question-view.js';
import { renderTemplate } from './render-template.js';
import { WHOLE_NAMED_MARKER, markersIn } from '../utils/redaction.js';

describe('fix 1, piece 3b — the states of a filtered `display` placeholder (check 3)', () => {
  it('a path that finds nothing: the chain runs on the missing value, and only `default` gives anything', () => {
    // (a) red when the chain is not run on a missing value (`default` lost: `none` becomes ''), or
    //     when a failed chain over a missing value leaves the placeholder; (b) prints the renderings.
    expect({
      upper: renderDisplay('[{{ reviewer | upper }}]', {}),
      default: renderDisplay("[{{ reviewer | default: 'none' }}]", {}),
      unassigned: renderDisplay("[{{ reviewer | default: 'unassigned' | upper }}]", {}),
      unknown: renderDisplay('[{{ reviewer | shout }}]', {}),
    }).toEqual({ upper: '[]', default: '[none]', unassigned: '[UNASSIGNED]', unknown: '[]' });
  });

  it('every filter succeeds: its result; `undefined` or `null` is empty; a list or a map is JSON on one line', () => {
    const vars = { key_changes: ['a', 'b'], none: [], note: 'Pack with care.', o: { k: 1 } };
    // (a) red when a filter is not applied (the list's JSON shows), when an empty result prints as
    //     the placeholder or as `undefined`, or when JSON is indented; (b) prints the renderings.
    expect({
      bullets: renderDisplay('{{ key_changes | bullets }}', vars),
      empty: ['bullets', 'first', 'last', 'and_join'].map((f) =>
        renderDisplay(`[{{ none | ${f} }}]`, vars),
      ),
      upper: renderDisplay('{{ note | upper }}', vars),
      split: renderDisplay("{{ note | split: ' ' }}", vars),
      map: renderDisplay("{{ o | default: 'x' }}", vars),
    }).toEqual({
      bullets: '• a\n• b',
      empty: ['[]', '[]', '[]', '[]'],
      upper: 'PACK WITH CARE.',
      split: '["Pack","with","care."]',
      map: '{"k":1}',
    });
  });

  it('a filter that fails leaves the placeholder as written: a type mismatch, an unknown filter, a bad argument, a throw', () => {
    const vars = { n: 3, note: 'x' };
    const out = {
      mismatch: renderDisplay('{{ n | upper }}', vars),
      unknown: renderDisplay('{{note|shout}}', vars),
      range: renderDisplay('{{ n | round: 500 }}', vars),
      throws: renderDisplay('{{ bad | bullets }}', { bad: [Object.create(null)] }),
    };
    // (a) red when there is no catch around a filter (`round: 500` throws a RangeError out of
    //     renderDisplay), or a failed chain prints '' or a partial value; (b) prints the renderings.
    expect(out).toEqual({
      mismatch: '{{ n | upper }}',
      unknown: '{{ note|shout }}',
      range: '{{ n | round: 500 }}',
      throws: '{{ bad | bullets }}',
    });
  });

  it("a quoted `|` in an argument is parsed as the approval question's chain parses it", () => {
    const note = 'a|b and a|b';
    const expression = "replace: 'a|b', 'x' | upper";
    // (a) red when display splits its chain on every `|` (the argument is cut, the filter fails);
    //     (b) prints both renderings.
    expect(renderDisplay(`{{ note | ${expression} }}`, { note })).toBe(
      renderTemplate(`{{ run.params.note | ${expression} }}`, {
        evidenceByStep: {},
        runParams: { note },
      }),
    );
    expect(renderDisplay(`{{ note | ${expression} }}`, { note })).toBe('X AND X');
  });

  it('`from_now` writes the date itself, as a stored message does', () => {
    // (a) red when display renders with no time (the placeholder stays) or with a reply's time (a
    //     relative phrase); (b) prints the rendering.
    expect(renderDisplay('{{ at | from_now }}', { at: '2026-01-28T14:05:00Z' })).toBe(
      '2026-01-28T14:05:00.000Z',
    );
  });

  it('a value shown as a marker or a shape is shown as it is, unfiltered; a list keeps its items', () => {
    const vars = {
      token: '[REDACTED]',
      amount: '‹number›',
      name: '‹string, 3 characters›',
      tags: ['‹string, 1 character›', '‹string, 2 characters›'],
      key: '[REDACTED]#2',
    };
    // (a) red when filters are applied to shapes (`‹STRING, 3 CHARACTERS›`, a `split` array, the
    //     number filter's placeholder left as written); (b) prints the renderings.
    expect({
      upper: renderDisplay('{{ token | upper }}', vars),
      split: renderDisplay("{{ token | split: '-' }}", vars),
      truncate: renderDisplay('{{ token | truncate: 3 }}', vars),
      number: renderDisplay('{{ amount | number_format: 2 }}', vars),
      name: renderDisplay('{{ name | upper }}', vars),
      key: renderDisplay('{{ key | lower }}', vars),
      bullets: renderDisplay('{{ tags | bullets }}', vars),
    }).toEqual({
      upper: '[REDACTED]',
      split: '[REDACTED]',
      truncate: '[REDACTED]',
      number: '‹number›',
      name: '‹string, 3 characters›',
      key: '[REDACTED]#2',
      bullets: '• ‹string, 1 character›\n• ‹string, 2 characters›',
    });
  });

  it('with no filter, a placeholder renders as before; `{{{ x }}}` renders `x` inside its braces', () => {
    const vars = { a: { b: 'deep' }, n: 3, o: { k: 1 }, x: 'v' };
    // (a) red when an unfiltered rule changes; (b) prints the renderings.
    expect([
      renderDisplay('[{{ a.b }}][{{ a.zz }}][{{ n }}|{{ o }}]', vars),
      renderDisplay('{{{ x }}}', vars),
    ]).toEqual(['[deep][][3|{"k":1}]', '{v}']);
  });
});

describe('fix 1, piece 3b — one placeholder rule and one marker form', () => {
  it("`displayPaths` gives each placeholder's path, a filtered one's included, by renderDisplay's rule", () => {
    // (a) red when the projection reads a filtered placeholder's whole expression as its path (the
    //     drive's gate print would project no field), or admits a brace into a path; (b) prints the
    //     paths.
    expect(
      displayPaths('{{ key_changes | bullets }} {{ a.b }} {{{ x }}} {{ y | default: "a|b" }}'),
    ).toEqual([['key_changes'], ['a', 'b'], ['x'], ['y']]);
  });

  it('the whole form matches a text that is wholly one marker or one shape, and nothing longer', () => {
    const whole = [
      '[REDACTED]',
      '[REDACTED]#2',
      '[REDACTED_EMAIL]',
      '[REDACTED: not checked]',
      '[redacted-live-claim]',
      '‹12 characters, not kept›',
      '‹string, 1 character›',
      '‹array, 3 items›',
      '‹object, 1 key›',
      '‹number›',
      '‹cycle›',
    ];
    const partial = ['x [REDACTED]', '[REDACTED] x', '‹number›‹number›', '‹STRING, 3 CHARACTERS›'];
    // (a) red when the form loses its anchors (a value holding a marker is then left unfiltered) or
    //     a member; (b) prints the texts it got wrong.
    expect({
      missed: whole.filter((t) => !WHOLE_NAMED_MARKER.test(t)),
      matched: partial.filter((t) => WHOLE_NAMED_MARKER.test(t)),
    }).toEqual({ missed: [], matched: [] });
    // The unanchored form is built from it: each marker is still found inside a text.
    // (a) red when NAMED_MARKER stops being the same members; (b) prints the markers found.
    expect(markersIn({ v: `a ${whole.join(' b ')} c` })).toEqual(whole);
  });
});
